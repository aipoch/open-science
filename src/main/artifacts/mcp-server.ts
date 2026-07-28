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
  CreateArtifactVersionRequest,
  ReplayArtifactVersionRequest
} from '../../shared/artifact-provenance'
import { ARTIFACT_MCP_SERVER_ARG } from '../mcp-server-args'
import { ArtifactRepository } from './repository'

const ARTIFACT_MCP_SERVER_NAME = 'open-science-artifacts'

type ArtifactMcpEnvironment = {
  storageRoot: string
  projectName: string
  sessionId: string
  currentRunFile: string
  allowedImportRoots: string[]
  rpcEndpoint?: string
}

// The per-turn run context the main process writes into current-run.json. runId attributes writes to
// the active turn; the notebook fields (present only in a notebook-enabled turn) carry the kernel's
// FINAL data dir + session root — resolved from the real ACP session id at turn start, so they are
// alias-proof, unlike the static session-creation env which only knows the pre-start alias.
type ArtifactRunContext = {
  artifactRunId: string
  appSessionId?: string
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
}

type ArtifactWriteInvocation = {
  writeOperationId?: string
  requestId?: string | number
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
              'Path to an ALREADY-SAVED file. A bare filename or relative path (e.g. "plot.png") resolves against the notebook session data dir (the kernel cwd), or the session workspace when there is no notebook data dir this turn — pass the same name you saved with. The session-relative `data/plot.png` form returned by Notebook `workingFiles[].relativePath` is also accepted. An absolute path also works. Do NOT rebuild a path from an env var; the kernel cwd already IS the data dir. The file must exist before you call this — the app copies it.'
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
    )
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
    appSessionId: optionalString('appSessionId'),
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

type ArtifactRpcResponse = { result?: ArtifactVersionFile | null; error?: string }

const callArtifactRpc = async (
  environment: ArtifactMcpEnvironment,
  capabilityToken: string,
  request: CreateArtifactVersionRequest
): Promise<ArtifactVersionFile> => {
  if (!environment.rpcEndpoint) {
    throw new Error('Artifact Provenance RPC connection is not configured.')
  }

  const response = await fetch(environment.rpcEndpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${capabilityToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ method: 'artifactCreateVersion', params: request })
  })
  const payload = (await response.json()) as ArtifactRpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(
      payload.error ?? `Artifact Provenance RPC failed with status ${response.status}`
    )
  }
  return payload.result
}

const callArtifactReplayRpc = async (
  environment: ArtifactMcpEnvironment,
  capabilityToken: string,
  request: ReplayArtifactVersionRequest
): Promise<ArtifactVersionFile | undefined> => {
  if (!environment.rpcEndpoint) {
    throw new Error('Artifact Provenance RPC connection is not configured.')
  }
  const response = await fetch(environment.rpcEndpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${capabilityToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ method: 'artifactReplayVersion', params: request })
  })
  const payload = (await response.json()) as ArtifactRpcResponse
  if (!response.ok || payload.error) {
    throw new Error(
      payload.error ?? `Artifact Provenance RPC failed with status ${response.status}`
    )
  }
  return payload.result ?? undefined
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
const isNotebookWorkingFilePath = (source: ArtifactWriteSource): boolean => {
  if (source.kind !== 'localPath') return false
  const segments = source.path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')

  return segments[0] === 'data' && !segments.includes('..')
}

