using System.Collections.Generic;
using Microsoft.Win32;

internal static class StartupInventory
{
    internal const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    internal static string[] ReadNames(RegistryKey root, string subkey = RunKey)
    {
        using var key = root.OpenSubKey(subkey, writable: false);
        var names = key?.GetValueNames() ?? [];
        System.Array.Sort(names, System.StringComparer.OrdinalIgnoreCase);
        return names;
    }

    internal static string Read()
    {
        var lines = new List<string>();
        foreach (var (hive, view, label) in new[]
        {
            (RegistryHive.CurrentUser, RegistryView.Registry64, "Current user"),
            (RegistryHive.LocalMachine, RegistryView.Registry64, "All users (64-bit)"),
            (RegistryHive.LocalMachine, RegistryView.Registry32, "All users (32-bit)")
        })
        {
            lines.Add(label);
            try
            {
                using var root = RegistryKey.OpenBaseKey(hive, view);
                var names = ReadNames(root);
                if (names.Length == 0) lines.Add("  No Run entries found.");
                foreach (var name in names)
                    lines.Add("  " + (name.Length == 0 ? "(Default)" : name.Replace('\r', ' ').Replace('\n', ' ')));
            }
            catch (System.Exception error) when (error is System.Security.SecurityException or System.UnauthorizedAccessException or System.IO.IOException)
            {
                lines.Add("  Entries unavailable.");
            }
            lines.Add("");
        }
        return string.Join(System.Environment.NewLine, lines);
    }
}
