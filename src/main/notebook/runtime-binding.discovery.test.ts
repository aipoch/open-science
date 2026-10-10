import { win32, posix, join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import * as discovery from './environment-discovery'
import { NotebookRuntimeBindingOwner } from './runtime-binding'
import { createRootNotebookLane } from './lane-identity'
import type { DiscoveredInterpreter } from '../../shared/notebook-runtime'
import type { NotebookSessionRuntimeBinding, NotebookSessionAggregate } from './session-aggregate'
import type { NotebookRunRepository } from './repository'

// Keep the real binding/discovery orchestration. Only machine enumeration and interpreter
// subprocesses are controlled through the existing discovery factory boundary.
afterEach(() => vi.restoreAllMocks())

describe('runtime discovery enablement', () => {
  it.each(['win32', 'darwin', 'linux'] as const)(
    '%s: lists the enabled system Python without probing the disabled managed Python',
    async (platform) => {
      const paths = platform === 'win32' ? win32 : posix
      const dataRoot = platform === 'win32' ? 'C:\\OpenScience' : '/OpenScience'
      const runtimeRoot = join(dataRoot, 'runtime')
      const managed = paths.join(dataRoot, 'runtime', 'envs', 'default-python', 'python')
      const system = paths.join(dataRoot, 'anaconda3', 'python')
      let finishDisabledProbe!: () => void
      const disabledProbe = new Promise<void>((resolve) => {
        finishDisabledProbe = resolve
      })
      const probeVersion = vi.fn(async (path: string) => {
        if (path === managed) {
          await disabledProbe // Models a probe that only returns when its timeout expires.
          return undefined
        }
        return '3.13.9'
      })
      vi.spyOn(discovery, 'defaultDiscoveryDeps').mockReturnValue({
        runtimeRoot,
        platform,
        candidatePaths: async (language) => (language === 'python' ? [managed, system] : []),
        realpath: (path) => path,
        probeVersion,
        rRunnable: async () => true
      })
      const owner = new NotebookRuntimeBindingOwner({
        dataRoot,
        platform,
        repository: { setRuntimeBindings: vi.fn(), findExisting: vi.fn() },
        runtimeSettings: {
          getSnapshot: async (language) => ({
            language,
            runtimeEnablement: {
              enabled: { [managed]: false, [system]: true },
              installAuthorized: {}
            },
            manualInterpreters: [],
            packageMirror: {}
          })
        },
        repairPolicy: {
          bindingRequirement: () => ({ required: false, keys: [], protectedIdentity: false })
        }
      })
      const session = {
        projectId: 'project',
        sessionId: 'new-session',
        lane: createRootNotebookLane('project', 'new-session', 'root-frame'),
        runtimeBinding: () => undefined,
        setRuntimeBinding: vi.fn()
      }
      const listing = owner.list(session)
      try {
        await vi.waitFor(() => expect(probeVersion).toHaveBeenCalledWith(system, 'python'))
        expect(probeVersion).not.toHaveBeenCalledWith(managed, 'python')
        await expect(listing).resolves.toMatchObject({
          runtimes: [{ runtimeId: system, version: '3.13.9', runnable: true }]
        })
        await expect(owner.bind(session, 'python', system)).resolves.toMatchObject({
          bound: { runtimeId: system, source: 'external' }
        })
        expect(probeVersion).not.toHaveBeenCalledWith(managed, 'python')
      } finally {
        finishDisabledProbe()
        await listing
      }
      // Settings/repair inventory must still be able to inspect disabled interpreters.
      probeVersion.mockClear()
      const inventory = await discovery.discoverInterpreters(
        'python',
        discovery.defaultDiscoveryDeps(runtimeRoot)
      )
      expect(inventory.map(({ envId }) => envId)).toContain(managed)
      expect(probeVersion).toHaveBeenCalledWith(managed, 'python')
    }
  )
})

describe.each(['python', 'r'] as const)('%s binding decision target validation', (language) => {
  const fixture = (): {
    runtime: DiscoveredInterpreter
    discover: Mock<() => Promise<DiscoveredInterpreter[]>>
    write: Mock<NotebookRunRepository['setRuntimeBindings']>
    setBinding: ReturnType<typeof vi.fn>
    session: Pick<
      NotebookSessionAggregate,
      'projectId' | 'sessionId' | 'lane' | 'runtimeBinding' | 'setRuntimeBinding'
    >
    owner: NotebookRuntimeBindingOwner
  } => {
    // A canonical realpath need not contain the logical default directory (e.g. symlinked prefixes).
    // Discovery ownership and logical environment identity are the authority, never model paths.
    const runtime: DiscoveredInterpreter = {
      language,
      provenance: 'app-managed',
      envId: `/canonical/runtime/bin/${language === 'r' ? 'R' : 'python'}`,
      interpreterPath: `/visible/runtime/bin/${language === 'r' ? 'R' : 'python'}`,
      label: 'Default',
      runnable: true,
      condaEnv: language === 'r' ? 'default-r' : 'default-python'
    }
    const discover = vi.fn(async () => [runtime])
    const write = vi.fn<NotebookRunRepository['setRuntimeBindings']>()
    let current: NotebookSessionRuntimeBinding | undefined
    const setBinding = vi.fn((_language, binding) => {
      current = binding
    })
    const session = {
      projectId: 'project',
      sessionId: 'session',
      lane: createRootNotebookLane('project', 'session', 'root-frame'),
      runtimeBinding: () => current,
      setRuntimeBinding: setBinding
    }
    const owner = new NotebookRuntimeBindingOwner({
      dataRoot: '/data',
      discoverRuntimes: discover,
      repository: { setRuntimeBindings: write, findExisting: vi.fn() },
      runtimeSettings: {
        getSnapshot: async () => ({
          language,
          manualInterpreters: [],
          packageMirror: {},
          runtimeEnablement: { enabled: {}, installAuthorized: {} }
        })
      },
      repairPolicy: {
        bindingRequirement: () => ({ required: false, keys: [], protectedIdentity: false })
      }
    })
    return { runtime, discover, write, setBinding, session, owner }
  }

  it('recognizes a discovered canonical default and refuses missing logical default identity', async () => {
    const h = fixture()
    expect(await h.owner.resolveBindingTarget(language, h.runtime.envId)).toMatchObject({
      readyDefault: true,
      runnable: true
    })
    h.runtime.condaEnv = undefined
    expect(await h.owner.resolveBindingTarget(language, h.runtime.envId)).toMatchObject({
      readyDefault: false
    })
    h.runtime.provenance = 'agent-created'
    expect(await h.owner.resolveBindingTarget(language, h.runtime.envId)).toMatchObject({
      readyDefault: false
    })
  })

  it('checks cancellation after final discovery and before durable commit', async () => {
    const h = fixture()
    const controller = new AbortController()
    h.discover
      .mockImplementationOnce(async () => [h.runtime])
      .mockImplementationOnce(async () => {
        controller.abort(new Error('cancelled at commit'))
        return [h.runtime]
      })
    expect(
      await h.owner.bind(
        h.session,
        language,
        h.runtime.envId,
        async () => undefined,
        () => controller.signal.throwIfAborted()
      )
    ).toMatchObject({ ok: false, bindingChanged: false, error: 'cancelled at commit' })
    expect(h.write).not.toHaveBeenCalled()
    expect(h.setBinding).not.toHaveBeenCalled()
  })

  it('revalidates logical default identity after the decision callback returns', async () => {
    const h = fixture()
    expect(
      await h.owner.bind(h.session, language, h.runtime.envId, async () => {
        h.runtime.condaEnv = undefined
      })
    ).toMatchObject({ ok: false, bindingChanged: false })
    expect(h.write).not.toHaveBeenCalled()
    expect(h.setBinding).not.toHaveBeenCalled()
  })
})
