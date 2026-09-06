import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  createWslFilesystemSpikeFixture,
  durableFixturePaths,
  probeWslFilesystemSandboxReuse,
  WslFixtureBusyError,
  WslFixtureCleanupError,
  wslGuestArguments,
  type WslFilesystemSpikeFixtureFactory,
  type WslFilesystemSpikeFixtureOperations,
  type WslGuestCommandRunner
} from '../runtime/src/platform/wsl-filesystem-spike.js'

const workspace = 'C:\\Open Science\\Workspace 路径'
const request = { workspace, distro: 'Ubuntu-22.04', user: 'open-science-spike' } as const
const createFixture = vi.fn<WslFilesystemSpikeFixtureFactory>().mockResolvedValue({
  workspace,
  readWriteRoot: `${workspace}\\spike\\Allowed RW 路径`,
  readOnlyRoot: `${workspace}\\spike\\Allowed RO CaseProbe`,
  unauthorizedRoot: 'C:\\Temp\\secret',
  cleanup: async () => undefined
})

const realFixtureOperations = (
  isProcessAlive: (pid: number) => boolean
): WslFilesystemSpikeFixtureOperations => ({
  mkdir,
  readFile,
  writeFile,
  copyFile: async (_source, destination) => writeFile(destination, 'windows executable fixture'),
  link,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  isProcessAlive,
  processStartIdentity: (pid) => (pid === process.pid ? 'test-process-start' : undefined)
})

