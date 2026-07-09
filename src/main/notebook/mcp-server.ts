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
  'When writing code to the notebook, begin a code cell, append code deltas, finish the cell, then run it explicitly.',
  'After each run, inspect the returned run summary, including stdout, stderr, traceback, outputs, artifacts, workingFiles, cwdBefore, and cwdAfter.',
  'If the result is not the expected user outcome, analyze the returned facts, modify code or environment, and run again.',
  'If you decide a missing package, dependency, Python executable, executor, interpreter, kernel, or runtime component must be installed, place installation contents under `~/.open-science/runtime/` and continue with that runtime.',
  'Do not install runtime dependencies into the project repository, workspace, system Python, or the user existing global environment unless the user explicitly asks.',
  'When notebook work requires data acquisition, download, cleaning, sampling, merging, caching, or intermediate analysis files, write files you create under `~/.open-science/notebooks/default-project/<sessionId>/`, preferably using returned `notebookSessionRoot` / `dataRoot` or the Python environment variables `OPEN_SCIENCE_NOTEBOOK_DIR` / `OPEN_SCIENCE_NOTEBOOK_DATA_DIR`.',
  'You may read user-provided existing data files in place, but do not move, overwrite, or delete original files; write derived files into the notebook session workspace.',
  'Treat notebook MCP results as execution facts only. The notebook runtime does not classify files for you; you decide whether each generated file is an intermediate working file or a final user-facing artifact.',
  'If a notebook run creates a final user-facing output such as a chart, image, report, PDF, HTML page, document, CSV export, or archive, save that final output through the `write_artifact_file` tool from `open-science-artifacts` before telling the user it is available.',
  'If the final output file is under the notebook session workspace, pass its absolute local path to `write_artifact_file` with `source: { "kind": "localPath", "path": "<absolute path>" }`.',
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

const beginCodeCellToolSchema = {
  cellId: z.string().min(1).optional()
}

const appendCodeCellToolSchema = {
  writeId: z.string().min(1),
  cellId: z.string().min(1),
  delta: z.string()
}

const finishCodeCellToolSchema = {
  writeId: z.string().min(1),
  cellId: z.string().min(1)
}

const runCellToolSchema = {
  cellId: z.string().min(1),
  timeoutMs: z.number().int().positive().optional()
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
    name: 'notebook_begin_code_cell',
    title: 'Begin notebook code cell',
    description:
      'Begin streaming Python code into the shared notebook. The app locks the target cell while code is being written.',
    method: 'beginCodeCell',
    inputSchema: beginCodeCellToolSchema
  },
  {
    name: 'notebook_append_code_cell',
    title: 'Append notebook code cell',
    description:
      'Append raw Python code text to the active notebook cell. Do not send chat text or Markdown.',
    method: 'appendCodeCell',
    inputSchema: appendCodeCellToolSchema
  },
  {
    name: 'notebook_finish_code_cell',
    title: 'Finish notebook code cell',
    description: 'Finish agent code streaming and release the notebook write lock.',
    method: 'finishCodeCell',
    inputSchema: finishCodeCellToolSchema
  },
  {
    name: 'notebook_run_cell',
    title: 'Run notebook code cell',
    description:
      'Run an existing notebook cell in the shared local Python interpreter and return the full run summary.',
    method: 'runCell',
    inputSchema: runCellToolSchema
  },
  {
    name: 'notebook_execute',
    title: 'Execute notebook Python code',
    description:
      'Convenience tool that writes one Python code cell, runs it, and returns the full run summary.',
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
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
  callNotebookRpc,
  createNotebookMcpEnvironmentFromProcess,
  createNotebookMcpServer,
  createNotebookMcpServerConfig,
  runNotebookMcpServer
}
export type { NotebookMcpEnvironment, NotebookMcpServerConfigRequest, NotebookRpcConnection }
