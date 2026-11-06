param(
  [Parameter(Mandatory = $true)][ValidateSet('DenyPublication', 'StartShortcut', 'LaunchShortcut')][string]$Mode,
  [string]$Root,
  [string]$SignalFile,
  [string]$ReleaseFile,
  [string]$Shortcut
)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'DenyPublication') {
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if ([IO.Path]::GetPathRoot($rootPath).TrimEnd('\') -eq $rootPath -or !(Test-Path -LiteralPath (Join-Path $rootPath 'open-science.exe'))) {
    throw 'A populated disposable installation is required for publication failure injection'
  }
  $original = [IO.Directory]::GetAccessControl($rootPath)
  $originalAccess = $original.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  $changed = [IO.Directory]::GetAccessControl($rootPath)
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CertificationDirectoryHold {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Open(string path) {
    IntPtr handle=CreateFile(path,0x80,3,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
    if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
}
'@
  # Keep this directory object in place while allowing deletion of its contents.
  $directoryHandle = [CertificationDirectoryHold]::Open($rootPath)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  # This directory only, not children: old files may be deleted, but publishing a new root file
  # must fail. The exact original descriptor is restored before attempting ordinary recovery.
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity.User,
    [Security.AccessControl.FileSystemRights]::CreateFiles,
    [Security.AccessControl.InheritanceFlags]::None,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Deny)
  $changed.AddAccessRule($rule)
  try {
    [IO.Directory]::SetAccessControl($rootPath, $changed)
    [IO.File]::WriteAllText($SignalFile, 'publication-denied')
    $deadline = [DateTime]::UtcNow.AddMinutes(8)
    while (!(Test-Path -LiteralPath $ReleaseFile)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Publication fault exceeded its bounded lifetime' }
      Start-Sleep -Milliseconds 50
    }
  } finally {
    try {
      # A freshly read DirectorySecurity has no dirty sections; setting it directly is a no-op.
      # Mark the saved access descriptor as changed before persisting the original ACL.
      $original.SetSecurityDescriptorSddlForm($originalAccess, [Security.AccessControl.AccessControlSections]::Access)
      [IO.Directory]::SetAccessControl($rootPath, $original)
    }
    finally { [CertificationDirectoryHold]::CloseHandle($directoryHandle) | Out-Null }
  }
  exit 0
}

if (!(Test-Path -LiteralPath $Shortcut -PathType Leaf) -or [IO.Path]::GetExtension($Shortcut) -ine '.lnk') {
  throw 'An existing ordinary shortcut is required'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$administrator = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Mode -eq 'LaunchShortcut' -or !$administrator) {
  if ($administrator) { throw 'The ordinary launch entry must run with a non-administrator token' }
  # No operation ID, setup path, or recovery arguments are supplied by the fixture.
  Start-Process -FilePath $Shortcut -WindowStyle Hidden
  [Console]::Out.Write('{"ordinaryShortcut":true,"administrator":false}')
  exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class CertificationMediumLaunch {
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved; public string desktop; public string title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2;
    public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr info,int size,out int returned);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr info,int size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint count,ref SID_AND_ATTRIBUTES disabled,uint privilegeCount,IntPtr privileges,uint restrictedCount,IntPtr restricted,out IntPtr result);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,uint flags,string app,StringBuilder command,uint creation,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  static void Check(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Run(string executable,string command,string directory) {
    IntPtr original=IntPtr.Zero, target=IntPtr.Zero, admin=IntPtr.Zero, medium=IntPtr.Zero;
    IntPtr info=Marshal.AllocHGlobal(64);
    try {
      Check(OpenProcessToken(GetCurrentProcess(),0x0002|0x0008|0x0080|0x0001,out original));
      int count;
      Check(GetTokenInformation(original,18,info,64,out count));
      if(Marshal.ReadInt32(info)==2 && GetTokenInformation(original,19,info,64,out count)) {
        target=Marshal.ReadIntPtr(info);
      } else {
        Check(ConvertStringSidToSid("S-1-5-32-544",out admin));
        var disabled=new SID_AND_ATTRIBUTES { Sid=admin, Attributes=0 };
        Check(CreateRestrictedToken(original,1,1,ref disabled,0,IntPtr.Zero,0,IntPtr.Zero,out target));
        Check(ConvertStringSidToSid("S-1-16-8192",out medium));
        var label=new SID_AND_ATTRIBUTES { Sid=medium, Attributes=0x20 };
        Marshal.StructureToPtr(label,info,false);
        Check(SetTokenInformation(target,25,info,Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))+(int)GetLengthSid(medium)));
      }
      var startup=new STARTUPINFO { cb=Marshal.SizeOf(typeof(STARTUPINFO)), flags=1, show=0 };
      PROCESS_INFORMATION process;
      Check(CreateProcessWithTokenW(target,1,executable,new StringBuilder(command),0x08000000,IntPtr.Zero,directory,ref startup,out process));
      try {
        if(WaitForSingleObject(process.process,30000)!=0) throw new Exception("Non-elevated shortcut launcher timed out");
        uint code; Check(GetExitCodeProcess(process.process,out code));
        if(code!=0) throw new Exception("Non-elevated shortcut launcher failed: "+code);
      } finally { CloseHandle(process.thread); CloseHandle(process.process); }
    } finally {
      if(target!=IntPtr.Zero) CloseHandle(target);
      if(original!=IntPtr.Zero) CloseHandle(original);
      if(admin!=IntPtr.Zero) LocalFree(admin);
      if(medium!=IntPtr.Zero) LocalFree(medium);
      Marshal.FreeHGlobal(info);
    }
  }
}
'@
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = '"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Mode LaunchShortcut -Shortcut "' + $Shortcut + '"'
[CertificationMediumLaunch]::Run($powershell, $command, [IO.Path]::GetDirectoryName($PSCommandPath))
[Console]::Out.Write('{"ordinaryShortcut":true,"administrator":false,"sameUserMediumToken":true}')
