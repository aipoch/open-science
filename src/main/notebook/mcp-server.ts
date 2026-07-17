import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const NOTEBOOK_MCP_SERVER_ARG = '--open-science-notebook-mcp'
const NOTEBOOK_MCP_SERVER_NAME = 'open-science-notebook'

// Scoped prompt addendum that only applies when the agent is given notebook tools.
const NOTEBOOK_SYSTEM_PROMPT_APPEND = [
  '<open_science_notebook_instructions>',
  'Notebook tool instructions (only applies when using open-science-notebook tools).',
  'Use the `open-science-notebook` tools when you need to write or run Python code in the shared local notebook interpreter.',
  'Notebook preview is only for code and execution results; keep chat, explanation, and diagnosis in the chat area.',
  'To write and run code, use the `notebook_execute` tool: it writes one Python code cell and runs it in the shared interpreter in a single step. Treat each `notebook_execute` call as one notebook cell, and use several calls for several cells. Reuse a `cellId` to overwrite and rerun that cell.',
  'The python and r data cells run `notebook_execute` writes and have NO outbound connector (host.mcp) access. To call an MCP connector, use the `repl_execute` tool — the control-plane REPL is the only kernel with connector access (`await host.mcp(server, method, args)`). Do NOT try to call host.mcp, urllib/requests, or fetch a connector from a python/r cell; it will fail.',
  'Hand connector results to the python/r data cells through the shared workspace channel: have `repl_execute` write files into the directory given by the `$OPEN_SCIENCE_HANDOFF_DIR` env var (read it at runtime — every kernel kind sees the same path there) and have the data cell read them back, not by pasting large data through the chat.',
  'Read input or preprocessed data from `./data/` (split into `./data/raw` and `./data/processed`; also reachable via the `OPEN_SCIENCE_NOTEBOOK_DATA_DIR` env var or the returned `dataRoot`) instead of guessing a path.',
  'Write intermediate or working analysis outputs into `./outputs/`; that is separate from final user-facing artifacts, which still must be saved with `write_artifact_file` before telling the user they are available.',
  'The python/r kernel is PERSISTENT across calls: variables, imports, and definitions from one `notebook_execute` call stay available to later calls on the SAME environment. Reuse them directly — do NOT re-read a file or recompute data that is already held in a variable from an earlier call this session.',
  'That in-memory state is lost not only on `notebook_restart` (whose result already says so) but also on closing/reopening the app — only run history and on-disk files survive. So checkpoint an expensive result you may need again (a large fetch, a slow computation, a trained model) to `./data`, `./handoff`, or `./outputs` and re-load it after a restart/reopen instead of recomputing.',
  'After each run, inspect the returned run summary, including stdout, stderr, traceback, outputs, artifacts, workingFiles, cwdBefore, and cwdAfter.',
  'If the result is not the expected user outcome, analyze the returned facts, modify code or environment, and run again.',
  'If you decide a missing package, dependency, Python executable, executor, interpreter, kernel, or runtime component must be installed, place installation contents under the directory given by the `OPEN_SCIENCE_RUNTIME_DIR` env var (read it at runtime) and continue with that runtime.',
  'Do not install runtime dependencies into the project repository, workspace, system Python, or the user existing global environment unless the user explicitly asks.',
  'The notebook already runs inside a writable session workspace — its current working directory — so create files with plain relative paths (e.g. `plt.savefig("plot.png")`, `df.to_csv("out.csv")`). Do NOT construct or guess absolute paths under a home directory; if you need an absolute path, read it at runtime (`os.getcwd()`, `os.path.abspath("plot.png")`, or the returned `dataRoot` / env var `OPEN_SCIENCE_NOTEBOOK_DATA_DIR`).',
  'You may read user-provided existing data files in place, but do not move, overwrite, or delete original files; write derived files into the working directory.',
  'Treat notebook MCP results as execution facts only. The notebook runtime does not classify files for you; you decide whether each generated file is an intermediate working file or a final user-facing artifact.',
  'If a notebook run creates a final user-facing output such as a chart, image, report, PDF, HTML page, document, CSV export, or archive, save that final output through the `write_artifact_file` tool from `open-science-artifacts` before telling the user it is available.',
  'Pass the file to `write_artifact_file` as `source: { "kind": "localPath", "path": "<absolute path>" }` — use an ABSOLUTE path (e.g. `os.path.abspath("plot.png")` for a file you just saved to the working directory), because the artifact tool runs in a separate process and will not resolve a bare relative name.',
  'Use inline `content` only for small generated text that is already in memory.',
  'Artifact file paths are returned in `artifacts[]`; notebook working file paths are returned in `workingFiles[]`.',
  'The user does not need to click a button to send results back; use MCP return values and notebook state as the execution facts.',
  'When a run fails on a missing package, dependency, or module (ImportError / ModuleNotFoundError / "there is no package called"), install it with the `manage_packages` tool — Python vs R by language — and do NOT install packages from inside a cell (%pip, !pip, install.packages()) or with OS installers.',
  'A named environment (notebook_execute environment:"my-analysis") is a SEPARATE persistent process and namespace from the default python/r environment and from every other named environment — switching environments gives you a fresh namespace with no shared variables/imports. Create a named environment with `manage_environments` before targeting it, and move data between environments through ./handoff/ just like you would between kernels.',
  '</open_science_notebook_instructions>'
].join('\n')

