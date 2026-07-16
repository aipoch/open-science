# Open Science — Product Requirements Document

> Status: living document, tracks the shipped product plus near-term scope. For the long-range vision and phase-by-phase delivery plan, see [`ROADMAP.md`](../ROADMAP.md). For the visual/interaction spec, see [`design.md`](../design.md).

## 1. Summary

**Open Science is an open-source, model-agnostic AI workbench for scientific discovery.** It runs as a self-hosted desktop application that pairs a planning-and-execution agent with a persistent, sandboxed compute kernel and durable project/session storage — so a researcher can hand off a real data-analysis or literature task to an agent and get back not just an answer, but the code, execution record, and artifacts that produced it.

The project exists because the clearest current articulation of this product category is closed-source and single-vendor: gated by billing region, subscription tier, and one company's model and infrastructure choices. Open Science is an independent, from-scratch implementation of the same category of tool — not a proxy, wrapper, or jailbreak of any existing closed product — built so any lab, on any budget, with any model, can run it on its own terms.

## 2. Problem Statement

A working researcher's day is a tour of disconnected tools: a reference manager, a notebook kernel, an SSH session into a cluster, browser tabs for database web forms, a stats package, and a manuscript editor that knows nothing about any of the above. None of these tools share state. None of them remember what was done yesterday. Reproducing an analysis from three months ago is often harder than running it the first time.

This shows up as four structural pains:

1. **Results aren't reproducible.** Code, data, and environment are scattered across machines, tracked (if at all) by manual habit. Nobody can reliably answer "which script, which parameters, which dependency versions produced this exact figure?"
2. **Constant tool-switching.** A typical workflow bounces between a scripting language, a stats package, shell access to a cluster, and literature search — every switch loses context and forces manual data movement.
3. **Fragmented compute.** A laptop, a lab server, an HPC cluster, and cloud GPUs are all valid places to run a job, but choosing and coordinating between them is manual, and data gets shuttled around unnecessarily.
4. **Audit is an afterthought.** In regulated research settings, reconstructing "who generated what, with what code, at what time" usually means reading logs after the fact rather than relying on something the system tracked by default.

## 3. Goals

- Give a researcher an agent that can **plan, execute, and revise** multi-step analysis and research tasks, not just suggest code for a human to run.
- Make every artifact the agent produces **traceable back to the code, data, and environment** that generated it.
- Keep the system **model-agnostic and self-hostable** by design, so no single vendor's pricing, billing region, or infrastructure choices gate access to it.
- Ship a **desktop-first experience** today, with the underlying orchestration core designed to support additional interfaces (CLI/SDK, web) later without a rewrite.
- Be honest about maturity: this PRD documents what exists, what's partially built, and what's aspirational — see the [Roadmap](../ROADMAP.md) for the phase-by-phase breakdown.

## 4. Non-Goals

- **Not a real-time multi-user collaborative editor.** Team workflows happen through export/share/import, not simultaneous co-editing of one session.
- **Not a replacement for domain-expert judgment.** Statistical validity, batch-effect analysis, and data-leakage risk remain calls the researcher makes; the system reduces the cost of *executing* and *recording* work, not the cost of *judging* it.
- **Not modeling research semantics.** The system's structured objects are computations and artifacts, not first-class "hypothesis / experiment / conclusion" entities.
- **Not a proxy, reskin, or unofficial client of any closed-source product.** Open Science shares no code with any single vendor's client software.

## 5. Target Users

- **Individual researchers and small labs** running data-heavy analysis (genomics, proteomics, structural biology, cheminformatics, and beyond) who want an agent that can execute, not just chat.
- **Institutions that cannot use a cloud-hosted, subscription-gated product** — due to data residency, billing region, or data-handling policy (e.g. PHI, unpublished data) — and need to self-host on their own infrastructure.
- **Contributors and toolmakers** who want to extend the system with new connectors, kernels, or skills rather than being limited to a closed plugin marketplace.

