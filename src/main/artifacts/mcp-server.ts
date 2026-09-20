import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import type {
  ArtifactFile,
  ArtifactWriteEncoding,
  ArtifactWriteSource
} from '../../shared/artifacts'
import type {
  ArtifactVersionFile,
  SaveArtifactVersionRequest
} from '../../shared/artifact-provenance'
import {
  artifactLiteratureRequestSchema,
  type ArtifactLiteratureRequest
} from '../../shared/artifact-literature'
import { resolveProjectId } from '../../shared/project-scope'
import type { ProjectIdScope } from '../../shared/project-scope'
import { ARTIFACT_MCP_SERVER_ARG } from '../mcp-server-args'
import { fetchLocalRpc } from '../local-rpc-transport'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'
import { ArtifactRepository } from './repository'
import { inlineDecodedSize } from '../bounded-file-io'

const ARTIFACT_MCP_SERVER_NAME = 'open-science-artifacts'

type ArtifactMcpEnvironment = ProjectIdScope & {
  storageRoot: string
  sessionId: string
  currentRunFile: string
  allowedImportRoots: string[]
  rpcEndpoint?: string
  rpcSocketPath?: string
}

// The per-turn run context the main process writes into current-run.json. runId attributes writes to
// the active turn; the notebook fields (present only in a notebook-enabled turn) carry the kernel's
// FINAL data dir + session root — resolved from the real ACP session id at turn start, so they are
// alias-proof, unlike the static session-creation env which only knows the pre-start alias.
type ArtifactRunContext = {
  artifactRunId: string
  executionId?: string
  appSessionId?: string
  artifactStorageSessionId?: string
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
  promptMessageId?: string
  agentName?: string
  notebookSessionId?: string
  notebookDataDir?: string
  notebookSessionRoot?: string
  rpcCapabilityToken?: string
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
  producerRunId?: string
  literature?: ArtifactLiteratureRequest
}

type ArtifactWriteInvocation = {
  writeOperationId?: string
  requestId?: string | number
  signal?: AbortSignal
}

// Some MCP clients serialize nested tool arguments before sending them. Accept a valid JSON string
// here while leaving non-JSON strings for Zod to reject with its normal schema error.
const parseJsonString = (value: unknown): unknown => {
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const writeArtifactFileToolSchema = {
  filename: z
    .string()
    .min(1)
    .describe('Display filename for the artifact, e.g. "sine_wave.png" or "report.pdf".'),
  mimeType: z.string().min(1).optional(),
  source: z
    .preprocess(
      parseJsonString,
      z.union([
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
              'Path to an ALREADY-SAVED file. A bare filename or relative path (e.g. "plot.png") resolves first against the notebook session data dir (the kernel cwd), then the session workspace — pass the same name you saved with. The session-relative `data/plot.png` form returned by Notebook `workingFiles[].relativePath` is also accepted. An absolute path also works. Do NOT rebuild a path from an env var; the kernel cwd already IS the data dir. The file must exist before you call this — the app copies it.'
            )
        })
      ])
    )
    .optional(),
  content: z.string().optional(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  producerRunId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Required when a Notebook cell/REPL/bash execution produced this file: pass the exact runId returned by that execution. Omit only when no Notebook execution produced it.'
    ),
  literature: z
    .preprocess(parseJsonString, artifactLiteratureRequestSchema)
    .optional()
    .describe(
      'Advanced fallback for artifacts without prepared citation metadata. For DOCX or LaTeX ZIP output, use the Literature preparation tool first and omit this field; write_artifact_file discovers its checksum-bound citation metadata automatically. If needed here, pass citationId and itemId; the app supplies metadata revisions and freezes verified snapshots.'
    )
}

const writeArtifactFileToolDefinition = {
  title: 'Write artifact file',
  description:
    'Attach a file this turn generated as a downloadable artifact (chart, image, report, CSV, archive, …). For small generated text such as Markdown or plain text, pass inline content directly; do not use Notebook, REPL, shell, or workspace file tools merely to create an intermediate file. For binary or otherwise disk-generated output, the file must already exist before this call. Simplest use inside a notebook: save with a relative name (e.g. plt.savefig("plot.png") / R png("plot.png")) then call this with just `filename: "plot.png"` — the app resolves it against the notebook session data dir (the kernel cwd) and copies it. Literature formatting tools attach their prepared DOCX and LaTeX outputs themselves; do not write those files again. You may also pass an explicit `source`: {kind:"localPath", path} where path is a bare filename, a path relative to the notebook data dir or session workspace, the session-relative `data/plot.png` returned by Notebook `workingFiles`, or an absolute path to an already-saved file; or {kind:"inline", content} for small in-memory text. The app assigns session/message ownership; do not call this before the file is written.',
  inputSchema: writeArtifactFileToolSchema
}

