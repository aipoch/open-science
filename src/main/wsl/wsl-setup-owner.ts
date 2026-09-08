import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { arch, release } from 'node:os'

import {
  RECOMMENDED_WSL_DISTRO,
  WSL_PLATFORM_OWNERSHIP,
  WSL_SETUP_DIAGNOSTICS_SCHEMA_VERSION,
  type OpenWslTerminalRequest,
  type SelectWslProfileRequest,
  type WslDistro,
  type WslReadiness,
  type WslDiagnosticCheck,
  type WslSelection,
  type WslPlatformInstallResult,
  type WslSetupOperation,
  type WslSetupOperationKind,
  type WslSetupOperationOutcome,
  type WslSetupSnapshot,
  type WslSetupFailure,
  type WslSetupGuide,
  type WslSetupStatus,
  type WslSetupState,
  type WslSupportHandoff
} from '../../shared/wsl-setup'
import { createLogger } from '../logger'
import { SettingsInstallCoordinator } from '../settings/settings-install-coordinator'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import type { WindowsVolumeProbeResult } from './windows-volume-probe'
import type {
  WslSetupOperationJournal,
  WslSetupOperationRecord
} from './wsl-setup-operation-journal'
import { loadWslSetupGuide } from './wsl-setup-guide'

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
  installCoordinator?: SettingsInstallCoordinator
  operationJournal?: WslSetupOperationJournal
  onStatusChanged?(status: WslSetupStatus): void
  operationReference?: () => string
  loadGuide?: () => Promise<WslSetupGuide>
  previewStatus?: () => Readonly<{ available: boolean; reason: string }>
  windowsVersion?: () => Readonly<{ version: string; build: string; architecture: string }>
  now?: () => number
  log?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>
}>

type WslActivation = Awaited<ReturnType<NonNullable<WslSetupOwnerOptions['readActivation']>>>

export interface WslTerminalLauncher {
  open(args: readonly string[]): Promise<void>
}

export { RECOMMENDED_WSL_DISTRO }
export const WSL_DISTRO_INSTALL_TIMEOUT_MS = 10 * 60_000
export const WSL_SETUP_DIAGNOSTICS_STALE = 'WSL_SETUP_DIAGNOSTICS_STALE'

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

const MAX_DIAGNOSTIC_TEXT = 512
const SECRET_ASSIGNMENT =
  /\b(password|passwd|secret|token|credential|authorization|cookie)\s*[:=]\s*([^\s,;]+)/gi

