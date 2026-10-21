param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$nativeSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'HandoffObserver.cs'))
Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies 'System.Web.Extensions'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FixtureProcessPermissions {
  public static bool BroadQueryDenied(int pid) {
    using(var process=System.Diagnostics.Process.GetProcessById(pid)) {
      try { var handle=process.Handle; return false; }
      catch(System.ComponentModel.Win32Exception error) { if(error.NativeErrorCode==5) return true; throw; }
    }
  }
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);
  [StructLayout(LayoutKind.Sequential, Pack=1)] struct Privilege { public uint count; public long luid; public uint attributes; }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValueW(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool all, ref Privilege state, int size, IntPtr old, IntPtr needed);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void DisableDebugPrivilege() {
    IntPtr token; long luid;
    if(!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle,0x28,out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      if(!LookupPrivilegeValueW(null,"SeDebugPrivilege",out luid)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var state = new Privilege { count=1,luid=luid,attributes=0 };
      if(!AdjustTokenPrivileges(token,false,ref state,0,IntPtr.Zero,IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(token); }
  }
}
'@
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = (Get-Command node.exe).Source
$start.Arguments = '-e "process.stdin.once(''data'',()=>process.exit(0));console.log(''ready'')"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$child = [Diagnostics.Process]::Start($start)
$identity = $null
try {
  if ($child.StandardOutput.ReadLine() -ne 'ready') { throw 'Fixture did not start' }
  $originalHandle = $child.Handle
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # Only this newly-created synthetic child: deny broad query/memory access,
  # retain QUERY_LIMITED_INFORMATION and SYNCHRONIZE for identity/exit observation.
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new("D:(D;;0x430;;;$sid)(A;;GA;;;$sid)")
  $bytes = New-Object byte[] $descriptor.BinaryLength
  $descriptor.GetBinaryForm($bytes,0)
  if (-not [FixtureProcessPermissions]::SetKernelObjectSecurity($originalHandle,4,$bytes)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  [FixtureProcessPermissions]::DisableDebugPrivilege()
  $denied = [FixtureProcessPermissions]::BroadQueryDenied($child.Id)
  if (-not $denied) { throw 'Fixture failed to reproduce excessive access denial' }
  $method = [HandoffObserver].GetMethod('Capture',[Reflection.BindingFlags]'NonPublic,Static')
  $identity = $method.Invoke($null,@([int]$child.Id,[int]$PID))
  if (-not $identity -or $identity.pid -ne $child.Id -or $identity.process.HasExited) { throw 'Read-only observer did not retain the live fixture' }
  if ([IO.Path]::GetFullPath($identity.path) -ne [IO.Path]::GetFullPath($start.FileName)) { throw 'Observer returned wrong executable' }
  $restricted = [Security.AccessControl.RawSecurityDescriptor]::new("D:(D;;0x1000;;;$sid)(A;;GA;;;$sid)")
  $restrictedBytes = New-Object byte[] $restricted.BinaryLength
  $restricted.GetBinaryForm($restrictedBytes,0)
  if (-not [FixtureProcessPermissions]::SetKernelObjectSecurity($originalHandle,4,$restrictedBytes)) { throw 'Cannot prepare denied-query fixture' }
  $readDenied = $false
  try { $unexpected = $method.Invoke($null,@([int]$child.Id,[int]$PID)); if ($unexpected) { $unexpected.process.Dispose() } }
  catch { $readDenied = $_.Exception.GetBaseException().NativeErrorCode -eq 5 }
  if (-not $readDenied) { throw 'Observer hid a real limited-query access denial' }
  $child.StandardInput.WriteLine('exit')
  if (-not $child.WaitForExit(10000)) { throw 'Fixture did not exit normally' }
  if (-not $identity.process.HasExited -or $child.ExitCode -ne 0 -or $identity.process.ExitCode -ne 0) { throw 'Recorded exit not confirmed' }
  @{status='PASS';pid=$child.Id;allAccessDenied=$denied;readDeniedRemainsFatal=$readDenied;readOnlyIdentity=$identity.path;exitCode=$child.ExitCode;forced=$false} | ConvertTo-Json | Set-Content -LiteralPath $Output
} finally {
  if (-not $child.HasExited) { $child.StandardInput.WriteLine('exit'); if (-not $child.WaitForExit(10000)) { throw 'Synthetic fixture failed cleanup' } }
  if ($identity) { $identity.process.Dispose() }
  $child.Dispose()
}
