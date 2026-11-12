# PR #20 Windows validation handoff

将下面内容交给真实 Windows 机器上的 agent。交接时同时提供 PR 最新提交 SHA；测试报告必须记录
实际 SHA。此文档描述待执行的验收，本身不代表 Windows 已通过。

## 可直接使用的提示词

你正在真实 Windows 上验证 `guch96/open-science` 的 PR #20：
`fix(session-persistence): decouple startup hydration from active saves`。
分支为 `codex/session-hydration-integration`。请完成验证并生成 Markdown 报告，不修改业务代码，
不合并 PR。先阅读仓库 `AGENTS.md`、`docs/session-persistence-retention.md` 和相关测试。

### 1. 确认版本与隔离环境

- 保留现有工作区修改；需要隔离时建立独立 worktree，禁止强制重置、清空用户目录或升级锁定依赖。
- 确认 origin 指向 `guch96/open-science`，fetch 后检出交接指定的提交，并记录 `git rev-parse HEAD`。
  如果指定提交不在 PR 最新分支上，先报告版本差异，避免验证旧代码。
- 使用与仓库 Windows CI 一致的 Node 24 和锁文件安装流程（参见
  `.github/workflows/windows-full-test.yml`、`.github/workflows/windows-e2e-regression.yml`）。
  已安装环境先核对依赖，不要无条件重装。缺失原生组件按仓库流程准备，不绕过签名或安装检查。
- 测试使用独立配置、数据和 Electron profile。真实用户数据只在授权副本上验证；保留原件。
  优先复用 `e2e/fixtures/electron-app.ts` 的隔离方式，区分 configRoot、dataRoot 与 userData。
- 记录 Windows 版本、CPU/内存、磁盘类型、Node/npm 版本、依赖准备结果，以及杀毒软件是否启用。
  保持原有杀毒设置，记录其影响。

### 2. 运行自动化检查

在仓库根目录使用 PowerShell，逐项执行并记录退出码和日志。先完成类型检查与 lint：

```powershell
npm run typecheck
npm run lint
```

运行以下完整测试文件，不使用名称过滤来隐藏失败：

```powershell
$persistenceTests = @(
  'src/main/session-persistence/startup-hydration.integration.test.ts',
  'src/main/session-persistence/recovery-commit.integration.test.ts',
  'src/main/session-persistence/coordinator.test.ts',
  'src/main/session-persistence/coordinator-contract.test.ts',
  'src/main/session-persistence/coordinator.architecture.test.ts',
  'src/main/session-persistence/operation-scheduler.test.ts',
  'src/main/session-persistence/repository.test.ts',
  'src/main/session-persistence/projection.test.ts',
  'src/main/session-persistence/runtime-session-owner.test.ts',
  'src/main/session-persistence/terminal-commit-scheduler.test.ts',
  'src/main/session-persistence/terminal-commit-recovery.test.ts',
  'src/main/session-persistence/deletion-integration.test.ts',
  'src/main/application-command-wiring.test.ts'
)
npx vitest run @persistenceTests --maxWorkers=2 --reporter=verbose
```

准备当前提交的 Electron 构建后执行已有桌面用例：

```powershell
npm run build:e2e
npx playwright test e2e/session-storage-recovery.spec.ts e2e/session-residency-capacity.spec.ts --workers=1 --reporter=line
```

不能把 `process.platform = win32` 模拟或 Node 测试通过等同于真实 Electron 验收。依赖真实模型凭据
的用例如果跳过，单独记录；不要输出凭据。依赖或原生构建失败应报告阻塞原因和实际执行范围。

### 3. 多会话、升级与磁盘竞争验收

在隔离数据副本中准备至少 170 个会话，包含少量较大历史 JSON、一个当前会话、一个中断会话。
可复用现有 fixtures/API 编写一次性验证脚本或临时测试，附上脚本和执行命令；不要更改业务逻辑、
放宽断言或延长保存预算使结果通过。

分别验证：

1. **已有 v8 投影的正常启动**：前台列表和当前会话先可用；启动 hydration 不读取全部历史正文。
   后台 sweep 随后逐个读取历史是预期行为，需要区分前台 hydration 与后台阶段。
2. **旧 v7／缺失投影的首次升级**：按照现有 projection 测试构造旧派生状态，保留 JSON 权威数据。
   此路径允许完整重建，必须单独记录耗时、UI 可用时刻、保存等待和警告，不能用正常启动结果替代。
3. **后台慢 I/O**：在隔离测试中延迟历史读取、第二次读取或索引超过 2.6 秒，确认延迟实际生效；
   真实前台终态保存应在测试要求的 1.5 秒内确认，并能从新 repository／重启后读取。
   对真实桌面额外记录实际耗时，不把单元测试门限描述成所有机器的性能保证。
4. **同会话版本竞争**：后台读取 N 后，前台提交 N+1；后台冲突、退避后重试成功，新消息和元数据
   保留。其他健康历史会话继续恢复，不出现当前会话的存储错误。
5. **历史坏 JSON／超限／索引失败**：分别验证最多三次尝试、250 ms／1 s 退避；健康会话可恢复，
   当前会话能保存，未确认的历史归属不会被当作不存在而删除。
6. **缓存释放与重启完整性**：超过 32 会话／估算 32 MiB、空闲 30 秒后，当前会话继续工作，历史
   再次打开可完整加载；退出重启后消息仍在。缓存限额不是整个进程的 RSS 上限，需记录实际内存。

### 4. 核对新增诊断

- `deferred Session recovery failed` 应包含 projectId/sessionId、phase、attempt、retry、
  retryDelayMs、exhausted；不得包含会话正文、标题或工作目录。
- 耗尽后 sweep 汇总应为 `status: partial`、`cleanupEligible: false`，
  `cleanupSkippedReason: retries-exhausted`。这是本轮跳过完整性清理，下次启动重试；同一进程不会
  自动再开完整 sweep。已有健康恢复和前台保存应继续正常。
- `status: complete` 表示 sweep 完成。清理仍可能因目录或 revision 变化跳过，此时应有
  `deferred Session catalog cleanup skipped` 及 reason；不要把 eligibility 当作已完成删除。
- 保存原始日志的时间范围与所在路径，报告中只摘录脱敏字段。

### 5. 交付结果

输出一份 Markdown 报告，包含：

- 提交 SHA、机器/依赖信息、每条命令与退出码、通过/失败/跳过数量。
- 每个验收场景的“通过／失败／阻塞／未执行”，以及证据路径、耗时、消息持久性结果。
- 失败对应的最小复现、错误堆栈和日志时间点；区分产品问题、测试问题、环境阻塞。
  只有在相同 Windows 环境与依赖下对基线复测，才能称为基线失败。若增加基线 checkout，使用隔离
  worktree，不切换或覆盖正在使用的测试数据。
- 汇总仍未覆盖的风险，并明确建议是否具备合并条件。存在失败或未执行项时，不输出“全部验证通过”。

产物包括报告、命令输出、必要的 Playwright trace/截图和复现脚本。真实数据与凭据不得提交到 Git。