export const boundedWslDiagnosticText = (value: string): string | undefined => {
  const normalized = clean(value)
    .replace(SECRET_ASSIGNMENT, '$1=[redacted]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  if (!normalized) return undefined
  return normalized.length <= MAX_DIAGNOSTIC_TEXT
    ? normalized
    : `${normalized.slice(0, MAX_DIAGNOSTIC_TEXT - 1)}…`
}

const diagnosticFailure = (
  stage: WslSetupFailure['stage'],
  code: string,
  result?: WslCommandResult
): WslSetupFailure => ({
  stage,
  code,
  ...(result ? { exitCode: result.exitCode } : {}),
  ...(result?.failure === 'timeout' ? { timedOut: true } : {}),
  ...(result && boundedWslDiagnosticText(result.stdout)
    ? { stdout: boundedWslDiagnosticText(result.stdout) }
    : {}),
  ...(result && boundedWslDiagnosticText(result.stderr)
    ? { stderr: boundedWslDiagnosticText(result.stderr) }
    : {})
})

const check = (
  value: boolean | undefined,
  applicable: boolean,
  extra: Partial<Omit<WslDiagnosticCheck, 'state'>> = {}
): WslDiagnosticCheck => ({
  state: !applicable
    ? 'not-applicable'
    : value === true
      ? 'pass'
      : value === false
        ? 'fail'
        : 'not-checked',
  ...extra
})

const parseWslSoftwareVersion = (output: string): string => {
  const value = clean(output)
  const match = value.match(/^WSL(?!g)\b[^:\r\n：]*[:：]\s*(\d+(?:\.\d+){1,3})\b/im)
  return match?.[1]?.trim() || 'unknown'
}

const DOCKER_DESKTOP_INTERNAL_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

const isDockerDesktopInternalDistro = (name: string): boolean =>
  DOCKER_DESKTOP_INTERNAL_DISTROS.has(name.trim().toLowerCase())

const isSelectableDistro = (distro: WslDistro): boolean =>
  !isDockerDesktopInternalDistro(distro.name)

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
  private readonly installCoordinator: SettingsInstallCoordinator
  private latestSnapshot: WslSetupSnapshot | undefined
  private operation: WslSetupOperation = Object.freeze({ state: 'idle' })
  private revision = 0
  private activePlatformInstall: Promise<WslPlatformInstallResult> | undefined
  private activeRecommendedDistroInstall: Promise<WslSetupSnapshot> | undefined
  private reconciliation: Promise<void> | undefined
  private selectionTail: Promise<void> = Promise.resolve()
  private recoveryBlocked = false
  private recoveryRecord: WslSetupOperationRecord | undefined
  private readonly inProcessOperationReferences = new Set<string>()

  constructor(private readonly options: WslSetupOwnerOptions) {
    this.runner = options.runner ?? executeWsl
    this.installer = options.installer ?? elevatedWslPlatformInstaller
    this.terminal = options.terminal ?? openWslTerminal
    this.log = options.log ?? createLogger('wsl-setup')
    this.installCoordinator = options.installCoordinator ?? new SettingsInstallCoordinator()
  }

  getStatus(): WslSetupStatus {
    return Object.freeze({
      revision: this.revision,
      ...(this.latestSnapshot ? { snapshot: this.latestSnapshot } : {}),
      operation: this.operation
    })
  }

  reconcileInterruptedOperation(): Promise<WslSetupStatus> {
    if (!this.options.operationJournal) return Promise.resolve(this.getStatus())
    this.reconciliation ??= this.runInterruptedOperationReconciliation()
    return this.reconciliation.then(() => this.getStatus())
  }

  private async runInterruptedOperationReconciliation(): Promise<void> {
    let record: WslSetupOperationRecord | undefined
    try {
      record = await this.options.operationJournal?.load()
    } catch (error) {
      this.log.warn('wsl setup operation journal could not be read', { error })
      this.recoveryBlocked = true
      this.recoveryRecord = undefined
      this.latestSnapshot = setupSnapshot('failed', this.reference(), [], {
        errorCode: 'wsl_install_journal_unavailable'
      })
      this.statusChanged()
      return
    }
    if (!record || this.inProcessOperationReferences.has(record.operationReference)) {
      if (!record) this.recoveryBlocked = false
      return
    }

    this.recoveryBlocked = true
    this.recoveryRecord = record
    await this.reconcileOperationRecord(record)
  }

  private async reconcileOperationRecord(record: WslSetupOperationRecord): Promise<void> {
    let snapshot: WslSetupSnapshot
    try {
      snapshot = await this.runProbe(record.operationReference)
    } catch {
      snapshot = setupSnapshot('failed', record.operationReference, [], {
        errorCode: 'wsl_install_interrupted'
      })
    }
    const confirmed =
      record.kind === 'install-platform'
        ? snapshot.state !== 'not-installed' && snapshot.state !== 'failed'
        : snapshot.state === 'restart-required' ||
          snapshot.distros.some((distro) => distro.name === RECOMMENDED_WSL_DISTRO)
    if (!confirmed) {
      snapshot = {
        ...snapshot,
        state: 'failed',
        errorCode: 'wsl_install_interrupted',
        operationReference: record.operationReference
      }
    }
    this.latestSnapshot = await this.withActivation(snapshot)
    if (!confirmed) {
      this.finishOperation(record.kind, record.operationReference, record.startedAt, 'interrupted')
      return
    }

    try {
      await this.options.operationJournal?.clear()
      this.recoveryBlocked = false
      this.recoveryRecord = undefined
      this.finishOperation(
        record.kind,
        record.operationReference,
        record.startedAt,
        snapshot.state === 'restart-required' ? 'restart-required' : 'completed'
      )
    } catch (error) {
      this.log.warn('wsl setup operation journal could not be cleared', { error })
      this.latestSnapshot = setupSnapshot('failed', record.operationReference, snapshot.distros, {
        errorCode: 'wsl_install_journal_unavailable'
      })
      this.finishOperation(record.kind, record.operationReference, record.startedAt, 'failed')
    }
  }

  installPlatform(): Promise<WslPlatformInstallResult> {
    if (this.activePlatformInstall) return this.activePlatformInstall
    const completion = this.runPlatformInstall()
    this.activePlatformInstall = completion
    const clear = (): void => {
      if (this.activePlatformInstall === completion) this.activePlatformInstall = undefined
    }
    completion.then(clear, clear)
    return completion
  }

  private async runPlatformInstall(): Promise<WslPlatformInstallResult> {
    if (this.options.operationJournal) await this.reconcileInterruptedOperation()
    if (this.recoveryBlocked) {
      const snapshot =
        this.latestSnapshot ??
        setupSnapshot('failed', this.reference(), [], {
          errorCode: 'wsl_install_journal_unavailable'
        })
      return {
        outcome: 'unknown',
        ownership: WSL_PLATFORM_OWNERSHIP,
        operationReference: snapshot.operationReference,
        snapshot
      }
    }
    const startedAt = Date.now()
    const operationReference = this.reference()
    const lease = this.installCoordinator.tryAcquire(`wsl-platform:${operationReference}`)
    if (!lease) {
      const snapshot = await this.withActivation(
        setupSnapshot('failed', operationReference, [], { errorCode: 'wsl_install_conflict' })
      )
      this.latestSnapshot = snapshot
      this.statusChanged()
      return {
        outcome: 'unknown',
        ownership: WSL_PLATFORM_OWNERSHIP,
        operationReference,
        snapshot
      }
    }
    this.inProcessOperationReferences.add(operationReference)
    let journalSaved = false
    try {
      this.operation = Object.freeze({
        state: 'running',
        kind: 'install-platform',
        phase: 'installing',
        operationReference,
        startedAt
      })
      this.statusChanged()
      if (this.options.operationJournal) {
        try {
          await this.options.operationJournal.save({
            kind: 'install-platform',
            operationReference,
            startedAt
          })
          journalSaved = true
        } catch (error) {
          this.log.warn('wsl setup operation journal could not be written', { error })
          const snapshot = await this.withActivation(
            setupSnapshot('failed', operationReference, [], {
              errorCode: 'wsl_install_journal_unavailable'
            })
          )
          this.latestSnapshot = snapshot
          this.finishOperation('install-platform', operationReference, startedAt, 'failed')
          return {
            outcome: 'unknown',
            ownership: WSL_PLATFORM_OWNERSHIP,
            operationReference,
            snapshot
          }
        }
      }
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
          errorCode: 'wsl_install_uac_cancelled',
          failure: {
            stage: 'installation',
            code: 'wsl_install_uac_cancelled',
            cancelled: true
          }
        })
      } else if (execution.kind === 'spawn-failed') {
        outcome = 'spawn-failed'
        snapshot = setupSnapshot('not-installed', operationReference, [], {
          errorCode: 'wsl_install_spawn_failed',
          failure: diagnosticFailure('installation', 'wsl_install_spawn_failed')
        })
      } else {
        this.operation = Object.freeze({
          state: 'running',
          kind: 'install-platform',
          phase: 'verifying',
          operationReference,
          startedAt
        })
        this.statusChanged()
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
          if (outcome === 'unknown') {
            snapshot = {
              ...snapshot,
              errorCode: 'wsl_install_unknown',
              failure: {
                stage: 'installation',
                code: 'wsl_install_unknown',
                exitCode: execution.exitCode
              }
            }
          }
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
      if (journalSaved) {
        journalSaved = false
        const cleared = await this.clearOperationJournal({
          kind: 'install-platform',
          operationReference,
          startedAt
        })
        if (!cleared) {
          outcome = 'unknown'
          snapshot = setupSnapshot('failed', operationReference, snapshot.distros, {
            errorCode: 'wsl_install_journal_unavailable'
          })
        }
      }
      this.latestSnapshot = snapshot
      this.finishOperation(
        'install-platform',
        operationReference,
        startedAt,
        this.platformOperationOutcome(outcome)
      )
      return {
        outcome,
        ownership: WSL_PLATFORM_OWNERSHIP,
        operationReference,
        snapshot
      }
    } finally {
      if (journalSaved) {
        journalSaved = false
        const record = { kind: 'install-platform' as const, operationReference, startedAt }
        if (!(await this.clearOperationJournal(record))) {
          this.latestSnapshot = setupSnapshot('failed', operationReference, [], {
            errorCode: 'wsl_install_journal_unavailable'
          })
          this.finishOperation('install-platform', operationReference, startedAt, 'failed')
        }
      }
      this.inProcessOperationReferences.delete(operationReference)
      lease.release()
    }
  }

  installRecommendedDistro(): Promise<WslSetupSnapshot> {
    if (this.activeRecommendedDistroInstall) return this.activeRecommendedDistroInstall
    const completion = this.runRecommendedDistroInstall()
    this.activeRecommendedDistroInstall = completion
    const clear = (): void => {
      if (this.activeRecommendedDistroInstall === completion) {
        this.activeRecommendedDistroInstall = undefined
      }
    }
    completion.then(clear, clear)
    return completion
  }

  private async runRecommendedDistroInstall(): Promise<WslSetupSnapshot> {
    if (this.options.operationJournal) await this.reconcileInterruptedOperation()
    if (this.recoveryBlocked) {
      return (
        this.latestSnapshot ??
        setupSnapshot('failed', this.reference(), [], {
          errorCode: 'wsl_install_journal_unavailable'
        })
      )
    }
    const operationReference = this.reference()
    const startedAt = Date.now()
    const lease = this.installCoordinator.tryAcquire(`wsl-distro:${operationReference}`)
    if (!lease) {
      return this.remember(
        setupSnapshot('failed', operationReference, [], { errorCode: 'wsl_install_conflict' })
      )
    }
    this.inProcessOperationReferences.add(operationReference)
    let journalSaved = false
    this.operation = Object.freeze({
      state: 'running',
      kind: 'install-recommended-distro',
      phase: 'verifying',
      operationReference,
      startedAt
    })
    this.statusChanged()
    let terminalOutcome: WslSetupOperationOutcome = 'failed'
    const settle = async (
      candidate: WslSetupSnapshot,
      outcome: WslSetupOperationOutcome
    ): Promise<WslSetupSnapshot> => {
      terminalOutcome = outcome
      let snapshot = candidate
      if (journalSaved) {
        journalSaved = false
        const cleared = await this.clearOperationJournal({
          kind: 'install-recommended-distro',
          operationReference,
          startedAt
        })
        if (!cleared) {
          terminalOutcome = 'failed'
          snapshot = setupSnapshot('failed', operationReference, candidate.distros, {
            errorCode: 'wsl_install_journal_unavailable'
          })
        }
      }
      return this.remember(snapshot)
    }
    try {
      const current = await this.probeForOperation(operationReference)
      if (current.state !== 'distro-required' || current.distros.length > 0) {
        terminalOutcome = 'blocked'
        return this.remember(
          setupSnapshot('failed', operationReference, current.distros, {
            selection: current.selection,
            readiness: current.readiness,
            errorCode: 'wsl_distro_install_not_allowed'
          })
        )
      }

      this.operation = Object.freeze({
        state: 'running',
        kind: 'install-recommended-distro',
        phase: 'installing',
        operationReference,
        startedAt
      })
      this.statusChanged()
      try {
        await this.options.operationJournal?.save({
          kind: 'install-recommended-distro',
          operationReference,
          startedAt
        })
        journalSaved = this.options.operationJournal !== undefined
      } catch (error) {
        this.log.warn('wsl setup operation journal could not be written', { error })
        return this.remember(
          setupSnapshot('failed', operationReference, [], {
            errorCode: 'wsl_install_journal_unavailable'
          })
        )
      }
      this.log.info('wsl distro install started', { operationReference })
      const result = await this.runner.run(
        ['--install', '--distribution', RECOMMENDED_WSL_DISTRO, '--no-launch'],
        { timeoutMs: WSL_DISTRO_INSTALL_TIMEOUT_MS }
      )
      this.operation = Object.freeze({
        state: 'running',
        kind: 'install-recommended-distro',
        phase: 'verifying',
        operationReference,
        startedAt
      })
      this.statusChanged()
      const fresh = await this.probeForOperation(operationReference)
      if (
        fresh.state === 'restart-required' ||
        fresh.distros.some((item) => item.name === RECOMMENDED_WSL_DISTRO)
      ) {
        const outcome = fresh.state === 'restart-required' ? 'restart-required' : 'completed'
        this.log.info('wsl distro install completed', {
          operationReference,
          outcome: fresh.state,
          durationMs: Date.now() - startedAt
        })
        return settle(fresh, outcome)
      }
      this.log.warn('wsl distro install completed', {
        operationReference,
        outcome: 'failed',
        errorCode:
          result.exitCode === 0 ? 'wsl_distro_install_unconfirmed' : 'wsl_distro_install_failed',
        durationMs: Date.now() - startedAt
      })
      return settle(
        setupSnapshot('failed', operationReference, fresh.distros, {
          errorCode:
            result.exitCode === 0 ? 'wsl_distro_install_unconfirmed' : 'wsl_distro_install_failed'
        }),
        'failed'
      )
    } finally {
      if (journalSaved) {
        journalSaved = false
        const record = {
          kind: 'install-recommended-distro' as const,
          operationReference,
          startedAt
        }
        if (!(await this.clearOperationJournal(record))) {
          terminalOutcome = 'failed'
          this.latestSnapshot = setupSnapshot('failed', operationReference, [], {
            errorCode: 'wsl_install_journal_unavailable'
          })
        }
      }
      this.inProcessOperationReferences.delete(operationReference)
      this.finishOperation(
        'install-recommended-distro',
        operationReference,
        startedAt,
        terminalOutcome
      )
      lease.release()
    }
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

  select(request: SelectWslProfileRequest): Promise<WslSetupSnapshot> {
    return this.enqueueSelection(() => this.selectProfile(request))
  }

  selectAtRevision(
    request: SelectWslProfileRequest,
    expectedRevision: number
  ): Promise<WslSetupSnapshot> {
    return this.enqueueSelection(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revision) {
        throw new Error(WSL_SETUP_DIAGNOSTICS_STALE)
      }
      return this.selectProfile(request)
    })
  }

  private async selectProfile(request: SelectWslProfileRequest): Promise<WslSetupSnapshot> {
    const selection = { distro: request.distro.trim(), user: request.user.trim() }
    if (
      !selection.distro ||
      !selection.user ||
      selection.distro.length > 256 ||
      selection.user.length > 128 ||
      /[\0\r\n]/.test(selection.distro) ||
      /[\0\r\n]/.test(selection.user) ||
      isDockerDesktopInternalDistro(selection.distro)
    ) {
      const snapshot = setupSnapshot('failed', this.reference(), [], {
        errorCode: 'wsl_selection_invalid'
      })
      return this.remember(snapshot)
    }
    await this.options.writeSelection(selection)
    return this.probe(selection)
  }

  private enqueueSelection(operation: () => Promise<WslSetupSnapshot>): Promise<WslSetupSnapshot> {
    const result = this.selectionTail.then(operation, operation)
    this.selectionTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async probe(selectionOverride?: WslSelection): Promise<WslSetupSnapshot> {
    if (this.options.operationJournal && this.recoveryBlocked) {
      if (this.recoveryRecord) {
        await this.reconcileOperationRecord(this.recoveryRecord)
      } else {
        this.reconciliation = undefined
        await this.reconcileInterruptedOperation()
      }
      if (this.latestSnapshot) return this.latestSnapshot
    }
    if (this.operation.state === 'running') {
      return this.latestSnapshot ?? setupSnapshot('checking', this.operation.operationReference)
    }
    const startedAt = Date.now()
    const operationReference = this.reference()
    const startingRevision = this.revision
    this.log.info('wsl probe started', { operationReference })
    const snapshot = await this.probeForOperation(operationReference, selectionOverride)
    const fields = {
      operationReference,
      state: snapshot.state,
      errorCode: snapshot.errorCode,
      durationMs: Date.now() - startedAt
    }
    if (snapshot.state === 'ready') this.log.info('wsl probe completed', fields)
    else this.log.warn('wsl probe completed', fields)
    if (this.revision !== startingRevision) return this.latestSnapshot ?? snapshot
    this.latestSnapshot = snapshot
    this.operation = Object.freeze({ state: 'idle' })
    this.statusChanged()
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
    const revision = this.revision
    const guide = await (this.options.loadGuide ?? loadWslSetupGuide)()
    const capturedAt = new Date((this.options.now ?? Date.now)()).toISOString()
    const windows = this.options.windowsVersion?.() ?? {
      version: release(),
      build: release().split('.').at(-1) ?? 'unknown',
      architecture: arch()
    }
    const preview = this.options.previewStatus?.()
    const versionResult = await this.runner.run(['--version'])
    const softwareVersion =
      versionResult.exitCode === 0 ? parseWslSoftwareVersion(versionResult.stdout) : 'unknown'
    if (!snapshot) {
      const operationReference = this.reference()
      return {
        schemaVersion: WSL_SETUP_DIAGNOSTICS_SCHEMA_VERSION,
        guide,
        capturedAt,
        revision,
        errorCode: 'wsl_probe_required',
        supportReference: operationReference,
        operationReference,
        windows: {
          ...windows,
          previewAvailable: preview?.available ?? 'unknown',
          previewReason: preview?.reason ?? 'unknown'
        },
        wsl: {
          softwareVersion,
          linuxKernelVersion: 'unknown',
          installState: 'checking'
        },
        distros: [],
        currentBackend: 'unknown',
        checks: {
          wsl2: check(undefined, true),
          home: check(undefined, true),
          bash: check(undefined, true),
          bwrap: check(undefined, true),
          python3: check(undefined, true),
          mirroredNetworking: check(undefined, true),
          namespaces: check(undefined, true),
          localWorkspace: check(undefined, true)
        },
        operation: this.operation,
        recovery: {
          restartRequired: false,
          resultUnknown: false,
          recheck: ['platform', 'distribution', 'target']
        },
        capabilities: {},
        versions: { wsl: softwareVersion, distribution: 'unknown' },
        target: 'restore-wsl2-bash'
      }
    }

    const selectedDistro = snapshot.selection
      ? snapshot.distros.find((distro) => distro.name === snapshot.selection?.distro)
      : undefined
    const readiness = snapshot.readiness
    const defaultUsers = new Map<string, Readonly<{ user: string; isRoot: boolean }>>()
    for (const distro of snapshot.distros) {
      if (distro.version !== 2) continue
      const identity = await this.runner.run([
        '--distribution',
        distro.name,
        '--exec',
        'sh',
        '-lc',
        'id -un; id -u'
      ])
      const [user, uid, ...extra] = clean(identity.stdout).split('\n')
      if (
        identity.exitCode === 0 &&
        extra.length === 0 &&
        this.validName(user ?? '', 128) &&
        /^\d+$/.test(uid ?? '')
      ) {
        defaultUsers.set(distro.name, { user, isRoot: uid === '0' })
      }
    }
    let linuxKernelVersion = 'unknown'
    let distroRelease: string | undefined
    let dependencyVersions: Readonly<{ bash?: string; bwrap?: string; python3?: string }> = {}
    if (snapshot.selection && selectedDistro?.version === 2) {
      const details = await this.inGuest(snapshot.selection, [
        'sh',
        '-lc',
        'printf "kernel=%s\\n" "$(uname -r 2>/dev/null)"; printf "distroRelease=%s\\n" "$(. /etc/os-release 2>/dev/null && printf %s "$VERSION_ID")"; printf "bash=%s\\n" "$(bash --version 2>/dev/null | head -n 1)"; printf "bwrap=%s\\n" "$(bwrap --version 2>/dev/null)"; printf "python3=%s\\n" "$(/usr/bin/python3 --version 2>/dev/null)"'
      ])
      if (details.exitCode === 0) {
        const values = new Map(
          clean(details.stdout)
            .split('\n')
            .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string])
        )
        linuxKernelVersion = values.get('kernel') || 'unknown'
        distroRelease = values.get('distroRelease') || undefined
        dependencyVersions = {
          ...(values.get('bash') ? { bash: values.get('bash') } : {}),
          ...(values.get('bwrap') ? { bwrap: values.get('bwrap') } : {}),
          ...(values.get('python3') ? { python3: values.get('python3') } : {})
        }
      }
    }
    const platformApplicable = snapshot.state !== 'not-installed'
    const lastOperation = this.operation.state === 'idle' ? undefined : this.operation.kind
    const resultUnknown =
      this.recoveryBlocked ||
      (this.operation.state === 'finished' &&
        (this.operation.outcome === 'interrupted' || this.operation.outcome === 'failed'))
    return {
      schemaVersion: WSL_SETUP_DIAGNOSTICS_SCHEMA_VERSION,
      guide,
      capturedAt,
      revision,
      errorCode: supportErrorCode(snapshot),
      supportReference: snapshot.operationReference,
      operationReference: snapshot.operationReference,
      windows: {
        ...windows,
        previewAvailable: preview?.available ?? 'unknown',
        previewReason: preview?.reason ?? 'unknown'
      },
      wsl: {
        softwareVersion,
        linuxKernelVersion,
        installState: snapshot.state
      },
      distros: snapshot.distros.map((distro) =>
        Object.freeze({
          ...distro,
          ...(defaultUsers.get(distro.name)
            ? {
                defaultUser: defaultUsers.get(distro.name)?.user,
                defaultUserIsRoot: defaultUsers.get(distro.name)?.isRoot
              }
            : {}),
          ...(distro.name === snapshot.selection?.distro && distroRelease
            ? { release: distroRelease }
            : {})
        })
      ),
      ...(snapshot.selection ? { selectedTarget: Object.freeze({ ...snapshot.selection }) } : {}),
      ...(snapshot.activatedSelection
        ? { activatedTarget: Object.freeze({ ...snapshot.activatedSelection }) }
        : {}),
      currentBackend: snapshot.activeRuntime ?? 'unknown',
      checks: {
        wsl2: check(readiness?.wsl2, platformApplicable),
        home: check(readiness?.home, platformApplicable),
        bash: check(readiness?.bash, platformApplicable, {
          ...(dependencyVersions.bash ? { version: dependencyVersions.bash } : {})
        }),
        bwrap: check(readiness?.bwrap, platformApplicable, {
          ...(dependencyVersions.bwrap ? { version: dependencyVersions.bwrap } : {})
        }),
        python3: check(readiness?.python3, platformApplicable, {
          ...(dependencyVersions.python3 ? { version: dependencyVersions.python3 } : {}),
          ...(readiness?.python3 !== undefined ? { path: '/usr/bin/python3' } : {})
        }),
        mirroredNetworking: check(readiness?.mirroredNetworking, platformApplicable),
        namespaces: check(readiness?.namespaces, platformApplicable),
        localWorkspace: check(readiness?.localWorkspace, platformApplicable)
      },
      ...(snapshot.failure
        ? { failure: snapshot.failure }
        : snapshot.state === 'failed' || snapshot.state === 'dependency-required'
          ? { failure: diagnosticFailure('platform', supportErrorCode(snapshot)) }
          : {}),
      operation: this.operation,
      recovery: {
        ...(lastOperation ? { lastOperation } : {}),
        restartRequired: snapshot.state === 'restart-required',
        resultUnknown,
        recheck: resultUnknown
          ? ['platform', 'distribution', 'target', 'dependencies', 'networking']
          : snapshot.state === 'ready'
            ? []
            : ['target', 'dependencies', 'networking']
      },
      capabilities: {
        ...(typeof readiness?.wsl2 === 'boolean' ? { wsl2: readiness.wsl2 } : {}),
        ...(typeof readiness?.home === 'boolean' ? { home: readiness.home } : {}),
        ...(typeof readiness?.bash === 'boolean' ? { bash: readiness.bash } : {}),
        ...(typeof readiness?.bwrap === 'boolean' ? { bwrap: readiness.bwrap } : {}),
        ...(typeof readiness?.python3 === 'boolean' ? { python3: readiness.python3 } : {}),
        ...(typeof readiness?.mirroredNetworking === 'boolean'
          ? { mirroredNetworking: readiness.mirroredNetworking }
          : {}),
        ...(typeof readiness?.namespaces === 'boolean' ? { namespaces: readiness.namespaces } : {}),
        ...(typeof readiness?.localWorkspace === 'boolean'
          ? { localWorkspace: readiness.localWorkspace }
          : {})
      },
      versions: {
        wsl: softwareVersion,
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
          errorCode: 'wsl_not_installed',
          failure: diagnosticFailure('platform', 'wsl_not_installed', status)
        })
      }
      const failure = platformFailure(`${status.stdout}\n${status.stderr}`)
      if (failure.state !== 'failed') {
        return setupSnapshot(failure.state, operationReference, [], { errorCode: failure.code })
      }
      const version = await this.runner.run(['--version'])
      if (version.exitCode === 0) {
        return setupSnapshot('restart-required', operationReference, [], {
          errorCode: 'wsl_restart_required',
          failure: diagnosticFailure('platform', 'wsl_restart_required', status)
        })
      }
      return setupSnapshot(failure.state, operationReference, [], {
        errorCode: failure.code,
        failure: diagnosticFailure('platform', failure.code, status)
      })
    }

    const names = await this.runner.run(['--list', '--quiet'])
    if (names.exitCode !== 0) {
      return setupSnapshot('failed', operationReference, [], {
        errorCode: 'wsl_probe_failed',
        failure: diagnosticFailure('distribution', 'wsl_probe_failed', names)
      })
    }
    const listed = await this.runner.run(['--list', '--verbose'])
    if (listed.exitCode !== 0) {
      return setupSnapshot('failed', operationReference, [], {
        errorCode: 'wsl_probe_failed',
        failure: diagnosticFailure('distribution', 'wsl_probe_failed', listed)
      })
    }
    const distros = parseWslDistros(names.stdout, listed.stdout).filter(isSelectableDistro)
    if (distros.length === 0) {
      return setupSnapshot('distro-required', operationReference, [], {
        errorCode: 'wsl_distro_missing'
      })
    }

    const selection = selectionOverride ?? (await this.options.readSelection())
    if (!selection || isDockerDesktopInternalDistro(selection.distro)) {
      return setupSnapshot('distro-required', operationReference, distros)
    }
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
          errorCode: firstLaunchRequired ? 'wsl_first_launch_required' : 'wsl_user_not_found',
          failure: diagnosticFailure(
            'identity',
            firstLaunchRequired ? 'wsl_first_launch_required' : 'wsl_user_not_found',
            identity
          )
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
        failure: diagnosticFailure('dependencies', errorCode, dependencies),
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
        errorCode: 'wsl_network_mode_unsupported',
        failure: diagnosticFailure('networking', 'wsl_network_mode_unsupported', dependencies)
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
        errorCode: 'wsl_namespace_unavailable',
        failure: diagnosticFailure('namespaces', 'wsl_namespace_unavailable', namespaces)
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
        errorCode: 'wsl_workspace_unreachable',
        failure: diagnosticFailure('workspace', 'wsl_workspace_unreachable', workspace)
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
    this.statusChanged()
    return snapshot
  }

  private async probeForOperation(
    operationReference: string,
    selectionOverride?: WslSelection
  ): Promise<WslSetupSnapshot> {
    let snapshot: WslSetupSnapshot
    try {
      snapshot = await this.runProbe(operationReference, selectionOverride)
    } catch {
      snapshot = setupSnapshot('failed', operationReference, [], { errorCode: 'wsl_probe_failed' })
    }
    return this.withActivation(snapshot)
  }

  private finishOperation(
    kind: WslSetupOperationKind,
    operationReference: string,
    startedAt: number,
    outcome: WslSetupOperationOutcome
  ): void {
    this.operation = Object.freeze({
      state: 'finished',
      kind,
      outcome,
      operationReference,
      startedAt,
      finishedAt: Date.now()
    })
    this.statusChanged()
  }

  private async clearOperationJournal(record: WslSetupOperationRecord): Promise<boolean> {
    try {
      await this.options.operationJournal?.clear()
      return true
    } catch (error) {
      this.log.warn('wsl setup operation journal could not be cleared', { error })
      this.recoveryBlocked = true
      this.recoveryRecord = record
      return false
    }
  }

  private platformOperationOutcome(
    outcome: WslPlatformInstallResult['outcome']
  ): WslSetupOperationOutcome {
    switch (outcome) {
      case 'completed':
        return 'completed'
      case 'restart-required':
        return 'restart-required'
      case 'uac-cancelled':
        return 'cancelled'
      case 'spawn-failed':
      case 'unknown':
        return 'failed'
    }
  }

  private statusChanged(): void {
    this.revision += 1
    try {
      this.options.onStatusChanged?.(this.getStatus())
    } catch (error) {
      this.log.warn('wsl status observer failed', { error })
    }
  }

  private async withActivation(snapshot: WslSetupSnapshot): Promise<WslSetupSnapshot> {
    let activation: WslActivation | undefined
    try {
      activation = await this.options.readActivation?.()
    } catch (error) {
      this.log.warn('wsl activation metadata could not be read', { error })
      return snapshot
    }
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
