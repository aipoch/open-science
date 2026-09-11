import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { NotebookEnvironmentLock } from '../../shared/notebook'
import { verifyRestoredEnvironment } from './restored-environment-verification'
import { defaultSpawn, type InstallSpawn } from './package-manager'
import { rScriptBin } from './runtime-paths'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (
  language: 'python' | 'r' = 'python',
  runtimeVersion?: string
): Promise<{
  prefix: string
  lock: NotebookEnvironmentLock
  record: Record<string, string>
  recordPath: string
  observed: {
    version: string
    root: string
    packages: Array<{ name: string; version: string; path: string; sha: string }>
  }
  spawn: Mock<InstallSpawn>
  env: NodeJS.ProcessEnv
}> => {
  const prefix = await realpath(await mkdtemp(join(tmpdir(), 'restored-verification-')))
  roots.push(prefix)
  const name = language === 'python' ? 'python' : 'r-base'
  const version = runtimeVersion ?? (language === 'python' ? '3.12.13' : '4.4.3')
  const archive = `${name}-${version}-test_0.conda`
  const record = {
    name,
    version,
    build: 'test_0',
    url: `https://repo.example.test/${archive}`,
    md5: '1'.repeat(32)
  }
  const recordPath = join(prefix, 'conda-meta', archive.replace('.conda', '.json'))
  await mkdir(join(prefix, 'conda-meta'))
  await writeFile(recordPath, JSON.stringify(record))
  const content =
    language === 'python'
      ? `example==1.0 --hash=sha256:${'a'.repeat(64)}\n`
      : JSON.stringify({
          Packages: {
            Example: {
              Version: '1.0',
              Source: 'GitHub',
              RemoteType: 'github',
              RemoteHost: 'api.github.com',
              RemoteUsername: 'owner',
              RemoteRepo: 'repo',
              RemoteSha: 'a'.repeat(40)
            }
          }
        })
  const lock: NotebookEnvironmentLock = {
    schemaVersion: 1,
    format: 'environment-lock-bundle',
    kernelKind: language,
    environmentName: `default-${language}`,
    untrackedPackages: [`${language}:example`],
    components: [
      {
        ecosystem: 'conda',
        format: 'conda-explicit-md5',
        resolution: 'locked',
        explicitLock: `@EXPLICIT\n${record.url}#${record.md5}\n`,
        packages: [name, language === 'python' ? 'pip' : 'r-renv']
      },
      {
        ...(language === 'python'
          ? { ecosystem: 'python' as const, format: 'pip-requirements' as const }
          : { ecosystem: 'r' as const, format: 'renv-lock' as const }),
        resolution: 'locked',
        files: [
          {
            path: language === 'python' ? 'requirements.lock' : 'renv.lock',
            checksum: createHash('sha256').update(content).digest('hex'),
            content
          }
        ]
      }
    ]
  }
  const observed = {
    version,
    root: prefix,
    packages: [
      {
        name: language === 'python' ? 'example' : 'Example',
        version: '1.0',
        path: join(prefix, 'library', 'example'),
        sha: 'a'.repeat(40)
      }
    ]
  }
  const spawn = vi.fn<InstallSpawn>(async () => ({
    code: 0,
    stdout: JSON.stringify(observed),
    stderr: ''
  }))
  return { prefix, lock, record, recordPath, observed, spawn, env: {} }
}

