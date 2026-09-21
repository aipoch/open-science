# AIPOCH Open-Science — Development & Packaging

AIPOCH Open-Science is an Electron application built with React, TypeScript, Prisma/SQLite, and an ACP-based agent runtime.

Prerequisites for source development:

- Node.js 22 (see [`.nvmrc`](../.nvmrc)) with npm
- Git
- Notebook execution optionally uses app-managed Python/R environments or a compatible interpreter you configure.

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

[README](../README.md)

## OpenCode Session tool isolation

The ACP coordinator gives each primary OpenCode Session its own runtime process, including forks
and Sessions with the same provider, model, and working directory. Resumes and background
continuations reuse the owning Session's process. Unused isolated runtimes retire after their
workflow leases finish. Other frameworks retain their existing sharing policy.

This is a tool-identity boundary, not just a performance choice. In OpenCode 1.18.14,
[`registerMcpServers`](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/acp/service.ts)
passes a directory and server name to `sdk.mcp.add`, without a Session id. A sibling Session can
replace the original Session's MCP connection, including its credentials. OpenCode also caches
registrations per Session, so resuming the original does not reliably restore its connection.
Notebook, artifact, and Plan tools must not inherit another Session's authority. Changing tool
names or re-registering tools before each prompt is not a substitute for isolation during concurrent
turns. Ephemeral reviewers already receive distinct temporary directories.

The coordinator regression tests model that provider behavior. A real-process contract test uses a
local deterministic model endpoint and a test MCP server; it reproduces the shared-process failure
and verifies separate processes preserve the original tool identity:

```bash
OPENCODE_ACP_PATH=/absolute/path/to/opencode npx vitest run src/main/agent-framework/opencode-mcp-isolation.integration.test.ts
```

Process isolation increases the number of OpenCode processes when multiple Sessions are loaded.
It does not grant forks permission to read or modify their source Session's Compute Jobs; historical
record visibility is a separate policy.

### Live isolation checks for Claude Code and Codex

`npm run test:session-isolation:live` requires all four executable paths below and fails if any
is missing, so an upgrade check cannot silently pass with skipped engine tests:

```bash
CLAUDE_NATIVE_PATH=/absolute/path/to/claude \
CODEX_ACP_PATH=/absolute/path/to/codex-acp/dist/index.js \
CODEX_NATIVE_PATH=/absolute/path/to/codex \
OPENCODE_ACP_PATH=/absolute/path/to/opencode \
npm run test:session-isolation:live
```

The matrix starts real ACP adapters and native agents against temporary stores and deterministic
local model endpoints. It does not use account credentials. Claude Code and both Codex model routes
(Responses and Chat Completions bridge) each run with stdio and HTTP MCP. Every case makes 36 calls
across the Notebook, artifact, and Plan server identities. Each call checks its tool name, unique
turn marker, and actual connection owner. Cases cover same-directory Session switching, overlapping
tool calls, close/resume, sibling credential rebinding, and process restart with durable Sessions.
The test MCP endpoints are probes; they do not execute Notebook code or modify real artifacts.

Verified on 2026-09-21: Claude Code 2.1.274 with claude-agent-acp 0.70.0; Codex 0.153.4 with
codex-acp 1.6.2; OpenCode 1.18.14. The Claude/Codex matrix passed all 216 ownership checks.
OpenCode's shared-process control reproduces the original defect, while separate processes preserve
ownership through sequential and concurrent calls. Re-run this matrix after adapter/native upgrades;
these observations are scoped to the tested versions and transports, not a certification of every
provider, authentication mode, or tool's internal behavior.
