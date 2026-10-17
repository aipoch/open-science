import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createCallerContext, type CallerContext } from '../caller-context'
import type { RunObservationTarget } from '../../shared/run-observation'
import { RunObservationOwner, type RunObservationSource } from './owner'
import { ObservationViewers, type ObservationViewersDependencies } from './viewers'
import { recordedFixture, projectRecordedFixture } from './recorded-viewer.test-support'
import { recordedFileSelectionForPayload } from '../../shared/run-observation-recorded'

const target: RunObservationTarget = {
  projectId: 'project-a',
  sessionId: 'session-a',
  operationId: 'operation-a'
}
const opened: ObservationViewers[] = []
afterEach(async () => {
  for (const viewers of opened.splice(0)) await viewers.close()
  vi.useRealTimers()
})
function caller(overrides: Partial<CallerContext> = {}): CallerContext {
  return createCallerContext({
    clientId: 'client-a',
    leaseId: 'lease-a',
    lifecycleClientId: 'lifecycle-a',
    surface: 'task',
    location: 'local',
    principalKind: 'automation',
    actionOrigin: 'automation',
    ...overrides
  })
}
function source(scope: RunObservationTarget): RunObservationSource {
  return {
    identity: { ...scope, runId: 'run-a', executionInvocationId: 'invocation-a' },
    phase: 'running',
    artifacts: [],
    run: {
      runId: 'run-a',
      executionInvocationId: 'invocation-a',
      cellId: 'cell-a',
      source: 'agent',
      kernelKind: 'bash',
      script: '',
      status: 'running',
      startedAt: 100,
      text: { stdout: 'progress', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }
  }
}
function harness(
  limits?: ObservationViewersDependencies['limits'],
  recorded?: ObservationViewersDependencies['recorded']
): {
  viewers: ObservationViewers
  observer: RunObservationOwner
  caller: CallerContext
  scope: Mock<(target: RunObservationTarget) => Promise<void>>
  read: Mock<(target: RunObservationTarget) => Promise<RunObservationSource>>
  revoked: Mock<NonNullable<ObservationViewersDependencies['onRevoked']>>
  setAuthorized(value: boolean): void
  setNow(value: number): void
} {
  let now = 1000
  let authorized = true
  const scope = vi.fn<(target: RunObservationTarget) => Promise<void>>(async () => undefined)
  const read = vi.fn(async (target: RunObservationTarget): Promise<RunObservationSource> =>
    source(target)
  )
  const revoked = vi.fn<NonNullable<ObservationViewersDependencies['onRevoked']>>(
    async () => undefined
  )
  const observer: RunObservationOwner = new RunObservationOwner({
    authorize: (target, viewer) => viewers.assertViewer(target, viewer),
    read,
    now: () => now
  })
  const viewers: ObservationViewers = new ObservationViewers({
    observer,
    recorded,
    authorizeScope: scope,
    onRevoked: revoked,
    now: () => now,
    limits
  })
  opened.push(viewers)
  return {
    viewers,
    observer,
    scope,
    read,
    revoked,
    caller: caller({ isAuthorizationCurrent: () => authorized }),
    setAuthorized(value) {
      authorized = value
    },
    setNow(value) {
      now = value
    }
  }
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('ObservationViewers', () => {
  it('creates only for a current local caller and exact authorized target', async () => {
    const h = harness()
    await expect(h.viewers.create(target, caller({ location: 'remote' }))).rejects.toMatchObject({
      code: 'unsupported-location'
    })
    await expect(
      h.viewers.create(target, caller({ isAuthorizationCurrent: () => false }))
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(h.viewers.create({ projectId: 'p', sessionId: 's' }, h.caller)).rejects.toThrow()
    expect(h.scope).not.toHaveBeenCalled()
    const view = await h.viewers.create(target, h.caller)
    expect(view.target).toEqual(target)
    expect(view.grant).toMatch(/^[a-f0-9]{64}$/)
    expect(view.grantExpiresAt).toBeLessThan(view.expiresAt)
    expect((await h.viewers.snapshot(view.viewerId, { caller: h.caller })).run?.runId).toBe('run-a')
  })

  it('describes a viewer without reading execution state or exposing credentials and revalidates access', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    const browser = await h.viewers.authenticateGrant(view.grant)
    const described = await h.viewers.describe(view.viewerId, { capability: browser.capability })
    expect(described).toEqual({ viewerId: view.viewerId, target, expiresAt: view.expiresAt })
    expect(h.read).not.toHaveBeenCalled()
    h.setAuthorized(false)
    await expect(
      h.viewers.describe(view.viewerId, { capability: browser.capability })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('pins client, lease, surface and principal identities and does not revoke the real owner for an impostor', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    for (const foreign of [
      caller({ clientId: 'other' }),
      caller({ leaseId: 'other' }),
      caller({ lifecycleClientId: 'other' }),
      caller({ surface: 'web' }),
      caller({ principalKind: 'human' }),
      caller({ actionOrigin: 'human' }),
      caller({ isAuthorizationCurrent: () => false })
    ])
      await expect(h.viewers.snapshot(view.viewerId, { caller: foreign })).rejects.toMatchObject({
        code: 'unauthorized'
      })
    expect(h.read).not.toHaveBeenCalled()
    await expect(h.viewers.snapshot(view.viewerId, { caller: h.caller })).resolves.toMatchObject({
      identity: target
    })
    expect(h.revoked).not.toHaveBeenCalled()
  })

  it('exchanges grants exactly once and confines browser capability to one viewer and immutable target', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    const outcomes = await Promise.allSettled([
      h.viewers.authenticateGrant(view.grant),
      h.viewers.authenticateGrant(view.grant)
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    const fulfilled = outcomes.find((outcome) => outcome.status === 'fulfilled')!
    if (fulfilled.status !== 'fulfilled') throw new Error('No browser capability issued')
    const browser = fulfilled.value
    const other = await h.viewers.create({ ...target, sessionId: 'other-session' }, h.caller)
    expect(
      (await h.viewers.snapshot(view.viewerId, { capability: browser.capability })).identity
    ).toMatchObject(target)
    await expect(
      h.viewers.snapshot(other.viewerId, { capability: browser.capability })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      h.viewers.snapshot(view.viewerId, { capability: view.grant })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      h.observer.snapshot({ ...target, sessionId: 'other-session' }, { viewerId: view.viewerId })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('shares the browser-selected frozen step with its creating SDK caller but isolates other viewers', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    const other = await h.viewers.create(target, h.caller)
    const browser = await h.viewers.authenticateGrant(view.grant)
    const first = await h.viewers.snapshot(view.viewerId, { capability: browser.capability })
    const selected = await h.viewers.select(
      view.viewerId,
      { cursor: first.cursor, stepId: first.stepId },
      { capability: browser.capability }
    )
    expect(await h.viewers.selection(view.viewerId, { caller: h.caller })).toEqual(selected)
    expect(await h.viewers.selection(other.viewerId, { caller: h.caller })).toBeNull()
    expect(await h.viewers.history(view.viewerId, { caller: h.caller })).toMatchObject({
      snapshots: [first]
    })
    expect(
      await h.viewers.changes(view.viewerId, first.cursor, { capability: browser.capability })
    ).toMatchObject({ kind: 'delta', changes: [] })
  })

  it('rechecks the original caller when a browser capability is used and cleans up dependent views', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    const browser = await h.viewers.authenticateGrant(view.grant)
    h.setAuthorized(false)
    await expect(
      h.viewers.snapshot(view.viewerId, { capability: browser.capability })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await vi.waitFor(() =>
      expect(h.revoked).toHaveBeenCalledWith(view.viewerId, 'authorization-revoked')
    )
    h.setAuthorized(true)
    await expect(
      h.viewers.snapshot(view.viewerId, { capability: browser.capability })
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('fails closed on scope deletion without exposing repository error details', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    h.scope.mockRejectedValueOnce(new Error('/private/database/file: gone'))
    await expect(h.viewers.snapshot(view.viewerId, { caller: h.caller })).rejects.toThrow(
      'The observed research is unavailable.'
    )
    await vi.waitFor(() =>
      expect(h.revoked).toHaveBeenCalledWith(view.viewerId, 'scope-unavailable')
    )
    expect(h.read).not.toHaveBeenCalled()
  })

  it('does not return a result when original authorization is revoked during the underlying read', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    const gate = deferred<RunObservationSource>()
    h.read.mockImplementationOnce(() => gate.promise)
    const pending = h.viewers.snapshot(view.viewerId, { caller: h.caller })
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1))
    h.setAuthorized(false)
    gate.resolve(source(target))
    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    await vi.waitFor(() => expect(h.revoked).toHaveBeenCalledTimes(1))
  })

  it('expires grants independently, supports owner-only reissue, and rejects a grant expiring during authorization', async () => {
    const h = harness({ grantLifetimeMs: 100 })
    const view = await h.viewers.create(target, h.caller)
    h.setNow(1101)
    await expect(h.viewers.authenticateGrant(view.grant)).rejects.toThrow('grant has expired')
    await expect(
      h.viewers.issueGrant(view.viewerId, caller({ leaseId: 'other' }))
    ).rejects.toMatchObject({ code: 'unauthorized' })
    const replacement = await h.viewers.issueGrant(view.viewerId, h.caller)
    const gate = deferred<void>()
    h.scope.mockImplementationOnce(() => gate.promise)
    const pending = h.viewers.authenticateGrant(replacement.grant)
    h.setNow(1202)
    gate.resolve()
    await expect(pending).rejects.toThrow('grant has expired')
    const newest = await h.viewers.issueGrant(view.viewerId, h.caller)
    await expect(h.viewers.authenticateGrant(newest.grant)).resolves.toMatchObject({
      viewerId: view.viewerId
    })
  })

  it('reissuing a grant retires the old bootstrap without changing the viewer or broadening its scope', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    const replacement = await h.viewers.issueGrant(view.viewerId, h.caller)
    expect(replacement.viewerId).toBe(view.viewerId)
    expect(replacement.expiresAt).toBe(view.expiresAt)
    await expect(h.viewers.authenticateGrant(view.grant)).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect((await h.viewers.authenticateGrant(replacement.grant)).target).toEqual(target)
  })

  it('expires idle viewers automatically and revokes all outstanding browser credentials', async () => {
    vi.useFakeTimers()
    const h = harness({ lifetimeMs: 1000 })
    const view = await h.viewers.create(target, h.caller)
    const browser = await h.viewers.authenticateGrant(view.grant)
    h.setNow(2000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.revoked).toHaveBeenCalledWith(view.viewerId, 'expired')
    await expect(
      h.viewers.snapshot(view.viewerId, { capability: browser.capability })
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('bounds concurrent creations including admissions still waiting on scope authorization', async () => {
    const h = harness({ viewers: 1 })
    const gate = deferred<void>()
    h.scope.mockImplementationOnce(() => gate.promise)
    const creating = h.viewers.create(target, h.caller)
    await expect(h.viewers.create(target, h.caller)).rejects.toMatchObject({ code: 'capacity' })
    gate.resolve()
    const view = await creating
    await h.viewers.revoke(view.viewerId, { caller: h.caller })
    await expect(h.viewers.create(target, h.caller)).resolves.toMatchObject({ target })
  })

  it('rechecks authorization after create admission and keeps a denied request from consuming capacity', async () => {
    const h = harness({ viewers: 1 })
    const gate = deferred<void>()
    h.scope.mockImplementationOnce(() => gate.promise)
    const creating = h.viewers.create(target, h.caller)
    h.setAuthorized(false)
    gate.resolve()
    await expect(creating).rejects.toMatchObject({ code: 'unauthorized' })
    h.setAuthorized(true)
    await expect(h.viewers.create(target, h.caller)).resolves.toMatchObject({ target })
  })

  it('revokes synchronously before awaiting dependent-view cleanup and retries failed cleanup during close', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    const browser = await h.viewers.authenticateGrant(view.grant)
    h.revoked.mockRejectedValueOnce(new Error('dependent view close failed'))
    await expect(
      h.viewers.revoke(view.viewerId, { capability: browser.capability })
    ).rejects.toThrow('dependent view close failed')
    await expect(
      h.viewers.snapshot(view.viewerId, { capability: browser.capability })
    ).rejects.toMatchObject({ code: 'unavailable' })
    await h.viewers.close()
    expect(h.revoked).toHaveBeenCalledTimes(2)
  })

  it('shutdown invalidates grants, viewers and reads already in flight without stopping executions', async () => {
    const h = harness()
    const view = await h.viewers.create(target, h.caller)
    const gate = deferred<RunObservationSource>()
    h.read.mockImplementationOnce(() => gate.promise)
    const pending = h.viewers.snapshot(view.viewerId, { caller: h.caller })
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1))
    await h.viewers.close()
    gate.resolve(source(target))
    await expect(pending).rejects.toMatchObject({ code: 'closed' })
    await expect(h.viewers.authenticateGrant(view.grant)).rejects.toMatchObject({ code: 'closed' })
    await expect(h.viewers.create(target, h.caller)).rejects.toMatchObject({ code: 'closed' })
    expect(h.revoked).toHaveBeenCalledWith(view.viewerId, 'shutdown')
  })
})

describe('recorded viewer authority', () => {
  it('pins project-recording format to the read-only viewer capability without creating Notebook authority', async () => {
    const { payload } = projectRecordedFixture()
    const recorded = {
      authorizeScope: vi.fn(async () => undefined),
      read: vi.fn(async () => recordedFixture().payload),
      readProject: vi.fn(async () => payload),
      selectFile: vi.fn(async () => recordedFileSelectionForPayload(payload, 'export-a'))
    }
    const h = harness(undefined, recorded)
    const access = await h.viewers.createRecorded(payload.receiving, h.caller, 'project-recording')
    const browser = await h.viewers.authenticateGrant(access.grant)
    const auth = { capability: browser.capability }
    expect(await h.viewers.describe(access.viewerId, auth)).toMatchObject({
      mode: 'recorded',
      format: 'project-recording'
    })
    expect(await h.viewers.recording(access.viewerId, auth)).toEqual(payload)
    expect(await h.viewers.selectRecordingFile(access.viewerId, 'export-a', auth)).toMatchObject({
      source: 'project-recording',
      scope: 'recording',
      stepKeys: []
    })
    expect(recorded.selectFile).toHaveBeenCalledWith(
      payload.receiving,
      'export-a',
      'project-recording'
    )
    await expect(
      h.viewers.selectRecording(access.viewerId, 'invented-step', auth)
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(h.viewers.snapshot(access.viewerId, auth)).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect(recorded.read).not.toHaveBeenCalled()
    expect(h.read).not.toHaveBeenCalled()
  })
  it('keeps file Ask separate from step Ask and revalidates its exact readable Version on retrieval', async () => {
    const { payload } = recordedFixture()
    let available = true
    const recorded = {
      authorizeScope: vi.fn(async () => undefined),
      read: vi.fn(async () => structuredClone(payload)),
      selectFile: vi.fn(async () => {
        if (!available) throw new Error('Version no longer available.')
        return recordedFileSelectionForPayload(payload, 'export-a')
      })
    }
    const h = harness(undefined, recorded)
    const access = await h.viewers.createRecorded(payload.receiving, h.caller)
    const browser = await h.viewers.authenticateGrant(access.grant)
    const auth = { capability: browser.capability }
    expect(await h.viewers.recordingFileSelection(access.viewerId, auth)).toBeNull()
    const step = await h.viewers.selectRecording(access.viewerId, 'observation-0', auth)
    const selected = await h.viewers.selectRecordingFile(access.viewerId, 'export-a', auth)
    expect(selected).toMatchObject({
      kind: 'recorded-observation-file',
      resource: { versionId: 'receiver-version' }
    })
    expect(selected).not.toHaveProperty('stepKey')
    selected.resource.versionId = 'caller-mutation'
    expect(
      (await h.viewers.recordingFileSelection(access.viewerId, auth))?.resource.versionId
    ).toBe('receiver-version')
    expect(await h.viewers.recordingSelection(access.viewerId, auth)).toEqual(step)
    expect(recorded.selectFile).toHaveBeenCalledWith(payload.receiving, 'export-a')
    expect(h.read).not.toHaveBeenCalled()
    expect(h.scope).not.toHaveBeenCalled()
    available = false
    await expect(h.viewers.recordingFileSelection(access.viewerId, auth)).rejects.toThrow()
  })
  it('reads a receiving Artifact without borrowing a live Run and freezes browser-selected source evidence', async () => {
    const payload = {
      ...recordedFixture().payload,
      executionContext: {
        purpose: 'research' as const,
        profileName: 'Small baseline',
        conditionChanges: ['reduced step count']
      }
    }
    const recorded = {
      authorizeScope: vi.fn(async () => undefined),
      read: vi.fn(async () => structuredClone(payload))
    }
    const h = harness(undefined, recorded)
    const access = await h.viewers.createRecorded(payload.receiving, h.caller)
    const browser = await h.viewers.authenticateGrant(access.grant)
    const auth = { capability: browser.capability }
    expect(await h.viewers.describe(access.viewerId, auth)).toMatchObject({
      mode: 'recorded',
      target: payload.receiving
    })
    expect(await h.viewers.recording(access.viewerId, auth)).toEqual(payload)
    const selected = await h.viewers.selectRecording(access.viewerId, 'observation-0', auth)
    expect(selected.record.sourceEvidence.identity.runId).toBe('author-run')
    expect(selected.receiving.versionId).toBe('archive-version')
    expect(selected.executionContext).toEqual(payload.executionContext)
    ;(selected.executionContext!.conditionChanges as string[])[0] = 'consumer mutation'
    expect(
      (await h.viewers.recordingSelection(access.viewerId, { caller: h.caller }))?.executionContext
    ).toEqual(payload.executionContext)
    selected.record.run!.logs.stdout.text = 'consumer mutation'
    expect(
      (await h.viewers.recordingSelection(access.viewerId, { caller: h.caller }))?.record.run?.logs
        .stdout.text
    ).toBe('Actual author output')
    for (const operation of [
      () => h.viewers.snapshot(access.viewerId, auth),
      () => h.viewers.history(access.viewerId, auth),
      () => h.viewers.selection(access.viewerId, auth),
      () => h.viewers.selectRecording(access.viewerId, 'foreign-step', auth)
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'unavailable' })
    expect(h.read).not.toHaveBeenCalled()
    expect(h.scope).not.toHaveBeenCalled()
    expect(recorded.authorizeScope).toHaveBeenCalledWith(payload.receiving)
    h.setAuthorized(false)
    await expect(h.viewers.recording(access.viewerId, auth)).rejects.toMatchObject({
      code: 'unauthorized'
    })
  })

  it('rejects a changed receiving identity and checks revocation during archive read', async () => {
    const { payload } = recordedFixture()
    const recorded = {
      authorizeScope: vi.fn(async () => undefined),
      read: vi.fn(async () => structuredClone(payload))
    }
    const h = harness(undefined, recorded)
    await expect(
      h.viewers.createRecorded({ ...payload.receiving, versionId: 'other' }, h.caller)
    ).rejects.toMatchObject({ code: 'unavailable' })
    const access = await h.viewers.createRecorded(payload.receiving, h.caller)
    recorded.read.mockImplementationOnce(async () => {
      h.setAuthorized(false)
      return payload
    })
    await expect(h.viewers.recording(access.viewerId, { caller: h.caller })).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect(h.read).not.toHaveBeenCalled()
  })
})
