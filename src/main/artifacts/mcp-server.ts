import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import type {
  ArtifactFile,
  ArtifactWriteEncoding,
  ArtifactWriteSource
} from '../../shared/artifacts'
import { ARTIFACT_MCP_SERVER_ARG } from '../mcp-server-args'
import { ArtifactRepository } from './repository'

const ARTIFACT_MCP_SERVER_NAME = 'open-science-artifacts'

type ArtifactMcpEnvironment = {
  storageRoot: string
  projectName: string
  sessionId: string
  currentRunFile: string
  allowedImportRoots: string[]
}

// The per-turn run context the main process writes into current-run.json. runId attributes writes to
// the active turn; the notebook fields (present only in a notebook-enabled turn) carry the kernel's
// FINAL data dir + session root — resolved from the real ACP session id at turn start, so they are
// alias-proof, unlike the static session-creation env which only knows the pre-start alias.
type ArtifactRunContext = {
  runId: string
  notebookDataDir?: string
  notebookSessionRoot?: string
}

type ArtifactMcpServerConfigRequest = ArtifactMcpEnvironment & {
  command: string
  entryPath: string
}

type ArtifactToolWriteInput = {
  filename: string
  mimeType?: string
  source?: ArtifactWriteSource
  content?: string
  encoding?: ArtifactWriteEncoding
}

const writeArtifactFileToolSchema = {
  filename: z
    .string()
    .min(1)
    .describe('Display filename for the artifact, e.g. "sine_wave.png" or "report.pdf".'),
  mimeType: z.string().min(1).optional(),
  source: z
    .union([
      z.object({
        kind: z.literal('inline'),
        content: z
          .string()
          .describe(
            'Small in-memory text to write directly. Use localPath for files already on disk.'
          ),
        encoding: z.enum(['utf8', 'base64']).default('utf8')
      }),
      z.object({
        kind: z.literal('localPath'),
        path: z
          .string()
          .min(1)
          .describe(
            'Path to an ALREADY-SAVED file. A bare filename or relative path (e.g. "plot.png") resolves against the notebook session data dir (the kernel cwd) — pass the same name you saved with. An absolute path also works. Do NOT rebuild a path from an env var; the kernel cwd already IS the data dir. The file must exist before you call this — the app copies it.'
          )
      })
    ])
    .optional(),
  content: z.string().optional(),
  encoding: z.enum(['utf8', 'base64']).default('utf8')
}

// Narrows parsed JSON before reading run context fields from the handoff file.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Reads the app-owned per-turn run context instead of accepting ids/paths from the model tool call.
const readCurrentRunContext = async (currentRunFile: string): Promise<ArtifactRunContext> => {
  const rawContext = await readFile(currentRunFile, 'utf8')
  const context = JSON.parse(rawContext) as unknown
  const runId = isRecord(context) && typeof context.runId === 'string' ? context.runId : ''

  if (!runId.trim()) {
    throw new Error('No active artifact run is available.')
  }

  const notebookDataDir =
    isRecord(context) && typeof context.notebookDataDir === 'string'
      ? context.notebookDataDir
      : undefined
  const notebookSessionRoot =
    isRecord(context) && typeof context.notebookSessionRoot === 'string'
      ? context.notebookSessionRoot
      : undefined

  return { runId, notebookDataDir, notebookSessionRoot }
}

// Normalizes the legacy content/encoding shape and the new source shape into one repository input.
const normalizeArtifactToolWriteInput = (input: ArtifactToolWriteInput): ArtifactWriteSource => {
  if (input.source) return input.source

  if (typeof input.content === 'string') {
    return {
      kind: 'inline',
      content: input.content,
      encoding: input.encoding ?? 'utf8'
    }
  }

  // Neither source nor inline content: treat the display filename as a local path. Resolved against
  // the notebook data dir (the kernel cwd), so a plain `write_artifact_file(filename: "plot.png")`
  // right after `plt.savefig("plot.png")` just works — the common case needs no path at all.
  return { kind: 'localPath', path: input.filename }
}

// Writes one tool call into the current pending run selected by the main process.
const writeArtifactFileForCurrentRun = async (
  repository: ArtifactRepository,
  environment: ArtifactMcpEnvironment,
  input: ArtifactToolWriteInput
): Promise<ArtifactFile> => {
  const context = await readCurrentRunContext(environment.currentRunFile)
  const source = normalizeArtifactToolWriteInput(input)

  return repository.writePendingFile(
    {
      projectName: environment.projectName,
      sessionId: environment.sessionId,
      runId: context.runId,
      filename: input.filename,
      mimeType: input.mimeType,
      source
    },
    {
      // The kernel's final session root (from the per-turn handoff) is the authoritative import root
      // for notebook writes; add it to the static roots so a resolved relative path is accepted even
      // when the env was built under a pre-start alias.
      allowedImportRoots: context.notebookSessionRoot
        ? [...environment.allowedImportRoots, context.notebookSessionRoot]
        : environment.allowedImportRoots,
      relativeBaseDir: context.notebookDataDir
    }
  )
}

