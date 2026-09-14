#requires -version 5.1
param(
    [string]$LogPath,
    [string]$ConfigRoot,
    [string]$SessionPath,
    [string]$SessionId,
    [string]$OutputRoot = $PSScriptRoot
)

# Offline, read-only collection. Never serialize an input object into the report.
$ErrorActionPreference = 'Stop'
$script:aliases = @{}
$script:events = New-Object 'Collections.Generic.Queue[object]'
$script:inputs = New-Object 'Collections.Generic.List[object]'
$script:notes = New-Object 'Collections.Generic.List[string]'
$script:readBytes = 0
$script:omittedEvents = 0
$utf8 = New-Object Text.UTF8Encoding($true)
$toolNames = @('notebook_execute','bash_execute','repl_execute','notebook_state',
    'notebook_restart','notebook_shutdown','load_skill','write_artifact_file',
    'inspect_packages','manage_packages','manage_environments','request_network_access',
    'list_notebook_runtimes','notebook_bind_runtime','notebook_switch_runtime','background_run')
$eventNames = @{
    'app starting' = 'app-start'
    'agent initialized' = 'agent-initialized'
    'agent process exit' = 'agent-exit'
    'skipping incompatible provider resume; adopting a fresh session' = 'provider-adoption'
    'acp:resume-session completed' = 'resume-complete'
    'session capabilities built' = 'capabilities-built'
    'session transcript replay dispatched' = 'history-replay'
    'prompt start' = 'prompt-start'
    'prompt stopped' = 'prompt-stop'
    'tool call failed' = 'tool-failed'
    'bridge skill selection completed' = 'skill-selection-complete'
    'bridge skill selection failed' = 'skill-selection-failed'
    'native Responses Skill selection failed' = 'skill-selection-failed'
    'bridge upstream error' = 'provider-http-error'
    'package installer completed' = 'package-install-result'
    'renderer javascript failure' = 'renderer-error'
    'Remote access remoteit enable failed' = 'remote-access-failed'
    'run evidence prepared' = 'notebook-run'
    'notebook RPC server starting' = 'rpc-start'
    'notebook RPC server stopped' = 'rpc-stop'
}
$signaturePatterns = [ordered]@{
    'invalid-notebook-rpc-token' = '(?i)Invalid notebook RPC token\.'
    'skills-list-omitted' = '(?i)Exceeded skills context budget|additional skills were not included'
    'skills-descriptions-shortened' = '(?i)Skill descriptions were shortened to fit'
    'session-bound-token-required' = '(?i)A session-bound notebook RPC token is required'
    'artifact-capability-expired' = '(?i)Artifact RPC capability expired'
    'frame-scope-mismatch' = '(?i)Notebook RPC capability does not match active Agent Frame'
    'process-launch-failed' = '(?i)failed to create process'
    'package-verification-failed' = '(?i)Package installation could not be verified'
    'permission-denied' = '(?i)permission denied|access is denied|\bEACCES\b|\bEPERM\b'
    'connection-refused' = '(?i)ECONNREFUSED|connection refused'
}

