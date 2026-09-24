param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerDir,
  [switch]$CheckUnpacked
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:AZURE_SIGNING_PUBLISHER)) {
  throw 'Missing AZURE_SIGNING_PUBLISHER environment variable.'
}
$installers = @(Get-ChildItem -LiteralPath $InstallerDir -File -Filter '*-win-x64-setup.exe')
if ($installers.Count -ne 1) {
  throw "Expected exactly one Windows x64 installer in $InstallerDir; found $($installers.Count)."
}

$files = @($installers[0].FullName)
if ($CheckUnpacked) {
  $unpacked = Join-Path $InstallerDir 'win-unpacked'
  foreach ($relativePath in @(
    'open-science.exe',
    'resources/micromamba.exe',
    'resources/micromamba-compat.exe',
    'resources/notebook-network-sandbox/windows/x64/notebook-appcontainer-host.exe'
  )) {
    $expected = Join-Path $unpacked $relativePath
    if (-not (Test-Path -LiteralPath $expected -PathType Leaf)) {
      throw "Missing packaged Windows executable: $expected"
    }
  }
  $files += @(Get-ChildItem -LiteralPath $unpacked -File -Filter '*.exe' -Recurse |
      Select-Object -ExpandProperty FullName)
}

foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid') {
    throw "Invalid Authenticode signature for ${file}: $($signature.Status) $($signature.StatusMessage)"
  }
  $publisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if ($publisher -ne $env:AZURE_SIGNING_PUBLISHER) {
    throw "Unexpected Authenticode publisher for ${file}: $publisher"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Missing Authenticode timestamp for $file"
  }
  Write-Host "Verified Authenticode signature and timestamp: $file"
}
