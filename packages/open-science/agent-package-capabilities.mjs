/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { verifyLocalFile } from './local-file-delivery.mjs'

const defaultWaitMs = 30_000
const pollIntervalMs = 250
const serviceCapability = 'agent-package-operations'
const importCapability = 'agent-package-import'
const forkCapability = 'agent-package-fork'
const exportReviewCapability = 'agent-sensitive-export-review'
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const referenceId = z.uuid()
const pathSchema = z
  .string()
  .min(1)
  .max(32768)
  .regex(/\.science$/i)
  .refine((path) => !path.includes('\0') && isAbsolute(path))
const projectName = z.string().trim().min(1).max(200)
const waitMsSchema = z.number().int().min(1).max(300_000).default(defaultWaitMs)
const references = {
  operationId: referenceId.optional(),
  correlationId: referenceId.optional(),
  kind: z.enum(['export', 'import', 'fork']).optional(),
  projectId: id.optional(),
  sessionId: id.optional(),
  destinationPath: pathSchema.optional(),
  sourcePath: pathSchema.optional(),
  targetProjectId: id.optional(),
  newProjectName: projectName.optional()
}

const lookup = (expected) => ({ action: 'get_package_operation', ...expected })
const unconfirmed = (expected, sensitiveExportDecision) => ({
  ...expected,
  completionStatus: 'unconfirmed',
  ...(expected.kind === 'export' ? { delivery: { status: 'unconfirmed' } } : {}),
  ...(sensitiveExportDecision ? { sensitiveExportDecision } : {}),
  retryable: false,
  next: [
    lookup(expected),
    {
      action: 'inspect_package_state',
      message:
        'Check the original operation and destination. Do not repeat the write automatically.'
    }
  ]
})

export const matchesPackageOperation = (snapshot, expected) => {
  if (!referenceId.safeParse(snapshot?.id).success || !snapshot.agent) return false
  return (
    (!expected.operationId || snapshot.id === expected.operationId) &&
    (!expected.correlationId || snapshot.agent.correlationId === expected.correlationId) &&
    (!expected.kind || snapshot.kind === expected.kind) &&
    (!expected.projectId || snapshot.session?.projectId === expected.projectId) &&
    (!expected.sessionId || snapshot.session?.sessionId === expected.sessionId) &&
    (!expected.destinationPath || snapshot.agent.destinationPath === expected.destinationPath) &&
    (!expected.sourcePath || snapshot.agent.sourcePath === expected.sourcePath) &&
    (!expected.targetProjectId || snapshot.importTarget?.projectId === expected.targetProjectId) &&
    (!expected.newProjectName || snapshot.importTarget?.projectName === expected.newProjectName)
  )
}

const busy = (snapshot) => ['running', 'awaiting-selection', 'cancelling'].includes(snapshot.state)

async function verifyLocalPackage(path, digest, signal) {
  if (!digest) return undefined
  const { sizeBytes, checksum: sha256 } = digest
  if (await verifyLocalFile(path, { bytes: sizeBytes, sha256 }, signal))
    return { path, sizeBytes, sha256 }
}