type NotebookRpcConnection = {
  endpoint: string
  token: string
}

type NotebookMcpEnvironment = NotebookRpcConnection & {
  projectName: string
  sessionId: string
  workspaceCwd: string
}

type NotebookMcpServerConfigRequest = NotebookMcpEnvironment & {
  command: string
  entryPath: string
}

const executeToolSchema = {
  code: z.string(),
  timeoutMs: z.number().int().positive().optional(),
  cellId: z.string().min(1).optional(),
  language: z.enum(['python', 'r']).optional(),
  environment: z.string().optional()
}

const replExecuteToolSchema = {
  code: z.string(),
  timeoutMs: z.number().int().positive().optional()
}

const bashExecuteToolSchema = {
  command: z.string(),
  timeoutMs: z.number().int().positive().optional()
}

const managePackagesToolSchema = {
  language: z.enum(['python', 'r']),
  packages: z.array(z.string().min(1)).min(1),
  usePip: z.boolean().optional(),
  channels: z.array(z.string().min(1)).optional(),
  environment: z.string().optional(),
  operation: z.enum(['install', 'uninstall']).optional()
}

const manageEnvironmentsToolSchema = {
  action: z.enum(['create', 'list', 'remove']),
  language: z.enum(['python', 'r']).optional(),
  name: z.string().optional(),
  packages: z.array(z.string().min(1)).optional()
}

// Install contract embedded as the manage_packages description so the agent always sees it (spec §8.2).
// Soft constraint this phase; the hard guarantee is the phase-3 network-isolation sandbox.
const MANAGE_PACKAGES_DOC = [
  'Install packages into the shared notebook environment through THIS tool only — it runs the install in the trusted main process, never in the kernel.',
  'Route by language: Python packages → manage_packages(language="python"); R packages → manage_packages(language="r"). For a PyPI-only Python package pass usePip=true; pass channels only when a package needs a non-default conda channel.',
  'conda installs resolve conda-forge + bioconda by default. A CRAN R package is installed by its plain name (e.g. "dplyr" → r-dplyr); a Bioconductor R package must be named by its bioconda package id "bioconductor-<name>" in lowercase (e.g. DESeq2 → "bioconductor-deseq2"), which is left as-is (not r- prefixed).',
  'Installs land in the environment you name (default when omitted); pass `environment` to target a named env you created with manage_environments. Installs persist across cells and sessions.',
  'Pass operation:"uninstall" to remove the listed packages from that same env (default operation is install); removal is env-scoped and never touches system/global packages.',
  'After a successful install you can import/library()-load the package in the SAME kernel right away — the running kernel picks up a newly-installed package on its next import (no restart needed). Only call notebook_restart if you installed a newer version of a package that was ALREADY imported/loaded this session and you need the running kernel to use the new version.',
  'Do NOT install any other way: no apt / brew / yum, no sudo, no curl | bash, no downloading installers, no subprocess hand-rolled installs, and no in-cell %pip / !pip / install.packages() (those run in the kernel and bypass this gate).',
  'Do NOT route around a missing package by swapping in a different library that does roughly the same thing; install the package the task actually needs.',
  'If a package needs a system/OS dependency, stop and report the limitation to the user; do NOT try to self-install it.'
].join('\n')

