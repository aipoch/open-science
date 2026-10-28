import { describe, expect, it, vi, type Mock } from 'vitest'
import { applyRunObservationChanges, type RunObservationTarget } from '../../shared/run-observation'
import type { NotebookRunRecord } from '../../shared/notebook'
import {
  RunObservationOwner,
  type RunObservationDependencies,
  type RunObservationSource
} from './owner'

const target: RunObservationTarget = {
  projectId: 'project-a',
  sessionId: 'session-a',
  operationId: 'operation-a'
}
const viewer = { viewerId: 'viewer-a' }
const otherViewer = { viewerId: 'viewer-b' }
function run(): NotebookRunRecord {
  return {
    runId: 'run-a',
    executionInvocationId: 'invocation-a',
    cellId: 'cell-a',
    source: 'agent',
    kernelKind: 'bash',
    script: 'secret source code',
    status: 'running',
    startedAt: 100,
    text: { stdout: 'first\n', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }
}
function harness(limits?: RunObservationDependencies['limits']): {
  owner: RunObservationOwner
  authorize: Mock<() => Promise<void>>
  read: Mock<() => Promise<RunObservationSource | undefined>>
  readonly source: RunObservationSource
  setSource(next: RunObservationSource | undefined): void
  setTime(time: number): void
} {
  let source: RunObservationSource | undefined = {
    identity: {
      ...target,
      environmentId: 'environment-a',
      executionInvocationId: 'invocation-a',
      runId: 'run-a'
    },
    phase: 'running',
    run: run(),
    artifacts: []
  }
  let now = 1000
  const authorize = vi.fn(async (): Promise<void> => undefined)
  const read = vi.fn(async () => source)
  const owner = new RunObservationOwner({ authorize, read, limits, now: () => now++ })
  return {
    owner,
    authorize,
    read,
    get source() {
      return source!
    },
    setSource(next: RunObservationSource | undefined) {
      source = next
    },
    setTime(time: number) {
      now = time
    }
  }
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RunObservationOwner', () => {
  it('retains verified demo viewing facts through snapshot, delta and exact-step selection', async () => {
    const h = harness()
    const before = await h.owner.snapshot(target, viewer)
    const demoViewing = {
      mode: 'until-stop-or-timeout' as const,
      timeoutMs: 600000,
      endReason: 'time-limit' as const
    }
    h.setSource({
      ...h.source,
      phase: 'timeout',
      run: { ...run(), status: 'timeout' },
      executionContext: {
        purpose: 'offline-demo',
        conditionChanges: [],
        demoViewing
      }
    })
    const after = applyRunObservationChanges(
      before,
      await h.owner.changes({ ...target, cursor: before.cursor }, viewer)
    )
    expect(after.executionContext?.demoViewing).toEqual(demoViewing)
    const selected = await h.owner.select(
      { ...target, cursor: after.cursor, stepId: after.stepId },
      viewer
    )
    expect(selected.snapshot.executionContext?.demoViewing).toEqual(demoViewing)
    expect(after.phase).toBe('timeout')
  })
  it('projects declared execution intent and condition differences through deltas with private redaction', async () => {
    const h = harness()
    const before = await h.owner.snapshot(target, viewer)
    expect(before.executionContext).toEqual({ purpose: 'unknown', conditionChanges: [] })
    h.setSource({
      ...h.source,
      secrets: ['private-value'],
      executionContext: {
        purpose: 'research',
        profileName: 'baseline private-value',
        conditionChanges: ['provider changed', 'data at /Users/private/source', 'private-value']
      }
    })
    const next = applyRunObservationChanges(
      before,
      await h.owner.changes({ ...target, cursor: before.cursor }, viewer)
    )
    expect(next.executionContext).toEqual({
      purpose: 'research',
      profileName: 'baseline [redacted]',
      conditionChanges: ['provider changed', 'data at [local path]', '[redacted]']
    })
    h.setSource({ ...h.source, executionContext: undefined })
    const legacy = applyRunObservationChanges(
      next,
      await h.owner.changes({ ...target, cursor: next.cursor }, viewer)
    )
    expect(legacy.executionContext?.purpose).toBe('unknown')
  })

  it('rejects unscoped or broadened targets before reading and never projects private Run fields', async () => {
    const { owner, read } = harness()
    await expect(
      owner.snapshot({ projectId: 'project-a', sessionId: 'session-a' }, viewer)
    ).rejects.toThrow()
    await expect(
      owner.snapshot({ ...target, anything: true } as RunObservationTarget, viewer)
    ).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    const snapshot = await owner.snapshot(target, viewer)
    expect(snapshot.identity.runId).toBe('run-a')
    expect(snapshot.run?.logs.stdout.text).toBe('first\n')
    expect(JSON.stringify(snapshot)).not.toContain('secret source code')
    expect(snapshot).not.toHaveProperty('script')
  })

  it('rejects foreign source, exact selector mismatch, mismatched Run, and changed execution identity', async () => {
    const h = harness()
    await h.owner.snapshot(target, viewer)
    h.setSource({
      ...h.source,
      identity: { ...h.source.identity, runId: 'run-b' },
      run: { ...run(), runId: 'run-b' }
    })
    await expect(h.owner.snapshot(target, viewer)).rejects.toMatchObject({ code: 'scope-mismatch' })
    const cases = [
      { ...h.source, identity: { ...h.source.identity, projectId: 'other' } },
      { ...h.source, identity: { ...h.source.identity, operationId: 'other' } },
      { ...h.source, run: { ...run(), executionInvocationId: 'other' } }
    ]
    for (const source of cases) {
      h.setSource(source)
      await expect(h.owner.snapshot(target, otherViewer)).rejects.toMatchObject({
        code: 'scope-mismatch'
      })
    }
  })

  it('allows an exact operation to acquire its first real Run without inventing one before admission', async () => {
    const h = harness()
    const executing = h.source
    h.setSource({ identity: target, phase: 'preparing', run: null, artifacts: [] })
    const preparing = await h.owner.snapshot(target, viewer)
    expect(preparing.run).toBeNull()
    expect(preparing.stepId).toBe('operation:operation-a')
    h.setSource(executing)
    const change = await h.owner.changes({ ...target, cursor: preparing.cursor }, viewer)
    const next = applyRunObservationChanges(preparing, change)
    expect(next.run?.runId).toBe('run-a')
    expect(next.cursor.epoch).toBe(preparing.cursor.epoch)
  })

  it('returns bounded contiguous changes, deduplicates identical reads, and resyncs expired/ahead/foreign cursors', async () => {
    const h = harness({ historySnapshots: 2 })
    const initial = await h.owner.snapshot(target, viewer)
    expect((await h.owner.snapshot(target, viewer)).cursor).toEqual(initial.cursor)
    expect(await h.owner.changes({ ...target, cursor: initial.cursor }, viewer)).toMatchObject({
      kind: 'delta',
      changes: []
    })
    h.source.run!.text.stdout += 'second\n'
    const second = applyRunObservationChanges(
      initial,
      await h.owner.changes({ ...target, cursor: initial.cursor }, viewer)
    )
    expect(second.run?.logs.stdout.text).toBe('first\nsecond\n')
    h.source.run!.text.stdout += 'third\n'
    expect(await h.owner.changes({ ...target, cursor: initial.cursor }, viewer)).toMatchObject({
      kind: 'resync',
      reason: 'cursor-expired'
    })
    expect(
      await h.owner.changes({ ...target, cursor: { ...second.cursor, sequence: 999 } }, viewer)
    ).toMatchObject({ kind: 'resync', reason: 'cursor-ahead' })
    expect(await h.owner.changes({ ...target, cursor: second.cursor }, otherViewer)).toMatchObject({
      kind: 'resync',
      reason: 'epoch-changed'
    })
    const history = await h.owner.history(target, viewer)
    expect(history).toMatchObject({ coverage: 'process-local', truncated: true })
    expect(history.snapshots).toHaveLength(2)
  })

  it('freezes exact evidence cutoff independently for every viewer and rejects borrowed/expired cursors', async () => {
    const h = harness({ historySnapshots: 2 })
    const first = await h.owner.snapshot(target, viewer)
    const other = await h.owner.snapshot(target, otherViewer)
    const selected = await h.owner.select(
      { ...target, cursor: first.cursor, stepId: first.stepId },
      viewer
    )
    await expect(
      h.owner.select({ ...target, cursor: first.cursor, stepId: first.stepId }, otherViewer)
    ).rejects.toMatchObject({ code: 'cursor-expired' })
    await expect(
      h.owner.select({ ...target, cursor: other.cursor, stepId: 'run:wrong' }, otherViewer)
    ).rejects.toMatchObject({ code: 'step-mismatch' })
    expect(await h.owner.selection(target, otherViewer)).toBeNull()
    h.source.run!.text.stdout = 'later secret result'
    h.setSource({
      ...h.source,
      artifacts: [{ versionId: 'new-output', name: 'result.json', producerRunId: 'run-a' }]
    })
    await h.owner.snapshot(target, viewer)
    h.source.run!.text.stdout += ' newer'
    await h.owner.snapshot(target, viewer)
    const stored = await h.owner.selection(target, viewer)
    expect(stored).toEqual(selected)
    expect(stored?.snapshot.run?.logs.stdout.text).toBe('first\n')
    expect(stored?.snapshot.artifacts).toEqual([])
    await expect(
      h.owner.select({ ...target, cursor: first.cursor, stepId: first.stepId }, viewer)
    ).rejects.toMatchObject({ code: 'cursor-expired' })
  })

  it('clones boundaries so callers and source readers cannot mutate retained or frozen evidence', async () => {
    const h = harness()
    const first = await h.owner.snapshot(target, viewer)
    const selection = await h.owner.select(
      { ...target, cursor: first.cursor, stepId: first.stepId },
      viewer
    )
    ;(first.run!.logs.stdout as { text: string }).text = 'client overwrite'
    ;(selection.snapshot.artifacts as unknown[]).push({ versionId: 'forged' })
    expect((await h.owner.snapshot(target, viewer)).run?.logs.stdout.text).toBe('first\n')
    expect((await h.owner.selection(target, viewer))?.snapshot.artifacts).toEqual([])
    h.source.run!.text.stdout = 'source changed'
    expect((await h.owner.selection(target, viewer))?.snapshot.run?.logs.stdout.text).toBe(
      'first\n'
    )
  })

  it('rechecks authorization after asynchronous reads and revokes cached selections on denial', async () => {
    const h = harness()
    const first = await h.owner.snapshot(target, viewer)
    await h.owner.select({ ...target, cursor: first.cursor, stepId: first.stepId }, viewer)
    const gate = deferred<RunObservationSource>()
    h.read.mockImplementationOnce(() => gate.promise)
    const pending = h.owner.snapshot(target, viewer)
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2))
    h.authorize.mockRejectedValueOnce(new Error('Viewer revoked'))
    gate.resolve(h.source)
    await expect(pending).rejects.toThrow('Viewer revoked')
    expect(await h.owner.selection(target, viewer)).toBeNull()
    const restored = await h.owner.snapshot(target, viewer)
    expect(restored.cursor.epoch).not.toBe(first.cursor.epoch)
  })

  it('rechecks shutdown after an asynchronous read and never delivers a late snapshot', async () => {
    const h = harness()
    const gate = deferred<RunObservationSource>()
    h.read.mockImplementationOnce(() => gate.promise)
    const pending = h.owner.snapshot(target, viewer)
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1))
    h.owner.close()
    gate.resolve(h.source)
    await expect(pending).rejects.toMatchObject({ code: 'closed' })
    await expect(h.owner.selection(target, viewer)).rejects.toMatchObject({ code: 'closed' })
  })

  it('serializes concurrent reads per viewer so slow earlier reads cannot overwrite newer evidence', async () => {
    const h = harness()
    const gate = deferred<RunObservationSource>()
    h.read.mockImplementationOnce(() => gate.promise)
    const first = h.owner.snapshot(target, viewer)
    const second = h.owner.snapshot(target, viewer)
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1))
    const old = structuredClone(h.source)
    h.source.run!.text.stdout = 'second state'
    gate.resolve(old)
    expect((await first).run?.logs.stdout.text).toBe('first\n')
    expect((await second).run?.logs.stdout.text).toBe('second state')
    expect((await h.owner.history(target, viewer)).snapshots).toHaveLength(2)
  })

  it('redacts assigned and echoed credentials and local paths without disclosing frozen shell context', async () => {
    const h = harness()
    h.source.run!.frozenShellContext = {
      cwd: '/custom/private-work',
      handoffDir: '/private/handoff',
      runtimeRoot: '/private/runtime',
      notebookSessionRoot: '/private/notebook',
      inputRoot: '/private/input',
      protectedDirs: [],
      environment: { SERVICE_TOKEN: 'echoed-credential', PUBLIC_SETTING: 'value' },
      timeoutMs: 100,
      platform: 'darwin'
    }
    h.source.run!.text.stdout =
      'token=token-value\nAPI_KEY="key-value"\nechoed-credential\n/custom/private-work/result.json\n/Users/person/private.txt\nC:\\Users\\person\\private.txt'
    const snapshot = await h.owner.snapshot(target, viewer)
    const output = JSON.stringify(snapshot)
    for (const privateValue of [
      'token-value',
      'key-value',
      'echoed-credential',
      '/custom/private-work',
      '/Users/person',
      'C:\\\\Users',
      'SERVICE_TOKEN',
      'frozenShellContext'
    ])
      expect(output).not.toContain(privateValue)
    expect(snapshot.run?.logs.stdout.redacted).toBe(true)
    expect(snapshot.run?.logs.stdout.text).toContain('[local path]')
  })

  it('bounds log tails and artifact counts and does not leak a credential cut at the sampling boundary', async () => {
    const h = harness({ logCharacters: 128, artifacts: 1 })
    h.source.run!.text.stdout = 'token=' + 'x'.repeat(100000)
    h.source.run!.text.stderr = 'safe\n'.repeat(1000) + 'tail'
    h.setSource({
      ...h.source,
      artifacts: [
        { versionId: 'one', name: 'one.json' },
        { versionId: 'two', name: 'two.json' }
      ]
    })
    const snapshot = await h.owner.snapshot(target, viewer)
    expect(snapshot.run?.logs.stdout).toMatchObject({ text: '', truncated: true })
    expect(snapshot.run?.logs.stderr.text.length).toBeLessThanOrEqual(128)
    expect(snapshot.run?.logs.stderr.text.endsWith('tail')).toBe(true)
    expect(snapshot.artifacts).toHaveLength(1)
    expect(snapshot.artifactsTruncated).toBe(true)
  })

  it('rejects foreign producer artifacts and invalid archive-capable checksum metadata', async () => {
    const h = harness()
    h.setSource({
      ...h.source,
      artifacts: [{ versionId: 'file', name: 'file', producerRunId: 'other-run' }]
    })
    await expect(h.owner.snapshot(target, viewer)).rejects.toMatchObject({ code: 'scope-mismatch' })
    h.setSource({
      ...h.source,
      artifacts: [{ versionId: 'file', name: 'file', checksum: 'invalid' }]
    })
    await expect(h.owner.snapshot(target, viewer)).rejects.toThrow()
  })

  it('bounds retained scopes and returns a new epoch after eviction or unavailable source', async () => {
    const h = harness({ scopes: 1 })
    const first = await h.owner.snapshot(target, viewer)
    await h.owner.snapshot(target, otherViewer)
    expect(await h.owner.changes({ ...target, cursor: first.cursor }, viewer)).toMatchObject({
      kind: 'resync',
      reason: 'epoch-changed'
    })
    const source = h.source
    h.setSource(undefined)
    await expect(h.owner.snapshot(target, viewer)).rejects.toMatchObject({ code: 'unavailable' })
    h.setSource(source)
    expect((await h.owner.snapshot(target, viewer)).cursor.epoch).not.toBe(first.cursor.epoch)
  })

  it('does not invent backward observation timestamps after a wall clock correction', async () => {
    const h = harness()
    const first = await h.owner.snapshot(target, viewer)
    h.setTime(1)
    h.source.run!.text.stdout += 'new'
    expect((await h.owner.snapshot(target, viewer)).observedAt).toBe(first.observedAt)
  })

  it('caps total cached payload even when callers request large per-scope history limits', async () => {
    const h = harness({ logCharacters: 65536, historySnapshots: 128 })
    const text = 'x'.repeat(65000)
    h.source.run!.text.stderr = text
    h.source.run!.text.traceback = text
    for (let index = 0; index < 48; index++) {
      h.source.run!.text.stdout = `${text}${index}`
      await h.owner.snapshot(target, viewer)
    }
    const result = await h.owner.history(target, viewer)
    expect(result.truncated).toBe(true)
    expect(result.snapshots.length).toBeLessThan(48)
    expect(result.snapshots.at(-1)?.run?.logs.stdout.text).toBe(`${text}47`)
    expect(JSON.stringify(result).length).toBeLessThan(8 * 1024 * 1024)
  })

  it('bounds queued reads without cancelling the underlying experiment or dropping accepted readers', async () => {
    const h = harness()
    const gate = deferred<RunObservationSource>()
    h.read.mockImplementationOnce(() => gate.promise)
    const pending = Array.from({ length: 256 }, () => h.owner.snapshot(target, viewer))
    const all = Promise.all(pending)
    await expect(h.owner.snapshot(target, viewer)).rejects.toMatchObject({ code: 'capacity' })
    gate.resolve(h.source)
    const results = await all
    expect(results).toHaveLength(256)
    expect(new Set(results.map((result) => result.cursor.sequence))).toEqual(new Set([0]))
  })

  it('pins caller target and viewer objects before awaiting authorization', async () => {
    const h = harness()
    const mutableTarget = { ...target }
    const mutableViewer = { ...viewer }
    const pending = h.owner.snapshot(mutableTarget, mutableViewer)
    mutableTarget.sessionId = 'changed-by-caller'
    mutableViewer.viewerId = 'changed-by-caller'
    expect((await pending).identity.sessionId).toBe('session-a')
    expect(h.read).toHaveBeenCalledWith(target, viewer)
  })
})
