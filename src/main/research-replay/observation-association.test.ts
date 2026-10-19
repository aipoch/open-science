import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  createObservationAssociationReader,
  importedObservationIdentity
} from './observation-association'
import { recordedFixture } from '../run-observation/recorded-viewer.test-support'
import { researchReplayHarness } from './test-support'
import { loadReplayDocument } from '../../renderer/src/lib/replay/source'
import type { ReplayDocument, ReplayRunIndex } from '../../shared/replay'

function fixture(): {
  payload: ReturnType<typeof recordedFixture>['payload']
  document: ReplayDocument
  run: ReplayRunIndex
  owner: ReturnType<typeof createObservationAssociationReader>
  importedIdentity: Mock<() => Promise<{ runId: string }>>
  authorize: Mock<() => Promise<void>>
  read: Mock<() => Promise<ReturnType<typeof recordedFixture>['payload']>>
  h: ReturnType<typeof researchReplayHarness>
} {
  const { payload } = recordedFixture()
  const h = researchReplayHarness()
  const run: ReplayRunIndex = {
    runId: 'receiver-run',
    cellId: 'cell',
    source: 'agent',
    kernelKind: 'bash',
    status: 'completed',
    startedAt: 100,
    endedAt: 190
  }
  const document: ReplayDocument = {
    generatorVersion: 3,
    presentationVersion: 2,
    source: { ...payload.receiving, fingerprint: 'fingerprint', title: 'Research' },
    defaultBranchId: 'branch',
    issues: [],
    resources: [
      {
        ...payload.receiving,
        id: 'index',
        name: 'observations.json',
        checksum: 'a'.repeat(64),
        availability: 'recorded',
        size: 100
      }
    ],
    branches: [
      {
        id: 'branch',
        kind: 'conversation',
        durationMs: 1000,
        steps: [
          {
            id: 'step',
            branchId: 'branch',
            kind: 'notebook',
            startMs: 0,
            endMs: 1000,
            durationMs: 1000,
            runs: [run],
            activities: [],
            resourceIds: [],
            issues: [],
            evidence: []
          }
        ]
      }
    ]
  }
  const importedIdentity = vi.fn(async () => ({ runId: run.runId }))
  const authorize = vi.fn(async () => undefined)
  const read = vi.fn(async () => payload)
  const owner = createObservationAssociationReader({
    reader: h.dependencies.reader,
    read,
    authorize,
    importedIdentity
  })
  return { payload, document, run, owner, importedIdentity, authorize, read, h }
}