async function packageStatus(snapshot, expected, signal) {
  if (!matchesPackageOperation(snapshot, expected)) return unconfirmed(expected)
  const reference = {
    ...expected,
    kind: snapshot.kind,
    operationId: snapshot.id,
    correlationId: snapshot.agent.correlationId,
    ...snapshot.session,
    ...(snapshot.agent.destinationPath ? { destinationPath: snapshot.agent.destinationPath } : {}),
    ...(snapshot.agent.sourcePath ? { sourcePath: snapshot.agent.sourcePath } : {}),
    ...(snapshot.importTarget?.projectId
      ? { targetProjectId: snapshot.importTarget.projectId }
      : {}),
    ...(snapshot.importTarget?.projectName
      ? { newProjectName: snapshot.importTarget.projectName }
      : {})
  }
  const { sensitiveExportReview: review, sensitiveExportDecision: decision } = snapshot
  const status = {
    ...reference,
    ...(decision
      ? { sensitiveExportDecision: { source: decision.source, decision: decision.decision } }
      : {})
  }
  if (review && snapshot.state === 'awaiting-selection') {
    const externalReview = review.agentDetails && review.destination === reference.destinationPath
    const { expiresAt, fileDigest } = review
    return {
      ...reference,
      completionStatus: 'pending',
      code: 'package_sensitive_content',
      message: 'The Session package contains sensitive content and is waiting for review.',
      owner: 'user',
      requiresUser: true,
      retryable: false,
      ...(externalReview
        ? {
            sensitiveExportReview: {
              destinationPath: reference.destinationPath,
              expiresAt,
              fileDigest,
              ...review.agentDetails,
              actions: ['approved', 'rejected'],
              responseCapability: 'respond_export_review'
            }
          }
        : {}),
      next: externalReview
        ? [
            {
              action: 'respond_export_review',
              operationId: snapshot.id,
              destinationPath: reference.destinationPath,
              expiresAt,
              sizeBytes: fileDigest.sizeBytes,
              sha256: fileDigest.checksum,
              source: 'user_relay',
              message:
                'Present the redacted findings, file scope and destination in this conversation. Explain that approval includes flagged content. Send approved or rejected only after the user decides on this candidate.'
            }
          ]
        : [
            {
              action: 'review_sensitive_export_in_open_science',
              ...reference,
              expiresAt,
              message:
                'Review the pending package in Open-Science Desktop on the same profile, then query this operation.'
            }
          ]
    }
  }
  if (busy(snapshot)) {
    return { ...status, completionStatus: 'pending', next: [lookup(reference)] }
  }
  if (snapshot.result?.recovery || snapshot.agent.failure === 'import-unconfirmed')
    return unconfirmed(reference)
  if (snapshot.state === 'succeeded') {
    if (snapshot.kind === 'export') {
      const file =
        reference.destinationPath &&
        snapshot.result?.filePath === reference.destinationPath &&
        (await verifyLocalPackage(reference.destinationPath, snapshot.result.fileDigest, signal))
      if (!file) return unconfirmed(reference, status.sensitiveExportDecision)
      return {
        ...status,
        completionStatus: 'completed',
        delivery: { status: 'verified', file }
      }
    }
    if (snapshot.kind === 'import') {
      const imported = snapshot.result?.imported
      if (
        !imported ||
        (reference.targetProjectId && imported.projectId !== reference.targetProjectId)
      )
        return unconfirmed(reference)
      return {
        ...reference,
        completionStatus: 'completed',
        session: { ...imported, readOnly: true },
        ...(snapshot.result.packageSummary
          ? { packageSummary: snapshot.result.packageSummary }
          : {}),
        next: [
          { action: 'get_session', ...imported },
          { action: 'list_artifacts', sessionId: imported.sessionId }
        ]
      }
    }
    if (snapshot.kind === 'fork') {
      const fork = snapshot.result?.imported
      if (
        !fork ||
        !snapshot.session ||
        fork.projectId !== snapshot.session.projectId ||
        fork.sessionId === snapshot.session.sessionId
      )
        return unconfirmed(reference)
      return {
        ...reference,
        completionStatus: 'completed',
        session: { ...fork, readOnly: false },
        next: [{ action: 'get_session', ...fork }]
      }
    }
  }
  if (snapshot.state === 'cancelled')
    return {
      ...status,
      completionStatus: 'cancelled',
      retryable: false,
      ...(snapshot.agent.failure === 'export-review-expired'
        ? {
            code: 'package_export_review_expired',
            message: 'The sensitive export review expired. No file was published.'
          }
        : {})
    }
  if (snapshot.state !== 'failed') return unconfirmed(reference)
  if (snapshot.kind === 'import') {
    const failure = importFailureDetails(snapshot.agent.failure)
    return { ...reference, completionStatus: 'failed', retryable: false, ...failure }
  }
  if (snapshot.kind === 'fork') {
    const notebook = snapshot.agent.failure === 'fork-notebook-refused'
    const pendingApproval = snapshot.agent.failure === 'fork-waiting-approval'
    return {
      ...reference,
      completionStatus: 'failed',
      code: notebook
        ? 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION'
        : pendingApproval
          ? 'session_busy'
          : 'package_fork_failed',
      message: notebook
        ? 'Notebook execution in the source Session was stopped. Have the user continue the original work in Open-Science Compute before considering a Fork.'
        : pendingApproval
          ? 'The source Session still has an approval decision. Have the user review it in Open-Science.'
          : 'Open-Science could not create the Fork. Check that the source Session exists and is idle.',
      owner: notebook || pendingApproval ? 'user' : 'service',
      requiresUser: notebook || pendingApproval,
      retryable: false,
      next: [{ action: notebook ? 'continue_notebook_in_app' : 'get_session', ...snapshot.session }]
    }
  }
  if (snapshot.agent.failure === 'requires-user')
    return {
      ...reference,
      completionStatus: 'failed',
      code: 'package_sensitive_content',
      message: 'Open-Science detected sensitive content and did not publish this package.',
      owner: 'user',
      requiresUser: true,
      retryable: false,
      next: [{ action: 'review_sensitive_export_in_open_science', ...reference }]
    }
  if (snapshot.agent.failure === 'content-changed')
    return {
      ...status,
      completionStatus: 'failed',
      code: 'package_sensitive_export_changed',
      message: 'The staged package changed after review. No file was published.',
      owner: 'user',
      requiresUser: true,
      retryable: false,
      next: [lookup(reference)]
    }
  if (snapshot.agent.failure === 'destination-conflict')
    return {
      ...status,
      completionStatus: 'failed',
      code: 'package_destination_conflict',
      message: 'The export destination already exists. Choose a new .science path.',
      owner: 'agent',
      requiresUser: false,
      retryable: false,
      next: [{ action: 'choose_new_destination' }]
    }
  return {
    ...status,
    completionStatus: 'failed',
    code: 'package_export_failed',
    message:
      'Open-Science could not save the Session package. Check the source Session and the destination directory.',
    owner: 'service',
    requiresUser: false,
    retryable: false,
    next: [lookup(reference)]
  }
}

