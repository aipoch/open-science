# Intended use and safe operation

Open-Science is a research workbench for organizing literature and data, running AI-assisted
analysis, inspecting results, and exchanging captured research records. This guide describes
supported uses, operating precautions, and uses that require additional validation. It does not
add conditions to the permissions granted by the [Apache-2.0 license](../LICENSE).

Read the [security model](security.md) for implemented controls and data flows, the
[known limitations](known-limitations.md) for current risks and verification gaps, and the
[security policy](../SECURITY.md) for supported versions and private vulnerability reporting.

## Intended workflows

- Explore literature, extract or translate document content, and organize sources for review.
- Develop and run Python, R, and Shell analyses on data you are authorized to process.
- Use selected models, Connectors, Skills, and Specialists to assist a researcher-controlled task.
- Submit authorized work to configured SSH hosts or Slurm clusters.
- Inspect captured code, inputs, execution evidence, and output comparisons; share selected records
  after reviewing their contents and sharing permissions.

Feature availability depends on the platform, execution path, configured providers, and available
evidence. Desktop, browser, and CLI capabilities differ. See the [capability map](ROADMAP.md#capability-map)
and [compatibility policy](compatibility.md) for those contracts.

## Research judgment and high-consequence uses

Model answers, literature screening decisions, extracted tables, translations, generated code, and
reviewer findings can be incomplete or incorrect. Check claims against the original sources and
inspect methods, units, statistics, exclusions, and data transformations before relying on a result.
Retain original inputs and review generated changes before replacing authoritative data.

Captured provenance records what evidence is available. An output comparison establishes only the
comparison performed on that attempt; it does not establish scientific validity, clinical safety,
or correctness of the underlying method. Missing inputs or environments can prevent reproduction.

Open-Science is not presented as a validated clinical decision system or a substitute for qualified
professional judgment. Do not rely on its output alone for diagnosis, treatment, safety-critical
control, or other decisions where an error could materially harm a person. Applying it to a regulated
or institutional workflow requires a separate assessment of the intended use, validation evidence,
data permissions, and operational safeguards. The software does not establish that approval for you.

## Before processing sensitive data

1. Confirm that you may process the data and disclose it to each selected recipient. Review the
   provider endpoint and account policy, including scenario models, Connectors, MCP servers, and
   remote compute hosts. Local storage does not imply offline execution.
2. Start with synthetic, public, or appropriately de-identified inputs. Removing file metadata alone
   does not remove identifying details visible in an image, text, filename, or query.
3. Use the narrowest folder grants, tool permissions, and service credentials that fit the task.
   Keep backups outside writable task roots. Review commands and destinations before approval.
4. Confirm the protection mode for the actual execution path. An approval prompt is an authorization
   decision, not process isolation. Full access suppresses additional approval prompts; Notebook
   protection does not cover every Agent-native tool or remote process.
5. Protect the host account and local files. Research records are not encrypted merely because
   credentials use an OS vault. Explicit Linux headless file credential storage uses reversible
   base64, not encryption. See [storage details](security.md#local-data-and-credentials).

## Extensions, remote access, and automation

Treat imported projects, model output, documents, Skills, helper scripts, Specialist packages, and
MCP servers as untrusted until reviewed. Their instructions can influence an Agent, and executable
components can act with the authority of their process. A package signature or checksum establishes
the corresponding identity or integrity check, not that its behavior is harmless.

Enable only the capabilities needed for the task. Review source and update changes before installing
extensions. For remote compute, use a dedicated account with limited filesystem access and an
appropriate resource budget; local sandbox settings do not configure the remote host's isolation.

Remote browser access controls the workspace on the host computer. Approve pairing only for the
browser you intend to authorize, avoid persistent trust on shared browser profiles, revoke unused
browsers, and turn remote access off when it is not needed. Follow the [remote setup guide](remote-control.md).

For unattended CLI/SDK work, review the effective permission profile and existing grants before
starting. Stopping a client wait is not task cancellation. Confirm task or remote-job termination
before assuming side effects or resource consumption have stopped.

## Sharing and reporting

Review the actual selected files, conversation content, outputs, code, paths, metadata, and environment
records before exporting `.science` packages, reports, notebooks, or diagnostics. Excluding credential
settings does not sanitize secrets or personal data embedded in research content. Generic redaction
cannot identify every sensitive domain field. Share only material you are authorized to distribute.

Cancelling a request or deleting a local record cannot retract data already received by a provider,
remote host, or export recipient. Arrange any required external deletion with that recipient.
Report suspected security failures through the [private reporting process](../SECURITY.md#reporting-a-vulnerability)
rather than posting sensitive evidence publicly.
