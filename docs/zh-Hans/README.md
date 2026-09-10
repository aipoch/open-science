<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  面向可复现科学研究的开源、本地优先、模型无关 AI 研究工作台。
</p>

<p align="center">
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="下载" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="版本" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://huggingface.co/datasets/phylobio/BiomniBench-DA">
    <img alt="BiomniBench-DA Public 50 第一名" src="https://img.shields.io/badge/%F0%9F%8F%86%20%231-BiomniBench--DA%20Public%2050-f59f00?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="支持平台 macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Apache 2.0 许可证" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="网站 aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
  <a href="https://discord.gg/zxQAYjReRv">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=flat&logo=discord&logoColor=white">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="English README" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="俄语 README" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="德语 README" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="西班牙语 README" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> 本文档是英文 `README.md` 的翻译。如内容存在差异，请以[英文原文](../../README.md)为准。

AIPOCH Open-Science 是由 [AIPOCH](https://aipoch.com/open-science) 为科学家和研究人员开发的开源、本地优先且模型无关的 AI 研究工作台。它通过科学 AI 智能体、Python 和 R 执行、科学数据连接器以及对 macOS、Windows 和 Linux 的跨平台支持，实现可复现、可检查的研究。在同一个工作区中，新建项目，用自然语言描述研究目标，然后让智能体读取文件、搜索网页、运行代码、查询科学数据源，并生成带有可追溯来源的报告、表格和图表。

AIPOCH Open-Science 支持机器学习、统计学、生命科学、化学、材料科学、物理学和环境科学等领域的计算密集型与数据密集型研究。它覆盖从文献综述、假设构建到代码执行、数据分析、仿真、可视化以及生成可追溯研究成果的完整研究流程。

> 💡 **[AIPOCH Open-Science v0.27.0 已发布](https://github.com/aipoch/open-science/releases/latest)** _（最后更新于 2026 年 9 月）_。AIPOCH Open-Science v0.27.0 扩展了文献工作区，并让长时间的工作可以在后台运行：一次导入大量 PDF，带逐文件进度与重试；在后台运行 Notebook 与 shell 作业并自动交付结果；并依靠一轮覆盖跨客户端同步、数据位置迁移与导入完整性的广泛文献稳定性加固。核心应用技能保持始终启用，无头 CLI 与 Task SDK 新增连接器管理，mermaid 图表渲染更流畅，无头 Linux 部署也获得了显式的凭据文件存储。详情请查看[最新发行说明](https://github.com/aipoch/open-science/releases/latest)。

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science 首屏横幅：Science, Open to All——开源、模型无关、可自托管的科学 AI 研究工作台" src="../images/readme/open-science-banner.png" />
</p>

## 目录

- [快速开始](#-快速开始)
- [产品导览](#产品导览)
- [基准测试表现](#基准测试表现)
- [为什么选择 AIPOCH Open-Science](#为什么选择-aipoch-open-science)
- [核心能力](#核心能力)
- [模型服务商](#模型服务商)
- [数据、权限与信任](#数据权限与信任)
- [项目状态](#项目状态)
- [开发与打包](#开发与打包)
- [常见问题](#常见问题)
- [参与项目](#参与项目)
- [许可证](#许可证)

## 🚀 快速开始

通过三个步骤运行 AIPOCH Open-Science：下载适合你平台的安装程序、完成首次启动向导，然后新建研究项目。

### 1. 下载应用

打开[最新版本](https://github.com/aipoch/open-science/releases/latest)，展开 **Assets**，并选择适合你计算机的安装程序：

| 你的计算机                          | 选择                                      |
| ----------------------------------- | ----------------------------------------- |
| macOS — Apple 芯片（M1 或更新型号） | 适用于 Apple Silicon / ARM64 的 macOS DMG |
| macOS — Intel                       | 适用于 Intel / x64 的 macOS DMG           |
| Windows x64                         | Windows x64 安装程序                      |
| Linux x64                           | Linux x64 AppImage 或 Debian 软件包       |

查看发行页面公布的文件和验证信息。如果需要在安装前验证软件包，请参阅[验证下载](../../SECURITY.md#verifying-your-download)。

> 如果 macOS 或 Windows 显示“无法识别的开发者”或“未知发布者”警告，请先确认软件包来自官方 Releases 页面，再继续操作。

macOS 用户也可以通过 [Homebrew](https://brew.sh) 安装：

```bash
brew install --cask open-science
```

Homebrew 会自动选择 Apple Silicon 或 Intel 安装包。

### 2. 完成首次设置

首次启动包含五个引导步骤：

1. **环境**检查兼容性、应用存储、安全凭据存储和网络访问。
2. **数据位置**选择大型产物、Notebook、上传内容和环境的存储位置。
3. **智能体运行时**选择并准备 Claude Code、OpenCode 或 Codex。安装由应用管理的运行时不需要 Node.js、npm 或管理员密码。
4. **模型服务商**连接并测试你要使用的模型。可以选择内置服务商、自定义网关，或现有 Claude、Codex 订阅登录。
5. **Notebook 运行时**可选择准备由应用管理的 Python 和 R 环境，或启用检测到及手动注册的两种语言解释器。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="AIPOCH Open-Science 自动执行首次启动环境检查"></td>
    <td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="AIPOCH Open-Science 首次启动模型服务商配置"></td>
  </tr>
  <tr>
    <td align="center"><sub>主机兼容性、存储和网络检查</sub></td>
    <td align="center"><sub>服务商、API Key、端点和模型验证</sub></td>
  </tr>
</table>

Notebook 执行是可选功能。所有必需的环境和智能体运行时检查通过后，`Continue` 才会可用；模型连接必须通过，设置才能完成。Notebook 和数据位置设置可以保留默认值，之后再到设置中更改。

### 3. 开始研究项目

1. 单击 **New project**，为项目提供稳定的研究名称和可选说明。
2. 打开会话，描述目标、输入数据、限制条件、期望输出以及结果的检查方法。
3. 附加源文件，选择已验证的模型，并选择批准模式。
4. 发送任务。检查智能体的工具活动，批准敏感操作，并在预览面板中打开生成的产物。
5. 如果要探索不同方向，编辑较早的用户消息并在新分支上重新发送；使用消息修订控件返回任一路径。
6. 打开产物的 **Provenance** 视图，检查其版本和所选结果背后的可用证据。
7. 在之后的会话中继续工作。使用 `@` 引用现有项目文件，使用 `/` 明确选择已启用的技能。

> 本 README 中的截图用于说明工作流程。标签、目录和其他界面细节可能与所安装版本不同。

## 产品导览

### 从研究请求到可追溯结果

以一个具有代表性的生物信息学任务为例：复现已发表的差异表达分析，将重新生成的结果与论文比较，并交付审阅所需的报告、表格和图像。以下截图来自已记录的 AIPOCH Open-Science 工作流，用于展示各个阶段，并非同一次连续会话。

#### 1. 明确研究任务与证据

说明研究问题、来源论文与数据集、必需的方法或阈值、预期输出和验收标准。上传支持文件，或使用 `@` 引用已有项目产物，让智能体从明确的输入开始，而不是依赖隐藏上下文。

<p align="center">
  <img src="../images/readme/product-tour-task.jpg" alt="AIPOCH Open-Science 论文复现任务，在同一工作区中显示研究结论、生成产物和来源比较" width="900">
</p>

#### 2. 使用可检查的科学工具执行

智能体可以在共享 Notebook 中组合科学技能、受权限控制的研究连接器、搜索、文件操作以及 Python 或 R 代码。生成图像可与研究摘要并排审阅，产物记录则提供已捕获的生成代码和执行证据供检查。

<p align="center">
  <img src="../images/readme/product-tour-execute.png" alt="AIPOCH Open-Science 生物信息学分析，并排显示研究摘要、生成图像和已捕获的生成代码" width="900">
</p>

#### 3. 就地审阅报告、表格和图像

最终回答会概述哪些结果成功复现、哪些存在差异，以及需要关注的局限。生成的 Markdown 报告、CSV 表格、图像和其他研究产物会继续附属于会话，并汇集到项目文件库，可在对话旁预览，也可用于后续工作。

<p align="center">
  <img src="../images/readme/product-tour-output.jpg" alt="AIPOCH Open-Science 复现结果，在智能体说明旁预览差异表达图像和生成文件" width="900">
</p>

#### 4. 将每个产物追溯到证据

每个生成产物都以不可变且带校验和的版本保存。其 **Provenance** 视图可显示生成代码与执行历史、引用的输入、观测到的环境清单、生成该产物的对话分支，以及限定到该版本的 Reviewer 结果。无法验证的证据会标记为不可用，而不会被推断补全。

<p align="center">
  <img src="../images/readme/product-tour-provenance.jpg" alt="AIPOCH Open-Science 研究产物预览，其中包含用于追溯生成结果的 Provenance 入口" width="900">
</p>

## 基准测试表现

### 🏆 BiomniBench-DA Public 50 第一名

AIPOCH Open-Science 在汇总的 BiomniBench-DA Public 50 对比中取得最高排名分：使用 **gpt-5.6-sol (xhigh)** 获得 **79.05** 分。该成绩是 Gemini 3.1 Pro 评审得分 **81.04** 与 DeepSeek v4-pro 评审得分 **77.06** 的等权平均值，使 AIPOCH Open-Science 在所收集的 Public 50 结果中位列 **第一**。查看 [BiomniBench-DA 数据集](https://huggingface.co/datasets/phylobio/BiomniBench-DA)。

<p align="center">
  <img src="../images/readme/biomnibench-public50-leaderboard.png" alt="BiomniBench-DA Public 50 对比，其中 AIPOCH Open-Science 以 79.05 分排名第一" width="1200" />
</p>

## 为什么选择 AIPOCH Open-Science

AIPOCH Open-Science 把分散在聊天窗口、Notebook、本地脚本、科学数据库、文件与报告工具中的研究工作整合为一个持久化、本地优先的 AI 研究工作台，让执行过程与证据始终相连。

- **持久执行。** 项目、会话、文件、预览和运行历史在重启后仍会保留；经用户批准，智能体可以运行命令、Python 和 R 并生成产物。
- **结果可追溯。** 不可变产物版本保留可验证的生成证据，并清楚标记无法获得的证据。
- **模型无关。** 可连接内置云服务商、兼容的自定义网关或 Claude、Codex 订阅，并为每个会话选择模型和推理强度。
- **本地优先控制。** 应用和项目状态保留在你的计算机上；外部调用只使用你明确配置或批准的服务。
- **开放且可扩展。** 独立开发的 Apache-2.0 代码库、技能、连接器、工具活动和生成文件均可检查，并可继续添加技能和 MCP 连接器。

## 核心能力

AIPOCH Open-Science 在一个本地工作区中整合项目管理、多模型智能体执行、Python 和 R Notebook、科学数据连接器、带来源的不可变产物版本，以及受权限控制的人工参与机制。不断变化的目录、打包细节和新增选项应以已安装应用及[最新发行说明](https://github.com/aipoch/open-science/releases/latest)为准。

| 领域                           | 核心能力                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **项目与会话**                 | 创建和组织项目，支持会话置顶、持久消息分支和侧边对话以及可编辑会话详情。可将已完成的提示编辑为持久、可选择的消息分支，而不删除原有后续路径，并恢复近期工作、草稿、对话历史和预览状态。                                                                                                                                                                                                                                                                                 |
| **智能体工作流**               | 在自然语言会话中获得流式响应和按用途分组的工具活动，并使用审批、停止、排队跟进、上下文压缩及重启恢复。可将已完成工作分支为新会话，并结合结构化澄清、文本/图片/PDF 批注、关联 PDF 阅读上下文、项目记忆、会话引用及需审阅的计划。通知、实时状态、耗时与词元详情、命令面板、来源预览和项目切换让长时间研究保持可见、可管理。                                                                                                                                              |
| **模型与智能体后端**           | 使用内置云服务商，包括 Apodex、提供精选智能体模型目录的 NVIDIA Build，以及最新的 OpenAI 和 Anthropic 模型目录（GPT-6 Astra 和 Claude Fable 5.1）；也可连接自定义兼容网关，或使用 Claude 和 Codex 订阅登录。可选择 Claude Code、OpenCode、Codex 或无需登录的 CodeBuddy 作为智能体后端，并获得模型和 API 兼容性验证、多模态图片输入、推理强度控制，以及独立的子智能体、审阅者和 Vision 策略。                                                                            |
| **专家与委派**                 | 创建能力范围明确的个人专家智能体，支持对话式定制、包导入/导出，以及从主智能体即时交接。采用签名包的专家市场支持官方及用户批准的 GitHub 来源、可感知冲突的导入和 64 个内置能力图标；生产级委派还提供持久消息、恢复机制和按会话委派开关。                                                                                                                                                                                                                                |
| **Python、R、Notebook 与 HPC** | 运行持久化 Python、R 和 REPL 内核以及纳入同一历史记录的命令行指令，可使用托管离线环境或自带解释器。在本机工作，或通过 SSH 连接远程主机并使用 Slurm 向 HPC 集群提交 Notebook 任务；受保护的网络访问、加密凭据、包与变量查看、共享终端和渐进式历史加载让计算过程可控且可观察。长时间的 Notebook、REPL 与 shell 工作可以在后台运行——释放智能体回合的同时保留确切的运行标识、取消能力与溯源，并在本地运行与远程计算作业之间自动交付结果。外部 R 环境的包管理仍需手动完成。 |
| **文献综述与参考文献管理**     | 通过 DOI、PubMed ID、arXiv ID 或文件导入参考文献——单个 PDF 通过元数据编辑器导入，或一次导入多个，带逐文件进度、重复处理与重试——并可一目了然地查看当前文献库的参考文献总数；整理合集、将参考文献关联到项目，并从回收站恢复下载的 PDF。并行检索 Europe PMC、PMC、OpenAlex、arXiv 和 Unpaywall 的开放获取全文，在不丢失附件或链接的情况下合并重复记录，并根据已存元数据生成带产物溯源的引用。                                                                             |
| **科学文件与预览**             | 通过流式上传添加最大 10 GB 的文件；整理和搜索项目文件库；使用 `@` 与 `@path` 引用上传内容、输出和本地文件夹；导出文件、对话或 `.ipynb` 会话。可内嵌或全屏预览科学数据、可搜索 PDF、Office 文件、TIFF 等图片、源代码、分子结构与反应以及 Notebook 历史，并提供溯源及返回来源的导航。                                                                                                                                                                                    |
| **产物与溯源**                 | 保存不可变、限定于会话的产物版本，包含内容校验和、生成代码、执行历史、确切输入、环境清单、消息分支上下文、沿袭关系和审阅证据。可编辑的 Markdown、文本、脚本和源代码每次保存都会发布保留溯源的新版本，并可与前一版本比较。                                                                                                                                                                                                                                              |
| **科学技能与数据连接器**       | 使用 **22 个精选**内置技能和 **24 个内置**研究连接器扩展研究工作流。可通过对话或已完成工作创建技能，导入包和 GitHub 来源，并添加具有工具级权限及配置导入/导出能力的自定义本地或远程 MCP 连接器。核心应用技能保持始终启用，内置入口因此持续可用；无头 CLI 与 Task SDK 可以列出、检查以及启用或禁用连接器。跨资源标签、受保护的“收藏夹”标签和可搜索筛选器用于组织技能、连接器和专家。                                                                                    |
| **本地数据、隐私、权限与验证** | 将项目数据、应用状态和 Notebook 缓存保存在可配置、可迁移的本地存储中；支持系统、手动或直连代理模式，以及包含 30 天活动热图和逐次运行归因的词元仪表板。通过 `Ask for approval`、`Auto-approve edits` 或 `Full access`、限定范围的授权、集中式凭据（无头 Linux 部署可选择显式的文件存储模式）、用户批准的计算域名以及连接器和工具级策略控制操作。可选审阅者会审计对话记录、执行日志和产物，报告通过/警告/失败结果，并可运行保留持久证据的有界修复循环。                  |

## 模型服务商

AIPOCH Open-Science 在产品层面不限定模型：可连接主要云端 LLM 服务商、自定义网关，或复用现有 Claude、Codex 订阅。当前可用服务商取决于所选智能体后端及其支持的 API 协议。模型有四种连接方式：

| 服务商模式       | 工作方式                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **内置云服务商** | 从已安装应用显示的服务商列表中选择，并使用要求的密钥进行认证。                                                                                                                                                                  |
| **自定义网关**   | 提供兼容的 Base URL、API Key 和准确模型 ID。默认 API 格式（Messages、Chat Completions 或 Responses）源自活动智能体框架，因此新的自定义网关可直接兼容。                                                                          |
| **Codex 订阅**   | 选择 Codex 智能体框架，然后在服务商类型中选择 Codex 订阅。                                                                                                                                                                      |
| **Claude 订阅**  | 通过两种模式登录 Claude 订阅：**共享**（浏览器登录，将凭据存入默认 `~/.claude` 配置）或**隔离**（应用在自有 `CLAUDE_CONFIG_DIR` 下管理 `claude setup-token`，与 `~/.claude/` 完全隔离，并提供浏览器流程和粘贴令牌的回退方式）。 |

旧版 **Local Claude** 服务商已移除。升级时会删除此前保存的 Local Claude 条目；改为添加 **Claude Subscription**，并通过共享浏览器登录或隔离的 `claude setup-token` 流程进行认证。

当前内置云厂商包括 OpenAI、Anthropic、Grok (xAI)、DeepSeek、带专用 GLM Coding Plan 端点的智谱 AI (GLM)、Kimi (Moonshot)、MiniMax、带专用 Step Plan 订阅端点的 StepFun、小米 MIMO、SenseNova、Volcengine Ark、带专用 Bailian for Plan 订阅端点的百炼 (Alibaba Cloud)、Tencent TokenHub 以及专用的腾讯 Coding Plan 与 Token Plan 订阅端点，还有 OpenCode Go、OpenCode Zen 和 OpenRouter 聚合网关等；部分具有地区限制。

服务商厂商、可用模型和地区端点可能独立于本 README 演进。以已安装应用中的服务商选择器和连接测试为准。

## 数据、权限与信任

AIPOCH Open-Science 将项目数据、设置、产物版本和来源证据存储在本地计算机上。API Key 保存在本地，并在操作系统支持时使用其安全凭据存储。日志保存在本地，不会自动上传。

仍可能发生外部数据流，应对其进行审查：

- 模型请求会将提示和必要上下文发送给所选模型服务商。
- 网页搜索和远程连接器会将其显示的参数发送给外部服务。
- 本地连接器可能会在计算机上执行受信任命令。
- 附件、`@` 引用、日志和生成报告可能包含敏感研究数据。

选择能够满足任务需要的最小权限配置：

| 模式                 | 行为                                         | 建议用途                             |
| -------------------- | -------------------------------------------- | ------------------------------------ |
| `Ask for approval`   | 在编辑、命令、网络和连接器调用前询问         | 新工作流、敏感数据、不熟悉的脚本     |
| `Auto-approve edits` | 自动允许工作区编辑；对命令、网络和连接器询问 | 受信任的文件编辑工作，并控制外部访问 |
| `Full access`        | 自动允许编辑、命令、网络和连接器             | 范围清晰、完全受信任的无人值守工作   |

批准前检查连接器参数和工具活动。切勿在截图或公开问题日志中包含 API Key、访问令牌、患者标识符、未公开数据或敏感本地路径。

## 项目状态

AIPOCH Open-Science 是持续开发中的桌面应用，可用于 macOS、Windows 和 Linux。开发重点是可靠的本地优先研究工作流、可扩展科学能力、可追溯研究产物以及用户控制的执行。

有关当前下载和特定版本变更，请查看[最新版本](https://github.com/aipoch/open-science/releases/latest)。有关已交付、部分实现和计划能力，请查看[能力地图](../../ROADMAP.md#capability-map)。

AIPOCH Open-Science 辅助研究执行和记录保存；研究人员仍需对方法、解释、隐私和科学有效性负责。

## 开发与打包

AIPOCH Open-Science 是使用 React、TypeScript、Prisma/SQLite 和基于 ACP 的智能体运行时构建的 Electron 应用。

源代码开发前提条件：

- Node.js 22（参见 [`.nvmrc`](../../.nvmrc)）及 npm
- Git
- 仅在需要 Notebook 执行时需要 Python 3

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` 会自动生成 Prisma 客户端并安装 Electron 原生依赖项。`npm run dev` 构建 Electron main/preload 软件包、启动渲染器并打开桌面应用。开发数据隔离在 `~/.open-science-project` 下。

常用命令：

| 命令                   | 用途                                    |
| ---------------------- | --------------------------------------- |
| `npm run dev`          | 启动开发应用                            |
| `npm run dev:web`      | 开发应用 + localhost Web UI (127.0.0.1) |
| `npm run dev:headless` | 开发后端 + Web UI，不打开 Electron 窗口 |
| `npm run lint`         | 运行 ESLint                             |
| `npm run typecheck`    | 对 main 和 renderer 代码进行类型检查    |
| `npm test`             | 运行 Vitest 测试套件                    |
| `npm run build`        | 类型检查并构建应用                      |
| `npm run build:web`    | 构建可选 localhost Web UI               |
| `npm run build:mac`    | 打包 macOS 构建                         |
| `npm run build:win`    | 打包 Windows 构建                       |
| `npm run build:linux`  | 打包 Linux 构建                         |

打包输出写入 `dist/`。

### Localhost Web 和无界面模式

桌面后端可以选择在本地计算机上向浏览器提供同一渲染器。此功能默认关闭，并且只绑定到 `127.0.0.1`。

```bash
npm run build:web
npm run dev:web
```

打开应用打印的认证 URL。使用 `npm run dev:headless` 启动后端、托盘、智能体运行时和 localhost Web 服务，而不打开 Electron 窗口。设置 `OPEN_SCIENCE_WEB_PORT` 可选择端口（默认 `44100`）。明确退出应用仍会正常关闭智能体和 Notebook 进程。

### 移动端远程访问

可以通过 Remote.It 配对，从手机或平板电脑访问同一 localhost Web UI。使用六位 AIPOCH Open-Science 代码配对浏览器，并在桌面端批准一次；无需直接暴露回环服务器，工作区即可保持可访问。浏览器信任可撤销，模式变更或服务关闭会立即使活动远程会话失效。

### 无界面 CLI 和 SDK

无界面 CLI 和零依赖 Node.js SDK 与桌面及 Web 界面使用同一本地守护进程、项目、会话、凭据和权限。详细用法与可发布软件包保存在一起，因此只需维护一份命令参考：

- [CLI 指南](../../packages/open-science/CLI.md) — 安装、服务生命周期、任务自动化、产物、输出格式和退出码
- [SDK 软件包概览](../../packages/open-science/README.md) — Node.js 快速开始和软件包入口点

## 常见问题

### 什么是 AIPOCH Open-Science？由谁开发？

答：AIPOCH Open-Science 是由 AIPOCH 团队开发的独立开源（Apache-2.0）研究工作台。**AIPOCH Open-Science** 是完整产品名，**Open-Science** 是简称；两者均指同一个 AIPOCH 产品。

### 首次打开 AIPOCH Open-Science 时应该做什么？

答：完成五个设置步骤：**Environment**、**Data location**、**Agent runtime**、**Model provider** 和 **Notebook runtime**。修复标记为 `Action needed` 的必需项目；如果提供选项，安装或修复所选智能体；然后测试模型连接。Notebook 设置和自定义数据位置是可选的。

### 什么是 API Key？从哪里获取？

答：API Key 是模型服务商签发的秘密凭据。从该服务商的开发者/API 控制台新建或复制。服务商可能会对使用此密钥发出的请求计费。像密码一样保护它：不要分享，也不要提交到仓库。

### 我需要 API Key 吗？

答：如果复用现有订阅登录，则不需要：可以通过共享浏览器登录或隔离的应用管理 `claude setup-token` 流程使用 Claude 订阅，也可以在 Codex 后端使用 ChatGPT/Codex 订阅登录。内置云服务商和自定义网关需要各自的密钥。

### 可以使用哪些模型服务商？

答：在设置期间或 `Settings → Model` 下打开服务商选择器，查看已安装应用和所选智能体后端支持的选项。可以使用内置云服务商、兼容的 Custom Gateway、共享或隔离登录的 Claude 订阅，或 Codex 后端上的 Codex 订阅。

### 为什么模型连接测试失败？

答：检查 API Key 是否缺少字符或含有空格，验证 Base URL 和地区，使用服务商准确的模型 ID，并确认网络访问和账户余额。对于 Claude 订阅，根据所选模式重新尝试共享浏览器登录，或刷新隔离的 `claude setup-token` 凭据。

### 为什么设置期间 `Continue` 被禁用？

答：当前步骤尚未满足必需条件。根据活动步骤，修复标记为 `Action needed` 的环境行，安装或修复所选智能体运行时，或验证模型服务商。Notebook 设置是可选的，只影响 Notebook 执行。

### 设置已完成，如何开始研究任务？

答：新建或打开项目，开始会话，附加源文件，并描述目标、限制条件、期望输出和验证标准。使用 `@` 引用项目文件，使用 `/` 选择已启用的技能。

### 如何在远程 HPC 集群上运行任务？

答：在 **Settings → Skills** 下启用 **Remote Compute (SSH)** 技能，在 **Settings → Compute** 下注册集群，然后开始会话并使用 `/remote-compute-ssh` 选择该技能。此技能处理主机注册、通过 SSH 运行短命令和完全异步的任务提交。任务完成后，应用会自动开始分析轮次，因此无需编写轮询循环。

### 是否提供命令行界面？

答：提供。在 **Settings → General → Command line tool → Install command** 中一键安装（将 `open-science` 添加到 PATH，无需单独安装 Node.js）。CLI 可控制本地服务并提交研究任务，无需打开浏览器：

```bash
# 在后台启动服务
open-science start --no-open

# 新建项目，并按准确名称运行任务
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# 下载生成产物
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

完整命令参考、JSON/JSONL 输出格式、退出码和无界面服务选项请查看 [CLI 指南](../../packages/open-science/CLI.md)。

### 如何检查生成结果的来源？

答：打开生成产物并选择 **Provenance**。选择一个版本，以检查内容标识及可用的生成代码、执行历史、输入、环境清单、生成对话上下文和审查证据。AIPOCH Open-Science 无法验证的证据会标记为不可用。

### 能否修改较早的请求而不丢失后续对话？

答：可以。编辑已完成的用户消息并重新发送，从该位置新建分支。原有后续轮次仍然可用，消息旁的修订箭头可在不同路径之间切换。

### 我的研究数据会保留在计算机上吗？

答：项目、会话、文件、设置和已配置凭据默认存储在本地。模型请求、网页搜索或连接器调用所需内容仍可能发送给你选择的外部服务，因此运行任务前应检查敏感输入和服务商政策。

## 参与项目

AIPOCH Open-Science 通过 GitHub、Discord、X 和 AIPOCH 网站接收缺陷报告、功能建议、设计讨论、社区问题和项目贡献。请选择最符合你目标的渠道，并在公开分享项目详情前查看相关贡献指南与公开发布安全提醒。

| 渠道                                                                     | 用途                               |
| ------------------------------------------------------------------------ | ---------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 缺陷、可复现故障和具体功能建议     |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 设计问题、路线图提议和较长技术讨论 |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 社区帮助、贡献者协调和非正式讨论   |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 版本公告和公开构建动态             |
| [AIPOCH Open-Science 官网](https://aipoch.com/open-science)              | 官方产品概览与下载                 |

提交公开问题前，从日志和截图中移除 API Key、令牌、私有文件路径、未公开数据、患者标识符和其他敏感材料。开发工作流请参阅[贡献指南](CONTRIBUTING.md)。

> ⭐ **Star 仓库：** 如果本项目对你有帮助，欢迎在 GitHub 上 Star。Star 仓库可以鼓励项目持续开发，只需片刻，却会对项目产生切实影响。

## 许可证

Apache License 2.0 — 参阅 [LICENSE](../../LICENSE)。
