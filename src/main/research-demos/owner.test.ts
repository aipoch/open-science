import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createResearchMaterialInspectionAuthority,
  type ResearchMaterialAuthorityDependencies
} from '../notebook/research-material-authority'
import { ResearchDemoOwner, type ResearchDemoService } from './owner'
import { demoFixture, demoSource, demoSourceIdentity } from './fixtures.test-support'
import { createElectronCallerContext } from '../caller-context'
import type { RunObservationSelection } from '../../shared/run-observation'

vi.mock('../notebook/research-material-authority', () => ({
  createResearchMaterialInspectionAuthority: vi.fn()
}))
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.clearAllMocks()
})

type FixtureService = {
  [K in keyof ResearchDemoService]: ReturnType<typeof vi.fn<ResearchDemoService[K]>>
}
type FixtureDependencies = ConstructorParameters<typeof ResearchDemoOwner>[0] & {
  sessionExists: ReturnType<
    typeof vi.fn<(projectId: string, sessionId: string) => Promise<boolean>>
  >
  assertOpen: ReturnType<typeof vi.fn>
  readSelection: ReturnType<
    typeof vi.fn<(viewerId: string) => Promise<RunObservationSelection | null>>
  >
}
type Fixture = {
  owner: ResearchDemoOwner
  service: FixtureService
  request: typeof demoSource & {
    expectedSourceIdentity: string
    demoVersionId: string
    requestId: string
  }
  materials: ReturnType<typeof demoFixture>
  dependencies: FixtureDependencies
  setStatus(next: string): void
}
async function fixture(options: Parameters<typeof demoFixture>[0] = {}): Promise<Fixture> {
  const materials = demoFixture(options)
  vi.mocked(createResearchMaterialInspectionAuthority).mockResolvedValue(materials.authority)
  const dataRoot = await mkdtemp(join(tmpdir(), 'research-demo-owner-'))
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }))
  let status = 'running'
  let created = false
  const snapshot = (): {
    projectId: string
    sessionId: string
    requestId: string
    operationId: string
    status: string
  } => ({
    projectId: 'project',
    sessionId: 'carrier',
    requestId: 'demo-execute-start-1',
    operationId: 'operation',
    status
  })
  const service = {
    runtimes: vi.fn(async () => materials.runtimes),
    createSession: vi.fn(async () => {
      created = true
      return { projectId: 'project', sessionId: 'carrier' }
    }),
    prepare: vi.fn(async () => ({ environmentId: 'e'.repeat(64) })),
    executeDemo: vi.fn(async () => snapshot()),
    getOperation: vi.fn(async () => snapshot()),
    waitOperation: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return snapshot()
    }),
    cancelOperation: vi.fn(async () => {
      status = 'cancelled'
      return snapshot()
    }),
    releaseEnvironment: vi.fn(async () => ({ state: 'released' })),
    inspectExecution: vi.fn(async () => ({
      identity: {
        projectId: 'project',
        sessionId: 'carrier',
        operationId: 'operation',
        executionInvocationId: 'managed-' + '1'.repeat(64),
        runId: 'run'
      },
      run: { runId: 'run', ...(status === 'completed' ? { endedAt: Date.now() } : {}) }
    })),
    recordingStatus: vi.fn(async () =>
      status === 'completed'
        ? {
            state: 'saved',
            archive: {
              projectId: 'project',
              sessionId: 'carrier',
              artifactId: 'archive',
              versionId: 'recording'
            }
          }
        : { state: 'recording' }
    )
  }
  const dependencies = {
    dataRoot,
    service: service as unknown as ResearchDemoService,
    materials: {} as ResearchMaterialAuthorityDependencies,
    sessionExists: vi.fn(async () => created),
    assertOpen: vi.fn(),
    readSelection: vi.fn(async (): Promise<RunObservationSelection | null> => null)
  }
  const owner = new ResearchDemoOwner(dependencies)
  cleanups.push(() => owner.close())
  const request = {
    ...demoSource,
    expectedSourceIdentity: demoSourceIdentity,
    demoVersionId: 'demo',
    requestId: 'start-1'
  }
  return {
    owner,
    service: service as unknown as FixtureService,
    request,
    materials,
    dependencies: dependencies as FixtureDependencies,
    setStatus: (next: string) => {
      status = next
    }
  }
}

