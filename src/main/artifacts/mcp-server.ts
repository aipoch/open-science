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
import { ArtifactRepository } from './repository'

const ARTIFACT_MCP_SERVER_ARG = '--open-science-artifact-mcp'
const ARTIFACT_MCP_SERVER_NAME = 'open-science-artifacts'

type ArtifactMcpEnvironment = {
  storageRoot: string
  projectName: string
  sessionId: string
  currentRunFile: string
  allowedImportRoots: string[]
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
            'Absolute path to an ALREADY-SAVED file inside the notebook session workspace (e.g. under OPEN_SCIENCE_NOTEBOOK_DATA_DIR). The file must exist before you call this — the app copies it.'
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

// Reads the app-owned active run id instead of accepting ids from the model tool call.
const readCurrentRunId = async (currentRunFile: string): Promise<string> => {
  const rawContext = await readFile(currentRunFile, 'utf8')
  const context = JSON.parse(rawContext) as unknown
  const runId = isRecord(context) && typeof context.runId === 'string' ? context.runId : ''

  if (!runId.trim()) {
    throw new Error('No active artifact run is available.')
  }

  return runId
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

  throw new Error('Artifact write requires either source or content.')
}

// Writes one tool call into the current pending run selected by the main process.
const writeArtifactFileForCurrentRun = async (
  repository: ArtifactRepository,
  environment: ArtifactMcpEnvironment,
  input: ArtifactToolWriteInput
): Promise<ArtifactFile> => {
  const runId = await readCurrentRunId(environment.currentRunFile)
  const source = normalizeArtifactToolWriteInput(input)

  return repository.writePendingFile(
    {
      projectName: environment.projectName,
      sessionId: environment.sessionId,
      runId,
      filename: input.filename,
      mimeType: input.mimeType,
      source
    },
    {
      allowedImportRoots: environment.allowedImportRoots
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
        'Attach a file this turn generated as a downloadable artifact (chart, image, report, CSV, archive, …). The file must ALREADY EXIST on disk before you call this. Provide `filename` plus a `source`: either {kind:"localPath", path} pointing at an already-saved file inside the notebook session workspace — save it first (e.g. plt.savefig(...) under OPEN_SCIENCE_NOTEBOOK_DATA_DIR) then pass that absolute path — or {kind:"inline", content} for small in-memory text. The app copies the file and assigns session/message ownership; do not call this before the file is written.',
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
  writeArtifactFileForCurrentRun
}
export type { ArtifactMcpEnvironment, ArtifactToolWriteInput }
