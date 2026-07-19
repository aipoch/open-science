# Codex ACP Agent Feasibility Assessment

> Assessment date: 2026-07-18
>
> Branch: `feat/codex-acp-feasibility`
>
> Recommendation: **Go, initially as a Preview; reuse `@agentclientprotocol/codex-acp` rather than building a custom protocol bridge.**

## 1. Conclusion

It is feasible for Open Science to support Codex as a third ACP agent alongside
Claude Code and OpenCode.

This branch contains an end-to-end API Key Preview candidate, including the
framework adapter, Responses provider compatibility, detection, preflight,
app-managed/npm installation, uninstall, Settings and onboarding entry points,
skill materialization, and IPC/preload/store wiring. It is not yet ready to be
treated as a production cross-platform release: validation on packaged
macOS/Windows/Linux builds, Gatekeeper/Defender behavior, and the live
provider/permission/image compatibility matrix remain release gates.

The recommended implementation does not connect `codex app-server` directly to
the existing `AcpRuntime`. Instead, it uses:

```text
Open Science AcpRuntime
        │ ACP v1 / stdio
        ▼
@agentclientprotocol/codex-acp
        │ Codex app-server JSON-RPC / stdio
        ▼
@openai/codex native binary
```

`agentclientprotocol/codex-acp` already implements the required protocol
translation and uses the same `@agentclientprotocol/sdk ^1.2.1` as this project.
Local testing confirmed that `codex-acp 1.1.4` successfully completes the
handshake with Open Science's current initialize request, returns
`protocolVersion: 1`, and advertises the following capabilities:

- session new/load/resume/list/close/delete
- prompt, cancel, and streaming session updates
- images and embedded context
- permission requests
- session modes and model/reasoning configuration options
- stdio/HTTP MCP (stdio is the baseline ACP transport)

The existing `AcpRuntime` can therefore remain the deep module. Codex requires
only a new `AgentFramework` adapter plus the associated settings, installation,
and provider support. Open Science should not maintain a separate app-server
translation layer.

The first release must have an explicit boundary: **the Codex wire API remains
Responses.** Existing Chat Completions providers are selectable by Codex only
through the separate main-process Responses-compatible gateway. The gateway is
path-aware: it targets each vendor's real `/chat/completions` route rather than a
fixed `/v1` suffix — a bare origin gets the standard `/v1` (DeepSeek), a `/v1`
base is kept (Kimi, Xiaomi), and a versioned path is kept verbatim (OpenRouter
`/api/v1`, GLM/Z.AI `/api/paas/v4`). So DeepSeek, Kimi (Moonshot), Kimi For
Coding, Xiaomi MIMO, OpenRouter, GLM/Z.AI, and custom gateways are all bridge-
selectable. Bridged providers are never relabeled as native Responses
providers, and unsupported Responses features remain rejected or filtered
according to the bridge capability boundary.

## 2. Upstream Selection

### Recommended: `agentclientprotocol/codex-acp`

