using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Threading;

internal static class UpdateStatus
{
    private static int searching;
    internal static bool SearchRunning => Volatile.Read(ref searching) != 0;

    internal sealed record SoftwareUpdate(Guid Id, int Revision, string Title, bool LicenseAccepted,
        bool Downloaded, bool MayPrompt, int RestartBehavior)
    {
        internal string? InstallBlockReason(bool? restartPending) => Id == Guid.Empty || Revision < 1 ? "Update identity could not be verified."
            : !LicenseAccepted ? "Review license terms in Windows Update."
            : MayPrompt ? "Use Windows Update for an installation that may ask for input."
            : RestartBehavior != 0 ? "Use Windows Update to manage possible restart requirements."
            : !Downloaded ? "Windows has not downloaded the update files."
            : restartPending switch
            {
                true => "Windows Update needs a restart to finish a previous change.",
                false => null,
                null => "Windows Update restart status could not be verified."
            };

        public string Readiness => !LicenseAccepted ? "Review license terms in Windows Update."
            : MayPrompt ? "Installation may require input in Windows Update."
            : Downloaded ? "Windows reports the update files are downloaded."
            : "Windows has not downloaded the update files.";

        public string RestartNotice => RestartBehavior switch
        {
            0 => "Windows reports no restart required for this update.",
            1 => "This update requires a restart after installation.",
            2 => "This update may require a restart after installation.",
            _ => "Windows did not report a recognized restart requirement."
        };
    }

    [SupportedOSPlatform("windows")]
    internal static SoftwareUpdate? Recheck(SoftwareUpdate selected, bool installed = false) =>
        Array.Find(ReadSoftware(false, selected, installed), update => update.Id == selected.Id && update.Revision == selected.Revision);

    [SupportedOSPlatform("windows")]
    internal static SoftwareUpdate[] ReadSoftware(bool online) => ReadSoftware(online, null, false);

    [SupportedOSPlatform("windows")]
    internal static SoftwareUpdate[] ReadInstalledSoftware() => ReadSoftware(false, null, true);

    [SupportedOSPlatform("windows")]
    private static SoftwareUpdate[] ReadSoftware(bool online, SoftwareUpdate? selected, bool installed)
    {
        if (Interlocked.CompareExchange(ref searching, 1, 0) != 0)
            throw new InvalidOperationException("A Windows Update search is already running.");
        try { return SearchSoftware(online, selected, installed); }
        finally { Volatile.Write(ref searching, 0); }
    }

    [SupportedOSPlatform("windows")]
    private static SoftwareUpdate[] SearchSoftware(bool online, SoftwareUpdate? selected, bool installed)
    {
        var type = Type.GetTypeFromProgID("Microsoft.Update.Session", throwOnError: true)!;
        var session = Activator.CreateInstance(type) ?? throw new InvalidOperationException("Windows Update catalog unavailable.");
        object? searcher = null, result = null, updates = null;
        try
        {
            searcher = ((dynamic)session).CreateUpdateSearcher();
            ((dynamic)searcher).Online = online;
            var software = installed ? "IsInstalled=1 and Type='Software'" :
                "IsInstalled=0 and IsHidden=0 and Type='Software'";
            var criteria = selected is null ? software :
                FormattableString.Invariant($"{software} and UpdateID='{selected.Id:D}' and RevisionNumber={selected.Revision}");
            result = ((dynamic)searcher).Search(criteria);
            if ((int)((dynamic)result).ResultCode != 2)
                throw new InvalidOperationException("Windows did not return a complete update result.");
            updates = ((dynamic)result).Updates;
            var candidates = new List<SoftwareUpdate>();
            int count = (int)((dynamic)updates).Count;
            for (int i = 0; i < count; i++)
            {
                object update = ((dynamic)updates).Item(i);
                try
                {
                    dynamic item = update;
                    object identity = item.Identity;
                    object? behavior = null;
                    try
                    {
                        dynamic key = identity;
                        behavior = item.InstallationBehavior;
                        candidates.Add(new SoftwareUpdate(Guid.Parse((string)key.UpdateID),
                            (int)key.RevisionNumber, (string)item.Title, (bool)item.EulaAccepted,
                            (bool)item.IsDownloaded, (bool)((dynamic)behavior).CanRequestUserInput,
                            (int)((dynamic)behavior).RebootBehavior));
                    }
                    finally
                    {
                        if (behavior is not null) Marshal.ReleaseComObject(behavior);
                        Marshal.ReleaseComObject(identity);
                    }
                }
                finally { Marshal.ReleaseComObject(update); }
            }
            return candidates.ToArray();
        }
        finally
        {
            foreach (var item in new[] { updates, result, searcher, session })
                if (item is not null) Marshal.ReleaseComObject(item);
        }
    }

    [SupportedOSPlatform("windows")]
    internal static bool ReadRestartRequired()
    {
        var type = Type.GetTypeFromProgID("Microsoft.Update.SystemInfo", throwOnError: true)!;
        var info = Activator.CreateInstance(type) ?? throw new InvalidOperationException("Windows Update status unavailable.");
        try { return (bool)((dynamic)info).RebootRequired; }
        finally { Marshal.ReleaseComObject(info); }
    }
}