## 6. Product Principles

These are the constraints the project treats as non-negotiable as it grows (see the founding vision in the [README](../README.md#design-principles) for full rationale):

- **Access is a right, not a privilege.** No plan tier, billing-region allowlist, or approval queue stands between a researcher and the software.
- **Model-agnostic core.** The agent runtime should ultimately talk to LLMs through a pluggable gateway — Claude, GPT, Gemini, DeepSeek, Qwen, or a locally-hosted open-weight model are all first-class citizens, not a hardcoded dependency. (Today's runtime is an early, single-backend implementation of this — see [§8](#8-current-architecture-what-is-actually-implemented).)
- **Local-first, data-sovereign by default.** Self-hosting is the default deployment target, not an enterprise upsell.
- **Reproducibility is a system property, not a discipline.** Every artifact should eventually carry the code, environment, and data lineage that produced it, generated automatically rather than maintained by hand.
- **Skills should be plain files, not opaque plugins.** Versioned, human-readable, and forkable — auditable by the person trusting them with their analysis.
- **Human-in-the-loop by construction.** New data sources, compute budgets, and external credentials require explicit, scoped approval; autonomy is opt-in, never ambient.
- **Composability over monolith.** Small, swappable services (model gateway, skill runtime, compute broker, artifact renderer) instead of one inseparable black box.
- **Trust is verified, not assumed.** Where the system makes a claim, that claim's basis (citation, computation, statistical method) should be checkable — ideally by another agent, not just by the researcher re-deriving it by hand.

## 7. Core User Journeys

1. **Start a project, run an analysis.** A researcher creates a project, opens a session, and asks the agent to load data, run a script, and produce a figure. The agent plans steps, executes them in the notebook kernel, and reports back with the resulting artifact — all without the researcher hand-writing the glue code.
2. **Resume where you left off.** The researcher closes the app and comes back days later; the home page shows their projects and five most recent sessions, and reopening one restores full conversation and execution history.
3. **Review what the agent did before trusting it.** Every tool call the agent makes is shown as a typed activity row (code diff, code block, web search, etc.), and higher-risk actions pause for explicit approval before running.
4. **Preview outputs without leaving the app.** Generated CSVs, images, HTML reports, FASTA files, JSON, Markdown, and notebook cells render natively in-app instead of requiring the researcher to open them in a separate tool.
5. **Organize work by project.** Multiple projects keep sessions, artifacts, and notebook workspaces isolated from each other, so a researcher running several concurrent lines of work doesn't have them bleed into one shared history.

## 8. Current Architecture (What Is Actually Implemented)

Open Science today is an Electron + React + TypeScript desktop application built around four cooperating layers:

| Layer | Responsibility | Current implementation |
| --- | --- | --- |
| **Interface** | Desktop shell, workspace UI, home page | Electron main/renderer split; React + TypeScript; shadcn/Radix design system (see [`design.md`](../design.md)) |
| **Agent Harness** | Plan → execute → reflect loop, tool-call visualization, permission gating | Agent runtime wrapped over the Agent Client Protocol (ACP), `src/main/acp/`; typed tool-activity rows in the transcript; a permission broker that pauses on higher-risk tool calls pending approval |
| **Execution / Data Plane** | Sandboxed code execution, artifact generation | A persistent Python notebook kernel (`src/main/notebook/`) with durable, replayable run history, plus the agent's own shell/search tool access |
| **Persistence** | Project/session storage, artifact storage | Prisma + SQLite for the Project entity; per-project, per-file session storage on disk (`src/main/session-persistence/`); artifact files organized by session/message/run (`src/main/artifacts/`) |

Key implemented capabilities, mapped to the codebase:

- **Project layer.** Prisma + SQLite `Project` model; full CRUD via IPC (`projects:create/list/get/update/delete`); a home page showing all projects and the five most recent sessions across them.
- **Per-project session storage.** Sessions live at `sessions/<projectId>/<sessionId>.json` (migrated from a legacy single-file format on first run, idempotently); a manifest file restores the last-open project/session; a save bridge diffs the in-memory store against disk so only changed sessions get written.
- **Notebook execution kernel.** One persistent Python process per notebook session, bridged over stdin/stdout, with per-run history (`run.json`) and write-locking to prevent concurrent corruption.
- **Artifacts.** An in-process MCP server (`open-science-artifacts`) exposes a `write_artifact_file` tool the agent calls with either inline content or a local file path; artifacts are namespaced by project, session, message, and run.
- **File preview.** Renderers for CSV, FASTA, HTML, image, JSON, Markdown, and plain text, plus a read-only notebook preview showing code and execution output side by side, all inside a dedicated preview workbench.
- **Permissions.** An `AcpPermissionBroker` intercepts tool-call permission requests from the agent runtime and surfaces them to the renderer for explicit approval before the call proceeds.
- **Attachments.** File uploads are threaded into the agent's prompt context.

For the gap between this and the full target architecture (model-agnostic gateway, provenance chain, skills commons, remote compute, security hardening, etc.), see the [Capability Map in `ROADMAP.md`](../ROADMAP.md#capability-map) — this PRD describes what the product is *for*; the roadmap tracks what's *built*.

## 9. Distribution & Packaging

- **Platforms:** macOS, Windows, and Linux via `electron-builder` (`npm run build:mac` / `build:win` / `build:linux`).
- **macOS signing & notarization.** Official release builds are **Developer ID signed and notarized by Apple** (notarization is decoupled into a capped, re-runnable `notarize-mac` CI job that staples the dmg/zip before publish), so downloaded releases open without a Gatekeeper prompt. Self-built or community-distributed `.app`s aren't notarized; they are deep ad-hoc signed at pack time (see `build/adhoc-sign.cjs`) so Gatekeeper shows the bypassable "unidentified developer" prompt instead of an unrecoverable "app is damaged" error on a quarantined copy — users right-click → Open or clear the quarantine flag; see [README: Building From Source](../README.md#building-from-source-macos-gatekeeper-note) for the exact command. Windows builds are not yet signed with an Authenticode certificate.
- **In-place auto-update.** Packaged builds self-update via `electron-updater` on macOS, Windows, and Linux — background checks against the stable release channel apply updates in place, with a manual-download fallback when auto-update can't complete.
- **Prisma runtime.** The generated Prisma client ships outside the `asar` archive (via `extraResources`) because its native query engine can't load from inside an asar; the native Claude agent binary is similarly unpacked (`asarUnpack`) so it can be spawned as a child process at runtime.

## 10. Success Signals (Directional, Not Committed Metrics)

Since this is an early, community-driven project rather than a metrics-driven product, "success" for the current phase looks like:

- A researcher can complete a real, non-trivial analysis task (multi-step, involving at least one script run and one artifact) without leaving the app.
- Reopening a session after restarting the app restores full context with no data loss.
- A new contributor can read this PRD + the Roadmap and know exactly which unimplemented capability to pick up next.

## 11. Open Questions

- **Model gateway design.** What's the right abstraction for routing different agents/sub-tasks to different model backends, given the current runtime is built tightly around the Agent Client Protocol?
- **Provenance granularity.** How much lineage metadata (code snapshot, execution log, dependency versions, environment snapshot, conversation context) is captured by default versus opt-in, and how is it surfaced to the researcher without becoming noise?
- **Skill format.** What should a portable, forkable "skill" file look like so it can move across models and frameworks (Horizon 2 in the Roadmap) without becoming vendor-specific again?

These are tracked as open design questions in [Discussions](https://github.com/aipoch/open-science/discussions) rather than settled here — the goal of this PRD is to state the target and the current state clearly, not to pre-decide every implementation detail.

---

_This PRD reflects the current codebase and product direction, and is updated as scope and implementation evolve. See [`ROADMAP.md`](../ROADMAP.md) for delivery phases and the long-range vision._
