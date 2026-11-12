<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AIPOCH Open-Science is a local-first open-source AI research workbench for reproducible science, with flexible model backends. Share a portable <code>.science</code> Research Package so others can inspect the evidence behind a result, or export a Research Film to show how you reached it.
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">
    <img width="720" alt="AIPOCH Research Generation Demo — AIPOCH Open-Science .science Research Package" src="docs/images/readme/demo-full.webp" />
  </a>
</p>

<p align="center">Watch on YouTube: <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">AIPOCH Open-Science: Generating .science Research Packages (Demo)</a></p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="Download AIPOCH Open-Science" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Latest AIPOCH Open-Science version" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="AIPOCH Open-Science Zenodo DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science preprint on arXiv: 2610.17110" src="docs/images/readme/arxiv-preprint.svg">
  </a>
  <a href="#benchmark-performance">
    <img alt="AIPOCH Open-Science — Benchmark results" src="docs/images/readme/benchmark-comparisons.svg">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Platforms macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="LICENSE">
    <img alt="License Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="Website aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
</p>

<p align="center">
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./docs/zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./docs/zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./docs/ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="./docs/ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="./docs/fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./docs/ru/README.md"><img alt="README на русском" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="./docs/de/README.md"><img alt="German README" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./docs/es/README.md"><img alt="Español README" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

### 💡 AIPOCH Open-Science v1.2.1 updates

_November 11, 2026_

- **Unified Resource Center**: Manage skills, connectors, specialists, and Marketplace installs together; installation also works in the Web UI.
- **Manual prompt optimization**: Invoke your configured provider from the composer, review or edit the result, and undo it; save custom templates in Project settings.
- **Built-in Agent upgrades**: Use Codex subscriptions for the main agent and subagents, select Claude Fable 5.2 with a 1M context window, and use provider-supported output limits.
- **Bibliography CSV**: Export selected references or a whole project or collection with 16 stable English column names.
- **Compact research exports**: Notebook and Compute histories store unique evidence once, reducing the size and export time of long `.science` histories.
- **Cloud compute sign-in**: Modal and Hugging Face prepare compatible Python before browser authorization; account verification follows the system proxy.
- **Reliability improvements**: Windows update recovery, answered questions, and research films across session switches improve; idle interpreters are reclaimed after 15 minutes without session activity.

