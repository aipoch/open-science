<#
.SYNOPSIS
Runs the opt-in Windows Electron certification for Notebook mutation process lifecycle.

.DESCRIPTION
Run `npm run build:e2e` first. This script compiles the controlled native fixture into .scratch,
sets its overrides only for this process, and invokes the repository-local Playwright CLI.
#>
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'The controlled notebook lifecycle fixture is Windows-only.'
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$artifactRoot = Join-Path $repoRoot '.scratch\notebook-lifecycle-e2e'
$fixtureBin = Join-Path $artifactRoot 'bin\micromamba.exe'
$rustc = if ($env:RUSTC) { $env:RUSTC } else { Join-Path $env:USERPROFILE '.cargo\bin\rustc.exe' }
$node = (Get-Command node -ErrorAction Stop).Source
$playwrightCli = Join-Path $repoRoot 'node_modules\@playwright\test\cli.js'
$previousMicromamba = $env:OPEN_SCIENCE_MICROMAMBA_BIN
$previousEvents = $env:OPEN_SCIENCE_E2E_MICROMAMBA_EVENTS

New-Item -ItemType Directory -Force (Split-Path $fixtureBin) | Out-Null
& $rustc (Join-Path $PSScriptRoot 'fake-micromamba.rs') -O -o $fixtureBin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location $repoRoot
try {
  $env:OPEN_SCIENCE_MICROMAMBA_BIN = $fixtureBin
  $env:OPEN_SCIENCE_E2E_MICROMAMBA_EVENTS = 'enabled'
  & $node $playwrightCli test e2e/certification/notebook-lifecycle.spec.ts --grep mutation --workers=1
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($null -eq $previousMicromamba) {
    Remove-Item Env:OPEN_SCIENCE_MICROMAMBA_BIN -ErrorAction SilentlyContinue
  } else {
    $env:OPEN_SCIENCE_MICROMAMBA_BIN = $previousMicromamba
  }
  if ($null -eq $previousEvents) {
    Remove-Item Env:OPEN_SCIENCE_E2E_MICROMAMBA_EVENTS -ErrorAction SilentlyContinue
  } else {
    $env:OPEN_SCIENCE_E2E_MICROMAMBA_EVENTS = $previousEvents
  }
  Pop-Location
}

Write-Host "Transcript screenshots: $artifactRoot\evidence"
