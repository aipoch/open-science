param(
  [Parameter(Mandatory = $true)][string]$InstallPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][int]$MaxLineLength
)

$ErrorActionPreference = 'Stop'

function Get-AbsolutePath([string]$Path) {
  if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)' -or $Path -match '[\x00-\x1f]') {
    throw 'The configured storage location must be an absolute path without control characters.'
  }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.Length -gt [IO.Path]::GetPathRoot($full).Length) { $full = $full.TrimEnd('\') }
  return $full
}

try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-install-publication.dll')
  # Match the packaged bootstrap resolver. A development-only STORAGE_ROOT does not participate.
  $configRoot = [string]$env:OPEN_SCIENCE_E2E_STORAGE_ROOT
  if (-not $configRoot.Trim()) { $configRoot = [string]$env:OPEN_SCIENCE_CONFIG_ROOT }
  if (-not $configRoot.Trim()) { $configRoot = Join-Path $env:USERPROFILE '.open-science' }
  $configRoot = Get-AbsolutePath $configRoot.Trim()
  $dataRoot = ''
  $settingsPath = Join-Path $configRoot 'settings.json'
  if (Test-Path -LiteralPath $settingsPath) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $settings.dataRoot) {
      if ($settings.dataRoot -isnot [string]) { throw 'The saved data location is not a path.' }
      if ($settings.dataRoot.Trim()) { $dataRoot = Get-AbsolutePath $settings.dataRoot }
    }
  }
  $install = Get-AbsolutePath $InstallPath
  # .NET expands existing 8.3 ancestors, while NSIS traversal can retain that spelling.
  # Match normalized locations, then emit descendants under the caller's exact root prefix.
  $traversalRoot = $InstallPath.TrimEnd('\')
  $prefix = $install.TrimEnd('\') + '\'
  $physicalInstall = [InstallDirectory]::CanonicalPath($install).TrimEnd('\')
  $physicalPrefix = $physicalInstall + '\'
  # The installation root itself already uses an allowlist. Protect any configured descendants,
  # including roots inside resources/locales, without retaining unrelated ancestors' program files.
  $paths = @($configRoot, $dataRoot) | ForEach-Object {
    $root = $_
    if ($root.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      $traversalRoot + $root.Substring($install.Length)
    } else { '' }
    # Preserve both the saved access path and its physical target. A junction/short-path alias
    # outside the installation can still address research inside the program tree.
    if ($root) {
      if ([IO.File]::Exists($root)) { throw 'The configured storage location is not a directory.' }
      $physical = [InstallDirectory]::CanonicalPath($root)
      if ($physical.StartsWith($physicalPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $traversalRoot + $physical.Substring($physicalInstall.Length)
      } else { '' }
    } else { '' }
  }
  if (@($paths | Where-Object { $_.Length + 2 -ge $MaxLineLength }).Count) {
    throw 'A configured storage location exceeds the installer path buffer.'
  }
  [IO.File]::WriteAllText($OutputPath, ($paths -join "`r`n") + "`r`n", [Text.UnicodeEncoding]::new($false, $false))
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
