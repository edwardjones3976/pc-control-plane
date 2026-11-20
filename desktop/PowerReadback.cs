using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class PowerReadback
{
    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerReadFriendlyName(IntPtr root, IntPtr scheme, IntPtr subgroup,
        IntPtr setting, [Out] byte[] buffer, ref uint size);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    internal static (Guid Id, string? Name)? Read()
    {
        if (PowerGetActiveScheme(IntPtr.Zero, out var scheme) != 0 || scheme == IntPtr.Zero)
            return null;
        try
        {
            var id = Marshal.PtrToStructure<Guid>(scheme);
            byte[] buffer = new byte[4096];
            uint size = (uint)buffer.Length;
            var result = PowerReadFriendlyName(IntPtr.Zero, scheme, IntPtr.Zero, IntPtr.Zero, buffer, ref size);
            string? name = result == 0 && size <= buffer.Length && size % 2 == 0
                ? Encoding.Unicode.GetString(buffer, 0, (int)size).TrimEnd('\0') : null;
            return (id, string.IsNullOrWhiteSpace(name) ? null : name);
        }
        finally { LocalFree(scheme); }
    }
}
