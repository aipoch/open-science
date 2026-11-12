<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AIPOCH Open-Science 是一款面向可复现科学研究的本地优先、开源 AI 研究工作台，支持灵活选择模型。将选定的研究内容导出为可移交的 <code>.science</code> 包，让他人检查研究记录。
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">
    <img width="720" alt="AIPOCH Open-Science Research Generation Demo — .science 包生成演示" src="../images/readme/demo-full.webp" />
  </a>
</p>

<p align="center">在 YouTube 观看: <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">AIPOCH Open-Science: Generating .science Research Packages (Demo)</a></p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="下载 AIPOCH Open-Science" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="AIPOCH Open-Science 最新版本" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="AIPOCH Open-Science Zenodo DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science arXiv 预印本：2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#基准测试表现">
    <img alt="AIPOCH Open-Science — 基准测试结果" src="../images/readme/benchmark-comparisons.svg">
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

### 💡 AIPOCH Open-Science v1.2.1 更新

_2026 年 11 月 11 日_

- **统一资源中心**：集中管理技能、连接器、专家及市场安装；Web 界面也支持从市场安装。
- **手动优化提示词**：从输入区调用已配置的服务商，审阅、编辑或撤销结果；自定义模板保存在项目设置中。
- **内置智能体升级**：主智能体和子智能体可使用 Codex 订阅；新增支持 1M 词元上下文的 Claude Fable 5.2，并采用服务商支持的输出上限。
- **文献 CSV 导出**：导出选中文献、整个项目或文献集的元数据，使用 16 个固定英文列名。
- **紧凑研究导出**：Notebook 和 Compute 对相同内容的证据只存储一次，缩小长篇 `.science` 记录并加快导出。
- **云端计算登录**：Modal 和 Hugging Face 在浏览器授权前准备兼容的 Python，账户验证使用系统代理。
- **可靠性改进**：改善 Windows 更新恢复、回答提问后的继续执行及切换会话时的研究影片生成；会话无活动 15 分钟后回收空闲解释器。

