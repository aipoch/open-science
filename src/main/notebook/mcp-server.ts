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
  'After each run, inspect the returned run summary, including stdout, stderr, traceback, outputs, artifacts, workingFiles, cwdBefore, and cwdAfter.',
  'If the result is not the expected user outcome, analyze the returned facts, modify code or environment, and run again.',
  'If you decide a missing package, dependency, Python executable, executor, interpreter, kernel, or runtime component must be installed, place installation contents under `~/.open-science/runtime/` and continue with that runtime.',
  'Do not install runtime dependencies into the project repository, workspace, system Python, or the user existing global environment unless the user explicitly asks.',
  'The notebook already runs inside a writable session workspace — its current working directory — so create files with plain relative paths (e.g. `plt.savefig("plot.png")`, `df.to_csv("out.csv")`). Do NOT construct or guess absolute paths under a home directory; if you need an absolute path, read it at runtime (`os.getcwd()`, `os.path.abspath("plot.png")`, or the returned `dataRoot` / env var `OPEN_SCIENCE_NOTEBOOK_DATA_DIR`).',
  'You may read user-provided existing data files in place, but do not move, overwrite, or delete original files; write derived files into the working directory.',
  'Treat notebook MCP results as execution facts only. The notebook runtime does not classify files for you; you decide whether each generated file is an intermediate working file or a final user-facing artifact.',
  'If a notebook run creates a final user-facing output such as a chart, image, report, PDF, HTML page, document, CSV export, or archive, save that final output through the `write_artifact_file` tool from `open-science-artifacts` before telling the user it is available.',
  'Pass the file to `write_artifact_file` as `source: { "kind": "localPath", "path": "<absolute path>" }` — use an ABSOLUTE path (e.g. `os.path.abspath("plot.png")` for a file you just saved to the working directory), because the artifact tool runs in a separate process and will not resolve a bare relative name.',
  'Use inline `content` only for small generated text that is already in memory.',
  'Artifact file paths are returned in `artifacts[]`; notebook working file paths are returned in `workingFiles[]`.',
  'The user does not need to click a button to send results back; use MCP return values and notebook state as the execution facts.',
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
  cellId: z.string().min(1).optional()
}

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

// Serializes notebook RPC results exactly as execution facts for the agent to analyze.
const toToolText = (value: unknown): string => JSON.stringify(value, null, 2)

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
    async (input) => ({
      content: [
        {
          type: 'text',
          text: toToolText(await callNotebookRpc(environment, definition.method, input))
        }
      ]
    })
  )
}

// Tool definitions stay data-driven so schema, title, and RPC method cannot drift independently.
const NOTEBOOK_RPC_TOOLS: NotebookRpcToolDefinition[] = [
  {
    name: 'notebook_execute',
    title: 'Execute notebook Python code',
    description:
      'Write one Python code cell and run it in the shared local interpreter, returning the full run summary. Each call is one notebook cell; reuse a cellId to overwrite and rerun that cell.',
    method: 'execute',
    inputSchema: executeToolSchema
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
      'Restart the shared notebook interpreter. Run history is preserved, but in-memory variables are cleared.',
    method: 'restart',
    inputSchema: {}
  },
  {
    name: 'notebook_shutdown',
    title: 'Shutdown notebook interpreter',
    description: 'Shutdown the shared notebook interpreter without deleting run.json or artifacts.',
    method: 'shutdown',
    inputSchema: {}
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
  NOTEBOOK_MCP_SERVER_ARG,
  NOTEBOOK_MCP_SERVER_NAME,
  NOTEBOOK_RPC_TOOLS,
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
  callNotebookRpc,
  createNotebookMcpEnvironmentFromProcess,
  createNotebookMcpServer,
  createNotebookMcpServerConfig,
  runNotebookMcpServer
}
export type { NotebookMcpEnvironment, NotebookMcpServerConfigRequest, NotebookRpcConnection }
