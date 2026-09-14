# Open Science 一键脱敏诊断（Windows）

用于调查技能目录超限、Notebook/Bash/REPL 工具失败，以及会话恢复前后的故障。
这是一份离线采集工具，不是修复程序，也不能保证仅凭旧日志找到根因。

## 用户怎么操作

1. **先保留现场**：错误出现后，让当前任务停止运行，等待几秒让记录保存。先不要删除会话、卸载环境或重装应用。无需为了采集再次执行失败的代码。
2. 把 ZIP **全部解压**到普通本地文件夹，例如“下载”。不要直接在 ZIP 预览中运行，不要放在网络盘或指向其他目录的链接里。
3. 双击 **diagnose.cmd**。无需管理员权限，无需安装 Python、Node 或额外模块。
4. 完成后，同目录会新增 `diagnosis-日期时间-随机编号` 文件夹。用记事本打开其中的 **diagnosis.txt**，必要时也检查 **diagnosis.json**。
5. **只把这两个报告文件发给支持人员**。不要附带原始日志、会话 JSON、配置文件或整个 Open Science 数据目录。

黑色窗口最后会停留，按任意键关闭。脚本不会打开或关闭 Open Science，不会自动上传，也不会自动发送报告。每次运行创建新目录，不覆盖旧报告。

建议在错误刚发生时运行。日志分析窗口是“读取到的最后日志时间之前 7 天”，并非运行脚本时刻之前 7 天，所以旧日志仍可用于调查。报告统一使用 **UTC**，北京时间需加 8 小时。

## 自动读取什么

- 正式版日志：`%APPDATA%\Open Science\logs\main.log` 及至多两份轮转日志。
- 从近期工具失败中选出最多三个会话，只查找 `%USERPROFILE%\.open-science\sessions\<项目目录>\<会话ID>.json` 中的对应文件。**会话在配置目录，不在设置里的科研数据目录。** 不扫描整个磁盘，也不读取其他会话内容。
- 会话工具结果中的固定错误特征，例如 `Invalid notebook RPC token`。保留分支和 Frame 的匿名关联，区分所属 Frame 的当前分支与其他分支/祖先；不会把全部分支拼成当前对话。
- 只观察日志中的应用版本、框架、时间、计数、HTTP 状态、已知生命周期事件和工具名。模型名称、会话/工具/分支标识替换为本次报告内的编号。

脚本在内存中解析上述文件，因此会临时读到其中的内容；**报告只使用固定字段和固定错误分类重新生成，不复制原始输入对象**。

## 脱敏边界

报告**不包含**对话正文、用户问题、提示词、执行代码、命令参数、终端原文、工具返回原文、文件名/完整路径、用户名、原始会话 ID、模型名称、提供商地址、API Key、令牌、Cookie、附件或图片。

不读取凭据配置、环境变量全集、浏览器数据、进程命令行、Notebook 数据文件或数据库。未知错误只报告 `unknown` 或没有匹配特征，不保留错误原文。

报告仍会包含诊断必需的**事件时间、应用版本、工具类别、调用失败情况、技能数量和匿名关联**。请在发送前确认这些元数据适合共享。相同事件可能同时出现在日志和会话中，观察次数不等于唯一故障次数。

本次编号不跨报告稳定，原始编号映射只在内存中，不写入任何文件。脚本不会删除、修复或迁移应用数据；持久化新增内容仅是两个诊断报告。

## 如果报告提示没有日志或没有会话错误正文

`no-session-error-content-collected`、`missing`、`unreadable-or-unsafe`、`size-limit`、解析失败等表示证据不完整，**不表示应用正常**。报告也不保证能确定哪一步撤销了令牌。

- 日志已轮转、会话被删除、错误正文未保存、活动还未落盘，都会导致缺少证据。
- 超大文件、目录链接、网络路径、未知会话图版本会跳过并报告。单份日志最多 8 MiB，会话文件最多 16 MiB，总读取预算 64 MiB；每份日志最多处理末尾 25,000 行，最多输出 4,000 个事件、检查 100 个项目目录、每个会话末尾 10,000 条活动。
- 如果记录仍在写入，会标记 `changed-during-read`。停止当前任务并稍后再运行；脚本不会强制终止任务。
- PowerShell 被单位策略阻止时，请交给支持人员或 IT 检查。不要修改全局执行策略或关闭安全软件。CMD 的 `-ExecutionPolicy Bypass` **仅对这次 PowerShell 子进程生效**，不修改系统设置。

## 支持人员：分析指定文件

把一份 `main.log` **拖到 diagnose.cmd 上**，即可分析这份文件。这种“复制日志”模式**不会自动读取本机会话**，避免把支持人员自己的数据混入用户报告。

需要指定会话时，在解压目录打开 PowerShell，执行下例，并替换示例路径：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\diagnose.ps1 -LogPath 'C:\Support\main.log' -SessionPath 'C:\Support\affected-session.json'
```

会话文件必须是应用持久化的单个 Session JSON；Markdown/PDF 导出或会话 ZIP 不能直接代替。用户可在文件资源管理器地址栏输入 `%USERPROFILE%\.open-science\sessions`，根据支持人员给出的会话 ID 找到文件。**在用户电脑本地执行后，只回传生成的报告，不传原始 JSON。**

非默认配置根目录或开发版可明确指定，脚本不会自行猜测：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\diagnose.ps1 -LogPath 'C:\Support\logs' -ConfigRoot 'C:\Support\app-config' -SessionId 'support-provided-session-id'
```

`-OutputRoot` 可指定已存在的可写本地输出目录。所有输入路径都作为文件路径处理，不执行文件中的文字，不发起 RPC 请求，不重新运行任何 Notebook 或 Shell 命令。

## 如何解读

- `invalid-notebook-rpc-token`：指定诊断字段/工具输出中出现了该错误特征。优先检查同一匿名会话前后的连接恢复、后端替换、能力构建和退出事件；不能只凭相邻时间就认定因果关系。
- `skills-list-omitted`：目录可见性下降，不代表技能文件被删除。
- `skill-selection-failed` / `provider-http-error`：技能选择或模型上游请求失败，需要与本地 RPC 鉴权区分。
- `persisted-tool-result` 且没有特征：工具失败已经记录，但具体原因不在本工具识别范围内。请保留现场，等待有针对性的下一步检查。
- `exact-active-branch`：该活动的分支恰好等于所属 Frame 保存的 `activeBranchId`；不是对整个当前对话分支祖先关系的重建。

工具不会将“没有找到错误”输出为“健康”，不会自动接受旧令牌，也不会为了消除警告调整模型上下文预算。
