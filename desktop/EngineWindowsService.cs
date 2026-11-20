using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.ServiceProcess;
using System.Threading;
using System.Threading.Tasks;

internal sealed class EngineWindowsService : ServiceBase
{
    private const string EngineServiceName = "PCControlPlaneEngine";
    private readonly string dataDirectory;
    private readonly string ownershipDirectory;
    private readonly CancellationTokenSource stopping = new();
    private Task? worker;

    internal EngineWindowsService(string dataDirectory, string ownershipDirectory)
    {
        this.dataDirectory = dataDirectory;
        this.ownershipDirectory = ownershipDirectory;
        ServiceName = EngineServiceName;
        CanStop = true;
    }

    internal static string ReadRegistrationStatus()
    {
        using var service = new ServiceController(EngineServiceName);
        try
        {
            return service.Status switch
            {
                ServiceControllerStatus.Running => "Running (engine health not checked)",
                ServiceControllerStatus.StartPending => "Starting",
                ServiceControllerStatus.StopPending => "Stopping",
                ServiceControllerStatus.Stopped => "Stopped",
                ServiceControllerStatus.Paused => "Paused",
                _ => "Changing state"
            };
        }
        catch (InvalidOperationException error) when (error.InnerException is Win32Exception { NativeErrorCode: 1060 })
        {
            return "Not installed";
        }
        catch (InvalidOperationException) { return "Unavailable"; }
        catch (Win32Exception) { return "Unavailable"; }
    }

    protected override void OnStart(string[] args)
    {
        using var process = Process.GetCurrentProcess();
        using var identity = WindowsIdentity.GetCurrent();
        if (process.SessionId != 0 || identity.User?.IsWellKnown(WellKnownSidType.LocalServiceSid) != true)
            throw new UnauthorizedAccessException("The engine service requires Windows Local Service in session 0.");

        RequestAdditionalTime(50000);
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        worker = EngineSupervisor.RunWorkerAsync(AppContext.BaseDirectory, dataDirectory, ownershipDirectory,
            stopping.Token, () => ready.TrySetResult(), readOnly: true, serveStatus: ServeStatusAsync);
        Task.WhenAny(ready.Task, worker).GetAwaiter().GetResult();
        if (worker.IsCompleted)
        {
            worker.GetAwaiter().GetResult();
            throw new IOException("The worker stopped during service startup.");
        }
        _ = worker.ContinueWith(finished =>
        {
            if (stopping.IsCancellationRequested) return;
            if (finished.IsFaulted) _ = finished.Exception;
            ExitCode = 1;
            Stop();
        }, TaskScheduler.Default);
    }

    private static async Task ServeStatusAsync(EngineSupervisor engine, Uri address, CancellationToken stop)
    {
        using var identity = WindowsIdentity.GetCurrent();
        using var pipe = ServiceStatusPipe.Create(ServiceStatusPipe.Name, identity.User!);
        await ServiceStatusPipe.ServeAsync(pipe, ServiceStatusPipe.WTSGetActiveConsoleSessionId, async deadline =>
        {
            try
            {
                return await engine.ReadProbeObserverRunningAsync(address, deadline)
                    ? ServiceStatusPipe.Health.Monitoring : ServiceStatusPipe.Health.ObserverStopped;
            }
            catch (Exception error) when (error is IOException or System.Net.Http.HttpRequestException or System.Text.Json.JsonException)
            {
                return ServiceStatusPipe.Health.Unavailable;
            }
        }, stop);
    }

    protected override void OnStop()
    {
        RequestAdditionalTime(50000);
        stopping.Cancel();
        try { worker?.GetAwaiter().GetResult(); }
        catch { ExitCode = 1; }
    }
}
