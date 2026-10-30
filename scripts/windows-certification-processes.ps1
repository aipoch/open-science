param(
  [Parameter(Mandatory = $true)][ValidateSet('Inspect', 'Terminate', 'Suspend')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Root,
  [int]$TargetPid = 0,
  [long]$ExpectedStartedAt = 0,
  [string]$SignalFile,
  [string]$ReleaseFile
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class CertificationProcesses {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr handle);
  public class Identity { public int pid; public string executablePath; public long startedAt; }
  public static Identity[] Run(string directory, int targetPid, bool terminate, bool suspend, long expectedStartedAt, string signalFile, string releaseFile) {
    string root = Path.GetFullPath(directory).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
    var results = new List<Identity>();
    foreach (Process process in Process.GetProcesses()) {
      using (process) {
        int pid = process.Id;
        if (targetPid != 0 && pid != targetPid) continue;
        // Verification and termination share this handle. PID reuse cannot redirect the kill.
        IntPtr handle = OpenProcess(0x00100000 | 0x1000 | (terminate ? 1u : 0u) | (suspend ? 0x0800u : 0u), false, pid);
        if (handle == IntPtr.Zero) {
          if (targetPid != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
          continue;
        }
        try {
          if (WaitForSingleObject(handle, 0) == 0) continue;
          int size = 32768; var image = new StringBuilder(size);
          if (!QueryFullProcessImageName(handle, 0, image, ref size)) {
            if (targetPid != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            continue;
          }
          string path = Path.GetFullPath(image.ToString());
          if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
          long created, exited, kernel, user;
          if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
          long startedAt = new DateTimeOffset(DateTime.FromFileTimeUtc(created)).ToUnixTimeMilliseconds();
          if (expectedStartedAt != 0 && expectedStartedAt != startedAt) throw new Exception("Target process identity changed");
          results.Add(new Identity { pid=pid, executablePath=path, startedAt=startedAt });
          if (suspend) {
            if (NtSuspendProcess(handle) != 0) throw new Exception("Could not suspend verified fixture process");
            try {
              File.WriteAllText(signalFile, "suspended");
              var deadline = DateTime.UtcNow.AddMinutes(5);
              while (!File.Exists(releaseFile) && WaitForSingleObject(handle, 50) != 0) {
                if (DateTime.UtcNow >= deadline) throw new Exception("Fixture suspension exceeded its bounded lifetime");
              }
            } finally {
              if (WaitForSingleObject(handle, 0) != 0 && NtResumeProcess(handle) != 0)
                throw new Exception("Could not resume verified fixture process");
            }
          }
          if (terminate && WaitForSingleObject(handle, 0) != 0) {
            if (!TerminateProcess(handle, 1) && WaitForSingleObject(handle, 0) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (WaitForSingleObject(handle, 10000) != 0) throw new Exception("Owned test process did not exit: " + pid);
          }
        } finally { CloseHandle(handle); }
      }
    }
    return results.ToArray();
  }
}
'@
if ($Mode -eq 'Suspend' -and ($TargetPid -lt 1 -or $ExpectedStartedAt -lt 1 -or !$SignalFile -or !$ReleaseFile)) {
  throw 'Suspension requires exact process identity and fixture control files'
}
$result = @([CertificationProcesses]::Run($Root, $TargetPid, $Mode -eq 'Terminate', $Mode -eq 'Suspend', $ExpectedStartedAt, $SignalFile, $ReleaseFile))
if ($Mode -eq 'Suspend' -and $result.Count -ne 1) { throw 'The intended suspension target was not found' }
ConvertTo-Json -InputObject $result -Compress
