import { win32, posix, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as discovery from './environment-discovery'
import { NotebookRuntimeBindingOwner } from './runtime-binding'
import { createRootNotebookLane } from './lane-identity'

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
