param(
  [Parameter(Mandatory = $true)][uint32]$HostProcessId,
  [Parameter(Mandatory = $true)][string]$ReceiptId,
  [Parameter(Mandatory = $true)][string]$PendingPath,
  [Parameter(Mandatory = $true)][string]$JobName
)
$ErrorActionPreference = 'Stop'
try {
  # Stop the verified host object before reaping its original Job; it cannot create the Job late.
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class WindowsHostRecovery {
  [StructLayout(LayoutKind.Sequential)] struct UnicodeText { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint Faults, Total, Active, Terminated; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int information, out Accounting accounting, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int information, IntPtr buffer, uint size, out uint needed);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static bool MatchesHost(IntPtr process,string receipt,string pending) {
    Guid id;
    if(!Guid.TryParseExact(receipt,"D",out id) || !pending.EndsWith(".pending."+receipt+".json",StringComparison.Ordinal))return false;
    uint size;
    // ProcessCommandLineInformation copies the retained process object's command line. A
    // process exit/recycled numeric PID cannot redirect this read or termination.
    NtQueryInformationProcess(process,60,IntPtr.Zero,0,out size);
    if(size<Marshal.SizeOf(typeof(UnicodeText)) || size>131072)throw new IOException("process-command");
    IntPtr buffer=Marshal.AllocHGlobal((int)size);
    try {
      if(NtQueryInformationProcess(process,60,buffer,size,out size)<0)throw new IOException("process-command");
      var text=(UnicodeText)Marshal.PtrToStructure(buffer,typeof(UnicodeText));
      long offset=text.Buffer.ToInt64()-buffer.ToInt64();
      if(offset<0 || offset+text.Length>size || text.Length%2!=0)throw new IOException("process-command");
      string command=Marshal.PtrToStringUni(text.Buffer,text.Length/2); int count;
      IntPtr argv=CommandLineToArgvW(command,out count);
      if(argv==IntPtr.Zero)throw new IOException("process-arguments");
      try {
        Func<int,string> argument=i=>Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,i*IntPtr.Size));
        return count>=5 && Path.GetFileName(argument(1)).Equals("kernel_process_host.js",StringComparison.OrdinalIgnoreCase)
          && argument(2).Equals(pending,StringComparison.OrdinalIgnoreCase) && argument(3)==receipt;
      } finally { LocalFree(argv); }
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static bool Recover(uint pid,string receipt,string pending,string jobName) {
    Guid id;
    if(!Guid.TryParseExact(receipt,"D",out id) || jobName!="Local\\OpenScience.Delegation."+receipt || !pending.EndsWith(".pending."+receipt+".json",StringComparison.Ordinal))return false;
    IntPtr process=IntPtr.Zero,job=IntPtr.Zero;
    var clock=Stopwatch.StartNew();
    try {
      process=OpenProcess(0x1000 | 0x100000 | 1,false,pid);
      if(process==IntPtr.Zero && Marshal.GetLastWin32Error()!=87)throw new IOException("process-open");
      job=OpenJobObject(4 | 8,false,jobName);
      if(job==IntPtr.Zero && Marshal.GetLastWin32Error()!=2)throw new IOException("job-open");
      if(process!=IntPtr.Zero) {
        uint state=WaitForSingleObject(process,0);
        if(state==258) {
          // A successful argv read can prove this is a replacement PID. Preserve that object
          // and reconcile only the original UUID Job. An unreadable identity throws instead.
          if(MatchesHost(process,receipt,pending)) {
            if(!TerminateProcess(process,1) && WaitForSingleObject(process,0)!=0)throw new IOException("process-terminate");
            if(WaitForSingleObject(process,5000)!=0)return false;
          }
        } else if(state!=0)throw new IOException("process-wait");
      }
      // No live host can launch later. Jobs contain every descendant from birth, including
      // children whose intermediate parent exited; a current PPID snapshot cannot prove this.
      if(job==IntPtr.Zero)job=OpenJobObject(4 | 8,false,jobName);
      if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2)return true; throw new IOException("job-open"); }
      if(!TerminateJobObject(job,1))throw new IOException("job-terminate");
      do {
        Accounting state;
        if(!QueryInformationJobObject(job,1,out state,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new IOException("job-query");
        if(state.Active==0)return true;
        Thread.Sleep(20);
      } while(clock.ElapsedMilliseconds<5000);
      return false;
    } finally { if(job!=IntPtr.Zero)CloseHandle(job); if(process!=IntPtr.Zero)CloseHandle(process); }
  }
}
'@
  $reaped = [WindowsHostRecovery]::Recover($HostProcessId, $ReceiptId, $PendingPath, $JobName)
  if ($reaped) { Write-Output '{"reaped":true}' } else { Write-Output '{"reaped":false}' }
} catch {
  $stage = $_.Exception.GetBaseException().Message
  if ($stage -notmatch '^[a-z-]+$') { $stage = 'host-recovery' }
  [Console]::Error.WriteLine("stage=$stage")
  exit 2
}
