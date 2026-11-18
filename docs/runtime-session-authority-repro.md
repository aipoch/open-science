# `Runtime Session authority unavailable` 复现报告

日期：2026-11-18  
复现环境：当前 Windows 工作树 `C:\Users\Helix\.codex\worktrees\afee\openscience-recheck`，使用独立目录 `.dev-isolate\runtime-session-authority\`。

## 结论

已在本机复现诊断包中的 **missing authority 诊断行为**，并定位到一个与两份日志相符的源码链路：Literature capability 在构建时用 `literature-session-*` 路由别名读取 Session runtime context；持久化层要求的身份是实际的 App Session ID。因此读取结果为 `missing`，记录 `Runtime Session authority unavailable`。`isEnabled()` 会捕获该异常并返回 `false`，所以任务可能继续执行，但每次 capability setup 都可能重复记录这个 warning。

这说明问题重点是 **routing alias 与 durable Session authority 的身份不匹配**。诊断包没有证明用户数据被删除，也没有证明 provider、ACP 连接或全局存储不可用。

## 两份诊断包的证据

| 项目                | 会话 1                           | 会话 2                           |
| ------------------- | -------------------------------- | -------------------------------- |
| sessionId           | `ses_e17e8a9b9ffekdwkGYxR5fWCdm` | `ses_e18010410ffe5unO3RvvequJWq` |
| revision            | 75                               | 160                              |
| app version         | 0.3.2                            | 0.3.2                            |
| Windows             | `10.0.26200`, x64                | `10.0.26200`, x64                |
| Node                | 22.23.4                          | 22.23.4                          |
| OpenCode            | 1.19.1                           | 1.19.1                           |
| projectId           | `cmwk1nzuk0000erjchwb40tka`      | `cmwk1nzuk0000erjchwb40tka`      |
| warning 次数        | 20                               | 20                               |
| 日志时间范围（UTC） | 2026-11-17 02:03:10–07:02:30     | 2026-11-17 02:03:10–07:02:30     |
| `authorityStatus`   | `missing`（20/20）               | `missing`（20/20）               |
| `metadataComplete`  | `true` 16 次，`false` 4 次       | `true` 16 次，`false` 4 次       |

每次事件的共同字段是：

```json
{
  "event": "Runtime Session authority unavailable",
  "diagnostics": {
    "projectId": "cmwk1nzuk0000erjchwb40tka",
    "sessionId": "literature-session-1794880990470-1",
    "operation": "runtime-context-read",
    "phase": "load-authority",
    "authorityStatus": "missing",
    "metadataComplete": true
  }
}
```

warning 前后反复出现以下顺序：ACP connection established → Session summaries loaded → `acp createSession: createMcpServers` → warning → Notebook RPC starting/listening → session capabilities built。两个包中的 hydration 多次达到 `status=ready`，不支持“全局持久化已经不可用”的解释。

## 源码链路

当前源码中有三段关键逻辑：

1. [`runtime-composition.ts`](../src/main/acp/runtime-composition.ts:511) 为 Literature 注入 `isEnabled(appSessionId, projectId)`。它调用 `readSessionRuntimeContext(projectId, appSessionId)`；如果找不到 authority，则捕获异常并返回 `false`。
2. [`session-capability-owner.ts`](../src/main/acp/session-capability-owner.ts:883) 构建 Literature capability 时把 `request.routingIds.literature` 传给 `isEnabled()`。
3. 同文件 [`session-capability-owner.ts`](../src/main/acp/session-capability-owner.ts:848) 为 Literature 生成的 routing ID 是 `literature-session-${timestamp}-${sequence}`。这只是 MCP/HTTP 路由别名，不是持久化 App Session ID（后者形如 `ses_e17...`）。

实际调用近似于：

```text
readSessionRuntimeContext(projectId, "literature-session-1794880990470-1")  # alias
readSessionRuntimeContext(projectId, "ses_e17e8a9b9ffekdwkGYxR5fWCdm")      # durable ID
```

这正好解释了诊断包中所有失败 sessionId 都以 `literature-session-` 开头。当前报告只定位问题，不修改业务代码。

## 本机验证

依赖安装、Prisma Client 生成和测试数据均使用 `.dev-isolate\runtime-session-authority\runtime\` 下的隔离目录；没有删除或修改生产 Session 文件。

已执行并通过：

| 检查                                                                 | 结果                    |
| -------------------------------------------------------------------- | ----------------------- |
| `src/main/session-persistence/missing-runtime-session-repro.test.ts` | 1 file，11 tests passed |
| `src/main/session-persistence/runtime-resume-recovery.test.ts`       | 1 file，21 tests passed |
| `coordinator.test.ts` 的 runtime-context 过滤用例                    | 5 passed，200 skipped   |
| `node packages/open-science/cli.mjs --help`                          | CLI 入口可加载          |

这些测试确认了：authority 缺失时会产生相同的事件名、`operation=runtime-context-read`、`phase=load-authority`、`authorityStatus=missing` 和诊断字段，并保持原始读取失败语义。

仓库中的 `missing-runtime-session-repro.test.ts` 明确把直接删除 Session 文件标记为 diagnostic control；它只能验证 observability 和错误处理，不能作为导出事件真实触发原因。因此不应把“手工删除 Session 文件”当作本问题的首选复现步骤。

## Windows 手工复现

下面步骤使用独立 profile，避免污染正式配置。请在 PowerShell 中从仓库根目录执行。

### 1. 准备隔离目录和变量

```powershell
$repo = 'C:\Users\Helix\.codex\worktrees\afee\openscience-recheck'
$task = Join-Path $repo '.dev-isolate\manual-runtime-authority'
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

