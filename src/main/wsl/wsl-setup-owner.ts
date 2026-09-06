import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import {
  RECOMMENDED_WSL_DISTRO,
  WSL_PLATFORM_OWNERSHIP,
  type OpenWslTerminalRequest,
  type SelectWslProfileRequest,
  type WslDistro,
  type WslReadiness,
  type WslSelection,
  type WslPlatformInstallResult,
  type WslSetupSnapshot,
  type WslSetupState,
  type WslSupportHandoff
} from '../../shared/wsl-setup'
import { createLogger } from '../logger'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import type { WindowsVolumeProbeResult } from './windows-volume-probe'

export type WslCommandResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
  failure?: 'not-found' | 'timeout'
}>

export interface WslCommandRunner {
  run(
    args: readonly string[],
    options?: Readonly<{ timeoutMs?: number }>
  ): Promise<WslCommandResult>
}

export type WslPlatformInstallExecution =
  | Readonly<{ kind: 'exited'; exitCode: number }>
  | Readonly<{ kind: 'uac-cancelled' }>
  | Readonly<{ kind: 'spawn-failed' }>

export interface WslPlatformInstaller {
  install(): Promise<WslPlatformInstallExecution>
}

type WslSetupOwnerOptions = Readonly<{
  runner?: WslCommandRunner
  installer?: WslPlatformInstaller
  terminal?: WslTerminalLauncher
  workspacePath: string | (() => string)
  volumeProbe(path: string): Promise<WindowsVolumeProbeResult>
  readSelection(): Promise<WslSelection | undefined>
  readActivation?(): Promise<
    Readonly<{
      runtime: 'powershell' | 'wsl2-bash' | undefined
      selection: WslSelection | undefined
    }>
  >
  writeSelection(selection: WslSelection): Promise<unknown>
  operationReference?: () => string
  log?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>
}>

export interface WslTerminalLauncher {
  open(args: readonly string[]): Promise<void>
}

export { RECOMMENDED_WSL_DISTRO }
export const WSL_DISTRO_INSTALL_TIMEOUT_MS = 10 * 60_000

const executeWsl: WslCommandRunner = {
  run: (args, options) =>
    new Promise((resolve) => {
      execFile(
        'wsl.exe',
        [...args],
        { windowsHide: true, timeout: options?.timeoutMs ?? 15_000, encoding: 'buffer' },
        (error, stdout, stderr) => {
          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: unknown })?.code === 'number'
              ? ((error as NodeJS.ErrnoException & { code: number }).code ?? 1)
              : error
                ? 1
                : 0
          const decode = (value: Buffer): string => {
            const sample = value.subarray(0, Math.min(value.length, 64))
            const nullBytes = [...sample].filter((byte) => byte === 0).length
            return value.toString(nullBytes > sample.length / 4 ? 'utf16le' : 'utf8')
          }
          const code = (error as NodeJS.ErrnoException | null)?.code
          resolve({
            stdout: decode(stdout),
            stderr: decode(stderr),
            exitCode,
            ...(code === 'ENOENT'
              ? { failure: 'not-found' as const }
              : (error as (NodeJS.ErrnoException & { killed?: boolean }) | null)?.killed
                ? { failure: 'timeout' as const }
                : {})
          })
        }
      )
    })
}

const elevatedWslPlatformInstaller: WslPlatformInstaller = {
  install: () =>
    new Promise((resolve) => {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        'try {',
        "  $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\wsl.exe') -ArgumentList @('--install', '--no-distribution') -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
        '  exit $process.ExitCode',
        '} catch {',
        '  if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }',
        '  exit 1',
        '}'
      ].join('\n')
      execFile(
        resolveWindowsPowerShellExecutable(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, encoding: 'buffer' },
        (error) => {
          const code = (error as { code?: unknown } | null)?.code
          if (code === 'ENOENT') resolve({ kind: 'spawn-failed' })
          else if (code === 1223) resolve({ kind: 'uac-cancelled' })
          else
            resolve({
              kind: 'exited',
              exitCode: typeof code === 'number' ? code : error ? 1 : 0
            })
        }
      )
    })
}

