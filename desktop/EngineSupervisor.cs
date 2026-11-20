using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

internal sealed class EngineSupervisor : IDisposable
{
    internal const int EnginePort = 8792;
    private readonly Process child;
    private readonly string? probeKey;
    private readonly bool readOnly;
    private Task? disconnect;
    private Task<Uri>? readiness;
    private Task? outputDrain;

    private EngineSupervisor(Process child, string probeKey, bool readOnly) =>
        (this.child, this.probeKey, this.readOnly) = (child, probeKey, readOnly);

    internal static EngineSupervisor Start(string engineDirectory, string dataDirectory, string ownershipDirectory,
        bool readOnly = false)
    {
        if (!Path.IsPathFullyQualified(engineDirectory) || !Path.IsPathFullyQualified(dataDirectory) ||
            !Path.IsPathFullyQualified(ownershipDirectory))
            throw new ArgumentException("Engine and data locations must be absolute.");

        var start = new ProcessStartInfo(Path.Combine(engineDirectory, "node.exe"))
        {
            WorkingDirectory = engineDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true
        };
        start.ArgumentList.Add(Path.Combine(engineDirectory, "server", "index.js"));
        start.ArgumentList.Add(readOnly ? "--managed-read-only" : "--managed-worker");
        foreach (var variable in new System.Collections.Generic.List<string>(start.Environment.Keys))
            if (variable.StartsWith("PC_CONTROL_", StringComparison.OrdinalIgnoreCase) ||
                variable.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase))
                start.Environment.Remove(variable);
        start.Environment["PC_CONTROL_DATA_DIR"] = dataDirectory;
        start.Environment["PC_CONTROL_OWNERSHIP_DIR"] = ownershipDirectory;
        start.Environment["PC_CONTROL_PORT"] = readOnly ? "0" :
            EnginePort.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var key = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        start.Environment["PC_CONTROL_PROBE_KEY"] = key;
        return new EngineSupervisor(Process.Start(start) ?? throw new InvalidOperationException("Engine did not start."), key, readOnly);
    }

    internal async Task<bool> ReadProbeObserverRunningAsync(Uri address, CancellationToken deadline) =>
        (await AuditExport.ReadEngineHealthAsync(address, probeKey, child.Id, deadline,
            expectedMode: readOnly ? "read-only" : "worker")).ObserverRunning;

    internal Task<Uri> ReadProbeAddressAsync(CancellationToken deadline) =>
        readiness ??= ReadReadinessAsync(deadline);

    private async Task<Uri> ReadReadinessAsync(CancellationToken deadline)
    {
        var line = await child.StandardOutput.ReadLineAsync(deadline)
            ?? throw new IOException("The engine exited without a readiness record.");
        using var record = JsonDocument.Parse(line);
        var root = record.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("schema", out var schema) || schema.ValueKind != JsonValueKind.String ||
            schema.GetString() != "pc-control-plane-ready/v1" ||
            !root.TryGetProperty("pid", out var pid) || pid.ValueKind != JsonValueKind.Number ||
            !pid.TryGetInt32(out var actual) || actual != child.Id ||
            !root.TryGetProperty("port", out var port) || port.ValueKind != JsonValueKind.Number ||
            !port.TryGetInt32(out var number) || number is < 1 or > 65535 ||
            (!readOnly && number != EnginePort))
            throw new InvalidDataException("Invalid engine readiness record.");
        outputDrain = child.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
        return new UriBuilder("http", "127.0.0.1", number).Uri;
    }

    internal async Task<int> StopAsync(CancellationToken deadline)
    {
        disconnect ??= child.StandardInput.DisposeAsync().AsTask();
        try { await disconnect; }
        catch (IOException) { /* A closed pipe still requires exit readback. */ }
        await child.WaitForExitAsync(deadline);
        if (outputDrain is not null) await outputDrain.WaitAsync(deadline);
        return child.ExitCode;
    }

    internal static async Task RunWorkerAsync(string desktopDirectory, string dataDirectory,
        string ownershipDirectory, CancellationToken stopping, Action? onReady = null, bool readOnly = false,
        Func<EngineSupervisor, Uri, CancellationToken, Task>? serveStatus = null)
    {
        stopping.ThrowIfCancellationRequested();
        using var engine = Start(Path.Combine(desktopDirectory, "engine"), dataDirectory, ownershipDirectory, readOnly);
        using var statusStop = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        Task? status = null;
        try
        {
            Uri address;
            using (var startup = CancellationTokenSource.CreateLinkedTokenSource(stopping))
            {
                startup.CancelAfter(TimeSpan.FromSeconds(15));
                address = await engine.ReadProbeAddressAsync(startup.Token);
                if (await engine.ReadProbeObserverRunningAsync(address, startup.Token) == readOnly)
                    throw new IOException("The managed worker reported an unexpected observer state.");
            }
            status = serveStatus?.Invoke(engine, address, statusStop.Token);
            if (status?.IsCompleted == true && !stopping.IsCancellationRequested)
                throw new IOException("The engine status listener did not start.", status.Exception);
            onReady?.Invoke();
            var childExit = engine.child.WaitForExitAsync(stopping);
            if (status is not null && await Task.WhenAny(childExit, status) == status && !stopping.IsCancellationRequested)
                throw new IOException("The engine status listener stopped unexpectedly.", status.Exception);
            await childExit;
            if (!stopping.IsCancellationRequested)
                throw new IOException($"The managed worker exited unexpectedly with code {engine.child.ExitCode}.");
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        finally
        {
            statusStop.Cancel();
            try
            {
                if (status is not null) await status;
            }
            catch (OperationCanceledException) when (statusStop.IsCancellationRequested) { }
            finally
            {
                using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                int code = await engine.StopAsync(shutdown.Token);
                if (code != 0) throw new IOException($"The managed worker exited with code {code}.");
            }
        }
    }

    internal static async Task CheckBundleAsync(string desktopDirectory)
    {
        var data = Directory.CreateTempSubdirectory("pc-bundle-check-");
        bool exited = false;
        try
        {
            using var engine = Start(Path.Combine(desktopDirectory, "engine"), data.FullName, data.FullName, readOnly: true);
            try
            {
                using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                var address = await engine.ReadProbeAddressAsync(startup.Token);
                if (await engine.ReadProbeObserverRunningAsync(address, startup.Token) ||
                    !File.Exists(Path.Combine(data.FullName, "server.lock.json")))
                    throw new InvalidDataException("The bundled engine did not report read-only health with ownership held.");
                using var desktop = Process.GetCurrentProcess();
                var elapsed = Stopwatch.StartNew();
                var beforeDesktop = desktop.TotalProcessorTime;
                var beforeEngine = engine.child.TotalProcessorTime;
                await Task.Delay(TimeSpan.FromSeconds(1), startup.Token);
                desktop.Refresh();
                engine.child.Refresh();
                Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
                {
                    workload = "isolated-read-only-no-window",
                    elapsedMs = elapsed.Elapsed.TotalMilliseconds,
                    desktopPrivateBytes = desktop.PrivateMemorySize64,
                    enginePrivateBytes = engine.child.PrivateMemorySize64,
                    desktopCpuMs = (desktop.TotalProcessorTime - beforeDesktop).TotalMilliseconds,
                    engineCpuMs = (engine.child.TotalProcessorTime - beforeEngine).TotalMilliseconds
                }));
            }
            finally
            {
                using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                int code = await engine.StopAsync(shutdown.Token);
                exited = true;
                if (code != 0) throw new IOException($"The bundled engine exited with code {code}.");
            }
            if (File.Exists(Path.Combine(data.FullName, "server.lock.json")) ||
                File.Exists(Path.Combine(data.FullName, "state.json")))
                throw new IOException("Unexpected ownership or settings after shutdown.");
        }
        finally
        {
            if (exited && !File.Exists(Path.Combine(data.FullName, "server.lock.json")))
            {
                foreach (var file in data.GetFiles()) file.Delete();
                data.Delete();
            }
        }
    }

    public void Dispose() => child.Dispose();
}