// Writes one tool call into the current pending run selected by the main process.
const writeArtifactFileForCurrentRun = async (
  repository: ArtifactRepository,
  environment: ArtifactMcpEnvironment,
  input: ArtifactToolWriteInput,
  invocation: ArtifactWriteInvocation = {}
): Promise<ArtifactFile | ArtifactVersionFile> => {
  const context = await readCurrentRunContext(environment.currentRunFile)
  const source = normalizeArtifactToolWriteInput(
    input,
    Boolean(context.notebookDataDir || environment.allowedImportRoots[0])
  )
  // A relative source normally has one authoritative base. Notebook workingFiles are the one bounded
  // exception: their `data/...` path is session-root relative, so probe the current session root after
  // the kernel cwd. Never probe additional workspace roots during a Notebook turn — that could import
  // a stale same-named file from outside the current Notebook Session.
  const relativeBaseDirs = context.notebookDataDir
    ? [
        context.notebookDataDir,
        ...(context.notebookSessionRoot && isNotebookWorkingFilePath(source)
          ? [context.notebookSessionRoot]
          : [])
      ]
    : environment.allowedImportRoots.slice(0, 1)
  const writeRequest = {
    projectName: environment.projectName,
    sessionId: environment.sessionId,
    runId: context.artifactRunId,
    filename: input.filename,
    mimeType: input.mimeType,
    source
  }
  const writeOptions = {
    // The kernel's final session root (from the per-turn handoff) is the authoritative import root
    // for notebook writes; add it to the static roots so a resolved relative path is accepted even
    // when the env was built under a pre-start alias. Authorization-only: it must NOT also join
    // relativeBaseDirs — a relative name resolves against the kernel cwd (notebookDataDir), never
    // against the session root.
    allowedImportRoots: context.notebookSessionRoot
      ? [...environment.allowedImportRoots, context.notebookSessionRoot]
      : environment.allowedImportRoots,
    relativeBaseDirs
  }

  // Old handoff files remain writable during migration. New production handoffs always include the
  // graph locators and RPC capability; only that complete trusted envelope may create a durable
  // Version in SQLite.
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
    return repository.writePendingFile(writeRequest, writeOptions)
  }
  const appSessionId = context.appSessionId
  const rootFrameId = context.rootFrameId
  const agentFrameId = context.agentFrameId
  const messageBranchId = context.messageBranchId
  const runtimeSegmentId = context.runtimeSegmentId
  const promptMessageId = context.promptMessageId
  const writeOperationId =
    invocation.writeOperationId ??
    (invocation.requestId !== undefined
      ? `artifact-write-${createHash('sha256')
          .update(
            JSON.stringify([
              environment.projectName,
              appSessionId,
              context.artifactRunId,
              invocation.requestId
            ])
          )
          .digest('hex')}`
      : `artifact-write-${randomUUID()}`)

  // A local path is mutable and may disappear after a successful first call. Ask SQLite whether the
  // app-owned operation already committed before copying or reading that path. Inline content remains
  // byte-checked below so reusing an operation with different inline bytes is still a hard conflict.
  if (source.kind === 'localPath') {
    const replay = await callArtifactReplayRpc(environment, context.rpcCapabilityToken, {
      projectId: environment.projectName,
      appSessionId,
      artifactStorageSessionId: environment.sessionId,
      artifactRunId: context.artifactRunId,
      writeOperationId,
      filename: input.filename,
      contentType: input.mimeType,
      producerRunId: input.producerRunId
    })
    if (replay) return replay
  }

  return repository.withPendingFileTransaction(
    writeRequest,
    writeOptions,
    async (pendingFile, sourceFileObservation) => {
      const contentChecksum = createHash('sha256')
        .update(await readFile(pendingFile.path))
        .digest('hex')
      const writeRequestChecksum = createHash('sha256')
        .update(
          JSON.stringify({
            contentChecksum,
            contentType: input.mimeType ?? null,
            filename: input.filename,
            producerRunId: input.producerRunId ?? null,
            sourceFileObservation: sourceFileObservation ?? null
          })
        )
        .digest('hex')

      return callArtifactRpc(environment, context.rpcCapabilityToken!, {
        projectId: environment.projectName,
        appSessionId,
        artifactStorageSessionId: environment.sessionId,
        artifactRunId: context.artifactRunId,
        writeOperationId,
        writeRequestChecksum,
        rootFrameId,
        agentFrameId,
        messageBranchId,
        messageBranchAncestry: context.messageBranchAncestry,
        messageAncestry: context.messageAncestry,
        runtimeSegmentId,
        promptMessageId,
        agentName: context.agentName,
        notebookSessionId: context.notebookSessionId,
        producerRunId: input.producerRunId,
        sourceFileObservation,
        filename: input.filename,
        contentType: input.mimeType
      })
    }
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
        content_type: artifact.mimeType,
        size_bytes: artifact.size,
        checksum: artifact.checksum,
        producer_run_id: artifact.producerRunId,
        environment: artifact.environment
      }
    }
  }

  return { artifact }
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
        'Attach a file this turn generated as a downloadable artifact (chart, image, report, CSV, archive, …). The file must ALREADY EXIST on disk before you call this. Simplest use inside a notebook: save with a relative name (e.g. plt.savefig("plot.png") / R png("plot.png")) then call this with just `filename: "plot.png"` — the app resolves it against the notebook session data dir (the kernel cwd) and copies it. You may also pass an explicit `source`: {kind:"localPath", path} where path is a bare filename, a path relative to the notebook data dir or session workspace, the session-relative `data/plot.png` returned by Notebook `workingFiles`, or an absolute path to an already-saved file; or {kind:"inline", content} for small in-memory text. The app assigns session/message ownership; do not call this before the file is written.',
      inputSchema: writeArtifactFileToolSchema
    },
    async (input, extra) => {
      // Echo the stored artifact metadata so the model can mention filenames without inventing paths.
      const artifact = await writeArtifactFileForCurrentRun(repository, environment, input, {
        requestId: extra.requestId
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
const createArtifactMcpServerConfig = ({
  command,
  entryPath,
  storageRoot,
  projectName,
  sessionId,
  currentRunFile,
  allowedImportRoots,
  rpcEndpoint
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
    },
    ...(rpcEndpoint ? [{ name: 'OPEN_SCIENCE_ARTIFACT_RPC_ENDPOINT', value: rpcEndpoint }] : [])
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
  allowedImportRoots: parseAllowedImportRoots(env.OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS),
  rpcEndpoint: env.OPEN_SCIENCE_ARTIFACT_RPC_ENDPOINT
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
  callArtifactRpc,
  toWriteArtifactToolResult,
  writeArtifactFileToolSchema,
  writeArtifactFileForCurrentRun
}
export type { ArtifactMcpEnvironment, ArtifactRunContext, ArtifactToolWriteInput }
