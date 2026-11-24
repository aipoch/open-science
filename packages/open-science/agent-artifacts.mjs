/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { AgentError } from './agent-adapter.mjs'
import { defaultAgentDeliveryDirectory } from './agent-delivery-directory.mjs'
import { deliverLocalFile, verifyLocalFile } from './local-file-delivery.mjs'

const sessionId = z
  .string()
  .trim()
  .min(1)
  .describe('Session ID from the research receipt or import.')
const runId = z.string().trim().min(1).describe('Run ID from the research receipt.')
const outputPath = z.string().refine((value) => isAbsolute(value) && !value.includes('\0'), {
  message: 'Use an absolute local path.'
})
const outputName = z
  .string()
  .min(1)
  .max(255)
  .describe('Exact Artifact name requested for this Run.')
const transferBudget = 300_000
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}

function projectArtifact(artifact, runId) {
  const {
    id,
    artifactId,
    versionId,
    artifactRunId,
    producerRunId,
    name,
    mimeType,
    kind,
    size,
    sha256
  } = artifact
  return {
    downloadId: id,
    artifactId,
    versionId,
    artifactRunId,
    producerRunId,
    runId,
    name,
    mimeType,
    kind,
    bytes: Number.isSafeInteger(size) && size >= 0 ? size : undefined,
    sha256: id === versionId && /^[a-f0-9]{64}$/u.test(sha256 ?? '') ? sha256 : undefined
  }
}

const loadArtifacts = async (client, sessionId, signal, run) => {
  if (run && run.sessionId !== sessionId) {
    throw new AgentError('invalid_request', { message: 'The Run does not belong to this Session.' })
  }
  const listed = await client.listArtifacts(sessionId, { signal })
  const produced =
    run && new Set(run.artifacts?.map((artifact) => artifact.versionId ?? artifact.id))
  return listed
    .filter(({ id }) => !produced || produced.has(id))
    .map((artifact) => projectArtifact(artifact, run?.id))
}

const defaultOutput = (profile, { downloadId, name }) => {
  const segment =
    /^[a-z0-9][a-z0-9_.-]{0,127}$/iu.test(downloadId) && !downloadId.endsWith('.')
      ? downloadId
      : createHash('sha256').update(downloadId).digest('hex')
  const filename = name && !/[\\/:]|\p{Cc}|[. ]$/u.test(name) ? name : 'artifact'
  return join(defaultAgentDeliveryDirectory(profile), segment, filename)
}

async function download({ sessionId, downloadId, outputPath, timeoutMs }, context) {
  const { signal, getClient, configRoot } = context
  const client = await getClient()
  const artifacts = await loadArtifacts(client, sessionId, signal)
  const artifact = artifacts.find((artifact) => artifact.downloadId === downloadId)
  if (!artifact) throw new AgentError('artifact_not_found')
  const path = outputPath ?? defaultOutput(client.configRoot ?? configRoot, artifact)
  if (!outputPath) await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  return {
    sessionId,
    downloadId,
    artifactId: artifact.artifactId,
    versionId: artifact.versionId,
    timeoutMs,
    ...(await deliverLocalFile(
      () => client.downloadArtifact(downloadId, { signal, timeoutMs }),
      path,
      {
        signal,
        expectedBytes: artifact.bytes,
        expectedSha256: artifact.sha256
      }
    ))
  }
}

