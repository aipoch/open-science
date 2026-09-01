<# Run from an elevated PowerShell session on an ephemeral Windows test host. #>
param(
  [Parameter(Mandatory = $true)]
  [string]$Exe,
  [ValidateSet('Basic', 'Full')]
  [string]$Mode = 'Basic'
)

$ErrorActionPreference = 'Stop'
$hostExe = (Resolve-Path $Exe).Path
$installationId = '0123456789abcdef01234567'
$secondInstallationId = '89abcdef0123456789abcdef'

$ownershipRoot = Join-Path $env:LOCALAPPDATA "Aipoch\OpenScience\notebook-sandbox\$installationId"
$secondOwnershipRoot = Join-Path $env:LOCALAPPDATA "Aipoch\OpenScience\notebook-sandbox\$secondInstallationId"
$receipt = Join-Path $ownershipRoot 'receipt.json'
$journal = Join-Path $ownershipRoot 'creating.json'
$leaseRoot = Join-Path $ownershipRoot 'acl-leases'
$receiptBackup = Join-Path $env:TEMP 'notebook-appcontainer-receipt.backup.json'
$originalLocalAppData = $env:LOCALAPPDATA
$simulatedElevatedLocalAppData = Join-Path $env:TEMP "notebook-sandbox-other-admin-$PID"
$filesystemRoot = $null
$outsideListener = $null
$gatewayListener = $null
$outsideListenerV6 = $null
$gatewayListenerV6 = $null
$outsideUdpListener = $null
$gatewayUdpListener = $null
$gatewayPort = $null
$networkPortsAvailable = $true
$concurrentLaunches = @()

function Invoke-SandboxHost {
  param([string]$Command, [string]$Identity, [string]$Root)
  & $script:hostExe $Command $Identity $Root
  if ($LASTEXITCODE -ne 0) { throw "AppContainer $Command exited $LASTEXITCODE" }
}

function Complete-SandboxLaunch {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,
    [int]$TimeoutMs = 15000
  )
  if (-not $Process.WaitForExit($TimeoutMs)) {
    $Process.Refresh()
    return $Process.ExitCode
  }
  $Process.Refresh()
  if ($null -ne $Process.ExitCode) { return $Process.ExitCode }
  # Start-Process -PassThru can leave ExitCode unpopulated after HasExited when stdout is redirected.
  $deadline = (Get-Date).AddSeconds(2)
  do {
    Start-Sleep -Milliseconds 50
    $Process.Refresh()
  } while ($null -eq $Process.ExitCode -and (Get-Date) -le $deadline)
  return $Process.ExitCode
}

function Test-SandboxLaunchSucceeded {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)]
    [string]$CompletePath
  )
  $code = Complete-SandboxLaunch $Process
  $complete = Test-Path -LiteralPath $CompletePath
  if (-not $Process.HasExited -or -not $complete) { return $false }
  if ($null -eq $code) { return $true }
  return $code -eq 0
}

function Install-SandboxResources {
  param([string]$Identity, [string]$Root)
  Invoke-SandboxHost 'prepare-setup' $Identity $Root
  Invoke-SandboxHost 'setup' $Identity $Root
  Invoke-SandboxHost 'finish-setup' $Identity $Root
}

function Remove-SandboxResources {
  param([string]$Identity, [string]$Root)
  Invoke-SandboxHost 'prepare-remove' $Identity $Root
  Invoke-SandboxHost 'remove' $Identity $Root
  Invoke-SandboxHost 'finish-remove' $Identity $Root
}

function Test-LoopbackPortAvailable {
  param([int]$Port)
  $listener = $null
  try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    Write-Warning "Loopback port $Port is unavailable before AppContainer setup: $($_.Exception.Message)"
    return $false
  } finally {
    if ($null -ne $listener) { $listener.Stop() }
  }
}