describe('Replay demo orchestration', () => {
  it('reads old history without refreshing a run or recovering/cleaning journal files', async () => {
    const f = await fixture()
    f.setStatus('completed')
    await f.owner.start(f.request)
    await vi.waitFor(() => expect(f.service.releaseEnvironment).toHaveBeenCalledOnce())
    const directory = join(f.dependencies.dataRoot, 'research-demos', 'runs')
    const name = (await readdir(directory)).find((name) => name.endsWith('.json'))!
    const path = join(directory, name)
    const before = await readFile(path, 'utf8')
    const orphan = path + '.999999999.tmp'
    await writeFile(orphan, before)
    for (const method of [
      'getOperation',
      'inspectExecution',
      'recordingStatus',
      'prepare',
      'executeDemo',
      'createSession'
    ] as const)
      f.service[method].mockClear()
    f.setStatus('failed')
    const history = await f.owner.readHistory(demoSource)
    const receipt = await f.owner.readReceipt({ ...demoSource, requestId: f.request.requestId })
    expect(history.receipts).toEqual([receipt])
    expect(receipt).toMatchObject({
      source: demoSource,
      sessionId: 'carrier',
      state: 'completed',
      purpose: 'offline-demo'
    })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await readFile(orphan, 'utf8')).toBe(before)
    for (const method of [
      'getOperation',
      'inspectExecution',
      'recordingStatus',
      'prepare',
      'executeDemo',
      'createSession'
    ] as const)
      expect(f.service[method]).not.toHaveBeenCalled()
  })

  it('retains the verified viewing budget in the receipt and only passes it through the Main demo entry', async () => {
    const f = await fixture({
      editDemo: (demo) => {
        demo.localServicePort = 4173
        demo.projectView = { title: 'Project' }
        demo.viewing = { mode: 'until-stop-or-timeout' }
      }
    })
    expect(await f.owner.start(f.request)).toMatchObject({
      demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 10000 }
    })
    await vi.waitFor(() => expect(f.service.executeDemo).toHaveBeenCalledOnce())
    expect(f.service.executeDemo).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 10000, projectView: { title: 'Project' } }),
      {
        inputVersionIds: ['demo'],
        demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 10000 }
      }
    )
    expect(await f.owner.get({ ...demoSource, requestId: f.request.requestId })).toMatchObject({
      demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 10000 }
    })
  })
  it('inspection creates no Session, environment or execution', async () => {
    const f = await fixture()
    expect((await f.owner.inspect(demoSource)).candidates[0].status).toBe('ready')
    expect(f.service.createSession).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.service.executeDemo).not.toHaveBeenCalled()
  })
  it('starts exactly one ordinary operation and restores the same receipt on duplicate requests', async () => {
    const f = await fixture()
    const [a, b] = await Promise.all([f.owner.start(f.request), f.owner.start(f.request)])
    expect(a.requestId).toBe(b.requestId)
    await vi.waitFor(() => expect(f.service.executeDemo).toHaveBeenCalledTimes(1))
    expect(f.service.executeDemo).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'carrier',
        recordObservation: true,
        command: 'node "$OPEN_SCIENCE_INPUT_DIR"/\'demo.mjs\''
      }),
      { inputVersionIds: ['demo'], demoViewing: { mode: 'process-lifetime', timeoutMs: 10000 } }
    )
    expect(await f.owner.carriers({ projectId: 'project' })).toEqual([
      { sessionId: 'carrier', source: demoSource }
    ])
    await expect(f.owner.start({ ...f.request, requestId: 'start-2' })).rejects.toThrow(
      'already-running'
    )
    f.setStatus('completed')
    await vi.waitFor(async () =>
      expect((await f.owner.get({ ...demoSource, requestId: 'start-1' })).state).toBe('completed')
    )
    await vi.waitFor(() => expect(f.service.releaseEnvironment).toHaveBeenCalledTimes(1))
    const restarted = new ResearchDemoOwner(f.dependencies)
    expect((await restarted.start(f.request)).recordingTarget?.versionId).toBe('recording')
    expect(f.service.executeDemo).toHaveBeenCalledTimes(1)
    await restarted.close()
  })
  it('rejects a reused request with another source identity or demo', async () => {
    const f = await fixture()
    await f.owner.start(f.request)
    await expect(f.owner.start({ ...f.request, demoVersionId: 'different' })).rejects.toThrow(
      'request-conflict'
    )
  })
  it('cancels the exact operation, keeps its history and does not dispatch again', async () => {
    const f = await fixture()
    await f.owner.start(f.request)
    await vi.waitFor(() => expect(f.service.executeDemo).toHaveBeenCalledTimes(1))
    await f.owner.stop({ ...demoSource, requestId: 'start-1' })
    await vi.waitFor(async () =>
      expect((await f.owner.list(demoSource)).receipts[0].state).toBe('cancelled')
    )
    expect(f.service.cancelOperation).toHaveBeenCalledWith({
      projectId: 'project',
      sessionId: 'carrier',
      requestId: expect.stringMatching(/^demo-execute-[a-f0-9]{64}$/)
    })
    await f.owner.start(f.request)
    expect(f.service.executeDemo).toHaveBeenCalledTimes(1)
  })
  it('does not dispatch when the initiating renderer loses authority before admission', async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(f.owner.start(f.request, controller.signal)).rejects.toThrow()
    expect(f.service.executeDemo).not.toHaveBeenCalled()
    expect(f.service.createSession).not.toHaveBeenCalled()
  })
  it('asks about the actual selected carrier operation without rewriting its evidence identity', async () => {
    const f = await fixture()
    await f.owner.start(f.request)
    await vi.waitFor(async () =>
      expect((await f.owner.get({ ...demoSource, requestId: 'start-1' })).runTarget).toBeDefined()
    )
    const identity = { projectId: 'project', sessionId: 'carrier', operationId: 'operation' }
    const cursor = { epoch: 'epoch', sequence: 1 }
    const selection: RunObservationSelection = {
      selectionId: 'selected',
      identity,
      cursor,
      stepId: 'step',
      selectedAt: 1,
      snapshot: {
        identity,
        cursor,
        observedAt: 1,
        phase: 'running',
        stepId: 'step',
        run: null,
        artifacts: [],
        artifactsTruncated: false
      }
    }
    f.dependencies.readSelection.mockResolvedValue(selection)
    const request = {
      ...demoSource,
      requestId: 'start-1',
      viewerId: 'a53dd6a8-6dc2-4464-a5f8-4ea635c02936',
      selectionId: 'selected',
      destinationSessionId: 'discussion'
    }
    const answer = await f.owner.question(request, createElectronCallerContext(1))
    expect(answer).toMatchObject({
      purpose: 'offline-demo',
      destination: { projectId: 'project', sessionId: 'discussion' },
      selection: { identity }
    })
    f.dependencies.readSelection.mockResolvedValue({
      ...selection,
      identity: { ...identity, sessionId: 'unrelated' }
    })
    await expect(f.owner.question(request, createElectronCallerContext(1))).rejects.toThrow(
      'selection-unavailable'
    )
  })
})

