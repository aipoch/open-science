# Open Science

An open-source, model-agnostic AI workbench for scientific discovery: a
coordinating agent plans and executes multi-step research tasks against
scientific data and compute, and returns not just an answer but the code,
execution record, and artifacts that produced it. This glossary fixes the
canonical language the project uses to talk about that work.

## Agents & Orchestration

**Coordinating Agent**:
The agent that converses with the researcher and does the work — planning
multi-step tasks and executing tool calls. In the reviewer design docs it is
"the agent under review".
_Avoid_: main agent, 主 agent, orchestrator, assistant, chatbot

**Specialist Sub-Agent**:
A domain-focused Coordinating-Agent helper (genomics, proteomics, structural
biology, cheminformatics, social science, economics) that the coordinator
delegates part of a task to. Planned, not yet shipping.
_Avoid_: worker, helper agent

**Reviewer**:
A planned verification agent that checks the Coordinating Agent's output —
citations, units, and statistical methods — before it ships, with its own checks
inspectable. Not yet implemented.
_Avoid_: verifier, checker, critic, validator

## Skills

**Skill**:
A unit of agent capability shipped as plain, versioned, human-readable, forkable
files (markdown + code) — auditable by the researcher who trusts it, not an
opaque binary.
_Avoid_: plugin, extension, add-on

**Skills Commons**:
The open, versioned, community-contributed registry that Skills are shared
through. Planned; today skill management is file-based and local.
_Avoid_: marketplace, plugin store, skill registry

## Work Organization

**Project**:
The top-level container that isolates a line of work — its sessions, artifacts,
and notebook workspace are kept separate from every other project's.
_Avoid_: workspace, folder

**Session**:
One conversation-plus-execution thread inside a Project, with durable history
that fully restores on reopen.
_Avoid_: chat, conversation, thread

## Execution & Artifacts

**Artifact**:
A durable file the agent saved — report, figure, table, dataset — that the
researcher will later reference or cite. Namespaced by project, session,
message, and run.
_Avoid_: output, result, file, attachment

**Run**:
A single execution of code or a tool, together with the durable, replayable
record the system keeps of it.

**Execution Record**:
The system's durable record of what a Run actually produced — stdout, errors,
exit status — kept so an artifact traces back to how it was generated.
_Avoid_: log, transcript, agent output

**Provenance**:
The lineage connecting every claim back to the exact code, environment, and data
version that produced it. Meant to be a system property, produced automatically,
not a discipline maintained by hand. Largely planned.
_Avoid_: lineage (as a standalone term), audit trail, history

## Data, Models & Compute

**Connector**:
An agent-callable integration to a scientific data source — the open commons
(PubMed, UniProt, PDB, ChEMBL, GEO, …) or a custom MCP server for private data
— surfaced as callable tools behind the permission gate.
_Avoid_: integration, plugin, data source adapter

**Model Gateway**:
The pluggable layer that fronts any LLM provider or self-hosted model, with
per-agent routing, so the core stays model-agnostic. Planned; today's runtime is
single-backend.
_Avoid_: model router, LLM proxy, provider adapter

**Compute Fabric**:
The broker that scales a job across a laptop kernel, an institutional HPC/Slurm
cluster, and on-demand cloud GPUs, handling submission, monitoring, and cost
guardrails. Planned; today all execution is local.
_Avoid_: compute broker, scheduler, job runner

**Permission Gate**:
The human-in-the-loop approval point that pauses higher-risk tool calls (new data
sources, compute budgets, external credentials) for explicit, scoped approval.
_Avoid_: permission broker, approval dialog, guardrail

## Interface

**Preview**:
In-app native rendering of an artifact (CSV, FASTA, HTML, image, JSON, Markdown,
text, notebook) so the researcher never leaves the app to inspect an output.
_Avoid_: viewer, render, display
