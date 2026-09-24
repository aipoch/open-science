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
  $unpacked = Join-Path $InstallerDir 'win-unpacked/open-science.exe'
  if (-not (Test-Path -LiteralPath $unpacked -PathType Leaf)) {
    throw "Missing packaged Windows executable: $unpacked"
  }
  $files += $unpacked
}

foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid') {
    throw "Invalid Authenticode signature for $file`: $($signature.Status) $($signature.StatusMessage)"
  }
  $publisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if ($publisher -ne $env:AZURE_SIGNING_PUBLISHER) {
    throw "Unexpected Authenticode publisher for $file`: $publisher"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Missing Authenticode timestamp for $file"
  }
  Write-Host "Verified Authenticode signature and timestamp: $file"
}