function importFailureDetails(failure) {
  if (failure === 'invalid-archive')
    return {
      code: 'package_invalid_archive',
      message:
        'The selected file is not a valid .science archive. Check or replace the source file.',
      owner: 'agent',
      requiresUser: false,
      next: [{ action: 'check_package_input' }]
    }
  if (failure === 'source-unavailable')
    return {
      code: 'package_source_unavailable',
      message:
        'The package is missing or unreadable. Check the absolute source path in this profile.',
      owner: 'agent',
      requiresUser: false,
      next: [{ action: 'check_package_input' }]
    }
  if (failure === 'requires-update')
    return {
      code: 'package_requires_update',
      message: 'The source package requires a newer version of Open-Science.',
      owner: 'deployment',
      requiresUser: true,
      next: [{ action: 'update_service' }]
    }
  return {
    code: 'package_import_failed',
    message:
      'Open-Science could not import this package. Check its contents and the selected Project.',
    owner: 'service',
    requiresUser: false,
    next: [{ action: 'inspect_package_state' }]
  }
}

async function waitForPackageOperation(client, snapshot, expected, signal) {
  while (
    matchesPackageOperation(snapshot, expected) &&
    busy(snapshot) &&
    !snapshot.sensitiveExportReview
  ) {
    await setTimeout(pollIntervalMs, undefined, { signal })
    snapshot = await client.getPackageOperation({ signal })
  }
  return packageStatus(snapshot, expected, signal)
}

async function requirePackageOperations(
  client,
  signal,
  AgentError,
  capability = serviceCapability
) {
  const { taskCapabilities } = await client.health({ signal })
  if (!Array.isArray(taskCapabilities) || !taskCapabilities.includes(capability))
    throw new AgentError('unsupported_capability', { requiresUser: true })
}

async function startPackageOperation(client, expected, waitMs, signal, start, AgentError) {
  const limit = AbortSignal.timeout(waitMs)
  const observation = signal ? AbortSignal.any([signal, limit]) : limit
  let snapshot
  try {
    snapshot = await start(observation)
  } catch (error) {
    if (error?.status === 404 || error?.code === 'invalid-command-arguments')
      throw new AgentError('unsupported_capability', { requiresUser: true })
    if ([400, 401, 403, 409].includes(error?.status)) throw error
    return { ...unconfirmed(expected), waitMs }
  }
  if (matchesPackageOperation(snapshot, expected))
    expected = { ...expected, operationId: snapshot.id }
  const result = await waitForPackageOperation(client, snapshot, expected, observation).catch(() =>
    unconfirmed(expected)
  )
  if (result.completionStatus === 'failed' || result.requiresUser)
    throw new AgentError(result.code, { ...result, waitMs })
  return { ...result, waitMs }
}