// Builds the stdio MCP server exposed to the agent for managed artifact writes.
const createArtifactMcpServer = (
  repository: ArtifactRepository,
  environment: ArtifactMcpEnvironment
): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: ARTIFACT_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(
    'write_artifact_file',
    {
      title: 'Write artifact file',
      description:
        'Attach a file this turn generated as a downloadable artifact (chart, image, report, CSV, archive, …). The file must ALREADY EXIST on disk before you call this. Simplest use inside a notebook: save with a relative name (e.g. plt.savefig("plot.png") / R png("plot.png")) then call this with just `filename: "plot.png"` — the app resolves it against the notebook session data dir (the kernel cwd) and copies it. You may also pass an explicit `source`: {kind:"localPath", path} where path is a bare filename, a path relative to the notebook data dir, or an absolute path to an already-saved file; or {kind:"inline", content} for small in-memory text. The app assigns session/message ownership; do not call this before the file is written.',
      inputSchema: writeArtifactFileToolSchema
    },
    async (input) => {
      // Echo the stored artifact metadata so the model can mention filenames without inventing paths.
      const artifact = await writeArtifactFileForCurrentRun(repository, environment, input)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ artifact }, null, 2)
          }
        ]
      }
    }
  )

  return server
}

// Creates the ACP MCP config that launches this Electron entry point in Node-compatible mode.
const createArtifactMcpServerConfig = ({
  command,
  entryPath,
  storageRoot,
  projectName,
  sessionId,
  currentRunFile,
  allowedImportRoots
}: ArtifactMcpServerConfigRequest): McpServerStdio => ({
  name: ARTIFACT_MCP_SERVER_NAME,
  command,
  args: [entryPath, ARTIFACT_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'OPEN_SCIENCE_ARTIFACT_STORAGE_ROOT', value: storageRoot },
    { name: 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME', value: projectName },
    { name: 'OPEN_SCIENCE_ARTIFACT_SESSION_ID', value: sessionId },
    { name: 'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE', value: currentRunFile },
    {
      name: 'OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS',
      value: JSON.stringify(allowedImportRoots)
    }
  ]
})

// Fails fast when the app launches MCP mode without the required artifact routing context.
const requireEnvironmentVariable = (
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv & string
): string => {
  const value = env[name]

  if (!value) {
    throw new Error(`Missing artifact MCP environment variable: ${name}`)
  }

  return value
}

const parseAllowedImportRoots = (value: string | undefined): string[] =>
  z.array(z.string()).parse(JSON.parse(value ?? '[]') as unknown)

// Reconstructs the repository/session context passed from the ACP runtime to the MCP process.
const createArtifactMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): ArtifactMcpEnvironment => ({
  storageRoot: requireEnvironmentVariable(env, 'OPEN_SCIENCE_ARTIFACT_STORAGE_ROOT'),
  projectName: requireEnvironmentVariable(env, 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME'),
  sessionId: requireEnvironmentVariable(env, 'OPEN_SCIENCE_ARTIFACT_SESSION_ID'),
  currentRunFile: requireEnvironmentVariable(env, 'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE'),
  allowedImportRoots: parseAllowedImportRoots(env.OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS)
})

// Runs only the artifact MCP server; Electron app modules are intentionally not loaded in this mode.
const runArtifactMcpServer = async (
  environment = createArtifactMcpEnvironmentFromProcess()
): Promise<void> => {
  const repository = new ArtifactRepository(environment.storageRoot)
  const server = createArtifactMcpServer(repository, environment)

  await server.connect(new StdioServerTransport())
}

export {
  ARTIFACT_MCP_SERVER_ARG,
  ARTIFACT_MCP_SERVER_NAME,
  createArtifactMcpEnvironmentFromProcess,
  createArtifactMcpServer,
  createArtifactMcpServerConfig,
  runArtifactMcpServer,
  writeArtifactFileToolSchema,
  writeArtifactFileForCurrentRun
}
export type { ArtifactMcpEnvironment, ArtifactRunContext, ArtifactToolWriteInput }