// Named-environment lifecycle contract embedded as the manage_environments description.
const MANAGE_ENVIRONMENTS_DOC = [
  'Create, list, and remove named persistent python/r environments. One conda environment = one process = one persistent namespace, separate from the default-python / default-r environments and from every other named environment.',
  'action:"create" — provision a new environment: pass language ("python" or "r") and name. It starts from a minimal base (just enough to run the loop protocol), plus any packages[] you pass. Use manage_packages afterwards to add more.',
  'action:"list" — return the environments already provisioned (name, language, readiness, whether it is a default).',
  'action:"remove" — delete a named environment by name. The defaults (default-python / default-r) cannot be removed. An environment with a running kernel is refused — restart or shut down its kernel first.',
  'A named environment must be created here before notebook_execute or manage_packages can target it via `environment`.',
  'Named environments have NO outbound connector (host.mcp) access, same as the default data kernels — only repl_execute (the control-plane REPL) can call connectors.'
].join('\n')

// Control-plane REPL contract, embedded as the repl_execute description so the agent always sees it.
const REPL_EXECUTE_DOC = [
  'Run JavaScript on the persistent control-plane REPL kernel — a Node process separate from the python/r data kernels.',
  'This is the ONLY kernel with outbound connector access: call `await host.mcp(server, method, args)` to reach MCP connectors. The python/r data kernels have none, so do connector fetches here.',
  'Code runs in a persistent context (globals declared in one call persist to the next). A trailing expression is echoed like a REPL — its value comes back as the result — or use `console.log(...)` / `return <expr>`. Do NOT echo a large result (many records / big JSON); it is truncated. Write large data to ./handoff/ instead.',
  'To hand data to the python/r kernels, write files into ./handoff/ (the shared workspace channel every kernel sees) and have the data cell read them back; this tool does not itself run data-analysis code.',
  'Distinct from notebook_execute: use notebook_execute for python/r data cells, and this tool for connector calls and control-plane orchestration.'
].join('\n')

// Stateless shell contract, embedded as the bash_execute description so the agent always sees it.
const BASH_EXECUTE_DOC = [
  'Run one shell command with `sh -c` in the shared session workspace. Stateless: every call spawns a fresh process, so shell state (cwd changes, exported variables, background jobs, shell functions) does NOT persist between calls — write files if you need results to carry over.',
  'Runs in the same workspace directory the python/r data kernels start in, and can read/write ./handoff/ (also at $OPEN_SCIENCE_HANDOFF_DIR), the same shared channel repl_execute uses to hand data to the data kernels.',
  'Returns { stdout, stderr, exitCode } and does not throw on a non-zero exit; inspect exitCode instead of assuming success.',
  'Distinct from notebook_execute and repl_execute: those run on persistent python/r/control-plane kernels with state that survives across calls; this tool is for one-off shell commands (ls, file moves, quick greps, package CLI probes), not for anything relying on shell state persisting.',
  'Do NOT use this to run analysis code: never write a python/R script to disk and execute it with `python`/`Rscript`/`node`, and never pipe code via `-e`/`-c`/a heredoc. Run python via notebook_execute (language:"python"), R via notebook_execute (language:"r"), and JavaScript via repl_execute — those kernels persist state, capture figures and outputs into the notebook, and install packages via manage_packages. A shell escape hatch bypasses all of that and its results are lost to the notebook.',
  'To install packages use manage_packages, not `pip install` / `Rscript -e install.packages(...)` here.'
].join('\n')

type RpcRequest = {
  method: string
  params: unknown
}

type RpcResponse = {
  result?: unknown
  error?: string
}

type NotebookToolSchema = Record<string, z.ZodTypeAny>

type NotebookRpcToolDefinition = {
  name: string
  title: string
  description: string
  method: string
  inputSchema: NotebookToolSchema
  // Optional projection of the raw RPC result before it is serialized for the agent. Used to keep
  // a verbose result (e.g. restart returning the whole session state) compact and to-the-point.
  mapResult?: (raw: unknown) => unknown
}

