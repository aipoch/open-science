import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ComputePythonRuntime,
  runComputePython,
  configureComputePythonRuntimes,
  computePythonRuntime
} from './compute-python-runtime'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { waitForDataRootWriters } from '../storage/migration-state'
import type { ComputeAccountProvider } from '../../shared/compute-accounts'
import type { ComputePythonSelection } from '../../shared/compute-python-runtime'
configureTestRuntimeMetadata()
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture(provider: ComputeAccountProvider = 'modal') {
  const root = await mkdtemp(join(tmpdir(), 'compute-python-runtime-'))
  roots.push(root)
  const runtimeRoot = join(root, 'runtime'),
    prefix = join(runtimeRoot, 'envs', 'default-python')
  const python = join(prefix, 'bin', 'python')
  await mkdir(join(prefix, 'bin'), { recursive: true })
  const makePython = async (path = python, ready = true, delay = ''): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(
      path,
      `#!/bin/sh\n${delay}\nif [ "$3" = "-c" ]; then\n  echo '${JSON.stringify(prefix)}'\nelse\n  echo '${JSON.stringify({ prefix, ...(ready ? { version: provider === 'modal' ? '1.6.3' : '2.4.0' } : { error: 'missing' }) })}'\nfi\n`
    )
    await chmod(path, 0o755)
  }
  await makePython()
  let saved: ComputePythonSelection | undefined
  const save = vi.fn(async (selection: ComputePythonSelection) => {
    saved = selection
  })
  const runtime = {
    assertPythonExecutionAllowed: vi.fn(async () => {}),
    withPythonExecution: vi.fn(async (_target, fn: () => Promise<unknown>) => fn()),
    managePackages: vi.fn(async () => {
      await makePython()
      return { ok: true, needsRestart: false, log: '' }
    })
  }
  const provision = vi.fn(async () => {
    await makePython()
  })
  const deps = {
    runtimeRoot: () => runtimeRoot,
    getSelection: async () => saved,
    saveSelection: save,
    listPython: vi.fn(async () => []),
    defaultReady: async () => existsSync(python),
    provision,
    runtime: runtime as ConstructorParameters<typeof ComputePythonRuntime>[0]['runtime'],
    commit: async <T>(fn: () => Promise<T>) => fn()
  }
  const owner = new ComputePythonRuntime(deps, provider)
  return { owner, deps, runtime, root, prefix, python, makePython, save, provision }
}
describe.skipIf(process.platform === 'win32').each(['modal', 'hugging-face'] as const)(
  '%s Python runtime ownership',
  (provider) => {
    it('reads candidates without checking SDK or provisioning, and saved managed overrides the old variable', async () => {
      const f = await fixture(provider)
      vi.stubEnv(
        provider === 'modal' ? 'OPEN_SCIENCE_MODAL_PYTHON' : 'OPEN_SCIENCE_HF_PYTHON',
        '/invalid/legacy/python'
      )
      expect((await f.owner.get()).selection).toEqual({
        kind: 'custom',
        pythonPath: '/invalid/legacy/python'
      })
      expect(f.runtime.withPythonExecution).not.toHaveBeenCalled()
      expect(f.provision).not.toHaveBeenCalled()
      expect(
        await f.owner.select({ operationId: 's', revision: 0, selection: { kind: 'managed' } })
      ).toEqual({ revision: 1 })
      expect((await f.owner.get()).selection).toEqual({ kind: 'managed' })
      expect((await f.owner.binding()).python).toBe(f.python)
    })
    it('installs only in default-python, holds the migration lease through the complete installer and rechecks SDK', async () => {
      const f = await fixture(provider)
      await f.makePython(f.python, false)
      const entered = deferred<void>(),
        finish = deferred<void>()
      f.runtime.managePackages.mockImplementation(async () => {
        entered.resolve()
        await finish.promise
        await f.makePython()
        return { ok: true, needsRestart: false, log: '' }
      })
      const prepared = f.owner.prepare({ operationId: 'p', revision: 0 })
      await entered.promise
      let drained = false
      const drain = waitForDataRootWriters().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      finish.resolve()
      expect((await prepared).binding.python).toBe(f.python)
      await drain
      expect(f.runtime.managePackages).toHaveBeenCalledWith(
        {
          language: 'python',
          environment: 'default-python',
          packages:
            provider === 'modal'
              ? ['modal==1.6.3', 'python-socks', 'aiohttp-socks']
              : ['huggingface_hub==2.4.0', 'socksio'],
          usePip: true
        },
        expect.any(AbortSignal)
      )
      expect(f.runtime.withPythonExecution).toHaveBeenCalledTimes(2)
    })
    it('honors installer ok=false, and rejects disabled ready runtimes without installing', async () => {
      const f = await fixture(provider)
      f.runtime.assertPythonExecutionAllowed.mockRejectedValueOnce(new Error('RUNTIME_DISABLED'))
      await expect(f.owner.prepare({ operationId: 'p', revision: 0 })).rejects.toMatchObject({
        reason: 'disabled'
      })
      expect(f.runtime.managePackages).not.toHaveBeenCalled()
      await f.makePython(f.python, false)
      f.runtime.managePackages.mockResolvedValueOnce({
        ok: false,
        needsRestart: false,
        log: 'failed'
      })
      await expect(f.owner.prepare({ operationId: 'r', revision: 0 })).rejects.toMatchObject({
        reason: 'install'
      })
    })
    it('checks custom sources without writing packages, preserving the selected executable and managed lock identity', async () => {
      const f = await fixture(provider)
      const custom = join(f.root, 'venv', 'bin', 'python')
      await f.makePython(custom)
      expect(
        await f.owner.select({
          operationId: 's',
          revision: 0,
          selection: { kind: 'custom', pythonPath: custom }
        })
      ).toEqual({ revision: 1 })
      expect(f.save).toHaveBeenCalledWith({ kind: 'custom', pythonPath: custom })
      expect(f.runtime.withPythonExecution).toHaveBeenCalledWith(
        expect.objectContaining({ python: custom, environment: 'default-python' }),
        expect.any(Function),
        expect.any(AbortSignal)
      )
      await f.makePython(custom, false)
      expect(
        await f.owner.select({
          operationId: 'bad',
          revision: 1,
          selection: { kind: 'custom', pythonPath: custom }
        })
      ).toMatchObject({ runtimeError: 'dependency' })
      expect(f.save).toHaveBeenCalledTimes(1)
      expect(f.runtime.managePackages).not.toHaveBeenCalled()
    })
    it('rejects late checks and stale bindings after a data root switch', async () => {
      const f = await fixture(provider)
      const slow = join(f.root, 'slow')
      await f.makePython(slow, true, 'sleep 0.2')
      const a = f.owner.select({
        operationId: 'a',
        revision: 0,
        selection: { kind: 'custom', pythonPath: slow }
      })
      const b = f.owner.select({ operationId: 'b', revision: 0, selection: { kind: 'managed' } })
      expect(await a).toMatchObject({ runtimeError: 'cancelled' })
      expect(await b).toEqual({ revision: 1 })
      expect(f.save).toHaveBeenCalledTimes(1)
      const binding = await f.owner.binding()
      f.deps.runtimeRoot = () => join(f.root, 'new-runtime')
      await expect(f.owner.run(binding, async () => true)).rejects.toMatchObject({
        reason: 'runtime-stale'
      })
    })
    it('cancels only the Modal wait for shared supply and never installs or authorizes afterward', async () => {
      const f = await fixture(provider)
      await rm(f.python)
      const supply = deferred<void>(),
        entered = deferred<void>()
      f.provision.mockImplementation(async () => {
        entered.resolve()
        await supply.promise
        await f.makePython()
      })
      const preparing = f.owner.prepare({ operationId: 'p', revision: 0 })
      await entered.promise
      f.owner.cancel('p')
      await expect(preparing).rejects.toMatchObject({ reason: 'cancelled' })
      supply.resolve()
      await supply.promise
      expect(f.runtime.managePackages).not.toHaveBeenCalled()
    })
    it('publishes a committed source even when cancel arrives during the settings write, and returns storage errors', async () => {
      const f = await fixture(provider)
      const entered = deferred<void>(),
        finish = deferred<void>()
      f.save.mockImplementationOnce(async () => {
        entered.resolve()
        await finish.promise
      })
      const selecting = f.owner.select({
        operationId: 's',
        revision: 0,
        selection: { kind: 'managed' }
      })
      await entered.promise
      f.owner.cancel('s')
      finish.resolve()
      expect(await selecting).toEqual({ revision: 1 })
      f.save.mockRejectedValueOnce(new Error('disk'))
      expect(
        await f.owner.select({ operationId: 'bad', revision: 1, selection: { kind: 'managed' } })
      ).toMatchObject({ revision: 1, runtimeError: 'storage' })
    })
    it('keeps the lease callback pending until an aborted child closes', async () => {
      const controller = new AbortController()
      const running = runComputePython('/bin/sh', ['-c', 'sleep 0.1'], undefined, controller.signal)
      controller.abort()
      await expect(running).rejects.toBeDefined()
    })
  }
)

