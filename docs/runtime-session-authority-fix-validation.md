# Runtime Session authority 修复后的真实用户场景验证

日期：2026-11-18

诊断包和根因说明见 [runtime-session-authority-repro.md](./runtime-session-authority-repro.md)。

## 修复内容

修复位于 [session-capability-owner.ts](../src/main/acp/session-capability-owner.ts:194)：

- 新建 ACP Session 在 provider 返回 App Session ID 之前只有临时的 `literature-session-*` 路由别名，不再用这个别名读取持久化 runtime context。
- 恢复已有 Session 时，只把 `stableAppSessionId`（例如 `ses_*`）传给 Literature 的 `isEnabled`。
- Literature 显式启用和 MCP/HTTP 路由注册逻辑保持不变。

| 场景                                  | authority 查询参数                 | 预期                                           |
| ------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| 新建 Session、尚未得到 App Session ID | 不查询                             | 不产生 `Runtime Session authority unavailable` |
| 恢复已有 Session                      | `stableAppSessionId`，如 `ses_...` | 读取正确的 durable authority                   |
| Literature 显式启用                   | 不依赖 authority 探针              | Literature 工具仍挂载                          |

## 自动验证

| 检查                               | 结果                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 相关 Vitest                        | 3 个文件，88 个用例通过                                                                                    |
| 定向 ESLint                        | 通过                                                                                                       |
| Prettier check                     | 通过                                                                                                       |
| `git diff --check`                 | 通过                                                                                                       |
| Backend 编译（不含原生组件重命名） | 通过；`build-backend.mjs` 生成 Node backend 和 5 个 workers                                                |
| Node 类型检查                      | 被仓库既有依赖错误阻断：`claude-agent-acp/dist/acp-agent.js` 缺少 `waitForMcpServers` 导出，与本次修改无关 |
| 完整 backend wrapper               | 原生组件阶段因 Windows 文件锁返回 `EPERM rename`；不是 TypeScript 或本次代码错误                           |
| 完整 Electron/provider E2E         | 需按下方步骤验证                                                                                           |

新增回归测试位于 [session-capability-owner.test.ts](../src/main/acp/session-capability-owner.test.ts:395)：

1. 临时 Literature routing alias 不触发持久化 authority 查询；
2. 已有 Session 查询时传入真实 App Session ID。

## 手工测试前提

请在 Windows PowerShell 中使用独立 profile。需要一个可用 provider；凭证只能通过已有环境变量提供，不要写入命令历史、脚本或日志。

## 完整操作链路

### 1. 创建独立 profile

在第一个 PowerShell 窗口执行：

```powershell
$repo = 'C:\Users\Helix\.codex\worktrees\afee\openscience-recheck'
$task = Join-Path $repo '.dev-isolate\manual-runtime-authority-fixed'
$runtime = Join-Path $task 'runtime'

New-Item -ItemType Directory -Force -Path `
(Join-Path $runtime 'data'), (Join-Path $runtime 'config'), `
(Join-Path $runtime 'install-state'), (Join-Path $runtime 'tmp'), `
(Join-Path $runtime 'logs'), (Join-Path $runtime 'npm-cache') | Out-Null

$env:OPEN_SCIENCE_E2E_STORAGE_ROOT = $runtime
$env:OPEN_SCIENCE_CONFIG_ROOT = Join-Path $runtime 'config'
$env:OPEN_SCIENCE_USER_DATA = Join-Path $runtime 'data'
$env:OPEN_SCIENCE_INSTALLATION_STATE_ROOT = Join-Path $runtime 'install-state'
$env:TEMP = Join-Path $runtime 'tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:OPEN_SCIENCE_ALLOW_MULTI_INSTANCE = '1'
$env:npm_config_cache = Join-Path $runtime 'npm-cache'
$env:OPEN_SCIENCE_STORAGE_ROOT = $null

