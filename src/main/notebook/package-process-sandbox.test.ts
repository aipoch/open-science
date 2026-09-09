import { mkdtempSync, rmSync } from 'node:fs'
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

  it('runs an installer through the Notebook sandbox and preserves its lifecycle', async () => {
    const endExecution = vi.fn()
    const cleanup = vi.fn()
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        beginExecution: () => endExecution,
        annotateStderr: (stderr: string) =>
          `${stderr}<sandbox_violations>blocked</sandbox_violations>`,
        cleanup
      }))
    }
    const storageRoot = process.cwd()
    const packageCache = mkdtempSync(join(tmpdir(), 'open-science-package-cache-'))
    const matplotlibCache = join(packageCache, 'matplotlib')
    temporaryDirectories.push(packageCache)
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: {
        language: 'python',
        packages: ['example'],
        sessionId: 'session-1',
        projectId: 'project-1',
        workspaceCwd: process.cwd()
      },
      runtimeRoot: join(storageRoot, '.open-science-test-runtime', 'package-sandbox', 'runtime'),
      storageRoot
    })

    const result = await spawn(process.execPath, ['-e', 'process.stderr.write("installer")'], {
      PATH: process.env.PATH,
      PIP_CERT: '/trusted/bundle.pem',
      PYTHONNOUSERSITE: '1',
      CONDA_PKGS_DIRS: packageCache,
      MPLCONFIGDIR: matplotlibCache,
      OPENAI_API_KEY: 'must-not-cross'
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('installer<sandbox_violations>blocked</sandbox_violations>')
    expect(processSandbox.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime: 'python',
        cwd: process.cwd()
      })
    )
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].env).toMatchObject({
      PATH: process.env.PATH,
      PIP_CERT: '/trusted/bundle.pem',
      MPLCONFIGDIR: matplotlibCache,
      PYTHONNOUSERSITE: '1'
    })
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].env).not.toHaveProperty(
      'OPENAI_API_KEY'
    )
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].filesystem.readWriteRoots).toContain(
      packageCache
    )
    expect(endExecution).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
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
})