it.skipIf(process.platform === 'win32')(
  'rejects an obsolete connection before it can cancel the current runtime operation',
  async () => {
    const f = await fixture()
    await f.owner.select({ operationId: 'selection', revision: 0, selection: { kind: 'managed' } })
    const current = { operationId: 'current', revision: 1 }
    const prepared = await f.owner.prepare(current)
    await expect(
      f.owner.prepare({ operationId: 'late-old-request', revision: 0 })
    ).rejects.toMatchObject({ reason: 'runtime-stale' })
    expect(prepared.signal.aborted).toBe(false)
    expect(() => f.owner.assertCurrent(current)).not.toThrow()
  }
)

it.skipIf(process.platform === 'win32')(
  'reports managed supply failures as preparation failures while preserving runtime policy reasons',
  async () => {
    const f = await fixture()
    await rm(f.python)
    f.provision.mockRejectedValueOnce(new Error('download failed'))
    await expect(
      f.owner.prepare({ operationId: 'failed-supply', revision: 0 })
    ).rejects.toMatchObject({ reason: 'install' })
    f.runtime.assertPythonExecutionAllowed.mockRejectedValueOnce(
      new Error('The runtime is disabled')
    )
    await expect(f.owner.prepare({ operationId: 'disabled', revision: 0 })).rejects.toMatchObject({
      reason: 'disabled'
    })
  }
)