export const getAgentPackageCapabilities = (AgentError) => [
  {
    name: 'export_session',
    group: 'delivery',
    description:
      'Export an existing Session to a new local .science file. Never overwrites a path or approves sensitive content. Observe the original operation after a timeout.',
    inputSchema: z.strictObject({
      projectId: id.describe('Source Project ID.'),
      sessionId: id.describe('Source Session ID.'),
      destinationPath: pathSchema.describe(
        'Absolute path for a new .science file on the shared local filesystem. Parent directory must exist.'
      ),
      waitMs: waitMsSchema.describe(
        'Maximum time to wait for the operation and verify delivery. The operation continues after this wait.'
      )
    }),
    annotations: { ...readOnly, readOnlyHint: false, idempotentHint: false },
    exposure: { cli: true, mcp: true },
    serviceCapability,
    async handler({ projectId, sessionId, destinationPath, waitMs }, { getClient, signal }) {
      const client = await getClient()
      await requirePackageOperations(client, signal, AgentError)
      const expected = {
        kind: 'export',
        projectId,
        sessionId,
        destinationPath: normalize(destinationPath),
        correlationId: randomUUID()
      }
      return startPackageOperation(
        client,
        expected,
        waitMs,
        signal,
        (observation) =>
          client.startAgentPackageExport(
            projectId,
            sessionId,
            expected.destinationPath,
            expected.correlationId,
            { signal: observation }
          ),
        AgentError
      )
    }
  },
  {
    name: 'import_session',
    group: 'delivery',
    description:
      'Import a local .science package as read-only research history when the user requests import or inspection. An attachment alone does not request import. Never executes its Notebook or creates a Fork. Use get_package_operation after an interrupted wait.',
    inputSchema: z
      .strictObject({
        sourcePath: pathSchema.describe('Absolute path to the local .science package.'),
        targetProjectId: id
          .describe('Existing Project ID. Do not combine with newProjectName.')
          .optional(),
        newProjectName: projectName
          .describe(
            'Name of a new Project. Omit both destinations to use the package Project name in a new Project.'
          )
          .optional(),
        waitMs: waitMsSchema.describe(
          'Maximum time to observe the import. The import may finish afterward.'
        )
      })
      .refine(({ targetProjectId, newProjectName }) => !(targetProjectId && newProjectName)),
    annotations: { ...readOnly, readOnlyHint: false, idempotentHint: false },
    exposure: { cli: true, mcp: true },
    serviceCapability: importCapability,
    async handler({ sourcePath, targetProjectId, newProjectName, waitMs }, { getClient, signal }) {
      const client = await getClient()
      await requirePackageOperations(client, signal, AgentError, importCapability)
      const expected = {
        kind: 'import',
        sourcePath: normalize(sourcePath),
        correlationId: randomUUID(),
        ...(targetProjectId ? { targetProjectId } : {}),
        ...(newProjectName ? { newProjectName } : {})
      }
      const target = { projectId: targetProjectId, projectName: newProjectName }
      return startPackageOperation(
        client,
        expected,
        waitMs,
        signal,
        (observation) =>
          client.startAgentPackageImport(expected.sourcePath, target, expected.correlationId, {
            signal: observation
          }),
        AgentError
      )
    }
  },
  {
    name: 'fork_session',
    group: 'delivery',
    description:
      'Create a writable Fork of the specified Session only after the user explicitly agrees to create a copy. A request to run an imported Session is not by itself consent to Fork. Does not run research or continue a stopped Notebook.',
    inputSchema: z.strictObject({
      projectId: id.describe('Source Project ID.'),
      sessionId: id.describe('Source Session ID.'),
      waitMs: waitMsSchema.describe(
        'Maximum time to observe the Fork. The operation may finish afterward.'
      )
    }),
    annotations: { ...readOnly, readOnlyHint: false, idempotentHint: false },
    exposure: { cli: true, mcp: true },
    serviceCapability: forkCapability,
    async handler({ projectId, sessionId, waitMs }, { getClient, signal }) {
      const client = await getClient()
      await requirePackageOperations(client, signal, AgentError, forkCapability)
      const correlationId = randomUUID()
      return startPackageOperation(
        client,
        { kind: 'fork', projectId, sessionId, correlationId },
        waitMs,
        signal,
        (observation) =>
          client.startAgentPackageFork(projectId, sessionId, correlationId, {
            signal: observation
          }),
        AgentError
      )
    }
  },
  {
    name: 'respond_export_review',
    group: 'delivery',
    description:
      'Relay the user’s approval or rejection of one staged sensitive .science export. Use the original operationId, destination, size, SHA-256 and deadline returned by get_package_operation. Ask the user about this candidate; task delegation cannot approve it. Query the original operation to verify delivery.',
    inputSchema: z.strictObject({
      operationId: referenceId,
      destinationPath: pathSchema,
      expiresAt: z.number().int().positive(),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      source: z.literal('user_relay'),
      decision: z.enum(['approved', 'rejected'])
    }),
    annotations: { ...readOnly, readOnlyHint: false },
    exposure: { cli: true, mcp: true },
    serviceCapability: exportReviewCapability,
    probeOnly: true,
    async handler(request, { getClient, signal }) {
      const { operationId, destinationPath } = request
      const expected = { kind: 'export', operationId, destinationPath }
      const timeout = AbortSignal.timeout(defaultWaitMs)
      const observation = signal ? AbortSignal.any([signal, timeout]) : timeout
      const client = await getClient(observation)
      await requirePackageOperations(client, observation, AgentError, exportReviewCapability)
      try {
        const snapshot = await client.respondExportReview(request, { signal: observation })
        return await packageStatus(snapshot, expected, observation)
      } catch (error) {
        if (error?.code === 'session-package-review-unavailable')
          throw new AgentError('package_export_review_unavailable', {
            ...expected,
            owner: 'user',
            message:
              'This review expired, no longer matches the candidate, or is unavailable. Check the original operation before asking the user for another decision.',
            next: [lookup(expected)]
          })
        if (error?.code === 'session-package-operation-conflict')
          throw new AgentError('package_export_review_conflict', {
            ...expected,
            owner: 'user',
            message:
              'The original operation already has a different decision or a native confirmation in progress. Query it before continuing.',
            next: [lookup(expected)]
          })
        if (error?.status === 404)
          throw new AgentError('unsupported_capability', { ...expected, requiresUser: true })
        if ([400, 401, 403].includes(error?.status)) throw error
        return unconfirmed(expected)
      }
    }
  },
  {
    name: 'get_package_operation',
    group: 'delivery',
    description:
      'Query a package operation by its original operationId or correlationId. Additional identity fields must match. Missing or superseded evidence yields unconfirmed and does not repeat a write.',
    inputSchema: z
      .strictObject(references)
      .refine(({ operationId, correlationId }) => Boolean(operationId || correlationId)),
    annotations: readOnly,
    exposure: { cli: true, mcp: true },
    serviceCapability,
    probeOnly: true,
    async handler(expected, { getClient, signal }) {
      if (expected.destinationPath) expected.destinationPath = normalize(expected.destinationPath)
      if (expected.sourcePath) expected.sourcePath = normalize(expected.sourcePath)
      const timeout = AbortSignal.timeout(defaultWaitMs)
      const observation = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const client = await getClient()
        await requirePackageOperations(client, observation, AgentError)
        return await packageStatus(
          await client.getPackageOperation({ signal: observation }),
          expected,
          observation
        )
      } catch (error) {
        const reference = { ...expected, completionStatus: 'unconfirmed' }
        if (error instanceof AgentError || error?.status === 404)
          throw new AgentError('unsupported_capability', { ...reference, requiresUser: true })
        if ([401, 403].includes(error?.status))
          throw new AgentError('access_denied', { ...reference, requiresUser: true })
        if (error?.status === 400) throw error
        return unconfirmed(expected)
      }
    }
  }
]
