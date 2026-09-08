import { EventEmitter } from 'node:events'
import { type spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { SettingsInstallCoordinator } from '../settings/settings-install-coordinator'
import {
  boundedWslDiagnosticText,
  RECOMMENDED_WSL_DISTRO,
  WSL_DISTRO_INSTALL_TIMEOUT_MS,
  WSL_SETUP_DIAGNOSTICS_STALE,
  WslSetupOwner,
  createWslTerminalLauncher,
  type WslCommandRunner,
  type WslPlatformInstaller,
  type WslTerminalLauncher
} from './wsl-setup-owner'
import type { WslSetupStatus } from '../../shared/wsl-setup'

const result = (
  stdout = '',
  exitCode = 0,
  stderr = '',
  failure?: 'not-found' | 'timeout'
): {
  stdout: string
  stderr: string
  exitCode: number
  failure?: 'not-found' | 'timeout'
} => ({ stdout, stderr, exitCode, ...(failure ? { failure } : {}) })

const makeRunner = (...responses: ReturnType<typeof result>[]): WslCommandRunner => ({
  run: vi.fn(async () => responses.shift() ?? result())
})

type OwnerOptions = ConstructorParameters<typeof WslSetupOwner>[0]
const makeOwner = (
  options: Omit<OwnerOptions, 'volumeProbe'> & Partial<Pick<OwnerOptions, 'volumeProbe'>>
): WslSetupOwner =>
  new WslSetupOwner({
    volumeProbe: async () => ({ kind: 'local-ntfs' }),
    loadGuide: async () => ({
      id: 'wsl2-setup',
      version: '1',
      status: 'available',
      markdown: '# test guide'
    }),
    windowsVersion: () => ({ version: '10.0.26100', build: '26100', architecture: 'x64' }),
    now: () => Date.UTC(2026, 8, 8),
    ...options
  })

describe('WslSetupOwner', () => {
  it('creates a privacy-safe support handoff from the current failed probe', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Distribution: Private-Lab'),
        result('Private-Lab'),
        result('* Private-Lab Running 2'),
        result('1001\nprivate-user\nhome-ok'),
        result('/usr/bin/bash', 0, 'raw stderr with credential=private-token')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Private-Lab', user: 'private-user' }),
      writeSelection: async () => undefined,
      operationReference: () => 'a1b2c3d4'
    })

    await owner.probe()
    const handoff = await owner.createSupportHandoff()

    expect(handoff).toMatchObject({
      schemaVersion: 1,
      guide: { id: 'wsl2-setup', version: '1', status: 'available' },
      capturedAt: '2026-09-08T00:00:00.000Z',
      revision: 1,
      errorCode: 'wsl_bwrap_missing',
      supportReference: 'a1b2c3d4',
      capabilities: { wsl2: true, home: true, bash: true, bwrap: false, python3: false },
      versions: { wsl: 'unknown', distribution: '2' },
      selectedTarget: { distro: 'Private-Lab', user: 'private-user' },
      checks: {
        wsl2: { state: 'pass' },
        home: { state: 'pass' },
        bash: { state: 'pass' },
        bwrap: { state: 'fail' },
        python3: { state: 'fail', path: '/usr/bin/python3' },
        mirroredNetworking: { state: 'not-checked' },
        namespaces: { state: 'not-checked' },
        localWorkspace: { state: 'not-checked' }
      },
      failure: {
        stage: 'dependencies',
        code: 'wsl_bwrap_missing',
        stderr: 'raw stderr with credential=[redacted]'
      },
      target: 'restore-wsl2-bash'
    })
    const serialized = JSON.stringify(handoff)
    expect(serialized).not.toContain('private-token')
    expect(serialized).not.toContain('C:\\science')
  })

  it('uses stable fallback diagnostics when no probe has completed yet', async () => {
    const owner = makeOwner({
      runner: makeRunner(result('', 1)),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'deadbeef'
    })

    await expect(owner.createSupportHandoff()).resolves.toMatchObject({
      schemaVersion: 1,
      revision: 0,
      errorCode: 'wsl_probe_required',
      supportReference: 'deadbeef',
      capabilities: {},
      versions: { wsl: 'unknown', distribution: 'unknown' },
      checks: { wsl2: { state: 'not-checked' } },
      target: 'restore-wsl2-bash'
    })
  })

  it('keeps the captured revision paired with its snapshot across concurrent refresh', async () => {
    let releaseGuide!: () => void
    const guideGate = new Promise<void>((resolve) => {
      releaseGuide = resolve
    })
    const loadGuide = vi.fn(async () => {
      await guideGate
      return {
        id: 'wsl2-setup' as const,
        version: '1' as const,
        status: 'available' as const,
        markdown: '# test guide'
      }
    })
    const runner: WslCommandRunner = {
      run: vi.fn(async (args: readonly string[]) => {
        if (args[0] === '--status') return result('Default Version: 2')
        if (args.join(' ') === '--list --quiet') return result('')
        if (args.join(' ') === '--list --verbose') return result('')
        if (args[0] === '--version') return result('WSL version: 2.7.13.0')
        return result()
      })
    }
    const owner = makeOwner({
      runner,
      loadGuide,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await owner.probe()
    const capturedRevision = owner.getStatus().revision

    const handoffPromise = owner.createSupportHandoff()
    await vi.waitFor(() => expect(loadGuide).toHaveBeenCalledOnce())
    await owner.probe()
    releaseGuide()
    const handoff = await handoffPromise

    expect(handoff.revision).toBe(capturedRevision)
    expect(owner.getStatus().revision).toBeGreaterThan(capturedRevision)
  })

  it('reports the WSL software version separately from distro generation', async () => {
    const runner: WslCommandRunner = {
      run: vi.fn(async (args: readonly string[]) => {
        if (args[0] === '--status') return result('Default Version: 2')
        if (args.join(' ') === '--list --quiet') return result('Ubuntu')
        if (args.join(' ') === '--list --verbose') return result('* Ubuntu Running 2')
        if (args[0] === '--version') return result('WSL version: 2.4.13.0\nKernel version: 5.15')
        const script = args.join(' ')
        if (script.includes('id -un; id -u')) return result('scientist\n1000')
        if (script.includes('id -u')) return result('1000\nscientist\nhome-ok')
        if (script.includes('command -v bash')) {
          return result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored')
        }
        if (script.includes('bwrap --unshare-all')) return result('ok')
        if (script.includes('guest_path=')) return result('/mnt/c/science\nok')
        if (script.includes('kernel=%s')) {
          return result(
            'kernel=5.15.167.4-microsoft-standard-WSL2\n' +
              'distroRelease=22.04\n' +
              'bash=GNU bash, version 5.1.16\n' +
              'bwrap=bubblewrap 0.6.2\n' +
              'python3=Python 3.10.12'
          )
        }
        return result()
      })
    }
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await owner.probe()
    await expect(owner.createSupportHandoff()).resolves.toMatchObject({
      wsl: {
        softwareVersion: '2.4.13.0',
        linuxKernelVersion: '5.15.167.4-microsoft-standard-WSL2'
      },
      distros: [
        {
          name: 'Ubuntu',
          version: 2,
          release: '22.04',
          defaultUser: 'scientist',
          defaultUserIsRoot: false
        }
      ],
      versions: { wsl: '2.4.13.0', distribution: '2' },
      checks: {
        bash: { state: 'pass', version: 'GNU bash, version 5.1.16' },
        bwrap: { state: 'pass', version: 'bubblewrap 0.6.2' },
        python3: { state: 'pass', version: 'Python 3.10.12', path: '/usr/bin/python3' },
        mirroredNetworking: { state: 'pass' }
      }
    })
  })

  it('parses the localized WSL software version line without using the kernel version', async () => {
    const runner: WslCommandRunner = {
      run: vi.fn(async (args: readonly string[]) => {
        if (args[0] === '--version') {
          return result('WSL 版本: 2.7.13.0\n内核版本: 6.6.87.2\nWSLg 版本: 1.0.70')
        }
        if (args[0] === '--status') return result('Default Version: 2')
        if (args.join(' ') === '--list --quiet') return result('')
        if (args.join(' ') === '--list --verbose') return result('')
        return result()
      })
    }
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })

    await owner.probe()
    await expect(owner.createSupportHandoff()).resolves.toMatchObject({
      wsl: { softwareVersion: '2.7.13.0' }
    })
  })

  it('keeps an in-progress platform installation observable outside its original caller', async () => {
    const installation = Promise.withResolvers<{ kind: 'uac-cancelled' }>()
    const owner = makeOwner({
      installer: { install: () => installation.promise },
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'install1'
    })

    const completion = owner.installPlatform()

    expect(owner.getStatus()).toMatchObject({
      operation: {
        state: 'running',
        kind: 'install-platform',
        phase: 'installing',
        operationReference: 'install1'
      }
    })

    installation.resolve({ kind: 'uac-cancelled' })
    await completion
  })

  it('rejects a stale profile selection inside the owner before persistence', async () => {
    const writeSelection = vi.fn()
    const owner = makeOwner({
      runner: makeRunner(result('', 1, '', 'not-found')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection
    })
    await owner.probe()

    await expect(
      owner.selectAtRevision({ distro: 'Ubuntu', user: 'scientist' }, 0)
    ).rejects.toThrow(WSL_SETUP_DIAGNOSTICS_STALE)
    expect(writeSelection).not.toHaveBeenCalled()
  })

  it('serializes revision-bound selections so a queued stale request cannot overwrite settings', async () => {
    const writes: Array<{ distro: string; user: string }> = []
    const runner: WslCommandRunner = {
      run: vi.fn(async (args: readonly string[]) => {
        if (args[0] === '--status') return result('Default Version: 2')
        if (args.join(' ') === '--list --quiet') return result('Ubuntu')
        if (args.join(' ') === '--list --verbose') return result('* Ubuntu Running 2')
        const command = args.join(' ')
        if (command.includes('id -u')) return result('1000\nscientist\nhome-ok')
        if (command.includes('command -v bash')) {
          return result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored')
        }
        if (command.includes('bwrap --unshare-all')) return result('ok')
        if (command.includes('guest_path=')) return result('/mnt/c/science\nok')
        return result()
      })
    }
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async (selection) => {
        writes.push(selection)
      }
    })
    const expectedRevision = owner.getStatus().revision

    const first = owner.selectAtRevision({ distro: 'Ubuntu', user: 'scientist' }, expectedRevision)
    const stale = owner.selectAtRevision({ distro: 'Ubuntu', user: 'other-user' }, expectedRevision)

    await expect(first).resolves.toMatchObject({ selection: { user: 'scientist' } })
    await expect(stale).rejects.toThrow(WSL_SETUP_DIAGNOSTICS_STALE)
    expect(writes).toEqual([{ distro: 'Ubuntu', user: 'scientist' }])
  })

  it('returns the live status after startup reconciliation has already completed', async () => {
    const installation = Promise.withResolvers<{ kind: 'uac-cancelled' }>()
    const journal = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }
    const owner = makeOwner({
      installer: { install: () => installation.promise },
      operationJournal: journal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'install1'
    })

    await owner.reconcileInterruptedOperation()
    const completion = owner.installPlatform()
    await vi.waitFor(() => expect(journal.save).toHaveBeenCalledOnce())

    await expect(owner.reconcileInterruptedOperation()).resolves.toMatchObject({
      operation: { state: 'running', operationReference: 'install1' }
    })

    installation.resolve({ kind: 'uac-cancelled' })
    await completion
  })

  it('publishes durable status transitions to observers while installation continues', async () => {
    const installation = Promise.withResolvers<{ kind: 'uac-cancelled' }>()
    const statuses: WslSetupStatus[] = []
    const owner = makeOwner({
      installer: { install: () => installation.promise },
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'install1',
      onStatusChanged: (status) => statuses.push(status)
    })

    const completion = owner.installPlatform()
    expect(statuses.at(-1)?.operation).toMatchObject({ state: 'running', phase: 'installing' })

    installation.resolve({ kind: 'uac-cancelled' })
    await completion
    expect(statuses.at(-1)?.operation).toMatchObject({
      state: 'finished',
      outcome: 'cancelled',
      operationReference: 'install1'
    })
    expect(statuses.at(-1)?.snapshot).toMatchObject({ errorCode: 'wsl_install_uac_cancelled' })
  })

  it('keeps a terminal installation result when an older probe finishes later', async () => {
    const staleStatus = Promise.withResolvers<ReturnType<typeof result>>()
    const installation = Promise.withResolvers<{ kind: 'uac-cancelled' }>()
    const references = ['probe1', 'install1']
    const owner = makeOwner({
      runner: {
        run: vi.fn(async (args) => (args[0] === '--status' ? staleStatus.promise : result()))
      },
      installer: { install: () => installation.promise },
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => references.shift() ?? 'later'
    })

    const staleProbe = owner.probe()
    const install = owner.installPlatform()
    installation.resolve({ kind: 'uac-cancelled' })
    await install
    staleStatus.resolve(result('', 1, '', 'not-found'))

    await expect(staleProbe).resolves.toMatchObject({
      errorCode: 'wsl_install_uac_cancelled',
      operationReference: 'install1'
    })
    expect(owner.getStatus().snapshot).toMatchObject({
      errorCode: 'wsl_install_uac_cancelled',
      operationReference: 'install1'
    })
  })

  it('does not let optional activation metadata strand a completed installation', async () => {
    const journal = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }
    const owner = makeOwner({
      installer: { install: async () => ({ kind: 'uac-cancelled' }) },
      operationJournal: journal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      readActivation: async () => Promise.reject(new Error('settings unavailable')),
      writeSelection: async () => undefined,
      operationReference: () => 'install1'
    })

    await expect(owner.installPlatform()).resolves.toMatchObject({
      outcome: 'uac-cancelled',
      snapshot: { errorCode: 'wsl_install_uac_cancelled' }
    })
    expect(owner.getStatus().operation).toMatchObject({
      state: 'finished',
      outcome: 'cancelled',
      operationReference: 'install1'
    })
    expect(journal.clear).toHaveBeenCalledOnce()
  })

  it('joins an in-progress platform installation instead of starting another one', async () => {
    const installation = Promise.withResolvers<{ kind: 'uac-cancelled' }>()
    const installer = { install: vi.fn(() => installation.promise) }
    const owner = makeOwner({
      installer,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'install1'
    })

    const firstCompletion = owner.installPlatform()
    const joinedCompletion = owner.installPlatform()

    expect(installer.install).toHaveBeenCalledOnce()
    expect(owner.getStatus().operation).toMatchObject({
      state: 'running',
      operationReference: 'install1'
    })

    installation.resolve({ kind: 'uac-cancelled' })
    await expect(Promise.all([firstCompletion, joinedCompletion])).resolves.toEqual([
      expect.objectContaining({ operationReference: 'install1' }),
      expect.objectContaining({ operationReference: 'install1' })
    ])
  })

  it('does not start WSL setup while another Settings installation owns admission', async () => {
    const installCoordinator = new SettingsInstallCoordinator()
    const runtimeInstall = installCoordinator.tryAcquire('runtime-install')
    const installer = { install: vi.fn() }
    const owner = makeOwner({
      installer,
      installCoordinator,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'install1'
    })

    await expect(owner.installPlatform()).resolves.toMatchObject({
      outcome: 'unknown',
      snapshot: { state: 'failed', errorCode: 'wsl_install_conflict' }
    })
    expect(installer.install).not.toHaveBeenCalled()
    runtimeInstall?.release()
  })

  it('does not start the platform installer when its crash marker cannot be persisted', async () => {
    const failure = new Error('disk unavailable')
    const journal = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => Promise.reject(failure)),
      clear: vi.fn()
    }
    const installer = { install: vi.fn() }
    const owner = makeOwner({
      installer,
      operationJournal: journal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'install1'
    })

    await expect(owner.installPlatform()).resolves.toMatchObject({
      outcome: 'unknown',
      snapshot: { state: 'failed', errorCode: 'wsl_install_journal_unavailable' }
    })
    expect(installer.install).not.toHaveBeenCalled()
  })

  it('surfaces a crash marker cleanup failure instead of reporting a reusable success', async () => {
    const journal = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => Promise.reject(new Error('disk unavailable')))
    }
    const owner = makeOwner({
      installer: { install: async () => ({ kind: 'exited', exitCode: 0 }) },
      runner: makeRunner(result('Default Version: 2'), result(''), result('')),
      operationJournal: journal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'install1'
    })

    await expect(owner.installPlatform()).resolves.toMatchObject({
      outcome: 'unknown',
      snapshot: {
        state: 'failed',
        errorCode: 'wsl_install_journal_unavailable',
        operationReference: 'install1'
      }
    })
    expect(owner.getStatus()).toMatchObject({
      operation: { state: 'finished', outcome: 'failed', operationReference: 'install1' },
      snapshot: { state: 'failed', errorCode: 'wsl_install_journal_unavailable' }
    })
  })

  it('moves a platform installation through verification into an observable terminal result', async () => {
    const installation = Promise.withResolvers<{ kind: 'exited'; exitCode: number }>()
    const statusCheck = Promise.withResolvers<ReturnType<typeof result>>()
    const runner: WslCommandRunner = {
      run: vi.fn(async (args) => (args[0] === '--status' ? statusCheck.promise : result()))
    }
    const owner = makeOwner({
      installer: { install: () => installation.promise },
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'install2'
    })

    const completion = owner.installPlatform()
    installation.resolve({ kind: 'exited', exitCode: 0 })

    await vi.waitFor(() => {
      expect(owner.getStatus().operation).toMatchObject({
        state: 'running',
        phase: 'verifying'
      })
    })

    statusCheck.resolve(result('Default Version: 2'))
    await completion

    expect(owner.getStatus()).toMatchObject({
      snapshot: { state: 'distro-required', operationReference: 'install2' },
      operation: {
        state: 'finished',
        kind: 'install-platform',
        outcome: 'completed',
        operationReference: 'install2'
      }
    })
  })

  it('installs the WSL platform only through the explicit owner command and confirms OS state', async () => {
    const installer: WslPlatformInstaller = {
      install: vi.fn(async () => ({ kind: 'exited' as const, exitCode: 1 }))
    }
    const runner = makeRunner(result('private-host-output'), result(''), result(''))
    const log = { info: vi.fn(), warn: vi.fn() }
    const owner = makeOwner({
      installer,
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      operationReference: () => 'install1',
      log
    })

    await expect(owner.installPlatform()).resolves.toEqual({
      outcome: 'completed',
      ownership: 'user-and-os-managed',
      operationReference: 'install1',
      snapshot: {
        state: 'distro-required',
        distros: [],
        errorCode: 'wsl_distro_missing',
        operationReference: 'install1'
      }
    })
    expect(installer.install).toHaveBeenCalledOnce()
    expect(runner.run).toHaveBeenCalledWith(['--status'])
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toContain(
      'private-host-output'
    )
    expect(log.info).toHaveBeenCalledWith('wsl install started', {
      operationReference: 'install1',
      ownership: 'user-and-os-managed'
    })
  })

  it.each([
    [
      'UAC cancellation',
      { kind: 'uac-cancelled' as const },
      'uac-cancelled',
      'wsl_install_uac_cancelled'
    ],
    [
      'launcher failure',
      { kind: 'spawn-failed' as const },
      'spawn-failed',
      'wsl_install_spawn_failed'
    ]
  ])(
    'reports %s without probing or replaying the installer',
    async (_label, execution, outcome, code) => {
      const installer: WslPlatformInstaller = { install: vi.fn(async () => execution) }
      const runner = makeRunner()
      const owner = makeOwner({
        installer,
        runner,
        workspacePath: 'C:\\science',
        readSelection: async () => undefined,
        writeSelection: vi.fn(),
        operationReference: () => 'install2'
      })

      await expect(owner.installPlatform()).resolves.toMatchObject({
        outcome,
        ownership: 'user-and-os-managed',
        operationReference: 'install2',
        snapshot: { state: 'not-installed', errorCode: code, operationReference: 'install2' }
      })
      await expect(owner.createSupportHandoff()).resolves.toMatchObject({
        errorCode: code,
        supportReference: 'install2',
        failure: { stage: 'installation', code }
      })
      expect(installer.install).toHaveBeenCalledOnce()
      expect(runner.run).toHaveBeenCalledOnce()
      expect(runner.run).toHaveBeenCalledWith(['--version'])
    }
  )

  it('bounds and redacts diagnostic command output', () => {
    const diagnostic = boundedWslDiagnosticText(`token=private-token ${'x'.repeat(800)}`)
    expect(diagnostic).toHaveLength(512)
    expect(diagnostic).toContain('token=[redacted]')
    expect(diagnostic).not.toContain('private-token')
    expect(diagnostic).toMatch(/…$/)
  })

  it('hands the platform to the user and OS and only performs a fresh probe after owner restart', async () => {
    const installer: WslPlatformInstaller = {
      install: vi.fn(async () => ({ kind: 'exited' as const, exitCode: 0 }))
    }
    const shared = {
      installer,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    }
    const installingOwner = makeOwner({
      ...shared,
      runner: makeRunner(result('Default Version: 2'), result('')),
      operationReference: () => 'install1'
    })

    await expect(installingOwner.installPlatform()).resolves.toMatchObject({
      ownership: 'user-and-os-managed',
      outcome: 'completed'
    })

    const restartedOwner = makeOwner({
      ...shared,
      runner: makeRunner(result('Default Version: 2'), result('')),
      operationReference: () => 'restart1'
    })
    await expect(restartedOwner.probe()).resolves.toMatchObject({
      state: 'distro-required',
      operationReference: 'restart1'
    })
    expect(installer.install).toHaveBeenCalledOnce()
  })

  it('reports an unknown result when the post-install OS probe itself fails', async () => {
    const installer: WslPlatformInstaller = {
      install: vi.fn(async () => ({ kind: 'exited' as const, exitCode: 0 }))
    }
    const runner: WslCommandRunner = { run: vi.fn(async () => Promise.reject(new Error('boom'))) }
    const owner = makeOwner({
      installer,
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      operationReference: () => 'install5'
    })

    await expect(owner.installPlatform()).resolves.toMatchObject({
      outcome: 'unknown',
      ownership: 'user-and-os-managed',
      operationReference: 'install5',
      snapshot: {
        state: 'failed',
        errorCode: 'wsl_install_unknown',
        operationReference: 'install5'
      }
    })
    expect(installer.install).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'restart-required',
      3010,
      [result('', 1, 'localized pending state'), result('', 1, 'localized unavailable')],
      'restart-required'
    ],
    [
      'unknown',
      1,
      [result('', 1, 'localized failure'), result('', 1, 'localized failure')],
      'failed'
    ]
  ])(
    'keeps an uncertain %s install single-shot and returns a fresh probe',
    async (outcome, exitCode, responses, state) => {
      const installer: WslPlatformInstaller = {
        install: vi.fn(async () => ({ kind: 'exited' as const, exitCode }))
      }
      const runner = makeRunner(...responses)
      const owner = makeOwner({
        installer,
        runner,
        workspacePath: 'C:\\science',
        readSelection: async () => undefined,
        writeSelection: vi.fn(),
        operationReference: () => 'install3'
      })

      await expect(owner.installPlatform()).resolves.toMatchObject({
        outcome,
        ownership: 'user-and-os-managed',
        operationReference: 'install3',
        snapshot: { state, operationReference: 'install3' }
      })
      expect(installer.install).toHaveBeenCalledOnce()
      expect(runner.run).toHaveBeenCalledTimes(2)
    }
  )

  it('installs only the recommended distro after an explicit request and returns a fresh OS probe', async () => {
    const runner = makeRunner(
      result('Default Version: 2'),
      result(''),
      result(''),
      result('', 0),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2')
    )
    const log = { info: vi.fn(), warn: vi.fn() }
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      log
    })

    const snapshot = await owner.installRecommendedDistro()

    expect(RECOMMENDED_WSL_DISTRO).toBe('Ubuntu-22.04')
    expect(runner.run).toHaveBeenNthCalledWith(
      4,
      ['--install', '--distribution', 'Ubuntu-22.04', '--no-launch'],
      { timeoutMs: WSL_DISTRO_INSTALL_TIMEOUT_MS }
    )
    expect(snapshot).toMatchObject({
      state: 'distro-required',
      distros: [{ name: 'Ubuntu-22.04', version: 2 }]
    })
    const operation = owner.getStatus().operation
    expect(operation.state).toBe('finished')
    if (operation.state !== 'finished') throw new Error('Expected a finished install operation.')
    expect(snapshot.operationReference).toBe(operation.operationReference)
    expect(runner.run).toHaveBeenCalledTimes(7)
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toContain(
      'Ubuntu-22.04'
    )
  })

  it('keeps one observable recommended-distro installation for concurrent callers', async () => {
    const installation = Promise.withResolvers<ReturnType<typeof result>>()
    const runner: WslCommandRunner = {
      run: vi.fn(async (args) => {
        if (args[0] === '--install') return installation.promise
        if (args[0] === '--status') return result('Default Version: 2')
        return result('')
      })
    }
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      operationReference: () => 'distro1'
    })

    const firstCompletion = owner.installRecommendedDistro()
    const joinedCompletion = owner.installRecommendedDistro()

    await vi.waitFor(() => {
      expect(owner.getStatus().operation).toMatchObject({
        state: 'running',
        kind: 'install-recommended-distro',
        phase: 'installing',
        operationReference: 'distro1'
      })
    })
    expect(
      vi.mocked(runner.run).mock.calls.filter(([args]) => args[0] === '--install')
    ).toHaveLength(1)

    installation.resolve(result('', 1, 'install failed'))
    await Promise.all([firstCompletion, joinedCompletion])
    expect(owner.getStatus().operation).toMatchObject({
      state: 'finished',
      kind: 'install-recommended-distro',
      operationReference: 'distro1'
    })
  })

  it('reconciles an interrupted distro install with read-only probes and never retries it', async () => {
    const journal = {
      load: vi.fn(async () => ({
        kind: 'install-recommended-distro' as const,
        operationReference: 'distro1',
        startedAt: 1
      })),
      save: vi.fn(),
      clear: vi.fn(async () => undefined)
    }
    const runner = makeRunner(result('Default Version: 2'), result(''), result(''))
    const owner = makeOwner({
      runner,
      operationJournal: journal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })

    await expect(owner.reconcileInterruptedOperation()).resolves.toMatchObject({
      operation: {
        state: 'finished',
        kind: 'install-recommended-distro',
        outcome: 'interrupted',
        operationReference: 'distro1'
      },
      snapshot: { state: 'failed', errorCode: 'wsl_install_interrupted' }
    })
    expect(vi.mocked(runner.run).mock.calls.map(([args]) => args[0])).not.toContain('--install')
    expect(journal.clear).not.toHaveBeenCalled()

    await expect(owner.installRecommendedDistro()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_install_interrupted',
      operationReference: 'distro1'
    })
    expect(journal.save).not.toHaveBeenCalled()
    expect(vi.mocked(runner.run).mock.calls.map(([args]) => args[0])).not.toContain('--install')
  })

  it('clears an interrupted marker only after a later read-only probe confirms the install', async () => {
    const journal = {
      load: vi.fn(async () => ({
        kind: 'install-recommended-distro' as const,
        operationReference: 'distro1',
        startedAt: 1
      })),
      save: vi.fn(),
      clear: vi.fn(async () => undefined)
    }
    const runner = makeRunner(
      result('Default Version: 2'),
      result(''),
      result(''),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2')
    )
    const owner = makeOwner({
      runner,
      operationJournal: journal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })

    await expect(owner.reconcileInterruptedOperation()).resolves.toMatchObject({
      operation: { state: 'finished', outcome: 'interrupted' }
    })
    expect(journal.clear).not.toHaveBeenCalled()

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'distro-required',
      distros: [{ name: 'Ubuntu-22.04', version: 2 }],
      operationReference: 'distro1'
    })
    expect(owner.getStatus().operation).toMatchObject({
      state: 'finished',
      outcome: 'completed',
      operationReference: 'distro1'
    })
    expect(journal.clear).toHaveBeenCalledOnce()
    expect(vi.mocked(runner.run).mock.calls.map(([args]) => args[0])).not.toContain('--install')
  })

  it('fails closed when an existing crash marker cannot be read', async () => {
    const journal = {
      load: vi.fn(async () => Promise.reject(new Error('corrupt marker'))),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }
    const installer = { install: vi.fn() }
    const owner = makeOwner({
      installer,
      operationJournal: journal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: async () => undefined,
      operationReference: () => 'recovery1'
    })

    await expect(owner.reconcileInterruptedOperation()).resolves.toMatchObject({
      snapshot: { state: 'failed', errorCode: 'wsl_install_journal_unavailable' }
    })
    await expect(owner.installPlatform()).resolves.toMatchObject({
      outcome: 'unknown',
      snapshot: { state: 'failed', errorCode: 'wsl_install_journal_unavailable' }
    })
    expect(installer.install).not.toHaveBeenCalled()
    expect(journal.save).not.toHaveBeenCalled()
    expect(journal.clear).not.toHaveBeenCalled()
  })

  it('gives distro download and registration more than the probe timeout', async () => {
    vi.useFakeTimers()
    const responses = [
      result('Default Version: 2'),
      result(''),
      result(''),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2')
    ]
    const runner: WslCommandRunner = {
      run: vi.fn(async (_args, options) => {
        if (options?.timeoutMs === WSL_DISTRO_INSTALL_TIMEOUT_MS) {
          await new Promise((resolve) => setTimeout(resolve, 16_000))
          return result('', 0)
        }
        return responses.shift() ?? result()
      })
    }
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })

    const installing = owner.installRecommendedDistro()
    await vi.advanceTimersByTimeAsync(16_000)
    await expect(installing).resolves.toMatchObject({ state: 'distro-required' })
    vi.useRealTimers()
  })

  it('launches WSL in a visible interactive Windows console with exact arguments', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn
    const launch = createWslTerminalLauncher(spawnProcess).open(['--distribution', 'Ubuntu-22.04'])

    expect(spawnProcess).toHaveBeenCalledWith(
      'conhost.exe',
      ['wsl.exe', '--distribution', 'Ubuntu-22.04'],
      { detached: true, windowsHide: false, stdio: 'inherit', shell: false }
    )
    child.emit('spawn')
    await expect(launch).resolves.toBeUndefined()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('opens an installed distro for interactive first launch without supplying credentials', async () => {
    const runner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2'),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2')
    )
    const terminal: WslTerminalLauncher = { open: vi.fn(async () => undefined) }
    const owner = makeOwner({
      runner,
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })

    const snapshot = await owner.openTerminal({ distro: 'Ubuntu-22.04' })

    expect(terminal.open).toHaveBeenCalledWith(['--distribution', 'Ubuntu-22.04'])
    expect(snapshot).toMatchObject({ state: 'distro-required' })
  })

  it('continues from a fresh install into first initialization without inventing a selection', async () => {
    const runner = makeRunner(
      result('Default Version: 2'),
      result(''),
      result(''),
      result('', 0),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2'),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2'),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2')
    )
    const terminal: WslTerminalLauncher = { open: vi.fn(async () => undefined) }
    const writeSelection = vi.fn()
    const owner = makeOwner({
      runner,
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection
    })

    const installed = await owner.installRecommendedDistro()
    expect(installed).toMatchObject({
      state: 'distro-required',
      distros: [{ name: 'Ubuntu-22.04', version: 2 }]
    })
    expect(installed).not.toHaveProperty('selection')
    const initialized = await owner.openTerminal({ distro: 'Ubuntu-22.04' })
    expect(initialized).toMatchObject({ state: 'distro-required' })
    expect(initialized).not.toHaveProperty('selection')
    expect(terminal.open).toHaveBeenCalledWith(['--distribution', 'Ubuntu-22.04'])
    expect(writeSelection).not.toHaveBeenCalled()
  })

  it('fails closed when install does not produce the recommended distro', async () => {
    const runner = makeRunner(
      result('Default Version: 2'),
      result(''),
      result(''),
      result('', 1, 'localized install failure'),
      result('Default Version: 2'),
      result(''),
      result('')
    )
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })

    await expect(owner.installRecommendedDistro()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_distro_install_failed'
    })

    const unconfirmed = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result(''),
        result(''),
        result('', 0),
        result('Default Version: 2'),
        result(''),
        result('')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(unconfirmed.installRecommendedDistro()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_distro_install_unconfirmed'
    })
  })

  it('opens dependency help as the selected non-root user and rejects unprobed distros', async () => {
    const terminal: WslTerminalLauncher = { open: vi.fn(async () => undefined) }
    const runner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash'),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash')
    )
    const owner = makeOwner({
      runner,
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu-22.04', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(
      owner.openTerminal({ distro: 'Ubuntu-22.04', user: 'scientist' })
    ).resolves.toMatchObject({ state: 'dependency-required', errorCode: 'wsl_bwrap_missing' })
    expect(terminal.open).toHaveBeenCalledWith([
      '--distribution',
      'Ubuntu-22.04',
      '--user',
      'scientist'
    ])

    const rejected = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu-22.04'),
        result('* Ubuntu-22.04 Running 2')
      ),
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(rejected.openTerminal({ distro: 'Attacker\n--exec' })).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_terminal_request_invalid'
    })
    expect(terminal.open).toHaveBeenCalledTimes(1)
  })

  it('returns a stable code without logging terminal errors or profile identity', async () => {
    const log = { info: vi.fn(), warn: vi.fn() }
    const terminal: WslTerminalLauncher = {
      open: vi.fn(async () => {
        throw new Error('private terminal output for scientist')
      })
    }
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu-22.04'),
        result('* Ubuntu-22.04 Stopped 2')
      ),
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      log
    })

    await expect(owner.openTerminal({ distro: 'Ubuntu-22.04' })).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_terminal_open_failed'
    })
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
    expect(logged).not.toContain('scientist')
    expect(logged).not.toContain('Ubuntu-22.04')
    expect(logged).not.toContain('private terminal output')
  })

  it('treats Docker Desktop internal distributions as no selectable distro', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('docker-desktop\ndocker-desktop-data'),
        result('* docker-desktop Running 2\n  docker-desktop-data Stopped 2')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      operationReference: () => 'docker1'
    })

    await expect(owner.probe()).resolves.toEqual({
      state: 'distro-required',
      distros: [],
      errorCode: 'wsl_distro_missing',
      operationReference: 'docker1'
    })
  })

  it('ignores a historical reserved selection while preserving similar user distros', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('docker-desktop\nDOCKER-DESKTOP-DATA\ndocker-desktop-dev\nUbuntu-24.04'),
        result(
          '  docker-desktop Running 2\n' +
            '  DOCKER-DESKTOP-DATA Stopped 2\n' +
            '  docker-desktop-dev Running 2\n' +
            '* Ubuntu-24.04 Stopped 2'
        )
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({
        distro: 'DOCKER-DESKTOP-DATA',
        user: 'scientist'
      }),
      writeSelection: vi.fn(),
      operationReference: () => 'docker3'
    })

    await expect(owner.probe()).resolves.toEqual({
      state: 'distro-required',
      distros: [
        { name: 'docker-desktop-dev', version: 2, isDefault: false },
        { name: 'Ubuntu-24.04', version: 2, isDefault: true }
      ],
      operationReference: 'docker3'
    })
  })

  it('distinguishes platform, restart, and distro-required setup states', async () => {
    const absent = makeOwner({
      runner: makeRunner(result('', 1, 'WSL is not installed')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(absent.probe()).resolves.toMatchObject({
      state: 'not-installed',
      errorCode: 'wsl_not_installed'
    })

    const restart = makeOwner({
      runner: makeRunner(result('', 1, 'A system restart is required')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(restart.probe()).resolves.toMatchObject({
      state: 'restart-required',
      errorCode: 'wsl_restart_required'
    })

    const noDistro = makeOwner({
      runner: makeRunner(result('Default Version: 2'), result('')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(noDistro.probe()).resolves.toMatchObject({
      state: 'distro-required',
      errorCode: 'wsl_distro_missing'
    })

    const localizedList = makeOwner({
      runner: makeRunner(
        result('默认版本: 2'),
        result('Ubuntu-24.04'),
        result('* Ubuntu-24.04 已停止 2')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(localizedList.probe()).resolves.toMatchObject({
      state: 'distro-required',
      distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }]
    })
  })

  it('classifies localized platform failures without depending on translated prose', async () => {
    const restart = makeOwner({
      runner: makeRunner(result('', 1, '需要重新启动'), result('WSL 2.4.0')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(restart.probe()).resolves.toMatchObject({
      state: 'restart-required',
      errorCode: 'wsl_restart_required'
    })

    const absent = makeOwner({
      runner: makeRunner(result('', 1, '找不到命令', 'not-found')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(absent.probe()).resolves.toMatchObject({
      state: 'not-installed',
      errorCode: 'wsl_not_installed'
    })
  })

  it('rejects case-variant Docker Desktop selections before persistence or probing', async () => {
    const runner = makeRunner()
    const writeSelection = vi.fn()
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection,
      operationReference: () => 'docker2'
    })

    const snapshot = await owner.select({ distro: 'Docker-Desktop', user: 'scientist' })

    expect(snapshot).toEqual({
      state: 'failed',
      distros: [],
      errorCode: 'wsl_selection_invalid',
      operationReference: 'docker2'
    })
    expect(writeSelection).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('persists an exact distro and non-root user but reports ready only after every check passes', async () => {
    const writeSelection = vi.fn()
    const log = { info: vi.fn(), warn: vi.fn() }
    const runner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu-24.04'),
      result('* Ubuntu-24.04 Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored'),
      result('ok'),
      result('/mnt/c/science\nok')
    )
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection,
      log
    })

    const snapshot = await owner.select({ distro: 'Ubuntu-24.04', user: 'scientist' })

    expect(writeSelection).toHaveBeenCalledWith({ distro: 'Ubuntu-24.04', user: 'scientist' })
    expect(snapshot).toMatchObject({
      state: 'ready',
      selection: { distro: 'Ubuntu-24.04', user: 'scientist' },
      readiness: {
        wsl2: true,
        bash: true,
        bwrap: true,
        python3: true,
        namespaces: true,
        localWorkspace: true
      }
    })
    expect(snapshot.operationReference).toMatch(/^[a-f0-9]{8}$/)
    expect(runner.run).toHaveBeenNthCalledWith(
      5,
      expect.arrayContaining([
        expect.stringContaining('test -x /usr/bin/python3 && /usr/bin/python3 -c')
      ])
    )
    expect(runner.run).toHaveBeenNthCalledWith(
      6,
      expect.arrayContaining([
        'bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true && printf ok'
      ])
    )
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
    expect(logged).not.toContain('Ubuntu-24.04')
    expect(logged).not.toContain('scientist')
    expect(logged).not.toContain('C:\\\\science')
  })

  it('admits WSL2 Bash only for the latest ready snapshot and unchanged saved profile', async () => {
    let selection = { distro: 'Ubuntu-24.04', user: 'scientist' }
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu-24.04'),
        result('* Ubuntu-24.04 Running 2'),
        result('1000\nscientist\nhome-ok'),
        result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored'),
        result('ok'),
        result('/mnt/c/science\nok')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => selection,
      writeSelection: async (next) => {
        selection = next
      }
    })

    await expect(owner.requireLatestReadySelection()).rejects.toThrow(
      'The selected WSL2 Shell profile is not ready.'
    )
    await expect(owner.probe()).resolves.toMatchObject({ state: 'ready' })
    await expect(owner.requireLatestReadySelection()).resolves.toEqual(selection)

    selection = { distro: 'Ubuntu-24.04', user: 'someone-else' }
    await expect(owner.requireLatestReadySelection()).rejects.toThrow(
      'The selected WSL2 Shell profile is not ready.'
    )
  })

  it('fails closed when the selected WSL2 profile is not using mirrored networking', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu-22.04'),
        result('* Ubuntu-22.04 Running 2'),
        result('1000\nscientist\nhome-ok'),
        result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nnat')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu-22.04', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_network_mode_unsupported',
      readiness: { mirroredNetworking: false }
    })
    await expect(owner.requireLatestReadySelection()).rejects.toThrow('is not ready')
  })

  it('reports the active profile separately from a newly verified candidate', async () => {
    let candidate = { distro: 'Ubuntu-24.04', user: 'candidate' }
    const active = { distro: 'Ubuntu-22.04', user: 'active' }
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu-24.04'),
        result('* Ubuntu-24.04 Running 2'),
        result('1000\ncandidate\nhome-ok'),
        result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored'),
        result('ok'),
        result('/mnt/c/science\nok')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => candidate,
      readActivation: async () => ({ runtime: 'wsl2-bash', selection: active }),
      writeSelection: async (next) => {
        candidate = next
      }
    })

    const snapshot = await owner.select(candidate)

    expect(snapshot).toMatchObject({
      state: 'ready',
      selection: candidate,
      activeRuntime: 'wsl2-bash',
      activatedSelection: active
    })
  })

  it('keeps exact distro names when verbose states contain localized words', async () => {
    const writeSelection = vi.fn()
    const nulSeparated = (value: string): string => [...value].join('\0')
    const runner = makeRunner(
      result('Default Version: 2'),
      result(nulSeparated('Ubuntu Pro\r\nDebian 中文\r\nSUSE Dev')),
      result(
        nulSeparated(
          '  NAME                  STATE             VERSION\r\n' +
            '* Ubuntu Pro            En ejecución      2\r\n' +
            '  Debian 中文            Wird ausgeführt   1\r\n' +
            '  SUSE Dev               正在 运行           2'
        )
      ),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored'),
      result('ok'),
      result('/mnt/c/science\nok')
    )
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection
    })

    const snapshot = await owner.select({ distro: 'Ubuntu Pro', user: 'scientist' })

    expect(writeSelection).toHaveBeenCalledWith({ distro: 'Ubuntu Pro', user: 'scientist' })
    expect(snapshot).toMatchObject({
      state: 'ready',
      selection: { distro: 'Ubuntu Pro', user: 'scientist' },
      distros: [
        { name: 'Ubuntu Pro', version: 2, isDefault: true },
        { name: 'Debian 中文', version: 1, isDefault: false },
        { name: 'SUSE Dev', version: 2, isDefault: false }
      ]
    })
    expect(runner.run).toHaveBeenNthCalledWith(2, ['--list', '--quiet'])
    expect(runner.run).toHaveBeenNthCalledWith(3, ['--list', '--verbose'])
  })

  it.each([
    [{ kind: 'not-local' as const }, 'wsl_workspace_not_local'],
    [{ kind: 'not-ntfs' as const, fileSystem: 'exFAT' }, 'wsl_workspace_not_ntfs'],
    [{ kind: 'not-ntfs' as const, fileSystem: 'ReFS' }, 'wsl_workspace_not_ntfs'],
    [{ kind: 'unavailable' as const }, 'wsl_workspace_volume_unavailable']
  ])('never becomes ready for an unsupported Windows volume', async (volume, errorCode) => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2')
      ),
      workspacePath: 'Z:\\science',
      volumeProbe: vi.fn(async () => volume),
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode,
      readiness: { wsl2: true, localWorkspace: false }
    })
  })

  it('resolves the configured data root when probing instead of capturing it at construction', async () => {
    let configuredRoot = 'C:\\default-data'
    const volumeProbe = vi.fn(async () => ({ kind: 'local-ntfs' as const }))
    const runner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu'),
      result('* Ubuntu Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored'),
      result('ok'),
      result('/mnt/d/custom-data\nok')
    )
    const owner = makeOwner({
      runner,
      workspacePath: () => configuredRoot,
      volumeProbe,
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    configuredRoot = 'D:\\custom-data'
    await expect(owner.probe()).resolves.toMatchObject({ state: 'ready' })
    expect(volumeProbe).toHaveBeenCalledWith('D:\\custom-data')
    expect(runner.run).toHaveBeenLastCalledWith(expect.arrayContaining(['D:\\custom-data']))
  })

  it.each([
    [
      'WSL1 distro',
      'wsl1_unsupported',
      makeRunner(result('Default Version: 2'), result('Ubuntu'), result('* Ubuntu Stopped 1'))
    ],
    [
      'root user',
      'wsl_root_user',
      makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('0\nroot')
      )
    ],
    [
      'uninitialized distro',
      'wsl_first_launch_required',
      makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Stopped 2'),
        result('', 1, 'localized first-launch failure'),
        result('', 1, 'localized first-launch failure')
      )
    ]
  ])('fails safely for %s', async (_label, errorCode, runner) => {
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'root' }),
      writeSelection: vi.fn()
    })
    await expect(owner.probe()).resolves.toMatchObject({ errorCode })
  })

  it('reports missing dependencies and unsupported workspace paths with actionable stable codes', async () => {
    const missingRunner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu'),
      result('* Ubuntu Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash\n/usr/bin/python3\n', 1)
    )
    const missing = makeOwner({
      runner: missingRunner,
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })
    await expect(missing.probe()).resolves.toMatchObject({
      state: 'dependency-required',
      errorCode: 'wsl_bwrap_missing',
      suggestedCommand: 'sudo apt-get update && sudo apt-get install bubblewrap'
    })
    expect(
      JSON.stringify((missingRunner.run as ReturnType<typeof vi.fn>).mock.calls)
    ).not.toContain('sudo apt-get')

    const missingPython = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist\nhome-ok'),
        result('/usr/bin/bash\n/usr/bin/bwrap\nmirrored')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })
    await expect(missingPython.probe()).resolves.toMatchObject({
      state: 'dependency-required',
      errorCode: 'wsl_python3_missing',
      readiness: { bash: true, bwrap: true, python3: false },
      suggestedCommand: 'sudo apt-get update && sudo apt-get install python3'
    })
    await expect(missingPython.requireLatestReadySelection()).rejects.toThrow('is not ready')

    const unsupported = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2')
      ),
      workspacePath: '\\\\server\\share',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })
    await expect(unsupported.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_workspace_path_unsupported'
    })
  })

  it('does not mark a selected user ready without an existing Linux home directory', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_home_missing',
      readiness: { wsl2: true, home: false }
    })
  })

  it('marks the namespace check as failed when bubblewrap cannot create the sandbox', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist\nhome-ok'),
        result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored'),
        result('', 1, 'namespace unavailable')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'dependency-required',
      errorCode: 'wsl_namespace_unavailable',
      readiness: { wsl2: true, bash: true, bwrap: true, namespaces: false }
    })
  })

  it('marks the local workspace check as failed when the selected user cannot reach it', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist\nhome-ok'),
        result('/usr/bin/bash\n/usr/bin/bwrap\n/usr/bin/python3\nmirrored'),
        result('ok'),
        result('/mnt/c/science', 1, 'workspace unavailable')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_workspace_unreachable',
      readiness: {
        wsl2: true,
        bash: true,
        bwrap: true,
        python3: true,
        namespaces: true,
        localWorkspace: false
      }
    })
  })
})
