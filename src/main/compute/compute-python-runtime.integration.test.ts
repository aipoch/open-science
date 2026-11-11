import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  envPrefix,
  pythonBin,
  writeReadyMarker
} from '@aipoch/environment'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { getRuntimeRoot, NotebookRunRepository } from '../notebook/repository'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import {
  ComputePythonRuntime,
  configureComputePythonRuntimes,
  computeHelperPath,
  runComputePython
} from './compute-python-runtime'
import { boundHfAccountAdapter } from './compute-account-hf'
import { boundModalAccountAdapter } from './modal-account-auth'
import { waitForDataRootWriters } from '../storage/migration-state'
let applicationPath = process.cwd()
configureTestRuntimeMetadata(() => ({ applicationPath }))
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
it('shares managed SDK leases with package mutation, drains migration, and enforces post-lock admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modal-leases-'))
  const runtimeRoot = getRuntimeRoot(root),
    prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV),
    python = pythonBin(prefix)
  await mkdir(join(python, '..'), { recursive: true })
  await writeFile(python, '')
  writeReadyMarker(runtimeRoot, DEFAULT_ENV_VERSION, new Date().toISOString())
  let disabled = false
  const installer = vi.fn(async () => ({ ok: true, needsRestart: false, log: '' }))
  const service = new NotebookRuntimeService({
    projectId: 'test-project',
    dataRoot: root,
    configRoot: root,
    repository: new NotebookRunRepository(root),
    notebookRuntimeSettings: {
      getSnapshot: async () => ({
        language: 'python',
        packageMirror: {},
        runtimeEnablement: { enabled: { [python]: !disabled }, installAuthorized: {} },
        manualInterpreters: []
      })
    },
    installPackagesImpl: installer,
    environmentStateTracker: {
      prepareRun: vi.fn(),
      captureCompletedRun: vi.fn(),
      inspectPackages: vi.fn(),
      markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
      refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
    }
  })
  try {
    const entered = deferred(),
      release = deferred()
    const reading = service.withPythonExecution(
      { runtimeRoot, environment: DEFAULT_PY_ENV, python },
      async () => {
        entered.resolve()
        await release.promise
      }
    )
    await entered.promise
    const writing = service.managePackages({
      language: 'python',
      environment: DEFAULT_PY_ENV,
      packages: ['modal==1.6.3', 'python-socks', 'aiohttp-socks'],
      usePip: true
    })
    let drained = false
    const draining = waitForDataRootWriters().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(installer).not.toHaveBeenCalled()
    expect(drained).toBe(false)
    release.resolve()
    await reading
    expect((await writing).ok).toBe(true)
    await draining
    disabled = true
    await expect(
      service.withPythonExecution(
        { runtimeRoot, environment: DEFAULT_PY_ENV, python },
        async () => true
      )
    ).rejects.toThrow('RUNTIME_DISABLED')
  } finally {
    vi.unstubAllEnvs()
    await service.shutdownAll()
    await rm(root, { recursive: true, force: true })
  }
})
it.each(['selected path', 'canonical identity'] as const)(
  'enforces external Python enablement by %s before running Modal helpers',
  async (keyKind) => {
    const root = await mkdtemp(join(tmpdir(), 'modal-external-admission-'))
    const runtimeRoot = getRuntimeRoot(root)
    const bin = join(root, 'bin')
    const alias = join(root, 'selected-bin')
    await mkdir(bin)
    await writeFile(join(bin, 'external-python'), '')
    await symlink(bin, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const selected = join(alias, 'external-python')
    // Discovery uses realpathSync to key interpreter enablement.
    const identity = keyKind === 'selected path' ? selected : realpathSync(selected)
    let disabled = true
    const service = new NotebookRuntimeService({
      projectId: 'test-project',
      dataRoot: root,
      configRoot: root,
      repository: new NotebookRunRepository(root),
      notebookRuntimeSettings: {
        getSnapshot: async () => ({
          language: 'python',
          packageMirror: {},
          manualInterpreters: [selected],
          runtimeEnablement: { enabled: { [identity]: !disabled }, installAuthorized: {} }
        })
      }
    })
    try {
      const execute = vi.fn(async () => 'helper result')
      const target = { runtimeRoot, python: selected }
      await expect(service.withPythonExecution(target, execute)).rejects.toThrow('RUNTIME_DISABLED')
      expect(execute).not.toHaveBeenCalled()
      disabled = false
      expect(await service.withPythonExecution(target, execute)).toBe('helper result')
      expect(execute).toHaveBeenCalledOnce()
    } finally {
      await service.shutdownAll()
      await rm(root, { recursive: true, force: true })
    }
  }
)
it.skipIf(process.env.OPEN_SCIENCE_MODAL_INSTALL_SMOKE !== '1')(
  'installs the real pinned SDK sessionlessly and launches both packaged helpers without a cloud resource',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'modal-install-'))
    const runtimeRoot = getRuntimeRoot(root),
      prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV),
      python = pythonBin(prefix)
    execFileSync(process.env.OPEN_SCIENCE_TEST_PYTHON ?? 'python3', ['-m', 'venv', prefix], {
      timeout: 60000
    })
    writeReadyMarker(runtimeRoot, DEFAULT_ENV_VERSION, new Date().toISOString())
    const service = new NotebookRuntimeService({
      projectId: 'test-project',
      dataRoot: root,
      configRoot: root,
      repository: new NotebookRunRepository(root),
      locale: 'en',
      getPackageMirror: () => ({ pypiIndex: 'https://pypi.org/simple' })
    })
    const manage = vi.spyOn(service, 'managePackages')
    const dependencies: ConstructorParameters<typeof ComputePythonRuntime>[0] = {
      runtimeRoot: () => runtimeRoot,
      runtime: service,
      getSelection: async () => undefined,
      saveSelection: async () => {},
      listPython: async () => [],
      defaultReady: async () => true,
      provision: async () => {
        throw new Error('Already supplied')
      },
      commit: (fn) => fn()
    }
    const owner = new ComputePythonRuntime(dependencies, 'modal')
    try {
      const ready = await owner
        .prepare({ operationId: 'real-install', revision: 0 })
        .catch(async (error) => {
          await writeFile(
            join(process.cwd(), '.scratch/modal-real-install-error.json'),
            JSON.stringify(await manage.mock.results[0]?.value, null, 2)
          )
          throw error
        })
      expect(manage).toHaveBeenCalledOnce()
      const installed = await manage.mock.results[0].value
      expect(installed.ok).toBe(true)
      expect(installed.method).toBe('pip')
      const checked = JSON.parse(
        await runComputePython(
          python,
          ['-I', '-B', join(process.cwd(), 'resources/compute-modal-check.py')],
          undefined
        )
      )
      expect(checked).toEqual({ prefix, version: '1.6.3' })
      const missingProxy = JSON.parse(
        await runComputePython(
          python,
          [
            '-I',
            '-B',
            '-c',
            [
              'import builtins,runpy',
              'from modal._utils import proxy_support',
              'proxy_support.get_proxy_url = lambda *args, **kwargs: "http://127.0.0.1:1"',
              'original_import = builtins.__import__',
              'def without_proxy(name, *args, **kwargs):',
              '    if name == "python_socks.async_.asyncio": raise ImportError("optional proxy support missing")',
              '    return original_import(name, *args, **kwargs)',
              'builtins.__import__ = without_proxy',
              'runpy.run_path(__import__("sys").argv[1])'
            ].join('\n'),
            join(process.cwd(), 'resources/compute-modal-check.py')
          ],
          undefined
        )
      )
      expect(missingProxy).toEqual({ prefix, version: '1.6.3', error: 'proxy' })
      let browserChallengeReceived = false
      if (process.env.OPEN_SCIENCE_MODAL_AUTH_SMOKE === '1') {
        configureComputePythonRuntimes({
          ...dependencies,
          saveSelection: (_provider, selection) => dependencies.saveSelection(selection),
          commit: (_provider, fn) => dependencies.commit(fn)
        })
        const cancelled = new AbortController()
        await expect(
          boundModalAccountAdapter(ready.binding).authorize(
            async (url) => {
              expect(new URL(url).origin).toBe('https://modal.com')
              browserChallengeReceived = true
              cancelled.abort()
            },
            AbortSignal.any([cancelled.signal, AbortSignal.timeout(30000)])
          )
        ).rejects.toMatchObject({ reason: 'cancelled' })
        expect(browserChallengeReceived).toBe(true)
      }

      const packagedResources = join(root, 'app.asar.unpacked', 'resources')
      await mkdir(packagedResources, { recursive: true })
      for (const helper of ['compute-modal-check.py', 'compute-modal-auth.py', 'compute-modal.py'])
        await copyFile(join(process.cwd(), 'resources', helper), join(packagedResources, helper))
      applicationPath = join(root, 'app.asar')
      // Empty explicit credentials force an offline missing-identity result; no remote resource calls.
      const auth = await owner.run(ready.binding, () =>
        runComputePython(
          python,
          ['-I', '-B', computeHelperPath('compute-modal-auth.py')],
          JSON.stringify({ action: 'probe', material: { tokenId: '', tokenSecret: '' } })
        )
      )
      expect(JSON.parse(auth)).toEqual({ error: 'missing' })
      const task = await owner.run(ready.binding, () =>
        runComputePython(
          python,
          ['-I', '-B', computeHelperPath('compute-modal.py'), 'offline-check'],
          JSON.stringify({ request: {}, managedIdentity: { tokenId: '', tokenSecret: '' } })
        )
      )
      expect(JSON.parse(task)).toHaveProperty('error')
      expect(
        await owner.select({
          operationId: 'custom-venv',
          revision: 0,
          selection: { kind: 'custom', pythonPath: python }
        })
      ).toEqual({ revision: 1 })
      if (process.platform !== 'win32') {
        const hostPython = process.env.OPEN_SCIENCE_TEST_PYTHON ?? 'python3'
        const userBase = join(root, 'user-site')
        vi.stubEnv('PYTHONUSERBASE', userBase)
        vi.stubEnv('PYTHONNOUSERSITE', undefined)
        const userSite = execFileSync(
          hostPython,
          ['-B', '-c', 'import site; print(site.getusersitepackages())'],
          { encoding: 'utf8' }
        ).trim()
        const installedSite = execFileSync(
          python,
          ['-I', '-B', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
          { encoding: 'utf8' }
        ).trim()
        await mkdir(dirname(userSite), { recursive: true })
        await symlink(installedSite, userSite)
        expect(
          execFileSync(
            hostPython,
            ['-B', '-c', 'from importlib.metadata import version; print(version("modal"))'],
            { encoding: 'utf8' }
          ).trim()
        ).toBe('1.6.3')
        const isolated = JSON.parse(
          await runComputePython(
            hostPython,
            ['-I', '-B', join(process.cwd(), 'resources/compute-modal-check.py')],
            undefined
          )
        )
        expect(isolated.error).toBe('missing')
        expect(
          await owner.select({
            operationId: 'user-site-only',
            revision: 1,
            selection: { kind: 'custom', pythonPath: hostPython }
          })
        ).toMatchObject({ runtimeError: 'dependency' })
        vi.unstubAllEnvs()
        expect(manage).toHaveBeenCalledOnce()
      }
      const inventoryRoot = join(runtimeRoot, 'provenance', 'environment-inventory')
      const inventories = await readdir(inventoryRoot)
      expect(inventories.length).toBeGreaterThan(0)
      const files = await readdir(join(inventoryRoot, inventories[0]))
      await writeFile(
        join(process.cwd(), '.scratch/modal-real-install-evidence.json'),
        JSON.stringify(
          {
            python,
            prefix,
            browserChallengeReceived,
            installer: { ok: installed.ok, method: installed.method, target: installed.target },
            checked,
            auth: JSON.parse(auth),
            task: JSON.parse(task),
            inventoryFiles: files,
            packagedHelper: computeHelperPath('compute-modal-check.py'),
            invocation: manage.mock.calls[0][0]
          },
          null,
          2
        )
      )
      const inventoryDirectory = join(inventoryRoot, inventories[0], 'inventories')
      const inventoryFiles = await readdir(inventoryDirectory)
      expect(
        (
          await Promise.all(
            inventoryFiles.map((file) => readFile(join(inventoryDirectory, file), 'utf8'))
          )
        ).join('')
      ).toContain('modal')
    } finally {
      applicationPath = process.cwd()
      vi.unstubAllEnvs()
      await service.shutdownAll()
      await rm(root, { recursive: true, force: true })
    }
  },
  180000
)

