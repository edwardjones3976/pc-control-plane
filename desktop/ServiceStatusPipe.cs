using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class ServiceStatusPipe
{
    internal const string Name = "PCControlPlane.EngineStatus.v1";
    private const byte ReadHealth = 1;
    private const PipeAccessRights ClientRights = PipeAccessRights.ReadData |
        PipeAccessRights.WriteData | PipeAccessRights.Synchronize;
    internal enum Health : byte { Unavailable = 0, Monitoring = 2, ObserverStopped = 3 }

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint id);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint id);

    [DllImport("kernel32.dll")]
    internal static extern uint WTSGetActiveConsoleSessionId();

    internal static NamedPipeServerStream Create(string name, SecurityIdentifier owner)
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(owner);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
            PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null),
            ClientRights, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance, 0, 0, security);
    }

    internal static async Task ServeAsync(NamedPipeServerStream pipe, Func<uint> activeSession,
        Func<CancellationToken, Task<Health>> readHealth, CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            await pipe.WaitForConnectionAsync(stop);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
            deadline.CancelAfter(TimeSpan.FromSeconds(2));
            try
            {
                byte[] frame = new byte[1];
                if (!GetNamedPipeClientSessionId(pipe.SafePipeHandle, out uint session) ||
                    session == 0 || session != activeSession()) continue;
                if (await pipe.ReadAsync(frame, deadline.Token) != 1) continue;
                var health = frame[0] == ReadHealth && session == activeSession() ?
                    await readHealth(deadline.Token) : Health.Unavailable;
                if (session == activeSession())
                    await pipe.WriteAsync(new[] { (byte)health }, deadline.Token);
            }
            catch (IOException) { }
            catch (OperationCanceledException) when (!stop.IsCancellationRequested) { }
            finally { pipe.Disconnect(); }
        }
    }

    internal static async Task<Health> ReadAsync(string name, Func<uint?> runningServicePid,
        CancellationToken stop, byte request = ReadHealth)
    {
        uint? expected = runningServicePid();
        if (expected is null or 0) return Health.Unavailable;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
        deadline.CancelAfter(TimeSpan.FromSeconds(3));
        using var client = new NamedPipeClientStream(".", name, ClientRights, PipeOptions.Asynchronous,
            TokenImpersonationLevel.Identification, HandleInheritability.None);
        try
        {
            await client.ConnectAsync(deadline.Token);
            if (!GetNamedPipeServerProcessId(client.SafePipeHandle, out uint actual) || actual != expected ||
                actual != runningServicePid()) return Health.Unavailable;
            await client.WriteAsync(new[] { request }, deadline.Token);
            byte[] frame = new byte[1];
            if (await client.ReadAsync(frame, deadline.Token) != 1 || actual != runningServicePid())
                return Health.Unavailable;
            return frame[0] switch
            {
                (byte)Health.Monitoring => Health.Monitoring,
                (byte)Health.ObserverStopped => Health.ObserverStopped,
                _ => Health.Unavailable
            };
        }
        catch (IOException) { return Health.Unavailable; }
        catch (UnauthorizedAccessException) { return Health.Unavailable; }
        catch (OperationCanceledException) when (!stop.IsCancellationRequested) { return Health.Unavailable; }
    }
}
