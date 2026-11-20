using System;
using System.Buffers.Binary;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class WorkerPipe
{
    private const byte StatusV3 = 0x13;
    private const byte Ready = 0x21;
    private const byte Unsupported = 0x22;
    private const byte SessionDenied = 0x23;
    private const PipeOptions Options = PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly;
    private const int ReplySize = 29;
    private static readonly uint SessionId = (uint)Process.GetCurrentProcess().SessionId;
    private static readonly string Name = $"PCControlPlane.Worker.v3.{SessionId}";
    internal sealed record Snapshot(TimeSpan Uptime, int AvailableProcessors, long PrivateBytes, TimeSpan CpuTime);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint sessionId);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe, out uint sessionId);

    internal static async Task ServeAsync(string name, CancellationToken stop, uint? expectedSession = null)
    {
        using var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, Options | PipeOptions.FirstPipeInstance);
        while (!stop.IsCancellationRequested)
        {
            await pipe.WaitForConnectionAsync(stop);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
            deadline.CancelAfter(TimeSpan.FromSeconds(2));
            try
            {
                byte[] frame = new byte[1];
                if (await pipe.ReadAsync(frame.AsMemory(), deadline.Token) != 0)
                {
                    var reply = new byte[ReplySize];
                    bool sameSession = GetNamedPipeClientSessionId(pipe.SafePipeHandle, out uint session) &&
                        session == (expectedSession ?? SessionId);
                    reply[0] = !sameSession ? SessionDenied : frame[0] == StatusV3 ? Ready : Unsupported;
                    if (reply[0] == Ready)
                    {
                        BinaryPrimitives.WriteInt64LittleEndian(reply.AsSpan(1, 8), Environment.TickCount64);
                        BinaryPrimitives.WriteInt32LittleEndian(reply.AsSpan(9, 4), Environment.ProcessorCount);
                        using var process = Process.GetCurrentProcess();
                        BinaryPrimitives.WriteInt64LittleEndian(reply.AsSpan(13, 8), process.PrivateMemorySize64);
                        BinaryPrimitives.WriteInt64LittleEndian(reply.AsSpan(21, 8), process.TotalProcessorTime.Ticks);
                    }
                    await pipe.WriteAsync(reply.AsMemory(), deadline.Token);
                }
            }
            catch (IOException) { }
            catch (OperationCanceledException) when (!stop.IsCancellationRequested) { }
            finally { pipe.Disconnect(); }
        }
    }

    private static async Task<byte[]> ExchangeAsync(string name, byte request, CancellationToken stop)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
        deadline.CancelAfter(TimeSpan.FromSeconds(3));
        using var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, Options);
        await client.ConnectAsync(deadline.Token);
        if (!GetNamedPipeServerSessionId(client.SafePipeHandle, out uint session) || session != SessionId)
            throw new IOException("Worker is not in the current Windows session.");
        byte[] frame = [request];
        await client.WriteAsync(frame.AsMemory(), deadline.Token);
        var reply = new byte[ReplySize];
        await client.ReadExactlyAsync(reply.AsMemory(), deadline.Token);
        return reply;
    }

    private static Snapshot DecodeSnapshot(byte[] reply)
    {
        long uptime = BinaryPrimitives.ReadInt64LittleEndian(reply.AsSpan(1, 8));
        int processors = BinaryPrimitives.ReadInt32LittleEndian(reply.AsSpan(9, 4));
        long privateBytes = BinaryPrimitives.ReadInt64LittleEndian(reply.AsSpan(13, 8));
        long cpuTicks = BinaryPrimitives.ReadInt64LittleEndian(reply.AsSpan(21, 8));
        if (reply[0] != Ready || uptime < 0 || uptime >= TimeSpan.MaxValue.TotalMilliseconds ||
            processors < 1 || privateBytes <= 0 || cpuTicks < 0)
            throw new InvalidDataException("Invalid worker snapshot.");
        return new Snapshot(TimeSpan.FromMilliseconds(uptime), processors, privateBytes, TimeSpan.FromTicks(cpuTicks));
    }

    internal static async Task<Snapshot> ProbeAsync() =>
        DecodeSnapshot(await ExchangeAsync(Name, StatusV3, CancellationToken.None));

    internal static Task RunAsync(CancellationToken stop) => ServeAsync(Name, stop);

    internal static async Task SmokeAsync()
    {
        string name = Name + ".test." + Guid.NewGuid().ToString("N");
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        var rejected = ServeAsync(name + ".denied", stop.Token, SessionId ^ 1u);
        try
        {
            var reply = await ExchangeAsync(name + ".denied", StatusV3, stop.Token);
            if (reply[0] != SessionDenied || reply.AsSpan(1).ContainsAnyExcept((byte)0))
                throw new InvalidDataException("An unexpected session was not explicitly denied.");
        }
        finally
        {
            stop.Cancel();
            try { await rejected; }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        }
        using var normal = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        var server = ServeAsync(name, normal.Token);
        try
        {
            var before = Environment.TickCount64;
            var snapshot = DecodeSnapshot(await ExchangeAsync(name, StatusV3, normal.Token));
            using var process = Process.GetCurrentProcess();
            var next = DecodeSnapshot(await ExchangeAsync(name, StatusV3, normal.Token));
            if (snapshot.Uptime.TotalMilliseconds < before ||
                snapshot.Uptime.TotalMilliseconds > Environment.TickCount64 ||
                snapshot.AvailableProcessors != Environment.ProcessorCount ||
                (await ExchangeAsync(name, 0xff, normal.Token))[0] != Unsupported ||
                next.Uptime < snapshot.Uptime || next.CpuTime < snapshot.CpuTime ||
                next.CpuTime > process.TotalProcessorTime)
                throw new InvalidDataException("Unexpected worker protocol response.");
        }
        finally
        {
            normal.Cancel();
            try { await server; }
            catch (OperationCanceledException) when (normal.IsCancellationRequested) { }
        }
    }
}
