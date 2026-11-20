using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal static class ServiceStatusScm
{
    private const uint Connect = 0x0001;
    private const uint QueryStatus = 0x0004;
    private const uint Running = 4;
    private const int ProcessInfo = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct Status
    {
        internal uint Type, State, Controls, Win32Exit, ServiceExit, Checkpoint, WaitHint, Pid, Flags;
    }

    private sealed class ScHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private ScHandle() : base(true) { }
        protected override bool ReleaseHandle() => CloseServiceHandle(handle);
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern ScHandle OpenSCManagerW(string? machine, string? database, uint access);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern ScHandle OpenServiceW(ScHandle manager, string name, uint access);

    [DllImport("advapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(ScHandle service, int infoLevel, out Status status,
        uint length, out uint needed);

    [DllImport("advapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);

    internal static uint? RunningProcessId() => RunningProcessId("PCControlPlaneEngine");

    internal static uint? RunningProcessId(string name)
    {
        using var manager = OpenSCManagerW(null, null, Connect);
        if (manager.IsInvalid) return null;
        using var service = OpenServiceW(manager, name, QueryStatus);
        if (service.IsInvalid || !QueryServiceStatusEx(service, ProcessInfo, out var status,
            (uint)Marshal.SizeOf<Status>(), out _) || status.State != Running || status.Pid == 0)
            return null;
        return status.Pid;
    }
}