try {
  Write-Host '[windows-smoke] setup and idempotency'
  # Ownership is passed by the desktop user and must not follow an elevated account's environment.
  New-Item -ItemType Directory -Path $simulatedElevatedLocalAppData -Force | Out-Null
  $env:LOCALAPPDATA = $simulatedElevatedLocalAppData
  Install-SandboxResources $installationId $ownershipRoot

  # Setup is repair-safe and idempotent.
  Install-SandboxResources $installationId $ownershipRoot

  $status = (& $hostExe status $installationId $ownershipRoot | ConvertFrom-Json)
  if (-not $status.profileExists -or -not $status.loopbackAllowed -or -not $status.networkFenceReady -or -not $status.owned -or $status.ownershipState -ne 'owned' -or $status.gatewayPort -lt 1) {
    throw 'Notebook AppContainer setup did not produce owned ready resources.'
  }
  $gatewayPort = [int]$status.gatewayPort
  $ownedReceipt = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if ($ownedReceipt.schemaVersion -ne 4 -or [string]::IsNullOrWhiteSpace($ownedReceipt.wfpSublayerKey) -or $ownedReceipt.wfpFilterKeys.Count -ne 3) {
    throw 'Notebook AppContainer receipt does not identify the owned WFP fence.'
  }
  $networkPortsAvailable = Test-LoopbackPortAvailable $gatewayPort
  if (-not $networkPortsAvailable) {
    & netsh.exe interface ipv4 show excludedportrange protocol=tcp
    Get-NetTCPConnection -LocalPort $gatewayPort -ErrorAction SilentlyContinue | Format-Table -AutoSize
    Write-Warning "NETWORK_BOUNDARY_UNVERIFIED: the host cannot bind configured loopback port $gatewayPort."
  }

  Write-Host '[windows-smoke] removal cancellation checkpoint'
  # This is the durable state when removal UAC is cancelled: processes and transient leases may be
  # stopped, but the profile and every owned setup resource must remain installed and retryable.
  Invoke-SandboxHost 'prepare-remove' $installationId $ownershipRoot
  $cancelledRemovalStatus = (& $hostExe status $installationId $ownershipRoot | ConvertFrom-Json)
  if (-not $cancelledRemovalStatus.profileExists -or -not $cancelledRemovalStatus.loopbackAllowed -or -not $cancelledRemovalStatus.networkFenceReady -or -not $cancelledRemovalStatus.owned) {
    throw 'Preparing removal changed durable resources before UAC approval.'
  }

  Write-Host '[windows-smoke] filesystem boundary'
  # Exercise the real command ACL boundary, not only receipt bookkeeping.
  $filesystemRoot = Join-Path $env:TEMP "notebook-sandbox-files-$PID"
  $readOnlyRoot = Join-Path $filesystemRoot 'read-only'
  $readWriteRoot = Join-Path $filesystemRoot 'read-write'
  $deniedRoot = Join-Path $filesystemRoot 'denied'
  New-Item -ItemType Directory -Path $readOnlyRoot, $readWriteRoot, $deniedRoot -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $readOnlyRoot 'input.txt') -Value 'readable'
  Set-Content -LiteralPath (Join-Path $deniedRoot 'secret.txt') -Value 'secret'
  $readOnlyFile = Join-Path $readOnlyRoot 'input.txt'
  $readWriteFile = Join-Path $readWriteRoot 'output.txt'
  $deniedFile = Join-Path $deniedRoot 'secret.txt'
  $systemFile = Join-Path $env:WINDIR 'System32\kernel32.dll'
  $probeExe = Join-Path $readWriteRoot 'filesystem-probe.exe'
  Copy-Item -LiteralPath $hostExe -Destination $probeExe

  $overlapSpec = @{
    executable = $probeExe
    arguments = @('probe-filesystem', $systemFile, $readOnlyFile, $readWriteFile, $deniedFile)
    cwd = $readWriteRoot
    readOnlyRoots = @($filesystemRoot, (Join-Path $env:WINDIR 'System32'))
    readWriteRoots = @($readWriteRoot)
    deniedReadRoots = @($deniedRoot)
    deniedWriteRoots = @()
  } | ConvertTo-Json -Compress
  $overlapBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($overlapSpec))
  $overlapBase64Url = $overlapBase64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
  & $hostExe launch $installationId $ownershipRoot $overlapBase64Url
  if ($LASTEXITCODE -eq 0) {
    throw 'AppContainer accepted a denied read root nested in an allowed root.'
  }

  $aclSpec = @{
    executable = $probeExe
    arguments = @('probe-filesystem', $systemFile, $readOnlyFile, $readWriteFile, $deniedFile)
    cwd = $readWriteRoot
    readOnlyRoots = @($readOnlyRoot, (Join-Path $env:WINDIR 'System32'))
    readWriteRoots = @($readWriteRoot)
    deniedReadRoots = @($deniedRoot)
    deniedWriteRoots = @()
  } | ConvertTo-Json -Compress
  $aclBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($aclSpec))
  $aclBase64Url = $aclBase64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
  & $hostExe launch $installationId $ownershipRoot $aclBase64Url
  if ($LASTEXITCODE -ne 0 -or (Get-Content -LiteralPath (Join-Path $readWriteRoot 'output.txt')) -ne 'allowed') {
    throw "AppContainer filesystem enforcement exited $LASTEXITCODE"
  }
  if ((Get-Content -LiteralPath (Join-Path $readOnlyRoot 'input.txt')) -ne 'readable') {
    throw 'AppContainer modified a read-only input.'
  }

  # A writable workspace must remain usable while selected metadata descendants stay read-only.
  $workspaceRoot = Join-Path $filesystemRoot 'workspace'
  $workspaceSource = Join-Path $workspaceRoot 'src'
  $workspaceGit = Join-Path $workspaceRoot '.git'
  $workspaceHooks = Join-Path $workspaceGit 'hooks'
  $workspaceFile = Join-Path $workspaceSource 'input.txt'
  $workspaceConfig = Join-Path $workspaceGit 'config'
  $workspaceHook = Join-Path $workspaceHooks 'existing-hook'
  New-Item -ItemType Directory -Path $workspaceSource, $workspaceHooks -Force | Out-Null
  Set-Content -LiteralPath $workspaceFile -Value 'original' -NoNewline
  Set-Content -LiteralPath $workspaceConfig -Value '[core]' -NoNewline
  Set-Content -LiteralPath $workspaceHook -Value 'protected' -NoNewline
  $workspaceAclBefore = (Get-Acl -LiteralPath $workspaceRoot).Sddl
  $workspaceGitAclBefore = (Get-Acl -LiteralPath $workspaceGit).Sddl

  $protectedWorkspaceSpec = @{
    executable = $probeExe
    arguments = @('probe-protected-workspace', $workspaceRoot, $workspaceFile, $workspaceConfig, $workspaceHooks)
    cwd = $workspaceRoot
    readOnlyRoots = @($readWriteRoot, (Join-Path $env:WINDIR 'System32'))
    readWriteRoots = @($workspaceRoot)
    deniedReadRoots = @()
    deniedWriteRoots = @($workspaceGit)
  } | ConvertTo-Json -Compress
  $protectedWorkspaceBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($protectedWorkspaceSpec))
  $protectedWorkspaceBase64Url = $protectedWorkspaceBase64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
  & $hostExe launch $installationId $ownershipRoot $protectedWorkspaceBase64Url
  if ($LASTEXITCODE -ne 0) {
    throw "AppContainer protected workspace enforcement exited $LASTEXITCODE"
  }
  if ((Get-Content -LiteralPath $workspaceFile -Raw) -ne 'updated') {
    throw 'AppContainer did not modify an ordinary workspace file.'
  }
  if ((Get-Content -LiteralPath (Join-Path $workspaceRoot 'created-by-sandbox.txt') -Raw) -ne 'created') {
    throw 'AppContainer did not create and reopen a workspace file.'
  }
  if ((Get-Content -LiteralPath (Join-Path $workspaceRoot 'created-directory\nested.txt') -Raw) -ne 'nested') {
    throw 'AppContainer did not create and reopen a nested workspace file.'
  }
  if ((Get-Content -LiteralPath $workspaceConfig -Raw) -ne '[core]') {
    throw 'AppContainer modified protected workspace configuration.'
  }
  if ((Get-Content -LiteralPath $workspaceHook -Raw) -ne 'protected' -or (Test-Path -LiteralPath (Join-Path $workspaceHooks 'created-hook'))) {
    throw 'AppContainer modified protected workspace hooks.'
  }
  $workspaceAclAfter = (Get-Acl -LiteralPath $workspaceRoot).Sddl
  $workspaceGitAclAfter = (Get-Acl -LiteralPath $workspaceGit).Sddl
  if ($workspaceAclAfter -ne $workspaceAclBefore -or $workspaceGitAclAfter -ne $workspaceGitAclBefore) {
    throw "AppContainer did not restore the original workspace ACLs.`nworkspace before: $workspaceAclBefore`nworkspace after: $workspaceAclAfter`n.git before: $workspaceGitAclBefore`n.git after: $workspaceGitAclAfter"
  }

  Write-Host '[windows-smoke] concurrent filesystem leases'
  $concurrentRoot = Join-Path $filesystemRoot 'concurrent'
  New-Item -ItemType Directory -Path $concurrentRoot -Force | Out-Null
  $concurrentAclBefore = (Get-Acl -LiteralPath $concurrentRoot).Sddl
  $aReady = Join-Path $concurrentRoot 'a-ready'
  $aRelease = Join-Path $concurrentRoot 'a-release'
  $aComplete = Join-Path $concurrentRoot 'a-complete'
  $bReady = Join-Path $concurrentRoot 'b-ready'
  $bWrite = Join-Path $concurrentRoot 'b-write'
  $bAfterA = Join-Path $concurrentRoot 'b-after-a'
  $bRelease = Join-Path $concurrentRoot 'b-release'
  $bComplete = Join-Path $concurrentRoot 'b-complete'
  $aStdout = Join-Path $concurrentRoot 'a-stdout.log'
  $aStderr = Join-Path $concurrentRoot 'a-stderr.log'
  $bStdout = Join-Path $concurrentRoot 'b-stdout.log'
  $bStderr = Join-Path $concurrentRoot 'b-stderr.log'
  $powerShellExe = (Get-Command powershell.exe -CommandType Application).Source
  $aCommand = "[IO.File]::WriteAllText('$aReady', 'ready'); `$deadline = [DateTime]::UtcNow.AddSeconds(30); while (-not [IO.File]::Exists('$aRelease')) { if ([DateTime]::UtcNow -gt `$deadline) { exit 41 }; [Threading.Thread]::Sleep(100) }; [IO.File]::WriteAllText('$aComplete', 'complete'); exit 0"
  $bCommand = "[IO.File]::WriteAllText('$bReady', 'ready'); `$deadline = [DateTime]::UtcNow.AddSeconds(30); while (-not [IO.File]::Exists('$bWrite')) { if ([DateTime]::UtcNow -gt `$deadline) { exit 42 }; [Threading.Thread]::Sleep(100) }; [IO.File]::WriteAllText('$bAfterA', 'allowed'); while (-not [IO.File]::Exists('$bRelease')) { if ([DateTime]::UtcNow -gt `$deadline) { exit 43 }; [Threading.Thread]::Sleep(100) }; [IO.File]::WriteAllText('$bComplete', 'complete'); exit 0"
  $concurrentSpec = {
    param($command)
    $json = @{
      executable = $powerShellExe
      arguments = @('-NoProfile', '-NonInteractive', '-Command', $command)
      cwd = $concurrentRoot
      readOnlyRoots = @()
      readWriteRoots = @($concurrentRoot)
      deniedReadRoots = @()
      deniedWriteRoots = @()
    } | ConvertTo-Json -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $encoded.TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }
  $launchA = Start-Process -FilePath $hostExe -ArgumentList @('launch', $installationId, $ownershipRoot, (& $concurrentSpec $aCommand)) -RedirectStandardOutput $aStdout -RedirectStandardError $aStderr -PassThru
  $concurrentLaunches += $launchA
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $aReady)) {
    if ($launchA.HasExited) {
      $stdout = if (Test-Path -LiteralPath $aStdout) { Get-Content -LiteralPath $aStdout -Raw } else { '<missing>' }
      $stderr = if (Test-Path -LiteralPath $aStderr) { Get-Content -LiteralPath $aStderr -Raw } else { '<missing>' }
      throw "First concurrent lease exited $($launchA.ExitCode) before becoming ready.`nstdout: $stdout`nstderr: $stderr"
    }
    if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for the first concurrent lease.' }
    Start-Sleep -Milliseconds 100
  }
  $launchB = Start-Process -FilePath $hostExe -ArgumentList @('launch', $installationId, $ownershipRoot, (& $concurrentSpec $bCommand)) -RedirectStandardOutput $bStdout -RedirectStandardError $bStderr -PassThru
  $concurrentLaunches += $launchB
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $bReady)) {
    if ($launchB.HasExited) {
      $stdout = if (Test-Path -LiteralPath $bStdout) { Get-Content -LiteralPath $bStdout -Raw } else { '<missing>' }
      $stderr = if (Test-Path -LiteralPath $bStderr) { Get-Content -LiteralPath $bStderr -Raw } else { '<missing>' }
      throw "Second concurrent lease exited $($launchB.ExitCode) before becoming ready.`nstdout: $stdout`nstderr: $stderr"
    }
    if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for the second concurrent lease.' }
    Start-Sleep -Milliseconds 100
  }
  Set-Content -LiteralPath $aRelease -Value release -NoNewline
  $deadline = (Get-Date).AddSeconds(15)
  while (-not $launchA.HasExited -and (Get-Date) -le $deadline) {
    Start-Sleep -Milliseconds 100
  }
  $aError = if (Test-Path -LiteralPath $aStderr) { Get-Content -LiteralPath $aStderr -Raw } else { '<missing>' }
  if (-not (Test-SandboxLaunchSucceeded -Process $launchA -CompletePath $aComplete)) {
    $stdout = if (Test-Path -LiteralPath $aStdout) { Get-Content -LiteralPath $aStdout -Raw } else { '<missing>' }
    throw "The first concurrent lease did not complete cleanly (exited: $($launchA.HasExited), exit code: $($launchA.ExitCode), complete: $(Test-Path -LiteralPath $aComplete)).`nstdout: $stdout`nstderr: $aError"
  }
  Set-Content -LiteralPath $bWrite -Value write -NoNewline
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $bAfterA)) {
    if ($launchB.HasExited) { throw "The surviving concurrent lease exited $($launchB.ExitCode) before writing." }
    if ((Get-Date) -gt $deadline) { throw 'The surviving concurrent lease lost filesystem access.' }
    Start-Sleep -Milliseconds 100
  }
  Set-Content -LiteralPath $bRelease -Value release -NoNewline
  $deadline = (Get-Date).AddSeconds(15)
  while (-not $launchB.HasExited -and (Get-Date) -le $deadline) {
    Start-Sleep -Milliseconds 100
  }
  $bError = if (Test-Path -LiteralPath $bStderr) { Get-Content -LiteralPath $bStderr -Raw } else { '<missing>' }
  if (-not (Test-SandboxLaunchSucceeded -Process $launchB -CompletePath $bComplete)) {
    $stdout = if (Test-Path -LiteralPath $bStdout) { Get-Content -LiteralPath $bStdout -Raw } else { '<missing>' }
    throw "The second concurrent lease did not complete cleanly (exited: $($launchB.HasExited), exit code: $($launchB.ExitCode), complete: $(Test-Path -LiteralPath $bComplete)).`nstdout: $stdout`nstderr: $bError"
  }
  $concurrentAclAfter = (Get-Acl -LiteralPath $concurrentRoot).Sddl
  if ($concurrentAclAfter -ne $concurrentAclBefore) {
    throw "Concurrent leases did not restore the original ACL.`nbefore: $concurrentAclBefore`nafter: $concurrentAclAfter"
  }

  Write-Host '[windows-smoke] WFP loopback network boundary'
  if ($networkPortsAvailable) {
    # The profile may reach only TCP on the single authenticated IPv4 gateway port.
    $outsideListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $outsideListener.Start()
    $outsidePort = $outsideListener.LocalEndpoint.Port
    $gatewayListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $gatewayPort)
    $gatewayListener.Start()
    $outsideListenerV6 = [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Loopback, 0)
    $outsideListenerV6.Start()
    $outsidePortV6 = $outsideListenerV6.LocalEndpoint.Port
    $gatewayListenerV6 = [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Loopback, $gatewayPort)
    $gatewayListenerV6.Start()
    $connectSpec = {
      param($hostName, $port)
      $command = "try { `$client = [Net.Sockets.TcpClient]::new(); `$connect = `$client.ConnectAsync('$hostName', $port); if (-not `$connect.Wait(5000)) { `$client.Dispose(); exit 34 }; `$connect.GetAwaiter().GetResult(); `$client.Dispose(); exit 0 } catch { exit 33 }"
      $json = @{
        executable = 'powershell.exe'
        arguments = @('-NoProfile', '-NonInteractive', '-Command', $command)
        cwd = $env:TEMP
        readOnlyRoots = @()
        readWriteRoots = @()
        deniedReadRoots = @()
        deniedWriteRoots = @()
      } | ConvertTo-Json -Compress
      $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
      $encoded.TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    & $hostExe launch $installationId $ownershipRoot (& $connectSpec '127.0.0.1' $outsidePort)
    if ($LASTEXITCODE -eq 0) { throw 'AppContainer bypassed the loopback gateway fence.' }
    & $hostExe launch $installationId $ownershipRoot (& $connectSpec '127.0.0.1' $gatewayPort)
    if ($LASTEXITCODE -ne 0) { throw 'AppContainer could not reach the authenticated gateway port.' }
    & $hostExe launch $installationId $ownershipRoot (& $connectSpec '::1' $outsidePortV6)
    if ($LASTEXITCODE -eq 0) { throw 'AppContainer bypassed the IPv6 loopback gateway fence.' }
    & $hostExe launch $installationId $ownershipRoot (& $connectSpec '::1' $gatewayPort)
    if ($LASTEXITCODE -eq 0) { throw 'AppContainer used the IPv4 gateway exception for IPv6.' }

    # The gateway exception is TCP-only. A datagram sent to either an unrelated port or the gateway
    # port must never reach a host listener.
    $outsideUdpListener = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
    $outsideUdpPort = $outsideUdpListener.Client.LocalEndPoint.Port
    $gatewayUdpListener = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, $gatewayPort))
    $udpSpec = {
      param($port)
      $command = "try { `$client = [Net.Sockets.UdpClient]::new(); `$bytes = [Text.Encoding]::UTF8.GetBytes('probe'); [void]`$client.Send(`$bytes, `$bytes.Length, '127.0.0.1', $port); `$client.Dispose(); exit 0 } catch { exit 33 }"
      $json = @{
        executable = 'powershell.exe'
        arguments = @('-NoProfile', '-NonInteractive', '-Command', $command)
        cwd = $env:TEMP
        readOnlyRoots = @()
        readWriteRoots = @()
        deniedReadRoots = @()
        deniedWriteRoots = @()
      } | ConvertTo-Json -Compress
      $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
      $encoded.TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    $outsideUdpReceive = $outsideUdpListener.ReceiveAsync()
    & $hostExe launch $installationId $ownershipRoot (& $udpSpec $outsideUdpPort)
    if ($outsideUdpReceive.Wait(2000)) { throw 'AppContainer sent UDP to an unrelated loopback port.' }
    $gatewayUdpReceive = $gatewayUdpListener.ReceiveAsync()
    & $hostExe launch $installationId $ownershipRoot (& $udpSpec $gatewayPort)
    if ($gatewayUdpReceive.Wait(2000)) { throw 'AppContainer used the TCP gateway exception for UDP.' }
    $outsideListener.Stop()
    $gatewayListener.Stop()
    $outsideListenerV6.Stop()
    $gatewayListenerV6.Stop()
    $outsideUdpListener.Dispose()
    $gatewayUdpListener.Dispose()
  } else {
    Write-Warning 'NETWORK_BOUNDARY_UNVERIFIED: skipped AppContainer loopback probes after failed preflight.'
  }

  Write-Host '[windows-smoke] process-tree removal and idempotency'
  $spec = @{
    executable = 'powershell.exe'
    arguments = @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60')
    cwd = $env:TEMP
    readOnlyRoots = @()
    readWriteRoots = @($env:TEMP)
    deniedReadRoots = @()
    deniedWriteRoots = @()
  } | ConvertTo-Json -Compress
  $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($spec))
  $base64Url = $base64.TrimEnd('=').Replace('+', '-').Replace('/', '_')

  $launch = Start-Process -FilePath $hostExe -ArgumentList @('launch', $installationId, $ownershipRoot, $base64Url) -PassThru
  Start-Sleep -Seconds 2
  Remove-SandboxResources $installationId $ownershipRoot
  if ($LASTEXITCODE -ne 0) {
    throw "AppContainer remove exited $LASTEXITCODE"
  }
  if (-not $launch.WaitForExit(15000)) {
    throw 'AppContainer remove did not stop the running sandbox process.'
  }

  Remove-SandboxResources $installationId $ownershipRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Repeated AppContainer remove exited $LASTEXITCODE"
  }

  if ($Mode -eq 'Full') {
    Write-Host '[windows-smoke] installation isolation'
    # Two installations own distinct profiles and receipts. Removing one must preserve the other.
    Install-SandboxResources $installationId $ownershipRoot
    Install-SandboxResources $secondInstallationId $secondOwnershipRoot
    Remove-SandboxResources $installationId $ownershipRoot
    $secondStatus = (& $hostExe status $secondInstallationId $secondOwnershipRoot | ConvertFrom-Json)
    if (-not $secondStatus.profileExists -or -not $secondStatus.loopbackAllowed -or -not $secondStatus.networkFenceReady -or -not $secondStatus.owned) {
      throw 'Removing one installation changed another installation resource.'
    }
    Remove-SandboxResources $secondInstallationId $secondOwnershipRoot
    Install-SandboxResources $installationId $ownershipRoot

    Write-Host '[windows-smoke] crashed ACL lease recovery'
    # A killed host leaves an ACL receipt. The next setup must recover it before creating work.
    $crashedLaunch = Start-Process -FilePath $hostExe -ArgumentList @('launch', $installationId, $ownershipRoot, $base64Url) -PassThru
    $leaseDeadline = (Get-Date).AddSeconds(15)
    while ((-not (Test-Path -LiteralPath $leaseRoot)) -or -not (Get-ChildItem -LiteralPath $leaseRoot -Filter '*.json' -ErrorAction SilentlyContinue)) {
      if ((Get-Date) -gt $leaseDeadline) { throw 'Timed out waiting for an ACL lease receipt.' }
      Start-Sleep -Milliseconds 100
    }
    Stop-Process -Id $crashedLaunch.Id -Force
    $crashedLaunch.WaitForExit()
    $crashedLease = Get-ChildItem -LiteralPath $leaseRoot -Filter '*.json' | Select-Object -First 1
    $crashedLeaseBytes = [IO.File]::ReadAllBytes($crashedLease.FullName)
    $tamperedLease = [Text.Encoding]::UTF8.GetString($crashedLeaseBytes) | ConvertFrom-Json
    $tamperedLease.capabilityName = "$($tamperedLease.capabilityName).tampered"
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($crashedLease.FullName, ($tamperedLease | ConvertTo-Json -Depth 8), $utf8NoBom)
    & $hostExe prepare-setup $installationId $ownershipRoot
    if ($LASTEXITCODE -eq 0) {
      throw 'Setup accepted a tampered ACL lease receipt.'
    }
    if (-not (Test-Path -LiteralPath $crashedLease.FullName)) {
      throw 'Setup removed an ACL lease whose ownership could not be proven.'
    }
    [IO.File]::WriteAllBytes($crashedLease.FullName, $crashedLeaseBytes)
    Install-SandboxResources $installationId $ownershipRoot
    if (Get-ChildItem -LiteralPath $leaseRoot -Filter '*.json' -ErrorAction SilentlyContinue) {
      throw 'Setup did not recover a crashed command ACL lease.'
    }

    Write-Host '[windows-smoke] interrupted setup recovery'
    # A creation journal is a repair receipt. Setup completes it without adopting other resources.
    $creating = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    $creating.state = 'creating'
    $creating | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $journal -Encoding UTF8
    Remove-Item -LiteralPath $receipt -Force
    Install-SandboxResources $installationId $ownershipRoot
    $recovered = (& $hostExe status $installationId $ownershipRoot | ConvertFrom-Json)
    if (-not $recovered.owned -or $recovered.ownershipState -ne 'owned' -or (Test-Path -LiteralPath $journal)) {
      throw 'Setup did not recover an interrupted owned creation.'
    }

    Write-Host '[windows-smoke] unowned resource preservation'
    # A missing receipt means ownership cannot be proven. Removal must preserve the profile and its
    # loopback entry; restoring the exact receipt lets the test clean up safely afterward.
    Copy-Item -LiteralPath $receipt -Destination $receiptBackup -Force
    Remove-Item -LiteralPath $receipt -Force
    Write-Host '[windows-smoke] final owned cleanup'
    Remove-SandboxResources $installationId $ownershipRoot
    if ($LASTEXITCODE -ne 0) {
      throw "Unowned AppContainer preservation check exited $LASTEXITCODE"
    }
    Move-Item -LiteralPath $receiptBackup -Destination $receipt -Force
    $preserved = (& $hostExe status $installationId $ownershipRoot | ConvertFrom-Json)
    if (-not $preserved.profileExists -or -not $preserved.loopbackAllowed -or -not $preserved.networkFenceReady -or -not $preserved.owned) {
      throw 'Removal changed AppContainer resources whose ownership could not be proven.'
    }
    Remove-SandboxResources $installationId $ownershipRoot
    if ($LASTEXITCODE -ne 0) {
      throw "Final AppContainer remove exited $LASTEXITCODE"
    }
  }
} finally {
  $env:LOCALAPPDATA = $originalLocalAppData
  if (Test-Path -LiteralPath $receiptBackup) {
    Move-Item -LiteralPath $receiptBackup -Destination $receipt -Force
  }
  try { Remove-SandboxResources $installationId $ownershipRoot } catch { Write-Warning $_ }
  try { Remove-SandboxResources $secondInstallationId $secondOwnershipRoot } catch { Write-Warning $_ }
  if ($outsideListener) { $outsideListener.Stop() }
  if ($gatewayListener) { $gatewayListener.Stop() }
  if ($outsideListenerV6) { $outsideListenerV6.Stop() }
  if ($gatewayListenerV6) { $gatewayListenerV6.Stop() }
  if ($outsideUdpListener) { $outsideUdpListener.Dispose() }
  if ($gatewayUdpListener) { $gatewayUdpListener.Dispose() }
  foreach ($launch in $concurrentLaunches) {
    if ($null -ne $launch -and -not $launch.HasExited) {
      Stop-Process -Id $launch.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if ($filesystemRoot -and (Test-Path -LiteralPath $filesystemRoot)) {
    Remove-Item -LiteralPath $filesystemRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $simulatedElevatedLocalAppData) {
    Remove-Item -LiteralPath $simulatedElevatedLocalAppData -Recurse -Force
  }
}

Write-Host 'Windows Notebook AppContainer smoke test passed.'