[查看 v1.2.1 完整版本说明](https://github.com/aipoch/open-science/releases/tag/v1.2.1)

## 🚀 快速开始

### 1. 下载应用

打开[官方应用下载页面](https://aipoch.com/open-science/download)，并选择适合你计算机的安装程序：

| 你的计算机                              | 选择                                      |
| --------------------------------------- | ----------------------------------------- |
| macOS 12+ — Apple 芯片（M1 或更新型号） | 适用于 Apple Silicon / ARM64 的 macOS DMG |
| macOS 12+ — Intel                       | 适用于 Intel / x64 的 macOS DMG           |
| Windows 10/11 x64                       | Windows x64 安装程序（已代码签名）        |
| Linux x64                               | Linux x64 AppImage 或 Debian 软件包       |
| Linux ARM64                             | Linux ARM64 AppImage 或 Debian 软件包     |

安装前的校验方法见[验证下载](../../SECURITY.md#verifying-your-download)。

macOS 用户也可以通过 [Homebrew](https://brew.sh) 安装：

```bash
brew install --cask open-science
```

macOS 或 Linux 的独立 CLI 使用单独的 [AIPOCH tap](https://github.com/aipoch/homebrew-tap)：

```bash
brew install aipoch/tap/open-science
```

该 Formula 自带 Node，无需启动桌面应用；其版本可能与桌面 Cask 不同。前提条件与升级方式见[独立运行时指南](../standalone-runtime.md)。

也可从 [GitHub Release 的 Assets](https://github.com/aipoch/open-science/releases/latest) 下载自带 Node.js 的独立 CLI 压缩包，适用于 macOS 和 Linux（ARM64 或 x64）以及 Windows x64。

如需独立 CLI 和 Web 界面，可使用 **Node.js 22.13.0 或更高版本**安装已发布的 [npm 软件包](https://www.npmjs.com/package/@aipoch/open-science)：

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

打开输出的 URL 完成配置，或按照[命令行配置指南](../../packages/open-science/CLI.md#first-run-setup-codex)操作。npm 支持 macOS ARM64/x64、使用 glibc 的 Linux ARM64/x64 和 Windows x64，无需安装桌面应用。请保留 npm 可选依赖，并查看 [Linux 前置条件和升级说明](../standalone-runtime.md#install-from-npm)。该 URL 包含身份验证令牌，请勿分享。

Windows 重装会保留研究数据；如需彻底清理，请参阅[数据重置工具](../../scripts/windows-reset/README.md)，确认后会永久删除本地数据。

### 2. 完成首次设置

按向导依次完成：**环境 → 数据位置 → 智能体运行时 → 模型服务商 → Notebook 运行时**。

完成必需的环境和智能体运行时检查，并测试模型连接。Python/R Notebook 配置可选；Notebook 和数据位置都可稍后在设置中调整。

首次设置完成后，可在系统设置中调整外观和通知。在通用设置中可查看应用信息、诊断和命令行工具，也能打开手动安装与更新指南。

原“模型”设置页现更名为**本地能力**，集中管理 PDF 提取、OCR 语言包和研究语音讲解；语音讲解需要本地安装的语音模型。

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

## AIPOCH Open-Science `.science` 包

将已完成的研究会话导出为可移植的 `.science` 包，用于审阅、交接和归档。选择要纳入的对话分支、文件版本、Notebook 记录和验证证据，然后将包导入其他项目或计算机。

桌面应用、本地 Web 会话和无界面 CLI 均支持导出与导入。远程 Web 会话无法从任意本地路径读取或写入 `.science` 包。

**导出 → 传递 → 检查**

1. 导出已完成的会话，并选择要纳入的内容。
2. 将 `.science` 文件传递给协作者，或转移到另一台计算机。
3. 将它导入项目。右侧的 **Research replay** 展示记录过程，左侧对话可针对记录提问并引用固定步骤。

导入记录保持只读；浏览回放不会执行代码、调用模型或恢复凭据。首次提问会创建关联的可写讨论；使用 **Fork to continue** 创建副本后可继续研究。重新运行结果仍需要完整配方、必要输入和可用运行环境。

从导入研究或回放步骤提问会创建关联该步骤的子讨论，不修改导入记录。讨论在归档后保留；删除父会话后会转为普通会话。

Side Chat 对话、私人阅读书签和凭据不随包导出，所含文件取决于导出选择。收到的验证记录描述发送方执行过的检查，不代表接收计算机已重新运行。详见 [`.science` 包指南](https://aipoch.com/docs/guides/research-packages/)。

<a id="基准测试表现"></a>

## 基准测试结果

AIPOCH 对 AIPOCH Open-Science 进行了评测，任务涵盖查找论文、回答论文内容相关问题和执行研究计划。以下结果来自 AIPOCH 自行开展的测试，每项成绩对应特定任务与评测配置。 评测还覆盖计算复现和基于数据的假设发现。

| 任务             | AIPOCH Open-Science 的结果                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 找到目标论文     | 在 LitQA2-FullText-Search 的 **75 道测试题中，有 68 道的目标论文出现在前 30 条结果中**（**Recall@30 为 90.67%**，gpt-6-astra）。            |
| 根据文献回答问题 | 在独立的 LitQA2-FullText 测试中，Open-Science **答对 75 题中的 70 题**（**准确率 93.33%**，deepseek-flash，Max 推理）。                     |
| 综合带引用的答案 | 使用 deepseek-v4-flash，在 ScholarQA-CS2 的 100 道验证题上获得 **0.9289/1 的综合质量分数**。官方测试参考结果使用不同的题目。                |
| 执行研究流程     | 在使用相同模型的本地 ASI-Bench 测试中，Open-Science 的 B4 得分为 **59.46**，Codex 为 **55.45**。B2 得分几乎相同（**56.11** 与 **56.09**）。 |
| 分析生物医学数据 | 在 BiomniBench-DA Public 50 上，两位评审模型的评分分别为 **81.04** 和 **77.06**，等权平均为 **79.05**。                                     |
| 复现已发表的结果 | CORE-Bench-Hard — 本地评测答对 37 项测试任务中的 36 项（97.30%），最终统计包含复测。                                                        |
| 根据数据提出假设 | DiscoveryBench — 在验证集的 25 项任务上，本地模型评分的均值为 0.7467/1。                                                                    |

### AstaBench — 文献任务

<details>
<summary><strong>论文检索 — 为 75 道题中的 68 道找到目标论文</strong></summary>

AIPOCH 在本地运行了官方 LitQA2-FullText-Search 的 75 题 Test 集。其 Recall@30 与 2026 年 10 月 26 日对比快照中的最高值相同。这次本地测试未提交至官方榜单，也不代表官方排名。

![AIPOCH Open-Science LitQA2 检索对比：官方 Test 集上的本地 Recall@30 为 90.67%](../images/readme/astabench-litqa2-test.jpg)

Recall@30 在目标论文出现在前 30 条结果中时计为命中，不衡量答案准确率。各次测试的成本核算未统一。

</details>

<details>
<summary><strong>全文问答 — 75 题中答对 70 题</strong></summary>

AIPOCH 运行了 AstaBench v0.5.4 中 LitQA2-FullText 的 75 题 Test 集。图表按分数排列本地结果与历史参考记录，其中的“#1”指这组对比的排序。

![AIPOCH Open-Science LitQA2 全文问答对比：本地准确率 93.33%](../images/readme/astabench-litqa2-fulltext-local-comparison.png)

准确率衡量回答正确的比例。此处 93.33% 是本地问答准确率，90.67% 是历史参考问答准确率，与上方检索图的指标不同。参考记录采集于 2026 年 10 月 28 日，最高参考分数于 11 月 2 日再次核对。

</details>

<details>
<summary><strong>引用答案质量 — 本地验证结果与官方测试参考</strong></summary>

本地 ScholarQA-CS2 结果衡量 100 道 Validation 题上的引用答案质量。参考成绩来自 Test 集，因此这些分数不能构成直接对决排名。

![AIPOCH Open-Science ScholarQA-CS2 对比：本地 Validation 综合得分 0.9289，与官方 Test 参考结果分开展示](../images/readme/astabench-scholarqa-cs2.jpg)

综合分数的范围为 0–1，并非完全答对题目的百分比。

</details>

### AstaBench — 计算复现与假设发现

<details>
<summary><strong>CORE-Bench-Hard — 36/37</strong></summary>

11 月 6 日，AIPOCH 使用 DeepSeek Flash（Max 推理）复现论文结果，依据所给代码、数据和 README 执行任务。官方程序评分器在本地运行，一项任务的所有必答项均正确才得 1 分。37 项均获评分，含复测。 [AIPOCH](https://aipoch.com/blog/aipoch-open-science-core-bench-hard).

</details>

<details>
<summary><strong>DiscoveryBench — 0.7467/1</strong></summary>

11 月 9 日，AIPOCH 使用 deepseek-v4-flash 生成假设，并用同一模型按本地实现的评测流程评分。25 项中，18 项满分、2 项部分得分、5 项零分。题集和评分模型均与官方完整测试不同，分数不能直接排名。

</details>

### ASI-Bench — 执行计划与选择方法

四种条件分别要求智能体执行指定计划（B1）、组织工作流程（B2）、选择研究方法（B3），以及在干扰信息下开展研究（B4）。图表前两行比较使用相同 GPT-6 Astra 模型的本地测试。

![AIPOCH Open-Science ASI-Bench B1–B4 结果与本地 Codex 测试及已发表参考结果](../images/readme/asi-bench-b1-b4.jpg)

Open-Science 在 B1–B4 上分别获得 **79.35、56.11、59.67 和 59.46**；本地 Codex 参考成绩为 **74.78、56.09、58.12 和 55.45**。B2 得分几乎相同。其他已发表测试在任务实例、配置或评判方式上存在差异。

本地 B1 因评分器问题排除一项任务后，计入 59 项任务。B1/B2 报告了三次本地重复测试。B3/B4 使用 Open-Science v0.32.0 和替代评审模型，各项得分为三次、每次 60 项任务的平均值。

### BiomniBench-DA — 生物医学数据分析

在 Public 50 任务集上，Gemini 3.1 Pro 评审模型对输出评分 **81.04**，DeepSeek v4-pro 评审模型评分 **77.06**。AIPOCH 报告了 gpt-5.6-sol（xhigh）配置的等权平均分 **79.05**。

<details>
<summary><strong>评审分数与历史参考 — 评审覆盖范围不同</strong></summary>

图表汇集了评审覆盖范围不同的记录，其中的“#1”描述这组记录的排序。要在统一评判流程下排名，需要对所有记录采用可比的评分方式。

![AIPOCH Open-Science BiomniBench-DA Public 50 对比，展示两位评审模型的分数及平均值](../images/readme/biomnibench-public50-leaderboard.png)

79.05 是这次内部评测的平均评审分数。

</details>

**评测范围：** 报告涵盖 2026 年 8 月至 11 月、使用所列模型与数据划分开展的本地或内部测试，并未针对当前版本重新运行。参考成绩是历史快照，并非实时排名。不同基准系列的分数不能直接比较，数值差距不代表统计显著性。

评测详情见 [AstaBench 与 ASI-Bench 报告](https://aipoch.com/benchmark/open-science)及 [BiomniBench-DA 报告](https://aipoch.com/blog/open-science-biomnibench-da)。

<a id="核心能力"></a>

## 为什么使用 AIPOCH Open-Science？

1. **在一个项目里读论文、分析数据。**
   - 从 Zotero 导入文献，或一次粘贴最多 100 个文献标识符或文章链接。配置筛选模型后，可按纳入和排除标准筛选文献，对照模型和自己的判断，再打开 PDF 核对原文。
   - 在论文旁预览科学数据、文档、图像和分子结构。在笔记本中运行 Python 或 R，将项目数据整理成表格或图，再对照源文件检查结果。

2. **查看结果如何生成，以及回答有哪些依据。**
   - 在「溯源」中打开某个版本的图、表或报告，查看可用的输入、代码和执行历史。输入、执行步骤和运行环境齐备时，可在桌面端重跑该版本并比较输出。
   - 启用 Reviewer，让它独立对照本轮执行日志和文件检查智能体的回答。你可以查看它指出的问题，以及智能体修正后的复查结果。

3. **把结果连同上下文一起交给同事。**
   - 选择要放入 `.science` 包的对话分支、文件版本、Notebook 记录和验证证据。同事可以在另一台电脑上打开包，查看一张图或表是怎样生成的。
   - 导入的记录为只读，导入时不会执行代码或恢复凭据。验证记录展示发送方电脑上的检查。要追问新问题，同事可选择 **Fork to continue**，在可写副本中继续。

4. **为分析选择工具和算力。**
   - 选择模型服务商，通过 **48 个内置连接器**访问科学数据源。部分连接器需要先手动启用。
   - 使用 **24 个内置技能**处理重复任务，也可从 [技能市场](https://github.com/aipoch/openscience-skill-marketplace) 的 **525 个技能**中选择安装。需要委派部分工作时，可从[专家市场](https://github.com/aipoch/openscience-specialist-marketplace)选择 **10 个专家**中的一个。
   - 在本地运行分析，或通过 SSH、Slurm、Kubernetes、Hugging Face Jobs、Modal 或 Ray 提交到你管理的计算环境。批准远程任务前先核对目标、命令、资源和输出。云任务可能产生费用，由关联账户承担。

## 模型服务商

AIPOCH Open-Science 在产品层面不限定模型：可连接主要云端 LLM 服务商、自定义网关，或复用现有 Claude、Codex 订阅。当前可用服务商取决于所选智能体后端及其支持的 API 协议。可使用以下连接方式：

| 服务商模式           | 工作方式                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **内置云服务商**     | 从已安装应用显示的服务商列表中选择，并使用要求的密钥进行认证。                                                                                                                                                                                                                                                       |
| **自定义网关**       | 提供 Base URL 和准确模型 ID，选择智能体后端支持的 API 协议（Messages、Chat Completions 或 Responses），然后执行连接测试。远程网关要求 HTTPS 和 API Key；`localhost`、`127.0.0.1` 或 `[::1]` 等回环端点可以使用 HTTP 并省略密钥。预设包括 Ollama、LM Studio、llama.cpp 和 vLLM。默认 API 格式不保证服务器或模型兼容。 |
| **Codex 订阅**       | 选择 Open-Science Agent 或 Codex，然后在服务商类型中选择 Codex 订阅。可导入现有 Codex 登录，或通过 Open-Science 登录。                                                                                                                                                                                               |
| **Claude 订阅**      | 通过两种模式登录 Claude 订阅：**共享**（浏览器登录，将凭据存入默认 `~/.claude` 配置）或**隔离**（应用在自有 `CLAUDE_CONFIG_DIR` 下管理 `claude setup-token`，与 `~/.claude/` 完全隔离，并提供浏览器流程和粘贴令牌的回退方式）。                                                                                      |
| **xAI (Grok) OAuth** | 使用内置的 xAI (Grok) OAuth 设备登录。可用性取决于 xAI 账户权限和所选后端支持的协议，请在应用中验证连接。                                                                                                                                                                                                            |

有 25 个预设服务商选项，包括 OpenAI、Anthropic、DeepSeek、NVIDIA Build 等；可用模型和地区端点取决于安装版本及所选智能体后端。请以应用中的服务商选择器和连接测试为准。

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

AIPOCH Open-Science 由普通 Node 后端和 Electron 桌面客户端组成，使用 React、TypeScript、Prisma/SQLite 及内置 Open-Science Agent 与可选智能体后端。

源代码开发前提条件：

- Node.js 24（参见 [`.nvmrc`](../../.nvmrc)）及 npm
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

Web 界面运行在普通 Node 后端上，无需 Electron 或图形显示。

```bash
npm run dev:web
npm run pack:backend
```

Web 界面运行在普通 Node 后端上，无需 Electron 或图形显示。`npm run dev:web` 和 `npm run dev:headless` 会构建并启动后端及 Web 界面，不启动桌面或托盘。`OPEN_SCIENCE_WEB_PORT` 选择端口（默认 `44100`）；Ctrl+C 正常关闭前台服务。

源码开发需要 Node.js 24。已发布的 npm 软件包和本地构建的独立 tarball 均需要 Node.js >=22.13.0。Release 压缩包、Homebrew Formula 和桌面命令启动器自带运行时。

桌面与浏览器共享同一服务。应用连接及 `open-science start` 的显式保活请求会维持服务运行；退出最后一个应用时，只有不存在显式保活请求，服务才会停止。

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### 移动端远程访问

扫描二维码，即可通过本地 WiFi 或 Pinggy 隧道，在手机或平板上打开当前工作区。本地 WiFi 配对的通信留在本地网络内；互联网隧道的流量经过 Pinggy 服务器，连接对话框会说明这一中继路径。

### 无界面 CLI 和 SDK

无界面 CLI 和零依赖 Node.js SDK 与桌面及 Web 界面使用同一本地守护进程、项目、会话、凭据和权限。详细用法与可发布软件包保存在一起，因此只需维护一份命令参考：

- [CLI 指南](../../packages/open-science/CLI.md) — 安装、服务生命周期、任务自动化、产物、输出格式和退出码
- [SDK 软件包概览](../../packages/open-science/README.md) — Node.js 快速开始和软件包入口点

独立 CLI 可通过 `open-science mcp` 向外部 MCP 客户端提供研究工具。请先启动并完成所选配置文件对应服务的身份验证。适配器沿用该配置文件的现有权限，并不是独立沙箱或只读视图，因此已连接的客户端可以写入更改并产生模型费用。它不提供任意 Shell 或 RPC 访问、凭据管理、文件导入或导出、下载到指定路径，也不提供远程 HTTP MCP 端点。

## 常见问题

<a id="为什么模型连接测试失败"></a>

<details>
<summary>为什么模型连接测试失败？</summary>

答：检查 API Key 是否缺少字符或含有空格，验证 Base URL 和地区，使用服务商准确的模型 ID，并确认网络访问和账户余额。对于 Claude 订阅，根据所选模式重新尝试共享浏览器登录，或刷新隔离的 `claude setup-token` 凭据。

</details>

<a id="为什么设置期间-continue-被禁用"></a>

<details>
<summary>为什么设置期间 <code>Continue</code> 被禁用？</summary>

答：当前步骤尚未满足必需条件。根据活动步骤，修复标记为 `Action needed` 的环境行，安装或修复所选智能体运行时，或验证模型服务商。Notebook 设置是可选的，只影响 Notebook 执行。

</details>

<a id="如何在远程-hpc-集群上运行任务"></a>

<details>
<summary>如何在远程 HPC 集群上运行任务？</summary>

答：**Remote Compute (SSH)** 始终启用，无需在 Settings 中手动启用。先在 **Settings → Connections → Compute** 中注册 SSH 计算主机并使其对当前会话可用，然后通过自然语言或 `/remote-compute-ssh` 使用远程计算。你需要可访问的 SSH 主机、有效认证、所需目录的访问权限，以及任务所需的软件、依赖和计算资源。Direct SSH 不要求调度器；Slurm 模式要求可用的 Slurm 环境和作业提交权限。“始终启用”仅指该 Skill，不代表所有已注册主机始终可用。

自行连接的 Kubernetes、Hugging Face Jobs、Modal 和 Ray 目标也受支持。每次外部提交前需批准目标、命令、资源和输出；恢复记录可在重启后继续收集结果，已发布结果可从 Compute Preview 打开。需自行准备账户、软件、资源和权限，云端任务可能产生费用。

</details>

<a id="是否提供命令行界面"></a>

<details>
<summary>是否提供命令行界面？</summary>

答：支持。安装独立 CLI，或使用 **设置 → 通用 → 命令行工具 → 安装命令** 控制已经运行的桌面实例。通过 npm 安装需要 Node.js；Homebrew 和自带运行时的独立发行包已包含 Node.js。初始化本地配置后，无需打开浏览器即可控制服务并提交科研任务：

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

</details>

<a id="如何检查生成结果的来源"></a>

<details>
<summary>如何检查生成结果的来源？</summary>

答：打开生成产物并选择 **Provenance**。选择一个版本，以检查内容标识及可用的生成代码、执行历史、输入、环境清单、生成对话上下文和审查证据。AIPOCH Open-Science 无法验证的证据会标记为不可用。

</details>

<a id="能否修改较早的请求而不丢失后续对话"></a>

<details>
<summary>能否修改较早的请求而不丢失后续对话？</summary>

答：可以。编辑已完成的用户消息并重新发送，从该位置新建分支。原有后续轮次仍然可用，消息旁的修订箭头可在不同路径之间切换。

</details>

## 贡献者

感谢所有为 AIPOCH Open-Science 贡献代码、文档、翻译、缺陷报告和社区支持的朋友。

[查看 GitHub 贡献者](https://github.com/aipoch/open-science/graphs/contributors)

[![AIPOCH Open-Science 贡献者](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## 参与项目

通过报告问题、建议功能、提问或贡献内容，一起改进 AIPOCH Open-Science。选择下方适合的渠道开始参与。

| 渠道                                                                     | 用途                               |
| ------------------------------------------------------------------------ | ---------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 缺陷、可复现故障和具体功能建议     |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 设计问题、路线图提议和较长技术讨论 |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 社区帮助、贡献者协调和非正式讨论   |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 版本公告和公开构建动态             |
| [AIPOCH Open-Science 官网](https://aipoch.com/open-science)              | 官方产品概览与下载                 |

提交公开问题前，从日志和截图中移除 API Key、令牌、私有文件路径、未公开数据、患者标识符和其他敏感材料。开发工作流请参阅[贡献指南](../../CONTRIBUTING.md)。

> 如果 AIPOCH Open-Science 对你有帮助，欢迎在 GitHub 上为仓库 Star。

已交付、部分实现和计划能力见[能力地图](../ROADMAP.md#capability-map)。

<a id="aipoch-open-science-论文与引用"></a>

## 引用

如果你的研究使用了 AIPOCH Open-Science，请引用[AIPOCH Open-Science 预印本](https://arxiv.org/abs/2610.17110)。

<details>
<summary>BibTeX 引用</summary>

```bibtex
@misc{ouyang2026aipochopenscienceopensourceai,
      title={AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages},
      author={Wen Ouyang and Bocheng Huang and Qianyu Yao and Fei Sun and Minying Deng and Haoyue Cheng and Wenwen Zhou and Lei Mou and Yusi Wei and Jiang Li and Kun Zhu and Lei Wang and Yi Feng and Jiaheng Dai and Ke Qian and Dan Wang and Yahui Wang and Chenyi Wang and Mingsheng Lyu and Yaqiang Zhang and Ping Zheng and Chunhua Tang and Xinge Ma and Xu Zhang and Youjia Fan and Can Lu and Zhijun Dai and Man Hu and Qiqi Xie and Beinan Liu and Yuanning Guo and Yunze Liu and Jinhong Jiang and Xianjun Fu and Mingwei Zhang and Yuanji Xu and Shilin Xia and Bowen Yang and Mingjun Yu and Jingdun Xie and Xuwei Chen and Xia Zou and Yuzhou Xue and Jianguo Zhou and Chunhao Cao and Donghao Tian and Lei Huang and Jinxiao Li and Shengrong Long and Zefeng Song and Honglin Li and Jiang Luo and Wenying Jiang and Shanshan Li and Lei Dai and Ning Jiang and Ying Cai and Chaohui Li and Chunyan Peng and Hetong Zhao and Angqing Li and Chunyan Yang and Chongyang Sun and Yong Li and Xinyu Shi and Wei Dai and Ming Peng and Chen Sang and Yuanyuan Han and Desong Qiu and Haixin Miao and Jian Xu and Yi Chen and Xiaoliang Shi and Tian Shen and Teng Hu and Shuhao Wang and Yingyong Hou and Huimei Wang},
      year={2026},
      eprint={2610.17110},
      archivePrefix={arXiv},
      primaryClass={cs.SE},
      url={https://arxiv.org/abs/2610.17110},
}
```

</details>

## 许可证

Apache License 2.0 — 参阅 [LICENSE](../../LICENSE)。
