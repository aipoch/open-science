# Known limitations and risk notices

This register summarizes publicly documented boundaries and verification gaps. Read it with the
[security model](security.md) and [intended-use guide](usage-scope.md). A listed limitation does not
exclude a vulnerability report when an implemented control is bypassed or an action exceeds the
user's authorization. Use the [private reporting process](../SECURITY.md#reporting-a-vulnerability)
for suspected vulnerabilities; do not add undisclosed exploit details here.

## Review baseline

The entries below were reviewed against source and documentation at `975c787f0b` on **2026-10-18**.
The application package version at that revision is **1.0.0**. Each entry's scope applies to that
baseline; historical affected ranges and later fixes must be established separately. Independent
packages retain their own versions. This review does not constitute new runtime testing, a security
certification, or a claim that every release/platform combination has been exercised.

All entries share that review date unless an entry records a newer one. **Documented boundary** means
the limitation remains relevant at this baseline, not that a fix is scheduled. **Verification gap**
means the stated assurance has not been established by this review. Release-specific changes belong
in the [release notes](../release-notes/README.md).

## Source risk detection is bounded

- **Scope / status:** Notebook code review and `@aipoch/notebook-code-risk`; documented boundary.
- **Trigger and impact:** Executing code with no reported findings can still have harmful effects.
  Libraries, native extensions, and dynamic behavior can hide effects from source inspection;
  findings are neither an execution permission nor a reusable safety certificate.
- **Precautions:** Review unfamiliar code, retain backups, and enforce runtime filesystem/network
  restrictions. Grant access only to the required data; writable data can still be modified.
- **Details:** [Code-risk module](../packages/notebook-code-risk/README.md#safety-and-integration).

## Isolation depends on platform and execution path

- **Scope / status:** Local Notebook processes, Agent-native tools, and remote compute; documented boundary.
- **Trigger and impact:** Windows standard mode inherits host-user filesystem access and provides a
  proxy only for compatible software. Agent-native file tools execute outside the Notebook sandbox;
  remote commands execute with the configured remote account's authority.
- **Precautions:** Enable Windows protected mode when relying on its enforced boundary, check the
  selected framework's restrictions, and use dedicated remote accounts. Do not treat approval prompts
  or Notebook protection as a universal sandbox.
- **Details:** [Execution security model](security.md#code-and-notebook-execution).

## Public HTTPS reads are not an allowlist-only boundary

- **Scope / status:** The Notebook gateway's public read channel, excluding the separate WSL2 path;
  documented boundary.
- **Trigger and impact:** When its local CA is available, the gateway can admit restricted GET/HEAD
  requests to otherwise unknown public DNS hosts on port 443. URL paths and query parameters can
  carry sensitive data even without a request body. The 8192-byte target limit is not an aggregate
  data limit; there is no per-command request-count quota.
- **Precautions:** Do not assume an unlisted public host cannot receive data. Use explicit deny rules
  for known destinations and an externally enforced restricted environment when the task requires
  strict egress control. Review the TLS inspection behavior before using this channel.
- **Details:** [Gateway policy](../packages/notebook-network-sandbox/README.md#scope) and
  [execution security model](security.md#code-and-notebook-execution).

## Local-first storage does not prevent external disclosure

- **Scope / status:** Model/scenario requests, Connectors, MCP servers, remote jobs, and exports;
  documented boundary.
- **Trigger and impact:** Requests disclose the content prepared for their recipients. Read-only
  calls still disclose arguments. Cancelling a request or deleting local content cannot retract
  received bytes or establish provider-side deletion, retention, or training restrictions.
- **Precautions:** Review recipients, endpoint/account policies, and selected inputs before sending.
  Minimize sensitive content and arrange any required deletion with the receiving service or person.
- **Details:** [Data recipients](security.md#data-recipients) and
  [retention boundaries](security.md#cancellation-deletion-and-retention).

## Runtime-wide traffic assurances need separate measurements

- **Scope / status:** Third-party Agent runtimes and desktop/remote Web traffic; verification gap.
- **Trigger and impact:** Backend proxy settings do not configure every browser session or already
  running process. Environment flags alone do not establish absence of third-party telemetry.
- **Precautions:** Measure the exact runtime/version and process lifecycle with synthetic inputs
  before making offline or no-telemetry claims. Apply network controls outside the app if required.
- **Details:** [Runtime network verification checklist](security.md#runtime-network-verification).

## External-media protection has rendering-specific coverage

- **Scope / status:** Message and Markdown external media, including Mermaid content; documented boundary.
- **Trigger and impact:** Activated media uses browser networking outside Notebook domain policy.
  Mermaid HTML-label images are not covered by the shape-image detector and can load without media
  activation. Loading remote media can disclose the request and browser network metadata.
- **Precautions:** Review untrusted content in an externally network-restricted environment when
  automatic outbound requests are unacceptable. Do not infer complete media blocking from the
  Markdown activation control.
- **Details:** [Media behavior](security.md#data-recipients).

## Local storage and exports require content-level review

- **Scope / status:** Research files, credentials, diagnostics, and exported research records;
  documented boundary.
- **Trigger and impact:** Research content remains user-readable local files. Explicit Linux
  headless file credential mode stores reversible base64. OS-vault protection for some credentials
  does not encrypt all records. Secrets and identifying information embedded in code, logs, images,
  paths, or exported content may survive generic redaction.
- **Precautions:** Protect accounts and disks, use the secure credential backend when available,
  and review the exact material before sharing. Do not upload complete configuration roots or
  unreviewed diagnostic bundles.
- **Details:** [Local storage](security.md#local-data-and-credentials), [diagnostics](security.md#diagnostics),
  and [sharing precautions](usage-scope.md#sharing-and-reporting).

## Research assistance and replay do not validate conclusions

- **Scope / status:** Literature screening, PDF extraction/translation, model/reviewer outputs,
  provenance, and artifact reproduction; documented boundary.
- **Trigger and impact:** Extraction, translation, or classification can omit or distort evidence.
  Matching replay outputs does not establish sound methods or scientific validity. Missing inputs,
  runtime differences, and nondeterminism can limit or prevent reproduction.
- **Precautions:** Compare results with original sources and review analysis methods independently.
  Retain original inputs and report the exact evidence and comparison performed.
- **Details:** [Research use](usage-scope.md#research-judgment-and-high-consequence-uses) and
  [traceability and replay](ROADMAP.md#traceability-replay-and-scientific-validity).

## Extensions and remote work retain their granted authority

- **Scope / status:** Skills, Specialist packages, MCP servers, environment installers, and SSH/Slurm jobs;
  documented boundary.
- **Trigger and impact:** Imported instructions can influence tool use; executable components and
  remote scripts can modify data or consume resources within their process/account permissions.
  Source integrity or schema validation does not establish harmless behavior. Disconnecting a client
  or stopping observation does not establish that a remote job has stopped.
- **Precautions:** Review sources and updates, limit credentials and writable data, set resource
  budgets, and confirm remote termination and cleanup separately.
- **Details:** [Extension and automation precautions](usage-scope.md#extensions-remote-access-and-automation)
  and [Compute safety](../packages/compute/README.md#safety-and-integration).

## Maintaining this register

Keep each entry's descriptive title, affected version/platform/module, triggering condition, impact,
available control, remaining risk, mitigation, status, review date, and supporting reference current.
Record a confirmed fixed version and verification evidence when resolving an entry; do not erase its
historical scope or label an untested platform fixed. Separate verification gaps from confirmed bugs.
Publish changes with the affected release and synchronize the owning module's documentation. Changes
to this register do not narrow the [security report scope](../SECURITY.md#what-to-report).