function Field($Value, [string]$Name) {
    if ($null -eq $Value) { return $null }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -ne $property) { return ,$property.Value }
    return $null
}
function Alias([string]$Kind, $Value) {
    if ($Value -isnot [string] -or !$Value -or $Value.Length -gt 512) { return $null }
    if (!$script:aliases.ContainsKey($Kind)) { $script:aliases[$Kind] = @{} }
    $map = $script:aliases[$Kind]
    if (!$map.ContainsKey($Value)) { $map[$Value] = '{0}-{1:D3}' -f $Kind, ($map.Count + 1) }
    return $map[$Value]
}
function Timestamp($Value) {
    try {
        if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString('o') }
        if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime.ToString('o') }
        if ($Value -is [string] -and $Value -match '^20\d\d-\d\d-\d\dT') {
            return ([DateTimeOffset]::Parse($Value)).UtcDateTime.ToString('o')
        }
        if ($Value -is [ValueType] -and [double]$Value -ge 946684800000 -and [double]$Value -lt 4102444800000) {
            return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Value).UtcDateTime.ToString('o')
        }
    } catch { }
    return $null
}
function SafeTool($Value) {
    if ($Value -isnot [string]) { return 'unknown' }
    foreach ($name in $toolNames) {
        if ($Value -eq $name -or $Value -match ('^mcp__[a-z0-9_]+__' + $name + '$')) { return $name }
    }
    return 'unknown'
}
function Signatures([string]$Text) {
    foreach ($key in $signaturePatterns.Keys) {
        if ([regex]::IsMatch($Text, $signaturePatterns[$key], 'None', [TimeSpan]::FromSeconds(1))) { $key }
    }
}
function AddEvent($Event) {
    if ($script:events.Count -ge 4000) { $null = $script:events.Dequeue(); $script:omittedEvents++ }
    $script:events.Enqueue($Event)
}
function AssertLocalPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -notmatch '^[A-Za-z]:[\\/]' -or $full.Substring(2).Contains(':')) { throw 'unsafe-path' }
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($full))
    if ($drive.DriveType -eq [IO.DriveType]::Network) { throw 'network-path' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'linked-path'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (!$parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}
function ReadInput([string]$Path, [string]$Kind, [int]$Limit) {
    $record = [ordered]@{ source = Alias 'source' $Path; kind = $Kind; status = 'unreadable'; bytes = 0 }
    $script:inputs.Add($record)
    $stream = $null
    try {
        $full = AssertLocalPath $Path
        if (!(Test-Path -LiteralPath $full -PathType Leaf)) { $record.status = 'missing'; return $null }
        $before = Get-Item -LiteralPath $full
        if ($before.Length -gt $Limit -or $script:readBytes + $before.Length -gt 64MB) {
            $record.status = 'size-limit'; return $null
        }
        $stream = [IO.File]::Open($full, 'Open', 'Read', 'ReadWrite,Delete')
        $buffer = New-Object byte[] ([int]$before.Length + 1)
        $offset = 0
        while ($offset -lt $buffer.Length) {
            $n = $stream.Read($buffer, $offset, $buffer.Length - $offset)
            if (!$n) { break }
            $offset += $n
        }
        $script:readBytes += $offset
        $record.bytes = $offset
        $after = Get-Item -LiteralPath $full
        $record.status = 'read'
        if ($offset -gt $before.Length -or $after.Length -ne $before.Length -or $after.LastWriteTimeUtc -ne $before.LastWriteTimeUtc) {
            $record.status = 'changed-during-read'
        }
        return [Text.Encoding]::UTF8.GetString($buffer, 0, $offset).TrimStart([char]0xFEFF)
    } catch { $record.status = 'unreadable-or-unsafe'; return $null }
    finally { if ($stream) { $stream.Dispose() } }
}

try {
    $outputBase = AssertLocalPath $OutputRoot
    if (!(Test-Path -LiteralPath $outputBase -PathType Container)) { throw 'output-root-missing' }
    $out = Join-Path $outputBase ('diagnosis-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    $null = New-Item -ItemType Directory -Path $out
    $copiedLogMode = ![string]::IsNullOrWhiteSpace($LogPath)
    $logFiles = New-Object 'Collections.Generic.List[string]'
    $locations = @($LogPath)
    if (!$copiedLogMode) { $locations = @((Join-Path $env:APPDATA 'Open Science/logs')) }
    foreach ($location in $locations) {
        try {
            $location = AssertLocalPath $location
            if (Test-Path -LiteralPath $location -PathType Leaf) { $logFiles.Add($location) }
            elseif (Test-Path -LiteralPath $location -PathType Container) {
                $found = @(Get-ChildItem -LiteralPath $location -File | Where-Object { $_.Name -match '^main(?:\.\d+)?\.log$' } | Sort-Object LastWriteTimeUtc -Descending)
                if ($found.Count -gt 3) { $script:notes.Add('log-file-limit') }
                foreach ($file in ($found | Select-Object -First 3)) { $logFiles.Add($file.FullName) }
            } else { $script:notes.Add('log-location-missing') }
        } catch { $script:notes.Add('log-location-unreadable-or-unsafe') }
    }
    $rows = New-Object 'Collections.Generic.List[object]'
    $badLines = 0
    foreach ($file in $logFiles) {
        $text = ReadInput $file 'log' 8MB
        if ($null -eq $text) { continue }
        $lines = $text -split '\r?\n'
        $start = [Math]::Max(0, $lines.Length - 25000)
        if ($start) { $script:notes.Add('log-line-limit') }
        for ($i = $start; $i -lt $lines.Length; $i++) {
            if (!$lines[$i].Trim()) { continue }
            if ($lines[$i].Length -gt 1MB) { $badLines++; continue }
            try {
                $entry = ConvertFrom-Json -InputObject $lines[$i] -ErrorAction Stop
                $time = Timestamp (Field $entry 't')
                if (!$time -or (Field $entry 'msg') -isnot [string]) { $badLines++; continue }
                $rows.Add(@{ time=$time; line=$i+1; source=(Alias 'source' $file); entry=$entry })
            } catch { $badLines++ }
        }
    }
    $orderedRows = @($rows | Sort-Object { $_.time }, { $_.source }, { $_.line })
    $latest = if ($orderedRows.Count) { $orderedRows[-1].time } else { $null }
    $cutoff = if ($latest) { ([DateTimeOffset]::Parse($latest)).AddDays(-7).UtcDateTime.ToString('o') } else { '' }
    $permissions = @{}
    foreach ($row in $orderedRows) {
        $data = Field $row.entry 'data'
        $callId = Field $data 'toolCallId'
        if ((Field $row.entry 'msg') -eq 'permission request received' -and $callId -is [string]) {
            $permissions[$callId] = SafeTool (Field $data 'tool')
        }
    }
    $failedSessions = New-Object 'Collections.Generic.List[string]'
    $versions = New-Object 'Collections.Generic.List[string]'
    foreach ($row in $orderedRows) {
        $entry = $row.entry
        $data = Field $entry 'data'
        $msg = Field $entry 'msg'
        $callId = Field $data 'toolCallId'
        if ($msg -eq 'app starting') {
            $version = Field $data 'version'
            if ($version -is [string] -and $version -match '^\d{1,4}\.\d{1,4}\.\d{1,4}$' -and !$versions.Contains($version)) { $versions.Add($version) }
        }
        if ($row.time -lt $cutoff) { continue }
        # Only diagnostic metadata, never command bodies or tool input, is inspected for signatures.
        $probe = @($msg, (Field $data 'message'), (Field $data 'error'), (Field $data 'text'), (Field (Field $data 'installerLog') 'text')) -join ' '
        $marks = @(Signatures $probe)
        $kind = $eventNames[$msg]
        if (!$kind -and !$marks.Count) { continue }
        if (!$kind) { $kind = 'log-signature' }
        $event = [ordered]@{ source=$row.source; line=$row.line; timeUtc=$row.time; event=$kind; signatures=$marks }
        $event.session = Alias 'session' (Field $data 'sessionId')
        $event.appRun = Alias 'app-run' (Field $entry 'runId')
        $event.toolCall = Alias 'call' $callId
        if ($kind -eq 'tool-failed') {
            $event.tool = if ($callId -is [string] -and $permissions.ContainsKey($callId)) { $permissions[$callId] } else { SafeTool (Field $data 'tool') }
            $sid = Field $data 'sessionId'
            if ($sid -is [string] -and $sid -match '^[a-zA-Z0-9_-]{1,128}$') { $failedSessions.Add($sid) }
        }
        foreach ($key in @('contextReset','expected','kernelDispatched','ok')) {
            $value = Field $data $key
            if ($value -is [bool]) { $event[$key] = $value }
        }
        foreach ($key in @('catalogCount','routedCatalogCount','generation','count')) {
            $value = Field $data $key
            if ($value -is [ValueType] -and [double]$value -ge 0 -and [double]$value -le 1000000) { $event[$key] = [long]$value }
        }
        $status = Field $data 'status'
        if ($status -is [ValueType] -and [double]$status -ge 100 -and [double]$status -le 599) { $event.httpStatus = [int]$status }
        elseif ($status -in @('completed','failed','cancelled','timeout','running')) { $event.status = $status }
        $reason = Field $data 'reason'
        if ($reason -in @('backend-changed','framework-changed','invalid-response','timeout','cancelled','upstream-http')) { $event.reason = $reason }
        $framework = Field $data 'framework'
        if (!$framework) { $framework = Field $data 'frameworkId' }
        if ($framework -in @('codex','claude-code','opencode','codebuddy')) { $event.framework = $framework }
        $event.model = Alias 'model' (Field $data 'model')
        if (!$event.model) { $event.model = Alias 'model' (Field $data 'upstreamModel') }
        AddEvent $event
    }

    # Session JSON lives under the config root, not the configurable research data directory.
    $sessionFiles = New-Object 'Collections.Generic.List[string]'
    if ($SessionPath) { $sessionFiles.Add($SessionPath) }
    elseif (!$copiedLogMode -or $ConfigRoot) {
        if (!$ConfigRoot) { $ConfigRoot = Join-Path $env:USERPROFILE '.open-science' }
        $targets = @()
        if ($SessionId) {
            if ($SessionId -notmatch '^[a-zA-Z0-9_-]{1,128}$') { throw 'invalid-session-id' }
            $targets = @($SessionId)
        } else {
            $unique = New-Object 'Collections.Generic.List[string]'
            for ($i=$failedSessions.Count-1; $i -ge 0 -and $unique.Count -lt 3; $i--) {
                if (!$unique.Contains($failedSessions[$i])) { $unique.Add($failedSessions[$i]) }
            }
            $targets = @($unique.ToArray())
        }
        try {
            $sessionRoot = AssertLocalPath (Join-Path $ConfigRoot 'sessions')
            if ($targets.Count -and (Test-Path -LiteralPath $sessionRoot -PathType Container)) {
                $projects = @(Get-ChildItem -LiteralPath $sessionRoot -Directory | Select-Object -First 101)
                if ($projects.Count -gt 100) { $script:notes.Add('project-directory-limit') }
                foreach ($project in ($projects | Select-Object -First 100)) {
                    if ($project.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
                    foreach ($target in $targets) {
                        $candidate = Join-Path $project.FullName ($target + '.json')
                        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and $sessionFiles.Count -lt 3) { $sessionFiles.Add($candidate) }
                    }
                }
            }
        } catch { $script:notes.Add('session-location-unreadable-or-unsafe') }
    }
    if (!$sessionFiles.Count) { $script:notes.Add('no-session-error-content-collected') }
    foreach ($file in $sessionFiles) {
        $text = ReadInput $file 'session' 16MB
        if ($null -eq $text) { continue }
        $inputRecord = $script:inputs[$script:inputs.Count - 1]
        $inputRecord['decodeStatus'] = 'invalid-json'
        try { $session = ConvertFrom-Json -InputObject $text -ErrorAction Stop }
        catch { $script:notes.Add('session-json-invalid-or-unsupported'); continue }
        # Production stores { version, session }, not a bare Session. Match the released
        # envelope contract in decodeSessionEnvelope; never fall back through unknown versions.
        $inputRecord['decodeStatus'] = 'invalid-envelope'
        if ($session -isnot [pscustomobject]) { $script:notes.Add('session-envelope-invalid'); continue }
        $hasEnvelope = $null -ne $session.PSObject.Properties['version'] -or $null -ne $session.PSObject.Properties['session']
        $inputRecord['format'] = 'bare'
        if ($hasEnvelope) {
            $version = Field $session 'version'
            if (($version -is [int] -or $version -is [long]) -and $version -gt 2) {
                $inputRecord['decodeStatus'] = 'unsupported-envelope'
                $script:notes.Add('session-envelope-version-unsupported'); continue
            }
            if (($version -isnot [int] -and $version -isnot [long]) -or $version -notin @(1,2) -or (Field $session 'session') -isnot [pscustomobject]) {
                $script:notes.Add('session-envelope-invalid'); continue
            }
            $inputRecord['format'] = if ($version -eq 1) { 'envelope-v1' } else { 'envelope-v2' }
            $session = Field $session 'session'
        }
        $inputRecord['decodeStatus'] = 'invalid-session'
        if ((Field $session 'id') -isnot [string] -or !(Field $session 'id')) {
            $script:notes.Add('session-structure-invalid'); continue
        }
        $graph = Field $session 'conversationGraph'
        $source = Alias 'source' $file
        $sid = Alias 'session' (Field $session 'id')
        $inputRecord['session'] = $sid
        $graphActivities = Field $graph 'activities'
        $hasGraph = $null -ne $graph
        if ($hasGraph -and (Field $graph 'schemaVersion') -ne 1) {
            $inputRecord['decodeStatus'] = 'unsupported-graph'
            $script:notes.Add('session-graph-version-unsupported'); continue
        }
        if (($hasGraph -and $graphActivities -isnot [Array]) -or
            (!$hasGraph -and (Field $session 'activities') -isnot [Array] -and (Field $session 'messages') -isnot [Array])) {
            $script:notes.Add('session-structure-invalid'); continue
        }
        $inputRecord['decodeStatus'] = 'decoded'
        $flatActivities = Field $session 'activities'
        $activities = if ($hasGraph) { @($graphActivities) } else { @($flatActivities) }
        $inputRecord['activityCount'] = @($activities | Where-Object { $null -ne $_ }).Count
        $inputRecord['inspectedActivityCount'] = 0
        $inputRecord['failedActivityCount'] = 0
        $inputRecord['activitiesWithOutput'] = 0
        if ($activities.Count -gt 10000) { $script:notes.Add('session-activity-limit') }
        $frames = @{}
        $graphFrames = Field $graph 'frames'
        foreach ($frame in $graphFrames) {
            $fid = Field $frame 'id'
            if ($fid -is [string]) { $frames[$fid] = Field $frame 'activeBranchId' }
        }
        foreach ($activity in ($activities | Select-Object -Last 10000)) {
            if ($null -eq $activity) { continue }
            $time = Timestamp (Field $activity 'updatedAt')
            if ($time -and $cutoff -and $time -lt $cutoff) { continue }
            $status = Field $activity 'status'
            if ($status -notin @('pending','in_progress','completed','failed')) { continue }
            $inputRecord['inspectedActivityCount']++
            if ($status -eq 'failed') { $inputRecord['failedActivityCount']++ }
            # Inspect the known output fields in memory. Only fixed signature names leave this loop.
            $outputFields = @((Field $activity 'rawOutput'), (Field $activity 'toolContent'), (Field $activity 'terminalOutput'))
            if (@($outputFields | Where-Object { $null -ne $_ -and $_ -ne '' }).Count) { $inputRecord['activitiesWithOutput']++ }
            $probe = ConvertTo-Json -InputObject $outputFields -Depth 12 -Compress -WarningAction SilentlyContinue
            $marks = @(Signatures $probe)
            if (!$marks.Count -and $status -ne 'failed') { continue }
            $event = [ordered]@{ source=$source; timeUtc=$time; event='persisted-tool-result'; session=$sid;
                toolCall=(Alias 'call' (Field $activity 'id')); tool=(SafeTool (Field $activity 'providerToolName'));
                status=$status; signatures=$marks; branchRelation='legacy-or-unknown' }
            if ($event.tool -eq 'unknown') { $event.tool = SafeTool (Field $activity 'title') }
            if ($hasGraph) {
                $fid = Field $activity 'agentFrameId'; $bid = Field $activity 'messageBranchId'
                $event.frame = Alias 'frame' $fid; $event.branch = Alias 'branch' $bid
                $event.runtime = Alias 'runtime' (Field $activity 'runtimeSegmentId')
                $event.prompt = Alias 'prompt' (Field $activity 'promptMessageId')
                if ($fid -is [string] -and $frames.ContainsKey($fid) -and $bid -is [string]) {
                    $event.branchRelation = if ($frames[$fid] -eq $bid) { 'exact-active-branch' } else { 'other-branch-or-ancestor' }
                }
            }
            AddEvent $event
        }
        if (!$inputRecord['inspectedActivityCount']) { $script:notes.Add('session-no-inspectable-activities') }
        elseif (!$inputRecord['activitiesWithOutput']) { $script:notes.Add('session-no-tool-output') }
    }
    $counts = [ordered]@{}
    foreach ($key in $signaturePatterns.Keys) { $counts[$key] = 0 }
    foreach ($event in $script:events) { foreach ($mark in $event.signatures) { $counts[$mark]++ } }
    $report = [ordered]@{
        reportVersion=2; collectorVersion='1.1.0'; generatedAtUtc=[DateTime]::UtcNow.ToString('o'); collectorPowerShell=$PSVersionTable.PSVersion.ToString()
        privacy='allowlisted metadata and fixed signatures only; per-report aliases; no raw text, paths, credentials or uploads'
        latestLogTimeUtc=$latest; recentWindowStartUtc=$cutoff; observedAppVersions=@($versions.ToArray())
        coverage=@{ invalidOrOversizedLogLines=$badLines; omittedEvents=$script:omittedEvents; inputBytes=$script:readBytes;
            notes=@($script:notes.ToArray()); inputCount=$script:inputs.Count }
        inputs=@($script:inputs.ToArray()); signatureCounts=$counts; events=@($script:events.ToArray())
        limitations=@('No match means not observed, not healthy.', 'A signature in stored tool output is not proof of which lifecycle operation revoked a token.',
            'The same tool may appear in both logs and Session results; counts are observations, not unique failures.',
            'Other branches may be ancestors; exact-active-branch does not reconstruct the complete current transcript.',
            'Model names, original IDs, paths, arbitrary error text, conversation text and code are intentionally omitted.')
    }
    $lines = New-Object 'Collections.Generic.List[string]'
    $lines.Add('Open Science 脱敏诊断报告')
    $lines.Add('诊断工具版本：1.1.0；报告格式：2')
    $lines.Add('时间均为 UTC；北京时间需加 8 小时。请先检查报告，再发给支持人员。')
    $lines.Add('只读采集已结束。未修改应用配置/数据库，未执行工具命令，未上传任何数据。')
    $lines.Add('应用版本（日志观察值）：' + ($versions -join ', '))
    $lines.Add('日志最后时间：' + $latest)
    $lines.Add('分析窗口：日志最后时间向前 7 天；会话结果有时间时使用相同窗口。')
    $lines.Add('')
    if ($counts['invalid-notebook-rpc-token'] -gt 0) {
        $lines.Add('发现 Invalid notebook RPC token 错误特征。关注连接更新、会话恢复和令牌撤销顺序；本报告不能证明具体撤销原因。')
    } else { $lines.Add('未在已读取字段中找到 Invalid notebook RPC token。不能据此判断正常；错误正文可能未保存或已超出窗口。') }
    if ($counts['skills-list-omitted'] -gt 0) { $lines.Add('发现技能目录省略警告。它表示发现目录受限，不表示已安装技能被删除。') }
    $lines.Add('错误特征观察次数（可能包含同一错误的重复记录）：')
    foreach ($key in $counts.Keys) { $lines.Add('  ' + $key + ': ' + $counts[$key]) }
    $lines.Add('')
    $lines.Add('采集状态（source 编号对应 JSON，原始路径不导出）：')
    foreach ($input in $script:inputs) {
        $lines.Add('  ' + $input.source + ' ' + $input.kind + ' ' + $input.status)
        if ($input.kind -eq 'session' -and $input.Contains('decodeStatus')) {
            $lines.Add('    会话解析：' + $input.decodeStatus + '；格式：' + $input.format + '；匿名会话：' + $input.session)
            if ($input.decodeStatus -eq 'decoded') {
                $lines.Add(('    活动总数：{0}；窗口内已检查：{1}；其中失败：{2}；包含工具输出：{3}' -f $input.activityCount, $input.inspectedActivityCount, $input.failedActivityCount, $input.activitiesWithOutput))
            }
        }
    }
    $lines.Add('无法解析/超长日志行：' + $badLines + '；未输出事件：' + $script:omittedEvents)
    foreach ($note in $script:notes) { $lines.Add('  注意：' + $note) }
    $lines.Add('')
    $lines.Add('若 session 未采集：可使用 README 的 -SessionPath 方法选择指定会话 JSON；不要发送原始会话文件。')
    $lines.Add('未知错误原文已省略。缺少证据时请保留现场；无需反复重试或卸载环境。')
    $lines.Add('事件时间线（具体元数据见 diagnosis.json）：')
    foreach ($event in $script:events) {
        $lines.Add(('{0} {1} {2} {3} {4}' -f $event.timeUtc, $event.event, $event.session, $event.tool, ($event.signatures -join ',')))
    }
    [IO.File]::WriteAllText((Join-Path $out 'diagnosis.json'), (ConvertTo-Json -InputObject $report -Depth 16), $utf8)
    [IO.File]::WriteAllLines((Join-Path $out 'diagnosis.txt'), $lines.ToArray(), $utf8)
    Write-Host '诊断完成。请检查下列文件夹中的 diagnosis.txt 和 diagnosis.json，仅发送这两个文件：'
    Write-Host $out
    exit 0
} catch {
    # Exception messages can contain paths, credentials or raw input; never print or export them.
    Write-Host '无法完成诊断。请解压到可写的本地文件夹，检查参数，或联系支持人员。未上传数据。'
    exit 1
}
