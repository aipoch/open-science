import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { sandboxedPackageSpawn } from './package-process-sandbox'
import type { NotebookProcessSandbox } from './process-sandbox'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('sandboxedPackageSpawn', () => {
  it.each(
    process.platform === 'win32'
      ? [
          ['bin', 'Rscript.exe'],
          ['bin', 'x64', 'Rscript.exe']
        ]
      : [['bin', 'Rscript']]
  )(
    'grants library writes and R home reads for %s/%s without interpreter writes',
    async (...parts) => {
      const root = mkdtempSync(join(tmpdir(), 'external-runtime-scope-'))
      temporaryDirectories.push(root)
      mkdirSync(join(root, 'etc'))
      mkdirSync(join(root, 'library'))
      const command = join(root, ...parts)
      const library = join(tmpdir(), 'personal-r-library')
      const runtimeRoot = join(root, 'managed-runtime')
      const cacheRoot = join(runtimeRoot, 'workload-cache')
      mkdirSync(cacheRoot, { recursive: true })
      const wrap = vi.fn<NotebookProcessSandbox['wrap']>(async () => {
        throw new Error('scope captured')
      })
      const spawn = sandboxedPackageSpawn({
        processSandbox: { wrap },
        request: { language: 'r', packages: ['glue'] },
        runtimeRoot,
        storageRoot: join(tmpdir(), 'app-storage'),
        interpreter: { command, library }
      })
      await expect(
        spawn(command, [], {
          R_LIBS_USER: library,
          MAMBA_ROOT_PREFIX: runtimeRoot,
          CONDA_PKGS_DIRS: runtimeRoot,
          OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: cacheRoot,
          R_LIBS: '/unrelated/library',
          R_PROFILE_USER: '/unrelated/profile'
        })
      ).rejects.toThrow('scope captured')
      const env = wrap.mock.calls[0]![0].env!
      expect(env.R_LIBS_USER).toBe(library)
      expect(env.R_LIBS).toBeUndefined()
      expect(env.R_PROFILE_USER).toBeUndefined()
      const filesystem = wrap.mock.calls[0]![0].filesystem!
      expect(filesystem.readWriteRoots).toContain(library)
      expect(filesystem.readWriteRoots).not.toContain(root)
      expect(filesystem.readWriteRoots).toEqual([library, cacheRoot])
      expect(filesystem.readWriteRoots).not.toContain(runtimeRoot)
      expect(filesystem.readOnlyRoots).toContain(runtimeRoot)
      expect(filesystem.readOnlyRoots).toContain(root)
    }
  )
  it('does not prepare or launch an installer for an already-cancelled request', async () => {
    const processSandbox: NotebookProcessSandbox = { wrap: vi.fn() }
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: { language: 'python', packages: ['example'] },
      runtimeRoot: process.cwd(),
      storageRoot: process.cwd()
    })
    const cancellation = new AbortController()
    cancellation.abort(new DOMException('Request cancelled.', 'AbortError'))
    const onChild = vi.fn()

    await expect(
      spawn(
        process.execPath,
        ['-e', 'process.exit(0)'],
        process.env,
        onChild,
        undefined,
        undefined,
        undefined,
        { signal: cancellation.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(processSandbox.wrap).not.toHaveBeenCalled()
    expect(onChild).not.toHaveBeenCalled()
  })

  it('cancels pending sandbox preparation without launching an installer', async () => {
    let preparationSignal: AbortSignal | undefined
    const preparationStarted = Promise.withResolvers<void>()
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn<NotebookProcessSandbox['wrap']>(
        (invocation) =>
          new Promise((_resolve, reject) => {
            preparationSignal = invocation.signal
            preparationStarted.resolve()
            invocation.signal?.addEventListener('abort', () => reject(invocation.signal?.reason), {
              once: true
            })
          })
      )
    }
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: { language: 'python', packages: ['example'] },
      runtimeRoot: process.cwd(),
      storageRoot: process.cwd()
    })
    const cancellation = new AbortController()
    const onChild = vi.fn()
    const pending = spawn(
      process.execPath,
      ['-e', 'process.exit(0)'],
      process.env,
      onChild,
      undefined,
      undefined,
      undefined,
      { signal: cancellation.signal }
    )
    await preparationStarted.promise

    cancellation.abort(new DOMException('Request cancelled.', 'AbortError'))

    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('sandbox preparation did not cancel')), 250)
        )
      ])
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(preparationSignal).toBe(cancellation.signal)
    expect(onChild).not.toHaveBeenCalled()
  })
  it.each(['darwin', 'win32'] as const)(
    'uses an authorized runtime cwd and filters unsafe package options on %s',
    async (platform) => {
      const storageRoot = mkdtempSync(join(tmpdir(), 'open-science-package-storage-'))
      const runtimeRoot = join(storageRoot, 'runtime')
      mkdirSync(runtimeRoot)
      temporaryDirectories.push(storageRoot)
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => {
          if (!invocation.filesystem.readWriteRoots.includes(invocation.cwd)) {
            throw new Error('getcwd: cannot access parent directories: Operation not permitted')
          }
          return {
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (stderr: string) => stderr,
            cleanup: vi.fn()
          }
        })
      }
      const spawn = sandboxedPackageSpawn({
        processSandbox,
        request: { language: 'python', packages: [], projectId: 'project-1' },
        runtimeRoot,
        storageRoot,
        platform
      })

      await expect(
        spawn(process.execPath, ['-e', ''], {
          PIP_REPORT: join(storageRoot, 'report.json'),
          PIP_TARGET: storageRoot,
          PIP_CONFIG_FILE: join(storageRoot, 'pip.conf'),
          Pip_Proxy: 'http://proxy.example:1086'
        })
      ).resolves.toMatchObject({ code: 0 })
      expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].cwd).toBe(runtimeRoot)
      const invocation = vi.mocked(processSandbox.wrap).mock.calls[0]?.[0]
      expect(invocation?.env.PIP_REPORT).toBeUndefined()
      expect(invocation?.env.PIP_CONFIG_FILE).toBeUndefined()
      expect(invocation?.env.PIP_TARGET).toBeUndefined()
      expect(invocation?.env.PIP_PROXY).toBe(
        platform === 'win32' ? 'http://proxy.example:1086' : undefined
      )
      expect(invocation?.filesystem.readWriteRoots).not.toContain(storageRoot)
    }
  )

  it('runs an installer through the Notebook sandbox and preserves its lifecycle', async () => {
    const endExecution = vi.fn()
    const cleanup = vi.fn().mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        confirmProcessTreeTermination: async () => true,
        beginExecution: () => endExecution,
        annotateStderr: (stderr: string) =>
          `${stderr}<sandbox_violations>blocked</sandbox_violations>`,
        cleanup
      }))
    }
    const storageRoot = process.cwd()
    const packageCache = mkdtempSync(join(tmpdir(), 'open-science-package-cache-'))
    const matplotlibCache = join(packageCache, 'matplotlib')
    const lockCwd = join(packageCache, 'locks')
    const reportRoot = mkdtempSync(join(tmpdir(), 'open-science-pip-report-'))
    temporaryDirectories.push(reportRoot)
    mkdirSync(lockCwd)
    temporaryDirectories.push(packageCache)
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: {
        language: 'python',
        packages: ['example'],
        sessionId: 'session-1',
        projectId: 'project-1',
        workspaceCwd: packageCache
      },
      runtimeRoot: join(storageRoot, '.open-science-test-runtime', 'package-sandbox', 'runtime'),
      storageRoot
    })
    const onOutput = vi.fn()

    const result = await spawn(
      process.execPath,
      ['-e', 'process.stderr.write("installer")'],
      {
        PATH: process.env.PATH,
        PIP_CERT: '/trusted/bundle.pem',
        PIP_REPORT: join(reportRoot, 'report.json'),
        PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null',
        PIP_NO_INDEX: '1',
        PIP_FIND_LINKS: '/trusted/wheels',
        PYTHONNOUSERSITE: '1',
        CONDA_PKGS_DIRS: packageCache,
        MPLCONFIGDIR: matplotlibCache,
        UV_PROJECT_ENVIRONMENT: packageCache,
        OPENAI_API_KEY: 'must-not-cross'
      },
      undefined,
      undefined,
      false,
      lockCwd,
      { onOutput }
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('installer<sandbox_violations>blocked</sandbox_violations>')
    expect(onOutput).toHaveBeenCalledWith({ stream: 'stderr', text: 'installer' })
    expect(processSandbox.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime: 'python',
        cwd: lockCwd
      })
    )
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].env).toMatchObject({
      PATH: process.env.PATH,
      PIP_CERT: '/trusted/bundle.pem',
      PIP_REPORT: join(reportRoot, 'report.json'),
      PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null',
      PIP_NO_INDEX: '1',
      PIP_FIND_LINKS: '/trusted/wheels',
      PYTHONNOUSERSITE: '1',
      MPLCONFIGDIR: matplotlibCache,
      UV_PROJECT_ENVIRONMENT: packageCache
    })
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].env).not.toHaveProperty(
      'OPENAI_API_KEY'
    )
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].filesystem.readWriteRoots).toContain(
      packageCache
    )
    expect(endExecution).toHaveBeenCalledOnce()
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].filesystem.readWriteRoots).toContain(
      reportRoot
    )
    expect(cleanup).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledWith('exit', {
      processesTerminated: true,
      confirmTermination: expect.any(Function)
    })
  })

  it('confirms an aborted installer tree before recording retryable cleanup', async () => {
    const confirmTermination = vi.fn(async () => true)
    const cleanup = vi.fn().mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        confirmProcessTreeTermination: confirmTermination,
        beginExecution: () => () => undefined,
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: { language: 'python', packages: ['example'] },
      runtimeRoot: process.cwd(),
      storageRoot: process.cwd()
    })
    const cancellation = new AbortController()
    await expect(
      spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 30_000)'],
        process.env,
        () => {
          cancellation.abort(new DOMException('Package operation cancelled.', 'AbortError'))
        },
        undefined,
        false,
        undefined,
        { signal: cancellation.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(cleanup).toHaveBeenCalledWith('spawn-failed', {
      processesTerminated: true,
      confirmTermination
    })
  })

  it('does not consume Windows Job Object proof after a confirmed abort kill', async () => {
    const confirmTermination = vi.fn(async () => false)
    const cleanup = vi.fn().mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        confirmProcessTreeTermination: confirmTermination,
        beginExecution: () => () => undefined,
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: { language: 'python', packages: ['example'] },
      runtimeRoot: process.cwd(),
      storageRoot: process.cwd()
    })
    const cancellation = new AbortController()
    const reason = Object.freeze(new DOMException('Package operation cancelled.', 'AbortError'))
    await expect(
      spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 30_000)'],
        process.env,
        () => {
          cancellation.abort(reason)
        },
        undefined,
        false,
        undefined,
        { signal: cancellation.signal }
      )
    ).rejects.toBe(reason)
    expect(Object.hasOwn(reason, 'processesTerminated')).toBe(false)
    expect(confirmTermination).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledWith('spawn-failed', {
      processesTerminated: true,
      confirmTermination
    })
  })

  it('grants only the configured package mirror hostnames to the installer', async () => {
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        annotateStderr: (stderr: string) => stderr,
        cleanup: vi.fn()
      }))
    }
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: { language: 'python', packages: ['example'] },
      mirror: {
        condaChannel: 'https://CONDA.example.org/channels/conda-forge/',
        pypiIndex: 'https://pypi.example.org/simple',
        cranMirror: 'https://cran.example.org/CRAN/'
      },
      runtimeRoot: process.cwd(),
      storageRoot: process.cwd()
    })

    await spawn(process.execPath, ['-e', 'process.exit(0)'], process.env)

    expect(processSandbox.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedNetworkHosts: ['conda.example.org', 'pypi.example.org', 'cran.example.org']
      })
    )
  })

  it.each([
    ['leading whitespace', ' https://packages.example.org/simple', []],
    ['trailing whitespace', 'https://packages.example.org/simple ', []],
    ['embedded ASCII whitespace', 'https://packages.exa\tmple.org/simple', []],
    ['embedded ASCII control', 'https://packages.example.org/sim\nple', []],
    ['non-HTTP protocol', 'ftp://packages.example.org/simple', []],
    ['URL userinfo', 'https://user:secret@packages.example.org/simple', []],
    ['localhost', 'https://localhost/simple', []],
    ['IPv4 address', 'https://127.0.0.1/simple', []],
    ['IPv6 address', 'https://[::1]/simple', []],
    ['valid IDN', 'https://例子.测试/simple', ['xn--fsqu00a.xn--0zwm56d']]
  ] as const)('derives safe exact mirror hosts for %s', async (_label, pypiIndex, expected) => {
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        annotateStderr: (stderr: string) => stderr,
        cleanup: vi.fn()
      }))
    }
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: { language: 'python', packages: ['example'] },
      mirror: { pypiIndex },
      runtimeRoot: process.cwd(),
      storageRoot: process.cwd()
    })

    await spawn(process.execPath, ['-e', 'process.exit(0)'], process.env)

    expect(processSandbox.wrap).toHaveBeenCalledWith(
      expect.objectContaining({ allowedNetworkHosts: expected })
    )
  })

  it('forwards installer deadlines and cleans up only after the child is stopped', async () => {
    const endExecution = vi.fn()
    const cleanup = vi.fn()
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        beginExecution: () => endExecution,
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: { language: 'python', packages: ['example'] },
      runtimeRoot: process.cwd(),
      storageRoot: process.cwd()
    })
    let childPid: number | undefined

    await expect(
      spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 15000)'],
        process.env,
        (pid) => {
          childPid = pid
        },
        undefined,
        undefined,
        undefined,
        { timeoutMs: 50 }
      )
    ).rejects.toMatchObject({ code: 'PACKAGE_OPERATION_TIMEOUT' })

    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid as number, 0)).toThrow()
    expect(endExecution).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it.each([
    {
      event: 'close',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      code: 0,
      platform: 'win32' as const,
      confirmsTermination: true,
      processesTerminated: true
    },
    {
      event: 'close without ownership',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      code: 0,
      platform: 'win32' as const,
      confirmsTermination: false,
      processesTerminated: false
    },
    {
      event: 'spawn error',
      executable: join(process.cwd(), 'missing-installer-executable'),
      args: [],
      code: 1,
      platform: 'win32' as const,
      confirmsTermination: true,
      processesTerminated: false
    },
    {
      event: 'confirmation failure',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      code: 0,
      platform: 'win32' as const,
      confirmsTermination: true,
      confirmationRejects: true,
      processesTerminated: false
    },
    {
      event: 'Linux close with a Windows-only confirmation flag',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      code: 0,
      platform: 'linux' as const,
      confirmsTermination: true,
      processesTerminated: false
    },
    {
      event: 'Linux spawn error',
      executable: join(process.cwd(), 'missing-installer-executable'),
      args: [],
      code: 1,
      platform: 'linux' as const,
      confirmsTermination: true,
      processesTerminated: false
    }
  ])(
    'waits for bounded installer-tree observation after $event',
    async ({
      executable,
      args,
      code,
      platform,
      confirmsTermination,
      confirmationRejects,
      processesTerminated
    }) => {
      let releaseReaping: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        releaseReaping = resolve
      })
      const terminateTree = vi.fn(async () => {
        await gate
        return { reaped: false }
      })
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          confirmProcessTreeTermination: async () => {
            if (confirmationRejects) throw new Error('proof unavailable')
            return confirmsTermination
          },
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }
      const runtimeRoot = mkdtempSync(join(tmpdir(), 'package-tree-'))
      temporaryDirectories.push(runtimeRoot)
      const spawn = sandboxedPackageSpawn({
        processSandbox,
        request: { language: 'python', packages: ['example'] },
        runtimeRoot,
        storageRoot: process.cwd(),
        platform,
        terminateTree
      })
      let completed = false

      const completion = spawn(executable, args).then((result) => {
        completed = true
        return result
      })

      await vi.waitFor(() => expect(terminateTree).toHaveBeenCalledOnce())
      expect(completed).toBe(false)
      expect(cleanup).not.toHaveBeenCalled()
      releaseReaping?.()
      await expect(completion).resolves.toMatchObject({ code })
      expect(cleanup).toHaveBeenCalledWith('exit', {
        processesTerminated,
        confirmTermination: expect.any(Function)
      })
    }
  )

  it.runIf(process.platform !== 'win32')(
    'reaps an installer helper that outlives its leader',
    async () => {
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }
      const runtimeRoot = mkdtempSync(join(tmpdir(), 'package-tree-'))
      temporaryDirectories.push(runtimeRoot)
      const spawn = sandboxedPackageSpawn({
        processSandbox,
        request: { language: 'python', packages: ['example'] },
        runtimeRoot,
        storageRoot: process.cwd()
      })
      let helperPid: number | undefined

      try {
        const result = await spawn(process.execPath, [
          '-e',
          "const {spawn}=require('node:child_process'); const helper=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true}); helper.unref(); process.stdout.write(String(helper.pid));"
        ])
        helperPid = Number(result.stdout)
        expect(result.code).toBe(0)
        await vi.waitFor(() => expect(() => process.kill(helperPid as number, 0)).toThrow())
        expect(cleanup).toHaveBeenCalledWith('exit', { processesTerminated: true })
      } finally {
        if (helperPid) {
          try {
            process.kill(helperPid, 'SIGKILL')
          } catch {
            // Expected once the owned installer group has been reaped.
          }
        }
      }
    }
  )
})
