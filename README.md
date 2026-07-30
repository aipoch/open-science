# Open Science

[![Download](https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=for-the-badge&logo=github)](https://github.com/aipoch/open-science/releases/latest)
[![Version](https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=for-the-badge&color=4dabf7)](https://github.com/aipoch/open-science/releases/latest)
[![License](https://img.shields.io/badge/License-Apache--2.0-4dabf7?style=for-the-badge)](LICENSE)
![Status](https://img.shields.io/badge/Status-Actively%20Developed-ff9f43?style=for-the-badge)
[![Discussions](https://img.shields.io/badge/Discussions-Welcome-9775fa?style=for-the-badge)](https://github.com/aipoch/open-science/discussions)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/85dKfuGM9)
[![YouTube](https://img.shields.io/badge/YouTube-AIPOCH_AI-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/@AIPOCH_AI)
[![Follow on X](https://img.shields.io/badge/Follow%20on%20X-%40aipoch__ai-212529?style=for-the-badge&logo=x&logoColor=white)](https://x.com/aipoch_ai)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-AIPOCH-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/pochai)

**Open Science is an open-source, local-first, model-agnostic AI research workbench for scientific discovery.** Built for researchers, it runs on your own computer (macOS, Windows, Linux). Create a project, describe a task in plain language, and let the AI agent read files, run Python and R code, search the web, call scientific data connectors, and return reproducible reports, tables, figures, and an inspectable activity history in one workspace.

> ⭐ **Star the repo:** If this project has been helpful, we'd greatly appreciate a star on GitHub. Starring the repository encourages continued development. It only takes a second, but it has a meaningful impact on the project.

> 💡 **[Open Science v0.8.1 released](https://github.com/aipoch/open-science/releases/latest)** _(last updated July 2026)_. This patch keeps you oriented during long-running work: the context-usage indicator now breaks the window down by category, completed tasks leave a durable unread badge with native attention on blocking approvals, and the project file library gains scoped search, grid/list views, and a large expand modal. It also hardens artifact finalization and provenance recovery, prevents R package installs from upgrading the live kernel, and keeps Claude Code's built-in web tools available in every session. See the [latest release notes](https://github.com/aipoch/open-science/releases/latest) for full details.

<p align="center">
 <img width="1920" height="1140" alt="Open Science open-source AI research workbench desktop app workspace showing an agent session with generated artifacts" src="https://github.com/user-attachments/assets/df59db19-98d7-4071-81f2-c682fbecdf86" />
</p>

## Table of Contents

- [Quick Start](#-quick-start)
- [Product Tour](#product-tour)
- [Why Open Science](#why-open-science)
- [Vision](#vision)
- [Design Principles](#design-principles)
- [Core Capabilities](#core-capabilities)
- [Model Providers](#model-providers)
- [Data, Permissions, and Trust](#data-permissions-and-trust)
- [Project Status](#project-status)
- [Development & Packaging](#development--packaging)
- [Building From Source](#building-from-source)
- [Roadmap](#roadmap)
- [Relationship to the aipoch Ecosystem](#relationship-to-the-aipoch-ecosystem)
- [What This Is Not](#what-this-is-not)
- [Frequently Asked Questions](#frequently-asked-questions)
- [Get Involved](#get-involved)
- [License](#license)
- [Star History](#star-history)

## 🚀 Quick Start

### 1. Download the app

Open the [latest release](https://github.com/aipoch/open-science/releases/latest), expand **Assets**, and choose the installer for your computer:

| Your computer                       | Choose                                   |
| ----------------------------------- | ---------------------------------------- |
| macOS — Apple Silicon (M1 or newer) | The macOS DMG for Apple Silicon / ARM64  |
| macOS — Intel                       | The macOS DMG for Intel / x64            |
| Windows x64                         | The Windows x64 installer                |
| Linux x64                           | The Linux x64 AppImage or Debian package |

Review the assets and verification information published on the release page. See [Verifying your download](SECURITY.md#verifying-your-download) before installation if you need to validate a package.

> If macOS or Windows shows an unidentified-developer or unknown-publisher warning, verify that the package came from the official Releases page before continuing. See [Building From Source](#building-from-source) for platform-specific guidance.

### 2. Complete first-time setup

The first launch has two guided steps:

1. **Prepare environment** checks compatibility, app storage, secure credential storage, network access, the Claude runtime, and optional Python Notebook support. If the runtime is missing, Open Science can install an app-managed copy without requiring Node.js, npm, or an administrator password.
2. **Model provider** connects and tests the model you want to use. Choose a built-in provider, an Anthropic-compatible custom gateway, or reuse an existing subscription login without entering an API Key — paste a `claude setup-token` for a Claude subscription, or pick a ChatGPT/Codex subscription login on the Codex backend.

<table>
  <tr>
    <td width="50%"><img src="docs/images/readme/onboarding-environment.jpg" alt="Automatic first-run environment checks in Open Science"></td>
    <td width="50%"><img src="docs/images/readme/onboarding-model-provider.jpg" alt="First-run model provider configuration in Open Science"></td>
  </tr>
  <tr>
    <td align="center"><sub>Automatic environment detection and managed runtime setup</sub></td>
    <td align="center"><sub>Provider, API Key, endpoint, and model validation</sub></td>
  </tr>
</table>

Python is optional unless you want the built-in Notebook kernel. Every required environment row must pass before `Continue` becomes available, and the model connection must pass before setup finishes.

### 3. Start a research project

1. Click **New project** and give the project a stable research name and optional description.
2. Open a session and describe the goal, input data, constraints, desired outputs, and how the result should be checked.
3. Attach source files, select a verified model, and choose an approval mode.
4. Send the task. Inspect the agent's tool activity, approve sensitive actions, and open generated artifacts in the preview panel.
5. To explore a different direction, edit an earlier user message and resend it on a new branch; use the message revision controls to return to either path.
6. Open an artifact's **Provenance** view to inspect its versions and the available evidence behind the selected result.
7. Continue the work in later sessions. Use `@` to reference an existing project file and `/` to explicitly select an enabled skill.

Want to develop the app instead? Skip to [Building From Source](#building-from-source).

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

Generated reports, figures, and tables remain attached to the session and are also collected in the project file library. Preview tabs keep the active result visible as the panel changes size, and long names preserve their identifying suffix and extension. Open Science previews common scientific data, Office documents (DOCX, XLSX, PPTX), images (with zoom and pan), source code, molecular structures and reactions, and Notebook history. Preview limits do not truncate the underlying file—the full artifact stays available to the agent and external tools. Use `Cmd/Ctrl+F` to search transcripts, Notebook output, and rendered pages across the workspace. A dark mode rounds out the workspace: toggle the theme in **Settings → General** and the whole shell, transcript, and renderer palette switch without a flash.

### Branch a conversation without losing the original

Edit a completed user message to resend a revised prompt from that point. Open Science creates a new message branch instead of deleting the turns that followed, and revision controls let you move between the original and alternative paths. Branch selection, tool activity, attachments, and generated artifacts persist across project switches and restarts. Provenance remains tied to the exact branch that produced each artifact version, so exploring a different hypothesis does not blur the record of the earlier result.

### Scientific skills and data connectors

Open Science includes a growing catalog of **18 featured**, file-based research skills: AlphaFold2, Boltz, Borzoi, Chai-1, DiffDock, Environment & Packages, ESM-2, ESMFold2, Evo 2, Indication Dossier, LigandMPNN, Literature Review, OpenFold3, ProteinMPNN, scGPT, scvi-tools, SolubleMPNN, and **Remote Compute (SSH)** for submitting and harvesting long-running jobs on remote HPC clusters. You can create personal skills, upload `SKILL.md`/ZIP/`.skill` packages, preview and import compatible skills from GitHub, or import skills already installed in your global agent directories. The agent can also request a package import from a session attachment, with an app-owned preview and confirmation step before anything is written. Enabled skills can be selected directly in the composer with `/`.

It also includes **24 built-in** research connectors across literature, genes and proteins, genomics, variants, structures, clinical research, expression, chemistry, drug regulation, and related resources. Built-in and custom connectors remain behind the permission system, with per-tool `Always allow`, `Ask each time`, and `Block` controls. The installed app shows the current skill, connector, and tool catalogs.

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

Research work is usually split across chat windows, notebooks, local scripts, scientific databases, file browsers, and reporting tools. Context is lost at every handoff, and the answer is often separated from the code and files that produced it.

Open Science brings those pieces into one inspectable desktop workspace:

- **Work that persists.** Projects, sessions, drafts, files, previews, and run history survive application restarts.
- **Execution, not just suggestions.** The agent can run commands, Python, and R, edit files, search, call connectors, and generate artifacts with the user's approval.
- **Alternative paths without lost work.** Revise an earlier prompt on a new message branch and switch between the resulting research directions.
- **Traceable results.** Immutable artifact versions retain the production evidence Open Science can verify, and explicitly mark evidence it cannot.
- **Multiple model choices.** Use a built-in cloud provider, a compatible custom gateway, or a Claude or Codex subscription; choose the model and its reasoning effort together in the composer.
- **Local-first ownership.** The application and project state run on your computer; external calls happen through services you explicitly configure or approve.
- **Inspectability.** The source code, skills, connector definitions, tool activity, generated files, and artifact provenance are available for review.
- **Extensibility.** Add skills and MCP connectors instead of waiting for a closed plugin roadmap.
- **No seat license.** Open Science is Apache-2.0 software. You pay only for the model or infrastructure you choose to use.

Open Science is an independent product built from scratch. It is not a proxy, unofficial client, or reskin of another AI research application.

## Vision

<img width="1920" height="1140" alt="Open Science vision: an open, traceable AI research loop connecting literature, data, computation, artifacts, and review" src="https://github.com/user-attachments/assets/5e3eea29-61b2-49b8-ac16-e4d9b43a4693" />

Our goal is to make the AI research workbench a piece of open infrastructure rather than a rented product surface. A student with a laptop, a lab using a regional model provider, and an institution running its own gateway should be able to use the same research workspace while keeping control of their models, tools, and data boundaries.

The long-term destination is a traceable loop connecting literature, data, computation, artifacts, review, and reusable scientific skills. Immutable artifact versions and provenance evidence now establish the audit layer for that loop; portable environment restoration, full-fidelity session replay, and deterministic reconstruction remain ahead.

## Design Principles

- **Open by default.** Source code, formats, connectors, and skills should remain inspectable and forkable.
- **Multi-provider with explicit compatibility.** The app validates provider configuration and makes endpoint requirements visible instead of treating every API protocol as interchangeable.
- **Local-first and data-aware.** Keep project state local, surface external data flows, and make autonomy opt-in.
- **Human-in-the-loop.** File edits, commands, network access, and connector calls are governed by explicit approval profiles.
- **Durable research records.** Sessions, tool activity, Notebook history, and immutable artifact versions should remain reviewable after the run ends, with unavailable evidence stated plainly.
- **Composable capabilities.** Skills, connectors, models, previews, and future compute backends should be replaceable parts rather than one black box.
- **Honest scientific boundaries.** Generated output does not replace expert judgment, statistical review, or validation against primary evidence.

## Core Capabilities

This section describes durable product capabilities rather than a version-specific inventory. The installed app and [latest release notes](https://github.com/aipoch/open-science/releases/latest) are the source of truth for changing catalogs, packaging details, and newly added options.

| Area                         | Core capability                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projects and sessions**    | Create, rename, and delete projects; maintain multiple sessions with pinning; edit completed prompts into persistent, selectable message branches without deleting the original downstream path; restore recent work, drafts, conversation history, and preview state.                                                                                                                                                                    |
| **Agent workflow**           | Natural-language tasks, streamed responses, typed tool-activity cards grouped under declared purpose titles, a live context-usage indicator with category-level estimates and on-demand context compaction, stop controls, approval pauses, a confirmation step (with a remembered preference) before closing or quitting during a running task, desktop notifications plus durable unread conversation badges and native attention on blocking approvals, and recovery of sessions interrupted by an application restart. |
| **Models**                   | Built-in cloud providers, custom compatible gateways, Claude and Codex subscription logins, connection validation, per-model multimodal image input, and a combined composer picker for model and model-supported reasoning effort.                                                                                                                                                                                                       |
| **Agent backend**            | A selectable agent-framework backend so the same workspace can run on more than one underlying agent implementation, with provider and model choices validated against the selected backend, and app-managed backends installable, switchable, and removable from Settings.                                                                                                                                                               |
| **Execution**                | Persistent notebook kernels (Python, R, and a REPL control plane) with durable code/output history, app-managed environments with offline provisioning and bring-your-own interpreters, remote SSH compute hosts as additional execution targets, and a user terminal shared with the agent.                                                                                                                                              |
| **Inputs and files**         | File attachments (up to 10 GB per file with streaming upload), a project-level library with indexed pagination, session grouping, source-scoped filename search, grid and list views, and a large expand modal for large projects, generated artifact cards, `@` references to existing uploads/outputs, file download/export, and session export as `.ipynb` (per-tab or download-all).                                                                                                                             |
| **Artifacts and provenance** | Immutable, session-scoped artifact versions with checksummed content and available producer code, execution history, exact input references, environment inventory, producing message-branch context, and version-scoped reviewer evidence, with version navigation and direct links between related evidence.                                                                                                                            |
| **Preview formats**          | Responsive multi-tab previews for common scientific data, Office documents (DOCX, XLSX, PPTX), images (with zoom and pan), source code, molecular structures and reactions, and Notebook history, viewable inline or full-screen.                                                                                                                                                                                                         |
| **Local data management**    | Local project and application data, configurable storage location, and guided migration.                                                                                                                                                                                                                                                                                                                                                  |
| **Skills**                   | **18 featured** built-in skills; personal skills, package upload, GitHub preview/import, import of installed global skills with candidate preview, agent-requested package imports in a session, enable/disable controls, and explicit `/` selection in a session.                                                                                                                                                                                            |
| **Connectors**               | **24 built-in** research connectors, custom local/remote MCP connectors, contact metadata, and connector/tool-level permissions.                                                                                                                                                                                                                                                                                                             |
| **Safety controls**          | `Ask for approval`, `Auto-approve edits`, and `Full access` conversation profiles, an approval dialog with a code preview and per-grant scope (this call vs. this conversation), plus per-connector and per-tool policies.                                                                                                                                                                                                                |
| **Review and verification**  | An opt-in reviewer that audits a completed turn against its own transcript, execution log, and artifacts, reports pass/warn/fail findings, and can run a bounded fix loop to correct them.                                                                                                                                                                                                                                                |
| **Distribution and support** | Installers for macOS, Windows, and Linux, plus update guidance, local diagnostics, and community links.                                                                                                                                                                                                                                                                                                                                   |

## Model Providers

Open Science is model-agnostic: connect it to major cloud LLM providers, a custom gateway, or reuse an existing Claude or Codex subscription. There are four ways to connect a model:

| Provider mode                | How it works                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Built-in cloud providers** | Choose from the provider list shown by the installed app and authenticate with the requested key.                                                                                                                                                                                                                                |
| **Custom Gateway**           | Supply a compatible Base URL, API Key, and exact model ID. The default API format (Messages, Chat Completions, or Responses) is derived from the active agent framework, so a new custom gateway is compatible out of the box.                                                                                                   |
| **Codex Subscription**       | Select the Codex agent framework first, then you can select Codex subscription in provider type                                                                                                                                                                                                                                  |
| **Claude Subscription**      | Sign in with a Claude subscription in two modes: **shared** (a browser login that stores credentials in your default `~/.claude` profile) or **isolated** (an app-managed `claude setup-token` run under an app-owned `CLAUDE_CONFIG_DIR`, fully isolated from `~/.claude/`, with a browser flow plus a paste-a-token fallback). |

The legacy **Local Claude** provider has been removed. Previously stored Local Claude entries are
dropped during upgrade; add **Claude Subscription** and authenticate with `claude setup-token`
instead.

Built-in cloud vendors currently include OpenAI, Anthropic, Grok (xAI), DeepSeek, Zhipu AI (GLM) with a dedicated GLM Coding Plan endpoint, Kimi (Moonshot), MiniMax, StepFun with a dedicated Step Plan subscription endpoint, Xiaomi MIMO, SenseNova, Volcengine Ark, and the OpenRouter aggregation gateway, among others; some are region-specific.

Provider vendors, available models, and regional endpoints can evolve independently of this README. Treat the provider picker and connection test in the installed app as the source of truth.

## Data, Permissions, and Trust

Open Science stores project data, settings, artifact versions, and provenance evidence on the local computer. API Keys are kept locally and use the operating system's secure credential storage when it is available. Logs are local and are not uploaded automatically.

### Downgrading safely

Installing an older Open Science application does not downgrade data that a newer version has
already written. To prepare a compatible, isolated copy for Open Science 0.7.3, quit the app and run:

```bash
open-science rollback-to-0.7.3 --yes
```

The command preserves the newer Config Root and data without rewriting them, converts the active
Session branches into the 0.7.3 format, and activates a separate rollback Data Root. It does not
require a backup made before the upgrade. Install and start 0.7.3 only after the command succeeds.
See [the CLI downgrade guide](packages/open-science/CLI.md#rollback-to-073) for retained data,
limitations, custom paths, and recovery locations.

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

Open Science is available as a released desktop application and is actively developed. v0.8.0 established immutable artifact versioning and inspectable provenance as shipped foundations, and v0.8.1 hardens provenance recovery, sharpens context and file-library awareness, and stabilizes R package management, while keeping deterministic reconstruction, portable environment restoration, and full-fidelity session replay on the roadmap.

For version-specific features, provider and catalog changes, platform packaging, and recent fixes, use the [latest release notes](https://github.com/aipoch/open-science/releases/latest) and the installed app. For a maintained shipped/partial/planned breakdown, see the [Capability Map](ROADMAP.md#capability-map).

Open Science assists execution and record-keeping; researchers remain responsible for methods, interpretation, privacy, and scientific validity.

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

### Headless CLI and SDK

The headless CLI and zero-dependency Node.js SDK use the same local daemon, projects, sessions,
credentials, and permissions as the desktop and web interfaces. Detailed usage lives with the
publishable package so there is one command reference to maintain:

- [CLI guide](packages/open-science/CLI.md) - installation, service lifecycle, task automation,
  artifacts, output formats, and exit codes
- [SDK package overview](packages/open-science/README.md) - Node.js quick start and package entry point

## Building From Source

### macOS Gatekeeper

If the copy you downloaded or built does not carry an Apple Developer ID trusted by your Mac, macOS may block it. In that case:

1. In Finder, right-click **Open Science.app** and choose **Open**.
2. If it remains blocked, go to **System Settings → Privacy & Security** and choose **Open Anyway**.
3. For a copy you built or downloaded from this repository and have verified, clear quarantine once:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Open Science.app"
   ```

Only remove quarantine from a package whose source and checksum you trust. See [SECURITY.md](SECURITY.md) for release verification and vulnerability reporting.

### Windows SmartScreen

If Windows shows an unknown-publisher warning, verify the downloaded asset and checksum, choose **More info**, and then **Run anyway**. Do not bypass SmartScreen for packages obtained outside the official Releases page.

## Roadmap

<img width="1920" height="1140" alt="Open Science product roadmap and capability status overview" src="https://github.com/user-attachments/assets/476c1b07-cb8e-4da0-80e3-46413710407b" />

The product roadmap and capability status are maintained in [ROADMAP.md](ROADMAP.md). This README intentionally does not duplicate the moving list of priorities or release targets.

## Relationship to the aipoch Ecosystem

<img width="1920" height="1140" alt="How Open Science fits the aipoch ecosystem as the desktop orchestration layer for open scientific AI workflows" src="https://github.com/user-attachments/assets/0ab847b1-1b7d-43f4-8c11-480a578e6c7d" />

Open Science is developed by [aipoch](https://github.com/aipoch) as the desktop orchestration layer for open scientific AI workflows.

- [aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills) is a broader collection of file-based medical and scientific research skills. Compatible skills can be inspected and imported into Open Science from GitHub.
- Open Science supplies the project/session workspace, agent runtime, execution, artifacts, previews, permissions, and connectors that turn those instructions into an interactive workflow.

Skills and connectors can execute code or send data externally. Review their source, license, scripts, and network behavior before enabling them.

## What This Is Not

- **Not just a chat UI.** The product is organized around persistent projects, execution, files, artifacts, and reviewable tool activity.
- **Not an unofficial client for another product.** It is an independent implementation with its own codebase, data model, interface, and roadmap.
- **Not a replacement for scientific judgment.** Outputs still require domain review, statistical validation, and verification against primary sources.

## Frequently Asked Questions

### **Q: What should I do the first time I open Open Science?**

A: Complete **Prepare environment** and **Model provider**. Fix required rows marked `Action needed`, use `Install missing runtime` if offered, click `Check again`, and then test a model connection.

### **Q: What is an API Key, and where do I get one?**

A: An API Key is a secret credential issued by a model provider. Create or copy one from that provider's developer/API console. The provider may bill requests made with the key. Treat it like a password: never share it or commit it to a repository.

### **Q: Do I need an API Key?**

A: Not if you reuse an existing subscription login — a Claude subscription via `claude setup-token` (paste the token into the Open Science sign-in prompt), or a ChatGPT/Codex subscription login on the Codex backend. Built-in cloud providers and custom gateways require their own keys.

### **Q: Which model providers can I use?**

A: Open the provider picker during setup or under `Settings → Model` for the choices supported by your installed app. You can use a built-in cloud provider, a compatible Custom Gateway, a Claude subscription via `claude setup-token`, or a Codex subscription on the Codex backend.

### **Q: Why does the model connection test fail?**

A: Check the API Key for missing characters or spaces, verify the Base URL and region, use the provider's exact model ID, and confirm network access and account balance. For a Claude subscription, re-run `claude setup-token` in a terminal and paste the new token into the Open Science sign-in prompt.

### **Q: Why is `Continue` disabled during setup?**

A: At least one required environment check has not passed. Fix the row marked `Action needed`, return to automatic detection, and click `Check again`. Python is optional and only affects Notebook execution.

### **Q: Setup is complete. How do I start a research task?**

A: Create or open a project, start a session, attach any source files, and describe the goal, constraints, expected output, and validation criteria. Use `@` to reference a project file and `/` to select an enabled skill.

### **Q: How do I run jobs on a remote HPC cluster?**

A: Enable the **Remote Compute (SSH)** skill under **Settings → Skills**, register your cluster under **Settings → Compute**, then start a session and select the skill with `/remote-compute-ssh`. The skill handles host registration, short commands via SSH, and fully async job submission — the app automatically starts an analysis turn when the job finishes, so you never write a polling loop.

### **Q: Is there a command-line interface?**

A: Yes. Install it in one click from **Settings → General → Command line tool → Install command** (adds `open-science` to your PATH; no separate Node.js needed). The CLI controls the local service and submits research tasks without opening a browser:

```bash
# Start the service in the background
open-science start --no-open

# Create a project and run a task, wait for completion
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

### **Q: How do I inspect where a generated result came from?**

A: Open the generated artifact and choose **Provenance**. Select a version to inspect the content identity and the available producer code, execution history, inputs, environment inventory, producing conversation context, and reviewer evidence. Evidence Open Science could not verify is marked unavailable.

### **Q: Can I revise an earlier request without losing the conversation that followed?**

A: Yes. Edit a completed user message and resend it to create a new branch from that point. The original later turns remain available, and the revision arrows beside the message switch between the alternative paths.

### **Q: Does my research data stay on my computer?**

A: Projects, sessions, files, settings, and configured credentials are stored locally by default. Content needed for model requests, web searches, or connector calls may still be sent to the external service you selected, so review sensitive inputs and provider policies before running a task.

## Get Involved

| Channel                                                                  | Use it for                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Bugs, reproducible failures, and concrete feature proposals             |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Design questions, roadmap proposals, and longer technical conversations |
| [Discord](https://discord.gg/85dKfuGM9)                                  | Community help, contributor coordination, and informal discussion       |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Release announcements and build-in-public updates                       |

Before opening a public issue, remove API Keys, tokens, private file paths, unpublished data, patient identifiers, and other sensitive material from logs and screenshots. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=aipoch%2Fopen-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=aipoch/open-science&type=date&theme=dark&legend=top-left&sealed_token=SfYmaFKVrSeoWXSFpM9v1yIMgQGuqcSgB3atEXCZ41bGZjk56hO-cJaQrD1sVpdyioihMw-HX-gxMQ3LsNaMPk8hP4sk1CzYoh-AtROEZeFB_5GestwN4xj2dlQSBuqa4nFUWabnN4YTg02U7tipvbF_YkahNnTz5m5W-GEn3xioDebss0lJJL8HrJfl" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=aipoch/open-science&type=date&legend=top-left&sealed_token=SfYmaFKVrSeoWXSFpM9v1yIMgQGuqcSgB3atEXCZ41bGZjk56hO-cJaQrD1sVpdyioihMw-HX-gxMQ3LsNaMPk8hP4sk1CzYoh-AtROEZeFB_5GestwN4xj2dlQSBuqa4nFUWabnN4YTg02U7tipvbF_YkahNnTz5m5W-GEn3xioDebss0lJJL8HrJfl" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=aipoch/open-science&type=date&legend=top-left&sealed_token=SfYmaFKVrSeoWXSFpM9v1yIMgQGuqcSgB3atEXCZ41bGZjk56hO-cJaQrD1sVpdyioihMw-HX-gxMQ3LsNaMPk8hP4sk1CzYoh-AtROEZeFB_5GestwN4xj2dlQSBuqa4nFUWabnN4YTg02U7tipvbF_YkahNnTz5m5W-GEn3xioDebss0lJJL8HrJfl" />
 </picture>
</a>