async function deliveryStatus({ runId, reportName, tableName, reportPath, tablePath }, context) {
  if (reportName === tableName) {
    throw new AgentError('invalid_request', {
      message: 'Specify distinct report and result table names.'
    })
  }
  const { getClient, signal, configRoot } = context
  const client = await getClient()
  const run = await client.getRun(runId, { signal })
  const artifacts = await loadArtifacts(client, run.sessionId, signal, run)
  const timeout = AbortSignal.timeout(transferBudget)
  const verifySignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const outputs = await Promise.all(
    [
      ['report', reportName, reportPath],
      ['table', tableName, tablePath]
    ].map(async ([role, name, path]) => {
      const matches = artifacts.filter((artifact) => artifact.name === name)
      const artifact = matches.length === 1 ? matches[0] : undefined
      if (!artifact) return { role, name, status: matches.length ? 'ambiguous' : 'missing' }
      const location = path ?? defaultOutput(client.configRoot ?? configRoot, artifact)
      return {
        role,
        name,
        downloadId: artifact.downloadId,
        path: location,
        status: (await verifyLocalFile(location, artifact, verifySignal)) ? 'verified' : 'available'
      }
    })
  )
  const available = outputs.filter(({ status }) => status === 'available' || status === 'verified')
  const verified = outputs.every(({ status }) => status === 'verified')
  const unverifiedDefaults = outputs
    .filter(
      ({ role, status }) => status === 'available' && !(role === 'report' ? reportPath : tablePath)
    )
    .map(({ role }) => `${role}Path`)
    .join(' and ')
  const execution = run.execution ?? { status: 'unconfirmed' }
  const completed =
    run.status === 'completed' &&
    execution.sessionId === run.sessionId &&
    execution.status === 'completed' &&
    execution.kernelDispatched === true
  return {
    runId,
    sessionId: run.sessionId,
    runStatus: run.status,
    execution,
    handoffStatus: completed && verified ? 'complete' : 'incomplete',
    delivery: {
      status: verified
        ? 'verified'
        : available.length === 2
          ? 'available'
          : available.length
            ? 'partial'
            : 'missing',
      verified,
      outputs
    },
    ...(unverifiedDefaults
      ? {
          next: [
            {
              action: 'get_delivery_status',
              runId,
              reportName,
              tableName,
              ...(reportPath ? { reportPath } : {}),
              ...(tablePath ? { tablePath } : {}),
              message: `No file verified at the default path for ${unverifiedDefaults}. If already downloaded elsewhere, recheck using ${unverifiedDefaults} from the download receipt. Otherwise download the files first. No background verification is pending.`
            }
          ]
        }
      : {})
  }
}

export const artifactCapabilities = [
  {
    name: 'list_artifacts',
    description:
      'List published Artifacts for a Session; use the downloadId directly. Pass runId to restrict results to outputs from that Run.',
    inputSchema: z.strictObject({ sessionId, runId: runId.optional() }),
    annotations: readOnly,
    async handler({ sessionId, runId }, { getClient, signal }) {
      const client = await getClient()
      const run = runId ? await client.getRun(runId, { signal }) : undefined
      return loadArtifacts(client, sessionId, signal, run)
    }
  },
  {
    name: 'download_artifact',
    description:
      'Download a listed Artifact version to a local file. Never overwrite an existing path. Requires the Agent, MCP and service to share the host filesystem.',
    inputSchema: z.strictObject({
      sessionId,
      downloadId: z.string().trim().min(1).describe('Download ID returned by list_artifacts.'),
      outputPath: outputPath
        .optional()
        .describe(
          'Absolute path in an existing directory. Default: <profile>/agent-delivery/<downloadId>/<Artifact name>.'
        ),
      timeoutMs: z.number().int().min(1).max(transferBudget).default(transferBudget)
    }),
    annotations: { ...readOnly, readOnlyHint: false, idempotentHint: false },
    handler: download
  },
  {
    name: 'get_delivery_status',
    description:
      'Check execution and delivery for one Run. Pass reportPath and tablePath from the download receipts for custom locations; omitted paths check only the default delivery directory. Available means an Artifact exists but its file did not verify at the checked path. A complete handoff requires matching source bytes and SHA-256, a completed Notebook with kernel dispatch, and a completed Run.',
    inputSchema: z.strictObject({
      runId,
      reportName: outputName,
      tableName: outputName,
      reportPath: outputPath
        .optional()
        .describe('Path of the downloaded report, when a custom path was used.'),
      tablePath: outputPath
        .optional()
        .describe('Path of the downloaded table, when a custom path was used.')
    }),
    annotations: readOnly,
    handler: deliveryStatus
  }
].map((entry) => ({
  ...entry,
  group: 'delivery',
  exposure: { cli: true, mcp: true },
  serviceCapability: 'task-artifacts'
}))
