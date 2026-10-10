param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:AZURE_SIGNING_PUBLISHER)) {
  throw 'AZURE_SIGNING_PUBLISHER is required.'
}
$names = @('credential_identity_probe.exe', 'credential_key_validator.exe', 'credential_secret.exe',
  'process_tree_native.node', 'safe_file_publisher_native.node')
foreach ($name in $names) {
  $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $Directory $name)
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) {
    throw "Invalid or untimestamped native signature: $name"
  }
  $publisher = $signature.SignerCertificate.GetNameInfo(
    [Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ne $env:AZURE_SIGNING_PUBLISHER) { throw "Unexpected native publisher: $name" }
}