Current maintained repository:
[`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp)

As of the assessment date:

- Latest version: `1.1.4` (2026-07-15)
- npm package:
  [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)
- License: Apache-2.0
- Implementation: TypeScript; launches Codex app-server and translates it to ACP
  v1
- Dependency: `@openai/codex ^0.144.4`
- Includes unit tests and end-to-end tests for session persistence, MCP approval,
  and shell/file approval

### Not recommended: continue using `zed-industries/codex-acp`

The README for
[`zed-industries/codex-acp`](https://github.com/zed-industries/codex-acp)
explicitly states that development has moved to `agentclientprotocol/codex-acp`
and that new installations should use `@agentclientprotocol/codex-acp`.

Version `v0.16.0` of the old repository provides standalone x64/arm64 binaries
for macOS, Windows, and Linux, which is attractive for app-managed installation.
However, it is an obsolete implementation on a migrated maintenance line. The
product should not be locked to a superseded adapter merely to obtain prebuilt
binaries.

Zed's [`Codex CLI ACP page`](https://zed.dev/acp/agent/codex-cli) still links to
the old repository. It remains useful as a product-entry reference, but its
installation source is outdated and cannot serve as the source of version truth.

## 3. Fit With the Existing Architecture

| Capability required by Open Science | Codex ACP 1.1.4 | Assessment                                                            |
| ----------------------------------- | --------------- | --------------------------------------------------------------------- |
| ACP v1 stdio                        | Yes             | Reuse the existing transport directly                                 |
| Create session                      | Yes             | `session/new` maps to `thread/start`                                  |
| Resume session                      | Yes             | Implements both `session/load` and `session/resume`                   |
| Close/delete session                | Yes             | Matches existing runtime capability detection                         |
| prompt/cancel                       | Yes             | `turn/start` / `turn/interrupt` are wrapped                           |
| Streaming messages, thought, plan   | Yes             | Maps to `session/update`                                              |
| Tool calls and approvals            | Yes             | Includes command/file/permission/MCP mappings                         |
| stdio MCP                           | Yes             | Adapter merges ACP MCP configuration into the Codex thread config     |
| HTTP MCP                            | Yes             | Adapter advertises `http: true`                                       |
| Model switching                     | Yes             | `model` session configuration option                                  |
| Reasoning effort                    | Yes             | `reasoning_effort` configuration option                               |
| Skills                              | Yes             | Native Codex skills; materialize them under the isolated `CODEX_HOME` |
| ChatGPT login                       | Upstream only   | Explicitly unsupported by the product; hidden with `NO_BROWSER=1`     |
| API Key                             | Yes             | Suitable as the authentication path for the initial Preview           |
| Custom gateway                      | Conditional     | OpenAI Responses wire API only                                        |

See the
[`Agent Client Protocol v1 overview`](https://agentclientprotocol.com/protocol/v1/overview)
for the baseline ACP v1 flow. See
[`Codex App Server`](https://learn.chatgpt.com/docs/app-server) for Codex
app-server thread, turn, event, and approval capabilities.

## 4. `AgentFramework` Adapter Design

Add `src/main/agent-framework/codex.ts` while leaving the existing interface
unchanged or extending it only minimally.

### Spawn

For app-managed installations, use Electron's bundled Node runtime to launch the
adapter:

```text
process.execPath <managed>/codex-acp/dist/index.js
```

Required environment variables:

- `ELECTRON_RUN_AS_NODE=1`
- `CODEX_PATH=<managed native codex binary>`
- `CODEX_HOME=<storageRoot>/codex`
- `NO_BROWSER=1` (the product does not support ChatGPT browser login)
- No API key environment variable; the key is sent once through ACP
  `authenticate` after `initialize`

The generated app-owned `CODEX_HOME/config.toml` sets
`cli_auth_credentials_store = "ephemeral"`. The provider routing JSON contains
no key; it uses `requires_openai_auth` and the adapter's ACP API-key method.

### Session Setup

The Codex adapter can reuse OpenCode's `promptPrefix` approach to pass system
guidance for artifacts, notebooks, and skill privacy. If upstream later exposes
stable developer instructions through ACP, this guidance can move to session
metadata.

### Permission Profile

Codex mode IDs differ from those of Claude Code and OpenCode, so the adapter must
provide a dedicated mapping:

| Open Science profile | Codex mode          | Behavior                                                       |
| -------------------- | ------------------- | -------------------------------------------------------------- |
| `ask`                | `read-only`         | File modifications and commands require approval               |
| `auto`               | `agent`             | Workspace writes; out-of-scope access/network require approval |
| `full`               | `agent-full-access` | Dangerous full access without approval                         |

The current generic mapper's assumptions about
`default/auto/bypassPermissions` cannot be used. Otherwise, a Codex session
would remain in its default `agent` mode and the semantics of `ask` would be
incorrect.

### Skills and MCP

- `supportsSkills: true`
- `acceptsStdioMcp: true`
- Materialize enabled Open Science skills under the app-owned
  `CODEX_HOME/skills`
- Continue passing artifact/notebook MCP from the runtime through
  `session/new.mcpServers`
- Initially pass connector instructions through the prompt prefix; later, make
  them an app-owned skill

## 5. Product Entry Points

### Settings

Add Codex to the existing agent framework card selector:

```text
Claude Code
OpenCode
Codex
```

When Codex is selected, show a dedicated Codex runtime card structured like the
OpenCode card:

- Status: Not installed / Ready / Broken (in-place update / version-drift
  detection remains a follow-up)
- Adapter version and Codex CLI version
- Detect (re-runnable at any time)
- Before a runtime is ready: installation-source selection and Install
- When ready: Uninstall (app-managed runtime only). This release has no in-place
  Update or source-switch for a ready runtime; changing source or upgrading is
  uninstall-then-reinstall.

### Onboarding

Add Codex to the Environment step of onboarding:

1. Select an agent framework.
2. Detect `codex-acp`.
3. If it is not installed, default to app-managed installation.
4. Run `codex-acp --version`, `codex --version`, and an ACP `initialize` smoke
   check against the staged adapter/native pair before replacing an existing install.
5. Continue to the API Key provider step.

### Provider Entry Point

Expose an **OpenAI API Key** as an official provider with a bundled model catalog
and the native Responses endpoint. The form shows the key and supported model
list; Base URL, API format, and model text inputs are not user-configurable.
ChatGPT login and reuse of a local Codex login are not provided. Existing Chat
Completions providers remain available to frameworks that natively support
`/v1/chat/completions`; switching to Codex routes them through the separate
Responses-compatible bridge.

Do not reuse the existing `OpenAI-compatible` label for Codex. That label and
its type explicitly represent `/v1/chat/completions`, while the `codex-acp`
custom gateway always writes `wire_api: "responses"`.

## 6. App-Managed Installation

### Feasibility: Yes

The GitHub release for `codex-acp 1.1.4` currently has no binary assets, so the
installation cannot rely on a GitHub release zip. Although the upstream
repository documents standalone binaries and provides a `bundle:all` build
script, its release workflow currently publishes only the npm package and
creates a GitHub release with no assets.

Reuse the npm registry plus SRI verification approach from the existing
`managed-opencode.ts` and install two pinned artifacts from npm:

1. `@agentclientprotocol/codex-acp@<pinned>`
2. `@openai/codex@<pinned>-<platform>-<arch>`

The `codex-acp 1.1.4` npm tarball:

- Compressed size: approximately 186 KB
- `dist/index.js`: approximately 1.1 MB
- Runtime dependencies other than `@openai/codex` are bundled by esbuild

Example for `@openai/codex 0.144.4-darwin-arm64`:

- Compressed size: approximately 120.3 MB
- Extracted size: approximately 311.6 MB
- Includes native `codex`, `codex-code-mode-host`, `rg`, and zsh resources

Retain the complete platform vendor subtree rather than extracting only the
primary binary. The Codex wrapper relies on relative paths to `rg`, the code
mode host, and shell resources.

### Version Pinning

The upstream adapter depends on `@openai/codex ^0.144.4`, so an npm install can
resolve to a later patch version. Locally, `npx codex-acp@1.1.4` resolved to Codex
`0.144.6`. App-managed installation must not fetch `latest` dynamically or rely
on caret resolution. Open Science should maintain its own validated manifest:

```json
{
  "adapterVersion": "1.1.4",
  "codexVersion": "0.144.6",
  "platforms": {
    "darwin-arm64": {
      "adapterIntegrity": "sha512-...",
      "codexIntegrity": "sha512-..."
    }
  }
}
```

This branch pins the adapter integrity and all six platform-specific Codex
integrities in the application. Registry metadata must match the pinned value;
download verification uses the application-owned value rather than trusting the
metadata as its own authority.

For each adapter/Codex combination upgrade, generate the app-server schema and
run Open Science's ACP contract tests.

### Installation Sources

| Source                 | Recommendation       | Notes                                                               |
| ---------------------- | -------------------- | ------------------------------------------------------------------- |
| App-managed download   | Default, recommended | No system Node/npm; npm tarballs + SHA-512 + atomic replacement     |
| npm global             | Advanced option      | `npm i -g @agentclientprotocol/codex-acp`                           |
| Existing executable    | Detect               | Find, version-check, and run a live ACP initialize smoke check before marking it ready |
| `npx` per spawn        | Not recommended      | First launch requires network; version and latency are uncontrolled |
| Old Zed binary release | Do not use           | Superseded maintenance line                                         |

### Platforms

The upstream Codex npm package covers:

- macOS x64 / arm64
- Windows x64 / arm64
- Linux x64 / arm64 (the Codex npm wrapper uses a musl target)

The installer must perform the following after installation:

- Integrity verification
- Executable mode repair
- `codex --version`
- `codex-acp --version`
- ACP initialize smoke test
- Execution validation on actual packaged macOS/Windows builds

The local npm Codex binary runs, but `codesign --verify --deep --strict` reports
an invalid signature. Because app-managed files are downloaded by the
application into its data root, they ordinarily do not participate in app
bundle signing. Nevertheless, this behavior must still be validated on machines
with quarantine, Gatekeeper, and enterprise endpoint security policies; a pass
on a development machine alone is insufficient.

## 7. Provider and Authentication Strategy

### Recommended Preview Path

Add a native OpenAI Responses provider:

- Continue storing the key in the existing encrypted settings repository
- Do not pass it through `CODEX_API_KEY`: Codex shell snapshots can copy inherited
  environment variables, and default API-key login also writes `auth.json`
- After ACP `initialize`, call `authenticate` with `methodId: "api-key"` and the
  decrypted key in the ACP `_meta` payload; clear the one-shot value afterward
- Generate app-owned `CODEX_HOME/config.toml` with
  `cli_auth_credentials_store = "ephemeral"` before spawn. Putting this only in
  `CODEX_CONFIG` is too late for the authentication phase.
- Set the model through the adapter's session model configuration option

### Custom Gateway

The app's native Codex provider uses `apiType: "responses"`. Chat Completions
providers remain `apiType: "openai"` and are accepted by Codex only through the
separate local Responses-compatible bridge below. The bridge is not a provider
type alias and does not claim native Responses support.

The bridge uses `providers/set` after initialize and before `session/new`. That
method accepts `apiType: "openai"` and emits Codex `wire_api: "responses"`;
the main process keeps the upstream key and sends Codex only a one-time local
bridge token. Bridge-backed sessions use the Codex catalog model
`gpt-5.5` only for Codex metadata (a classic tool-mode entry so tools are
declared directly as functions the bridge can forward — the `gpt-5.6-*` family
is `code_mode_only` and advertises no function tools over a custom gateway); the
bridge rewrites it to the selected provider model before calling Chat
Completions. Chat Completions has no separate tool namespace field, so the bridge
encodes each app-owned Notebook or Artifact MCP pair as one function alias (for example,
`mcp__open_science_notebook__notebook_execute`) and restores the native Responses
shape `{ namespace: "mcp__open_science_notebook", name: "notebook_execute" }` on
the way back. Codex then performs the real MCP dispatch and preserves its approval
and lifecycle behavior. A live contract test with `codex-acp 1.1.4`, Codex
`0.144.6`, a fresh session, and a temporary stdio MCP server verifies this path.
The boundary remains narrow: built-in Notebook and Artifact MCP tools are mapped explicitly;
arbitrary dynamically discovered MCP namespaces and server-side hosted tools are
not bridge-supported. Native Responses remains the complete capability path. Do
not place an Authorization header or API key in `DEFAULT_AUTH_REQUEST`: the
adapter startup log records `authRequestString/defaultAuthRequest`.

### Explicitly Exclude ChatGPT / Local Codex

Open Science does not expose the `codex-acp` ChatGPT authentication method and
does not reuse the user's `~/.codex` login. The runtime always sets
`NO_BROWSER=1` and points `CODEX_HOME` to an app-owned directory.

This removes the entire implementation path for login URLs, callbacks, account
state, and logout UI/IPC. It also prevents inheritance of the user's Codex
configuration, MCP servers, hooks, and skills. If API Key authentication is not
configured in the app-owned `CODEX_HOME`, session creation should return an
actionable provider configuration error immediately rather than falling back to
browser login.

## 8. Security and Blocking Issues

The following must be resolved before the Preview is released:

1. **Configuration isolation scope**: The product boundary is user-level
   isolation. An app-owned `CODEX_HOME` isolates user config, auth state, skills,
   and MCP state; project `.codex` configuration remains project-owned behavior
   and is intentionally out of scope for this integration.
2. **Secret persistence**: The live probe found the key in default `auth.json`
   and in Codex shell snapshots when passed through the environment. ACP
   `authenticate` plus global `cli_auth_credentials_store = "ephemeral"` passed
   the same probe without a key copy in the temporary home. Keep this behavior in
   the product and add a regression scan. New Provider, NCBI, and custom MCP
   secret writes now fail closed when Electron `safeStorage` is unavailable.
   Legacy `plain:` Provider/NCBI refs and plaintext custom MCP `env`/`headers`
   remain readable only for compatibility and migrate to encrypted refs when the
   system keychain becomes available.
3. **Permission parity**: The Codex-specific mode mapper (`ask`→read-only,
   `auto`→agent, `full`→agent-full-access, fail-closed) and the conservative
   auto-approve fallback are unit-tested. The end-to-end file/shell/network/MCP
   approval matrix for each mode exercises Codex's own enforcement, so it is a
   MANUAL pre-release verification against a pinned Codex runtime (a checklist,
   not a CI unit test) — tracked as a release gate, since it can't run without a
   live runtime.
4. **Process tree cleanup**: The adapter launches Codex app-server as a child
   process, so cleanup must target the whole tree, not merely the adapter PID,
   via the shared awaited `terminateProcessTree` (which reports whether the tree
   was confirmed reaped). On POSIX it enumerates descendant PIDs (via `ps`),
   sends `SIGTERM`, then escalates any survivors to `SIGKILL`; on Windows it runs
   `taskkill /t` to walk the tree. Two postures, deliberately different:
   - **Session shutdown / update gate**: a strong guarantee. A degraded reap
     (`reaped:false` — e.g. taskkill fell back to a direct kill, or a descendant
     survived) is treated as failure: the in-place-update gate refuses to proceed
     so it never overwrites files a surviving process still holds open.
   - **Install/detect smoke checks**: **best-effort** cleanup. The smoke reaps
     the tree while the adapter is still alive (so a Codex grandchild is reachable
     through it) and awaits the teardown, but a `reaped:false` result is **logged,
     not fatal** — the adapter pairing itself succeeded, and failing an otherwise
     valid install/detection because post-init cleanup could not be *confirmed*
     would spuriously break setup on constrained hosts. A degraded reap therefore
     may leave a short-lived residual process; it is surfaced via a warning.
5. **Version compatibility**: Pin the adapter and Codex combination. Do not allow
   the app-managed runtime to drift automatically.
6. **Downloaded binary execution**: Test real packaged builds with macOS
   Gatekeeper/quarantine, Windows Defender/VC++ runtime, and Linux musl/glibc.

## 9. Implementation Slices

The slices below are the original estimates for moving from assessment to a
production release. This branch implements the Preview code for Slices B-D; the
live upstream contract/security validation in Slice A and all of Slice E remain
release requirements.

### Slice A: Protocol and Security Spike (completed on this branch)

- Pin the `codex-acp`/Codex version combination
- Add live initialize/new/resume/cancel/MCP contract tests
- Verify `CODEX_HOME` isolation and project configuration behavior
- Verify that the API Key is not written to logs

Exit criteria: the security model is explainable. The bridge and user-level
config parts are now evidenced below; live resume, permissions, and MCP remain
release gates.

### Slice B: Backend Adapter and Detection (2-3 days)

- `AgentFrameworkId += 'codex'`
- `codexFramework`
- Codex-specific permission mapping
- Detection, repository, preflight, and environment checks
- Skill materialization and protected read roots

### Slice C: App-Managed Installer (2-3 days)

- Platform mapping
- Dual tarball parsing, SRI verification, extraction, and atomic replacement
- Install/update/uninstall IPC
- Smoke checks and rollback on failure

### Slice D: Entry Points and Provider (2-3 days)

- Framework selector and Codex status/install card
- Onboarding framework/install flow
- OpenAI Responses provider and compatibility filtering
- Composer model option integration

### Slice E: Cross-Platform Hardening (2-4 days)

- macOS x64/arm64, Windows x64/arm64, and Linux x64/arm64
- App shutdown/process tree
- Packaging, quarantine, and VC++ runtime
- Documentation, telemetry, and error copy

Rough estimate: 7-11 engineering days for the API Key Preview; 10-14 engineering
days for a custom Responses gateway and full cross-platform release. ChatGPT
login is not included in the estimate or roadmap.

## 10. Primary Change Surface

- `src/shared/settings.ts`
- `src/shared/provider-registry.ts`
- `src/main/agent-framework/codex.ts`
- `src/main/agent-framework/registry.ts`
- `src/main/acp/runtime.ts` (only post-initialize provider configuration or a
  minimal hook)
- `src/main/settings/codex-detect.ts`
- `src/main/settings/managed-codex.ts`
- `src/main/settings/service.ts`
- `src/main/settings/preflight.ts`
- `src/main/settings/environment-check.ts`
- `src/main/settings/ipc.ts`
- `src/preload/index.ts` / `index.d.ts`
- `src/renderer/src/stores/settings-store.ts`
- `src/renderer/src/pages/settings/SettingsPage.tsx`
- `src/renderer/src/pages/settings/CodexStatusCard.tsx`
- `src/renderer/src/pages/onboarding/OnboardingWizard.tsx`
- Corresponding unit, render, and runtime contract tests

## 11. Validation Spike Results

### Responses-to-Chat Bridge

This was validated with a local probe — a fake `/v1/chat/completions` upstream
and a stateful local `/v1/responses` translator driving the real pinned
processes. The probe script is not shipped on the branch; its durable result is
recorded here:

```text
@agentclientprotocol/codex-acp 1.1.4
Codex CLI 0.144.6
ACP protocol v1
```

The probe completed with:

```text
stopReason: end_turn
responsesRequestCount: 2
chatRequestCount: 2
sawFunctionOutput: true
sawChatToolResult: true
acpText: ... BRIDGE_OK
```

The first request translated Codex's `exec_command` function declaration into
Chat Completions format. The fake upstream returned a streamed function call;
the bridge converted it back to a Responses function-call item. Codex executed
`pwd`, sent `function_call_output` on the second request, and the bridge mapped
that to a Chat Completions `tool` message before returning streamed text.

The same probe also records the raw Responses tool types emitted by the pinned
Codex runtime: `function`, `namespace`, and `web_search`. The latter two cannot
be represented faithfully as Chat Completions function tools. Codex emits them
even for a plain text turn, so rejecting the entire request makes the bridge
unusable. The bridge drops these known non-translatable declarations (including
`tool_search`) before calling the upstream; genuinely unknown tool types are
rejected so the boundary stays explicit. Function tools remain available and
round-trip through the bridge. The Notebook and Artifact MCP servers remain wired for
bridge-backed Codex and its connector skill docs are materialized into Codex's own
home. The bridge injects the app-owned Notebook and Artifact schemas as flattened Chat
function aliases and restores the Responses `namespace` field before Codex sees
the call. The earlier `unsupported call: notebook_execute` failure was caused by
injecting only the bare function name; without `namespace`, Codex correctly looked
for a built-in function handler instead of its MCP router.

This proves feasibility for a local, stateful translator. It does **not** prove
that arbitrary Chat Completions vendors are compatible. A production bridge must
also define behavior for `previous_response_id`, response storage, compact,
reasoning and encrypted content, hosted tools/web search, parallel tool calls,
SSE cancellation, errors, and usage. For the MVP, actively reject stateful
fields (`previous_response_id`, `conversation`, and `background`),
unsupported input parts, and unknown tool types.

Reasoning and refusal output are handled rather than rejected: throwing on model
output mid-stream resets the socket and surfaces to the agent as an opaque
"error decoding response body", so the bridge instead drops `reasoning_content`
from the visible answer (thinking-mode providers such as DeepSeek require it to
be cached and passed back on the next turn, which the bridge does) and surfaces a
`refusal` as visible text. Upstream image output remains rejected outright.
Known hosted tools and arbitrary native MCP declarations are still filtered
because Codex includes them by default. Only the app-owned Notebook and Artifact
namespaces are injected explicitly; other MCP tools cannot be used through this
provider path.
Useful external references are
[`sybil-solutions/codex-shim`](https://github.com/sybil-solutions/codex-shim),
[LiteLLM's Responses transformation](https://github.com/BerriAI/litellm/tree/main/litellm/responses),
and [New API's relay conversion](https://github.com/QuantumNous/new-api/tree/main/service/relayconvert).
[CC Switch's Codex Chat transformer](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/transform_codex_chat.rs)
is a particularly useful reference for strict Chat Completions gateways: it maps
`developer` to `system`, collapses system messages to the leading position,
drops `tool_choice` and `parallel_tool_calls` when tool conversion leaves no
tools, injects streaming usage, and keeps provider model mapping separate from
wire-format conversion. Open Science adopts those compatibility rules. CC Switch
also flattens Responses `namespace` tools back into function names. Open Science
uses the same principle for its Notebook namespace, with an allowlisted reverse
mapping so an upstream cannot invent arbitrary namespace calls. Full dynamic
`tool_search` emulation remains outside the bridge boundary.
They demonstrate input/instruction conversion, function/tool-result round trips,
reasoning summaries, usage, and Responses SSE state machines. New API is also a
useful reference for actively rejecting unsupported stateful fields; none is a
reason to expose every Chat Completions provider automatically.

**Decision:** support native OpenAI Responses in Codex plus a separately
implemented Responses-compatible gateway as an isolated feasibility component.
The bridge owns its upstream key and local token; it does not mutate the
provider's stored API type or claim support for unvalidated Responses features.
An `openai`/`both` provider is selectable by Codex only through this bridge,
which prevents hosted `web_search` and `namespace` declarations emitted by
Codex from failing an otherwise ordinary text request.

### Project `.codex/config.toml`

The isolated-home probe used temporary `HOME`, temporary `CODEX_HOME`, no API
key, and the same native Codex binary. Results for Codex `0.144.6`:

| Case | Result |
| --- | --- |
| Empty isolated home | `app-server --strict-config` exits 0 |
| Invalid `CODEX_HOME/config.toml` | exits 1; home config is loaded |
| Invalid project `.codex/config.toml`, project untrusted | exits 0; config is gated and not parsed |
| Same project trusted in isolated home | exits 1; project config is parsed |
| Normal `codex-acp` launch with invalid trusted project config | initializes with a `configWarning` and defaults, because the adapter does not use `--strict-config` |

The experiment also observed that untrusted project skills still load. This was
exercised with a probe over temporary `HOME`, `CODEX_HOME`, and project
directories, capturing the exit code and diagnostics for all four cases. The
probe script is not shipped on the branch; the durable conclusion is recorded
here so it does not depend on any temporary directory.

**Decision:** use `CODEX_HOME` as the user-level isolation boundary. Project
`.codex` configuration and project skills are outside this product scope.

### Authentication and Secret Storage

The same real-process bridge probe was run three ways:

- Environment API key with default Codex storage: succeeded, but the fake key was
  found in `auth.json` and a shell snapshot.
- Environment API key with `cli_auth_credentials_store` in `CODEX_CONFIG`:
  succeeded, but the key was still persisted because authentication precedes
  session-config merge.
- ACP `authenticate` with the key in `_meta`, plus app-owned global
  `config.toml` setting `cli_auth_credentials_store = "ephemeral"`: succeeded,
  and no scanned temporary Codex file contained the key.

The product implementation now follows the third path. Electron `safeStorage`
remains the at-rest store owned by Open Science when the OS keychain is available;
Codex receives the decrypted key only for the ACP authentication request and keeps
it in process memory. New writes are rejected when `safeStorage` is unavailable;
legacy reversible refs remain readable for migration, but the app creates no new
plaintext refs. Custom MCP environment variables and HTTP headers are persisted
as individually encrypted refs and are resolved only in the main process.

### MCP Status

ACP MCP wiring is implemented: the runtime has artifact/notebook stdio server
configuration, and Codex ACP 1.1.4 advertises stdio MCP support in its adapter
capabilities. The existing runtime tests cover server construction and routing,
including the HTTP fallback for frameworks that reject stdio. MCP works end to end
on all three paths, verified live: **Claude** (native MCP); **Codex on a
Responses-native provider** (apiType `responses`, no bridge) — the agent ran
`notebook_execute` with `host.mcp("pubmed", …)` for real PubMed results and
`write_artifact_file` to save a plot; and **Codex over the Chat-Completions
bridge**, via the flattened namespaced connector aliases described below — the
agent called the namespaced `notebook_execute` and ran `host.mcp("pubmed", …)`
with no raw-HTTP fallback.

The Chat-Completions bridge cannot use Codex's deferred `tool_search` mechanism,
but it can expose app-owned MCP tools explicitly. The bridge injects the Notebook
and Artifact MCP schemas as flattened Chat function aliases, restores their
Responses namespace on model output, and preserves aliases when replaying history. A live
contract using Codex ACP 1.1.4 and Codex 0.144.6 verified that Codex dispatched the
restored call through its real MCP router and returned the MCP result to the next
Chat Completions turn.

Connector routing needs an additional constraint because connectors are not Codex
MCP servers: they are called from Notebook Python with `host.mcp`. In bridge mode,
the gateway filters Codex's misleading MCP resource-browser functions, selects an
enabled connector when a user message names its ID or display name, injects that
connector's generated skill document, and strengthens the `notebook_execute`
description to prohibit raw HTTP access. This addresses the observed DeepSeek
behavior of calling `list_mcp_resource_templates("mcp-pubmed")` and then using
`requests` against NCBI directly.

This is a model-compliance constraint, not a hard execution policy. If a supported
Chat model still emits raw HTTP after the constrained tool surface is verified
live, the next bridge iteration should expose selected connector methods as
generated Chat function tools and translate those calls into app-generated
`notebook_execute` code containing `host.mcp(...)`. That structural translation
would guarantee connector routing; prompt injection alone cannot.

### Image Status

Codex ACP image content is supported on both sides of a session within explicit
bounds. User uploads become ACP image blocks only when the active Provider declares
image-input support. Official OpenAI and Anthropic providers declare it; Custom
Gateway exposes an explicit switch; other official providers stay conservative
unless their model catalog identifies a vision model.

The main process validates MIME and Base64 content, applies a per-image limit, a
24 MiB aggregate inline-input budget, and a 24 MiB persisted/session-event budget.
It never falls back to forwarding an oversized undecodable original. Assistant ACP
image chunks are bounded, persisted, rendered (including image-only messages), and
included in bounded soft replay. AVIF, GIF, JPEG, PNG, and WebP are accepted; SVG
is rejected.

For Chat-Completions bridge providers, Responses `input_image`/`image_url` parts
are converted only from validated absolute HTTP(S) URLs or image data URLs. The
bridge does not emulate upstream image generation: vendor image output is rejected
as `unsupported_upstream_output`; generated files must use the app-owned Artifact
MCP tool. Scanned/image-only PDF OCR and a live real-Codex image contract remain
outside this Preview's verified surface.

## 12. Final Recommendation

**Proceed. Reusing the upstream adapter is now a better choice than building a
custom bridge.**

Approve a Preview implementation with the following boundaries:

- Use `@agentclientprotocol/codex-acp`
- Make app-managed installation the default
- Always use an isolated `CODEX_HOME` with an OpenAI API Key
- Do not support ChatGPT login or reuse of a local Codex login
- Do not promise compatibility with every existing provider
- Validate a Chat Completions Provider with a connectivity/key check on its first
  model (not a per-model runtime probe). Per-model bridge compatibility is a
  static, ships-with-the-app registry mark (`bridgeUnsupportedModels`), populated
  from our own pre-release testing, so users never test each model. (Superseded
  the earlier "model-specific streaming function-tool probe" requirement, which
  forced users to re-test every model of a multi-model vendor.)
- Do not use the old Zed binary release
- Do not duplicate app-server-to-ACP translation logic inside Open Science
- Do not mark the integration Stable until configuration isolation, secret
  logging, and real platform binary execution have passed validation

This path keeps the new Codex adapter as a deep module: callers continue to
understand only ACP, while Codex/app-server protocol changes remain contained in
the upstream adapter and a small framework adapter. Its maintenance cost is
substantially lower than that of a custom bridge.
