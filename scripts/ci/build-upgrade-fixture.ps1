param(
  [Parameter(Mandatory)][string]$Source,
  [Parameter(Mandatory)][version]$Version,
  [Parameter(Mandatory)][string]$Destination,
  [Parameter(Mandatory)][string]$Thumbprint,
  [switch]$ReuseDependencies
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$env:NODE_OPTIONS = '--max-old-space-size=8192'
# Test signatures have no external timestamp or signing-service dependency.
$env:ELECTRON_BUILDER_OFFLINE = 'true'
Push-Location -LiteralPath $Source
try {
  if (!$ReuseDependencies) {
    node scripts/ci/npm-ci.mjs
    node scripts/fetch-micromamba.mjs win-64 resources/bin/win/x64/micromamba.exe
    node scripts/fetch-micromamba.mjs win-64 resources/bin/win/x64/micromamba-compat.exe compatibility
    node packages/notebook-network-sandbox/vendor/windows/build.mjs x64
  }
  npm version --no-git-tag-version --allow-same-version --ignore-scripts $Version
  npm run build:e2e
  $config = Join-Path $env:RUNNER_TEMP 'upgrade-builder.json'
  @{
    extends = (Resolve-Path electron-builder.yml).Path
    extraMetadata = @{ version = $Version.ToString() }
    win = @{
      forceCodeSigning = $true
      signtoolOptions = @{
        certificateSha1 = $Thumbprint
        signingHashAlgorithms = @('sha256')
        publisherName = @('CN=Open Science CI')
      }
    }
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $config
  npx --no-install electron-builder --win --x64 --publish never --config $config
  $name = "aipoch-open-science-$Version-win-x64-setup.exe"
  $signature = Get-AuthenticodeSignature -LiteralPath "dist/$name"
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $Thumbprint) {
    throw "Unexpected test signature for $name"
  }
  New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
  foreach ($asset in $name, "$name.blockmap", 'latest.yml') {
    Copy-Item -LiteralPath "dist/$asset" -Destination $Destination
  }
} finally {
  Pop-Location
}
