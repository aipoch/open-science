param(
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [switch]$SkipNode,
    [switch]$SkipPowerShell
)

# Run with PowerShell 7, Python 3, Git and VS 2022 C++ Build Tools with ClangCL available.
# A short, dedicated BuildRoot avoids MAX_PATH failures in Node's source generator.
$ErrorActionPreference = 'Stop'
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if ($BuildRoot.Length -gt 75) { throw 'Use a dedicated build directory with an absolute path shorter than 76 characters.' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'The pinned runtime build currently supports Windows x64 only.' }
$sources = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'sources.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$stage = Join-Path $PSScriptRoot 'x64'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
# An interrupted build must not be mistaken for a completed runtime.
$marker = Join-Path $stage 'build.json'
if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker }

function Get-Source($source, [string]$name) {
    $archive = Join-Path $BuildRoot $name
    $candidate = $archive
    if (!(Test-Path -LiteralPath $archive)) {
        $candidate = "$archive.download"
        Write-Host "Downloading $name from $($source.url)"
        # Bound the entire transfer as well as connection setup. A stalled upstream must not
        # consume the compiler's job budget. Incomplete downloads never become reusable archives.
        & curl.exe --disable --fail --location --silent --show-error --connect-timeout 30 --max-time 300 --retry 2 --retry-delay 2 --retry-max-time 600 --output $candidate $source.url
        if ($LASTEXITCODE -ne 0) { throw "Source download failed: $name (curl exit $LASTEXITCODE)" }
    }
    $algorithm = if ($source.sha512) { 'SHA512' } else { 'SHA256' }
    $expected = if ($source.sha512) { $source.sha512 } else { $source.sha256 }
    Write-Host "Verifying $name"
    if ((Get-FileHash -LiteralPath $candidate -Algorithm $algorithm).Hash -ne $expected) {
        throw "Source checksum mismatch: $name"
    }
    if ($candidate -ne $archive) { Move-Item -LiteralPath $candidate -Destination $archive }
    return $archive
}

function Expand-Source([string]$archive, [string]$source, [int]$TimeoutSeconds = 300) {
    if (Test-Path -LiteralPath $source) { return }
    $partial = "$source.extracting"
    if (Test-Path -LiteralPath $partial) {
        throw "Incomplete source extraction: $partial. Inspect it and use a fresh BuildRoot."
    }
    New-Item -ItemType Directory -Path $partial | Out-Null
    # Python is already required by Node's build. Use its native gzip/lzma support instead
    # of PATH-dependent tar implementations and their external decompressor processes.
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    foreach ($argument in @('-u', '-c', @'
import sys, tarfile
print("Source extractor: " + sys.executable + " (Python " + sys.version.split()[0] + ")", flush=True)
with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2], filter="data")
'@, $archive, $partial)) { $start.ArgumentList.Add($argument) }
    Write-Host "Extracting $archive with $($start.FileName); deadline ${TimeoutSeconds}s"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = [Diagnostics.Process]::Start($start)
    try {
        $process.StandardInput.Close()
        while ($true) {
            $remaining = $TimeoutSeconds * 1000 - $timer.ElapsedMilliseconds
            if ($remaining -le 0) {
                $process.Kill($true)
                if (!$process.WaitForExit(5000)) { throw "Source extractor did not stop: $archive" }
                throw "Source extraction timed out: $archive after ${TimeoutSeconds}s; partial files: $partial"
            }
            if ($process.WaitForExit([int][Math]::Min(30000, $remaining))) { break }
            Write-Host "Extracting $archive; elapsed $([int]$timer.Elapsed.TotalSeconds)s"
        }
        if ($process.ExitCode -ne 0) { throw "Source extraction failed: $archive (exit $($process.ExitCode)); partial files: $partial" }
        $extracted = Join-Path $partial (Split-Path $source -Leaf)
        if (!(Test-Path -LiteralPath $extracted -PathType Container)) { throw "Source extraction failed: expected directory $extracted" }
        Move-Item -LiteralPath $extracted -Destination $source
        [IO.Directory]::Delete($partial)
        Write-Host "Extracted $archive in $([Math]::Round($timer.Elapsed.TotalSeconds, 1))s"
    } finally { $process.Dispose() }
}

