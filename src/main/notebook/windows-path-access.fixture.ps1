param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
# Keep a WRITE_DAC handle open before restricting this test-owned directory so
# cleanup does not need elevation, ownership changes, or broad filesystem access.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class ReadOnlyPathFixture {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFile(string p, uint access, uint share, IntPtr sa, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr h, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr h, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr sd, out uint size);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorControl(IntPtr sd, out ushort control, out uint revision);
  static void Check(uint result) { if (result != 0) throw new Win32Exception((int)result); }
  public static void Hold(string path) {
    if (!System.IO.File.Exists(System.IO.Path.Combine(path, ".acl-probe-owned")))
      throw new InvalidOperationException("Not a test-owned fixture.");
    IntPtr handle = CreateFile(path, 0x60000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception();
    IntPtr owner, group, dacl, sacl, original;
    Check(GetSecurityInfo(handle, 1, 4, out owner, out group, out dacl, out sacl, out original));
    ushort control; uint revision;
    GetSecurityDescriptorControl(original, out control, out revision);
    IntPtr restricted = IntPtr.Zero;
    try {
      uint size;
      string sid = WindowsIdentity.GetCurrent().User.Value;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;OICI;FRFX;;;" + sid + ")(A;;RC;;;OW)", 1, out restricted, out size))
        throw new Win32Exception();
      bool present, defaulted; IntPtr nextDacl;
      GetSecurityDescriptorDacl(restricted, out present, out nextDacl, out defaulted);
      Check(SetSecurityInfo(handle, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, nextDacl, IntPtr.Zero));
      IntPtr denied = CreateFile(path, 0x40000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
      if (denied != new IntPtr(-1)) { CloseHandle(denied); throw new Exception("Fixture still permits WRITE_DAC."); }
      if (Marshal.GetLastWin32Error() != 5) throw new Win32Exception();
      Console.WriteLine("READABLE_WITHOUT_WRITE_DAC");
      Console.Out.Flush();
      Console.ReadLine();
    } finally {
      Check(SetSecurityInfo(handle, 1, ((control & 0x1000) != 0 ? 0x80000000u : 0x20000000u) | 4, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero));
      if (restricted != IntPtr.Zero) LocalFree(restricted);
      LocalFree(original);
      CloseHandle(handle);
    }
  }
}
'@
# The child remains independently grantable even while its parent rejects WRITE_DAC.
$child = Join-Path $Directory 'bin'
if (!(Test-Path -LiteralPath (Join-Path $child '.acl-probe-owned'))) {
  throw 'Missing test-owned child fixture.'
}
$originalChildAcl = [IO.Directory]::GetAccessControl($child)
$protectedChildAcl = [IO.Directory]::GetAccessControl($child)
$protectedChildAcl.SetAccessRuleProtection($true, $true)
try {
  [IO.Directory]::SetAccessControl($child, $protectedChildAcl)
  [ReadOnlyPathFixture]::Hold($Directory)
} finally {
  [IO.Directory]::SetAccessControl($child, $originalChildAcl)
}
