import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OfflinePlanAdmission } from './offline-plan-admission'
import { demoFixture, demoSourceIdentity } from '../research-demos/fixtures.test-support'
import {
  ManagedExecutionService,
  type ManagedExecutionServiceDependencies,
  type ManagedExecutionTurnContext
} from './managed-execution-service'
import {
  createManagedExecutionTurnPort,
  managedExecutionCallSchema
} from './managed-execution-port'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const scope = { projectId: 'project', sessionId: 'ordinary' }
const selection = {
  ...scope,
  sourceSessionId: 'source',
  sourceIdentity: demoSourceIdentity,
  planVersionId: 'demo',
  requestId: 'run-offline'
}
type FixtureDependencies = ConstructorParameters<typeof OfflinePlanAdmission>[0] & {
  service: {
    runtimes: ReturnType<typeof vi.fn<ManagedExecutionService['runtimes']>>
    prepare: ReturnType<typeof vi.fn<ManagedExecutionService['prepare']>>
  }
}
async function fixture(options: Parameters<typeof demoFixture>[0] = {}): Promise<{
  dependencies: FixtureDependencies
  material: ReturnType<typeof demoFixture>
  admission: OfflinePlanAdmission
}> {
  const material = demoFixture(options)
  const dataRoot = await mkdtemp(join(tmpdir(), 'offline-plan-'))
  roots.push(dataRoot)
  const dependencies: FixtureDependencies = {
    dataRoot,
    withWritableSession: async <T>(target: typeof scope, work: () => Promise<T>) => {
      if (target.projectId !== scope.projectId || target.sessionId !== scope.sessionId)
        throw new Error('read-only target')
      return work()
    },
    materials: vi.fn(async (input: { expectedSourceIdentity?: string }) => {
      if (
        input.expectedSourceIdentity &&
        input.expectedSourceIdentity !== material.authority.source.identity
      )
        throw new Error('source changed')
      return material.authority
    }),
    service: {
      runtimes: vi.fn<ManagedExecutionService['runtimes']>(async () => material.runtimes),
      prepare: vi.fn<ManagedExecutionService['prepare']>(async () => ({
        environmentId: 'e'.repeat(64)
      }))
    }
  }
  return { dependencies, material, admission: new OfflinePlanAdmission(dependencies) }
}

it('discovers package plans in an ordinary Session without preparing, invoking a model or writing an admission', async () => {
  const f = await fixture()
  expect(await f.admission.inspect({ ...scope, sourceSessionId: 'source' })).toMatchObject({
    confinement: 'offline-project-process',
    source: { identity: demoSourceIdentity },
    plans: [
      {
        planVersionId: 'demo',
        status: 'ready',
        substitutions: f.material.demo.substitutions,
        hasProjectView: false
      }
    ]
  })
  expect(f.dependencies.service.prepare).not.toHaveBeenCalled()
  expect(await readdir(f.dependencies.dataRoot)).toEqual([])
})

it('derives the literal package command and fixed inputs, with no credential or network override', async () => {
  const f = await fixture({
    editDemo(demo) {
      demo.arguments = ['$(touch nope)', "a'b"]
    }
  })
  const prepared = await f.admission.prepare(selection)
  expect(prepared.request).toMatchObject({
    ...scope,
    environmentId: 'e'.repeat(64),
    requestId: selection.requestId,
    recordObservation: true
  })
  expect(prepared.request.command).toBe(
    "node \"$OPEN_SCIENCE_INPUT_DIR\"/'demo.mjs' '$(touch nope)' 'a'\\''b'"
  )
  expect(prepared.options).toEqual({
    inputVersionIds: ['demo'],
    demoViewing: { mode: 'process-lifetime', timeoutMs: 10000 }
  })
  expect(f.dependencies.service.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      ...scope,
      sourceSessionId: 'source',
      sourceIdentity: demoSourceIdentity,
      materials: {
        descriptorVersionId: 'descriptor',
        materialKeys: ['script'],
        materialVersions: { script: 'script' }
      }
    }),
    undefined
  )
  expect(prepared.request).not.toHaveProperty('profileId')
})

it.each([
  { profileId: 'private' },
  { command: 'anything' },
  { purpose: 'research' },
  { allowedNetworkHosts: ['example.com'] },
  { environmentId: 'e'.repeat(64) }
])('rejects caller supplied policy or command fields %j before preparation', async (extra) => {
  const f = await fixture()
  await expect(f.admission.prepare({ ...selection, ...extra })).rejects.toThrow()
  expect(f.dependencies.service.prepare).not.toHaveBeenCalled()
})

it('deduplicates concurrent and restarted preparation, even when the prior environment is now active or released', async () => {
  const f = await fixture()
  const [a, b] = await Promise.all([f.admission.prepare(selection), f.admission.prepare(selection)])
  expect(a).toEqual(b)
  expect(f.dependencies.service.prepare).toHaveBeenCalledOnce()
  f.dependencies.service.prepare.mockRejectedValue(new Error('original environment released'))
  f.dependencies.service.runtimes.mockRejectedValue(new Error('runtime list changed'))
  expect(await new OfflinePlanAdmission(f.dependencies).prepare(selection)).toEqual(a)
  await expect(f.admission.prepare({ ...selection, planVersionId: 'another' })).rejects.toThrow(
    'conflicts'
  )
  expect(f.dependencies.service.prepare).toHaveBeenCalledOnce()
})