const sourceDigest = createHash('sha256')
  .update(
    JSON.stringify([demoSource.projectId, demoSource.sourceSessionId, demoSource.sourceImportId])
  )
  .digest('hex')
async function seedCarrier(f: Fixture): Promise<string> {
  const directory = join(f.dependencies.dataRoot, 'research-demos', 'carriers')
  await mkdir(directory, { recursive: true })
  const path = join(directory, sourceDigest + '.json')
  await writeFile(
    path,
    JSON.stringify({ schemaVersion: 1, key: sourceDigest, source: demoSource, generation: 0 })
  )
  return path
}

it('joins queued admission during source deletion before creating a Session', async () => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.mocked(createResearchMaterialInspectionAuthority).mockImplementationOnce(async () => {
    await gate
    return f.materials.authority
  })
  const first = f.owner.start(f.request)
  const second = f.owner.start({ ...f.request, requestId: 'start-2' })
  const outcomes = Promise.allSettled([first, second])
  await vi.waitFor(() => expect(createResearchMaterialInspectionAuthority).toHaveBeenCalled())
  let drained = false
  const stopping = f.owner
    .stopScope({ projectId: demoSource.projectId, sessionId: demoSource.sourceSessionId })
    .then(() => {
      drained = true
    })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(drained).toBe(false)
  release()
  await stopping
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true)
  expect(f.service.createSession).not.toHaveBeenCalled()
})

