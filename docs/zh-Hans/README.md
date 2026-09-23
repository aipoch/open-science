<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  面向可复现科学研究的 AI 研究工作台——开源、本地优先、模型无关。
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

AIPOCH Open-Science 是面向科学家和研究人员的 AI 研究工作台，由 [AIPOCH](https://aipoch.com/open-science) 开发，采用开源、本地优先、模型无关的设计。它通过科学 AI 智能体、Python 和 R 执行、科学数据连接器以及对 macOS、Windows 和 Linux 的跨平台支持，实现可复现、可检查的研究。在同一个工作区中，新建项目，用自然语言描述研究目标，然后让智能体读取文件、搜索网页、运行代码、查询科学数据源，并生成带有可追溯来源的报告、表格和图表。

AIPOCH Open-Science 支持机器学习、统计学、生命科学、化学、材料科学、物理学和环境科学等领域的计算密集型与数据密集型研究。它覆盖从文献综述、假设构建到代码执行、数据分析、仿真、可视化以及生成可追溯研究成果的完整研究流程。

> 💡 **[AIPOCH Open-Science v0.33.0 已发布](https://github.com/aipoch/open-science/releases/latest)** _（最后更新于 2026 年 9 月）_。AIPOCH Open-Science v0.33.0 带来了筛选级的文献甄别：智能文献合集会依据你的纳入与排除标准评估参考文献，提供已纳入 / 待复核 / 已排除状态、PDF 证据，以及可选开启的自动更新。研究包现在会嵌入 RO-Crate 元数据（新导出的包需要支持 ro-crate 能力的读取器；现有包仍可读取），连接器家族也随 Zenodo 公共记录发现、GDC 项目与文件元数据以及 UniProt 批量标识符映射而壮大。按智能体的资源访问控制把主智能体与专家的技能和连接器权限集中到一处；会话新增本地诊断导出；模型服务商目录随 Xiaomi MiMo v2.6、Grok 4.7 以及 Zen 和 Go 的当前一代模型得到刷新。Notebook 的环境与恢复通知现在可以关闭，Windows 包重置会清除只读属性，Linux 包内置 Fedora 查询引擎，而设有上限的词元估算让流式输出保持响应。详情请查看[最新发行说明](https://github.com/aipoch/open-science/releases/latest)。

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science 首屏横幅：Science, Open to All——开源、模型无关、可自托管的科学 AI 研究工作台" src="../images/readme/open-science-banner.png" />
</p>

## 目录

- [快速开始](#-快速开始)
- [产品导览](#产品导览)
- [基准测试表现](#基准测试表现)
- [核心能力](#核心能力)
- [模型服务商](#模型服务商)
- [数据、权限与信任](#数据权限与信任)
- [开发与打包](#开发与打包)
- [常见问题](#常见问题)
- [参与项目](#参与项目)
- [许可证](#许可证)

## 🚀 快速开始

### 1. 下载应用

打开[最新版本](https://github.com/aipoch/open-science/releases/latest)，展开 **Assets**，并选择适合你计算机的安装程序：

| 你的计算机                              | 选择                                      |
| --------------------------------------- | ----------------------------------------- |
| macOS 12+ — Apple 芯片（M1 或更新型号） | 适用于 Apple Silicon / ARM64 的 macOS DMG |
| macOS 12+ — Intel                       | 适用于 Intel / x64 的 macOS DMG           |
| Windows x64                             | Windows x64 安装程序                      |
| Linux x64                               | Linux x64 AppImage 或 Debian 软件包       |

从官方版本页下载安装包；如需校验，请参阅[验证下载](../../SECURITY.md#verifying-your-download)。

macOS 用户也可以通过 [Homebrew](https://brew.sh) 安装：

```bash
brew install --cask open-science
```

Windows 重装会保留研究数据；如需彻底清理，请参阅[数据重置工具](../../scripts/windows-reset/README.md)，确认后会永久删除本地数据。

### 2. 完成首次设置

按向导依次完成：**环境 → 数据位置 → 智能体运行时 → 模型服务商 → Notebook 运行时**。

完成必需的环境和智能体运行时检查，并测试模型连接。Python/R Notebook 配置可选；Notebook 和数据位置都可稍后在设置中调整。

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

### 3. 开始研究项目

1. 点击 **New project**，打开会话，说明研究目标、输入和期望输出。
2. 附加文件，选择模型与批准模式，然后发送任务；可用 `@` 引用项目文件，用 `/` 选择技能。
3. 查看工具活动并处理批准请求，预览结果，通过 **Provenance** 检查可用证据。

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

## 核心能力

AIPOCH Open-Science 在一个本地工作区中整合项目管理、多模型智能体执行、Python 和 R Notebook、科学数据连接器、带来源的不可变产物版本，以及受权限控制的人工参与机制。不断变化的目录、打包细节和新增选项应以已安装应用及[最新发行说明](https://github.com/aipoch/open-science/releases/latest)为准。

| 领域                           | 核心能力                                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **科学技能**                   | 提供 **23 个内置 Skills**，并可从 [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace) 安装 **525 个 Skills**，支持一键安装与更新。可通过对话或已完成的工作创建技能，导入技能包及 GitHub 来源。市场投稿经审核后发布，本地导入不会自动上架。        |
| **连接器**                     | 通过 **24 个内置 Connectors** 访问科学资源，也可添加自定义本地或远程 MCP 连接器。支持工具级权限管理，以及连接器配置的导入和导出。                                                                                                                                           |
| **专家与委派**                 | 从 [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) 安装 **10 个 Specialists**，或创建和定制个人专家，由主智能体委派任务。专家包支持导入和导出；市场投稿经审核后发布，本地导入不会自动上架。                                          |
| **模型与智能体后端**           | 连接云端模型、兼容的自定义网关，或使用 Claude、Codex 订阅登录。支持 Claude Code、OpenCode、Codex 和 CodeBuddy 四种智能体后端，并提供模型连接检查、图片输入和推理强度设置。                                                                                                  |
| **项目、会话与研究包**         | 管理项目，支持会话置顶、消息分支、侧边对话和历史恢复。将会话导出为**可移植的 `.science` 研究包**，并导入其他项目或计算机，携带对话分支、所选文件版本、Notebook 记录和验证证据。导入结果为只读历史，不执行代码或恢复凭据；侧边对话和书签不随包导出，文件范围取决于导出选择。 |
| **审阅智能体**                 | 按需开启自动审阅，在独立上下文中核对智能体已完成轮次的回复、执行记录及相关文件证据。生成带依据的通过、警告或失败检查项，发现问题后可触发主智能体修正，并在有限轮次内复审。保留审阅日志与问题处理状态，审阅范围限于该轮可用记录。                                            |
| **Python、R、Notebook 与 HPC** | 使用托管环境或自配解释器，在本地运行 Python、R、Notebook 和 Shell 任务，支持后台执行与历史记录。也可通过 SSH 连接远程主机或使用 Slurm 提交作业；远程计算需具备下方 FAQ 所述的主机、软件、资源和权限。                                                                       |
| **文献库**                     | 导入和管理文献与 PDF，支持合集、标签、项目关联、笔记及重复条目合并。查找开放获取全文，阅读 PDF 并提取图表，在会话中调用库内文献辅助分析。按所选引用样式生成参考文献，并导出为 BibTeX 或 RIS。                                                                               |
| **科学文件与预览**             | 单个上传文件最大 **10 GiB**，支持项目文件管理及科学数据、PDF、Office 文档、图像、代码和分子结构预览。这是上传大小限制，不代表模型可以读取全部内容；模型上下文、附件解析和预览各有限制。大文件通常需要通过代码分块读取或分析。                                               |
| **产物与溯源**                 | 保存不可变的产物版本及可用的生成代码、输入、执行历史、环境信息和审阅证据。在桌面端，可使用完整执行配方、必要输入和可用运行时重放符合条件的版本，比较输出并导出验证记录。证据缺失可能阻止验证，重放检查不证明科学结论有效。                                                  |

## 模型服务商

AIPOCH Open-Science 在产品层面不限定模型：可连接主要云端 LLM 服务商、自定义网关，或复用现有 Claude、Codex 订阅。当前可用服务商取决于所选智能体后端及其支持的 API 协议。模型有四种连接方式：

| 服务商模式       | 工作方式                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **内置云服务商** | 从已安装应用显示的服务商列表中选择，并使用要求的密钥进行认证。                                                                                                                                                                                                                                                       |
| **自定义网关**   | 提供 Base URL 和准确模型 ID，选择智能体后端支持的 API 协议（Messages、Chat Completions 或 Responses），然后执行连接测试。远程网关要求 HTTPS 和 API Key；`localhost`、`127.0.0.1` 或 `[::1]` 等回环端点可以使用 HTTP 并省略密钥。预设包括 Ollama、LM Studio、llama.cpp 和 vLLM。默认 API 格式不保证服务器或模型兼容。 |
| **Codex 订阅**   | 选择 Codex 智能体框架，然后在服务商类型中选择 Codex 订阅。                                                                                                                                                                                                                                                           |
| **Claude 订阅**  | 通过两种模式登录 Claude 订阅：**共享**（浏览器登录，将凭据存入默认 `~/.claude` 配置）或**隔离**（应用在自有 `CLAUDE_CONFIG_DIR` 下管理 `claude setup-token`，与 `~/.claude/` 完全隔离，并提供浏览器流程和粘贴令牌的回退方式）。                                                                                      |

内置服务商包括 OpenAI、Anthropic、DeepSeek、NVIDIA Build 等；可用模型和地区端点取决于安装版本及所选智能体后端。请以应用中的服务商选择器和连接测试为准。

## 数据、权限与信任

AIPOCH Open-Science 将项目数据、设置、产物版本和来源证据存储在本地计算机上。API Key 保存在本地，并在操作系统支持时使用其安全凭据存储。日志保存在本地，不会自动上传。

仍可能发生外部数据流，应对其进行审查：

- 模型请求会将提示和必要上下文发送给所选模型服务商。
- 网页搜索和远程连接器会将其显示的参数发送给外部服务。
- 本地连接器可能会在计算机上执行受信任命令。
- 应用也可能访问更新服务器、市场目录，以及运行时或模型下载服务。
- 附件、`@` 引用、日志和生成报告可能包含敏感研究数据。

选择能够满足任务需要的最小权限配置：

| 模式                 | 行为                                                           | 建议用途                             |
| -------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `Ask for approval`   | 对未被已有范围授权或可信应用工具策略覆盖的操作请求批准         | 新工作流、敏感数据、不熟悉的脚本     |
| `Auto-approve edits` | 优先使用后端原生自动审查；否则仅自动批准明显低风险的工作区操作 | 受信任的文件编辑工作，并控制外部访问 |
| `Full access`        | 自动允许编辑、命令、网络和连接器                               | 范围清晰、完全受信任的无人值守工作   |

实际权限模式取决于所选后端和已有授权。连接器、工具及计算网络策略同样适用；请查看应用显示的实际生效模式。

批准前检查连接器参数和工具活动。切勿在截图或公开问题日志中包含 API Key、访问令牌、患者标识符、未公开数据或敏感本地路径。

## 开发与打包

AIPOCH Open-Science 是使用 React、TypeScript、Prisma/SQLite 和基于 ACP 的智能体运行时构建的 Electron 应用。

源代码开发前提条件：

- Node.js 22（参见 [`.nvmrc`](../../.nvmrc)）及 npm
- Git
- Notebook 执行为可选功能，可使用应用管理的 Python/R 环境或自行配置的兼容解释器。

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

构建命令与开发流程见[开发命令与打包参考](development-quick-reference.md)和[贡献指南](../../CONTRIBUTING.md)。

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

### 为什么模型连接测试失败？

答：检查 API Key 是否缺少字符或含有空格，验证 Base URL 和地区，使用服务商准确的模型 ID，并确认网络访问和账户余额。对于 Claude 订阅，根据所选模式重新尝试共享浏览器登录，或刷新隔离的 `claude setup-token` 凭据。

### 为什么设置期间 `Continue` 被禁用？

答：当前步骤尚未满足必需条件。根据活动步骤，修复标记为 `Action needed` 的环境行，安装或修复所选智能体运行时，或验证模型服务商。Notebook 设置是可选的，只影响 Notebook 执行。

### 如何在远程 HPC 集群上运行任务？

答：**Remote Compute (SSH)** 始终启用，无需在 Settings 中手动启用。先在 **Settings → Compute** 中注册 SSH 计算主机并使其对当前会话可用，然后通过自然语言或 `/remote-compute-ssh` 使用远程计算。你需要可访问的 SSH 主机、有效认证、所需目录的访问权限，以及任务所需的软件、依赖和计算资源。Direct SSH 不要求调度器；Slurm 模式要求可用的 Slurm 环境和作业提交权限。“始终启用”仅指该 Skill，不代表所有已注册主机始终可用。

### 是否提供命令行界面？

答：提供。在 **Settings → General → Command line tool → Install command** 中一键安装（将 `open-science` 添加到 PATH，无需单独安装 Node.js）。CLI 可控制本地服务并提交研究任务，无需打开浏览器：

```bash
# 在后台启动服务
open-science init
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

## 参与项目

AIPOCH Open-Science 通过 GitHub、Discord、X 和 AIPOCH 网站接收缺陷报告、功能建议、设计讨论、社区问题和项目贡献。请选择最符合你目标的渠道，并在公开分享项目详情前查看相关贡献指南与公开发布安全提醒。

| 渠道                                                                     | 用途                               |
| ------------------------------------------------------------------------ | ---------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 缺陷、可复现故障和具体功能建议     |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 设计问题、路线图提议和较长技术讨论 |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 社区帮助、贡献者协调和非正式讨论   |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 版本公告和公开构建动态             |
| [AIPOCH Open-Science 官网](https://aipoch.com/open-science)              | 官方产品概览与下载                 |

提交公开问题前，从日志和截图中移除 API Key、令牌、私有文件路径、未公开数据、患者标识符和其他敏感材料。开发工作流请参阅[贡献指南](../../CONTRIBUTING.md)。

> ⭐ **Star 仓库：** 如果本项目对你有帮助，欢迎在 GitHub 上 Star。Star 仓库可以鼓励项目持续开发，只需片刻，却会对项目产生切实影响。

已交付、部分实现和计划能力见[能力地图](../../ROADMAP.md#capability-map)。

## 许可证

Apache License 2.0 — 参阅 [LICENSE](../../LICENSE)。