it.skipIf(process.platform === 'win32')(
  'waits for cancelled installer settlement before retry and rejects its late success',
  async () => {
    const f = await fixture()
    await f.makePython(f.python, false)
    const entered = deferred<void>(),
      settled = deferred<void>()
    f.runtime.managePackages.mockImplementationOnce(async () => {
      entered.resolve()
      await settled.promise
      await f.makePython()
      return { ok: true, needsRestart: false, log: '' }
    })
    const old = f.owner.prepare({ operationId: 'old-install', revision: 0 })
    await entered.promise
    f.owner.cancel('old-install')
    const rejected = expect(old).rejects.toMatchObject({ reason: 'cancelled' })
    let retried = false
    const retry = f.owner.prepare({ operationId: 'retry-install', revision: 0 }).then((result) => {
      retried = true
      return result
    })
    await Promise.resolve()
    expect(retried).toBe(false)
    expect(f.runtime.managePackages).toHaveBeenCalledOnce()
    settled.resolve()
    await rejected
    expect((await retry).binding.python).toBe(f.python)
    expect(f.runtime.managePackages).toHaveBeenCalledOnce()
  }
)

it.skipIf(process.platform === 'win32')(
  'pairs source and revision when reading candidates overlaps a source commit',
  async () => {
    const f = await fixture()
    const entered = deferred<void>(),
      oldRead = deferred<ComputePythonSelection | undefined>()
    const originalRead = f.deps.getSelection
    let first = true
    f.deps.getSelection = async () => {
      if (!first) return originalRead()
      first = false
      entered.resolve()
      return oldRead.promise
    }
    const getting = f.owner.get()
    await entered.promise
    await f.owner.select({ operationId: 'new-source', revision: 0, selection: { kind: 'managed' } })
    oldRead.resolve({ kind: 'custom', pythonPath: '/old/python' })
    expect(await getting).toMatchObject({ selection: { kind: 'managed' }, revision: 1 })
  }
)

it.skipIf(process.platform === 'win32')(
  'keeps provider selection, revision and cancellation independent even with equal operation IDs',
  async () => {
    const f = await fixture()
    const selections = new Map<ComputeAccountProvider, ComputePythonSelection>()
    configureComputePythonRuntimes({
      ...f.deps,
      getSelection: async (provider) => selections.get(provider),
      saveSelection: async (provider, selection) => {
        selections.set(provider, selection)
      },
      commit: (_provider, operation) => operation()
    })
    const modal = computePythonRuntime('modal')
    const hf = computePythonRuntime('hugging-face')
    expect(
      await hf.select({ operationId: 'same-id', revision: 0, selection: { kind: 'managed' } })
    ).toEqual({ revision: 1 })
    expect((await modal.get()).revision).toBe(0)
    expect(selections.has('modal')).toBe(false)
    expect(selections.get('hugging-face')).toEqual({ kind: 'managed' })
    const ready = await modal.prepare({ operationId: 'same-id', revision: 0 })
    expect(hf.cancel('same-id')).toBe(true)
    expect(ready.signal.aborted).toBe(false)
    expect(() => modal.assertCurrent({ operationId: 'same-id', revision: 0 })).not.toThrow()
  }
)
