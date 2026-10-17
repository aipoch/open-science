param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$count = 0
Get-ChildItem -LiteralPath $Directory -Recurse -File | ForEach-Object {
  $stream = [System.IO.File]::OpenRead($_.FullName)
  try {
    if ($stream.Length -lt 64) { return }
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5a4d) { return }
    $stream.Position = 0x3c
    $offset = $reader.ReadUInt32()
    if ($offset -gt $stream.Length - 4) { return }
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x4550) { return }
  } finally { $stream.Dispose() }
  $signature = Get-AuthenticodeSignature -LiteralPath $_.FullName
  if ($signature.Status -ne 'Valid') { throw "Invalid native signature: $($_.FullName) ($($signature.Status))" }
  # Preserve valid vendor signatures; the parent installer has its publisher checked by package-smoke.
  if ($null -eq $signature.TimeStamperCertificate) { throw "Missing native timestamp: $($_.FullName)" }
  $count++
}
if ($count -eq 0) { throw 'No PE payloads found' }
Write-Host "Verified $count signed native payloads"
