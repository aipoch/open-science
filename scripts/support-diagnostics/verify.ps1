#requires -version 5.1
# Developer checks using isolated synthetic data; not included in the end-user ZIP.
param([string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
if (!$FixtureRoot) { $FixtureRoot = Join-Path $env:TEMP ('open-science-diagnostic-test-' + [Guid]::NewGuid().ToString('N')) }
$null = New-Item -ItemType Directory -Path $FixtureRoot -Force
$utf8 = New-Object Text.UTF8Encoding($true)
$canary = 'DO_NOT_EXPORT_SECRET_862cbf'
$sourceRoot = Join-Path $FixtureRoot ('sensitive-path-' + $canary)
$null = New-Item -ItemType Directory -Path $sourceRoot -Force
$log = Join-Path $sourceRoot 'main.log'
$sessionFile = Join-Path $sourceRoot 'session.json'
$output = Join-Path $FixtureRoot 'reports'
$null = New-Item -ItemType Directory -Path $output -Force
$stamp = '2026-09-13T03:07:30Z'
$records = @(
    @{t=$stamp;msg='app starting';data=@{version='0.28.0';password=$canary}},
    @{t=$stamp;msg='permission request received';data=@{tool='notebook_execute';toolCallId='private-call';sessionId='private-provider'}},
    @{t=$stamp;msg='acp:resume-session completed';data=@{contextReset=$true;sessionId='private-session';token=$canary}},
    @{t=$stamp;msg='bridge skill selection completed';data=@{catalogCount=316;routedCatalogCount=128;model=$canary}},
    @{t=$stamp;msg='tool call failed';data=@{toolCallId='private-call';sessionId='private-session'}},
    @{t=$stamp;msg='bridge upstream error';data=@{status=403;upstreamModel=$canary;body=$canary}},
    @{t=$stamp;msg='agent stderr';data=@{text="Warning: Exceeded skills context budget of 2%. 131 additional skills were not included. password=$canary"}},
    @{t=$stamp;msg='package installer completed';data=@{ok=$false;installerLog=@{text="failed to create process. C:\$canary\pip.exe"}}}
)
$logText = (@($records | ForEach-Object {ConvertTo-Json -InputObject $_ -Depth 8 -Compress}) -join "`n") + "`nBROKEN JSON`n"
[IO.File]::WriteAllText($log, $logText, $utf8)
$activity = @{id='private-call';status='failed';title=$canary;providerToolName='mcp__open_science_notebook__notebook_execute';
    agentFrameId='private-frame';messageBranchId='private-branch';runtimeSegmentId='private-runtime';
    promptMessageId='private-prompt';updatedAt=1789268850000;rawInput=@{code=$canary};
    rawOutput=@{error="Invalid notebook RPC token. Bearer $canary"};toolContent=@(@{text=$canary})}
$old = $activity.Clone(); $old.id='private-old-call'; $old.messageBranchId='private-old-branch'
$session = @{id='private-session';title=$canary;messages=@(@{role='user';content=$canary});
    activities=@($activity);conversationGraph=@{schemaVersion=1;frames=@(@{id='private-frame';activeBranchId='private-branch'});activities=@($activity,$old)}}
$sessionEnvelope = @{version=2;session=$session}
[IO.File]::WriteAllText($sessionFile, (ConvertTo-Json -InputObject $sessionEnvelope -Depth 15), $utf8)

function Assert($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function RunCollector([string[]]$Options) {
    $before = @(Get-ChildItem -LiteralPath $output -Directory).Count
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'diagnose.ps1') -OutputRoot $output @Options | ForEach-Object { Write-Host $_ }
    Assert ($LASTEXITCODE -eq 0) 'collector process failed'
    $dirs = @(Get-ChildItem -LiteralPath $output -Directory | Sort-Object LastWriteTimeUtc)
    Assert ($dirs.Count -eq $before+1) 'run did not preserve prior reports'
    $dir = $dirs[-1].FullName
    $raw = [IO.File]::ReadAllText((Join-Path $dir 'diagnosis.json'))
    $txt = [IO.File]::ReadAllText((Join-Path $dir 'diagnosis.txt'))
    foreach ($forbidden in @($canary,'private-session','private-provider','private-call','private-frame','private-branch','private-runtime','private-prompt',$sourceRoot)) {
        Assert (!$raw.Contains($forbidden) -and !$txt.Contains($forbidden)) 'privacy canary leaked'
    }
    return (ConvertFrom-Json -InputObject $raw)
}
$beforeLog = (Get-FileHash -LiteralPath $log).Hash
$beforeSession = (Get-FileHash -LiteralPath $sessionFile).Hash
$report = RunCollector @('-LogPath',$log,'-SessionPath',$sessionFile)
Assert ($report.signatureCounts.'invalid-notebook-rpc-token' -eq 2) 'graph duplicate projection or signature parsing wrong'
Assert ($report.collectorVersion -eq '1.1.0' -and $report.reportVersion -eq 2) 'collector version missing'
$sessionInput = @($report.inputs | Where-Object {$_.kind -eq 'session'})[0]
Assert ($sessionInput.decodeStatus -eq 'decoded' -and $sessionInput.format -eq 'envelope-v2') 'production envelope was not decoded'
Assert ($sessionInput.activityCount -eq 2 -and $sessionInput.inspectedActivityCount -eq 2 -and $sessionInput.failedActivityCount -eq 2 -and $sessionInput.activitiesWithOutput -eq 2) 'activity coverage wrong'
Assert ($report.signatureCounts.'skills-list-omitted' -eq 1) 'skills warning missing'
Assert ($report.coverage.invalidOrOversizedLogLines -eq 1) 'malformed line not counted'
$results = @($report.events | Where-Object {$_.event -eq 'persisted-tool-result'})
Assert (@($results | Where-Object {$_.branchRelation -eq 'exact-active-branch'}).Count -eq 1) 'active branch wrong'
Assert (@($results | Where-Object {$_.branchRelation -eq 'other-branch-or-ancestor'}).Count -eq 1) 'historical branch wrong'
$failed = @($report.events | Where-Object {$_.event -eq 'tool-failed'})[0]
Assert ($failed.tool -eq 'notebook_execute' -and $failed.toolCall -eq $results[0].toolCall) 'tool ID join lost'
Assert ($beforeLog -eq (Get-FileHash -LiteralPath $log).Hash -and $beforeSession -eq (Get-FileHash -LiteralPath $sessionFile).Hash) 'input was changed'
$v1 = @{version=1;session=$session}
[IO.File]::WriteAllText($sessionFile,(ConvertTo-Json -InputObject $v1 -Depth 15),$utf8)
$v1Report = RunCollector @('-LogPath',$log,'-SessionPath',$sessionFile)
Assert ($v1Report.signatureCounts.'invalid-notebook-rpc-token' -eq 2) 'released v1 envelope not supported'
foreach ($invalidEnvelope in @(@{version=99;session=$session}, @{version='2';session=$session}, @{version=2;session=@($session)}, @{session=$session})) {
    [IO.File]::WriteAllText($sessionFile,(ConvertTo-Json -InputObject $invalidEnvelope -Depth 15),$utf8)
    $invalidReport = RunCollector @('-LogPath',$log,'-SessionPath',$sessionFile)
    Assert ($invalidReport.signatureCounts.'invalid-notebook-rpc-token' -eq 0) 'unsupported envelope was inspected'
    $invalidInput = @($invalidReport.inputs | Where-Object {$_.kind -eq 'session'})[0]
    Assert ($invalidInput.decodeStatus -in @('invalid-envelope','unsupported-envelope')) 'envelope decode failure not disclosed'
}
$empty = @{version=2;session=@{id='private-session';conversationGraph=@{schemaVersion=1;frames=@();activities=@()}}}
[IO.File]::WriteAllText($sessionFile,(ConvertTo-Json -InputObject $empty -Depth 8),$utf8)
$emptyReport = RunCollector @('-LogPath',$log,'-SessionPath',$sessionFile)
Assert ($emptyReport.coverage.notes -contains 'session-no-inspectable-activities') 'empty activities not disclosed'
$noOutput = @{version=2;session=@{id='private-session';activities=@(@{id='private-call';status='failed';title='notebook_execute'})}}
[IO.File]::WriteAllText($sessionFile,(ConvertTo-Json -InputObject $noOutput -Depth 8),$utf8)
$noOutputReport = RunCollector @('-LogPath',$log,'-SessionPath',$sessionFile)
Assert ($noOutputReport.coverage.notes -contains 'session-no-tool-output') 'missing tool output not disclosed'
Assert (@($noOutputReport.events | Where-Object {$_.event -eq 'persisted-tool-result'}).Count -eq 1) 'failed activity without output was dropped'
$copyOnly = RunCollector @('-LogPath',$log)
Assert (@($copyOnly.inputs | Where-Object {$_.kind -eq 'session'}).Count -eq 0) 'copied log mode read local sessions'
Assert ($copyOnly.coverage.notes -contains 'no-session-error-content-collected') 'missing session not disclosed'
$missing = RunCollector @('-LogPath',(Join-Path $sourceRoot 'missing.log'))
Assert ($missing.inputs.Count -eq 0 -and $missing.coverage.notes -contains 'log-location-missing') 'missing input not disclosed'
$badSession = Join-Path $sourceRoot 'bad.json'
[IO.File]::WriteAllText($badSession,'{broken', $utf8)
$bad = RunCollector @('-LogPath',$log,'-SessionPath',$badSession)
Assert ($bad.coverage.notes -contains 'session-json-invalid-or-unsupported') 'bad session not disclosed'
$large = Join-Path $sourceRoot 'large.log'
$stream = [IO.File]::Create($large); $stream.SetLength(8MB+1); $stream.Dispose()
$big = RunCollector @('-LogPath',$large)
Assert ($big.inputs[0].status -eq 'size-limit') 'large input not bounded'
$legacy = @{id='private-session';activities=@(@{id='private-call';status='failed';title='repl_execute';rawOutput=@{error='Invalid notebook RPC token.'}})}
[IO.File]::WriteAllText($sessionFile,(ConvertTo-Json -InputObject $legacy -Depth 8),$utf8)
$oldReport = RunCollector @('-LogPath',$log,'-SessionPath',$sessionFile)
Assert ($oldReport.signatureCounts.'invalid-notebook-rpc-token' -eq 1) 'legacy activity not supported'
Assert (@($oldReport.events | Where-Object {$_.branchRelation -eq 'legacy-or-unknown'}).Count -eq 1) 'legacy branch mislabeled'
$network = RunCollector @('-LogPath','\\localhost\c$\secret.log')
Assert ($network.coverage.notes -contains 'log-location-unreadable-or-unsafe') 'network input not refused'
$unsupported = @{id='private-session';conversationGraph=@{schemaVersion=99;activities=@($activity)}}
[IO.File]::WriteAllText($sessionFile,(ConvertTo-Json -InputObject $unsupported -Depth 8),$utf8)
$unknownGraph = RunCollector @('-LogPath',$log,'-SessionPath',$sessionFile)
Assert ($unknownGraph.coverage.notes -contains 'session-graph-version-unsupported') 'unknown graph silently treated as current'

# Exercise the actual automatic lookup with a private synthetic profile and an unrelated Session.
$fakeAppData = Join-Path $FixtureRoot 'fake-appdata'
$fakeHome = Join-Path $FixtureRoot 'fake-home'
$fakeLogs = Join-Path $fakeAppData 'Open Science/logs'
$fakeSessions = Join-Path $fakeHome '.open-science/sessions/project-1'
$null = New-Item -ItemType Directory -Path $fakeLogs,$fakeSessions -Force
[IO.File]::WriteAllText((Join-Path $fakeLogs 'main.log'), $logText, $utf8)
[IO.File]::WriteAllText((Join-Path $fakeSessions 'private-session.json'), (ConvertTo-Json -InputObject $sessionEnvelope -Depth 15), $utf8)
[IO.File]::WriteAllText((Join-Path $fakeSessions 'unrelated.json'), '{broken-should-not-be-read', $utf8)
$savedAppData=$env:APPDATA; $savedProfile=$env:USERPROFILE
try {
    $env:APPDATA=$fakeAppData; $env:USERPROFILE=$fakeHome
    $automatic = RunCollector @()
    Assert (@($automatic.inputs | Where-Object {$_.kind -eq 'session'}).Count -eq 1) 'automatic lookup did not restrict Session reads'
    Assert ($automatic.signatureCounts.'invalid-notebook-rpc-token' -eq 2) 'automatic session evidence missing'
    # Windows path quoting and double-click entrypoint: parentheses, spaces, Unicode and ampersand.
    $cmdDir = Join-Path $FixtureRoot '双击诊断 (test) & space'
    $null = New-Item -ItemType Directory -Path $cmdDir -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'diagnose.cmd'),(Join-Path $PSScriptRoot 'diagnose.ps1') -Destination $cmdDir
    $savedPause=$env:OPEN_SCIENCE_DIAG_NO_PAUSE
    try {
        $env:OPEN_SCIENCE_DIAG_NO_PAUSE='1'
        Push-Location -LiteralPath $cmdDir
        try { & cmd.exe /d /c diagnose.cmd | ForEach-Object {Write-Host $_}; Assert ($LASTEXITCODE -eq 0) 'CMD entrypoint failed' }
        finally { Pop-Location }
    } finally { $env:OPEN_SCIENCE_DIAG_NO_PAUSE=$savedPause }
    $cmdReports = @(Get-ChildItem -LiteralPath $cmdDir -Directory -Filter 'diagnosis-*')
    Assert ($cmdReports.Count -eq 1) 'CMD did not create report'
    $cmdRaw=[IO.File]::ReadAllText((Join-Path $cmdReports[0].FullName 'diagnosis.json'))
    Assert (!$cmdRaw.Contains($canary)) 'CMD privacy canary leaked'
} finally { $env:APPDATA=$savedAppData; $env:USERPROFILE=$savedProfile }
Write-Host 'PASS: signatures, ID joins, branch separation, privacy canaries, input preservation, repeat runs, copied logs, missing/malformed/large input, legacy/unknown formats, network refusal, automatic scoped lookup, actual CMD in a special-character path.'
Write-Host ('Fixture evidence: ' + $FixtureRoot)