// Narrows parsed JSON before reading run context fields from the handoff file.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Reads the app-owned per-turn run context instead of accepting ids/paths from the model tool call.
const readCurrentRunContext = async (currentRunFile: string): Promise<ArtifactRunContext> => {
  const rawContext = await readFile(currentRunFile, 'utf8')
  const context = JSON.parse(rawContext) as unknown
  const artifactRunId =
    isRecord(context) && typeof context.artifactRunId === 'string'
      ? context.artifactRunId
      : isRecord(context) && typeof context.runId === 'string'
        ? context.runId
        : ''

  if (!artifactRunId.trim()) {
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

  const optionalString = (key: keyof ArtifactRunContext): string | undefined =>
    isRecord(context) && typeof context[key] === 'string' ? context[key] : undefined

  return {
    artifactRunId,
    executionId: optionalString('executionId'),
    appSessionId: optionalString('appSessionId'),
    artifactStorageSessionId: optionalString('artifactStorageSessionId'),
    rootFrameId: optionalString('rootFrameId'),
    agentFrameId: optionalString('agentFrameId'),
    messageBranchId: optionalString('messageBranchId'),
    messageBranchAncestry:
      isRecord(context) &&
      Array.isArray(context.messageBranchAncestry) &&
      context.messageBranchAncestry.every((value) => typeof value === 'string')
        ? context.messageBranchAncestry
        : undefined,
    messageAncestry:
      isRecord(context) &&
      Array.isArray(context.messageAncestry) &&
      context.messageAncestry.every((value) => typeof value === 'string')
        ? context.messageAncestry
        : undefined,
    runtimeSegmentId: optionalString('runtimeSegmentId'),
    promptMessageId: optionalString('promptMessageId'),
    agentName: optionalString('agentName'),
    notebookSessionId: optionalString('notebookSessionId'),
    notebookDataDir,
    notebookSessionRoot,
    rpcCapabilityToken: optionalString('rpcCapabilityToken')
  }
}

type ArtifactRpcResponse<Result> = { result?: Result | null; error?: string }

const serializeArtifactSaveRequest = (request: SaveArtifactVersionRequest): string => {
  const body = JSON.stringify({ method: 'artifactSaveVersion', params: request })
  assertWithinResourceBudget(
    'request',
    Buffer.byteLength(body),
    LOCAL_RESOURCE_BUDGETS.requestBytes
  )
  return body
}

const callArtifactRpc = async (
  environment: ArtifactMcpEnvironment,
  capabilityToken: string,
  request: SaveArtifactVersionRequest,
  signal?: AbortSignal
): Promise<ArtifactVersionFile> => {
  if (!environment.rpcEndpoint) {
    throw new Error('Artifact Provenance RPC connection is not configured.')
  }

  const response = await fetchLocalRpc(
    {
      endpoint: environment.rpcEndpoint,
      socketPath: environment.rpcSocketPath
    },
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capabilityToken}`,
        'content-type': 'application/json'
      },
      body: serializeArtifactSaveRequest(request),
      signal
    },
    'Artifact Provenance RPC'
  )
  const payload = (await response.json()) as ArtifactRpcResponse<ArtifactVersionFile>

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(
      payload.error ?? `Artifact Provenance RPC failed with status ${response.status}`
    )
  }
  return payload.result
}

// Normalizes the legacy content/encoding shape and the new source shape into one repository input.
// hasRelativeBase only gates whether the bare-filename convenience default is meaningful; the
// actual relative-path resolution (the ordered multi-base probe) happens exclusively in the
// repository layer.
const normalizeArtifactToolWriteInput = (
  input: ArtifactToolWriteInput,
  hasRelativeBase: boolean
): ArtifactWriteSource => {
  // An explicit source passes through untouched; the repository resolves a relative localPath
  // against the turn's ordered base dirs (never the MCP/app process cwd) and rejects when the turn
  // carries no base at all, so the caller gets a clear "pass an absolute path" error instead of a
  // spurious not-found from the wrong cwd.
  if (input.source) return input.source

  if (typeof input.content === 'string') {
    return {
      kind: 'inline',
      content: input.content,
      encoding: input.encoding ?? 'utf8'
    }
  }

  // Neither source nor inline content. The bare-filename default only makes sense when there is a
  // base dir to resolve it against (kernel cwd or session workspace): `write_artifact_file(filename:
  // "plot.png")` right after `plt.savefig("plot.png")` just works. With no base at all a bare
  // filename would silently resolve against the MCP process cwd and fail the allow-root check —
  // keep the explicit contract error instead so the caller learns what to pass.
  if (!hasRelativeBase) {
    throw new Error(
      'write_artifact_file requires source or content: no notebook session data dir or allowed import root to resolve a bare filename against.'
    )
  }

  return { kind: 'localPath', path: input.filename }
}

// Notebook workingFiles use paths relative to the session root (`data/plot.png`), while code runs
// inside that data directory and naturally uses `plot.png`. Accept both app-owned representations.
// The kernel-relative interpretation stays first so an explicit `data/plot.png` saved by user code
// still resolves to `<dataDir>/data/plot.png`; only a missing first candidate falls through to the
// same current Notebook Session root, never to an unrelated workspace or process cwd.
// Writes one tool call into the current pending run selected by the main process.
const writeArtifactFileForCurrentRun = async (
  _repository: ArtifactRepository,
  environment: ArtifactMcpEnvironment,
  input: ArtifactToolWriteInput,
  invocation: ArtifactWriteInvocation = {}
): Promise<ArtifactVersionFile> => {
  const projectId = resolveProjectId(environment)
  const context = await readCurrentRunContext(environment.currentRunFile)
  const artifactStorageSessionId = context.artifactStorageSessionId ?? environment.sessionId
  const source = normalizeArtifactToolWriteInput(
    input,
    Boolean(context.notebookDataDir || environment.allowedImportRoots[0])
  )
  if (
    !environment.rpcEndpoint ||
    !context.rpcCapabilityToken ||
    !context.appSessionId ||
    !context.rootFrameId ||
    !context.agentFrameId ||
    !context.messageBranchId ||
    !context.runtimeSegmentId ||
    !context.promptMessageId
  ) {
    throw new Error(
      'Artifact save protocol requires a complete active run capability. Restart the Agent MCP connection.'
    )
  }
  const appSessionId = context.appSessionId
  const writeOperationId =
    invocation.writeOperationId ??
    (invocation.requestId !== undefined
      ? `artifact-write-${createHash('sha256')
          .update(
            JSON.stringify([projectId, appSessionId, context.artifactRunId, invocation.requestId])
          )
          .digest('hex')}`
      : `artifact-write-${randomUUID()}`)

  let transportedSource = source
  if (source.kind === 'inline') {
    const encoding = source.encoding ?? 'utf8'
    assertWithinResourceBudget(
      'file',
      inlineDecodedSize(source.content, encoding),
      LOCAL_RESOURCE_BUDGETS.artifactInlineBytes
    )
    transportedSource = {
      kind: 'inline',
      content: Buffer.from(source.content, encoding).toString('base64'),
      encoding: 'base64'
    }
  }
  return callArtifactRpc(
    environment,
    context.rpcCapabilityToken,
    {
      projectId,
      appSessionId,
      artifactStorageSessionId,
      artifactRunId: context.artifactRunId,
      writeOperationId,
      rootFrameId: context.rootFrameId,
      agentFrameId: context.agentFrameId,
      messageBranchId: context.messageBranchId,
      runtimeSegmentId: context.runtimeSegmentId,
      promptMessageId: context.promptMessageId,
      filename: input.filename,
      contentType: input.mimeType,
      producerRunId: input.producerRunId,
      literature: input.literature,
      source: transportedSource
    },
    invocation.signal
  )
}

const toWriteArtifactToolResult = (
  artifact: ArtifactFile | ArtifactVersionFile
): { artifact: unknown } => {
  if ('versionId' in artifact) {
    return {
      artifact: {
        artifact_id: artifact.artifactId,
        version_id: artifact.versionId,
        version_number: artifact.versionNumber,
        filename: artifact.name,
        size_bytes: artifact.size,
        producer_run_id: artifact.producerRunId
      }
    }
  }

  return {
    artifact: {
      artifact_id: artifact.id,
      filename: artifact.name,
      size_bytes: artifact.size,
      producer_run_id: artifact.producerRunId
    }
  }
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
    writeArtifactFileToolDefinition,
    async (input, extra) => {
      // Echo the stored artifact metadata so the model can mention filenames without inventing paths.
      const artifact = await writeArtifactFileForCurrentRun(repository, environment, input, {
        requestId: extra.requestId,
        signal: extra.signal
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(toWriteArtifactToolResult(artifact), null, 2)
          }
        ]
      }
    }
  )

  return server
}

