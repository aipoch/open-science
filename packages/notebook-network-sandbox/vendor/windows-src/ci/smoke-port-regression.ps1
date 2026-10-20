<# Run only on an elevated, ephemeral Windows test host. #>
param([Parameter(Mandatory = $true)][string]$Exe)
$ErrorActionPreference = 'Stop'
$reservation = @{ listener = $null; unavailable = $false }
$passes = 0
$attempts = 0
try {
  while ($passes -lt 2 -and $attempts -lt 256) {
    $attempts++
    $reservation.unavailable = $false
    try {
      & "$PSScriptRoot/smoke.ps1" -Exe $Exe -AfterSetup {
        param([int]$Port)
        $reservation.listener = [Net.Sockets.UdpClient]::new()
        $reservation.listener.ExclusiveAddressUse = $true
        try {
          $reservation.listener.Client.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Any, $Port))
        } catch {
          $reservation.unavailable = $true
          $reservation.listener.Dispose()
          $reservation.listener = $null
          throw
        }
        Write-Host "[regression] exclusively bound UDP port $Port; TCP gateway remains available"
      }
      $passes++
    } catch {
      $socketError = $_.Exception.GetBaseException()
      if ($reservation.unavailable -and $socketError -is [Net.Sockets.SocketException] -and $socketError.SocketErrorCode -in @('AccessDenied', 'AddressAlreadyInUse')) {
        Write-Host "[regression] UDP fixture port unavailable; recreate the test installation"
        continue
      }
      Write-Host "[regression] failure: $($_.Exception.ToString())"
      Write-Host $_.ScriptStackTrace
      & netsh.exe interface ipv4 show excludedportrange protocol=udp
      throw
    } finally {
      if ($reservation.listener) { $reservation.listener.Dispose(); $reservation.listener = $null }
    }
  }
  if ($passes -ne 2) { throw "Smoke test did not complete twice with a TCP-only gateway port after $attempts attempts" }
} finally {
  if ($reservation.listener) { $reservation.listener.Dispose() }
}
