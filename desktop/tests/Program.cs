using System.Net;
using System.Net.Sockets;
using System.Text;

#if SERVICE_STATUS_SMOKE
using System.Diagnostics;
using System.Security.Principal;
#endif

static async Task<T> ReadFixture<T>(string response, string route, Func<Uri, Task<T>> read)
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    var address = new Uri($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}");
    async Task Respond()
    {
        using var client = await listener.AcceptTcpClientAsync(stop.Token);
        using var stream = client.GetStream();
        using var reader = new StreamReader(stream, leaveOpen: true);
        if (await reader.ReadLineAsync(stop.Token) != $"GET {route} HTTP/1.1")
            throw new InvalidDataException("Unexpected report route.");
        while (await reader.ReadLineAsync(stop.Token) is { Length: > 0 }) { }
        await stream.WriteAsync(Encoding.ASCII.GetBytes(response), stop.Token);
    }
    var serving = Respond();
    try { return await read(address); }
    finally { listener.Stop(); await serving; }
}

static async Task Reject<T>(Func<Task> operation) where T : Exception
{
    try { await operation(); }
    catch (T) { return; }
    throw new Exception($"Expected {typeof(T).Name}.");
}

static Task<byte[]> Report(string response) =>
    ReadFixture(response, "/api/audit?days=6&format=readable", AuditExport.ReadAsync);
static Task<string> Status(string json) =>
    ReadFixture($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {json.Length}\r\nConnection: close\r\n\r\n{json}",
        "/api/health", AuditExport.ReadEngineStatusAsync);

if (await Status("""{"observer":{"running":true}}""") != "Engine connected. Observer running." ||
    await Status("""{"observer":{"running":false}}""") != "Engine connected. Observer stopped.")
    throw new Exception("Unexpected engine status.");
await Reject<InvalidDataException>(() => Status("""{"observer":{}}"""));
await Reject<InvalidDataException>(() => Status("""{"observer":null}"""));
await Reject<InvalidDataException>(() => Status("[]"));
var stalled = new TcpListener(IPAddress.Loopback, 0);
stalled.Start();
try
{
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    var address = new Uri($"http://127.0.0.1:{((IPEndPoint)stalled.LocalEndpoint).Port}");
    var probe = AuditExport.ReadEngineHealthAsync(address, null, cancellation: deadline.Token);
    using var peer = await stalled.AcceptTcpClientAsync(deadline.Token);
    deadline.Cancel();
    await Reject<OperationCanceledException>(() => probe.WaitAsync(TimeSpan.FromSeconds(2)));
}
finally { stalled.Stop(); }
if (!(await Status("""{"observer":{"running":true},"savedMode":{"status":"saved","modeId":"competitive"}}"""))
        .EndsWith("\nSaved control mode: Competitive Gaming.") ||
    !(await Status("""{"observer":{"running":false},"savedMode":{"status":"missing","modeId":null}}"""))
        .EndsWith("\nSaved control mode unavailable."))
    throw new Exception("Unexpected saved mode status.");
