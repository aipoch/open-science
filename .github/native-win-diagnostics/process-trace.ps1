param(
  [Parameter(Mandatory)][ValidateSet('start','stop')][string]$Mode,
  [Parameter(Mandatory)][string]$Session,
  [Parameter(Mandatory)][string]$Prefix
)
$ErrorActionPreference = 'Stop'
$etl = "$Prefix.etl"
$provider = 'Microsoft-Windows-Kernel-Process'
[DateTime]::UtcNow.ToString('o')
if ($Mode -eq 'start') {
  & logman start $Session -p $provider 0x10 5 -o $etl -ets
  exit $LASTEXITCODE
}
& logman stop $Session -ets
if ($LASTEXITCODE) { exit $LASTEXITCODE }
# Export process lifecycle fields only. Do not include unrelated command lines from the ETL.
$events = Get-WinEvent -Path $etl -Oldest
$keep = @('ProcessID','ParentProcessID','CreateTime','ExitTime','ProcessExitTime','ExitCode','ExitStatus',
          'ImageName','ImageFileName','ProcessSequenceNumber','ParentProcessSequenceNumber')
$count = 0
$events | Where-Object { $_.ProviderName -eq $provider -and $_.Id -in 1,2 } | ForEach-Object {
  $event = $_
  $data = [ordered]@{ id = $event.Id; time = $event.TimeCreated.ToUniversalTime().ToString('o') }
  foreach ($field in ([xml]$event.ToXml()).Event.EventData.Data) {
    if ($keep -contains $field.Name) { $data[$field.Name] = $field.'#text' }
  }
  $count++
  ConvertTo-Json -InputObject $data -Compress
} | Set-Content -Encoding utf8 "$Prefix-process.jsonl"
Remove-Item $etl
"Events exported: $count"
if (!$count) { exit 2 }