describe('restored environment metadata verification', () => {
  it.each(['uv-lock', 'poetry-lock'] as const)(
    'does not require the intentionally omitted project root from a %s',
    async (format) => {
      const input = await fixture()
      const tool = format === 'uv-lock' ? 'uv' : 'poetry'
      input.lock.components[0] = {
        ecosystem: 'conda',
        format: 'conda-explicit-md5',
        resolution: 'locked',
        explicitLock: `@EXPLICIT\n${input.record.url}#${input.record.md5}\n`,
        packages: ['python', tool]
      }
      const content =
        '[[package]]\nname = "analysis-project"\nversion = "0.1.0"\n[[package]]\nname = "example"\nversion = "1.0"\n'
      input.lock.components[1] = {
        ecosystem: 'python',
        format,
        resolution: 'locked',
        files: [
          {
            path: `${tool}.lock`,
            checksum: createHash('sha256').update(content).digest('hex'),
            content
          }
        ]
      }
      await expect(verifyRestoredEnvironment(input)).resolves.toBeUndefined()
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_TEST_R_ENV)(
    'runs the R metadata probe against a temporary package library without loading its code',
    async () => {
      const input = await fixture('r')
      const library = join(input.prefix, 'library')
      const pkg = join(library, 'Example')
      await mkdir(pkg, { recursive: true })
      await writeFile(
        join(pkg, 'DESCRIPTION'),
        `Package: Example\nVersion: 1.0\nRemoteSha: ${'a'.repeat(40)}\n`
      )
      await writeFile(join(pkg, 'NAMESPACE'), 'stop("must not load package code")\n')
      const spawn: InstallSpawn = async (_command, args) => {
        // The host interpreter supplies base R/jsonlite; only runtime identity is a fixture.
        const script = `R.home <- function(...) ${JSON.stringify(input.prefix)}; getRversion <- function() package_version("4.4.3"); .libPaths(c(${JSON.stringify(library)},.libPaths()));\n${args.at(-1)}`
        const { stdout, stderr } = await promisify(execFile)(
          rScriptBin(process.env.OPEN_SCIENCE_TEST_R_ENV!),
          ['--vanilla', '--slave', '-e', script],
          { timeout: 15000 }
        )
        return { code: 0, stdout, stderr }
      }
      await expect(verifyRestoredEnvironment({ ...input, spawn })).resolves.toBeUndefined()
      await writeFile(
        join(pkg, 'DESCRIPTION'),
        `Package: Example\nVersion: 1.0\nRemoteSha: ${'b'.repeat(40)}\n`
      )
      await expect(verifyRestoredEnvironment({ ...input, spawn })).rejects.toThrow(
        'source revision'
      )
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'verifies real Python distribution metadata in an isolated venv without importing the package',
    async () => {
      const execute = promisify(execFile)
      const python = process.env.OPEN_SCIENCE_TEST_PYTHON!
      const { stdout: version } = await execute(python, [
        '-I',
        '-c',
        'import platform; print(platform.python_version())'
      ])
      const input = await fixture('python', version.trim())
      await execute(python, ['-I', '-m', 'venv', '--without-pip', input.prefix])
      const venvPython = join(
        input.prefix,
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      )
      const { stdout: library } = await execute(venvPython, [
        '-I',
        '-c',
        'import sysconfig; print(sysconfig.get_path("purelib"))'
      ])
      const metadata = join(library.trim(), 'example-1.0.dist-info')
      await mkdir(metadata)
      await writeFile(
        join(metadata, 'METADATA'),
        'Metadata-Version: 2.1\nName: example\nVersion: 1.0\n'
      )
      await writeFile(
        join(library.trim(), 'example.py'),
        'raise RuntimeError("must not import this scientific package")\n'
      )
      const spawn: InstallSpawn = (_command, args, env, ...rest) =>
        defaultSpawn(venvPython, args, env, ...rest)
      await expect(
        verifyRestoredEnvironment({ ...input, env: process.env, spawn })
      ).resolves.toBeUndefined()
      await writeFile(
        join(metadata, 'METADATA'),
        'Metadata-Version: 2.1\nName: example\nVersion: 2.0\n'
      )
      await expect(
        verifyRestoredEnvironment({ ...input, env: process.env, spawn })
      ).rejects.toThrow('version or location')
    }
  )
  it.each(['python', 'r'] as const)(
    'checks %s installation identity without importing scientific packages',
    async (language) => {
      const input = await fixture(language)
      await expect(verifyRestoredEnvironment(input)).resolves.toBeUndefined()
      expect(input.spawn).toHaveBeenCalledOnce()
      const args = input.spawn.mock.calls[0]
      expect(args[1].join(' ')).toContain(language === 'python' ? 'importlib.metadata' : 'read.dcf')
      expect(args[1].join(' ')).not.toContain(
        language === 'python' ? 'import example' : 'library(Example)'
      )
    }
  )

  it.each(['version', 'md5', 'url'] as const)(
    'rejects a changed Conda %s before starting a probe',
    async (field) => {
      const input = await fixture()
      await writeFile(
        input.recordPath,
        JSON.stringify({
          ...input.record,
          [field]: field === 'url' ? 'https://other.test/python.conda' : 'changed'
        })
      )
      await expect(verifyRestoredEnvironment(input)).rejects.toThrow('captured identity')
      expect(input.spawn).not.toHaveBeenCalled()
    }
  )

  it.each(['python', 'r'] as const)(
    'rejects %s package version, path, and missing-inventory drift',
    async (language) => {
      for (const drift of ['version', 'path', 'missing', 'runtime'] as const) {
        const input = await fixture(language)
        if (drift === 'version') input.observed.packages[0].version = '2.0'
        if (drift === 'path')
          input.observed.packages[0].path = join(input.prefix, '..', 'host-library')
        if (drift === 'missing') input.observed.packages = []
        if (drift === 'runtime') input.observed.version = '0.0'
        await expect(verifyRestoredEnvironment(input)).rejects.toThrow(/does not match|incomplete/)
      }
    }
  )

  it('rejects an R GitHub package restored from a different commit', async () => {
    const input = await fixture('r')
    input.observed.packages[0].sha = 'b'.repeat(40)
    await expect(verifyRestoredEnvironment(input)).rejects.toThrow('source revision')
  })

  it('rejects oversized metadata and truncated probes', async () => {
    const input = await fixture()
    await writeFile(input.recordPath, ' '.repeat(4 * 1024 * 1024 + 1))
    await expect(verifyRestoredEnvironment(input)).rejects.toThrow('limits')
    await writeFile(input.recordPath, JSON.stringify(input.record))
    await expect(
      verifyRestoredEnvironment({
        ...input,
        spawn: async () => ({
          code: 0,
          stdout: JSON.stringify(input.observed),
          stderr: '',
          stdoutDroppedBytes: 1
        })
      })
    ).rejects.toThrow('output limit')
  })

  it('preserves cancellation from the metadata probe', async () => {
    const input = await fixture()
    const controller = new AbortController()
    const reason = new Error('cancelled while inspecting packages')
    await expect(
      verifyRestoredEnvironment({
        ...input,
        signal: controller.signal,
        spawn: async () => {
          controller.abort(reason)
          return { code: 0, stdout: JSON.stringify(input.observed), stderr: '' }
        }
      })
    ).rejects.toBe(reason)
  })
})
