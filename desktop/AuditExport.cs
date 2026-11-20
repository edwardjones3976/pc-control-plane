using System;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

internal static class AuditExport
{
    private const int MaxBytes = 8 * 1024 * 1024;
    private static readonly HttpClient Client = new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        UseCookies = false
    });

    internal static Task<byte[]> ReadAsync(Uri engine) =>
        ReadLocalAsync(engine, "/api/audit?days=6&format=readable", "text/html");

    internal static async Task<string> ReadEngineStatusAsync(Uri engine) =>
        (await ReadEngineHealthAsync(engine, null)).Summary;

    internal static async Task<(bool ObserverRunning, string Summary)> ReadEngineHealthAsync(Uri engine, string? probeKey,
        int? expectedProbePid = null, CancellationToken cancellation = default, string expectedMode = "read-only")
    {
        using var status = System.Text.Json.JsonDocument.Parse(
            await ReadLocalAsync(engine, "/api/health", "application/json", probeKey, cancellation));
        if (status.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object ||
            !status.RootElement.TryGetProperty("observer", out var observer) ||
            observer.ValueKind != System.Text.Json.JsonValueKind.Object ||
            !observer.TryGetProperty("running", out var running) ||
            running.ValueKind is not (System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False))
            throw new InvalidDataException("Engine status is missing observer state.");
        if (expectedProbePid is int expected &&
            (!status.RootElement.TryGetProperty("pid", out var pid) ||
                pid.ValueKind != System.Text.Json.JsonValueKind.Number || !pid.TryGetInt32(out var actual) || actual != expected ||
                !status.RootElement.TryGetProperty("mode", out var mode) ||
                mode.ValueKind != System.Text.Json.JsonValueKind.String || mode.GetString() != expectedMode))
            throw new InvalidDataException("Health response did not identify the expected managed engine.");
        var summary = running.GetBoolean() ? "Engine connected. Observer running." : "Engine connected. Observer stopped.";
        if (!status.RootElement.TryGetProperty("savedMode", out var saved) ||
            saved.ValueKind != System.Text.Json.JsonValueKind.Object)
            return (running.GetBoolean(), summary);
        string? ReadString(string key) => saved.TryGetProperty(key, out var value) &&
            value.ValueKind == System.Text.Json.JsonValueKind.String ? value.GetString() : null;
        var label = ReadString("status") == "saved" ? ReadString("modeId") switch
        {
            "conservative" => "Conservative",
            "balanced" => "Balanced",
            "performance" => "100% Performance",
            "competitive" => "Competitive Gaming",
            "agentic" => "Agentic Work",
            "overdrive" => "Overdrive",
            _ => null
        } : null;
        return (running.GetBoolean(), summary + (label is null ? "\nSaved control mode unavailable." : $"\nSaved control mode: {label}."));
    }

    private static async Task<byte[]> ReadLocalAsync(Uri engine, string route, string mediaType, string? probeKey = null,
        CancellationToken cancellation = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(engine, route));
        if (probeKey is not null) request.Headers.Add("x-pc-probe-key", probeKey);
        using var response = await Client.SendAsync(request,
            HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentType?.MediaType != mediaType ||
            response.Content.Headers.ContentLength > MaxBytes)
            throw new InvalidDataException("The engine did not return a supported audit report.");
        using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var report = new MemoryStream();
        byte[] buffer = new byte[16384];
        int read;
        while ((read = await stream.ReadAsync(buffer.AsMemory(), timeout.Token)) != 0)
        {
            if (report.Length + read > MaxBytes) throw new InvalidDataException("The report is too large.");
            report.Write(buffer, 0, read);
        }
        if (report.Length == 0) throw new InvalidDataException("The audit report was empty.");
        return report.ToArray();
    }

    internal static async Task SaveAsync(string destination, byte[] report)
    {
        string directory = Path.GetDirectoryName(Path.GetFullPath(destination))!;
        string temporary = Path.Combine(directory, $".pc-control-audit-{Guid.NewGuid():N}.tmp");
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, true))
        {
            try { await file.WriteAsync(report.AsMemory()); }
            catch
            {
                file.Dispose();
                File.Delete(temporary);
                throw;
            }
        }
        try { File.Move(temporary, destination, overwrite: true); }
        finally { File.Delete(temporary); }
    }
}
