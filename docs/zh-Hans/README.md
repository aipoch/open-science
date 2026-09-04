<h1 align="center">Open Science</h1>

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

Open Science 是由 [AIPOCH](https://aipoch.com/open-science) 为科学家和研究人员开发的开源、本地优先且模型无关的 AI 研究工作台。它通过科学 AI 智能体、Python 和 R 执行、科学数据连接器以及对 macOS、Windows 和 Linux 的跨平台支持，实现可复现、可检查的研究。在同一个工作区中，新建项目，用自然语言描述研究目标，然后让智能体读取文件、搜索网页、运行代码、查询科学数据源，并生成带有可追溯来源的报告、表格和图表。

Open Science 支持机器学习、统计学、生命科学、化学、材料科学、物理学和环境科学等领域的计算密集型与数据密集型研究。它覆盖从文献综述、假设构建到代码执行、数据分析、仿真、可视化以及生成可追溯研究成果的完整研究流程。

> 💡 **[Open Science v0.25.1 已发布](https://github.com/aipoch/open-science/releases/latest)** _（最后更新于 2026 年 9 月）_。Open Science v0.25.1 是一次维护性版本：受保护的 Notebook 内核现在可以在 Windows 上直接启动，文件导出以原子方式发布并带有跨时区依然有效的软件包时间戳，生成的图像预览已恢复，同时还带来一大批会话、产物、专家与服务商修复。详情请查看[最新发行说明](https://github.com/aipoch/open-science/releases/latest)。

<p align="center">
 <img width="1920" height="1140" alt="Open Science 开源 AI 研究工作台桌面应用工作区，其中显示了包含生成产物的智能体会话" src="https://github.com/user-attachments/assets/df59db19-98d7-4071-81f2-c682fbecdf86" />
</p>

## 目录

- [快速开始](#-快速开始)
- [产品导览](#产品导览)
- [基准测试表现](#基准测试表现)
- [为什么选择 Open Science](#为什么选择-open-science)
- [设计原则](#设计原则)
- [核心能力](#核心能力)
- [模型服务商](#模型服务商)
- [数据、权限与信任](#数据权限与信任)
- [项目状态](#项目状态)
- [开发与打包](#开发与打包)
- [路线图](#路线图)
- [与 AIPOCH 生态系统的关系](#与-aipoch-生态系统的关系)
- [Open Science 不是什么](#open-science-不是什么)
- [常见问题](#常见问题)
- [参与项目](#参与项目)
- [许可证](#许可证)

## 🚀 快速开始

通过三个步骤运行 Open Science：下载适合你平台的安装程序、完成首次启动向导，然后新建研究项目。

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

### 2. 完成首次设置

首次启动包含五个引导步骤：

1. **环境**检查兼容性、应用存储、安全凭据存储和网络访问。
2. **数据位置**选择大型产物、Notebook、上传内容和环境的存储位置。
3. **智能体运行时**选择并准备 Claude Code、OpenCode 或 Codex。安装由应用管理的运行时不需要 Node.js、npm 或管理员密码。
4. **模型服务商**连接并测试你要使用的模型。可以选择内置服务商、自定义网关，或现有 Claude、Codex 订阅登录。
5. **Notebook 运行时**可选择准备由应用管理的 Python 和 R 环境，或启用检测到及手动注册的两种语言解释器。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="Open Science 自动执行首次启动环境检查"></td>
    <td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="Open Science 首次启动模型服务商配置"></td>
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

Open Science 将研究组织成项目和会话，使每项结果都能与产生它的证据保持关联。以下章节介绍工作区、产物来源、预览、科学技能和数据连接器。

### 从任务到可追溯产物的统一工作区

项目将相关会话、上传内容、生成文件和预览状态保存在一起。对话会记录智能体回答，以及产生该回答的命令、文件读取、编辑、搜索和连接器调用。每个生成产物都以不可变且带校验和的版本保存。其 **Provenance** 视图公开 Open Science 在创建时能够验证的证据：生成代码和执行历史、引用的输入、观测到的环境清单、生成该产物的对话分支，以及限定到该版本的审查结果。缺少的证据会明确显示为不可用，而不会被猜测补全。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/project-files.jpg" alt="包含上传内容和生成研究产物的项目文件库"></td>
    <td width="50%"><img src="../images/readme/csv-preview.jpg" alt="已完成智能体会话旁的 CSV 产物预览"></td>
  </tr>
  <tr>
    <td align="center"><sub>按项目和会话组织的上传内容与生成文件</sub></td>
    <td align="center"><sub>原生预览让数据和研究历史并排显示</sub></td>
  </tr>
</table>

生成的报告、图表和表格会继续附属于会话，同时汇集到项目文件库。面板尺寸变化时，预览标签页会保持活动结果可见；长名称会保留用于识别的后缀和扩展名。Open Science 可以预览常见科学数据、PDF、Office 文档（DOCX、XLSX、PPTX）、图像（支持缩放和平移）、带语法高亮的源代码、分子结构与反应，以及 Notebook 历史。预览限制不会截断底层文件，智能体和外部工具仍可使用完整产物。使用 `Cmd/Ctrl+F` 搜索工作区中的对话记录、Notebook 输出和渲染页面，或使用 `Cmd/Ctrl+K` 打开项目级命令面板。工作区还支持深色模式：在 **Settings → General** 中切换主题，整个命令行、对话记录和渲染器配色会无闪烁切换。界面也提供德语、简体中文、繁体中文、日语、韩语、法语、俄语和西班牙语，并可在设置中运行时切换语言。

### 为对话创建分支而不丢失原始内容

编辑已完成的用户消息，可从该位置重新发送修改后的提示。Open Science 会新建消息分支，而不是删除后续轮次；修订控件可在原始路径和替代路径之间切换。分支选择、工具活动、附件和生成产物会跨项目切换与应用重启保持。来源仍与生成每个产物版本的准确分支绑定，因此探索不同假设不会模糊早期结果的记录。

### 科学技能与数据连接器

Open Science 包含不断扩展的 **18 个精选**文件型研究技能目录：AlphaFold2、Boltz、Borzoi、Chai-1、DiffDock、Environment & Packages、ESM-2、ESMFold2、Evo 2、Indication Dossier、LigandMPNN、Literature Review、OpenFold3、ProteinMPNN、scGPT、scvi-tools、SolubleMPNN，以及用于在远程 HPC 集群提交和收取长时间任务的 **Remote Compute (SSH)**。你可以新建个人技能，上传 `SKILL.md`/ZIP/`.skill` 软件包，以可选认证方式从 GitHub 预览并导入兼容技能，或导入已安装在全局智能体目录中的技能。智能体也可以请求从会话附件或公开 GitHub URL 导入软件包；应用会在写入任何内容前提供自有的预览和确认步骤。可以在输入框中使用 `/` 直接选择已启用的技能。

应用还包含 **24 个内置**研究连接器：Literature Graph、PubMed、bioRxiv、Genes & Ontologies、Genomes、BioMart、Variants、Human Genetics、Clinical Genomics、Structures & Interactions、Protein Annotation、Expression、Omics Archives、CellGuide、Regulation、RNA、Chemistry、ChEMBL、ZINC、Molecule Viewer、Clinical Trials、Drug Regulatory、Cancer Models 和 Research Resources。内置与自定义连接器都受权限系统控制，每个工具可设置 `Always allow`、`Ask each time` 和 `Block`。已安装应用会显示当前的技能、连接器和工具目录。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/skills.jpg" alt="Open Science 设置中显示精选科学技能"></td>
    <td width="50%"><img src="../images/readme/connectors.jpg" alt="Open Science 设置中显示内置科学数据连接器"></td>
  </tr>
  <tr>
    <td align="center"><sub>可读、可复用的研究技能</sub></td>
    <td align="center"><sub>作为受权限控制的智能体工具提供的科学数据库</sub></td>
  </tr>
</table>

## 基准测试表现

### 🏆 BiomniBench-DA Public 50 第一名

Open Science 在汇总的 BiomniBench-DA Public 50 对比中取得最高排名分：使用 **gpt-5.6-sol (xhigh)** 获得 **79.05** 分。该成绩是 Gemini 3.1 Pro 评审得分 **81.04** 与 DeepSeek v4-pro 评审得分 **77.06** 的等权平均值，使 Open Science 在所收集的 Public 50 结果中位列 **第一**。查看 [BiomniBench-DA 数据集](https://huggingface.co/datasets/phylobio/BiomniBench-DA)。

<p align="center">
  <img src="../images/readme/biomnibench-public50-leaderboard.jpg" alt="BiomniBench-DA Public 50 对比，其中 AIPOCH Open Science 以 79.05 分排名第一" width="1200" />
</p>

## 为什么选择 Open Science

Open Science 将研究任务、执行、文件和证据汇集到一个本地、可检查的桌面工作区。

研究工作通常分散在聊天窗口、Notebook、本地脚本、科学数据库、文件浏览器和报告工具中。每次交接都会丢失上下文，答案也往往与产生它的代码和文件分离。

Open Science 将这些内容整合到一个可检查的桌面工作区：

- **工作持久保存。** 项目、会话、草稿、文件、预览和运行历史在应用重启后仍会保留。
- **不仅建议，还能执行。** 经用户批准，智能体可以运行命令、Python 和 R，编辑文件、搜索、调用连接器并生成产物。
- **探索替代路径而不丢失工作。** 在新消息分支上修改较早的提示，并在产生的研究方向间切换。
- **结果可追溯。** 不可变产物版本保留 Open Science 能够验证的生成证据，并明确标记无法验证的证据。
- **多种模型选择。** 使用内置云服务商、兼容的自定义网关，或 Claude、Codex 订阅；在输入框中为每个会话选择模型及其推理强度。
- **本地优先所有权。** 应用和项目状态在你的计算机上运行；外部调用只通过你明确配置或批准的服务发生。
- **可检查。** 源代码、技能、连接器定义、工具活动、生成文件和产物来源都可供审查。
- **可扩展。** 添加技能和 MCP 连接器，无需等待封闭的插件路线图。
- **无席位许可证费用。** Open Science 是 Apache-2.0 软件。你只需支付所选择模型或基础设施的费用。

Open Science 是从零构建的独立产品，不是其他 AI 研究应用的代理、非官方客户端或换皮版本。

## 设计原则

Open Science 建立在七项设计原则之上，它们定义了代码、数据、模型和人工监督的配合方式：默认开放、明确的多服务商兼容性、本地优先的数据所有权、人工参与监督、持久研究记录、可组合能力，以及诚实的科学边界。

- **默认开放。** 源代码、格式、连接器和技能应保持可检查、可复刻。
- **明确兼容性的多服务商支持。** 应用会验证服务商配置并显示端点要求，而不会把所有 API 协议视为可互换。
- **本地优先且关注数据。** 将项目状态保留在本地，公开外部数据流，并让自主操作由用户选择启用。
- **人工参与。** 文件编辑、命令、网络访问和连接器调用均受明确批准配置约束。
- **持久研究记录。** 会话、工具活动、Notebook 历史和不可变产物版本应在运行结束后仍可审查，并清楚说明不可用的证据。
- **可组合能力。** 技能、连接器、模型、预览和未来计算后端应是可替换部件，而非一个黑盒。
- **诚实的科学边界。** 生成输出不能替代专家判断、统计审查或基于原始证据的验证。

## 核心能力

Open Science 在一个本地工作区中整合项目管理、多模型智能体执行、Python 和 R Notebook、科学数据连接器、带来源的不可变产物版本，以及受权限控制的人工参与机制。不断变化的目录、打包细节和新增选项应以已安装应用及[最新发行说明](https://github.com/aipoch/open-science/releases/latest)为准。

| 领域             | 核心能力                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **项目与会话**   | 新建、重命名和删除项目；置顶并维护多个会话；将已完成提示编辑为可持久保存、可选择的消息分支，而不删除原有下游路径；会话内持久侧边对话；生成并可编辑的会话详情（标题与描述）；恢复最近工作、草稿、对话历史和预览状态。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **智能体工作流** | 自然语言任务、流式响应、按声明目的分组的类型化工具活动卡片、带分类估算的实时上下文用量指示器、按需上下文压缩、跨重启持久化、停止控件、批准暂停、运行任务期间关闭或退出前的确认步骤（可记住偏好）、运行轮次期间用于暂存后续消息的输入框消息队列、统一的草稿撤销与重做历史、从已完成智能体消息分支到新会话、带关注原因的桌面通知以及持久未读对话徽章和阻塞批准的原生提醒、带持久读取状态并保留已删除目标的跨界面通知消息中心、处理多问题请求的结构化智能体澄清卡片（支持逐题答案回顾）、可将选定上下文发送到对话的文本、图像与 PDF 批注（选中的文本或区域在源文档中点击即可定位）、标记轮次之间智能体配置变更的时间线分隔符、展开时显示所加载技能文档的技能加载行、可将最多三个 PDF 关联为会话阅读上下文（让智能体阅读当前页、逐页浏览完整文档并跨文档检索）、跨会话召回项目范围知识的持久智能体记忆、智能体回复中来源链接的应用内安全预览、主页仪表板中的实时会话状态、带耗时和用量弹出框的消息时间元数据、逐轮词元用量（含逐模型调用用量详情与按调用划分的上下文窗口图表）、已完成轮次的智能体框架和模型标识、项目级命令面板、项目级框架读取、项目操作和智能体上下文、工作区项目菜单中列出其他活动项目并带标题与描述预览的项目快速切换器（列表增多后提供模糊搜索）、带会话标题与描述悬停预览的优化会话侧栏行、编辑器中引用其他会话的会话引用（`#`，按轮次授予只读访问）、注入正在运行主回合的侧边对话建议、全局搜索的会话编号查找、带持久执行契约以及 CLI 计划查看、批准和拒绝命令的审查门控会话计划、平滑实时响应渲染、可折叠侧面板、新建对话键盘快捷键，以及应用重启后恢复中断会话。 |
| **子智能体委派** | 生产级子智能体委派，支持持久消息和恢复；输入框的智能体控制中还有一个按会话生效的委派开关，决定智能体是否可以把工作委派出去。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **模型**         | 内置云服务商（包括 NVIDIA Build 及其精选的具备智能体能力的模型目录）、自定义兼容网关、Claude 和 Codex 订阅登录、连接验证、逐模型多模态图像输入、用于模型和模型所支持推理强度的按会话组合输入框选择器、涵盖子智能体/审查者/视觉策略的合并场景模型卡片、设置中仅用于新会话的默认值，以及带有供纯文本后端使用的持久图像证据中继的专用 Vision 模型选择器。可用服务商和 API 格式会针对所选智能体后端验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **智能体后端**   | 可选择智能体框架后端——Claude Code、OpenCode、Codex 或无需登录的 CodeBuddy 运行时——让同一工作区运行在多种底层智能体实现之上；服务商和模型选择会针对所选后端验证；应用管理的后端可在设置中安装、切换和移除；智能体感知的上下文重放在切换或恢复后遵循各框架的上下文路径。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **专家**         | 带限定范围能力的个人专家智能体配置、从主智能体即时进行中的交接、对话式定制、软件包导入/导出、不可变调用标识、基于名称生成且可验证覆盖的 ID，以及限定范围的专家市场；支持签名软件包验证、官方和用户批准的 GitHub 来源、CDN 回退、下载进度和导入时技能冲突解决。市场现已采用卡片网格布局与筛选标签，区分“已安装”与“市场”视图（单一主浏览入口与明确返回路径），可即时打开已验证缓存列表并手动刷新，支持从详情页直接安装，并提供共享能力图标、外观快速编辑和能力行导航。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **能力组织**     | 为技能、连接器和可运行专家提供跨资源标签，包含受保护的“收藏夹”标签、分配菜单、徽章、筛选器、可搜索的标签设置浏览器，以及持久化的指针或键盘拖拽排序。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **执行**         | 带持久代码/输出历史的 Python、R 和 REPL 控制平面内核，以及记录在同一运行历史中的无状态命令行命令；Notebook 与计算运行时的出站网络访问仅限 Open Science 默认域与用户批准的域，被阻止的目标会在对话中呈现以供批准，保护状态会在 Settings → Runtimes 中显示；用于智能体驱动评估的有界 REPL 推理；支持离线预置的应用管理环境，可在设置中安全重装受管运行时，并提供决定智能体是否可以创建运行时环境的全局开关；自带 Python 和 R 解释器；作为额外执行目标的远程 SSH 计算主机，支持密钥或密码认证（含 Windows）并使用操作系统加密存储凭据；与智能体共享的用户终端，输入时会从运行中的内核实时建议变量名；每个运行时环境的只读已安装软件包清单；运行中 Python 和 R 内核的只读实时变量浏览器；供智能体侧文件检查的 Notebook 产物读取；带耗时显示的软件包安装进度；以及长时间运行 Notebook 的渐进式历史加载。外部 R 运行时的软件包管理仍需手动完成。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **输入与文件**   | 文件附件（单个文件最大 10 GB，流式上传）、带索引分页的项目级文件库、会话分组、按来源限定的文件名搜索、网格与列表视图、用于大型项目的大型展开模态框、会话旁的拆分视图文件预览、生成产物卡片、使用 `@` 引用现有上传/输出、使用 `@path` 提及授予支持跨驱动器浏览、可编辑路径栏和驱动器切换器的本地文件夹访问、文件下载/导出、选择性会话产物下载、可精确还原的长文本粘贴附件、将对话导出为 Markdown 或 PDF，以及将会话导出为 `.ipynb`（按标签页或全部下载）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **产物与来源**   | 不可变、限定到会话的产物版本，包含内容校验和以及可用的生成代码、执行历史、准确输入引用、环境清单、生成消息分支上下文、产物沿袭访问和限定到版本的审查证据；支持版本导航和相关证据间的直接链接；列入白名单的文本产物与上传内容（Markdown、纯文本、脚本和源代码）可以按原始文本编辑，每次保存都会发布一个保留其来源沿袭的新版本，并通过 Compare 操作查看前一个版本。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **预览格式**     | 对常见科学数据、支持文本选择、区域选择、大纲与缩略图导航、文档搜索和页面导航的 PDF、Office 文档（DOCX、XLSX、PPTX）、图像（包括 TIFF，支持缩放和平移）、带语法高亮的源代码、分子结构与反应以及 Notebook 历史提供响应式多标签页预览；支持内联或全屏查看，提供右键标签页操作（关闭、关闭其他、下载、复制路径、另存为产物），并可通过“在上下文中查看”导航回生成产物的对话。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **本地数据管理** | 本地项目和应用数据、同时承载 Notebook 工作负载缓存的可配置存储位置、引导式迁移，以及带系统、手动和直连模式的全局代理设置；词元用量仪表板包含周期汇总、30 天活动热力图、每日输入/缓存/输出图表、逐运行用量归因，以及对主对话之外模型调用的覆盖（侧边对话、委派与上下文压缩）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **技能**         | **18 个精选**内置技能；名称不可变且使用小写连字符的个人技能；在会话中通过自然语言对话新建技能；从已完成对话轮次另存为技能；直接用户技能文件夹支持及带外软件包验证；按来源、状态和文本筛选的批量启用/停用管理；软件包上传；经认证的 GitHub 预览/导入；预览候选后导入已安装的全局技能；由智能体请求从会话附件或 GitHub URL 导入软件包；用于技能脚本且带结构化验证的 camelCase Host JavaScript API；带注册图形样式、多面板组合与论文叙事辅助工具的来源感知图形工作流；启用/停用控件；以及在会话中通过 `/` 明确选择。重新设计的技能面板统一了主智能体与专家筛选，使用真实用户头像堆叠与有界“使用者”弹窗，整合行操作，并支持经确认的批量删除，同时保护内置及专家关联技能。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **连接器**       | **24 个内置**研究连接器，具有运行时状态和恢复界面；自定义本地/远程 MCP 连接器使用与可编辑显示名称分离的不可变小写调用名称；提供基于名称生成且可验证覆盖的本地 ID、联系元数据、连接器/工具级权限，以及以占位符替换凭据的标准 MCP 客户端配置导入/导出。目录交互现采用与技能相同的紧凑管理模式。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **安全控制**     | `Ask for approval`、`Auto-approve edits` 和 `Full access` 对话配置；包含代码预览以及调用/对话决定的批准对话框；在当前回合持续生效的权限拒绝，阻止智能体通过其他路径重试或变相执行被拒绝的操作；持久化的全局、项目和会话级允许授权，支持筛选、逐行和按系列撤销以及撤销操作；针对 GitHub 令牌、连接器密钥与连接器登录的集中凭据管理，提供健康状态与引导式恢复；可供自定义连接器绑定而非自行存储副本的设备级共享凭据（API 密钥、访问令牌与 OAuth 登录）；可重新补齐缺失安全默认授权的恢复默认值操作；另有逐连接器和逐工具策略。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **审查与验证**   | 可选择启用的审查器根据已完成轮次自身的对话记录、执行日志和产物进行审计，报告通过/警告/失败结果，并可运行有界修复循环进行纠正；可配置审查模型策略，可跟随活动模型或固定专用服务商、模型和推理强度；持久化审查评估快照保留纠正归因。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **分发与支持**   | macOS、Windows 和 Linux 安装程序；针对环境、数据位置、智能体运行时、模型服务商和 Notebook 运行时的精简首次启动向导；支持德语、西班牙语、法语、简体中文、繁体中文、日语、韩语和俄语界面，为每种受支持语言提供 README 译本，并另有多语言贡献指南；带醒目更新提醒的更新指引；本地诊断；社区链接。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 模型服务商

Open Science 在产品层面不限定模型：可连接主要云端 LLM 服务商、自定义网关，或复用现有 Claude、Codex 订阅。当前可用服务商取决于所选智能体后端及其支持的 API 协议。模型有四种连接方式：

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

Open Science 将项目数据、设置、产物版本和来源证据存储在本地计算机上。API Key 保存在本地，并在操作系统支持时使用其安全凭据存储。日志保存在本地，不会自动上传。

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

Open Science 是持续开发中的桌面应用，可用于 macOS、Windows 和 Linux。开发重点是可靠的本地优先研究工作流、可扩展科学能力、可追溯研究产物以及用户控制的执行。

有关当前下载和特定版本变更，请查看[最新版本](https://github.com/aipoch/open-science/releases/latest)。有关已交付、部分实现和计划能力，请查看[能力地图](../../ROADMAP.md#capability-map)。

Open Science 辅助研究执行和记录保存；研究人员仍需对方法、解释、隐私和科学有效性负责。

## 开发与打包

Open Science 是使用 React、TypeScript、Prisma/SQLite 和基于 ACP 的智能体运行时构建的 Electron 应用。

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

可以通过 Remote.It 配对，从手机或平板电脑访问同一 localhost Web UI。使用六位 Open Science 代码配对浏览器，并在桌面端批准一次；无需直接暴露回环服务器，工作区即可保持可访问。浏览器信任可撤销，模式变更或服务关闭会立即使活动远程会话失效。

### 无界面 CLI 和 SDK

无界面 CLI 和零依赖 Node.js SDK 与桌面及 Web 界面使用同一本地守护进程、项目、会话、凭据和权限。详细用法与可发布软件包保存在一起，因此只需维护一份命令参考：

- [CLI 指南](../../packages/open-science/CLI.md) — 安装、服务生命周期、任务自动化、产物、输出格式和退出码
- [SDK 软件包概览](../../packages/open-science/README.md) — Node.js 快速开始和软件包入口点

## 路线图

产品路线图和能力状态维护在 [ROADMAP.md](../../ROADMAP.md) 中。本 README 不重复不断变化的优先级或版本目标列表。

## 与 AIPOCH 生态系统的关系

<img width="1920" height="1140" alt="Open Science 作为开放科学 AI 工作流桌面编排层融入 AIPOCH 生态系统的方式" src="https://github.com/user-attachments/assets/0ab847b1-1b7d-43f4-8c11-480a578e6c7d" />

[AIPOCH](https://aipoch.com/)（[GitHub 组织](https://github.com/aipoch)）将 [Open Science](https://aipoch.com/open-science) 打造为开放科学 AI 工作流的桌面编排层。

- [aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills) 是包含 500 多个文件型医学和科学研究技能的更大集合；所有技能都可以检查、导入，并从 GitHub 与 Open Science 搭配使用。
- Open Science 提供项目/会话工作区、智能体运行时、执行、产物、预览、权限和连接器，将这些指令转变为交互式工作流。

技能和连接器可能执行代码或向外部发送数据。启用前检查其源代码、许可证、脚本和网络行为。

## Open Science 不是什么

Open Science 是研究执行和记录保存工具，而非通用聊天套壳、非官方客户端或科学审查的替代品。

- **不只是聊天 UI。** 产品围绕持久项目、执行、文件、产物和可审查工具活动组织。
- **不是其他产品的非官方客户端。** 它是独立实现，拥有自己的代码库、数据模型、界面和路线图。
- **不能替代科学判断。** 输出仍需要领域审查、统计验证以及与原始资料核对。

## 常见问题

### 首次打开 Open Science 时应该做什么？

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

答：打开生成产物并选择 **Provenance**。选择一个版本，以检查内容标识及可用的生成代码、执行历史、输入、环境清单、生成对话上下文和审查证据。Open Science 无法验证的证据会标记为不可用。

### 能否修改较早的请求而不丢失后续对话？

答：可以。编辑已完成的用户消息并重新发送，从该位置新建分支。原有后续轮次仍然可用，消息旁的修订箭头可在不同路径之间切换。

### 我的研究数据会保留在计算机上吗？

答：项目、会话、文件、设置和已配置凭据默认存储在本地。模型请求、网页搜索或连接器调用所需内容仍可能发送给你选择的外部服务，因此运行任务前应检查敏感输入和服务商政策。

## 参与项目

Open Science 通过 GitHub、Discord、X 和 AIPOCH 网站接收缺陷报告、功能建议、设计讨论、社区问题和项目贡献。请选择最符合你目标的渠道，并在公开分享项目详情前查看相关贡献指南与公开发布安全提醒。

| 渠道                                                                     | 用途                               |
| ------------------------------------------------------------------------ | ---------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 缺陷、可复现故障和具体功能建议     |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 设计问题、路线图提议和较长技术讨论 |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 社区帮助、贡献者协调和非正式讨论   |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 版本公告和公开构建动态             |
| [Open Science 官网](https://aipoch.com/open-science)                     | 官方产品概览与下载                 |

提交公开问题前，从日志和截图中移除 API Key、令牌、私有文件路径、未公开数据、患者标识符和其他敏感材料。开发工作流请参阅[贡献指南](CONTRIBUTING.md)。

> ⭐ **Star 仓库：** 如果本项目对你有帮助，欢迎在 GitHub 上 Star。Star 仓库可以鼓励项目持续开发，只需片刻，却会对项目产生切实影响。

## 许可证

Apache License 2.0 — 参阅 [LICENSE](../../LICENSE)。
