# Open-Science Roadmap

Open-Science is an open-source, local-first AI research workbench. Researchers can move from
literature and data to agent-assisted computation, inspectable results, and portable research records
in one workspace, while choosing compatible models and compute infrastructure.

This roadmap separates **available capabilities**, **remaining gaps**, and **possible future work**.
It is a capability map, not a release log or a promise of delivery dates. The baseline below was
reviewed against `main` on **2026-09-26**, with package version **0.33.3**. Some changes on `main` may
not yet be in an installed release; consult the [release notes](https://github.com/aipoch/open-science/releases)
for version-specific availability and the [README](README.md) for setup and a product tour.

## Table of Contents

- [Where We Are Today](#where-we-are-today)
- [Capability Map](#capability-map)
- [Important Capability Boundaries](#important-capability-boundaries)
- [Delivery Phases](#delivery-phases)
- [Long-Term Vision: Five Horizons](#long-term-vision-five-horizons)
- [Boundaries & Non-Goals](#boundaries--non-goals)
- [How to Contribute to This Roadmap](#how-to-contribute-to-this-roadmap)

## Where We Are Today

The core research loop is available: organize a project, bring in papers and data, ask an agent to
plan and execute, run Python or R locally or on SSH/Slurm infrastructure, review the outputs and
their provenance, and preserve or transfer the research record. The product remains an evolving
preview; having a capability does not imply that every model, platform, dataset, or recovery path
behaves identically.

The workbench now extends well beyond that initial loop:

- **Read and organize evidence:** a literature library, smart screening collections, PDF structure
  extraction, persistent PDF annotations and document notebooks, citations, and source-linked conversations.
- **Work across research paths:** message branches, independent side chats, reusable specialists,
  subagent delegation, reviewable plans, background computation, and notifications.
- **Inspect and reuse results:** immutable file versions, recorded execution and lineage, optional
  turn review, artifact replay checks, portable environment bundles, `.science` packages, and RO-Crate exports.
- **Use the same local backend through several entry points:** desktop, localhost browser, headless
  CLI and Task SDK, plus paired mobile browser access. Individual capabilities still have surface restrictions.

The immediate planning problem is to deepen reliability, evidence quality, and portability across
these workflows. It is no longer accurate to describe the project as waiting to build notebooks,
remote compute, literature management, marketplaces, or basic reproducibility checks.

## Capability Map

Every **Available now** entry describes an implemented capability, not a guarantee that its broader
research goal is complete. The final column distinguishes current limits from extensions that still
need design and prioritization. Related rows can evolve independently.

| Area                               | Available now                                                                                                                                                                                                                  | Limits and remaining direction                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects and sessions              | Project organization, pinning and archiving; persistent conversation branches; editable prompts; writable session forks; global search and project navigation.                                                                 | Research packages and forks have different copy rules. No simultaneous multi-user editing.                                                                       |
| Conversation and attention         | Multiple side chats, queued messages, session references, live tool activity, review-gated plans, clarification and permission cards, bookmarks, and a notification inbox.                                                     | Side chats are separate from the main transcript and are excluded from research packages and session forks.                                                      |
| Models and agent frameworks        | Claude Code, OpenCode, Codex, and CodeBuddy; built-in providers and compatible custom endpoints; Claude/Codex subscription sign-in; model and reasoning controls; connection validation and scenario-specific model policies.  | Protocol support depends on the selected framework. This is not yet a backend-independent gateway for arbitrary model protocols.                                 |
| Context and usage                  | Opt-in project memory, attachment and linked-PDF context, context composition estimates, native compaction, and token usage dashboards with turn/model-call details.                                                           | Context windows and attachment handling vary by model/framework; memory and retained transcript evidence are not complete copies of every input.                 |
| Specialists and delegation         | Personal specialists with scoped skills/connectors, conversational customization, portable packages, signed marketplace discovery, and subagent delegation with messaging and recovery.                                        | Package sharing is available; a broader community model for fork lineage and institutional governance remains a future direction.                                |
| Skills and capability selection    | File-based skills, explicit loading, conversational creation, save-as-skill, package/GitHub imports, signed marketplace installation and updates, batch management, and classification-assisted skill/connector selection.     | User-facing version pinning and a first-class cross-machine fork workflow remain open. Broader evidence-aware capability composition extends existing selection. |
| Scientific connectors              | Built-in life-science resources and an offline molecule viewer; custom MCP servers; configuration import/export; shared credentials and OAuth; per-agent resource access and tool permissions.                                 | Coverage and limits depend on each upstream service. New scientific domains need maintained contracts and validation, not just more catalog entries.             |
| Literature library                 | References, collections, tags, notes, project links, identifier and batch-PDF import, duplicate review/merge, open-access full-text lookup, bibliographies, BibTeX/RIS export, and in-workspace reference previews.            | Metadata and full-text availability vary by source; an imported reference does not guarantee an accessible PDF.                                                  |
| Smart literature screening         | Inclusion/exclusion criteria, draft previews, individual or batch evaluation, optional PDF evidence, distinct AI/manual decisions, live progress, pause/resume, retry, and opt-in automatic updates.                           | Screening supports human triage. It does not establish study quality or replace a systematic-review protocol.                                                    |
| Reading and annotations            | PDF text/search/navigation, figures/tables/algorithms extraction and agent reads, persistent PDF marks and document notes, native annotation import, annotated-PDF/notes export, and conversational text/image/PDF selections. | PDF region anchoring exists. Region selection on other image/HTML surfaces and broader editable scientific viewers remain open.                                  |
| Scientific files and previews      | Streaming uploads, project file browsing, versioned text editing, and previews for tables, sequences, PDFs, Office documents, images, code, HTML, Notebook history, and molecular structures.                                  | The 10 GiB per-file upload limit is separate from parsing, preview, and model-context limits. Large data may require chunked analysis.                           |
| Notebook and environments          | Persistent Python/R kernels and REPL, shell execution, managed and user-provided interpreters, environment/package management, variable inspection, run history, and `.ipynb` export.                                          | Environment capture and portability have explicit bounds; see below. Shell and protection behavior depend on platform/setup.                                     |
| Remote and background compute      | Local background work; SSH hosts and Slurm submission; cancellation, restart recovery, result collection, and automatic delivery/notifications.                                                                                | Hosts require user/admin provisioning and suitable software/permissions. Managed cloud-GPU provisioning and submission remain open.                              |
| Artifacts, review, and provenance  | Immutable checksummed versions; available producer code, inputs, execution, environment and branch evidence; lineage; optional reviewer with bounded correction; on-demand code reconstruction.                                | Missing evidence is reported explicitly. Reviewer findings and reconstructed code do not prove scientific validity or fill missing original evidence.            |
| Replay and environment portability | Eligible artifact versions can be re-executed from a sealed recipe in isolation and compared; session-wide batches and exportable verification records; version-bound environment bundle export/import.                        | No deterministic whole-session replay or solver-exact environment guarantee. Generic live-environment export and bare external lock-file import remain open.     |
| Research exchange                  | `.science` session export/import with selectable files and literature PDFs; Markdown/PDF conversation export; artifact downloads; lightweight/complete artifact RO-Crate 1.1 exports and package metadata.                     | Imports are read-only and do not run code or restore credentials. Sharing transfers selected records, not a live process or complete machine state.              |
| Permissions and local data         | Scoped grants and revocation, approved local-folder access, network controls, centralized credentials, storage relocation/recovery, proxy settings, and selectable diagnostic exports.                                         | Protection varies by execution path and platform. Automated credential rotation and institutional policy/audit controls remain future work.                      |
| Access and distribution            | Desktop installers for macOS, Windows and Linux; signed macOS/Windows releases, macOS notarization, updates, onboarding, interface translations, localhost web, headless CLI/Task SDK, and paired mobile access.               | Browser/CLI access does not imply desktop feature parity or a hosted multi-tenant service. Catalog and platform support follow the installed release.            |

Implementation and product references: [current architecture](docs/PRD.md#8-current-architecture-what-is-actually-implemented),
[workspace design](docs/design.md), [security boundaries](docs/security.md), and
[CLI/SDK package](packages/open-science/README.md). The following distinctions matter when assessing
what is complete.

## Important Capability Boundaries

### Traceability, replay, and scientific validity

These are three different claims:

1. **Traceability is available.** Inspect an exact artifact version and its retained inputs, code,
   execution, environment inventory, branch context, and review evidence where captured.
2. **Artifact replay checks are available.** In the desktop app, an eligible version with a complete
   recipe, required inputs, and usable runtime can run again in an isolated environment. Byte-exact,
   bounded image/table, and optional scientific comparisons report what matched in that check.
3. **Deterministic whole-session reproduction remains open.** A recorded environment inventory or
   exported bundle is not a complete solver lock, and external services, system libraries, hardware,
   random processes, and uncaptured inputs can affect reconstruction. Matching output is not proof of
   a sound method or conclusion.

RO-Crate export makes recorded provenance exchangeable; it does not strengthen evidence that was
never captured. Generated code reconstruction is an aid to investigation, not the original producer
record. See the [artifact implementation](src/main/artifacts/) and the
[reproducibility case guide](docs/reproducibility-cases/README.md).

### Packages, forks, and environments

- **Research package:** export selected session history, branches, file versions, Notebook records,
  verification evidence, environment locks, and optional literature PDFs. Side chats, private
  bookmarks, and credentials are excluded. Import creates inspectable read-only history and does
  not execute its contents.
- **Writable fork:** continue a copied research history under new identities without changing its
  source, including when starting from imported history. Local forks can copy bookmarks; side chats
  are excluded. Omitted or unavailable file evidence cannot be recreated by forking.
- **Environment bundle:** export an artifact version's captured environment and import it as a
  managed environment when the bundle is complete and compatible with the target platform. Partial
  or wrong-platform bundles are not restorable. This is separate from exporting an arbitrary live runtime, importing any
  external lock file, or overwriting an existing environment; those broader operations remain open.

These are implemented transfer workflows with bounded scope, not full machine backups. See the
[session package implementation](src/main/session-package/) and
[environment export/import checks](src/main/artifacts/artifact-reproducibility-export.test.ts).

### Reading context and persistent notes

Conversation annotations send selected evidence to the agent. Private bookmarks help a researcher
return to a location. Persistent PDF annotations and document notebooks retain marks, comments and
notes on the document; library attachments share their notebook across references, projects, and
sessions. Annotated PDF export creates a separate file and preserves the source bytes.

These capabilities already exist. Future interaction work concerns broader spatial editing and
context composition, rather than introducing PDF annotation support for the first time. See
[PDF annotation services](src/main/pdf-annotations/) and
[smart collection behavior](src/main/literature/smart-collections.test.ts).

### Framework, platform, and trust boundaries

Model compatibility follows the chosen framework and endpoint protocol. Scenario-specific reviewer,
subagent, vision, and classification settings provide routing choices today; they are not a universal
gateway. Capability classification already helps select skills and connectors, while broader
research-context discovery remains a direction for improvement.

Approved folder access and scoped grants exist. Notebook/compute network protection restricts
outbound access to defaults and approved destinations, with platform-specific requirements; Windows
protected execution requires administrator setup. Windows WSL2 Bash remains an explicit opt-in
preview. None of these controls implies identical sandbox coverage for every external tool or
provider. See [data, permissions, and trust](README.md#data-permissions-and-trust) and
[security guidance](docs/security.md).

## Delivery Phases

The earlier sequential Phase 0–5 model no longer describes delivery: capabilities from every phase
have landed alongside one another. Work is better organized into the following overlapping tracks.
**The ordering below is a proposed focus, not an approved schedule.** Future items require scoped
issues, design review where needed, and maintainer prioritization; no release dates are assigned.

### Deepen the workflows already available

| Direction                         | Existing foundation                                                                                                     | Useful next outcome                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real research reproducibility     | Artifact checks, portable records, and the [Reproducibility Pilot](https://github.com/aipoch/open-science/issues/2725). | Curate rerun examples across Python/R and analysis types, document failures, and turn them into focused regression tests and guidance. See the [reviewed case index](docs/reproducibility-cases/index.md) for actual evidence. |
| Daily reliability and scale       | Durable sessions, background jobs, recovery, large-library and long-conversation handling.                              | Expand representative restart, cancellation, large-data and cross-platform journeys; make unresolved recovery and missing evidence easier to understand.                                                                       |
| Literature-to-analysis continuity | Smart screening, document notes, citations, extracted PDF structures, and library context.                              | Improve source/evidence navigation and extraction quality, with reviewed examples showing how screening decisions and downstream analysis retain their sources.                                                                |
| Research capability quality       | Scientific connectors, skills, specialist packages, and existing classification.                                        | Broaden tested scientific workflows and upstream contract coverage; improve selection quality and explain why a capability is useful for a task.                                                                               |

### Close the remaining portability and control gaps

These extend implemented foundations; the scope and order are still to be decided.

| Candidate                          | Remaining work to define                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stronger reproduction              | More complete environment and input capture, clearer unsupported cases, and reconstruction across machines; define the conditions before claiming deterministic Session replay.                              |
| Model independence                 | A backend-independent gateway and consistent per-agent routing across supported protocols, preserving framework-specific behavior, credentials, permissions, and recovery.                                   |
| Skill and specialist reuse         | User-facing skill version pinning, explicit fork/update lineage, and more reproducible capability selections across machines. Existing marketplace discovery and package exchange remain the starting point. |
| Broader automation                 | Extend the current CLI/Task SDK and browser surface around concrete research workflows, with documented capability boundaries rather than assumed desktop parity.                                            |
| Context and scientific interaction | Evidence-aware discovery/composition beyond current classification, region anchoring on image/HTML surfaces, and editable scientific viewers with traceable revisions.                                       |
| Trust and credential lifecycle     | Automated credential rotation and more consistent, inspectable policies across execution paths, building on current grants, folder access and network controls.                                              |

### Explore longer-term infrastructure

- **Cloud compute:** managed GPU/cloud job submission beyond SSH and Slurm. Any proposal needs a
  clear cost/approval model and ownership of provisioning, cancellation, recovery, and removal.
- **Open research commons:** shared workflows, datasets, protocols, and curated agents with explicit
  provenance, fork lineage, and community governance beyond today's skills/specialist marketplaces.
- **Institutional and optional hosted use:** deployment, policy administration, and audit requirements
  for labs or institutions while preserving local-first use. A hosted offering is an exploration,
  not a current service or a commitment to live collaborative editing.

## Long-Term Vision: Five Horizons

The founding horizons remain useful as direction, not completion gates or a delivery sequence:

| Horizon                        | Direction                                                                         | Current foothold                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **1. Scientific Connectivity** | Make scientific data and tools directly accessible to research agents.            | Scientific connectors, MCP integration, literature access, and local/remote computation.                    |
| **2. Agent Portability**       | Let research capability follow the scientist across models and infrastructure.    | Multiple frameworks/providers, portable skills and specialists, research packages, and environment bundles. |
| **3. Context-Aware Discovery** | Select and compose capabilities appropriate to a task and its evidence.           | Explicit skill loading, classification-assisted selection, literature context, and opt-in project memory.   |
| **4. Closed-Loop Research**    | Connect reading, computation, review, and verification without losing provenance. | Branches, notebooks, immutable artifacts, reviewer checks, and artifact replay.                             |
| **5. Open-Science Commons**    | Share reproducible research infrastructure across labs and platforms.             | Open-source code, reviewed marketplaces, portable records, and the reproducibility pilot.                   |

## Boundaries & Non-Goals

- **Single-researcher focused.** Sharing is through exported records and packages, not real-time
  co-editing of a session by multiple people.
- **Computation and evidence, not a prescribed scientific ontology.** The system does not require
  first-class hypothesis/experiment/conclusion entities to conduct research.
- **Expert judgment remains essential.** Review, screening, and reproduction checks cannot certify
  statistical validity, absence of data leakage, or the truth of a scientific claim.
- **Local-first does not mean automatically offline.** Selected model providers, connectors,
  remote compute, and remote access can contact external services under their configured policies.
- **Independent implementation.** Open-Science is not a proxy or reskin of a closed-source client
  and is not designed to bypass another vendor's billing or terms.

## How to Contribute to This Roadmap

Choose a remaining gap or a concrete failure in an existing workflow. Open an
[issue](https://github.com/aipoch/open-science/issues) with the research use case, current behavior,
proposed outcome, and an example that can be checked. Use
[Discussions](https://github.com/aipoch/open-science/discussions) for unsettled product or architecture
questions, and follow [CONTRIBUTING.md](CONTRIBUTING.md) for implementation and validation.

Keep this document maintainable:

- Update the relevant capability and its remaining boundary when work lands; put release-by-release
  detail in release notes. Keep changing model names and catalog counts in their authoritative catalogs.
- Call a capability available only when its end-to-end path exists; describe framework, platform,
  surface, and evidence restrictions alongside it. Planned work should link to a scoped issue when one exists.
- Distinguish an implemented foundation from the larger aspiration. Do not mark an entire area
  complete because one slice shipped, or label a whole area unstarted because an extension is missing.
- For implementation proposals, call out historical-data compatibility, new states/enums, and
  persistence changes separately before choosing a design. This roadmap itself introduces none of them.