// Creates the ACP MCP-server declaration that launches this app bundle in notebook stdio mode.
const createNotebookMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  token,
  projectName,
  sessionId,
  workspaceCwd
}: NotebookMcpServerConfigRequest): McpServerStdio => ({
  name: NOTEBOOK_MCP_SERVER_NAME,
  command,
  args: [entryPath, NOTEBOOK_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'OPEN_SCIENCE_NOTEBOOK_RPC_ENDPOINT', value: endpoint },
    { name: 'OPEN_SCIENCE_NOTEBOOK_RPC_TOKEN', value: token },
    { name: 'OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME', value: projectName },
    { name: 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID', value: sessionId },
    { name: 'OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD', value: workspaceCwd }
  ]
})

// Reads one required environment value for the stdio MCP subprocess.
const requireEnvironmentVariable = (
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv & string
): string => {
  const value = env[name]

  if (!value) {
    throw new Error(`Missing notebook MCP environment variable: ${name}`)
  }

  return value
}

// Reconstructs the notebook RPC routing context passed through the MCP server environment.
const createNotebookMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): NotebookMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'OPEN_SCIENCE_NOTEBOOK_RPC_ENDPOINT'),
  token: requireEnvironmentVariable(env, 'OPEN_SCIENCE_NOTEBOOK_RPC_TOKEN'),
  projectName: requireEnvironmentVariable(env, 'OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME'),
  sessionId: requireEnvironmentVariable(env, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID'),
  workspaceCwd: requireEnvironmentVariable(env, 'OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD')
})

// Sends a tool request to the app-local notebook RPC server and returns its raw result payload.
const callNotebookRpc = async (
  environment: NotebookMcpEnvironment,
  method: string,
  params: unknown = {}
): Promise<unknown> => {
  const response = await fetch(environment.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      method,
      params: {
        sessionId: environment.sessionId,
        workspaceCwd: environment.workspaceCwd,
        projectName: environment.projectName,
        ...((params ?? {}) as Record<string, unknown>)
      }
    } satisfies RpcRequest)
  })

  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `Notebook RPC failed with status ${response.status}`)
  }

  return payload.result
}

// Per-stream cap for the run summary returned to the agent. The full output is always kept in
// run.json and the notebook preview; only this agent-facing copy is bounded so a single large
// result (e.g. a connector call dumping many records to stdout) cannot overflow the tool result.
const NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT = 8_000

// Clips one output stream to the field limit, appending a marker that points at the full copy.
const clipStream = (text: string): { text: string; clipped: boolean } => {
  if (text.length <= NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT) return { text, clipped: false }

  const removed = text.length - NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT
  return {
    text: `${text.slice(0, NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT)}\n…[truncated ${removed} chars; full output in notebook preview]`,
    clipped: true
  }
}

// Bounds the agent-facing run summary by clipping oversized stdout/stderr/traceback in place. Only
// touches values shaped like a run summary (a `text` object with string streams); every other RPC
// payload (state/restart/shutdown) is returned untouched. Never clips the serialized JSON string,
// which would produce invalid JSON.
// A single inline base64 image (matplotlib/ggplot figure) or other rich payload easily overflows the
// tool-result token budget, and the agent only needs to know the output exists — the full data lives
// in run.json and the notebook preview. Image mimes and any oversized payload are replaced with a
// marker; small text mimes stay inline.
const MIME_INLINE_LIMIT = 1_024
const isImageMime = (mime: string): boolean => mime.startsWith('image/')

// Elides image/oversized display payloads and clips oversized stream/error text inside one run's
// structured `outputs` array; returns whether anything was clipped.
const elideOutputs = (outputs: unknown): { outputs: unknown; clipped: boolean } => {
  if (!Array.isArray(outputs)) return { outputs, clipped: false }
  let clipped = false
  const next = outputs.map((output) => {
    if (typeof output !== 'object' || output === null) return output
    const record = output as Record<string, unknown>

    if (record.type === 'display' && typeof record.data === 'object' && record.data !== null) {
      const data = record.data as Record<string, unknown>
      const nextData: Record<string, unknown> = {}
      for (const [mime, payload] of Object.entries(data)) {
        const asString = typeof payload === 'string' ? payload : JSON.stringify(payload)
        if (isImageMime(mime) || asString.length > MIME_INLINE_LIMIT) {
          nextData[mime] = `[${mime}: ${asString.length} chars omitted; shown in notebook preview]`
          clipped = true
        } else {
          nextData[mime] = payload
        }
      }
      return { ...record, data: nextData }
    }

    for (const field of ['text', 'traceback'] as const) {
      const value = record[field]
      if (typeof value !== 'string') continue
      const { text: clippedText, clipped: didClip } = clipStream(value)
      if (didClip) {
        clipped = true
        return { ...record, [field]: clippedText }
      }
    }

    return output
  })
  return { outputs: next, clipped }
}

