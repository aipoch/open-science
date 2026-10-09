import type { ReplayDocument, ReplayResource, ReplayRunIndex } from '../../shared/replay'
import type {
  RecordedObservationPayload,
  RecordedObservationTarget
} from '../../shared/run-observation-recorded'
import {
  readObservationBindingsRequestSchema,
  type ReadObservationBindingsRequest,
  type ReadObservationBindingsResult,
  type ResearchReplayObservationBinding
} from '../../shared/research-replay-observations'
import { loadReplayDocument, type ReplayReaderApi } from '../../renderer/src/lib/replay/source'

type Scope = { projectId: string; sessionId: string }
type SourceIdentity =
  RecordedObservationPayload['archive']['records'][number]['sourceEvidence']['identity']
type ReceiptIdentity = { importId: string; manifestChecksum: string }

/** Call only after the existing package owner has admitted the exact archive Version and
 * checksum. Old working-copy exports with no source Run mapping deliberately return unknown. */
export function importedObservationIdentity(
  target: RecordedObservationTarget,
  source: SourceIdentity,
  expected: ReceiptIdentity,
  origin: { receiptIdentity: ReceiptIdentity; identities: Readonly<Record<string, string>> }
): { runId: string; executionInvocationId?: string } | undefined {
  const own = (key: string): string | undefined =>
    Object.hasOwn(origin.identities, key) ? origin.identities[key] : undefined
  if (
    origin.receiptIdentity.importId !== expected.importId ||
    origin.receiptIdentity.manifestChecksum !== expected.manifestChecksum ||
    own(source.projectId) !== target.projectId ||
    own(source.sessionId) !== target.sessionId ||
    !source.runId ||
    !own(source.runId)
  )
    return undefined
  return {
    runId: own(source.runId)!,
    ...(source.executionInvocationId
      ? { executionInvocationId: own(source.executionInvocationId) ?? source.executionInvocationId }
      : {})
  }
}
export type ObservationAssociationDependencies = {
  reader: ReplayReaderApi
  read(target: RecordedObservationTarget): Promise<RecordedObservationPayload>
  authorize(target: Scope): Promise<void>
  /** Main-only receipt lookup. It must bind the exact receiving archive before returning ids. */
  importedIdentity?(
    target: RecordedObservationTarget,
    resource: ReplayResource,
    source: SourceIdentity
  ): Promise<{ runId: string; executionInvocationId?: string } | undefined>
}

const sameTarget = (left: RecordedObservationTarget, right: RecordedObservationTarget): boolean =>
  (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).every(
    (key) => left[key] === right[key]
  )
const identityKey = (target: RecordedObservationTarget): string =>
  JSON.stringify([target.projectId, target.sessionId, target.artifactId, target.versionId])
const resourceFor = (
  document: ReplayDocument,
  target: RecordedObservationTarget
): ReplayResource | undefined => {
  if (
    target.projectId !== document.source.projectId ||
    target.sessionId !== document.source.sessionId
  )
    return undefined
  const matches = document.resources.filter(
    (resource) =>
      (resource.source ?? 'artifact') === 'artifact' &&
      resource.availability === 'recorded' &&
      resource.projectId === target.projectId &&
      resource.sessionId === target.sessionId &&
      resource.artifactId === target.artifactId &&
      resource.versionId === target.versionId
  )
  return matches.length === 1 && /^[a-f0-9]{64}$/.test(matches[0].checksum ?? '')
    ? matches[0]
    : undefined
}
const compatible = (
  payload: RecordedObservationPayload,
  run: ReplayRunIndex,
  invocation?: string
): boolean => {
  if (invocation && run.executionInvocationId !== invocation) return false
  return payload.archive.records.every(
    (record) =>
      !record.run ||
      (record.run.startedAt === run.startedAt &&
        record.run.kernelKind === run.kernelKind &&
        (record.run.endedAt === undefined || record.run.endedAt === run.endedAt) &&
        (['queued', 'running'].includes(record.run.status) || record.run.status === run.status))
  )
}

/** Associates saved bytes with existing Notebook identities; never creates a run, guesses by
 * time, or treats the synthetic ids used by the standalone observation viewer as Run ids. */
export function createObservationAssociationReader(
  dependencies: ObservationAssociationDependencies
): {
  resolve(
    document: ReplayDocument,
    payloads: readonly RecordedObservationPayload[]
  ): Promise<ResearchReplayObservationBinding[]>
  read(request: ReadObservationBindingsRequest): Promise<ReadObservationBindingsResult>
} {
  const resolve = async (
    document: ReplayDocument,
    payloads: readonly RecordedObservationPayload[]
  ): Promise<ResearchReplayObservationBinding[]> => {
    const scope = { projectId: document.source.projectId, sessionId: document.source.sessionId }
    await dependencies.authorize(scope)
    const bindings: ResearchReplayObservationBinding[] = []
    const seen = new Set<string>()
    for (const payload of payloads.slice(0, 64)) {
      const resource = resourceFor(document, payload.receiving),
        key = identityKey(payload.receiving)
      if (!resource || seen.has(key)) continue
      seen.add(key)
      const source = payload.archive.records.at(-1)?.sourceEvidence.identity
      if (!source?.runId || !payload.archive.records.some((record) => record.run)) continue
      let identity: { runId: string; executionInvocationId?: string } | undefined
      let basis: ResearchReplayObservationBinding['basis'] = 'native-identity'
      if (source.projectId === scope.projectId && source.sessionId === scope.sessionId) {
        identity = { runId: source.runId, executionInvocationId: source.executionInvocationId }
      } else {
        try {
          identity = await dependencies.importedIdentity?.(payload.receiving, resource, source)
        } catch {
          /* Optional association must not hide saved evidence. */
        }
        basis = 'import-receipt'
      }
      if (!identity) continue
      const entries = document.branches.flatMap((branch) =>
        branch.steps.flatMap((step) =>
          step.runs
            .filter((run) => run.runId === identity!.runId)
            .map((run) => ({ branchId: branch.id, run }))
        )
      )
      if (
        !entries.length ||
        entries.some(({ run }) => !compatible(payload, run, identity!.executionInvocationId))
      )
        continue
      bindings.push({
        target: { ...payload.receiving },
        recordingId: payload.archive.recordingId,
        archiveChecksum: resource.checksum!,
        runId: identity.runId,
        branchIds: [...new Set(entries.map((entry) => entry.branchId))],
        basis
      })
    }
    await dependencies.authorize(scope)
    return bindings
  }
  return {
    resolve,
    read: async (input) => {
      const request = readObservationBindingsRequestSchema.parse(input)
      const scope = { projectId: request.projectId, sessionId: request.sourceSessionId }
      await dependencies.authorize(scope)
      const document = await loadReplayDocument(dependencies.reader, scope)
      if (document.source.fingerprint !== request.sourceFingerprint)
        throw new Error('The Replay source changed.')
      const targets = [
        ...new Map(request.targets.map((target) => [identityKey(target), target])).values()
      ]
      const payloads: RecordedObservationPayload[] = []
      for (const target of targets) {
        if (!resourceFor(document, target)) continue
        try {
          const payload = await dependencies.read(target)
          if (sameTarget(payload.receiving, target)) payloads.push(payload)
        } catch {
          /* Missing observations degrade without altering the source replay. */
        }
      }
      const bindings = await resolve(document, payloads)
      await dependencies.authorize(scope)
      return {
        sourceFingerprint: document.source.fingerprint,
        bindings,
        unavailableTargets: targets.filter(
          (target) => !bindings.some((binding) => sameTarget(binding.target, target))
        )
      }
    }
  }
}
