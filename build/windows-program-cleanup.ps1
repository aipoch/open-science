param([Parameter(Mandatory = $true)][string]$StagingPath)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-install-publication.dll')
  [InstallDirectory]::RemoveStagedProgramFiles($StagingPath)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 2
}