export const createWslTerminalLauncher = (
  spawnProcess: typeof spawn = spawn
): WslTerminalLauncher => ({
  open: (args) =>
    new Promise((resolve, reject) => {
      const child = spawnProcess('conhost.exe', ['wsl.exe', ...args], {
        detached: true,
        windowsHide: false,
        stdio: 'inherit',
        shell: false
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
})

const openWslTerminal = createWslTerminalLauncher()

const clean = (value: string): string => value.replaceAll('\0', '').replaceAll('\r', '').trim()

export const parseWslDistros = (quietOutput: string, verboseOutput: string): WslDistro[] => {
  const names = clean(quietOutput)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const verboseLines = clean(verboseOutput).split('\n')
  const longestNamesFirst = [...names].sort((left, right) => right.length - left.length)
  const details = new Map<string, Omit<WslDistro, 'name'>>()

  for (const rawLine of verboseLines) {
    const defaultMatch = rawLine.trimStart().match(/^\*\s*/)
    const line = defaultMatch ? rawLine.trimStart().slice(defaultMatch[0].length) : rawLine.trim()
    const name = longestNamesFirst.find(
      (candidate) => line.startsWith(candidate) && /^\s/.test(line.slice(candidate.length))
    )
    if (!name) continue
    // The exact name comes from --quiet. Only the stable numeric final column is interpreted;
    // the localized state between them may contain any number of words.
    const versionMatch = line.slice(name.length).match(/\s+.+\s+([12])\s*$/)
    if (!versionMatch) continue
    details.set(name, {
      version: Number(versionMatch[1]) as 1 | 2,
      isDefault: !!defaultMatch
    })
  }

  return names.flatMap((name) => {
    const detail = details.get(name)
    return detail ? [{ name, ...detail }] : []
  })
}

const setupSnapshot = (
  state: WslSetupState,
  operationReference: string,
  distros: readonly WslDistro[] = [],
  extra: Partial<Omit<WslSetupSnapshot, 'state' | 'operationReference' | 'distros'>> = {}
): WslSetupSnapshot => ({ state, operationReference, distros, ...extra })

const platformFailure = (output: string): { state: WslSetupState; code: string } => {
  if (/restart|reboot/i.test(output))
    return { state: 'restart-required', code: 'wsl_restart_required' }
  if (/not installed|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/i.test(output)) {
    return { state: 'not-installed', code: 'wsl_not_installed' }
  }
  return { state: 'failed', code: 'wsl_probe_failed' }
}

const supportErrorCode = (snapshot: WslSetupSnapshot): string => {
  if (snapshot.errorCode && /^wsl_[a-z0-9_]+$/.test(snapshot.errorCode)) {
    return snapshot.errorCode
  }
  return {
    checking: 'wsl_probe_required',
    'not-installed': 'wsl_not_installed',
    'restart-required': 'wsl_restart_required',
    'distro-required': 'wsl_distro_selection_required',
    'first-launch-required': 'wsl_first_launch_required',
    'dependency-required': 'wsl_dependency_required',
    ready: 'wsl_ready',
    failed: 'wsl_probe_failed'
  }[snapshot.state]
}

export class WslSetupOwner {
  private readonly runner: WslCommandRunner
  private readonly installer: WslPlatformInstaller
  private readonly terminal: WslTerminalLauncher
  private readonly log: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>
  private latestSnapshot: WslSetupSnapshot | undefined

  constructor(private readonly options: WslSetupOwnerOptions) {
    this.runner = options.runner ?? executeWsl
    this.installer = options.installer ?? elevatedWslPlatformInstaller
    this.terminal = options.terminal ?? openWslTerminal
    this.log = options.log ?? createLogger('wsl-setup')
  }

  async installPlatform(): Promise<WslPlatformInstallResult> {
    const startedAt = Date.now()
    const operationReference = this.reference()
    this.log.info('wsl install started', {
      operationReference,
      ownership: WSL_PLATFORM_OWNERSHIP
    })
    let execution: WslPlatformInstallExecution
    try {
      execution = await this.installer.install()
    } catch {
      execution = { kind: 'spawn-failed' }
    }

    let outcome: WslPlatformInstallResult['outcome']
    let snapshot: WslSetupSnapshot
    if (execution.kind === 'uac-cancelled') {
      outcome = 'uac-cancelled'
      snapshot = setupSnapshot('not-installed', operationReference, [], {
        errorCode: 'wsl_install_uac_cancelled'
      })
    } else if (execution.kind === 'spawn-failed') {
      outcome = 'spawn-failed'
      snapshot = setupSnapshot('not-installed', operationReference, [], {
        errorCode: 'wsl_install_spawn_failed'
      })
    } else {
      try {
        snapshot = await this.runProbe(operationReference)
      } catch {
        snapshot = setupSnapshot('failed', operationReference, [], {
          errorCode: 'wsl_install_unknown'
        })
      }
      if (snapshot.state === 'restart-required' || execution.exitCode === 3010) {
        outcome = 'restart-required'
        snapshot = setupSnapshot('restart-required', operationReference, snapshot.distros, {
          errorCode: 'wsl_restart_required'
        })
      } else {
        outcome =
          snapshot.state !== 'not-installed' && snapshot.state !== 'failed'
            ? 'completed'
            : 'unknown'
        if (outcome === 'unknown') snapshot = { ...snapshot, errorCode: 'wsl_install_unknown' }
      }
    }

    const fields = {
      operationReference,
      ownership: WSL_PLATFORM_OWNERSHIP,
      outcome,
      state: snapshot.state,
      errorCode: snapshot.errorCode,
      durationMs: Date.now() - startedAt
    }
    if (outcome === 'completed') this.log.info('wsl install completed', fields)
    else this.log.warn('wsl install completed', fields)
    snapshot = await this.withActivation(snapshot)
    this.latestSnapshot = snapshot
    return {
      outcome,
      ownership: WSL_PLATFORM_OWNERSHIP,
      operationReference,
      snapshot
    }
  }

  async installRecommendedDistro(): Promise<WslSetupSnapshot> {
    const current = await this.probe()
    if (current.state !== 'distro-required' || current.distros.length > 0) {
      return this.remember(
        setupSnapshot('failed', this.reference(), current.distros, {
          selection: current.selection,
          readiness: current.readiness,
          errorCode: 'wsl_distro_install_not_allowed'
        })
      )
    }

    const operationReference = this.reference()
    const startedAt = Date.now()
    this.log.info('wsl distro install started', { operationReference })
    const result = await this.runner.run(
      ['--install', '--distribution', RECOMMENDED_WSL_DISTRO, '--no-launch'],
      { timeoutMs: WSL_DISTRO_INSTALL_TIMEOUT_MS }
    )
    const fresh = await this.probe()
    if (
      fresh.state === 'restart-required' ||
      fresh.distros.some((item) => item.name === RECOMMENDED_WSL_DISTRO)
    ) {
      this.log.info('wsl distro install completed', {
        operationReference,
        outcome: fresh.state,
        durationMs: Date.now() - startedAt
      })
      return fresh
    }
    this.log.warn('wsl distro install completed', {
      operationReference,
      outcome: 'failed',
      errorCode:
        result.exitCode === 0 ? 'wsl_distro_install_unconfirmed' : 'wsl_distro_install_failed',
      durationMs: Date.now() - startedAt
    })
    return this.remember(
      setupSnapshot('failed', operationReference, fresh.distros, {
        errorCode:
          result.exitCode === 0 ? 'wsl_distro_install_unconfirmed' : 'wsl_distro_install_failed'
      })
    )
  }

  async openTerminal(request: OpenWslTerminalRequest): Promise<WslSetupSnapshot> {
    const distro = request.distro.trim()
    const user = request.user?.trim()
    const current = await this.probe()
    const installed = current.distros.find((item) => item.name === distro && item.version === 2)
    const verifiedUser =
      !user ||
      (current.selection?.distro === distro &&
        current.selection.user === user &&
        current.readiness?.wsl2 === true &&
        current.readiness.home === true)
    if (
      !installed ||
      !verifiedUser ||
      !this.validName(distro, 256) ||
      (user !== undefined && !this.validName(user, 128))
    ) {
      return this.remember(
        setupSnapshot('failed', this.reference(), current.distros, {
          selection: current.selection,
          readiness: current.readiness,
          errorCode: 'wsl_terminal_request_invalid'
        })
      )
    }

    const operationReference = this.reference()
    try {
      await this.terminal.open([
        '--distribution',
        installed.name,
        ...(user ? ['--user', user] : [])
      ])
    } catch {
      this.log.warn('wsl terminal open failed', {
        operationReference,
        errorCode: 'wsl_terminal_open_failed'
      })
      return this.remember(
        setupSnapshot('failed', operationReference, current.distros, {
          selection: current.selection,
          readiness: current.readiness,
          errorCode: 'wsl_terminal_open_failed'
        })
      )
    }
    this.log.info('wsl terminal opened', { operationReference, withExplicitUser: !!user })
    return this.probe()
  }

  async select(request: SelectWslProfileRequest): Promise<WslSetupSnapshot> {
    const selection = { distro: request.distro.trim(), user: request.user.trim() }
    if (
      !selection.distro ||
      !selection.user ||
      selection.distro.length > 256 ||
      selection.user.length > 128 ||
      /[\0\r\n]/.test(selection.distro) ||
      /[\0\r\n]/.test(selection.user)
    ) {
      const snapshot = setupSnapshot('failed', this.reference(), [], {
        errorCode: 'wsl_selection_invalid'
      })
      this.latestSnapshot = snapshot
      return snapshot
    }
    await this.options.writeSelection(selection)
    return this.probe(selection)
  }

  async probe(selectionOverride?: WslSelection): Promise<WslSetupSnapshot> {
    const startedAt = Date.now()
    const operationReference = this.reference()
    this.log.info('wsl probe started', { operationReference })
    let snapshot: WslSetupSnapshot
    try {
      snapshot = await this.runProbe(operationReference, selectionOverride)
    } catch {
      snapshot = setupSnapshot('failed', operationReference, [], { errorCode: 'wsl_probe_failed' })
    }
    const fields = {
      operationReference,
      state: snapshot.state,
      errorCode: snapshot.errorCode,
      durationMs: Date.now() - startedAt
    }
    if (snapshot.state === 'ready') this.log.info('wsl probe completed', fields)
    else this.log.warn('wsl probe completed', fields)
    snapshot = await this.withActivation(snapshot)
    this.latestSnapshot = snapshot
    return snapshot
  }

  async requireLatestReadySelection(): Promise<WslSelection> {
    const snapshot = this.latestSnapshot
    const saved = await this.options.readSelection()
    const selectedDistro = saved
      ? snapshot?.distros.find((distro) => distro.name === saved.distro && distro.version === 2)
      : undefined
    if (
      snapshot?.state !== 'ready' ||
      !saved ||
      !snapshot.selection ||
      snapshot.selection.distro !== saved.distro ||
      snapshot.selection.user !== saved.user ||
      !selectedDistro ||
      !this.validName(saved.distro, 256) ||
      !this.validName(saved.user, 128)
    ) {
      throw new Error('The selected WSL2 Shell profile is not ready.')
    }
    return Object.freeze({ distro: saved.distro, user: saved.user })
  }

  async createSupportHandoff(): Promise<WslSupportHandoff> {
    const snapshot = this.latestSnapshot
    if (!snapshot) {
      return {
        errorCode: 'wsl_probe_required',
        supportReference: this.reference(),
        capabilities: {},
        versions: { wsl: 'unknown', distribution: 'unknown' },
        target: 'restore-wsl2-bash'
      }
    }

    const selectedDistro = snapshot.selection
      ? snapshot.distros.find((distro) => distro.name === snapshot.selection?.distro)
      : undefined
    const readiness = snapshot.readiness
    return {
      errorCode: supportErrorCode(snapshot),
      supportReference: snapshot.operationReference,
      capabilities: {
        ...(typeof readiness?.wsl2 === 'boolean' ? { wsl2: readiness.wsl2 } : {}),
        ...(typeof readiness?.home === 'boolean' ? { home: readiness.home } : {}),
        ...(typeof readiness?.bash === 'boolean' ? { bash: readiness.bash } : {}),
        ...(typeof readiness?.bwrap === 'boolean' ? { bwrap: readiness.bwrap } : {}),
        ...(typeof readiness?.python3 === 'boolean' ? { python3: readiness.python3 } : {}),
        ...(typeof readiness?.namespaces === 'boolean' ? { namespaces: readiness.namespaces } : {}),
        ...(typeof readiness?.localWorkspace === 'boolean'
          ? { localWorkspace: readiness.localWorkspace }
          : {})
      },
      versions: {
        wsl: snapshot.readiness?.wsl2 === true ? '2' : 'unknown',
        distribution: selectedDistro ? (String(selectedDistro.version) as '1' | '2') : 'unknown'
      },
      target: 'restore-wsl2-bash'
    }
  }

  private async runProbe(
    operationReference: string,
    selectionOverride?: WslSelection
  ): Promise<WslSetupSnapshot> {
    const status = await this.runner.run(['--status'])
    if (status.exitCode !== 0) {
      if (status.failure === 'not-found') {
        return setupSnapshot('not-installed', operationReference, [], {
          errorCode: 'wsl_not_installed'
        })
      }
      const failure = platformFailure(`${status.stdout}\n${status.stderr}`)
      if (failure.state !== 'failed') {
        return setupSnapshot(failure.state, operationReference, [], { errorCode: failure.code })
      }
      const version = await this.runner.run(['--version'])
      if (version.exitCode === 0) {
        return setupSnapshot('restart-required', operationReference, [], {
          errorCode: 'wsl_restart_required'
        })
      }
      return setupSnapshot(failure.state, operationReference, [], { errorCode: failure.code })
    }

    const names = await this.runner.run(['--list', '--quiet'])
    if (names.exitCode !== 0) {
      return setupSnapshot('failed', operationReference, [], { errorCode: 'wsl_probe_failed' })
    }
    const listed = await this.runner.run(['--list', '--verbose'])
    if (listed.exitCode !== 0) {
      return setupSnapshot('failed', operationReference, [], { errorCode: 'wsl_probe_failed' })
    }
    const distros = parseWslDistros(names.stdout, listed.stdout)
    if (distros.length === 0) {
      return setupSnapshot('distro-required', operationReference, [], {
        errorCode: 'wsl_distro_missing'
      })
    }

    const selection = selectionOverride ?? (await this.options.readSelection())
    if (!selection) return setupSnapshot('distro-required', operationReference, distros)
    const distro = distros.find((candidate) => candidate.name === selection.distro)
    if (!distro) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        errorCode: 'wsl_distro_not_found'
      })
    }
    if (distro.version !== 2) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness(),
        errorCode: 'wsl1_unsupported'
      })
    }
    const workspacePath = this.workspacePath()
    if (!/^[A-Za-z]:\\/.test(workspacePath) || workspacePath.startsWith('\\\\')) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true }),
        errorCode: 'wsl_workspace_path_unsupported'
      })
    }
    const volume = await this.options.volumeProbe(workspacePath)
    if (volume.kind !== 'local-ntfs') {
      const errorCode =
        volume.kind === 'not-local'
          ? 'wsl_workspace_not_local'
          : volume.kind === 'not-ntfs'
            ? 'wsl_workspace_not_ntfs'
            : 'wsl_workspace_volume_unavailable'
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true, localWorkspace: false }),
        errorCode
      })
    }

    const identity = await this.inGuest(selection, [
      'sh',
      '-lc',
      'id -u; id -un; test -n "$HOME" && test -d "$HOME" && printf "home-ok\\n"'
    ])
    const identityOutput = clean(identity.stdout)
    if (identity.exitCode !== 0) {
      // Retrying with the distro's default user distinguishes an uninitialized distro from an
      // invalid explicit username without interpreting localized wsl.exe error prose.
      const defaultIdentity = await this.runner.run([
        '--distribution',
        selection.distro,
        '--exec',
        'id',
        '-u'
      ])
      const firstLaunchRequired = defaultIdentity.exitCode !== 0
      return setupSnapshot(
        firstLaunchRequired ? 'first-launch-required' : 'failed',
        operationReference,
        distros,
        {
          selection,
          readiness: this.readiness({ wsl2: true }),
          errorCode: firstLaunchRequired ? 'wsl_first_launch_required' : 'wsl_user_not_found'
        }
      )
    }
    const [uid, actualUser, homeStatus] = identityOutput.split('\n')
    if (uid === '0') {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true }),
        errorCode: 'wsl_root_user'
      })
    }
    if (actualUser !== selection.user) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true }),
        errorCode: 'wsl_user_mismatch'
      })
    }
    if (homeStatus !== 'home-ok') {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true, home: false }),
        errorCode: 'wsl_home_missing'
      })
    }

    const dependencies = await this.inGuest(selection, [
      'sh',
      '-lc',
      'command -v bash; command -v bwrap; test -x /usr/bin/python3 && /usr/bin/python3 -c "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)" && printf "/usr/bin/python3\\n"; wslinfo --networking-mode'
    ])
    const dependencyOutput = clean(dependencies.stdout)
    const bash = /(^|\n)\/[^\n]*bash(\n|$)/.test(dependencyOutput)
    const bwrap = /(^|\n)\/[^\n]*bwrap(\n|$)/.test(dependencyOutput)
    const python3 = dependencyOutput.split('\n').includes('/usr/bin/python3')
    if (!bash || !bwrap || !python3) {
      const errorCode = !bash
        ? 'wsl_bash_missing'
        : !bwrap
          ? 'wsl_bwrap_missing'
          : 'wsl_python3_missing'
      const suggestedCommand = this.dependencyInstallCommand(selection.distro, errorCode)
      return setupSnapshot('dependency-required', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true, home: true, bash, bwrap, python3 }),
        errorCode,
        ...(suggestedCommand ? { suggestedCommand } : {})
      })
    }

    const mirroredNetworking = dependencyOutput.split('\n').at(-1) === 'mirrored'
    if (!mirroredNetworking) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({
          wsl2: true,
          home: true,
          bash: true,
          bwrap: true,
          python3: true,
          mirroredNetworking: false
        }),
        errorCode: 'wsl_network_mode_unsupported'
      })
    }

    const namespaces = await this.inGuest(selection, [
      'bash',
      '-lc',
      'bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true && printf ok'
    ])
    if (namespaces.exitCode !== 0 || clean(namespaces.stdout) !== 'ok') {
      return setupSnapshot('dependency-required', operationReference, distros, {
        selection,
        readiness: this.readiness({
          wsl2: true,
          home: true,
          bash: true,
          bwrap: true,
          python3: true,
          mirroredNetworking: true,
          namespaces: false
        }),
        errorCode: 'wsl_namespace_unavailable'
      })
    }

    const workspace = await this.inGuest(selection, [
      'bash',
      '-lc',
      'guest_path=$(wslpath -u "$1") && printf "%s\\n" "$guest_path" && test -d "$guest_path" && printf ok',
      '--',
      workspacePath
    ])
    const workspaceLines = clean(workspace.stdout).split('\n')
    if (workspace.exitCode !== 0 || workspaceLines.at(-1) !== 'ok') {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({
          wsl2: true,
          home: true,
          bash: true,
          bwrap: true,
          python3: true,
          namespaces: true,
          localWorkspace: false
        }),
        errorCode: 'wsl_workspace_unreachable'
      })
    }

    return setupSnapshot('ready', operationReference, distros, {
      selection,
      readiness: this.readiness({
        wsl2: true,
        home: true,
        bash: true,
        bwrap: true,
        python3: true,
        mirroredNetworking: true,
        namespaces: true,
        localWorkspace: true
      })
    })
  }

  private inGuest(selection: WslSelection, command: readonly string[]): Promise<WslCommandResult> {
    return this.runner.run([
      '--distribution',
      selection.distro,
      '--user',
      selection.user,
      '--exec',
      ...command
    ])
  }

  private readiness(ready: Partial<WslReadiness> = {}): WslReadiness {
    return ready
  }

  private workspacePath(): string {
    return typeof this.options.workspacePath === 'function'
      ? this.options.workspacePath()
      : this.options.workspacePath
  }

  private remember(snapshot: WslSetupSnapshot): WslSetupSnapshot {
    this.latestSnapshot = snapshot
    return snapshot
  }

  private async withActivation(snapshot: WslSetupSnapshot): Promise<WslSetupSnapshot> {
    const activation = await this.options.readActivation?.()
    if (!activation) return snapshot
    return Object.freeze({
      ...snapshot,
      ...(activation.runtime ? { activeRuntime: activation.runtime } : {}),
      ...(activation.selection
        ? { activatedSelection: Object.freeze({ ...activation.selection }) }
        : {})
    })
  }

  private reference(): string {
    const reference = (this.options.operationReference?.() ?? randomUUID())
      .replaceAll('-', '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)
    return reference || randomUUID().replaceAll('-', '').slice(0, 8)
  }

  private validName(value: string, maxLength: number): boolean {
    return !!value && value.length <= maxLength && !/[\0\r\n]/.test(value)
  }

  private dependencyInstallCommand(distro: string, errorCode: string): string | undefined {
    if (!/ubuntu|debian/i.test(distro)) return undefined
    if (errorCode === 'wsl_bwrap_missing') {
      return 'sudo apt-get update && sudo apt-get install bubblewrap'
    }
    if (errorCode === 'wsl_python3_missing') {
      return 'sudo apt-get update && sudo apt-get install python3'
    }
    return undefined
  }
}
