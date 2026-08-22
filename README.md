# Open Science - The open-source AI research workbench with scientific AI agents

[![Download](https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=for-the-badge&logo=github)](https://github.com/aipoch/open-science/releases/latest)
[![Version](https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=for-the-badge&color=4dabf7)](https://github.com/aipoch/open-science/releases/latest)
[![License](https://img.shields.io/badge/License-Apache--2.0-4dabf7?style=for-the-badge)](LICENSE)
[![Website](https://img.shields.io/badge/Website-aipoch.com-2f9e44?style=for-the-badge)](https://aipoch.com/)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/zxQAYjReRv)

<p align="center">
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./docs/zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./docs/zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./docs/ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="./docs/ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="./docs/fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./docs/ru/README.md"><img alt="README на русском" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
</p>

Open Science is an open-source, local-first, model-agnostic AI research workbench for scientists and researchers. It enables reproducible, inspectable research with scientific AI agents, Python and R execution, scientific data connectors, and cross-platform support for macOS, Windows, and Linux. Create a project, describe your research goal in plain language, and let the agents read files, search the web, run code, query scientific data sources, and produce reports, tables, and figures with traceable provenance—all in one workspace.

Open Science supports computational and data-intensive research across disciplines, including machine learning, statistics, life sciences, chemistry, materials science, physics and environmental science. It supports the research process from literature review and hypothesis development to code execution, data analysis, simulation, visualization, and the production of traceable research outputs.

> 💡 **[Open Science v0.18.2 released](https://github.com/aipoch/open-science/releases/latest)** _(last updated August 2026)_. Open Science v0.18.2 introduces Russian localization, turn selection for conversation exports, and pre-registered OAuth clients for custom connectors — alongside narrowed agent list summaries, bounded incremental event admission that keeps the renderer responsive during high-volume streams, streamed Project Artifact ZIP exports, MCP progress heartbeats with UTF-8 notebook source decoding, preserved attachments on message edits, opaque Codex resume recovery, idempotent Task API creates, and a broad set of workspace, notebook, update, and persistence fixes. See the [latest release notes](https://github.com/aipoch/open-science/releases/latest) for full details.

<p align="center">
 <img width="1920" height="1140" alt="Open Science open-source AI research workbench desktop app workspace showing an agent session with generated artifacts" src="https://github.com/user-attachments/assets/df59db19-98d7-4071-81f2-c682fbecdf86" />
</p>

## Table of Contents

- [Quick Start](#-quick-start)
- [Product Tour](#product-tour)
- [Why Open Science](#why-open-science)
- [Design Principles](#design-principles)
- [Core Capabilities](#core-capabilities)
- [Model Providers](#model-providers)
- [Data, Permissions, and Trust](#data-permissions-and-trust)
- [Project Status](#project-status)
- [Development & Packaging](#development--packaging)
- [Roadmap](#roadmap)
- [Relationship to the AIPOCH Ecosystem](#relationship-to-the-aipoch-ecosystem)
- [What This Is Not](#what-this-is-not)
- [Frequently Asked Questions](#frequently-asked-questions)
- [Get Involved](#get-involved)
- [License](#license)
- [Star History](#star-history)

## 🚀 Quick Start

Get Open Science running in three steps: download the installer for your platform, complete the guided first-run setup, and create a research project.

### 1. Download the app

Open the [latest release](https://github.com/aipoch/open-science/releases/latest), expand **Assets**, and choose the installer for your computer:

| Your computer                       | Choose                                   |
| ----------------------------------- | ---------------------------------------- |
| macOS — Apple Silicon (M1 or newer) | The macOS DMG for Apple Silicon / ARM64  |
| macOS — Intel                       | The macOS DMG for Intel / x64            |
| Windows x64                         | The Windows x64 installer                |
| Linux x64                           | The Linux x64 AppImage or Debian package |

Review the assets and verification information published on the release page. See [Verifying your download](SECURITY.md#verifying-your-download) before installation if you need to validate a package.

> If macOS or Windows shows an unidentified-developer or unknown-publisher warning, verify that the package came from the official Releases page before continuing.

### 2. Complete first-time setup

The first launch has five guided steps:

1. **Environment** checks compatibility, app storage, secure credential storage, and network access.
2. **Agent runtime** selects and prepares Claude Code, OpenCode, or Codex. App-managed runtimes can be installed without requiring Node.js, npm, or an administrator password.
3. **Model provider** connects and tests the model you want to use. Choose a built-in provider, a custom gateway, or an existing Claude or Codex subscription login.
4. **Notebook runtime** optionally prepares app-managed Python and R environments or enables detected and manually registered interpreters for either language.
5. **Data location** chooses where large artifacts, notebooks, uploads, and environments are stored.

<table>
  <tr>
    <td width="50%"><img src="docs/images/readme/onboarding-environment.jpg" alt="Automatic first-run environment checks in Open Science"></td>
    <td width="50%"><img src="docs/images/readme/onboarding-model-provider.jpg" alt="First-run model provider configuration in Open Science"></td>
  </tr>
  <tr>
    <td align="center"><sub>Host compatibility, storage, and network checks</sub></td>
    <td align="center"><sub>Provider, API Key, endpoint, and model validation</sub></td>
  </tr>
</table>

Notebook execution is optional. Every required environment and agent-runtime check must pass before `Continue` becomes available, and the model connection must pass before setup finishes. Notebook and data-location settings can keep their defaults and be changed later in Settings.

### 3. Start a research project

1. Click **New project** and give the project a stable research name and optional description.
2. Open a session and describe the goal, input data, constraints, desired outputs, and how the result should be checked.
3. Attach source files, select a verified model, and choose an approval mode.
4. Send the task. Inspect the agent's tool activity, approve sensitive actions, and open generated artifacts in the preview panel.
5. To explore a different direction, edit an earlier user message and resend it on a new branch; use the message revision controls to return to either path.
6. Open an artifact's **Provenance** view to inspect its versions and the available evidence behind the selected result.
7. Continue the work in later sessions. Use `@` to reference an existing project file and `/` to explicitly select an enabled skill.

> Screenshots in this README illustrate the workflow. Labels, catalogs, and other interface details may differ from the version you install.

## Product Tour

Open Science organizes research into projects and sessions so that every result can stay connected to the evidence that produced it. The sections below walk through the workspace, artifact provenance, previews, scientific skills, and data connectors.

### One workspace from task to traceable artifacts

Projects keep related sessions, uploads, generated files, and preview state together. The conversation records the agent's answer and the commands, file reads, edits, searches, and connector calls that produced it. Each generated artifact is stored as an immutable, checksummed version. Its **Provenance** view exposes the evidence Open Science could verify at creation time: producer code and execution history, referenced inputs, an observed environment inventory, the producing conversation branch, and any version-scoped reviewer findings. Missing evidence is shown as unavailable instead of being guessed.

<table>
  <tr>
    <td width="50%"><img src="docs/images/readme/project-files.jpg" alt="Project file library with uploads and generated research artifacts"></td>
    <td width="50%"><img src="docs/images/readme/csv-preview.jpg" alt="CSV artifact preview beside a completed agent session"></td>
  </tr>
  <tr>
    <td align="center"><sub>Uploads and generated files organized by project and session</sub></td>
    <td align="center"><sub>Native previews keep data and the research history side by side</sub></td>
  </tr>
</table>

Generated reports, figures, and tables remain attached to the session and are also collected in the project file library. Preview tabs keep the active result visible as the panel changes size, and long names preserve their identifying suffix and extension. Open Science previews common scientific data, PDFs, Office documents (DOCX, XLSX, PPTX), images (with zoom and pan), source code with syntax highlighting, molecular structures and reactions, and Notebook history. Preview limits do not truncate the underlying file—the full artifact stays available to the agent and external tools. Use `Cmd/Ctrl+F` to search transcripts, Notebook output, and rendered pages across the workspace, or `Cmd/Ctrl+K` to open the project-scoped command palette. A dark mode rounds out the workspace: toggle the theme in **Settings → General** and the whole shell, transcript, and renderer palette switch without a flash. The interface is also available in Chinese (Simplified and Traditional), Japanese, Korean, French, and Russian with a runtime language switcher in Settings.

### Branch a conversation without losing the original

Edit a completed user message to resend a revised prompt from that point. Open Science creates a new message branch instead of deleting the turns that followed, and revision controls let you move between the original and alternative paths. Branch selection, tool activity, attachments, and generated artifacts persist across project switches and restarts. Provenance remains tied to the exact branch that produced each artifact version, so exploring a different hypothesis does not blur the record of the earlier result.

### Scientific skills and data connectors

Open Science includes a growing catalog of **18 featured**, file-based research skills: AlphaFold2, Boltz, Borzoi, Chai-1, DiffDock, Environment & Packages, ESM-2, ESMFold2, Evo 2, Indication Dossier, LigandMPNN, Literature Review, OpenFold3, ProteinMPNN, scGPT, scvi-tools, SolubleMPNN, and **Remote Compute (SSH)** for submitting and harvesting long-running jobs on remote HPC clusters. You can create personal skills, upload `SKILL.md`/ZIP/`.skill` packages, preview and import compatible skills from GitHub with optional authenticated access, or import skills already installed in your global agent directories. The agent can also request a package import from a session attachment or a public GitHub URL, with an app-owned preview and confirmation step before anything is written. Enabled skills can be selected directly in the composer with `/`.

It also includes **24 built-in** research connectors: Literature Graph, PubMed, bioRxiv, Genes & Ontologies, Genomes, BioMart, Variants, Human Genetics, Clinical Genomics, Structures & Interactions, Protein Annotation, Expression, Omics Archives, CellGuide, Regulation, RNA, Chemistry, ChEMBL, ZINC, Molecule Viewer, Clinical Trials, Drug Regulatory, Cancer Models, and Research Resources. Built-in and custom connectors remain behind the permission system, with per-tool `Always allow`, `Ask each time`, and `Block` controls. The installed app shows the current skill, connector, and tool catalogs.

<table>
  <tr>
    <td width="50%"><img src="docs/images/readme/skills.jpg" alt="Open Science settings showing featured scientific skills"></td>
    <td width="50%"><img src="docs/images/readme/connectors.jpg" alt="Open Science settings showing built-in scientific data connectors"></td>
  </tr>
  <tr>
    <td align="center"><sub>Readable, reusable research skills</sub></td>
    <td align="center"><sub>Scientific databases exposed as permissioned agent tools</sub></td>
  </tr>
</table>

## Why Open Science

Open Science brings research tasks, execution, files, and evidence into one local, inspectable desktop workspace.

Research work is usually split across chat windows, notebooks, local scripts, scientific databases, file browsers, and reporting tools. Context is lost at every handoff, and the answer is often separated from the code and files that produced it.

Open Science brings those pieces into one inspectable desktop workspace:

- **Work that persists.** Projects, sessions, drafts, files, previews, and run history survive application restarts.
- **Execution, not just suggestions.** The agent can run commands, Python, and R, edit files, search, call connectors, and generate artifacts with the user's approval.
- **Alternative paths without lost work.** Revise an earlier prompt on a new message branch and switch between the resulting research directions.
- **Traceable results.** Immutable artifact versions retain the production evidence Open Science can verify, and explicitly mark evidence it cannot.
- **Multiple model choices.** Use a built-in cloud provider, a compatible custom gateway, or a Claude or Codex subscription; choose each Session's model and reasoning effort together in the composer.
- **Local-first ownership.** The application and project state run on your computer; external calls happen through services you explicitly configure or approve.
- **Inspectability.** The source code, skills, connector definitions, tool activity, generated files, and artifact provenance are available for review.
- **Extensibility.** Add skills and MCP connectors instead of waiting for a closed plugin roadmap.
- **No seat license.** Open Science is Apache-2.0 software. You pay only for the model or infrastructure you choose to use.

Open Science is an independent product built from scratch. It is not a proxy, unofficial client, or reskin of another AI research application.

## Design Principles

Open Science is built on seven design principles that govern how code, data, models, and human oversight fit together: open by default, explicit multi-provider compatibility, local-first data ownership, human-in-the-loop oversight, durable research records, composable capabilities, and honest scientific boundaries.

- **Open by default.** Source code, formats, connectors, and skills should remain inspectable and forkable.
- **Multi-provider with explicit compatibility.** The app validates provider configuration and makes endpoint requirements visible instead of treating every API protocol as interchangeable.
- **Local-first and data-aware.** Keep project state local, surface external data flows, and make autonomy opt-in.
- **Human-in-the-loop.** File edits, commands, network access, and connector calls are governed by explicit approval profiles.
- **Durable research records.** Sessions, tool activity, Notebook history, and immutable artifact versions should remain reviewable after the run ends, with unavailable evidence stated plainly.
- **Composable capabilities.** Skills, connectors, models, previews, and future compute backends should be replaceable parts rather than one black box.
- **Honest scientific boundaries.** Generated output does not replace expert judgment, statistical review, or validation against primary evidence.

## Core Capabilities

Open Science combines project management, multi-model agent execution, Python and R notebooks, scientific data connectors, immutable artifact versions with provenance, and permissioned human-in-the-loop control in one local workspace. The installed app and [latest release notes](https://github.com/aipoch/open-science/releases/latest) are the source of truth for changing catalogs, packaging details, and newly added options.

| Area                         | Core capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projects and sessions**    | Create, rename, and delete projects; maintain multiple sessions with pinning; edit completed prompts into persistent, selectable message branches without deleting the original downstream path; persistent side conversations within a session; restore recent work, drafts, conversation history, and preview state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Agent workflow**           | Natural-language tasks, streamed responses, typed tool-activity cards grouped under declared purpose titles, a live context-usage indicator with category-level estimates, on-demand context compaction, and persistence across restarts, stop controls, approval pauses, a confirmation step (with a remembered preference) before closing or quitting during a running task, a composer message queue for staging follow-up messages during a running turn, branching into a new session from completed agent messages, desktop notifications with attention reasons plus durable unread conversation badges and native attention on blocking approvals, a cross-surface notification message center with durable read state and retained deleted targets, structured agent clarification cards for multi-question requests, live session status on the Home dashboard, message timing metadata with elapsed-time and usage popovers, per-turn token usage, completed-turn agent framework and model identification, a project-scoped command palette, project-scoped frame reads, project actions and agent context, refined session sidebar rows, review-gated session plans with durable execution contracts and CLI plan show, approve, and reject commands, smooth live response rendering, collapsible side panels, a new-conversation keyboard shortcut, and recovery of sessions interrupted by an application restart. |
| **Subagent delegation**      | Production subagent delegation with durable messaging and recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Models**                   | Built-in cloud providers, custom compatible gateways, Claude and Codex subscription logins, connection validation, per-model multimodal image input, a combined per-Session composer picker for model and model-supported reasoning effort, Settings defaults for new Sessions, and a dedicated Vision model selector with a persistent image evidence relay for text-only backends. Available providers and API formats are validated against the selected agent backend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Agent backend**            | A selectable agent-framework backend so the same workspace can run on more than one underlying agent implementation, with provider and model choices validated against the selected backend, app-managed backends installable, switchable, and removable from Settings, and agent-aware context replay that respects each framework's context path after switches or resumes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Specialists**              | Personal specialist agent profiles with scoped capabilities, immediate in-flight handoff from the main agent, conversational customization, package import/export, immutable invocation identities, generated name-based IDs with validated overrides, and a scoped Specialist marketplace with signed package verification, official and user-approved GitHub sources, CDN fallback, download progress, and skill-conflict resolution on import. The marketplace separates Installed and Marketplace views, opens verified cached listings immediately with manual refresh, supports direct installation from details, and provides shared capability icons, quick appearance editing, and capability-row navigation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Capability organization**  | Cross-resource tags for skills, connectors, and runnable specialists, with a protected Favorites tag, assignment menus, badges, filters, a searchable Tags settings browser, and persistent pointer or keyboard drag ordering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Execution**                | Persistent Python, R, and REPL control-plane kernels with durable code/output history, plus stateless shell commands recorded in the same run history; bounded REPL inference for agent-driven evaluation; app-managed environments with offline provisioning; bring-your-own Python and R interpreters; remote SSH compute hosts with key or password authentication and OS-encrypted stored credentials as additional execution targets; a user terminal shared with the agent; a read-only installed-package inventory per runtime environment; and notebook artifact read access for agent-side file inspection. Package management for external R runtimes remains manual.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Inputs and files**         | File attachments (up to 10 GB per file with streaming upload), a project-level library with indexed pagination, session grouping, source-scoped filename search, grid and list views, a large expand modal for large projects, split-view file preview beside the session, generated artifact cards, `@` references to existing uploads/outputs, `@path` mentions to grant local folder access with cross-drive browsing, an editable path bar, and a drive switcher, file download/export, selective session-artifact downloads, conversation export as Markdown or PDF, and session export as `.ipynb` (per-tab or download-all).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Artifacts and provenance** | Immutable, session-scoped artifact versions with checksummed content and available producer code, execution history, exact input references, environment inventory, producing message-branch context, artifact lineage access, and version-scoped reviewer evidence, with version navigation and direct links between related evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Preview formats**          | Responsive multi-tab previews for common scientific data, PDFs, Office documents (DOCX, XLSX, PPTX), images (including TIFF, with zoom and pan), source code with syntax highlighting, molecular structures and reactions, and Notebook history, viewable inline or full-screen, with view-in-context navigation back to the conversation that produced an artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Local data management**    | Local project and application data, configurable storage location, guided migration, and global proxy settings with system, manual, and direct modes; a token usage dashboard with period summaries, a 30-day activity heatmap, and daily input/cache/output charts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Skills**                   | **18 featured** built-in skills; personal skills with immutable lowercase-hyphenated names; conversational skill creation from natural language inside a session; save-as-skill from a completed conversation turn; direct user skill folder support with out-of-band package validation; bulk enable/disable management with source, status, and text filters; package upload; authenticated GitHub preview/import; import of installed global skills with candidate preview; agent-requested package imports from session attachments or GitHub URLs; camelCase Host JavaScript APIs for skill scripting with structured validation; enable/disable controls; and explicit `/` selection in a session. The redesigned Skills panel unifies main-agent and specialist filtering, shows actual-user avatar stacks with a bounded Used by popover, consolidates row actions, and supports confirmed bulk deletion while protecting built-in and specialist-linked skills.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Connectors**               | **24 built-in** research connectors with runtime status and recovery surfaces, custom local/remote MCP connectors with immutable lowercase invocation names separate from editable display names, generated name-based local IDs with validated overrides, contact metadata, and connector/tool-level permissions. Catalog interactions follow the same compact management patterns as skills.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Safety controls**          | `Ask for approval`, `Auto-approve edits`, and `Full access` conversation profiles; approval dialogs with code previews and call/conversation decisions; durable global, project, and session-scoped allow grants with filtering, per-row and family revoke, and Undo; plus per-connector and per-tool policies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Review and verification**  | An opt-in reviewer that audits a completed turn against its own transcript, execution log, and artifacts, reports pass/warn/fail findings, and can run a bounded fix loop to correct them; a configurable reviewer model policy that follows the active model or pins a dedicated provider, model, and reasoning effort; and durable reviewer assessment snapshots with correction attribution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Distribution and support** | Installers for macOS, Windows, and Linux; a streamlined first-run onboarding wizard for environment, agent runtime, model provider, notebook runtime, and data location; interface localization in French, Chinese (Simplified and Traditional), Japanese, Korean, and Russian with README translations for every supported language and additional multilingual contribution guides; update guidance with prominent update reminders; local diagnostics; and community links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Model Providers

Open Science is model-agnostic at the product level: connect it to major cloud LLM providers, a custom gateway, or reuse an existing Claude or Codex subscription. Provider availability currently depends on the selected agent backend and the API protocols it supports. There are four ways to connect a model:

| Provider mode                | How it works                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Built-in cloud providers** | Choose from the provider list shown by the installed app and authenticate with the requested key.                                                                                                                                                                                                                                |
| **Custom Gateway**           | Supply a compatible Base URL, API Key, and exact model ID. The default API format (Messages, Chat Completions, or Responses) is derived from the active agent framework, so a new custom gateway is compatible out of the box.                                                                                                   |
| **Codex Subscription**       | Select the Codex agent framework first, then you can select Codex subscription in provider type                                                                                                                                                                                                                                  |
| **Claude Subscription**      | Sign in with a Claude subscription in two modes: **shared** (a browser login that stores credentials in your default `~/.claude` profile) or **isolated** (an app-managed `claude setup-token` run under an app-owned `CLAUDE_CONFIG_DIR`, fully isolated from `~/.claude/`, with a browser flow plus a paste-a-token fallback). |

The legacy **Local Claude** provider has been removed. Previously stored Local Claude entries are
dropped during upgrade; add **Claude Subscription** and authenticate with shared browser login or
the isolated `claude setup-token` flow instead.

Built-in cloud vendors currently include OpenAI, Anthropic, Grok (xAI), DeepSeek, Zhipu AI (GLM) with a dedicated GLM Coding Plan endpoint, Kimi (Moonshot), MiniMax, StepFun with a dedicated Step Plan subscription endpoint, Xiaomi MIMO, SenseNova, Volcengine Ark, Bailian (Alibaba Cloud) with a dedicated Bailian for Plan subscription endpoint, and the OpenRouter aggregation gateway, among others; some are region-specific.

Provider vendors, available models, and regional endpoints can evolve independently of this README. Treat the provider picker and connection test in the installed app as the source of truth.

## Data, Permissions, and Trust

Open Science stores project data, settings, artifact versions, and provenance evidence on the local computer. API Keys are kept locally and use the operating system's secure credential storage when it is available. Logs are local and are not uploaded automatically.

External data flow is still possible and should be reviewed:

- Model requests send the prompt and necessary context to the selected model provider.
- Web searches and remote connectors send their displayed parameters to external services.
- Local connectors may execute trusted commands on the computer.
- Attachments, `@` references, logs, and generated reports may contain sensitive research data.

Choose the narrowest permission profile that fits the task:

| Mode                 | Behavior                                                                         | Recommended use                                           |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `Ask for approval`   | Asks before edits, commands, network, and connector calls                        | New workflows, sensitive data, unfamiliar scripts         |
| `Auto-approve edits` | Automatically allows workspace edits; asks for commands, network, and connectors | Trusted file-editing work with controlled external access |
| `Full access`        | Automatically allows edits, commands, network, and connectors                    | Clearly scoped, fully trusted, unattended work            |

Review connector parameters and tool activity before approving them. Never include API Keys, access tokens, patient identifiers, unpublished data, or sensitive local paths in screenshots or public issue logs.

## Project Status

Open Science is an actively developed desktop application available for macOS, Windows, and Linux. Development focuses on reliable local-first research workflows, extensible scientific capabilities, traceable research artifacts, and user-controlled execution.

See the [latest release](https://github.com/aipoch/open-science/releases/latest) for current downloads and version-specific changes. For shipped, partial, and planned capabilities, see the [Capability Map](ROADMAP.md#capability-map).

Open Science assists research execution and record-keeping; researchers remain responsible for methods, interpretation, privacy, and scientific validity.

## Development & Packaging

Open Science is an Electron application built with React, TypeScript, Prisma/SQLite, and an ACP-based agent runtime.

Prerequisites for source development:

- Node.js LTS or newer with npm
- Git
- Python 3 only if you want Notebook execution

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` automatically generates the Prisma client and installs Electron native dependencies. `npm run dev` builds the Electron main/preload bundles, starts the renderer, and opens the desktop app. Development data is isolated under `~/.open-science-project`.

Useful commands:

| Command                | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `npm run dev`          | Start the development application        |
| `npm run dev:web`      | Dev app + localhost web UI (127.0.0.1)   |
| `npm run dev:headless` | Dev backend + web UI, no Electron window |
| `npm run lint`         | Run ESLint                               |
| `npm run typecheck`    | Type-check main and renderer code        |
| `npm test`             | Run the Vitest suite                     |
| `npm run build`        | Type-check and build the application     |
| `npm run build:web`    | Build the optional localhost web UI      |
| `npm run build:mac`    | Package macOS builds                     |
| `npm run build:win`    | Package Windows builds                   |
| `npm run build:linux`  | Package Linux builds                     |

Packaged output is written under `dist/`.

### Localhost web and headless modes

The desktop backend can optionally serve the same renderer to a browser on the local computer. This
feature is off by default and binds only to `127.0.0.1`.

```bash
npm run build:web
npm run dev:web
```

Open the authenticated URL printed by the application. Use `npm run dev:headless` to start the
backend, tray, agent runtime, and localhost web service without opening an Electron window.
Set `OPEN_SCIENCE_WEB_PORT` to choose a port (default `44100`). Explicitly quitting the
application still shuts down agent and Notebook processes normally.

### Mobile remote access

The same localhost web UI can be reached from a phone or tablet through Remote.It pairing. Pair
a browser with a six-digit Open Science code, approve it once on the desktop, and the workspace
stays reachable without exposing the loopback server directly. Browser trust is revocable, and
mode changes or service shutdown immediately invalidate active remote sessions.

### Headless CLI and SDK

The headless CLI and zero-dependency Node.js SDK use the same local daemon, projects, sessions,
credentials, and permissions as the desktop and web interfaces. Detailed usage lives with the
publishable package so there is one command reference to maintain:

- [CLI guide](packages/open-science/CLI.md) - installation, service lifecycle, task automation,
  artifacts, output formats, and exit codes
- [SDK package overview](packages/open-science/README.md) - Node.js quick start and package entry point

## Roadmap

The product roadmap and capability status are maintained in [ROADMAP.md](ROADMAP.md). This README intentionally does not duplicate the moving list of priorities or release targets.

## Relationship to the AIPOCH Ecosystem

<img width="1920" height="1140" alt="How Open Science fits the AIPOCH ecosystem as the desktop orchestration layer for open scientific AI workflows" src="https://github.com/user-attachments/assets/0ab847b1-1b7d-43f4-8c11-480a578e6c7d" />

[AIPOCH](https://aipoch.com/open-science) ([GitHub org](https://github.com/aipoch)) builds Open Science as the desktop orchestration layer for open scientific AI workflows.

- [aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills) is a broader collection of 500+ file-based medical and scientific research skills, all of which can be inspected, imported, and paired with Open Science from GitHub.
- Open Science supplies the project/session workspace, agent runtime, execution, artifacts, previews, permissions, and connectors that turn those instructions into an interactive workflow.

Skills and connectors can execute code or send data externally. Review their source, license, scripts, and network behavior before enabling them.

## What This Is Not

Open Science is a research execution and record-keeping tool, not a generic chat wrapper, unofficial client, or substitute for scientific review.

- **Not just a chat UI.** The product is organized around persistent projects, execution, files, artifacts, and reviewable tool activity.
- **Not an unofficial client for another product.** It is an independent implementation with its own codebase, data model, interface, and roadmap.
- **Not a replacement for scientific judgment.** Outputs still require domain review, statistical validation, and verification against primary sources.

## Frequently Asked Questions

### What should I do the first time I open Open Science?

A: Complete the five setup steps: **Environment**, **Agent runtime**, **Model provider**, **Notebook runtime**, and **Data location**. Fix required rows marked `Action needed`, install or repair the selected agent if offered, and test the model connection. Notebook setup and a custom data location are optional.

### What is an API Key, and where do I get one?

A: An API Key is a secret credential issued by a model provider. Create or copy one from that provider's developer/API console. The provider may bill requests made with the key. Treat it like a password: never share it or commit it to a repository.

### Do I need an API Key?

A: Not if you reuse an existing subscription login — a Claude subscription through shared browser login or an isolated app-managed `claude setup-token` flow, or a ChatGPT/Codex subscription login on the Codex backend. Built-in cloud providers and custom gateways require their own keys.

### Which model providers can I use?

A: Open the provider picker during setup or under `Settings → Model` for the choices supported by your installed app and selected agent backend. You can use a built-in cloud provider, a compatible Custom Gateway, a Claude subscription through shared or isolated login, or a Codex subscription on the Codex backend.

### Why does the model connection test fail?

A: Check the API Key for missing characters or spaces, verify the Base URL and region, use the provider's exact model ID, and confirm network access and account balance. For a Claude subscription, retry the shared browser login or refresh the isolated `claude setup-token` credential, depending on the selected mode.

### Why is `Continue` disabled during setup?

A: The current step has not met its required condition. Fix any environment row marked `Action needed`, install or repair the selected agent runtime, or validate the model provider, depending on the active step. Notebook setup is optional and only affects Notebook execution.

### Setup is complete. How do I start a research task?

A: Create or open a project, start a session, attach any source files, and describe the goal, constraints, expected output, and validation criteria. Use `@` to reference a project file and `/` to select an enabled skill.

### How do I run jobs on a remote HPC cluster?

A: Enable the **Remote Compute (SSH)** skill under **Settings → Skills**, register your cluster under **Settings → Compute**, then start a session and select the skill with `/remote-compute-ssh`. The skill handles host registration, short commands via SSH, and fully async job submission — the app automatically starts an analysis turn when the job finishes, so you never write a polling loop.

### Is there a command-line interface?

A: Yes. Install it in one click from **Settings → General → Command line tool → Install command** (adds `open-science` to your PATH; no separate Node.js needed). The CLI controls the local service and submits research tasks without opening a browser:

```bash
# Start the service in the background
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

### How do I inspect where a generated result came from?

A: Open the generated artifact and choose **Provenance**. Select a version to inspect the content identity and the available producer code, execution history, inputs, environment inventory, producing conversation context, and reviewer evidence. Evidence Open Science could not verify is marked unavailable.

### Can I revise an earlier request without losing the conversation that followed?

A: Yes. Edit a completed user message and resend it to create a new branch from that point. The original later turns remain available, and the revision arrows beside the message switch between the alternative paths.

### Does my research data stay on my computer?

A: Projects, sessions, files, settings, and configured credentials are stored locally by default. Content needed for model requests, web searches, or connector calls may still be sent to the external service you selected, so review sensitive inputs and provider policies before running a task.

## Get Involved

Open Science welcomes bug reports, feature proposals, design discussions, community questions, and contributions through GitHub, Discord, X, and the AIPOCH website. Choose the channel that best matches your goal, then follow the linked contribution guidance and public-posting safety reminder before sharing project details.

| Channel                                                                  | Use it for                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Bugs, reproducible failures, and concrete feature proposals             |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Design questions, roadmap proposals, and longer technical conversations |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Community help, contributor coordination, and informal discussion       |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Release announcements and build-in-public updates                       |
| [Website](https://aipoch.com/)                                           | Product overview, downloads, and the rest of the AIPOCH ecosystem       |

Before opening a public issue, remove API Keys, tokens, private file paths, unpublished data, patient identifiers, and other sensitive material from logs and screenshots. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

> ⭐ **Star the repo:** If this project has been helpful, we'd greatly appreciate a star on GitHub. Starring the repository encourages continued development. It only takes a second, but it has a meaningful impact on the project.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Star History

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