var bytes = await Report("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 9\r\nConnection: close\r\n\r\n<p>ok</p>");
await Reject<HttpRequestException>(() => Report("HTTP/1.1 302 Found\r\nLocation: /other\r\nContent-Length: 0\r\n\r\n"));
await Reject<InvalidDataException>(() => Report("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n"));
await Reject<InvalidDataException>(() => Report("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 8388609\r\n\r\n"));
var directory = Directory.CreateTempSubdirectory("pc-audit-test-");
var target = Path.Combine(directory.FullName, "report.html");
try
{
    await File.WriteAllTextAsync(target, "previous report");
    using (File.Open(target, FileMode.Open, FileAccess.Read, FileShare.None))
    {
        try
        {
            await AuditExport.SaveAsync(target, bytes);
            throw new Exception("Locked report was unexpectedly replaced.");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
    if (await File.ReadAllTextAsync(target) != "previous report") throw new Exception("Previous report changed.");
    await AuditExport.SaveAsync(target, bytes);
    if (await File.ReadAllTextAsync(target) != "<p>ok</p>" || directory.GetFiles().Length != 1)
        throw new Exception("Report bytes or temporary-file cleanup did not match.");
}
finally { File.Delete(target); directory.Delete(); }
Console.WriteLine("Audit export smoke passed.");

var eligibleUpdate = new UpdateStatus.SoftwareUpdate(Guid.NewGuid(), 1, "Fixture", true, true, false, 0);
if (eligibleUpdate.InstallBlockReason(false) is not null ||
    eligibleUpdate.InstallBlockReason(true) is null ||
    eligibleUpdate.InstallBlockReason(null) is null || new[]
{
    eligibleUpdate with { Id = Guid.Empty }, eligibleUpdate with { Revision = 0 },
    eligibleUpdate with { LicenseAccepted = false }, eligibleUpdate with { Downloaded = false },
    eligibleUpdate with { MayPrompt = true }, eligibleUpdate with { RestartBehavior = 1 },
    eligibleUpdate with { RestartBehavior = 2 }, eligibleUpdate with { RestartBehavior = -1 }
}.Any(update => update.InstallBlockReason(false) is null))
    throw new Exception("Unexpected update preflight decision.");
Console.WriteLine("Update preflight smoke passed.");

await Reject<OperationCanceledException>(() =>
    EngineSupervisor.RunWorkerAsync("", "", "", new CancellationToken(canceled: true)));

#if SERVICE_STATUS_SMOKE
if (args is ["--scm", var expectedPid] && uint.TryParse(expectedPid, out uint scmPid))
{
    if (ServiceStatusScm.RunningProcessId("RpcSs") != scmPid ||
        ServiceStatusScm.RunningProcessId("PCControlPlaneFixture-" + Guid.NewGuid()) is not null)
        throw new InvalidOperationException("SCM status did not match the native readback.");
    Console.WriteLine("Service process readback passed.");
}

using (var user = WindowsIdentity.GetCurrent())
using (var process = Process.GetCurrentProcess())
using (var stop = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
{
    uint session = (uint)process.SessionId;
    uint pid = (uint)Environment.ProcessId;
    string name = ServiceStatusPipe.Name + ".fixture." + Guid.NewGuid().ToString("N");
    using var pipe = ServiceStatusPipe.Create(name, user.User!);
    var calls = 0;
    var active = session;
    var current = ServiceStatusPipe.Health.ObserverStopped;
    var task = ServiceStatusPipe.ServeAsync(pipe, () => Volatile.Read(ref active), _ =>
    {
        Interlocked.Increment(ref calls);
        return Task.FromResult(current);
    }, stop.Token);
    try
    {
        if (await ServiceStatusPipe.ReadAsync(name, () => pid, stop.Token) != current)
            throw new InvalidOperationException("Valid read-only health did not round trip.");
        current = ServiceStatusPipe.Health.Monitoring;
        if (await ServiceStatusPipe.ReadAsync(name, () => pid, stop.Token) != current ||
            await ServiceStatusPipe.ReadAsync(name, () => pid, stop.Token, request: 255) != ServiceStatusPipe.Health.Unavailable ||
            await ServiceStatusPipe.ReadAsync(name, () => pid ^ 1, stop.Token) != ServiceStatusPipe.Health.Unavailable ||
            await ServiceStatusPipe.ReadAsync(name, () => null, stop.Token) != ServiceStatusPipe.Health.Unavailable)
            throw new InvalidOperationException("Current health or peer verification did not match.");
        Volatile.Write(ref active, session ^ 1u);
        if (await ServiceStatusPipe.ReadAsync(name, () => pid, stop.Token) != ServiceStatusPipe.Health.Unavailable ||
            Volatile.Read(ref calls) != 2)
            throw new InvalidOperationException("A denied operation reached the health provider.");
        Console.WriteLine("Service status pipe smoke passed.");
    }
    finally
    {
        stop.Cancel();
        try { await task; }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }
}
#endif

if (args is ["--engine", var bundled])
{
    var data = Directory.CreateTempSubdirectory("pc-bundled-engine-test-");
    try
    {
        using var engine = EngineSupervisor.Start(Path.GetFullPath(bundled), data.FullName, data.FullName, readOnly: true);
        using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            var address = await engine.ReadProbeAddressAsync(startup.Token);
            await Reject<HttpRequestException>(() => AuditExport.ReadEngineStatusAsync(address));
            if (await engine.ReadProbeObserverRunningAsync(address, startup.Token))
                throw new Exception("Expected a read-only engine.");
            if (!File.Exists(Path.Combine(data.FullName, "server.lock.json")))
                throw new Exception("Engine did not acquire isolated ownership.");
        }
        finally
        {
            using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            if (await engine.StopAsync(shutdown.Token) != 0)
                throw new Exception("Bundled engine shutdown failed.");
        }
        if (File.Exists(Path.Combine(data.FullName, "server.lock.json")) ||
            File.Exists(Path.Combine(data.FullName, "state.json")))
            throw new Exception("Unexpected ownership or settings after shutdown.");
        Console.WriteLine("Bundled engine supervisor smoke passed.");
        using var stopping = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        bool qualified = false;
        bool statusRead = false;
        await EngineSupervisor.RunWorkerAsync(Path.GetDirectoryName(Path.GetFullPath(bundled))!,
            data.FullName, data.FullName, stopping.Token, () =>
            {
                qualified = true;
            }, readOnly: true, serveStatus: async (engine, address, stop) =>
            {
                if (await engine.ReadProbeObserverRunningAsync(address, stop))
                    throw new InvalidOperationException("Unexpected status listener health.");
                statusRead = true;
                stopping.Cancel();
                await Task.Delay(Timeout.InfiniteTimeSpan, stop);
            });
        if (!qualified || !statusRead || File.Exists(Path.Combine(data.FullName, "server.lock.json")) ||
            File.Exists(Path.Combine(data.FullName, "state.json")))
            throw new Exception("Read-only service lifecycle was not verified.");
        bool incorrectlyReady = false;
        await Reject<IOException>(() => EngineSupervisor.RunWorkerAsync(Path.GetDirectoryName(Path.GetFullPath(bundled))!,
            data.FullName, data.FullName, CancellationToken.None, () => incorrectlyReady = true, readOnly: true,
            serveStatus: (_, _, _) => Task.FromException(new IOException("Synthetic listener startup failure."))));
        if (incorrectlyReady || File.Exists(Path.Combine(data.FullName, "server.lock.json")))
            throw new Exception("A failed listener announced readiness or left ownership behind.");
        Console.WriteLine("Read-only service lifecycle smoke passed.");
#if SERVICE_STATUS_SMOKE
        using var identity = WindowsIdentity.GetCurrent();
        using var host = Process.GetCurrentProcess();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var listening = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        string pipeName = ServiceStatusPipe.Name + ".engine.fixture." + Guid.NewGuid().ToString("N");
        var worker = EngineSupervisor.RunWorkerAsync(Path.GetDirectoryName(Path.GetFullPath(bundled))!,
            data.FullName, data.FullName, stop.Token, () => listening.TrySetResult(), readOnly: true,
            serveStatus: async (engine, address, token) =>
            {
                using var status = ServiceStatusPipe.Create(pipeName, identity.User!);
                await ServiceStatusPipe.ServeAsync(status, () => (uint)host.SessionId, async deadline =>
                    await engine.ReadProbeObserverRunningAsync(address, deadline)
                        ? ServiceStatusPipe.Health.Monitoring : ServiceStatusPipe.Health.ObserverStopped, token);
            });
        try
        {
            if (await Task.WhenAny(worker, listening.Task.WaitAsync(stop.Token)) == worker)
            {
                await worker;
                throw new IOException("The bundled engine stopped before the pipe was ready.");
            }
            stop.Token.ThrowIfCancellationRequested();
            if (await ServiceStatusPipe.ReadAsync(pipeName, () => (uint)host.Id, stop.Token) !=
                ServiceStatusPipe.Health.ObserverStopped)
                throw new IOException("The pipe did not read the bundled engine's observer state.");
        }
        finally
        {
            stop.Cancel();
            await worker;
        }
        if (File.Exists(Path.Combine(data.FullName, "server.lock.json")) ||
            File.Exists(Path.Combine(data.FullName, "state.json")))
            throw new IOException("Pipe shutdown left ownership or settings behind.");
        using var rebind = ServiceStatusPipe.Create(pipeName, identity.User!);
        Console.WriteLine("Bundled engine service status and pipe shutdown passed.");
#endif
    }
    finally
    {
        foreach (var file in data.GetFiles()) file.Delete();
        data.Delete();
    }
}

if (args is [var node])
{
    var fixture = Directory.CreateTempSubdirectory("pc-supervisor-test-");
    var server = fixture.CreateSubdirectory("server");
    var executable = Path.Combine(fixture.FullName, "node.exe");
    var entry = Path.Combine(server.FullName, "index.js");
    try
    {
        File.Copy(node, executable);
        await File.WriteAllTextAsync(entry, """
            if (process.argv[2] !== '--managed-worker' ||
                process.env.PC_CONTROL_DATA_DIR !== process.cwd() ||
                process.env.PC_CONTROL_OWNERSHIP_DIR !== process.cwd() ||
                process.env.PC_CONTROL_PORT !== '8792' ||
                process.env.NODE_OPTIONS !== undefined) process.exit(2);
            process.stdin.resume();
            console.log(JSON.stringify({schema:'pc-control-plane-ready/v1', pid:process.pid, port:8792}));
            process.stdin.on('end', () => setTimeout(() => {
                process.stdout.write('x'.repeat(1024 * 1024), () => { process.exitCode = 17; });
            }, 250));
            """);
        using var engine = EngineSupervisor.Start(fixture.FullName, fixture.FullName, fixture.FullName);
        using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        if (await engine.ReadProbeAddressAsync(startup.Token) != new Uri("http://127.0.0.1:8792/"))
            throw new Exception("Managed worker readiness did not resolve to the expected local address.");
        if (await engine.ReadProbeAddressAsync(startup.Token) != new Uri("http://127.0.0.1:8792/"))
            throw new Exception("Managed worker readiness was not retained.");
        using var shortWait = new CancellationTokenSource(TimeSpan.FromMilliseconds(30));
        await Reject<OperationCanceledException>(() => engine.StopAsync(shortWait.Token));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        if (await engine.StopAsync(deadline.Token) != 17)
            throw new Exception("Supervisor did not confirm the child's actual exit code.");
        Console.WriteLine("Engine supervisor smoke passed.");
    }
    finally
    {
        File.Delete(entry);
        File.Delete(executable);
        server.Delete();
        fixture.Delete();
    }
}