function Apply-Patch([string]$source, [string]$patch) {
    Push-Location $source
    try {
        & git apply --check --ignore-whitespace $patch 2>$null
        if ($LASTEXITCODE -eq 0) {
            & git apply --ignore-whitespace $patch
            if ($LASTEXITCODE -ne 0) { throw "Cannot apply $patch" }
        } else {
            & git apply --reverse --check --ignore-whitespace $patch
            if ($LASTEXITCODE -ne 0) { throw "Unexpected source state: $patch" }
        }
    } finally { Pop-Location }
}

if (!$SkipNode) {
    $archive = Get-Source $sources.node 'node.tar.xz'
    $source = Join-Path $BuildRoot "node-v$($sources.node.version)"
    Expand-Source $archive $source
    Write-Host 'Applying Node patch'
    Apply-Patch $source (Join-Path $PSScriptRoot 'node-appcontainer.patch')
    Push-Location $source
    try {
        Write-Host "Building Node $($sources.node.version) with VS 2022 / ClangCL"
        $env:msbuild_args = '/m:1 /p:MultiProcMaxCount=2 /p:MultiProcessorCompilation=false /p:CL_MPCount=1'
        & .\vcbuild.bat x64 vs2022 clang-cl no-cctest openssl-no-asm
        if ($LASTEXITCODE -ne 0) { throw 'Node build failed' }
    } finally { Pop-Location }
    $node = Join-Path $stage 'node'
    New-Item -ItemType Directory -Force -Path (Join-Path $node 'node_modules') | Out-Null
    Copy-Item -LiteralPath (Join-Path $source 'Release/node.exe') -Destination $node
    Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $node 'LICENSE.node')
    Copy-Item -LiteralPath (Join-Path $source 'deps/npm') -Destination (Join-Path $node 'node_modules') -Recurse -Force
    foreach ($shim in @('npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1')) {
        Copy-Item -LiteralPath (Join-Path $source "deps/npm/bin/$shim") -Destination $node -Force
    }
}

if (!$SkipPowerShell) {
    $archive = Get-Source $sources.powershell 'powershell.tar.gz'
    $source = Join-Path $BuildRoot "PowerShell-$($sources.powershell.version)"
    Expand-Source $archive $source
    Write-Host 'Applying PowerShell patch'
    Apply-Patch $source (Join-Path $PSScriptRoot 'powershell-appcontainer.patch')
    Apply-Patch $source (Join-Path $PSScriptRoot 'powershell-build-metadata.patch')
    if ($sources.powershell.commit -notmatch '^[0-9a-f]{40}$') {
        throw 'PowerShell source commit must be pinned in sources.json.'
    }
    $sdkArchive = Get-Source $sources.dotnet 'dotnet.zip'
    $sdk = Join-Path $BuildRoot 'dotnet'
    if (!(Test-Path -LiteralPath (Join-Path $sdk 'dotnet.exe'))) {
        Write-Host 'Extracting .NET SDK'
        Expand-Archive -LiteralPath $sdkArchive -DestinationPath $sdk
    }
    $env:DOTNET_CLI_HOME = $BuildRoot
    $env:NUGET_PACKAGES = Join-Path $BuildRoot 'nuget'
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
    $env:PATH = "$sdk;$env:PATH"
    $previousPowerShellVersion = $env:PowerShellVersion
    # The verified release archive has no .git directory. Supply its pinned upstream identity;
    # never derive PowerShell metadata from the enclosing application's Git repository.
    $env:PowerShellVersion = "v$($sources.powershell.version)-0-g$($sources.powershell.commit)"
    Push-Location $source
    try {
        Write-Host 'Building PowerShell'
        Import-Module ./build.psm1
        Start-PSBuild -Configuration Release -Runtime win7-x64 -ReleaseTag "v$($sources.powershell.version)" -NoPSModuleRestore -Output (Join-Path $stage 'powershell')
    } finally {
        Pop-Location
        $env:PowerShellVersion = $previousPowerShellVersion
    }
}

foreach ($file in @('node/node.exe', 'node/node_modules/npm/bin/npm-cli.js', 'powershell/pwsh.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $stage $file))) { throw "Runtime incomplete: $file" }
}
@{ node = $sources.node.version; powershell = $sources.powershell.version;
    powershellSourceCommit = $sources.powershell.commit;
    patches = @('libuv-f46e4246b5277fe1c5888b88b24d8b78020dd4f8', 'powershell-appcontainer-v1', 'powershell-source-archive-metadata-v1')
} | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding utf8