it('passes cancellation into prepare and releases a committed environment after its reply is lost', async () => {
  const f = await fixture()
  f.dependencies.findPreparedEnvironment = vi.fn(async () => ({ environmentId: 'e'.repeat(64) }))
  f.service.prepare.mockImplementation(async (_request, signal) => {
    if (!signal) throw new Error('prepare must receive the owner signal')
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
    return undefined
  })
  await f.owner.start(f.request)
  await vi.waitFor(() => expect(f.service.prepare).toHaveBeenCalledTimes(1))
  await f.owner.stopScope({ projectId: demoSource.projectId, sessionId: 'carrier' })
  expect(f.service.releaseEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId: 'e'.repeat(64) })
  )
  expect(f.service.executeDemo).not.toHaveBeenCalled()
  expect((await f.owner.get({ ...demoSource, requestId: f.request.requestId })).state).toBe(
    'cancelled'
  )
})

it('retains cleanup-pending across refresh and blocks another demo until recovery verifies release', async () => {
  const f = await fixture()
  f.service.releaseEnvironment.mockResolvedValue({ state: 'cleanup-pending' })
  await f.owner.start(f.request)
  await vi.waitFor(() => expect(f.service.executeDemo).toHaveBeenCalled())
  f.setStatus('completed')
  await vi.waitFor(async () =>
    expect((await f.owner.get({ ...demoSource, requestId: f.request.requestId })).state).toBe(
      'recovery-pending'
    )
  )
  expect((await f.owner.list(demoSource)).receipts[0].state).toBe('recovery-pending')
  await expect(f.owner.start({ ...f.request, requestId: 'start-2' })).rejects.toThrow(
    'already-running'
  )
  f.service.releaseEnvironment.mockResolvedValue({ state: 'released' })
  await f.owner.recover()
  expect((await f.owner.get({ ...demoSource, requestId: f.request.requestId })).state).toBe(
    'completed'
  )
  expect(f.service.executeDemo).toHaveBeenCalledTimes(1)
})

it('tracks owner reads that refresh journals and background launch through its final cleanup', async () => {
  const f = await fixture()
  const writes = new Set<Promise<unknown>>()
  f.dependencies.track = async <T>(work: () => Promise<T>): Promise<T> => {
    const pending = Promise.resolve().then(work)
    writes.add(pending)
    try {
      return await pending
    } finally {
      writes.delete(pending)
    }
  }
  await f.owner.start(f.request)
  await vi.waitFor(() => expect(f.service.executeDemo).toHaveBeenCalled())
  expect(writes.size).toBeGreaterThan(0)
  let release!: () => void
  f.service.releaseEnvironment.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { state: 'released' }
  })
  const stopping = f.owner.stopScope()
  await vi.waitFor(() => expect(release).toBeDefined())
  expect(writes.size).toBeGreaterThan(0)
  release()
  await stopping
  expect(writes.size).toBe(0)
})

it('reconciles a committed carrier before the owner journal reply without creating an unstarted intent', async () => {
  const f = await fixture()
  const path = await seedCarrier(f)
  f.dependencies.findCarrierSession = vi.fn(async () => ({
    projectId: 'project',
    sessionId: 'existing-carrier',
    state: 'available' as const
  }))
  f.dependencies.onCarrierCreated = vi.fn(async () => undefined)
  f.dependencies.sessionExists.mockResolvedValue(true)
  await f.owner.recover()
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
    sessionId: 'existing-carrier',
    generation: 0
  })
  expect(f.dependencies.onCarrierCreated).toHaveBeenCalledWith('project', 'existing-carrier')
  expect(f.service.createSession).not.toHaveBeenCalled()
  expect(f.service.prepare).not.toHaveBeenCalled()
  expect(await f.owner.carriers({ projectId: 'project' })).toEqual([
    { sessionId: 'existing-carrier', source: demoSource }
  ])
  expect(await readdir(join(f.dependencies.dataRoot, 'research-demos'))).toEqual(['carriers'])
})

it('never resurrects deleted carrier receipts or creates a missing carrier during recovery', async () => {
  const f = await fixture()
  const path = await seedCarrier(f)
  f.dependencies.findCarrierSession = vi.fn(async () => ({
    projectId: 'project',
    sessionId: 'deleted',
    state: 'missing' as const
  }))
  await f.owner.recover()
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ generation: 1 })
  f.dependencies.findCarrierSession = vi.fn(async () => undefined)
  await f.owner.recover()
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ generation: 1 })
  expect(f.service.createSession).not.toHaveBeenCalled()
  expect(f.service.prepare).not.toHaveBeenCalled()
})