it('retries a lost preparation response with exactly the same fixed source, runtime and request identity', async () => {
  const f = await fixture()
  f.dependencies.service.prepare.mockRejectedValueOnce(new Error('lost response'))
  await expect(f.admission.prepare(selection)).rejects.toThrow('lost response')
  await new OfflinePlanAdmission(f.dependencies).prepare(selection)
  expect(f.dependencies.service.prepare.mock.calls[0]).toEqual(
    f.dependencies.service.prepare.mock.calls[1]
  )
})

it('rejects a read-only destination and changed source before executing or preparing', async () => {
  const f = await fixture()
  await expect(f.admission.prepare({ ...selection, sessionId: 'source' })).rejects.toThrow(
    'read-only'
  )
  await expect(f.admission.prepare({ ...selection, sourceIdentity: 'wrong' })).rejects.toThrow(
    'source changed'
  )
  expect(f.dependencies.service.prepare).not.toHaveBeenCalled()
})

it('keeps required credentials and unavailable materials as blockers instead of falling back', async () => {
  const f = await fixture({
    editDescription(description) {
      description.secrets = [
        {
          key: 'key',
          environmentVariable: 'API_KEY',
          description: 'Key',
          required: true,
          planKeys: ['example']
        }
      ]
    }
  })
  expect(
    (await f.admission.inspect({ ...scope, sourceSessionId: 'source' })).plans[0]
  ).toMatchObject({ status: 'blocked', blockers: ['secrets-required'] })
  await expect(f.admission.prepare(selection)).rejects.toThrow('unavailable')
  expect(f.dependencies.service.prepare).not.toHaveBeenCalled()
})

it('does not prepare when immutable plan bytes fail their recorded hash', async () => {
  const f = await fixture()
  f.material.content.get('demo')!.bytes = Buffer.from('{}')
  await expect(f.admission.prepare(selection)).rejects.toThrow('content-mismatch')
  expect(f.dependencies.service.prepare).not.toHaveBeenCalled()
})

it('routes external admission and current-turn admission through the existing Main-only offline executor', async () => {
  const f = await fixture()
  const createSession = vi.fn()
  const service = new ManagedExecutionService({
    ...f.dependencies,
    createSession
  } as unknown as ManagedExecutionServiceDependencies)
  vi.spyOn(service, 'runtimes').mockImplementation(f.dependencies.service.runtimes)
  vi.spyOn(service, 'prepare').mockImplementation(f.dependencies.service.prepare)
  const external = vi
    .spyOn(service, 'executeDemo')
    .mockResolvedValue({ operationId: 'operation' } as Awaited<
      ReturnType<typeof service.executeDemo>
    >)
  const current = vi
    .spyOn(service, 'executeDemoInTurn')
    .mockResolvedValue({ runId: 'run' } as Awaited<ReturnType<typeof service.executeDemoInTurn>>)
  const research = vi.spyOn(service, 'execute').mockRejectedValue(new Error('wrong mode'))
  expect(await service.executeOfflinePlan(selection)).toMatchObject({
    operationId: 'operation',
    environmentId: 'e'.repeat(64)
  })
  const context = {
    ...scope,
    operationId: 'active-turn',
    provenanceContext: {
      rootFrameId: 'root',
      agentFrameId: 'root',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment',
      promptMessageId: 'prompt'
    }
  } as ManagedExecutionTurnContext
  const signal = new AbortController().signal
  expect(await service.executeOfflinePlanInTurn(selection, context, signal)).toMatchObject({
    runId: 'run',
    environmentId: 'e'.repeat(64)
  })
  expect(external).toHaveBeenCalledOnce()
  expect(current).toHaveBeenCalledWith(
    expect.objectContaining(scope),
    context,
    signal,
    expect.objectContaining({ inputVersionIds: ['demo'] })
  )
  expect(research).not.toHaveBeenCalled()
  expect(createSession).not.toHaveBeenCalled()
  await expect(
    service.executeOfflinePlanInTurn(selection, { ...context, sessionId: 'other' })
  ).rejects.toThrow('current Main Agent')
})

it('exposes both methods through the current-turn bridge and injects its scope', async () => {
  const inspectOfflinePlans = vi.fn(async () => ({ plans: [] }))
  const executeOfflinePlanInTurn = vi.fn(async () => ({ runId: 'run' }))
  const port = createManagedExecutionTurnPort({
    dataRoot: '/tmp/offline-turn-test',
    service: { inspectOfflinePlans, executeOfflinePlanInTurn }
  } as unknown as Parameters<typeof createManagedExecutionTurnPort>[0])
  const turn = {
    ...scope,
    ownerExecutionId: 'active-turn',
    artifactRunId: 'artifacts',
    artifactStorageSessionId: 'ordinary',
    workspaceCwd: '/workspace',
    invocationId: 'call',
    provenanceContext: {
      rootFrameId: 'root',
      agentFrameId: 'root',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment',
      promptMessageId: 'prompt'
    },
    signal: new AbortController().signal,
    assertActive: vi.fn()
  }
  for (const method of ['inspectOfflinePlans', 'executeOfflinePlan'] as const)
    expect(managedExecutionCallSchema.parse({ method }).method).toBe(method)
  await port.call(
    'inspectOfflinePlans',
    { sourceSessionId: 'source', projectId: 'spoof', sessionId: 'spoof' },
    turn as Parameters<typeof port.call>[2]
  )
  expect(inspectOfflinePlans).toHaveBeenCalledWith(
    { ...scope, sourceSessionId: 'source' },
    turn.signal
  )
  await port.call('executeOfflinePlan', selection, turn as Parameters<typeof port.call>[2])
  expect(executeOfflinePlanInTurn).toHaveBeenCalledWith(
    selection,
    expect.objectContaining({ ...scope, operationId: 'active-turn' }),
    turn.signal
  )
})
