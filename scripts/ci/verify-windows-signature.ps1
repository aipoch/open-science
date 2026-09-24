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

function Test-PortableExecutable([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    if ($stream.Length -lt 64) { return $false }
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5a4d) { return $false }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadUInt32()
    if ($peOffset -gt $stream.Length - 4) { return $false }
    $stream.Position = $peOffset
    return $reader.ReadUInt32() -eq 0x4550
  } finally {
    $stream.Dispose()
  }
}

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
  # The Store requires every installed PE, including DLLs and native .node addons, to be signed.
  $files += @(Get-ChildItem -LiteralPath $unpacked -File -Recurse |
      Where-Object { Test-PortableExecutable $_.FullName } |
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
  if ($file.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase) -and
      $publisher -ne $env:AZURE_SIGNING_PUBLISHER) {
    throw "Unexpected Authenticode publisher for ${file}: $publisher"
  }
  if ($publisher -eq $env:AZURE_SIGNING_PUBLISHER -and
      $null -eq $signature.TimeStamperCertificate) {
    throw "Missing Authenticode timestamp for $file"
  }
  Write-Host "Verified Authenticode signature and timestamp: $file"
}