# 清掉可能把 CLI 指向其他任务的继承值。
$env:OPEN_SCIENCE_STORAGE_ROOT = $null
Set-Location $repo
```

`OPEN_SCIENCE_E2E_STORAGE_ROOT` 优先级最高；同时显式设置其他路径，便于检查实际 `dataRoot` 是否仍在 `$runtime` 内。不要把 API key 写进脚本或报告。

### 2. 启动隔离服务并创建 Project

```powershell
node packages/open-science/cli.mjs start --no-open --json
$project = node packages/open-science/cli.mjs project create 'runtime-authority-repro' --json | ConvertFrom-Json
$projectId = $project.id
$projectId
```

在隔离 profile 中配置一个可用的 provider。若 provider 需要密钥，把密钥放在当前 PowerShell 进程已经存在的环境变量中，再使用 `--api-key-env` 引用变量名；不要在命令行历史中直接粘贴密钥。例如：

```powershell
node packages/open-science/cli.mjs provider add `
  --type official --vendor openai --model '<model-id>' --api-key-env OPENAI_API_KEY
```

如果本机已有可用的本地 provider，可复用其配置，但必须确认它属于隔离 profile。

### 3. 先监听日志，再触发 Literature capability

```powershell
$log = Get-ChildItem -Recurse $env:OPEN_SCIENCE_CONFIG_ROOT -Filter main.log |
  Select-Object -First 1
if (-not $log) { throw 'main.log not found under the isolated config root' }

Get-Content $log.FullName -Wait |
  Select-String 'Runtime Session authority unavailable|createSession: createMcpServers|session capabilities built'
```

保持该窗口运行，在另一个 PowerShell 窗口重新设置同一组隔离变量，并把上一步输出的 Project ID 写入 `$projectId` 后执行：

```powershell
Set-Location 'C:\Users\Helix\.codex\worktrees\afee\openscience-recheck'
$projectId = '<copy-project-id-from-step-2>'
node packages/open-science/cli.mjs run `
  --project $projectId `
  --skill literature-review `
  --prompt '使用 Literature 工具检索两篇关于 reproducible research 的论文，并给出 DOI。' `
  --wait --jsonl
```

`--skill literature-review` 的目的，是确保本次新 Session 进入 Literature capability setup；实际 provider 的工具权限和模型可用性可能影响任务是否完成，但不应影响 capability probe 是否发生。

### 4. 预期结果

在日志窗口中查找 JSON 行，预期看到：

```text
event=Runtime Session authority unavailable
operation=runtime-context-read
phase=load-authority
authorityStatus=missing
sessionId=literature-session-<timestamp>-<sequence>
```

重复提交同类任务或创建新 Session，通常会再次出现该 warning。若日志中的 `sessionId` 是 `ses_*` 而不是 `literature-session-*`，则没有复现本报告定位的 alias mismatch；应保留该日志以便继续排查其他调用方。

### 5. 对照和清理

可用不加载 `literature-review` 的普通任务作对照；该路径不应触发 Literature 的 `isEnabled` 探针。如果仍出现同一事件，应检查其他 capability 是否调用了 `readSessionRuntimeContext`。

完成后停止隔离服务，并删除整个隔离目录（确认路径是 `$task` 后再操作）：

```powershell
node packages/open-science/cli.mjs stop --force
Remove-Item -LiteralPath $task -Recurse -Force
```

不要对正式 `OPEN_SCIENCE_CONFIG_ROOT`、正式 `dataRoot` 或用户已有 Session 目录执行删除操作。

## 验证边界

- 已确认：两份诊断包的 warning 结构、频次和 alias 形态；本机持久化层的 missing-authority 诊断行为；源码中的 alias/authority 参数不匹配。
- 尚未确认：在本机使用真实 provider 完成一次完整 CLI 任务并由桌面应用产生相同 warning。当前只验证了 CLI 入口加载，没有启动完整 Electron/ACP/provider E2E。
- 诊断包的应用版本是 0.3.2，而当前工作树 `package.json` 版本是 1.2.2；因此源码链路与日志高度吻合，但不能把它表述为已在同一二进制版本上完成端到端证明。