// Clips oversized stdout/stderr/traceback and elides image/large `outputs` on one run-shaped record
// (an execute summary, or one entry from a state result's run history).
const truncateRunLike = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  let clippedAny = false
  let next: Record<string, unknown> = record

  const text = record.text
  if (typeof text === 'object' && text !== null) {
    const streams = text as Record<string, unknown>
    const nextText: Record<string, unknown> = { ...streams }
    let textClipped = false
    for (const field of ['stdout', 'stderr', 'traceback'] as const) {
      const stream = streams[field]
      if (typeof stream !== 'string') continue
      const { text: clippedText, clipped } = clipStream(stream)
      nextText[field] = clippedText
      textClipped = textClipped || clipped
    }
    if (textClipped) {
      next = { ...next, text: nextText }
      clippedAny = true
    }
  }

  // Top-level streams: repl_execute/bash_execute control-plane results carry stdout/stderr/traceback
  // on the record itself (not under `text`). A large host.mcp result dumped into stdout here would
  // otherwise overflow the tool-result budget exactly like an untruncated run summary.
  for (const field of ['stdout', 'stderr', 'traceback'] as const) {
    const stream = record[field]
    if (typeof stream !== 'string') continue
    const { text: clippedText, clipped } = clipStream(stream)
    if (clipped) {
      next = { ...next, [field]: clippedText }
      clippedAny = true
    }
  }

  const { outputs, clipped: outputsClipped } = elideOutputs(record.outputs)
  if (outputsClipped) {
    next = { ...next, outputs }
    clippedAny = true
  }

  return clippedAny ? { ...next, truncated: true } : value
}

// Bounds the agent-facing result: clips oversized text streams and replaces image/large display
// outputs with markers — on a single run summary AND on every run inside a state result's
// `runs`/`recentRuns` history. run.json and the notebook preview keep the full data untouched.
const truncateNotebookRunResult = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>

  // State result: a run-history document with runs/recentRuns arrays.
  if (Array.isArray(record.runs) || Array.isArray(record.recentRuns)) {
    const next = { ...record }
    if (Array.isArray(record.runs)) next.runs = record.runs.map(truncateRunLike)
    if (Array.isArray(record.recentRuns)) next.recentRuns = record.recentRuns.map(truncateRunLike)
    return next
  }

  // Single run summary (execute result).
  return truncateRunLike(value)
}

// Serializes notebook RPC results exactly as execution facts for the agent to analyze, bounding the
// per-stream output size so one large run cannot overflow the tool result.
const toToolText = (value: unknown): string =>
  JSON.stringify(truncateNotebookRunResult(value), null, 2)

// Registers one MCP tool that forwards its validated input to a matching notebook RPC method.
const registerNotebookRpcTool = (
  server: ModelContextProtocolServer,
  environment: NotebookMcpEnvironment,
  definition: NotebookRpcToolDefinition
): void => {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema
    },
    async (input) => {
      const raw = await callNotebookRpc(environment, definition.method, input)
      const result = definition.mapResult ? definition.mapResult(raw) : raw
      return {
        content: [
          {
            type: 'text',
            text: toToolText(result)
          }
        ]
      }
    }
  )
}

// Projects the full session state a restart returns down to a compact confirmation: the agent only
// needs to know the kernel reset and that history is preserved — not the entire cell/run history.
const compactRestartResult = (raw: unknown): unknown => {
  if (typeof raw !== 'object' || raw === null) return raw
  const state = raw as Record<string, unknown>
  const cells = Array.isArray(state.cells) ? state.cells.length : 0
  return {
    sessionId: state.sessionId,
    kernelStatus: state.kernelStatus,
    status: 'restarted',
    note: 'Kernel restarted; in-memory variables cleared. Run history is preserved (use notebook_state to view it).',
    cells
  }
}

