using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class InstallDirectory {
  [StructLayout(LayoutKind.Sequential, Pack=4)] struct Information {
    public uint Attributes; public long Creation; public long Access; public long Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information information);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateDirectory(string path, IntPtr security);
  public static void Create(string path) {
    if (!CreateDirectory(path, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static SafeFileHandle Hold(string path) {
    // No delete sharing: the installation ancestors cannot be renamed while this action runs.
    var handle = CreateFile(path, 0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    Information info;
    if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x410) != 0x10) {
      handle.Dispose(); throw new InvalidOperationException("Expected a directory without a reparse point: " + path);
    }
    return handle;
  }
  public static string Identity(SafeFileHandle handle) {
    Information info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return info.Volume.ToString("X8") + ":" + info.IndexHigh.ToString("X8") + info.IndexLow.ToString("X8");
  }
}