it.skipIf(process.env.OPEN_SCIENCE_HF_INSTALL_SMOKE !== '1')(
  'prepares the real Hugging Face SDK, checks packaged resources and reaches its browser challenge',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hf-install-'))
    const runtimeRoot = getRuntimeRoot(root)
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const python = pythonBin(prefix)
    execFileSync(process.env.OPEN_SCIENCE_TEST_PYTHON ?? 'python3', ['-m', 'venv', prefix], {
      timeout: 60000
    })
    writeReadyMarker(runtimeRoot, DEFAULT_ENV_VERSION, new Date().toISOString())
    const service = new NotebookRuntimeService({
      projectId: 'hf-smoke',
      dataRoot: root,
      configRoot: root,
      repository: new NotebookRunRepository(root),
      locale: 'en',
      getPackageMirror: () => ({ pypiIndex: 'https://pypi.org/simple' })
    })
    const manage = vi.spyOn(service, 'managePackages')
    const dependencies: ConstructorParameters<typeof ComputePythonRuntime>[0] = {
      runtimeRoot: () => runtimeRoot,
      runtime: service,
      getSelection: async () => undefined,
      saveSelection: async () => {},
      listPython: async () => [],
      defaultReady: async () => true,
      provision: async () => {
        throw new Error('Already supplied')
      },
      commit: (fn) => fn()
    }
    const owner = new ComputePythonRuntime(dependencies, 'hugging-face')
    try {
      const ready = await owner.prepare({ operationId: 'real-hf-install', revision: 0 })
      expect(manage).toHaveBeenCalledWith(
        expect.objectContaining({
          packages: ['huggingface_hub==2.4.0', 'socksio'],
          environment: DEFAULT_PY_ENV
        }),
        expect.any(AbortSignal)
      )
      const resources = join(root, 'app.asar.unpacked', 'resources')
      await mkdir(resources, { recursive: true })
      for (const helper of ['compute-hf-check.py', 'compute-hf-auth.py'])
        await copyFile(join(process.cwd(), 'resources', helper), join(resources, helper))
      applicationPath = join(root, 'app.asar')
      const checked = JSON.parse(
        await owner.run(ready.binding, () =>
          runComputePython(
            python,
            ['-I', '-B', computeHelperPath('compute-hf-check.py')],
            undefined
          )
        )
      )
      expect(checked).toEqual({ prefix, version: '2.4.0' })
      expect(
        await owner.select({
          operationId: 'custom-hf',
          revision: 0,
          selection: { kind: 'custom', pythonPath: python }
        })
      ).toEqual({ revision: 1 })
      configureComputePythonRuntimes({
        ...dependencies,
        saveSelection: (_provider, selection) => dependencies.saveSelection(selection),
        commit: (_provider, fn) => dependencies.commit(fn)
      })
      let browserChallengeReceived = false
      if (process.env.OPEN_SCIENCE_HF_AUTH_SMOKE === '1') {
        const controller = new AbortController()
        await expect(
          boundHfAccountAdapter(ready.binding).authorize(
            async (url) => {
              expect(['https://huggingface.co', 'https://hf.co']).toContain(new URL(url).origin)
              browserChallengeReceived = true
              controller.abort()
            },
            AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
          )
        ).rejects.toMatchObject({ reason: 'cancelled' })
        expect(browserChallengeReceived).toBe(true)
      }
      await writeFile(
        join(process.cwd(), '.scratch/hf-connection/real-install-evidence.json'),
        JSON.stringify(
          {
            checked,
            browserChallengeReceived,
            packagedHelper: computeHelperPath('compute-hf-check.py'),
            installed: (await manage.mock.results[0].value).ok
          },
          null,
          2
        )
      )
    } finally {
      applicationPath = process.cwd()
      await service.shutdownAll()
      await rm(root, { recursive: true, force: true })
    }
  },
  180000
)