Set-Location $repo
```

检查路径都在隔离目录下：

```powershell
$env:OPEN_SCIENCE_E2E_STORAGE_ROOT
$env:OPEN_SCIENCE_CONFIG_ROOT
$env:OPEN_SCIENCE_USER_DATA
$env:OPEN_SCIENCE_INSTALLATION_STATE_ROOT
```

### 2. 配置 provider、启动服务、创建 Project

如果隔离 profile 尚未配置 provider，使用环境变量引用密钥：

```powershell
node packages/open-science/cli.mjs provider add `
--type official --vendor openai --model '<model-id>' --api-key-env OPENAI_API_KEY
node packages/open-science/cli.mjs start --no-open --json

$projectResult = node packages/open-science/cli.mjs project create `
  'Literature authority fix acceptance' --json | ConvertFrom-Json
$projectId = $projectResult.id
$projectId
```

### 3. 监听日志

在第二个 PowerShell 窗口重新设置第 1 步的隔离变量，然后执行：

```powershell
Set-Location 'C:\Users\Helix\.codex\worktrees\afee\openscience-recheck'
$log = Get-ChildItem -Recurse $env:OPEN_SCIENCE_CONFIG_ROOT -Filter main.log |
Select-Object -First 1
if (-not $log) { throw 'main.log not found under isolated config root' }

Get-Content $log.FullName -Wait |
Select-String 'Runtime Session authority unavailable|createSession: createMcpServers|session capabilities built|literature-session-'
```

### 4. 执行真实 Literature 任务

回到第一个窗口，设置上一步输出的 Project ID：

```powershell
$projectId = '<copy-project-id-from-step-2>'
$runOutput = node packages/open-science/cli.mjs run `
--project $projectId `
  --skill literature-review `
  --prompt '请检索两篇关于 reproducible research 的论文，比较研究方法，并给出 DOI。' `
  --wait --jsonl | Tee-Object (Join-Path $runtime 'logs\first-run.jsonl')

$runOutput
$runOutput | Select-String 'sessionId'
$sessionId = '<copy-ses-id-from-run-output>'
```

这个任务同时验证 Literature capability 能正常建立、实际 Literature 工具能返回结果。provider 本身的凭证或网络错误应单独显示，不能表现为 authority missing。

### 5. 验收新建 Session

日志中可以看到 `createSession: createMcpServers` 和 `literature-session-...` 路由注册，但不应看到同时满足以下条件的事件：

```text
event=Runtime Session authority unavailable
operation=runtime-context-read
authorityStatus=missing
sessionId=literature-session-...
```

CLI 任务应完成并返回论文结果，或返回明确的 provider 错误。不要把“没有 warning”当作唯一验收条件。

### 6. 重启服务并恢复同一个 Session

保留隔离目录，只重启服务：

```powershell
node packages/open-science/cli.mjs stop --force
node packages/open-science/cli.mjs start --no-open --json

$resumeOutput = node packages/open-science/cli.mjs run `
  --project $projectId `
--session $sessionId `
  --prompt '请继续上一个文献比较任务，补充两篇论文的研究限制。' `
  --wait --jsonl | Tee-Object (Join-Path $runtime 'logs\resume-run.jsonl')

$resumeOutput
```

验收：

- `sessionId` 是真实的 `ses_*`；
- Literature 工具仍可用；
- 不出现 `literature-session-...` 作为 `runtime-context-read` 的 Session ID；
- 不出现 `Runtime Session authority unavailable`；
- 对话能继续使用已有上下文，或显示明确的 provider 恢复错误。

### 7. 普通任务对照

```powershell
$plainOutput = node packages/open-science/cli.mjs run `
  --project $projectId `
--prompt '请列出这个 Project 当前的研究目标，并给出三个下一步建议。' `
--wait --jsonl
$plainOutput
```

普通任务不应出现 Literature authority warning。若出现，保留其 `operation`、`sessionId` 和前后各 20 行日志，以便继续定位其他调用方。

### 8. 清理

确认当前变量指向手工测试目录后执行：

```powershell
node packages/open-science/cli.mjs stop --force
$task
Remove-Item -LiteralPath $task -Recurse -Force
```

不要对正式 `OPEN_SCIENCE_CONFIG_ROOT`、`OPEN_SCIENCE_USER_DATA`、`dataRoot` 或已有 Session 目录执行删除。

## 失败时收集的最小信息

保留 warning JSON 中的 `projectId`、`sessionId`、`operation`、`phase`、`authorityStatus`，以及发生前后各 20 行主日志和 CLI JSONL 输出。不要上传 API key、credential store、完整配置根目录或未筛选的诊断包。
