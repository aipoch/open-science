# 一期 CLI/MCP 任务交互与配置闭环

2026-11-21 两轮设计确认后的实施方案。代码核对基线为 `750ff8d2f213af4081a1f783cc1f1d415e986d9e`。
本文描述已确认、待实现的扩展；既有验收记录不能作为本扩展已经通过的证据。
本方案与 [Spec #54](https://github.com/guch96/open-science/issues/54) 同步维护。

## 目标与已确认决定

外部 Agent 通过 CLI 或 MCP 完成准备、研究、运行中交互和文件交付。用户可以让 Agent
代办常规操作，也可以在当前外部对话中回答问题或确认具体动作；Web/Desktop 保留为可选入口。
Provider 的 OAuth 授权仍按供应商要求由用户完成。

1. 常规权限、Plan、Notebook 环境绑定和代码审阅可按任务委托外部 Agent 处理。
2. Notebook 停止后的继续、敏感导出仍逐次询问用户，但允许外部宿主转交决定。
3. AskUser 有已有信息可依据时可以代答；缺少研究取舍、数据或偏好时转问用户，不猜测。
4. 覆盖主任务、子任务、断连后的待办查询和服务重启后的恢复或明确失效。
5. 委托可在提交时设置，也可对已经等待的任务追加或收回；仅作用于该任务及其子任务。
6. 一期补齐现有普通 API Provider 和模型的发现、配置、选择与验证，支持指定凭据引用或环境变量名。
7. Python/R 同时支持托管环境和用户已有环境；托管安装的进度、取消及明确请求的修复纳入一期。

本地 Agent、MCP 和服务共享文件系统、三层状态、durable 研究提交、只读导入和明确 Fork 的既有要求继续适用。
README 仍只提供简短设置提示；不把后续业务或每一项授权写进安装提示。

## 已核实的实现起点

| 领域          | 当前实现                                                               | 需要扩展的部分                                             |
| ------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| Agent runtime | `list_runtimes`、`select_runtime`、`prepare_runtime` 已共用安装逻辑    | 与配置进度、失败诊断和后续检查衔接                         |
| Provider      | MCP 配置限于免密钥 Kilo；原生 CLI 另有 OpenAI 初始配置                 | 公开已有 Settings Provider/模型管理能力，保持 CLI/MCP 一致 |
| Notebook 环境 | 可按指定语言安装托管 Python/R；Web 可打开 Runtimes                     | 环境发现、登记、选择、启用、绑定及安装取消/修复的公开入口  |
| Plan          | `get_plan`、`respond_plan` 已有版本/revision 校验和持久决定            | 纳入统一待办和任务委托，统一各响应入口的准入               |
| 普通权限      | Broker 已有请求、选项、授权范围及部分持久恢复                          | Task caller 目前不能回应；缺少按任务过滤的公开待办详情     |
| AskUser       | 已有答案校验，普通和 delegated durable 问题有各自处理逻辑              | 公开读取/回答/恢复，不能仅从事件流或聊天文本猜问题         |
| Notebook 审阅 | `auto` 可批准已验证默认托管环境的首次绑定；`full` 可批准绑定和代码审阅 | 为仍在等待的具体审批提供响应入口，不靠改成 `full` 解锁     |
| 停止后的继续  | 原 refusal/branch 校验和新执行意图仅在 Desktop 入口开放                | 增加接受外部用户接力的窄入口，保留 fresh checks 和原上下文 |
| 敏感导出      | 候选包私有暂存、扫描、大小/摘要绑定、Desktop 确认和发布复核已存在      | 公开脱敏审阅信息及对当前候选包的明确响应                   |

`permissionPrompts: none` 目前拒绝剩余交互，不是自动批准；`autoReviewEnabled` 是研究结束后的 reviewer，
不是运行权限开关。当前 `permissionProfile` 会进入 Session 配置，不能用它代替本次任务的委托设置。

## 授权与默认行为

### 执行权限和任务委托

保留已有 `ask / auto / full` 及既有明确授权。新增任务级交互处理模式，拟用扁平字段
`interactionMode: relay | delegate`，默认 `relay`。

- `relay`：既有授权和自动策略照常生效；剩余常规审批交给用户在当前外部对话决定。
- `delegate`：用户明确委托后，外部 Agent 可检查并回应本次任务的常规审批。该模式不自动批准所有请求，
  也不扩大文件、网络、环境或运行范围；Agent 对不属于任务授权范围的动作仍需询问。
- AskUser 可以依据已提供的信息回答；信息不足时返回待输入，不因选择 `delegate` 就自动选第一项。
- 新研究回合默认 `relay`，不继承上一回合的委托。系统明确关联的恢复或 continuation 属于原逻辑任务，
  可恢复其委托；普通新 prompt、Fork 或新 Session 不因此继承。
- 已存在的 Session 权限策略保持其原语义。设置任务委托不隐式改动 Session、Project 或全局默认值。

运行中修改模式必须带原任务标识与当前 revision。修改对尚未决定的主任务及子任务待办生效；
在最终处理响应时再次读取有效模式，拒绝已经撤回的委托。已经启动的动作不因收回委托而被隐式取消。
对仍在等待的 Notebook 审阅，走原审批响应，不重新提交研究，也不假定切换权限 profile 会释放旧请求。

由委托产生的普通权限响应默认只批准当前请求，不隐式记忆为 Session/Project/global grant。
需要后续审批时继续按任务委托处理，避免额外建设一套权限授予系统。

### 外部用户接力的信任模型

本地、经过认证的外部 Task 调用方是用户选择的受托宿主，可以提交自己受托作出的决定，或转交用户的决定。
两种来源必须区分记录。Task caller 保持 automation 身份，不伪装成 Electron/Web human caller。

服务端验证调用方准入、有效任务委托、待办归属、当前版本及动作内容；它不能独立证明用户确实在 WorkBuddy
里按过某个按钮。用户已接受这个信任边界。因此来源字段是宿主的声明，不是人类在场证明，也不能代替服务端准入。
内部研究 Agent 的 `agent-session`、Notebook 工具、包内容或模型输出不能自行创建外部委托。

Notebook 停止后的继续和敏感导出要求逐项 `user_relay`，不由 `delegate`、`full` 或无人值守参数预先批准。
敏感审阅返回脱敏风险、文件范围、目标及候选摘要，不将密钥原文交给外部 Agent。

### 无人值守与等待

CLI/MCP 不要求宿主支持 MCP elicitation。基础路径是普通工具查询、Agent 对话询问、工具提交答案。
CLI 无 TTY 或用户暂时不在线时，返回可行动的待输入信息和恢复标识；不永久占用一次工具调用，也不擅自拒绝答案。
现有显式 `permissionPrompts: none` 保留“拒绝未解决交互”的含义，不能被作为闭环的默认配置。
显式 `delegate` 或 `plan-first` 与 `permissionPrompts: none` 的矛盾组合明确报错。

## CLI/MCP 公开接口

CLI 与 MCP 从同一 Agent Adapter 定义生成 Schema、默认值、描述、错误和 Handler。
先复用已有 SDK/Owner；新公开入口按业务类型限定，不提供任意内部 RPC 调用。
下列名称为实施时的接口起点，具体名称可随现有能力归并，语义及验收要求不变。

| 能力                        | 主要输入                                                                                       | 行为                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `start_run`                 | 现有字段及 `interactionMode`                                                                   | 记录发送前已有的 `requestId`、采用的权限策略和任务委托                |
| `set_run_interaction_mode`  | `runId`、`expectedRevision`、`interactionMode`                                                 | 对原逻辑任务追加或收回委托，返回新的有效设置                          |
| `list_interactions`         | `runId`，或明确的 Project/Session 查询范围                                                     | 返回该任务及子任务的待办；Session 查询可发现重启后留下的交互          |
| `get_interaction`           | `interactionId` 加原 Run 或明确 Project/Session 范围                                           | 返回当前规范内容、revision、可执行选项、状态和恢复引用                |
| `respond_permission`        | `interactionId`、`expectedRevision`、`optionId`、决定来源                                      | 普通权限、Notebook 绑定和代码审阅复用原 Broker；仅接受实际提供的选项  |
| `answer_question`           | `interactionId`、`expectedRevision`、`expectedBranchId`、`source`、`action` 和结构化 `answers` | 复用题目类型、必填、选项和多选校验；路由普通或 delegated 问题处理逻辑 |
| `get_plan` / `respond_plan` | Session、Plan 版本、revision、分支、来源、决定或反馈                                           | 复用 Plan 服务；批准、拒绝和请求修改都针对已读的版本                  |
| `continue_notebook`         | 原 Run/branch/refusal、`user_relay`、`prompt`、`requestId`                                     | 创建可追踪的新继续意图，复查环境与内存，不重放已停止的旧回调          |
| `respond_export_review`     | 原 `operationId`、候选摘要/目标、明确的用户决定                                                | 批准或拒绝当前候选包；发布前再次检查内容                              |

查询范围、参数互斥和必填条件在 Schema 中明确，不默认选择最近 Session。每个待办都包含足以定位其
Project、Session、Run、分支、prompt 或 delegated attempt 的服务端引用；包审批可以独立关联 operation。
公开对象只展示调用方有权处理且归属于该范围的内容，不直接暴露整个 ACP snapshot。

统一待办投影包括：

- 稳定身份、种类、当前 revision、状态，以及关联的任务或操作。
- 需要阅读的内容和合法答案/动作；Notebook 审阅包括作出判断所需的语言、环境或代码风险信息。
- 当前可由谁处理，以及对应 capability 和参数提示。
- 是否可恢复、是否已失效、已知截止时间及决定后的继续标识。

`get_run` / `wait_run` 的 attention 覆盖普通权限、AskUser、Plan、Notebook 审阅/停止及 delegated 待办。
关联敏感导出的等待由 package operation 同样返回可处理的 review 引用。事件用于通知，查询才用于重新同步事实。
继续分别报告 readiness、execution 和 delivery；等待审批时不能声称 Notebook 已派发或报告已生成。

所有公开响应入口都执行同一准入规则。原 Plan 命令或其他别名不能绕过新契约。

#70 的 Plan 响应只接受以同 profile 的本机 Bearer 验证的 Task 调用。浏览器原有的人类响应入口独立保留。
`get_run` 的 `attention.kind: interactions` 只包含待办引用，具体 Plan 内容和决定回执从 `get_interaction`
读取。`continuation.id` 沿用 Plan Owner 的持久交付身份；它标识原对话的接续，不改写或重跑原 Task Run。
Task 接续在调用 Provider 前持久化新的 `requestId` 和 Run，并在 Plan 决定上返回其查询标识与
`taskRunStatus: tracked`。新 Run 的 `continuedFromRunId` 指向原 Run。`pending` 或 `unconfirmed`
时重新查询同一决定；`accepted` 只证明 Plan 交付，Notebook 执行和文件交付各自核验。旧 Run 经重启中断时仍报告中断。
回执随本地 Plan 记录保留，归档导出和 Fork 不带本机响应记录。

#71 在同一本机连接上公布 `task-permissions` 和 `task-delegation`。默认的 `relay` 可通过
`set_run_interaction_mode` 按 `interactionPolicy.revision` 修改；受托的普通权限和 Plan 响应都带
`expectedModeRevision`，由原 Owner 在最终提交时再次校验。续跑通过 `continuedFromRunId`
读取原任务的策略，后续撤回同时约束续跑中的待办。普通新研究仍默认 `relay`。
`respond_permission` 只接受原分支、原请求提供的一次性选项。活跃等待由原 Broker 释放；仍有效的
持久等待重用原 Permission Wait Owner，从原请求派生新的 continuation 提交 ID。用 `get_interaction`
查询决定与接续回执；旧 Run 的中断原因仍保留。决定和查询记录都保存在本机 Task Run 日志，不写入 `.science`。

#72 的主任务 AskUser 用 `answer_question` 对已读的唯一题目提交 `accept` 或 `decline`。每个答案包含 `fieldId` 和字面 `value`，允许跳过的字段由 `skipFieldIds` 明示，可提交 `{ fieldId, status: "skipped" }`。`known_context` 只用于用户已提供的信息；跳过或拒绝需要 `user_relay`。提交不会授予权限。

原 Run 尚未停稳时，待办提示重新查询；普通 ACP 表单直接解除原 Provider 等待。Provider 已结束的持久问题原子保存规范答案，再由既有 Question Owner 接续。接续先登记持久 `requestId` 和新 Run，随后才允许发送。用原交互查询该回执，并用 `get_run` 检查新 Run 的真实执行。若重启时答案已记录、接续仍无登记，查询返回 `unconfirmed`；重复提交已记录的回答不会再次发送。原 Run 若因重启中断，仍保持中断。只有活跃进程能回答的表单在重启后失效。本机回答回执不进入 `.science` 或其 Fork。

#75 在本机 Bearer 连接上公布 `notebook-continuation` 能力。原 Run 的待办返回当前拒绝和分支；
外部宿主得到本次明确同意后，以保留的 `requestId` 调用 `continue_notebook`。Notebook Owner 核对
当前拒绝、归属分支和原 prompt，并创建新一轮执行意图。旧上下文及其工具调用仍被拒绝；新一轮按现有规则
重新检查运行时和内存。`get_submission` 可跨服务重启恢复该提交回执；其 `runId` 指向新 Run，
`notebookContinuation.runId` 指向原 Run。拒绝本身不持久化，未处理的旧拒绝重启后报告失效，不能重放。

## 配置与环境准备

### Provider 和 Agent

公开现有运行时及 Provider 类型、模型选择与兼容关系，复用 Settings 的配置、验证和激活逻辑。
至少覆盖当前应用已支持的普通 API Provider 配置、已有 Provider 的使用，以及用户选择的非 Codex Agent。
不新建模型目录或凭据库，也不自动复用外部 Agent 的订阅。

密钥只能通过用户明确指定的已有凭据引用，或 CLI/MCP 适配器进程可见的指定环境变量读取。
密钥值不进入工具参数、stdout、错误或验收记录。MCP 进程看不到指定环境变量时，明确返回配置缺失和准备方式；
不扫描其他进程、浏览器或系统应用的凭据。验证成功和选择激活分别返回真实结果，不能把“保存了配置”当作可运行。

OAuth 可提供启动、状态检查和取消入口；用户在 Provider 要求的位置完成同意。支持范围以本版能力发现为准。
Web 是备用配置入口，不能用于补齐声明为支持的普通 API Provider 主流程。

### Notebook 环境

通用检查同时报告 Python/R，不选语言、不安装。研究需要已知语言时先检查该语言，复用现有环境管理逻辑完成：

1. 列举可用解释器及其来源、就绪和启用状态；用户指定的解释器可以登记并校验。
2. 准备所需的托管语言环境，观察进度、取消，或明确请求修复指定托管环境。
3. 明确选中并启用所需环境，在目标研究上下文中完成绑定；返回真实采用的环境身份。
4. 需要更改已有环境的依赖时，沿用其安装授权和任务委托，不将选择解释器视为包修改授权。
5. 准备后复查同一 profile 和语言；安装成功、环境可用、绑定获准、Notebook 已执行分别说明。

绑定选择通过结构化参数到既有 Owner，不靠在 prompt 中拼接解释器路径。
缺失的 Python 不阻止只需 R 的研究，反之亦然。安装/修复等待有界，超时查询原进度，不启动重复安装。
系统依赖、隔离和内存失败继续独立诊断；需要系统权限的操作给出准确的用户或部署处理动作。

托管环境操作（#78）：调用方在发送准备或修复前保留 `operationId`，通过同语言与 ID 查询进度或请求取消。
默认等待 1 秒，可用 `timeoutMs: 0` 直接返回，等待超时只结束观察。回执只保留在当前服务进程；
重启或历史回执移除后返回 `unconfirmed`，应先复查语言环境，不应自动重试。修复仍由现有 Owner
验证当前默认托管目标，进入重建阶段后必须完成。安装回执不等于 Notebook 已获准执行。

## 响应去重与恢复

复用现有 Permission Wait、Elicitation、Plan、delegation、Notebook intent 和 Package Owner 保存事实，
不建立第二套通用审批状态机。需要的持久字段限于任务委托、交互身份/版本、决定来源与原处理逻辑缺少的恢复关联。
不改变 `.science` 格式来携带本机授权、凭据或待审批权限。

| 情况                                  | 处理要求                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 同一待办重复响应                      | 已记录的同一决定返回原结果，不重复唤醒；冲突决定、过期 revision 和已替换选项明确拒绝                   |
| 响应丢失或 Agent 断连                 | 用原交互/操作身份查询结果；不能因超时就换 Session 或重提研究                                           |
| 服务仍在运行，交互已处理              | 跟踪原 Run；若原 Owner 创建 continuation，则返回明确关联并跟踪它                                       |
| 服务重启，原 Run 中断                 | 保留原 Run 的失败/中断事实；从 Session 中重建可恢复待办，新的续跑有新的 durable `requestId`/Run 及来源 |
| 交互不具备恢复证据                    | 返回 expired/unconfirmed 和原因；不能把不存在的 live Promise 当成继续成功                              |
| 子任务已结束、换分支或 attempt 已替换 | 拒绝旧答案/授权；不能把旧决定用于新的子任务                                                            |
| Notebook 停止或敏感导出确认过期       | 原确认失效；重新取得当前可审阅状态和用户决定，不自动重放                                               |

Notebook refusal 和待确认敏感包目前含内存状态；本期不承诺透明保存计算进程或敏感候选包。
实现必须明确哪些待办可重建，哪些在重启后终止，以及下一步如何恢复业务。
原研究提交的 durable 去重要求不因交互扩展降低；包操作仍不承诺与研究提交相同的持久 exactly-once。

## 实施顺序

1. **待办发现与等待。** 统一过滤、详情、合法动作和 attention；先让每一种阻塞都可被外部 Agent 看见。
2. **任务委托和常规响应。** 增加任务模式及运行中修改，接入权限、AskUser、Plan 和 Notebook 审阅，覆盖主任务/子任务。
3. **逐项用户接力。** 接入停止后的继续与敏感导出，替换当前 Desktop 专属限制；保留内容、分支、时效和实时条件检查。
4. **配置完整性。** 补齐普通 API Provider、模型与已有环境管理；安装/修复复用既有进度和取消路径。
5. **故障与恢复。** 验证丢响应、重复决定、撤回竞态、重连、重启、旧分支和旧子任务；必要持久化补充在所属 Owner 内完成。
6. **真实闭环。** 更新英文 Agent 指南和能力描述，构建实际 npm 包，分别用 CLI、WorkBuddy 和独立迁移环境验收。

这些是同一期的增量交付顺序，前几步完成不代表一期验收通过。既有远程 PR 保持 Draft；发布后 registry 验收独立记录。

## 一期验收条件

测试通过公共边界：真实 CLI JSON / MCP stdio → 共享 Adapter → SDK/服务端业务处理 → 状态、调用次数和落盘文件。
使用现有 Owner 故障注入覆盖重启和竞态；真实 Agent 验收不额外提供工具调用顺序。

| 场景                                  | 必须观察到的结果                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 短 README 提示，有/无 `.science` 附件 | 只做发现与设置检查；没有研究请求就不提交，没有导入/Fork 请求就不执行                                                |
| 缺 Agent、Provider 或语言环境         | 可通过 CLI/MCP 完成已授权的安装/普通 API 配置；无默认 Codex 或默认安装 Python                                       |
| 托管与已有 Python/R                   | 只准备/选中请求的环境；现有环境可登记、检查、启用和绑定；无关语言及环境不受影响                                     |
| 安装失败、取消、修复、观察超时        | 状态和原因真实、可继续查询；无重复安装或虚假成功                                                                    |
| `relay` 与 `delegate`                 | 剩余审批按有效模式处理；任务委托不隐式改变长期 profile/grant                                                        |
| 已挂起时追加委托，随后撤回            | 原请求可处理；撤回后的旧委托不能放行尚未提交的决定；没有重提研究                                                    |
| 普通权限、Plan、Notebook 审阅         | 从 CLI/MCP 看完整待办、选择合法动作并继续；旧版本不能批准；全程不强制打开 Web                                       |
| AskUser 主任务与子任务                | 必填/多选/自定义答案可提交；未知信息转问当前用户；没有答案时清楚等待                                                |
| Notebook 停止                         | 用户在外部对话明确继续后才处理；复查仍失败时保留真实原因；原意图不会被自动重放                                      |
| 敏感导出                              | 用户看到脱敏风险和目标；确认绑定具体包；改变内容、错操作或过期确认不能发布                                          |
| 决定丢响应、重复、并发                | 查询可确认已记录结果，不重复执行；冲突、旧 revision、旧分支或旧 attempt 拒绝                                        |
| 服务重启                              | 原 Run 中断事实保留；可恢复待办能找到；不能恢复的有明确状态和下一步，新续跑可追踪                                   |
| 宿主不支持 MCP elicitation            | 普通工具查询/回答足以闭环，不要求宿主实现特定对话 UI                                                                |
| WorkBuddy 真实研究                    | 常规配置/审批/AskUser/Plan 经 MCP 完成；真人决定在外部对话处理；产生真实 Notebook dispatch、报告、CSV 和 `.science` |
| 独立环境续研                          | 仅迁移包，明确导入后只读检查，获准 Fork 后二次研究与交付；MCP 业务流程不借 CLI 补漏                                 |

真实验收分别标记协议夹具、实际服务、真实模型/Notebook、实际安装包和 registry 来源。
此前 WorkBuddy 的安装/导入证据保留；停在人工审阅的 Run 不算新交互闭环完成。

## 对原 Spec 的替换

Spec #54 的配置接力、Notebook 人工继续、敏感导出条款及对应故事/验收需要同步修订：

- 其他 Provider 和已有环境管理不再一律交给 Web。
- 常规待办按任务委托或外部用户接力处理；旧的全量 human caller 拒绝不能直接套用到新接口。
- Notebook 继续、敏感导出允许明确的外部用户接力；旧的 Desktop 专属限制由新窄接口替代。
- “拒绝 Agent 伪造 human 身份”和“拒绝不匹配、失效或永久 force 授权”继续适用。
  新受托宿主的明确响应是被设计支持的入口，不应仍在文档中描述为禁止的行为。
- 扩展只针对一期任务和配置闭环，不开放私有 RPC 全集，不承诺跨 Agent 订阅复用、远端文件迁移或完整计算进程恢复。

## 代码入口

- 共享能力与参数：`packages/open-science/agent-adapter.mjs`、`agent-capabilities.mjs`、`agent-package-capabilities.mjs`。
- Task 授权与接口：`src/main/caller-context.ts`、`src/main/web-service/task-api.ts`、`src/main/tasks/task-runner.ts`。
- 权限/问题：`src/main/acp/permission-broker.ts`、`permission-wait-owner.ts`、`elicitation-owner.ts`、
  `durable-continuation-context-owner.ts`、`src/main/delegation/delegated-user-question-owner.ts`。
- Plan：`src/main/session-plan/plan-service.ts` 及既有 delivery 处理逻辑。
- Notebook：`src/main/composition/notebook-approvals.ts`、`src/main/notebook/runtime-service.ts`、
  `execution-intent.ts`、`runtime-application-commands.ts`、`environment-application-commands.ts`。
- Provider：`src/main/settings/service.ts`、`provider-accounts.ts` 及已有 Settings 配置/验证处理逻辑。
- 导出：`src/main/session-package/desktop.ts`、`service.ts` 及原 operation、候选包校验和发布路径。