[View the full v1.2.1 release notes](https://github.com/aipoch/open-science/releases/tag/v1.2.1)

<a id="share-your-research"></a>

## A research record to share, a film to watch

**Hand off a result with a [`.science` package](https://aipoch.com/docs/guides/research-packages/).** Export the conversation branches, file versions, Notebook records, and verification evidence you want to share. Recipients can import the package into their own projects, open the read-only record, and trace a figure or table back to its inputs. Verification records describe the sender’s checks. In the desktop app, **Fork to continue** creates a writable copy.

**Present the same work as a [Research Film](https://aipoch.com/docs/guides/research-films/).** In the desktop app, choose **Generate research film** on a completed conversation branch. Your configured model prepares the presentation from the recorded session, and the local speech engine generates English narration. Review the film, then download the HTML player or export an MP4. A `.science` package can also carry the player for a film already generated on an included branch.

## 🚀 Quick Start

### 1. Download the app

Open the [official download page](https://aipoch.com/open-science/download) and choose the installer for your computer:

| Your computer                           | Choose                                     |
| --------------------------------------- | ------------------------------------------ |
| macOS 12+ — Apple Silicon (M1 or newer) | The macOS DMG for Apple Silicon / ARM64    |
| macOS 12+ — Intel                       | The macOS DMG for Intel / x64              |
| Windows 10/11 x64                       | The Windows x64 installer (code-signed)    |
| Linux x64                               | The Linux x64 AppImage or Debian package   |
| Linux ARM64                             | The Linux ARM64 AppImage or Debian package |

See [download verification](SECURITY.md#verifying-your-download) for checks before installation.

On macOS, you can also install with [Homebrew](https://brew.sh):

```bash
brew install --cask open-science
```

The [release assets](https://github.com/aipoch/open-science/releases/latest) include standalone CLI archives for macOS, Linux, and Windows. They bundle Node.js, so you can run the CLI without installing Node.js, npm, or Homebrew.

For the standalone CLI on macOS or Linux, use the separate [AIPOCH tap](https://github.com/aipoch/homebrew-tap):

```bash
brew install aipoch/tap/open-science
```

This Formula includes Node and runs without the desktop app; its release may differ from the desktop Cask. See the [standalone runtime guide](docs/standalone-runtime.md) for prerequisites and upgrades.

For the standalone CLI and Web UI, install the published [npm package](https://www.npmjs.com/package/@aipoch/open-science) with **Node.js 22.13.0 or later**:

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

Open the printed URL to complete setup, or follow the [terminal setup guide](packages/open-science/CLI.md#first-run-setup-codex). npm supports macOS ARM64/x64, glibc Linux ARM64/x64 and Windows x64; the desktop app is not required. Keep npm optional dependencies enabled and review the [Linux prerequisites and upgrade instructions](docs/standalone-runtime.md#install-from-npm). The URL contains an authentication token; keep it private.

Windows reinstalls preserve research data. For a full cleanup, see the [data reset tool](scripts/windows-reset/README.md), which permanently deletes local data after confirmation.

### 2. Complete first-time setup

Follow the setup wizard: **Environment → Data location → Agent runtime → Model provider → Notebook runtime**.

Complete the required environment and agent-runtime checks and test your model connection. Python/R Notebook setup is optional; Notebook and data-location settings can be changed later.

After setup, open **System** settings to change appearance or notifications. In **General**, you can find diagnostics, command-line tools, and the guide to manual installation and updates.

The former Model settings tab is now **Local capabilities**, covering PDF extraction, OCR language packs, and research narration. Narration requires a locally installed voice model.

<table>
  <tr>
    <td width="50%"><img src="docs/images/readme/onboarding-environment.jpg" alt="Automatic first-run environment checks in AIPOCH Open-Science"></td>
    <td width="50%"><img src="docs/images/readme/onboarding-model-provider.jpg" alt="First-run model provider configuration in AIPOCH Open-Science"></td>
  </tr>
  <tr>
    <td align="center"><sub>Host compatibility, storage, and network checks</sub></td>
    <td align="center"><sub>Provider, API Key, endpoint, and model validation</sub></td>
  </tr>
</table>

### 3. Start a research project

1. Click **New project**, open a session, and describe your research goal, inputs, and expected outputs.
2. Attach files, select a model and approval mode, then send the task. Use `@` to reference project files or `/` to choose a skill.
3. Review tool activity and any approval requests, preview the results, and check their available evidence in **Provenance**.

> Screenshots in this README illustrate the workflow. Labels, catalogs, and other interface details may differ from the version you install.

<a id="core-capabilities"></a>

## What can you do with AIPOCH Open-Science?

| Task              | How it works                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review literature | Import references from Zotero, screen papers against your criteria, and open the source PDFs to check a finding.                                       |
| Analyze data      | Run Python or R in a Notebook and inspect the resulting tables and figures alongside the source files.                                                 |
| Trace a result    | Open a file version in **Provenance** to inspect its inputs, code, and execution history. Rerun it when the recipe, inputs, and runtime are available. |
| Hand off a result | Share a [`.science` package](#share-your-research) so others can inspect the recorded steps and file versions behind a result.                         |
| Extend a workflow | Enable scientific data connectors, choose built-in skills, or install additional skills and specialists from the marketplaces.                         |
| Choose a model    | Connect a supported provider or custom gateway, or use a supported Claude or Codex subscription. Available protocols depend on the agent backend.      |

<a id="benchmark-performance"></a>

## Benchmark Results

AIPOCH evaluated Open-Science on research tasks ranging from literature search to reproducing published results.

| Task                                  | Benchmark                                 | Result from AIPOCH’s run                                                                |
| ------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Find a paper                          | LitQA2-FullText-Search, Test              | Target paper in the top 30 for **68/75** questions (90.67% Recall@30).                  |
| Answer a question from the literature | LitQA2-FullText, Test                     | **70/75** correct answers (93.33% accuracy).                                            |
| Write a cited answer                  | ScholarQA-CS2, 100 validation questions   | **0.9289/1** composite quality score. Official test references use different questions. |
| Carry out a workflow                  | ASI-Bench, local runs with the same model | **59.46** on B4 (Codex 55.45) and **56.11** on B2 (Codex 56.09).                        |
| Reproduce published results           | CORE-Bench-Hard                           | **36/37** tasks correct (97.30%, including retests).                                    |
| Analyze biomedical data               | BiomniBench-DA, Public 50                 | **79.05** mean judge score (81.04 and 77.06, weighted equally).                         |
| Generate hypotheses                   | DiscoveryBench, 25 validation tasks       | **0.7467/1** mean score using a local model judge.                                      |

<details>
<summary>Evaluation scope and reports</summary>

These local runs used different metrics, models, and task sets from August to November 2026. The scores describe those runs. They were not rerun for this release.

[Evaluation overview](https://aipoch.com/benchmark/open-science) · [CORE-Bench-Hard report](https://aipoch.com/blog/aipoch-open-science-core-bench-hard) · [BiomniBench-DA report](https://aipoch.com/blog/open-science-biomnibench-da)

</details>

## Data, Permissions, and Trust

AIPOCH Open-Science stores project data, settings, artifact versions, and provenance evidence on the local computer. API Keys are kept locally and use the operating system's secure credential storage when it is available. Logs are local and are not uploaded automatically.

External data flow is still possible and should be reviewed:

- Model requests send the prompt and necessary context to the selected model provider.
- Web searches and remote connectors send their displayed parameters to external services.
- Local connectors may execute trusted commands on the computer.
- The application can also contact update servers, marketplace catalogs, and runtime or model download services.
- Attachments, `@` references, logs, and generated reports may contain sensitive research data.

Choose the narrowest permission profile that fits the task:

| Mode                 | Behavior                                                                                                                   | Recommended use                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `Ask for approval`   | Requests approval for actions not already covered by scoped grants or trusted application tool policies                    | New workflows, sensitive data, unfamiliar scripts         |
| `Auto-approve edits` | Uses the backend's native auto review when available; otherwise automatically allows clearly low-risk workspace operations | Trusted file-editing work with controlled external access |
| `Full access`        | Automatically allows edits, commands, network, and connectors                                                              | Clearly scoped, fully trusted, unattended work            |

The effective profile depends on the selected backend and existing grants. Connector, tool, and compute-network policies also apply; check the effective mode shown by the app.

Review connector parameters and tool activity before approving them. Never include API Keys, access tokens, patient identifiers, unpublished data, or sensitive local paths in screenshots or public issue logs.

## Developer guides

- **Development** · [Build and package from source](docs/development-quick-reference.md) · [Contribute a change](CONTRIBUTING.md)
- **Running Open-Science** · [Standalone runtime](docs/standalone-runtime.md) · [Service lifecycle](packages/open-science/CLI.md#service-lifecycle) · [Mobile pairing](https://aipoch.com/docs/guides/remote-access/#mobile-pairing)
- **Automation** · [CLI](packages/open-science/CLI.md) · [Node.js SDK](packages/open-science/README.md) · [Connect an MCP client](packages/open-science/CLI.md#external-agents-through-mcp)

## Frequently Asked Questions

<a id="why-does-the-model-connection-test-fail"></a>

<details>
<summary>Why does the model connection test fail?</summary>

A: Check the API Key for missing characters or spaces, verify the Base URL and region, use the provider's exact model ID, and confirm network access and account balance. For a Claude subscription, retry the shared browser login or refresh the isolated `claude setup-token` credential, depending on the selected mode.

</details>

<a id="why-is-continue-disabled-during-setup"></a>

<details>
<summary>Why is <code>Continue</code> disabled during setup?</summary>

A: The current step has not met its required condition. Fix any environment row marked `Action needed`, install or repair the selected agent runtime, or validate the model provider, depending on the active step. Notebook setup is optional and only affects Notebook execution.

</details>

<a id="how-do-i-run-jobs-on-a-remote-hpc-cluster"></a>

<details>
<summary>How do I run jobs on a remote HPC cluster?</summary>

A: **Remote Compute (SSH)** is always enabled and does not need to be enabled in Settings. Register an SSH compute host under **Settings → Connections → Compute**, make it available to the current session, and then use natural language or `/remote-compute-ssh`. You need a reachable SSH host, valid authentication, permission for the required directories, and the software, dependencies, and compute resources required by the workload. Direct SSH does not require a scheduler; Slurm mode requires a working Slurm environment and permission to submit jobs. “Always enabled” refers to the skill, not to the availability of every registered host.

Kubernetes, Hugging Face Jobs, Modal, and Ray are also available for user-connected targets. Before each external submission, approve the target, command, resources, and outputs. Recovery records resume result collection after a restart, and published results open in Compute Preview. Provision the required account, software, resources, and permissions yourself; cloud jobs may incur charges.

</details>

<a id="is-there-a-command-line-interface"></a>

<details>
<summary>Is there a command-line interface?</summary>

A: Yes. Install the standalone CLI, or use **Settings → General → Command line tool → Install command** to control an already running desktop instance. The npm installation requires Node.js; Homebrew and standalone bundled-runtime packages include it. Initialize the local profile, then control the service and submit research tasks without opening a browser:

```bash
# Initialize the local CLI profile and start the service in the background
open-science init
open-science start --no-open

# Create a project and run a task by its exact name
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Download a generated artifact
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

See the [CLI guide](packages/open-science/CLI.md) for the full command reference, JSON/JSONL output formats, exit codes, and headless service options.

</details>

<a id="how-do-i-inspect-where-a-generated-result-came-from"></a>

<details>
<summary>How do I inspect where a generated result came from?</summary>

A: Open the generated artifact and choose **Provenance**. Select a version to inspect the content identity and the available producer code, execution history, inputs, environment inventory, producing conversation context, and reviewer evidence. Evidence AIPOCH Open-Science could not verify is marked unavailable.

</details>

<a id="can-i-revise-an-earlier-request-without-losing-the-conversation-that-followed"></a>

<details>
<summary>Can I revise an earlier request without losing the conversation that followed?</summary>

A: Yes. Edit a completed user message and resend it to create a new branch from that point. The original later turns remain available, and the revision arrows beside the message switch between the alternative paths.

</details>

## Contributors

Thank you to everyone who contributes code, documentation, translations, bug reports, and community support to AIPOCH Open-Science.

[Contributors on GitHub](https://github.com/aipoch/open-science/graphs/contributors)

[![AIPOCH Open-Science contributors](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## Get Involved

Help improve AIPOCH Open-Science: report a bug, suggest a feature, ask a question, or contribute. Choose a channel below to get started.

| Channel                                                                  | Use it for                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Bugs, reproducible failures, and concrete feature proposals             |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Design questions, roadmap proposals, and longer technical conversations |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Community help, contributor coordination, and informal discussion       |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Release announcements and build-in-public updates                       |
| [AIPOCH Open-Science website](https://aipoch.com/open-science)           | Official product overview and downloads                                 |

Before opening a public issue, remove API Keys, tokens, private file paths, unpublished data, patient identifiers, and other sensitive material from logs and screenshots. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

> If AIPOCH Open-Science is useful to you, star the repository on GitHub.

For shipped, partial, and planned capabilities, see the [Capability Map](docs/ROADMAP.md#capability-map).

<a id="aipoch-open-science-paper-and-citation"></a>

## Citation

If you use AIPOCH Open-Science in your research, please cite the [AIPOCH Open-Science preprint](https://arxiv.org/abs/2610.17110).

<details>
<summary>BibTeX citation</summary>

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

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Star History

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="AIPOCH Open-Science GitHub star history chart" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