describe('saved observation Notebook association', () => {
  it('uses a trusted receiver mapping and returns only the exact receiving run and branch', async () => {
    const h = fixture()
    expect(await h.owner.resolve(h.document, [h.payload])).toEqual([
      {
        target: h.payload.receiving,
        recordingId: 'recording-a',
        archiveChecksum: 'a'.repeat(64),
        runId: 'receiver-run',
        branchIds: ['branch'],
        basis: 'import-receipt'
      }
    ])
    expect(h.importedIdentity).toHaveBeenCalledWith(
      h.payload.receiving,
      h.document.resources[0],
      h.payload.archive.records[0].sourceEvidence.identity
    )
  })
  it('requires exact native identity and does not need package metadata', async () => {
    const h = fixture(),
      identity = h.payload.archive.records[0].sourceEvidence.identity
    Object.assign(identity, {
      projectId: h.payload.receiving.projectId,
      sessionId: h.payload.receiving.sessionId,
      runId: h.run.runId
    })
    expect(await h.owner.resolve(h.document, [h.payload])).toMatchObject([
      { basis: 'native-identity' }
    ])
    expect(h.importedIdentity).not.toHaveBeenCalled()
  })
  it('never guesses the only run from matching timestamps or publication on a branch', async () => {
    const h = fixture()
    h.importedIdentity.mockResolvedValue(undefined as never)
    h.document.branches[0].steps[0].resourceIds = ['index']
    expect(await h.owner.resolve(h.document, [h.payload])).toEqual([])
  })
  it.each([
    'runId',
    'startedAt',
    'kernelKind',
    'endedAt',
    'status',
    'executionInvocationId'
  ] as const)('rejects conflicting %s', async (field) => {
    const h = fixture()
    if (field === 'runId') h.importedIdentity.mockResolvedValue({ runId: 'foreign-run' })
    else if (field === 'executionInvocationId') {
      h.importedIdentity.mockResolvedValue({
        runId: h.run.runId,
        executionInvocationId: 'foreign'
      } as never)
    } else Object.assign(h.run, { [field]: typeof h.run[field] === 'number' ? 999 : 'different' })
    expect(await h.owner.resolve(h.document, [h.payload])).toEqual([])
  })
  it('does not associate a foreign scope, unknown Version, unavailable receipt, or a duplicate source', async () => {
    const h = fixture()
    expect(await h.owner.resolve(h.document, [h.payload, h.payload])).toHaveLength(1)
    h.importedIdentity.mockRejectedValue(new Error('receipt unavailable'))
    expect(await h.owner.resolve(h.document, [h.payload])).toEqual([])
    h.importedIdentity.mockClear()
    h.payload.receiving.versionId = 'other-version'
    expect(await h.owner.resolve(h.document, [h.payload])).toEqual([])
    expect(h.importedIdentity).not.toHaveBeenCalled()
    h.payload.receiving.projectId = 'another-project'
    expect(await h.owner.resolve(h.document, [h.payload])).toEqual([])
  })
  it('keeps legitimate repeated branch membership while rejecting contradictory copies', async () => {
    const h = fixture()
    h.document.branches.push({ ...structuredClone(h.document.branches[0]), id: 'second' })
    expect(await h.owner.resolve(h.document, [h.payload])).toMatchObject([
      { branchIds: ['branch', 'second'] }
    ])
    h.document.branches[1].steps[0].runs[0].startedAt++
    expect(await h.owner.resolve(h.document, [h.payload])).toEqual([])
  })
  it('reauthorizes after receipt reads instead of converting revoked access to missing data', async () => {
    const h = fixture()
    h.authorize.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('revoked'))
    await expect(h.owner.resolve(h.document, [h.payload])).rejects.toThrow('revoked')
  })
  it('checks fingerprint and receiving catalog before reading renderer-supplied targets', async () => {
    const h = fixture()
    const document = await loadReplayDocument(h.h.dependencies.reader, h.h.target)
    await expect(
      h.owner.read({
        projectId: 'project',
        sourceSessionId: 'session',
        sourceFingerprint: 'stale',
        targets: []
      })
    ).rejects.toThrow('source changed')
    const result = await h.owner.read({
      projectId: 'project',
      sourceSessionId: 'session',
      sourceFingerprint: document.source.fingerprint,
      targets: [h.payload.receiving]
    })
    expect(result.bindings).toEqual([])
    expect(result.unavailableTargets).toEqual([h.payload.receiving])
    expect(h.read).not.toHaveBeenCalled()
  })
})

describe('verified imported Run identity', () => {
  const target = {
    projectId: 'receiver-project',
    sessionId: 'receiver-session',
    artifactId: 'archive',
    versionId: 'version'
  }
  const source = {
    projectId: 'author-project',
    sessionId: 'author-session',
    runId: 'author-run',
    executionInvocationId: 'invocation'
  }
  const expected = { importId: 'import', manifestChecksum: 'checksum' }
  const receipt = (): { receiptIdentity: typeof expected; identities: Record<string, string> } => ({
    receiptIdentity: { ...expected },
    identities: {
      'author-project': target.projectId,
      'author-session': target.sessionId,
      'author-run': 'receiver-run'
    }
  })
  it('maps the original Run and preserves unchanged invocation identities', () => {
    expect(importedObservationIdentity(target, source, expected, receipt())).toEqual({
      runId: 'receiver-run',
      executionInvocationId: 'invocation'
    })
  })
  it('uses a remapped invocation when the retained import recorded one', () => {
    const origin = receipt()
    Object.assign(origin.identities, { invocation: 'receiver-invocation' })
    expect(
      importedObservationIdentity(target, source, expected, origin)?.executionInvocationId
    ).toBe('receiver-invocation')
  })
  it.each(['importId', 'manifestChecksum'] as const)('refuses stale %s', (field) => {
    const origin = receipt()
    origin.receiptIdentity[field] = 'other'
    expect(importedObservationIdentity(target, source, expected, origin)).toBeUndefined()
  })
  it('refuses missing multi-hop mappings instead of guessing by run time', () => {
    const origin = receipt()
    delete (origin.identities as Record<string, string>)['author-run']
    expect(importedObservationIdentity(target, source, expected, origin)).toBeUndefined()
  })
  it('rejects a receipt from a different receiving scope', () => {
    expect(
      importedObservationIdentity({ ...target, sessionId: 'foreign' }, source, expected, receipt())
    ).toBeUndefined()
  })
  it('does not accept inherited object properties as identity mappings', () => {
    expect(
      importedObservationIdentity(target, source, expected, {
        ...receipt(),
        identities: Object.create(receipt().identities)
      })
    ).toBeUndefined()
  })
})