// Creates the ACP MCP config that launches this Electron entry point in Node-compatible mode.
const createArtifactMcpServerConfig = (request: ArtifactMcpServerConfigRequest): McpServerStdio => {
  const projectId = resolveProjectId(request)
  return {
    name: ARTIFACT_MCP_SERVER_NAME,
    command: request.command,
    args: [request.entryPath, ARTIFACT_MCP_SERVER_ARG],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'OPEN_SCIENCE_ARTIFACT_STORAGE_ROOT', value: request.storageRoot },
      { name: 'OPEN_SCIENCE_ARTIFACT_PROJECT_ID', value: projectId },
      { name: 'OPEN_SCIENCE_ARTIFACT_SESSION_ID', value: request.sessionId },
      { name: 'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE', value: request.currentRunFile },
      {
        name: 'OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS',
        value: JSON.stringify(request.allowedImportRoots)
      },
      ...(request.rpcEndpoint
        ? [{ name: 'OPEN_SCIENCE_ARTIFACT_RPC_ENDPOINT', value: request.rpcEndpoint }]
        : []),
      ...(request.rpcSocketPath
        ? [{ name: 'OPEN_SCIENCE_ARTIFACT_RPC_SOCKET_PATH', value: request.rpcSocketPath }]
        : [])
    ]
  }
}

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
): ArtifactMcpEnvironment => {
  const currentProjectId = env.OPEN_SCIENCE_ARTIFACT_PROJECT_ID
  const legacyProjectId = env.OPEN_SCIENCE_ARTIFACT_PROJECT_NAME
  if (currentProjectId && legacyProjectId && currentProjectId !== legacyProjectId) {
    throw new Error('Conflicting projectId and legacy projectName values.')
  }
  const projectId = resolveProjectId({ projectId: currentProjectId ?? legacyProjectId })
  return {
    storageRoot: requireEnvironmentVariable(env, 'OPEN_SCIENCE_ARTIFACT_STORAGE_ROOT'),
    projectId,
    sessionId: requireEnvironmentVariable(env, 'OPEN_SCIENCE_ARTIFACT_SESSION_ID'),
    currentRunFile: requireEnvironmentVariable(env, 'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE'),
    allowedImportRoots: parseAllowedImportRoots(env.OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS),
    rpcEndpoint: env.OPEN_SCIENCE_ARTIFACT_RPC_ENDPOINT,
    rpcSocketPath: env.OPEN_SCIENCE_ARTIFACT_RPC_SOCKET_PATH
  }
}

// Runs only the artifact MCP server; Electron app modules are intentionally not loaded in this mode.
const runArtifactMcpServer = async (
  environment = createArtifactMcpEnvironmentFromProcess()
): Promise<void> => {
  const repository = new ArtifactRepository(environment.storageRoot)
  const server = createArtifactMcpServer(repository, environment)

  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: LOCAL_RESOURCE_BUDGETS.requestBytes
    })
  )
}

export {
  ARTIFACT_MCP_SERVER_ARG,
  ARTIFACT_MCP_SERVER_NAME,
  createArtifactMcpEnvironmentFromProcess,
  createArtifactMcpServer,
  createArtifactMcpServerConfig,
  readCurrentRunContext,
  runArtifactMcpServer,
  callArtifactRpc,
  toWriteArtifactToolResult,
  writeArtifactFileToolDefinition,
  writeArtifactFileToolSchema,
  writeArtifactFileForCurrentRun
}
export type { ArtifactMcpEnvironment, ArtifactRunContext, ArtifactToolWriteInput }