describe('WSL filesystem sandbox reuse capability', () => {
  it('flushes the exclusive owner journal before creating any root and fails closed on write failure', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-journal-flush-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => false)
    const writeFailure = new Error('injected durable journal write failure')
    const writeFileSpy = vi.fn(operations.writeFile).mockRejectedValueOnce(writeFailure)
    const linkSpy = vi.fn(operations.link)
    try {
      await expect(
        createWslFilesystemSpikeFixture(fixtureWorkspace, {
          ...operations,
          writeFile: writeFileSpy,
          link: linkSpy
        })
      ).rejects.toBeInstanceOf(WslFixtureBusyError)

      expect(writeFileSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\.open-science-wsl-spike-owner\.json\.claim-[0-9a-f-]{36}$/u),
        expect.any(String),
        {
          encoding: 'utf8',
          flag: 'wx',
          flush: true
        }
      )
      expect(linkSpy).not.toHaveBeenCalled()
      await expect(access(paths.fixtureRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(paths.secretRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('does not publish a malformed final journal when the staged claim write crashes', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-journal-partial-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => false)
    const crashingOperations: WslFilesystemSpikeFixtureOperations = {
      ...operations,
      writeFile: async (path, data, options) => {
        if (String(path).includes('.open-science-wsl-spike-owner.json.claim-')) {
          await writeFile(path, '{"schema":', options)
          throw new Error('injected mid-write crash')
        }
        await operations.writeFile(path, data, options)
      }
    }
    try {
      await expect(
        createWslFilesystemSpikeFixture(fixtureWorkspace, crashingOperations)
      ).rejects.toBeInstanceOf(WslFixtureBusyError)
      await expect(access(paths.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        (await readdir(fixtureWorkspace)).filter((entry) => entry.includes('.claim-'))
      ).toEqual([])
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('retries transient Windows sharing violations while committing journal transitions', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-journal-retry-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => true)
    let transientFailures = 2
    let transitionWrites = 0
    const retryingOperations: WslFilesystemSpikeFixtureOperations = {
      ...operations,
      writeFile: async (path, data, options) => {
        if (
          path === paths.journalPath &&
          typeof options === 'object' &&
          options !== null &&
          'flag' in options &&
          options.flag === 'w'
        ) {
          transitionWrites += 1
          if (transientFailures > 0) {
            transientFailures -= 1
            throw Object.assign(new Error('injected Windows sharing violation'), { code: 'EPERM' })
          }
        }
        await operations.writeFile(path, data, options)
      }
    }
    try {
      const fixture = await createWslFilesystemSpikeFixture(fixtureWorkspace, retryingOperations)
      await fixture.cleanup()
      expect(transitionWrites).toBeGreaterThan(2)
      await expect(access(paths.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(`${paths.journalPath}.pending`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('recovers a flushed pending transition when the final journal is interrupted', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-journal-pending-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    try {
      await createWslFilesystemSpikeFixture(
        fixtureWorkspace,
        realFixtureOperations(() => true)
      )
      const durableState = await readFile(paths.journalPath, 'utf8')
      await writeFile(`${paths.journalPath}.pending`, durableState, {
        encoding: 'utf8',
        flag: 'wx',
        flush: true
      })
      await writeFile(paths.journalPath, '{"schema":', 'utf8')

      const recovered = await createWslFilesystemSpikeFixture(
        fixtureWorkspace,
        realFixtureOperations(() => false)
      )
      await recovered.cleanup()
      for (const path of [
        paths.fixtureRoot,
        paths.secretRoot,
        paths.journalPath,
        `${paths.journalPath}.pending`
      ]) {
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('passes distro and user as inert wsl.exe argument values before --exec', () => {
    expect(
      wslGuestArguments({
        distro: 'Ubuntu-22.04 & calc.exe',
        user: 'open-science-spike; id',
        args: ['/bin/sh', '-c', 'printf safe']
      })
    ).toEqual([
      '--distribution',
      'Ubuntu-22.04 & calc.exe',
      '--user',
      'open-science-spike; id',
      '--exec',
      '/bin/sh',
      '-c',
      'printf safe'
    ])
  })

  it('rejects an empty explicit profile without starting WSL', async () => {
    const runGuest = vi.fn<WslGuestCommandRunner>()

    await expect(
      probeWslFilesystemSandboxReuse({ ...request, user: '   ' }, { runGuest })
    ).resolves.toEqual({ kind: 'unavailable', code: 'wsl_profile_invalid', phase: 'profile' })
    expect(runGuest).not.toHaveBeenCalled()
  })

  it('rejects paths outside the first-version local drive scope without starting WSL', async () => {
    const runGuest = vi.fn<WslGuestCommandRunner>()

    await expect(
      probeWslFilesystemSandboxReuse(
        { ...request, workspace: '\\\\server\\share\\workspace' },
        { runGuest }
      )
    ).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_path_unsupported',
      phase: 'host-path'
    })
    expect(runGuest).not.toHaveBeenCalled()
  })

  it('distinguishes a missing WSL launcher from an unavailable distribution', async () => {
    const missingLauncher = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
    const runGuest = vi.fn<WslGuestCommandRunner>().mockRejectedValue(missingLauncher)

    await expect(probeWslFilesystemSandboxReuse(request, { runGuest })).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_platform_unavailable',
      phase: 'wsl-launch'
    })
  })

  it('fails closed with a stable result when bubblewrap is missing', async () => {
    const runGuest = vi.fn<WslGuestCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;bwrap=0;unshare=1;namespace=1\n',
      stderr: 'localized host warning that must not escape'
    })

    await expect(probeWslFilesystemSandboxReuse(request, { runGuest })).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_bwrap_missing',
      phase: 'guest-prerequisite'
    })
  })

  it('fails closed when user namespaces cannot be created', async () => {
    const runGuest = vi.fn<WslGuestCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;bwrap=1;unshare=1;namespace=0\n',
      stderr: ''
    })

    await expect(probeWslFilesystemSandboxReuse(request, { runGuest })).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_namespace_unavailable',
      phase: 'guest-prerequisite'
    })
  })

  it('rejects a root guest user with a stable capability code', async () => {
    const runGuest = vi.fn<WslGuestCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout:
        'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;uid=0;nonroot=0;bwrap=1;unshare=1;namespace=1\nOPEN_SCIENCE_WSL_HOME_HEX:2f726f6f74\n',
      stderr: ''
    })

    await expect(probeWslFilesystemSandboxReuse(request, { runGuest })).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_root_user_unsupported',
      phase: 'guest-prerequisite'
    })
  })

  it('rejects a guest home marker containing invalid UTF-8 bytes', async () => {
    const runGuest = vi.fn<WslGuestCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout:
        'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;uid=1000;nonroot=1;bwrap=1;unshare=1;namespace=1\nOPEN_SCIENCE_WSL_HOME_HEX:c328\n',
      stderr: ''
    })

    await expect(probeWslFilesystemSandboxReuse(request, { runGuest })).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_home_unsupported',
      phase: 'guest-prerequisite'
    })
  })

  it('classifies fixture setup rollback failures as incomplete cleanup', async () => {
    const runGuest = vi.fn<WslGuestCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout:
        'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;uid=1000;nonroot=1;bwrap=1;unshare=1;namespace=1\nOPEN_SCIENCE_WSL_HOME_HEX:2f686f6d652f7370696b65\n',
      stderr: ''
    })
    const operations = {
      mkdir: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('fixture setup failed')),
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      writeFile: vi.fn().mockResolvedValue(undefined),
      link: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn(),
      rm: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('rollback failed')),
      unlink: vi.fn(),
      isProcessAlive: vi.fn().mockReturnValue(false),
      processStartIdentity: vi.fn().mockReturnValue('test-process-start')
    } as unknown as WslFilesystemSpikeFixtureOperations
    const setupFixture: WslFilesystemSpikeFixtureFactory = (fixtureWorkspace) =>
      createWslFilesystemSpikeFixture(fixtureWorkspace, operations)

    const result = await probeWslFilesystemSandboxReuse(request, {
      runGuest,
      createFixture: setupFixture
    })

    expect(result).toEqual({
      kind: 'unavailable',
      code: 'wsl_cleanup_incomplete',
      phase: 'cleanup'
    })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(operations.rm).toHaveBeenCalledTimes(1)
    expect(operations.unlink).not.toHaveBeenCalled()
  })

  it('reconciles a crashed owner before acquiring the deterministic fixture', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-crash-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    try {
      await createWslFilesystemSpikeFixture(
        fixtureWorkspace,
        realFixtureOperations(() => true)
      )
      const recovered = await createWslFilesystemSpikeFixture(
        fixtureWorkspace,
        realFixtureOperations(() => false)
      )
      await recovered.cleanup()

      for (const path of [paths.fixtureRoot, paths.secretRoot, paths.journalPath]) {
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('reconciles a pre-marker fixture staging crash without touching an unowned canonical root', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-staging-crash-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const ownerId = '11111111-1111-4111-8111-111111111111'
    const fixtureStaging = `${paths.fixtureRoot}.staging-${ownerId}`
    const fixtureQuarantine = `${paths.fixtureRoot}.quarantine-${ownerId}`
    const secretStaging = `${paths.secretRoot}.staging-${ownerId}`
    const secretQuarantine = `${paths.secretRoot}.quarantine-${ownerId}`
    try {
      await mkdir(fixtureStaging)
      const fixtureStat = await stat(fixtureStaging)
      await writeFile(
        paths.journalPath,
        JSON.stringify({
          schema: 1,
          ownerId,
          pid: 424242,
          processStartIdentity: 'crashed-process-start',
          heartbeatAtMs: 0,
          fixtureRoot: paths.fixtureRoot,
          secretRoot: paths.secretRoot,
          cleanupRoots: {
            fixture: {
              root: paths.fixtureRoot,
              stagingPath: fixtureStaging,
              quarantinePath: fixtureQuarantine,
              state: 'staging',
              identity: {
                dev: fixtureStat.dev,
                ino: fixtureStat.ino,
                birthtimeMs: fixtureStat.birthtimeMs
              }
            },
            secret: {
              root: paths.secretRoot,
              stagingPath: secretStaging,
              quarantinePath: secretQuarantine,
              state: 'absent'
            }
          }
        }),
        'utf8'
      )
      await mkdir(paths.fixtureRoot)
      await writeFile(join(paths.fixtureRoot, 'user-data.txt'), 'preserve', 'utf8')

      await expect(
        createWslFilesystemSpikeFixture(
          fixtureWorkspace,
          realFixtureOperations(() => false)
        )
      ).rejects.toBeDefined()

      await expect(access(fixtureStaging)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(paths.fixtureRoot, 'user-data.txt'), 'utf8')).resolves.toBe(
        'preserve'
      )
      await expect(access(paths.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        (await readdir(fixtureWorkspace)).filter((entry) =>
          entry.startsWith('.open-science-wsl-spike-fixture.staging-')
        )
      ).toEqual([])
      expect(
        (await readdir(tmpdir())).filter((entry) =>
          entry.startsWith(`${basename(paths.secretRoot)}.staging-`)
        )
      ).toEqual([])
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
      await rm(fixtureStaging, { recursive: true, force: true })
    }
  })

  it('reconciles a pre-marker secret staging crash and leaves zero owned residue', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-secret-staging-crash-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const ownerId = '22222222-2222-4222-8222-222222222222'
    const secretStaging = `${paths.secretRoot}.staging-${ownerId}`
    const secretQuarantine = `${paths.secretRoot}.quarantine-${ownerId}`
    const fixtureStaging = `${paths.fixtureRoot}.staging-${ownerId}`
    const fixtureQuarantine = `${paths.fixtureRoot}.quarantine-${ownerId}`
    try {
      await mkdir(secretStaging)
      const secretStat = await stat(secretStaging)
      await writeFile(
        paths.journalPath,
        JSON.stringify({
          schema: 1,
          ownerId,
          pid: 424242,
          processStartIdentity: 'crashed-process-start',
          heartbeatAtMs: 0,
          fixtureRoot: paths.fixtureRoot,
          secretRoot: paths.secretRoot,
          cleanupRoots: {
            fixture: {
              root: paths.fixtureRoot,
              stagingPath: fixtureStaging,
              quarantinePath: fixtureQuarantine,
              state: 'absent'
            },
            secret: {
              root: paths.secretRoot,
              stagingPath: secretStaging,
              quarantinePath: secretQuarantine,
              state: 'staging',
              identity: {
                dev: secretStat.dev,
                ino: secretStat.ino,
                birthtimeMs: secretStat.birthtimeMs
              }
            }
          }
        }),
        'utf8'
      )

      const recovered = await createWslFilesystemSpikeFixture(
        fixtureWorkspace,
        realFixtureOperations(() => false)
      )
      await recovered.cleanup()
      await expect(access(secretStaging)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(paths.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
      await rm(secretStaging, { recursive: true, force: true })
    }
  })

  it('does not reconcile an active concurrent fixture lease', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-active-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => true)
    try {
      const active = await createWslFilesystemSpikeFixture(fixtureWorkspace, operations)
      await expect(
        createWslFilesystemSpikeFixture(fixtureWorkspace, operations)
      ).rejects.toBeInstanceOf(WslFixtureBusyError)
      expect(
        (await readdir(fixtureWorkspace)).filter((entry) => entry.includes('.claim-'))
      ).toEqual([])
      await active.cleanup()
      await active.cleanup()
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('uses a fresh heartbeat to fence a live process whose start identity is unavailable', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-live-unknown-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations: WslFilesystemSpikeFixtureOperations = {
      ...realFixtureOperations(() => true),
      processStartIdentity: () => undefined
    }
    try {
      const active = await createWslFilesystemSpikeFixture(fixtureWorkspace, operations)
      await expect(
        createWslFilesystemSpikeFixture(fixtureWorkspace, operations)
      ).rejects.toBeInstanceOf(WslFixtureBusyError)
      await active.cleanup()
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('does not treat a reused live pid with a different process start identity as active', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-pid-reuse-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    let processStartIdentity = 'process-start-a'
    const operations: WslFilesystemSpikeFixtureOperations = {
      ...realFixtureOperations(() => true),
      processStartIdentity: () => processStartIdentity
    }
    try {
      await createWslFilesystemSpikeFixture(fixtureWorkspace, operations)
      processStartIdentity = 'process-start-b'
      const recovered = await createWslFilesystemSpikeFixture(fixtureWorkspace, operations)
      await recovered.cleanup()

      for (const path of [paths.fixtureRoot, paths.secretRoot, paths.journalPath]) {
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('recovers an identity-matching lease whose heartbeat is stale', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-stale-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => true)
    try {
      await createWslFilesystemSpikeFixture(fixtureWorkspace, operations)
      const journal = JSON.parse(await readFile(paths.journalPath, 'utf8')) as Record<
        string,
        unknown
      >
      await writeFile(paths.journalPath, JSON.stringify({ ...journal, heartbeatAtMs: 0 }), 'utf8')
      const recovered = await createWslFilesystemSpikeFixture(fixtureWorkspace, operations)
      await recovered.cleanup()
      await expect(access(paths.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('preserves a staging path replaced after its identity was journaled', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-staging-replaced-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => false)
    let replacementPath: string | undefined
    const replacingOperations: WslFilesystemSpikeFixtureOperations = {
      ...operations,
      writeFile: async (path, data, options) => {
        const markerPath = String(path)
        if (
          !replacementPath &&
          markerPath.includes('.staging-') &&
          markerPath.endsWith('.open-science-owner.json')
        ) {
          replacementPath = dirname(markerPath)
          await rm(replacementPath, { recursive: true, force: true })
          await mkdir(replacementPath)
          await writeFile(join(replacementPath, 'user-data.txt'), 'replacement', 'utf8')
          throw new Error('injected staging replacement')
        }
        await operations.writeFile(path, data, options)
      }
    }
    try {
      await expect(
        createWslFilesystemSpikeFixture(fixtureWorkspace, replacingOperations)
      ).rejects.toBeInstanceOf(WslFixtureCleanupError)
      expect(replacementPath).toBeDefined()
      await expect(readFile(join(replacementPath!, 'user-data.txt'), 'utf8')).resolves.toBe(
        'replacement'
      )
      await expect(access(paths.journalPath)).resolves.toBeUndefined()
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
      if (replacementPath) await rm(replacementPath, { recursive: true, force: true })
    }
  })

  it('keeps a canonical replacement created after atomic quarantine', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-race-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => true)
    let replacementCreated = false
    const racingOperations: WslFilesystemSpikeFixtureOperations = {
      ...operations,
      rename: async (source, destination) => {
        await operations.rename(source, destination)
        if (!replacementCreated && source === paths.fixtureRoot) {
          replacementCreated = true
          await mkdir(paths.fixtureRoot)
          await writeFile(join(paths.fixtureRoot, 'user-data.txt'), 'replacement', 'utf8')
        }
      }
    }
    try {
      const fixture = await createWslFilesystemSpikeFixture(fixtureWorkspace, racingOperations)
      await fixture.cleanup()

      await expect(readFile(join(paths.fixtureRoot, 'user-data.txt'), 'utf8')).resolves.toBe(
        'replacement'
      )
      await expect(access(paths.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('retries a journal-fenced quarantine after partial rm removes its internal marker', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-retry-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => true)
    let failFixtureRemoval = true
    const retryingOperations: WslFilesystemSpikeFixtureOperations = {
      ...operations,
      rm: async (path, options) => {
        if (
          failFixtureRemoval &&
          String(path).startsWith(`${paths.fixtureRoot}.quarantine-`) &&
          String(path) !== paths.fixtureRoot
        ) {
          failFixtureRemoval = false
          const quarantineRoot = dirname(String(path))
          await rm(join(quarantineRoot, '.open-science-owner.json'), { force: true })
          await rm(join(quarantineRoot, 'Allowed RW 路径'), { recursive: true, force: true })
          throw new Error('injected fixture quarantine removal failure')
        }
        await operations.rm(path, options)
      }
    }
    try {
      const fixture = await createWslFilesystemSpikeFixture(fixtureWorkspace, retryingOperations)
      const journal = JSON.parse(await readFile(paths.journalPath, 'utf8')) as { ownerId: string }
      const fixtureQuarantine = `${paths.fixtureRoot}.quarantine-${journal.ownerId}`

      await expect(fixture.cleanup()).rejects.toBeInstanceOf(WslFixtureCleanupError)
      await expect(access(paths.journalPath)).resolves.toBeUndefined()
      await expect(access(fixtureQuarantine)).resolves.toBeUndefined()
      const failedJournal = JSON.parse(await readFile(paths.journalPath, 'utf8')) as {
        cleanupRoots: { fixture: { quarantinePath: string; state: string } }
      }
      expect(failedJournal.cleanupRoots.fixture).toMatchObject({
        root: paths.fixtureRoot,
        quarantinePath: fixtureQuarantine,
        state: 'quarantined'
      })
      await expect(
        access(join(fixtureQuarantine, '.open-science-owner.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await mkdir(paths.fixtureRoot)
      await writeFile(join(paths.fixtureRoot, 'user-data.txt'), 'replacement', 'utf8')
      await fixture.cleanup()

      await expect(readFile(join(paths.fixtureRoot, 'user-data.txt'), 'utf8')).resolves.toBe(
        'replacement'
      )

      for (const path of [paths.secretRoot, paths.journalPath, fixtureQuarantine]) {
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('preserves a quarantine path replaced after a partial cleanup failure', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-quarantine-replaced-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => true)
    let replacementPath: string | undefined
    const replacingOperations: WslFilesystemSpikeFixtureOperations = {
      ...operations,
      rm: async (path, options) => {
        const candidate = String(path)
        if (!replacementPath && candidate.startsWith(`${paths.fixtureRoot}.quarantine-`)) {
          replacementPath = dirname(candidate)
          await rm(join(replacementPath, '.open-science-owner.json'), { force: true })
          await rm(replacementPath, { recursive: true, force: true })
          await mkdir(replacementPath)
          await writeFile(join(replacementPath, 'user-data.txt'), 'replacement', 'utf8')
          throw new Error('injected quarantine replacement')
        }
        await operations.rm(path, options)
      }
    }
    try {
      const fixture = await createWslFilesystemSpikeFixture(fixtureWorkspace, replacingOperations)
      await expect(fixture.cleanup()).rejects.toBeInstanceOf(WslFixtureCleanupError)
      await expect(fixture.cleanup()).rejects.toBeInstanceOf(WslFixtureCleanupError)
      expect(replacementPath).toBeDefined()
      await expect(readFile(join(replacementPath!, 'user-data.txt'), 'utf8')).resolves.toBe(
        'replacement'
      )
      await expect(access(paths.journalPath)).resolves.toBeUndefined()
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
      if (replacementPath) await rm(replacementPath, { recursive: true, force: true })
    }
  })

  it('preserves an unowned canonical directory and removes only its own journal', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-unowned-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    try {
      await mkdir(paths.fixtureRoot)
      await writeFile(join(paths.fixtureRoot, 'user-data.txt'), 'preserve', 'utf8')

      await expect(
        createWslFilesystemSpikeFixture(
          fixtureWorkspace,
          realFixtureOperations(() => false)
        )
      ).rejects.toBeDefined()
      await expect(readFile(join(paths.fixtureRoot, 'user-data.txt'), 'utf8')).resolves.toBe(
        'preserve'
      )
      await expect(access(paths.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        (await readdir(fixtureWorkspace)).filter((entry) =>
          entry.startsWith('.open-science-wsl-spike-fixture.staging-')
        )
      ).toEqual([])
      expect(
        (await readdir(tmpdir())).filter((entry) =>
          entry.startsWith(`${basename(paths.secretRoot)}.staging-`)
        )
      ).toEqual([])
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('preserves a canonical root replaced after its owner crashed', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-replaced-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    try {
      await createWslFilesystemSpikeFixture(
        fixtureWorkspace,
        realFixtureOperations(() => true)
      )
      await rm(paths.fixtureRoot, { recursive: true, force: true })
      await mkdir(paths.fixtureRoot)
      await writeFile(join(paths.fixtureRoot, 'user-data.txt'), 'replacement', 'utf8')

      await expect(
        createWslFilesystemSpikeFixture(
          fixtureWorkspace,
          realFixtureOperations(() => false)
        )
      ).rejects.toBeDefined()
      await expect(readFile(join(paths.fixtureRoot, 'user-data.txt'), 'utf8')).resolves.toBe(
        'replacement'
      )
      await expect(access(paths.secretRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(paths.journalPath)).resolves.toBeUndefined()
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('preserves a canonical root replaced during setup rollback', async () => {
    const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'open-science-fixture-setup-replaced-'))
    const paths = durableFixturePaths(fixtureWorkspace)
    const operations = realFixtureOperations(() => false)
    let replaced = false
    const replacingOperations: WslFilesystemSpikeFixtureOperations = {
      ...operations,
      writeFile: async (path, data, options) => {
        if (!replaced && String(path).endsWith('input.txt')) {
          replaced = true
          await rm(paths.fixtureRoot, { recursive: true, force: true })
          await mkdir(paths.fixtureRoot)
          await writeFile(join(paths.fixtureRoot, 'user-data.txt'), 'replacement', 'utf8')
          throw new Error('later fixture setup failure')
        }
        await operations.writeFile(path, data, options)
      }
    }
    try {
      await expect(
        createWslFilesystemSpikeFixture(fixtureWorkspace, replacingOperations)
      ).rejects.toBeInstanceOf(WslFixtureCleanupError)
      await expect(readFile(join(paths.fixtureRoot, 'user-data.txt'), 'utf8')).resolves.toBe(
        'replacement'
      )
      await expect(access(paths.secretRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(paths.journalPath)).resolves.toBeUndefined()
    } finally {
      await rm(fixtureWorkspace, { recursive: true, force: true })
      await rm(paths.secretRoot, { recursive: true, force: true })
    }
  })

  it('preserves a delimiter-bearing guest home without exposing host paths or guest output', async () => {
    const runGuest = vi
      .fn<WslGuestCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;uid=1000;nonroot=1;bwrap=1;unshare=1;namespace=1\nOPEN_SCIENCE_WSL_HOME_HEX:2f686f6d652f637573746f6d3b6e616d653d76616c7565\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/Open Science/Workspace 路径\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/Open Science/Workspace 路径/spike/Allowed RW 路径\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'OPEN_SCIENCE_WSL_PATH:/mnt/c/Open Science/Workspace 路径/spike/Allowed RO CaseProbe\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/Temp/secret\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'OPEN_SCIENCE_WSL_RESULT:rw_read=1;rw_write=1;ro_read=1;ro_write_blocked=1;unauthorized_hidden=1;home_hidden=1;mount_hidden=1;media_hidden=1;interop_blocked=1;unicode_space=1;case=insensitive\n',
        stderr: ''
      })

    const result = await probeWslFilesystemSandboxReuse(request, { runGuest, createFixture })

    expect(result).toEqual({
      kind: 'ready',
      code: 'wsl_filesystem_sandbox_reusable',
      evidence: {
        architecture: 'x86_64',
        authorizedRead: true,
        authorizedWrite: true,
        readOnlyWriteBlocked: true,
        unauthorizedReadBlocked: true,
        sensitiveMountsHidden: true,
        windowsInteropBlocked: true,
        unicodeAndSpacesSupported: true,
        caseBehavior: 'insensitive'
      }
    })
    expect(JSON.stringify(result)).not.toContain('Open Science')
    expect(JSON.stringify(result)).not.toContain('localized')
    const sandboxArgs = runGuest.mock.calls.at(-1)?.[0].args ?? []
    expect(sandboxArgs.join('\n')).toContain('interop-probe.exe')
    expect(sandboxArgs.join('\n')).toContain('/run/WSL')
    expect(sandboxArgs.at(-1)).toBe('/home/custom;name=value')
  })

  it('fails closed with a stable result when fixture cleanup is incomplete', async () => {
    const runGuest = vi
      .fn<WslGuestCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;uid=1000;nonroot=1;bwrap=1;unshare=1;namespace=1\nOPEN_SCIENCE_WSL_HOME_HEX:2f726f6f74\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/workspace\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/workspace/rw\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/workspace/ro\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/secret\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'OPEN_SCIENCE_WSL_RESULT:rw_read=1;rw_write=1;ro_read=1;ro_write_blocked=1;unauthorized_hidden=1;home_hidden=1;mount_hidden=1;media_hidden=1;interop_blocked=1;unicode_space=1;case=insensitive\n',
        stderr: ''
      })
    const cleanup = vi.fn().mockRejectedValue(new Error('C:\\private\\cleanup failure'))
    const failingFixture = vi.fn<WslFilesystemSpikeFixtureFactory>().mockResolvedValue({
      workspace,
      readWriteRoot: `${workspace}\\rw`,
      readOnlyRoot: `${workspace}\\ro`,
      unauthorizedRoot: 'C:\\private',
      cleanup
    })

    const result = await probeWslFilesystemSandboxReuse(request, {
      runGuest,
      createFixture: failingFixture
    })

    expect(result).toEqual({
      kind: 'unavailable',
      code: 'wsl_cleanup_incomplete',
      phase: 'cleanup'
    })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('reports an unreachable guest path without attempting the sandbox', async () => {
    const runGuest = vi
      .fn<WslGuestCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;uid=1000;nonroot=1;bwrap=1;unshare=1;namespace=1\nOPEN_SCIENCE_WSL_HOME_HEX:2f726f6f74\n',
        stderr: ''
      })
      .mockResolvedValueOnce({ exitCode: 73, stdout: '', stderr: 'localized path failure' })

    await expect(
      probeWslFilesystemSandboxReuse(request, { runGuest, createFixture })
    ).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_workspace_unreachable',
      phase: 'path-map'
    })
    expect(runGuest).toHaveBeenCalledTimes(2)
  })

  it('classifies a sandbox launch exception at the sandbox phase', async () => {
    const runGuest = vi
      .fn<WslGuestCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;uid=1000;nonroot=1;bwrap=1;unshare=1;namespace=1\nOPEN_SCIENCE_WSL_HOME_HEX:2f726f6f74\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/workspace\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/workspace/rw\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/workspace/ro\n',
        stderr: ''
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/secret\n',
        stderr: ''
      })
      .mockRejectedValueOnce(new Error('bounded launch failure'))

    await expect(
      probeWslFilesystemSandboxReuse(request, { runGuest, createFixture })
    ).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_sandbox_policy_failed',
      phase: 'sandbox'
    })
  })

  it('treats incomplete sandbox evidence as a stable failed-closed result', async () => {
    const runGuest = vi
      .fn<WslGuestCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'OPEN_SCIENCE_WSL_PROBE:arch=x86_64;uid=1000;nonroot=1;bwrap=1;unshare=1;namespace=1\nOPEN_SCIENCE_WSL_HOME_HEX:2f726f6f74\n',
        stderr: ''
      })
      .mockResolvedValue({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_WSL_PATH:/mnt/c/workspace\n',
        stderr: ''
      })

    await expect(
      probeWslFilesystemSandboxReuse(request, { runGuest, createFixture })
    ).resolves.toEqual({
      kind: 'unavailable',
      code: 'wsl_sandbox_policy_failed',
      phase: 'sandbox'
    })
  })
})
