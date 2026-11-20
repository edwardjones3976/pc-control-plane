using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

internal static class ServiceInventory
{
    internal sealed record ServiceRow(string Name, string DisplayName, string State, string Startup,
        string Dependencies, string Dependents);

    internal static Task<ServiceRow[]> ReadAsync() => ReadInventoryAsync<ServiceRow>("""
            $ErrorActionPreference = 'Stop'
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            $requiredBy = @{}
            $requires = @{}
            foreach ($edge in Get-CimInstance -ClassName Win32_DependentService) {
              $from = $edge.Antecedent.Name
              $to = $edge.Dependent.Name
              if (!$from -or !$to) { continue }
              if (!$requiredBy.ContainsKey($from)) { $requiredBy[$from] = [Collections.Generic.List[string]]::new() }
              if (!$requires.ContainsKey($to)) { $requires[$to] = [Collections.Generic.List[string]]::new() }
              $requiredBy[$from].Add($to)
              $requires[$to].Add($from)
            }
            $rows = @(Get-Service | Sort-Object DisplayName | ForEach-Object {
              $dependencies = ($requires[$_.Name] | Sort-Object -Unique) -join ', '
              $dependents = ($requiredBy[$_.Name] | Sort-Object -Unique) -join ', '
              if (!$dependencies) { $dependencies = 'None listed' }
              if (!$dependents) { $dependents = 'None listed' }
              @{ Name = $_.Name; DisplayName = $_.DisplayName; State = [string]$_.Status
                 Startup = [string]$_.StartType; Dependencies = $dependencies; Dependents = $dependents }
            })
            ConvertTo-Json -InputObject $rows -Compress
            """);

    internal sealed record DeviceRow(string Name, string Class, string Status, int? Problem);

    internal static Task<DeviceRow[]> ReadDevicesAsync() => ReadInventoryAsync<DeviceRow>("""
        $ErrorActionPreference = 'Stop'
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $rows = @(Get-CimInstance Win32_PnPEntity -Filter 'Present = TRUE' |
          Sort-Object Name | ForEach-Object {
            @{ Name = $_.Name; Class = $_.PNPClass; Status = $_.Status; Problem = $_.ConfigManagerErrorCode }
          })
        ConvertTo-Json -InputObject $rows -Compress
        """);

    private static async Task<T[]> ReadInventoryAsync<T>(string script)
    {
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            StandardOutputEncoding = Encoding.UTF8
        };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command", script })
            start.ArgumentList.Add(arg);
        using var child = Process.Start(start) ?? throw new IOException("Could not start service readback.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            string result = await child.StandardOutput.ReadToEndAsync(timeout.Token);
            await child.WaitForExitAsync(timeout.Token);
            if (child.ExitCode != 0 || string.IsNullOrWhiteSpace(result))
                throw new IOException("Windows did not return the service inventory.");
            return JsonSerializer.Deserialize<T[]>(result)
                ?? throw new IOException("Windows inventory was unreadable.");
        }
        catch (OperationCanceledException)
        {
            try { child.Kill(); }
            catch (InvalidOperationException) when (child.HasExited) { }
            throw;
        }
    }
}
