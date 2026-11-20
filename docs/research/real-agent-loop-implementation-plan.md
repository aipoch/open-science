# OpenScience 一期 Agent 闭环实施方案

以 [规格 #54](https://github.com/guch96/open-science/issues/54) 和它的子任务为准。起点是
`real-agent-loop.md`、`real-agent-loop-completed-20261120-evidence.json` 与
`recovery-interface-notes.md` 的历史调研。调研证明过核心 Notebook 与包迁移路径，不能作为本次构建的验收结果。
本轮代码核对基线：`b41cbc4be84e56c56f8c5e75581e50bcd181c7e2`。

一期保证外部 Agent、MCP 进程和 OpenScience 服务同机并共享可访问的文件系统。外部 Agent 从 README
英文提示语进入，安装或启动、发现本版本能力、检查准备状态，再按用户授权完成研究及交付。迁移时只把
`.science` 包带到另一个独立环境，先只读检查，用户同意后才 Fork、二次研究并再次导出。

## 基线核对与实施取舍

| 路径 | 可复用入口 | 本轮契约 |
| --- | --- | --- |
| 发现与准备 | SDK `doctor`、`bootstrap`、现有登录和配置流程 | CLI/MCP 共用能力定义、Schema、默认值、Handler 和错误；分别判断适配器已注册、服务是否支持、Agent/Notebook 是否就绪。服务未启动也可读本地指南。 |
| 资源选择与配置 | Task API 的 Project/Session Owner、Literature SDK | CLI/MCP 共用 Project、Session 和 Literature 能力。用返回的 ID 明确指定资源；可校验 Session 归属。配置使用扁平字段及现有版本检查。导入 Session 公开只读及来源字段，Owner 拒绝修改配置和恢复研究，无需变更持久格式。 |
| 研究提交与恢复 | `submitRun`、`getSubmission`、`waitForSubmission` 和服务端 TaskSubmissions | 显式 `projectId`；无 `sessionId` 新建。MCP 发送前持有并传入 `requestId`；CLI 自动生成时先落恢复记录。超时只结束观察，重连或重启后查原回执。 |
| Notebook | 现有 runtime、memory policy 和 execution intent | 外层 Run 状态独立于 dispatch、执行和人工停止。停止态只提供定位和用户继续入口，无自动重试或规避动作；检查 readiness 不创建执行域。 |
| Artifact | SDK 列举与内容响应、Artifact Owner | 显式区分 lineage、version 和 downloadId；MCP 与 CLI 共用无覆盖的本地交付。报告和结果表需对应当前研究；可信源端的大小与 SHA-256 匹配时才可验证交付。 |
| 包操作 | SDK export/import/fork 与既有 Package Owner | 复用 `.science` 格式。操作结果须与原操作关联；仅有相似快照时返回 `unconfirmed` 并停止自动重试。 |
| 敏感导出 | 服务端扫描与现有 Web/Desktop 风险审阅 | 确认须绑定具体导出及内容。Web RPC 的本地认证或默认 human caller 本身不能充当确认；自动调用方只观察原操作并获取已获准的交付。 |

验收分别检查 **readiness**（能否开始）、**execution**（实际执行了什么）和 **delivery**（实际交付了什么）。
文件核验通过不能证明计算正确，使用已知数据另行核对报告和结果表。以上三层状态、统一错误和敏感确认均为一期门槛。
既有 SDK 和持久数据兼容；旧 CLI/MCP 协议、远端文件交付、跨 Agent 模型迁移和订阅复用不在本期。

## 任务依赖与验证

1. [#55](https://github.com/guch96/open-science/issues/55) 建立共享注册、发现和基础 doctor。
   用真实 MCP stdio、CLI JSON 核对本地发现、Schema 与错误。
   当前入口为 CLI `tools list/describe/call --json` 和 MCP `list_capabilities`、`describe_capability`；
   指南通过 `openscience://agent/guide` 或 `get_agent_guide` 读取。目录默认离线，显式探测复用
   SDK 的 `/api/bootstrap`；旧服务未公告 doctor 时，可用只读 doctor 请求核对支持情况。
   `readiness.agent` 根据已有服务端检查投影，Notebook 状态目前保留 `unconfirmed`。
2. [#56–#61](https://github.com/guch96/open-science/issues/54) 接入资源、runtime/provider、Notebook readiness、持久研究、执行状态及 Artifact。
   在两个公开入口对齐语义；复用 Owner 测试验证重启、审批边界及源端文件校验。
   [#56](https://github.com/guch96/open-science/issues/56) 已用真实 MCP stdio 和 CLI JSON 调用同一个认证 HTTP
   夹具验证资源选择、配置版本检查、导入 Session 的只读拒绝和 Literature 默认值；
   TaskRunner 测试验证 Owner 的归属与只读限制。此处的导入 Session 使用测试记录，真实包迁移另行验收。
   [#60](https://github.com/guch96/open-science/issues/60) 用 Task Run 已记录的 prompt 标识，读取同一 Session
   中精确归属于该 prompt 的 Python/R Notebook Run。`execution` 独立于外层 Run；缺失派发证据时保留
   `unconfirmed`。人工停止时，Web 和 Agent 会提供原 refusal/branch 并指向连接同一服务的 Desktop Compute；
   继续命令不接受 Web 请求。用户完成后用原 Session 的
   `continuedFromRefusalId` 观察新意图，原 Run 保留原事实。此关联只存在于当前服务，不更改任务或 `.science`
   持久格式。自动化覆盖 CLI/MCP 查询与等待、Web 拒绝、错 branch 和旧回调。Electron Playwright 夹具验证
   Compute 按钮在恢复后创建新提示和审批，模型与真实数据验收另行记录。
   [#59](https://github.com/guch96/open-science/issues/59) 复用 TaskSubmissions 和 Run Owner；
   `start_run` 返回持久回执，`get_submission` / `wait_submission` 和 `get_run` / `wait_run`
   查询原任务。Agent 等待默认 10 秒、上限 30 秒，超时不取消。CLI `run` 自动分配 ID 时先将定位信息
   写入 `<profile>/agent-run-requests/`。协议测试覆盖丢失响应、重连和落盘失败；服务端测试覆盖同 ID
   并发、冲突和重启后的回执关联及中断状态。ACP 在 Run 建立前明确拒绝认证时，原失败回执
   持久保留 `provider_auth_required`，CLI/MCP 共用同一 profile 的用户设置入口。用户完成配置
   后可另行授权新请求，旧请求不会重放。待受理回执带原 `requestId` 的 `wait_submission`
   动作。续研默认使用原 Session 配置；需要换模型时先更新该 Session。
   实包验收发现两类等待没有正确显示：代码审阅被投影为 `running`，Ask 策略下首次绑定
   Python 则在 Notebook Run 创建前就等用户确认。现在从审批 Owner 匹配原 prompt 和分支，
   返回 `waiting_for_user`、`kernelDispatched: false`，并区分环境确认和代码审阅。用户处理后
   查询同一 Run。停止后的继续仍走 Desktop 的 Compute。Session 查询按活跃或最新的 prompt
   读取执行证据，不会用上一轮的 Notebook 派发证明当前轮次。
   模型触发回合或输出预算上限时，原 Run 报告失败原因并保留已有输出。
3. [#62–#65](https://github.com/guch96/open-science/issues/54) 接入包导出、导入、Fork、查询和敏感确认。
   以真实 `.science` 和原操作关联证据区分可验证交付、待确认和未知结果。
   [#62](https://github.com/guch96/open-science/issues/62) 导出由 Package Owner 在受理时记录 operation/correlation，
   并使用排他发布。Adapter 用 Owner 提供的大小和摘要核对本地文件；丢响应、快照被替换或文件不匹配时
   返回 `unconfirmed`。查询仅匹配当前快照，不提供研究提交级别的持久回执。真实 CLI JSON、MCP stdio 与 Package Owner 集成覆盖
   文件内容、目标冲突、回执关联、超时和敏感阻断。
   [#63](https://github.com/guch96/open-science/issues/63) 通过同一 Package Owner 的本地导入入口，
   从绝对路径导入 `.science`，将已校验包的摘要和新建只读 Session 关联到原操作。使用实际 Project/Session ID
   查阅 Session、历史回答和已发布 Artifact。测试只迁移包字节到另一个空数据目录，验证拒绝写入、
   丢失回执后查询原操作以及快照被覆盖时保留 `unconfirmed`；独立机器或容器验收留给 #67。
   [#64](https://github.com/guch96/open-science/issues/64) Fork 复用已有发布与权限检查。操作回执的顶层 ID
   指向本次直接来源，嵌套 `session` 指向可写副本；副本的 `forkOrigin` 保留包来源。只在用户同意后 Fork，
   另行授权的二次研究使用新 Session 和新 `requestId`。源 Session 有 Notebook 拒绝时仍须回到原处继续。
   [#65](https://github.com/guch96/open-science/issues/65) 检出敏感内容后在服务的私有暂存保留候选包，
   用原操作返回 `pending` 和 `requiresUser`。同 profile 的 Desktop 显示脱敏证据和目标位置；
   原生对话框默认取消，批准绑定候选归档大小与 SHA-256，发布时再次核对。拒绝或十分钟未确认即取消并清理；
   本地 Web 可显示此操作，但浏览器、CLI、MCP 的认证不能批准。Agent 通过原操作查询结果。
   Electron 验收使用真实服务、MCP、界面和 IPC，仅替换 OS 对话框选择；另有候选归档变更、过期、拒绝和伪造测试。
4. [#66–#67](https://github.com/guch96/open-science/issues/54) 以实际构建的 npm 包运行 README 两条验收路径。
   只给提示语时，准备好后等用户研究指令；给包时在无源数据库、Notebook 工作目录或凭据的独立环境先只读检查。
5. [#68](https://github.com/guch96/open-science/issues/68) 在目标版本发布后从 registry 复验。
   本次实现与本地打包不发布 npm，也不以旧 registry 版本替代当前构建。

记录实际构建、环境隔离方式、用户动作、Project/Session/request/Run/operation 关联、Notebook dispatch、
Artifact/包校验和已知统计值。分别注明协议夹具、真实服务、真实 Notebook、registry 的结果；证据不含密钥或原始凭据。