// Tool definitions stay data-driven so schema, title, and RPC method cannot drift independently.
const NOTEBOOK_RPC_TOOLS: NotebookRpcToolDefinition[] = [
  {
    name: 'notebook_execute',
    title: 'Execute notebook code',
    description:
      'Write one code cell and run it in the shared local interpreter, returning the full run summary. Each call is one notebook cell; reuse a cellId to overwrite and rerun that cell. Pass language: "python" (default) or "r" to select the interpreter for the cell. Pass environment to select a named persistent environment; omitted defaults to the default environment for the language, and environment="python"/"r" also mean the defaults. A named environment is a SEPARATE namespace from the default and from every other named environment (variables/imports do NOT carry across environments) — create it first with manage_environments.',
    method: 'execute',
    inputSchema: executeToolSchema
  },
  {
    name: 'repl_execute',
    title: 'Execute control-plane REPL code',
    description: REPL_EXECUTE_DOC,
    method: 'executeControl',
    inputSchema: replExecuteToolSchema
  },
  {
    name: 'bash_execute',
    title: 'Execute a stateless shell command',
    description: BASH_EXECUTE_DOC,
    method: 'executeShell',
    inputSchema: bashExecuteToolSchema
  },
  {
    name: 'notebook_state',
    title: 'Get notebook state',
    description:
      'Return current notebook cells, recent runs, notebookSessionRoot, dataRoot, runtimeRoot, cwd, and kernel status.',
    method: 'state',
    inputSchema: {}
  },
  {
    name: 'notebook_restart',
    title: 'Restart notebook interpreter',
    description:
      'Restart the shared notebook interpreter, clearing in-memory variables (run history is preserved). RARELY NEEDED: hangs and crashes recover on their own, and installing a package does NOT require a restart — a running kernel picks it up on its next import/library(). Use it only to (a) deliberately wipe the namespace / free memory, or (b) reload a NEWER version of a package you already imported this session.',
    method: 'restart',
    inputSchema: {},
    mapResult: compactRestartResult
  },
  {
    name: 'notebook_shutdown',
    title: 'Shutdown notebook interpreter',
    description: 'Shutdown the shared notebook interpreter without deleting run.json or artifacts.',
    method: 'shutdown',
    inputSchema: {}
  },
  {
    name: 'manage_packages',
    title: 'Install notebook packages',
    description: MANAGE_PACKAGES_DOC,
    method: 'managePackages',
    inputSchema: managePackagesToolSchema
  },
  {
    name: 'manage_environments',
    title: 'Manage named notebook environments',
    description: MANAGE_ENVIRONMENTS_DOC,
    method: 'manageEnvironments',
    inputSchema: manageEnvironmentsToolSchema
  }
]

// Creates the stdio MCP server and attaches every notebook tool to it.
const createNotebookMcpServer = (
  environment: NotebookMcpEnvironment
): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: NOTEBOOK_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  for (const tool of NOTEBOOK_RPC_TOOLS) {
    registerNotebookRpcTool(server, environment, tool)
  }

  return server
}

// Runs the notebook MCP server over stdio from the packaged Electron entry point.
const runNotebookMcpServer = async (
  environment = createNotebookMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createNotebookMcpServer(environment)

  await server.connect(new StdioServerTransport())
}

export {
  MANAGE_ENVIRONMENTS_DOC,
  MANAGE_PACKAGES_DOC,
  REPL_EXECUTE_DOC,
  BASH_EXECUTE_DOC,
  NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT,
  NOTEBOOK_MCP_SERVER_ARG,
  NOTEBOOK_MCP_SERVER_NAME,
  NOTEBOOK_RPC_TOOLS,
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
  callNotebookRpc,
  compactRestartResult,
  createNotebookMcpEnvironmentFromProcess,
  createNotebookMcpServer,
  createNotebookMcpServerConfig,
  runNotebookMcpServer,
  truncateNotebookRunResult
}
export type { NotebookMcpEnvironment, NotebookMcpServerConfigRequest, NotebookRpcConnection }
