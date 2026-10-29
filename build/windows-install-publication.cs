using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.IO;
using System.Text;
using System.Collections.Generic;
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
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct BasicInformation {
    public long Creation; public long Access; public long Write; public long Change;
    public uint Attributes;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref byte disposition, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref BasicInformation information, uint size);
  sealed class PendingRemoval {
    public SafeFileHandle Handle;
    public SafeFileHandle AttributeHandle;
    public uint OriginalAttributes;
    public bool Marked;
  }
  static void SetAttributes(SafeFileHandle handle, uint attributes) {
    var info = new BasicInformation();
    info.Attributes = attributes == 0 ? 0x80 : attributes;
    if (!SetFileInformationByHandle(handle, 0, ref info, (uint)Marshal.SizeOf(info)))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static IEnumerable<string> ProgramLeaves(string directory) {
    foreach (var path in Directory.GetFileSystemEntries(directory)) {
      var attributes = File.GetAttributes(path);
      if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == FileAttributes.Directory) {
        foreach (var child in ProgramLeaves(path)) yield return child;
      } else yield return path;
    }
  }
  // Only the caller's freshly staged program tree is accepted. No configured data is staged.
  // Classic FileDispositionInfo remains reversible until the handles close. Do not substitute
  // DELETE_ON_CLOSE or POSIX unlink: either would defeat cancellation after a later failure.
  public static void RemoveStagedProgramFiles(string directory) {
    using (Hold(directory)) {
      var pending = new List<PendingRemoval>();
      try {
        try {
          foreach (var path in ProgramLeaves(directory)) {
            var entry = new PendingRemoval();
            pending.Add(entry);
            // Exclusive data/delete sharing; OPEN_REPARSE_POINT removes links, never targets.
            entry.Handle = CreateFile(path, 0x10080, 0, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (entry.Handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
            Information info;
            if (!GetFileInformationByHandle(entry.Handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
            if ((info.Attributes & 0x410) == 0x10) throw new IOException("Program entry became a directory: " + path);
            if ((info.Attributes & 1) != 0) {
              // Attribute-only access is compatible with the exclusive deletion handle.
              entry.AttributeHandle = CreateFile(path, 0x100, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
              if (entry.AttributeHandle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
              SetAttributes(entry.AttributeHandle, info.Attributes & ~1u);
              entry.OriginalAttributes = info.Attributes;
            }
            byte remove = 1;
            if (!SetFileInformationByHandle(entry.Handle, 4, ref remove, 1)) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
            entry.Marked = true;
          }
        } catch (Exception failure) {
          var errors = new List<Exception>();
          errors.Add(failure);
          // Cancel every pending deletion before releasing any handle or restoring attributes.
          foreach (var entry in pending) {
            if (!entry.Marked) continue;
            byte keep = 0;
            if (!SetFileInformationByHandle(entry.Handle, 4, ref keep, 1))
              errors.Add(new Win32Exception(Marshal.GetLastWin32Error(), "Could not cancel program deletion."));
          }
          foreach (var entry in pending) {
            if (entry.OriginalAttributes == 0) continue;
            try { SetAttributes(entry.AttributeHandle, entry.OriginalAttributes); }
            catch (Exception error) { errors.Add(error); }
          }
          throw new AggregateException("Program cleanup failed before commit.", errors);
        }
      } finally {
        // Closing commits only after all entries are marked, or after cancellation on failure.
        foreach (var entry in pending) {
          if (entry.AttributeHandle != null) entry.AttributeHandle.Dispose();
          if (entry.Handle != null) entry.Handle.Dispose();
        }
      }
    }
  }
  public static string CanonicalPath(string path) {
    var missing = new Stack<string>();
    var current = Path.GetFullPath(path);
    while (true) {
      using (var handle = CreateFile(current, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
        if (!handle.IsInvalid) {
          var buffer = new StringBuilder(32768);
          var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
          if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
          var resolved = buffer.ToString();
          if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) resolved = @"\\" + resolved.Substring(8);
          else if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal)) resolved = resolved.Substring(4);
          while (missing.Count > 0) resolved = Path.Combine(resolved, missing.Pop());
          return resolved;
        }
        var error = Marshal.GetLastWin32Error();
        if (error != 2 && error != 3) throw new Win32Exception(error);
        var parent = Path.GetDirectoryName(current);
        if (String.IsNullOrEmpty(parent)) throw new Win32Exception(error);
        missing.Push(Path.GetFileName(current));
        current = parent;
      }
    }
  }
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
