[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $InputDocx,
    [Parameter(Mandatory = $true)][string] $OutputPdf
)

$ErrorActionPreference = 'Stop'
$inputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InputDocx)
$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPdf)
if ([IO.Path]::GetExtension($inputPath) -ne '.docx' -or ![IO.File]::Exists($inputPath)) {
    throw 'Input must be an existing DOCX file.'
}
if ([IO.Path]::GetExtension($outputPath) -ne '.pdf' -or [IO.File]::Exists($outputPath)) {
    throw 'Output must be a new PDF filename.'
}
$outputDirectory = [IO.Path]::GetDirectoryName($outputPath)
if (![IO.Directory]::Exists($outputDirectory)) { throw 'The output directory does not exist.' }

if (!('OpenScience.WordPdf.NativeWindow' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenScience.WordPdf {
    public static class NativeWindow {
        private delegate bool VisitWindow(IntPtr window, IntPtr unused);
        [DllImport("user32.dll")] private static extern bool EnumWindows(VisitWindow visit, IntPtr unused);
        [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr owner, VisitWindow visit, IntPtr unused);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
        [DllImport("oleacc.dll")]
        private static extern int AccessibleObjectFromWindow(IntPtr window, uint id, ref Guid iid,
            [MarshalAs(UnmanagedType.IDispatch)] out object result);
        [DllImport("kernel32.dll")]
        private static extern bool QueryInformationJobObject(IntPtr job, int infoClass,
            IntPtr info, uint size, IntPtr returnedLength);

        public static bool InCurrentJob(Process process) {
            // JobObjectBasicProcessIdList for the job of this PowerShell process.
            // If membership cannot be proved with this bounded query, refuse the export.
            const int capacity = 128;
            const int header = 8;
            int bytes = header + capacity * IntPtr.Size;
            IntPtr list = Marshal.AllocHGlobal(bytes);
            try {
                if (!QueryInformationJobObject(IntPtr.Zero, 3, list, (uint)bytes, IntPtr.Zero))
                    return false;
                int count = Marshal.ReadInt32(list, 4);
                if (count < 0 || count > capacity || process.HasExited) return false;
                for (int i = 0; i < count; i++) {
                    if (Marshal.ReadIntPtr(list, header + i * IntPtr.Size).ToInt64() == process.Id)
                        return true;
                }
                return false;
            } finally { Marshal.FreeHGlobal(list); }
        }

        private static bool OwnedBy(IntPtr window, int expectedPid) {
            uint owner;
            return GetWindowThreadProcessId(window, out owner) != 0 && owner == expectedPid;
        }

        public static object FindWordWindow(Process process) {
            IntPtr match = IntPtr.Zero;
            int pid = process.Id;
            EnumWindows(delegate(IntPtr top, IntPtr unused) {
                if (!OwnedBy(top, pid)) return true;
                EnumChildWindows(top, delegate(IntPtr child, IntPtr ignored) {
                    StringBuilder name = new StringBuilder(16);
                    if (OwnedBy(child, pid) && GetClassName(child, name, name.Capacity) > 0 &&
                            name.ToString() == "_WwG") {
                        match = child;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);
                return match == IntPtr.Zero;
            }, IntPtr.Zero);

            // Bind only this child process's native object model, never the global COM instance.
            if (match == IntPtr.Zero || process.HasExited || !OwnedBy(match, pid)) return null;
            Guid dispatch = new Guid("00020400-0000-0000-C000-000000000046");
            object result;
            return AccessibleObjectFromWindow(match, unchecked((uint)-16), ref dispatch, out result) == 0 &&
                !process.HasExited && OwnedBy(match, pid) ? result : null;
        }
    }
}
"@
}

try {
    $shell = [Diagnostics.Process]::GetCurrentProcess()
    if (![OpenScience.WordPdf.NativeWindow]::InCurrentJob($shell)) {
        throw 'Run this converter in the supervised Windows Notebook Shell.'
    }
} finally {
    if ($shell) { $shell.Dispose() }
}

$wordExe = $null
foreach ($view in 'Registry64', 'Registry32') {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', $view)
    try {
        $key = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE')
        if ($key) {
            try { $candidate = ([string] $key.GetValue('')).Trim('"') } finally { $key.Dispose() }
            if ([IO.Path]::IsPathRooted($candidate) -and [IO.File]::Exists($candidate)) {
                $wordExe = $candidate
                break
            }
        }
    } finally { $base.Dispose() }
}
if (!$wordExe) { throw 'Microsoft Word desktop is not registered on this computer.' }

$stage = [IO.Path]::Combine($env:TEMP, ('word-pdf-' + [Guid]::NewGuid().ToString('N')))
$stagedPdf = [IO.Path]::Combine($stage, 'export.pdf')
$publishPath = $null
$child = $window = $word = $document = $null
try {
    [void] [IO.Directory]::CreateDirectory($stage)
    $start = [Diagnostics.ProcessStartInfo]::new($wordExe, '/w /q /a')
    $start.UseShellExecute = $false
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Minimized
    $child = [Diagnostics.Process]::Start($start)
    if ($child.HasExited -or ![OpenScience.WordPdf.NativeWindow]::InCurrentJob($child)) {
        throw 'Could not verify a supervised Word process.'
    }
    $wait = [Diagnostics.Stopwatch]::StartNew()
    while (!$window -and !$child.HasExited -and $wait.Elapsed.TotalSeconds -lt 30) {
        $window = [OpenScience.WordPdf.NativeWindow]::FindWordWindow($child)
        if (!$window) { Start-Sleep -Milliseconds 100 }
    }
    if (!$window) { throw 'Could not bind to the dedicated Word instance.' }

    $word = $window.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3 # Disable macros before opening the input.
    $document = $word.Documents.Open($inputPath, $false, $true, $false)
    $document.ExportAsFixedFormat($stagedPdf, 17)
    $document.Close(0)
    $word.Quit(0)
    if (!$child.WaitForExit(5000)) { throw 'The dedicated Word process did not exit.' }
    if (([IO.FileInfo]::new($stagedPdf)).Length -eq 0) { throw 'Word did not write a PDF.' }

    # Stage beside the destination so the final non-overwriting move is on one volume.
    $publish = [IO.Path]::Combine($outputDirectory, ('.word-pdf-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    $destination = [IO.File]::Open($publish, 'CreateNew', 'Write', 'None')
    $publishPath = $publish
    try {
        $source = [IO.File]::OpenRead($stagedPdf)
        try { $source.CopyTo($destination) } finally { $source.Dispose() }
    } finally { $destination.Dispose() }
    [IO.File]::Move($publishPath, $outputPath)
    $publishPath = $null
    @{ output_path = $outputPath; mime_type = 'application/pdf' } | ConvertTo-Json -Compress
} finally {
    try {
        if ($child -and !$child.HasExited) {
            # The Process retains the original handle. Never locate or kill Word by name or PID.
            $child.Kill()
            if (!$child.WaitForExit(5000)) { throw 'Could not confirm the dedicated Word process exited.' }
        }
    } finally {
        if ($child) { $child.Dispose() }
        foreach ($proxy in $document, $word, $window) {
            if ($proxy -and [Runtime.InteropServices.Marshal]::IsComObject($proxy)) {
                [void] [Runtime.InteropServices.Marshal]::ReleaseComObject($proxy)
            }
        }
        if ($publishPath) { [IO.File]::Delete($publishPath) }
        [IO.File]::Delete($stagedPdf)
        if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage) }
    }
}
