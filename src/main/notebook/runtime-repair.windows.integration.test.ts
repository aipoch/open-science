import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createWindowsPythonFixture,
  type WindowsPythonFixture
} from './windows-python.test-support'
import type { NotebookRuntimeBindings } from '../../shared/notebook-runtime'
import type { ProvisionProgress } from '../../shared/notebook-env'
import type { NotebookRunDocument } from '../../shared/notebook'
import { createNotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import { createRootNotebookLane } from './lane-identity'
import { DefaultRuntimeProvisioner } from './provisioner'
import { verifyExecutable } from './provisioner-runtime'
import { NotebookRuntimeBindingOwner } from './runtime-binding'
import {
  DEFAULT_PY_ENV,
  envPrefix,
  pythonBin,
  readReadyMarker,
  readRepairRequiredReason
} from './runtime-paths'
import { NotebookRuntimeRepairOwner } from './runtime-repair'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import { NotebookSessionAggregate } from './session-aggregate'

// Real Windows, Python launchers, provisioning verification and default discovery are required.
// Only package acquisition/materialization and Notebook repository persistence use test boundaries.
describe.skipIf(process.platform !== 'win32')('Windows managed Python repair and binding', () => {
  let fixture: WindowsPythonFixture

  beforeAll(async () => {
    fixture = await createWindowsPythonFixture()
  }, 60_000)

  afterAll(async () => {
    await fixture?.cleanup()
  })

  function harness(
    name: string,
    options: {
      brokenMaterialization?: boolean
      breakAfterVerify?: boolean
      failPersistence?: boolean
      manualTemplate?: boolean
    } = {}
  ): {
    lifecycle: ReturnType<typeof createNotebookEnvironmentLifecycle>
    session: NotebookSessionAggregate
    interpreter: string
    runtimeRoot: string
    policy: NotebookRuntimeRepairPolicy
    progress: ProvisionProgress[]
    repairBlocks: Set<string>
    order: string[]
    persisted: () => NotebookRuntimeBindings
  } {
    const dataRoot = join(fixture.root, name)
    const runtimeRoot = join(dataRoot, 'runtime')
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const interpreter = pythonBin(prefix)
    const template = join(prefix, 'Lib', 'venv', 'scripts', 'nt', 'python.exe')
    const materializeTemplate = (): void => {
      if (!options.manualTemplate) return
      mkdirSync(dirname(template), { recursive: true })
      copyFileSync(fixture.interpreters.plain, template)
    }
    const lockPath = join(dataRoot, 'fixture.lock')
    const persistedPath = join(dataRoot, 'runtime-bindings.json')
    mkdirSync(prefix, { recursive: true })
    copyFileSync(fixture.brokenInterpreter, interpreter)
    materializeTemplate()
    writeFileSync(lockPath, '@EXPLICIT\n')
    const policy = new NotebookRuntimeRepairPolicy(runtimeRoot)
    const progress: ProvisionProgress[] = []
    const repairBlocks = new Set<string>()
    const order: string[] = []
    const session = new NotebookSessionAggregate({
      sessionId: 'session',
      projectId: 'project',
      lane: createRootNotebookLane('project', 'session', 'root-frame'),
      cwd: dataRoot,
      notebookSessionRoot: dataRoot,
      dataRoot,
      runtimeRoot,
      runJsonPath: join(dataRoot, 'run.json'),
      executionCount: 0,
      executorGeneration: Symbol('repair'),
      executor: {
        execute: async () => ({
          status: 'completed' as const,
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: dataRoot,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        terminate: async () => undefined
      }
    })
    session.setRuntimeBinding('python', {
      language: 'python',
      runtimeId: interpreter,
      source: 'managed',
      provenance: 'app-managed',
      interpreterPath: interpreter,
      label: 'Old managed Python',
      envName: DEFAULT_PY_ENV,
      status: 'active'
    })
    const bindings = new NotebookRuntimeBindingOwner({
      dataRoot,
      repository: {
        findExisting: vi.fn(),
        setRuntimeBindings: async (_projectId, _sessionId, snapshot) => {
          if (snapshot.python?.status === 'active') {
            expect(readRepairRequiredReason(runtimeRoot, DEFAULT_PY_ENV)).toBe(
              'protected-identity-change'
            )
            if (options.failPersistence) throw new Error('binding persistence denied')
            order.push('binding-persisted')
          }
          const document: NotebookRunDocument = {
            version: 1,
            projectId: _projectId,
            sessionId: _sessionId,
            workspaceCwd: dataRoot,
            notebookSessionRoot: dataRoot,
            dataRoot,
            kernel: { kernelName: 'python3', runtimeRoot, lastKnownStatus: 'idle' },
            runs: [],
            updatedAt: Date.now(),
            runtimeBindings: snapshot
          }
          writeFileSync(persistedPath, JSON.stringify(document))
          return document
        }
      },
      runtimeSettings: {
        getSnapshot: async (language) => ({
          language,
          manualInterpreters: options.manualTemplate ? [template] : [],
          runtimeEnablement: { enabled: {}, installAuthorized: {} },
          packageMirror: {}
        })
      },
      repairPolicy: policy
    })
    const repairs = new NotebookRuntimeRepairOwner({
      runtimeRoot,
      policy,
      bindings,
      environmentOperations: {
        blockRepair: (key) => {
          repairBlocks.add(key)
        },
        clearRepair: (key) => {
          repairBlocks.delete(key)
        }
      },
      sessions: () => [session],
      isCurrentSession: (candidate) => candidate === session,
      clearKernelTermination: async () => undefined,
      notifyChanged: () => undefined
    })
    const provisioner = new DefaultRuntimeProvisioner({
      root: runtimeRoot,
      mm: '/unused-micromamba',
      channel: 'conda-forge',
      fetchBundle: async () => ({ lockPath }),
      runArgv: async () => {
        expect(session.runtimeBinding('python')).toMatchObject({
          status: 'unavailable',
          reason: 'repair-required'
        })
        if (options.brokenMaterialization) {
          mkdirSync(prefix, { recursive: true })
          copyFileSync(fixture.brokenInterpreter, interpreter)
          return
        }
        // A real venv launcher and its real pyvenv.cfg model a materialized managed interpreter.
        const venv = dirname(dirname(fixture.interpreters.plain))
        cpSync(venv, prefix, { recursive: true })
        copyFileSync(fixture.interpreters.plain, interpreter)
        materializeTemplate()
      },
      verify: async (bin, expectedPrefix) => {
        await verifyExecutable(bin, { prefix: expectedPrefix })
        order.push('interpreter-verified')
        if (options.breakAfterVerify) {
          // Windows can briefly retain the executable mapping after process completion. Wait only
          // while arranging this corrupt-file fixture, before exercising post-verification discovery.
          await vi.waitFor(() => copyFileSync(fixture.brokenInterpreter, bin), {
            timeout: 5_000,
            interval: 50
          })
        }
      }
    })
    const lifecycle = createNotebookEnvironmentLifecycle({
      provisioner,
      root: runtimeRoot,
      projectProgress: (event) => {
        if (event.event?.code === 'python-ready') {
          expect(session.runtimeBinding('python')).toMatchObject({ status: 'active' })
          expect(repairBlocks.has(`python:${DEFAULT_PY_ENV}`)).toBe(false)
          order.push('python-ready')
        }
        progress.push(event)
      },
      onRepairStarting: async () => {
        const original = await bindings.requireManagedDefault('python', interpreter)
        await repairs.prepareExplicitRepair('python', original)
      },
      onRepairCompleted: async () => {
        const replacement = await bindings.requireManagedDefault('python')
        await repairs.completeExplicitRepair('python', replacement)
      }
    })
    return {
      lifecycle,
      session,
      interpreter,
      runtimeRoot,
      policy,
      progress,
      repairBlocks,
      order,
      persisted: () =>
        (JSON.parse(readFileSync(persistedPath, 'utf8')) as NotebookRunDocument).runtimeBindings ??
        {}
    }
  }

  it('repairs and binds the canonical interpreter despite a manually added internal venv template', async () => {
    const h = harness('Manual venv template', { manualTemplate: true })
    await expect(h.lifecycle.repair('python', h.interpreter)).resolves.toBeUndefined()
    expect(h.order).toEqual(['interpreter-verified', 'binding-persisted', 'python-ready'])
    expect(h.persisted().python).toMatchObject({ runtimeId: h.interpreter, status: 'active' })
    expect(h.policy.requirement('python', DEFAULT_PY_ENV).required).toBe(false)
    expect(
      existsSync(join(dirname(h.interpreter), 'Lib', 'venv', 'scripts', 'nt', 'python.exe'))
    ).toBe(true)
  }, 30_000)

  it.each(['plain', 'For Open Science', 'Program Files (vee)'])(
    'repairs, binds and reports Python ready under %s',
    async (name) => {
      const h = harness(name)
      await expect(h.lifecycle.repair('python', h.interpreter)).resolves.toBeUndefined()
      expect(h.order).toEqual(['interpreter-verified', 'binding-persisted', 'python-ready'])
      expect(h.session.runtimeBinding('python')).toMatchObject({
        interpreterPath: h.interpreter,
        version: fixture.version,
        status: 'active'
      })
      expect(h.persisted().python).toMatchObject({ runtimeId: h.interpreter, status: 'active' })
      expect(h.policy.requirement('python', DEFAULT_PY_ENV).required).toBe(false)
      await expect(h.lifecycle.status()).resolves.toMatchObject({ pythonReady: true })
      expect(h.progress.filter(({ event }) => event?.code === 'python-ready')).toHaveLength(1)
    },
    30_000
  )

  it.each([
    { name: 'verification', brokenMaterialization: true, error: 'interpreter not executable' },
    {
      name: 'post-verification discovery',
      breakAfterVerify: true,
      error: 'runtime is not runnable'
    },
    { name: 'binding persistence', failPersistence: true, error: 'binding persistence denied' }
  ])(
    'keeps repair protection when $name fails',
    async ({ name, error, ...options }) => {
      const h = harness(`Failed repair (${name})`, options)
      await expect(h.lifecycle.repair('python', h.interpreter)).rejects.toThrow(error)
      expect(h.session.runtimeBinding('python')).toMatchObject({
        status: 'unavailable',
        reason: 'repair-required'
      })
      expect(h.persisted().python).toMatchObject({
        status: 'unavailable',
        reason: 'repair-required'
      })
      expect(h.policy.requirement('python', DEFAULT_PY_ENV).protectedIdentity).toBe(true)
      expect(h.repairBlocks.has(`python:${DEFAULT_PY_ENV}`)).toBe(true)
      expect(readReadyMarker(h.runtimeRoot)).toBeUndefined()
      expect(existsSync(h.interpreter)).toBe(true)
      await expect(h.lifecycle.status()).resolves.toMatchObject({
        pythonReady: false,
        pythonRepairRequired: true
      })
      expect(h.progress.some(({ event }) => event?.code === 'python-ready')).toBe(false)
      expect(h.progress.at(-1)).toMatchObject({ phase: 'error' })
    },
    30_000
  )
})
