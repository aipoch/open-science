import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { Logger } from '@aipoch/diagnostics/node'
import { basename, dirname, join } from 'node:path'
import { installationFs } from './installation-filesystem'
import type { ManualInstallInfo, ManualInstallerFormat, UpdateStatus } from '../../shared/update'

export type ManualInstallerArtifact = {
  identity: string
  platform: ManualInstallInfo['platform']
  arch: string
  version: string
  path: string
  source: string
  size: number
  algorithm: 'sha256' | 'sha512'
  checksum: string
  format?: ManualInstallerFormat
  standalone: boolean
  device: number
  inode: number
  modified: number
}
export type ManualInstallerOptions = {
  manualInstallStorePath?: string | null
  revealManualInstallerFile?: (path: string) => void | Promise<void>
  verifyManualInstallerSignature?: (artifact: ManualInstallerArtifact) => Promise<void>
  inspectManualInstallSafety?: () => Promise<boolean | 'quit-required'>
}
const { lstat, open, access } = installationFs.promises
const snapshotKey = (status: UpdateStatus): string =>
  JSON.stringify([
    status.current,
    status.latest,
    status.localPath,
    status.state,
    status.error,
    status.reason,
    status.recovery,
    status.blockedBy,
    status.cliConfirmation,
    status.outcome
  ])

export function manualInstallIsSafe(status: UpdateStatus): boolean {
  const recovery = status.recovery
  return (
    (status.state === 'ready' || status.state === 'error' || status.state === 'available') &&
    !status.blockedBy?.length &&
    !status.cliConfirmation &&
    (!status.reason || status.reason === 'install-failed') &&
    (!recovery ||
      (recovery.runtime === 'running' &&
        recovery.installation === 'unchanged' &&
        recovery.phase === 'preparing' &&
        !recovery.detail))
  )
}

// A pre-native occupancy refusal may expose instructions, never installation authority. The
// current handoff gate and the live main-process safety hook must still authorize it.
export function manualInstallRequiresQuit(status: UpdateStatus): boolean {
  return (
    (status.state === 'ready' || status.state === 'error' || status.state === 'available') &&
    !status.blockedBy?.length &&
    !status.cliConfirmation &&
    status.reason === 'installation-busy' &&
    status.recovery?.phase === 'preparing' &&
    status.recovery.runtime === 'running' &&
    status.recovery.installation === 'unchanged' &&
    status.recovery.detail === 'other-runtime'
  )
}

// This is the first-party publishing contract (electron-builder.yml and version-manifest producer),
// independent of transport: differential NSIS downloads reconstruct this complete setup executable.
export function manualInstallerFormat(
  source: string,
  platform: string,
  arch: string,
  version: string,
  provider: 'manifest' | 'electron',
  hasExtraPackages = false
): ManualInstallerFormat | undefined {
  if (hasExtraPackages || !['x64', 'arm64'].includes(arch)) return undefined
  let name: string
  try {
    name = basename(new URL(source, 'https://updates.invalid/').pathname)
  } catch {
    return undefined
  }
  if (
    platform === 'linux' &&
    name === `aipoch-open-science_${version}_${arch === 'x64' ? 'amd64' : arch}.deb`
  )
    return 'deb'
  const prefix = `aipoch-open-science-${version}-`
  if (!name.startsWith(prefix)) return undefined
  const suffix = name.slice(prefix.length)
  if (platform === 'darwin' && suffix === `mac-${arch}.${provider === 'manifest' ? 'dmg' : 'zip'}`)
    return provider === 'manifest' ? 'dmg' : 'zip'
  if (platform === 'win32' && suffix === `win-${arch}-setup.exe`) return 'nsis'
  if (
    platform === 'linux' &&
    (suffix === `linux-${arch}.AppImage` || (arch === 'x64' && suffix === 'linux-x86_64.AppImage'))
  )
    return 'appimage'
  if (platform === 'linux' && suffix === `linux-${arch}.deb`) return 'deb'
  return undefined
}

/** Main-only artifact ownership and fallback authority. No caller can supply a filesystem path. */
export class ManualInstallerFallback {
  private artifact?: ManualInstallerArtifact
  private failure?: 'download' | 'install'
  private handoffStarted = false
  private revision = 0
  private check?: Promise<ManualInstallInfo>
  private checkSnapshot?: string
  private checkRevision?: number
  private formatHint?: ManualInstallerFormat
  private reveal?: Promise<ManualInstallInfo>
  private qualification?: { snapshot: string; revision: number; info: ManualInstallInfo }
  private readonly options: ManualInstallerOptions
  constructor(
    private readonly platform: ManualInstallInfo['platform'],
    private readonly arch: string,
    options: ManualInstallerOptions,
    private readonly status: () => UpdateStatus,
    private readonly publish: (info: ManualInstallInfo | undefined) => void,
    private readonly log?: Pick<Logger, 'warn'>
  ) {
    this.options = options
  }
  private persist(): void {
    try {
      this.writeRecord()
    } catch (error) {
      // Auxiliary provenance must never change the owning download or installation outcome.
      this.log?.warn('manual update provenance could not be persisted', error)
    }
  }
  private writeRecord(): void {
    const file = this.options.manualInstallStorePath
    if (!file) return
    installationFs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const descriptor = installationFs.openSync(temporary, 'wx', 0o600)
      try {
        installationFs.writeFileSync(
          descriptor,
          JSON.stringify({ schema: 1, artifact: this.artifact })
        )
        installationFs.fsyncSync(descriptor)
      } finally {
        installationFs.closeSync(descriptor)
      }
      installationFs.renameSync(temporary, file)
      if (process.platform !== 'win32') {
        const directory = installationFs.openSync(dirname(file), 'r')
        try {
          installationFs.fsyncSync(directory)
        } finally {
          installationFs.closeSync(directory)
        }
      }
    } finally {
      installationFs.rmSync(temporary, { force: true })
    }
  }
  async capture(
    input: Omit<ManualInstallerArtifact, 'identity' | 'device' | 'inode' | 'modified'>
  ): Promise<void> {
    if (this.hasPendingAttempt())
      throw new Error('A native installation attempt is still unresolved.')
    const revision = ++this.revision
    this.artifact = undefined
    this.failure = undefined
    this.publish(undefined)
    const stat = await lstat(input.path)
    if (!stat.isFile() || stat.size !== input.size) return
    const artifact = {
      ...input,
      identity: randomUUID(),
      device: stat.dev,
      inode: stat.ino,
      modified: stat.mtimeMs
    }
    // Verify bytes before trusting completion notifications or writing durable provenance.
    await this.verify(artifact, false)
    if (revision !== this.revision) return
    this.artifact = artifact
    this.persist()
  }
  supersede(version?: string): void {
    if (this.hasPendingAttempt()) return
    if (this.artifact && this.artifact.version === version) return
    ++this.revision
    this.artifact = undefined
    this.failure = undefined
    this.publish(undefined)
  }
  failed(kind: 'download' | 'install'): void {
    if (this.hasPendingAttempt()) return
    ++this.revision
    this.failure = kind
  }
  clearFailure(): void {
    if (this.hasPendingAttempt()) return
    ++this.revision
    this.failure = undefined
  }
  beforeHandoff(): void {
    // Submission errors do not prove a detached native installer stopped. Only the original
    // installation protection owns cross-start recovery; this gate lives for this process.
    ++this.revision
    this.handoffStarted = true
  }
  handoffRejected(): void {
    // Only a definite OS refusal to open the installer may use this. Exceptions or later SDK
    // errors leave handoffStarted intact because the native outcome is unknown.
    this.handoffStarted = false
    this.failed('install')
  }
  hasPendingAttempt(): boolean {
    return this.handoffStarted
  }
  recovered(): void {
    if (this.hasPendingAttempt() || !this.artifact) return
    ++this.revision
    this.failure = 'install'
  }
  setOfferFormat(format: ManualInstallerFormat | undefined): void {
    this.formatHint = format
  }
  entry(): ManualInstallInfo | undefined {
    if (
      (!this.failure && !manualInstallRequiresQuit(this.status())) ||
      (!manualInstallIsSafe(this.status()) && !manualInstallRequiresQuit(this.status())) ||
      this.handoffStarted
    )
      return undefined
    return this.website(this.failure === 'download' ? 'download-failed' : 'unavailable')
  }
  isCurrent(info: ManualInstallInfo | undefined): boolean {
    return (
      !!info &&
      this.qualification?.info === info &&
      this.qualification.revision === this.revision &&
      this.qualification.snapshot === snapshotKey(this.status())
    )
  }
  private publishQualified(info: ManualInstallInfo): void {
    this.qualification = { snapshot: snapshotKey(this.status()), revision: this.revision, info }
    this.publish(info)
  }
  private base(): Pick<ManualInstallInfo, 'identity' | 'platform' | 'arch' | 'version'> {
    return {
      identity:
        this.artifact?.identity ?? `${this.platform}:${this.arch}:${this.status().latest ?? ''}`,
      platform: this.platform,
      arch: this.arch,
      version: this.status().latest
    }
  }
  private website(
    reason: 'download-failed' | 'unavailable' | 'not-standalone'
  ): Extract<ManualInstallInfo, { kind: 'website' }> {
    return {
      ...this.base(),
      kind: 'website',
      reason,
      ...((this.artifact?.format ?? this.formatHint)
        ? { format: this.artifact?.format ?? this.formatHint }
        : {})
    }
  }
  private blocked(): ManualInstallInfo {
    return { ...this.base(), kind: 'blocked' }
  }
  private async verify(a: ManualInstallerArtifact, signature = true): Promise<void> {
    await access(a.path, constants.R_OK)
    const before = await lstat(a.path)
    if (
      !before.isFile() ||
      before.size !== a.size ||
      before.dev !== a.device ||
      before.ino !== a.inode ||
      before.mtimeMs !== a.modified
    )
      throw new Error('The installer identity has changed.')
    const handle = await open(a.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (opened.dev !== a.device || opened.ino !== a.inode || opened.size !== a.size)
        throw new Error('The installer was replaced.')
      const hash = createHash(a.algorithm)
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      if (hash.digest(a.algorithm === 'sha512' ? 'base64' : 'hex') !== a.checksum)
        throw new Error('The installer checksum has changed.')
    } finally {
      await handle.close()
    }
    if (signature && a.standalone) {
      if (!this.options.verifyManualInstallerSignature)
        throw new Error('Installer signature verification is unavailable.')
      await this.options.verifyManualInstallerSignature(a)
    }
    const after = await lstat(a.path)
    if (
      !after.isFile() ||
      after.dev !== a.device ||
      after.ino !== a.inode ||
      after.size !== a.size ||
      after.mtimeMs !== a.modified
    )
      throw new Error('The installer changed while being verified.')
  }
  get(): Promise<ManualInstallInfo> {
    const snapshot = snapshotKey(this.status())
    if (this.check) {
      // A newer lifecycle waits for the old verifier, then receives its own current-state check.
      // Coalescing an old failed-install snapshot into recovery would otherwise strand the entry.
      if (this.checkSnapshot === snapshot && this.checkRevision === this.revision) return this.check
      return this.check.then(() => this.get())
    }
    const pending = this.inspect()
    this.check = pending
    this.checkSnapshot = snapshot
    this.checkRevision = this.revision
    void pending
      .finally(() => {
        if (this.check === pending) this.check = undefined
      })
      .catch(() => {})
    return pending
  }
  private async inspect(): Promise<ManualInstallInfo> {
    const revision = this.revision
    const snapshot = snapshotKey(this.status())
    const blocked = (): ManualInstallInfo => {
      const result = this.blocked()
      if (
        !this.handoffStarted &&
        revision === this.revision &&
        snapshotKey(this.status()) === snapshot
      )
        this.publishQualified(result)
      return result
    }
    const artifact = this.artifact
    const safe = async (): Promise<boolean | 'quit-required'> => {
      const requiresQuit = manualInstallRequiresQuit(this.status())
      if (this.hasPendingAttempt() || (!manualInstallIsSafe(this.status()) && !requiresQuit))
        return false
      // The narrow occupancy exception always requires live main-process proof. A status snapshot
      // alone, or a missing desktop hook, cannot grant access to manual installer instructions.
      if (!this.options.inspectManualInstallSafety) return !requiresQuit
      const result = await this.options.inspectManualInstallSafety().catch(() => false)
      if (this.hasPendingAttempt()) return false
      return result && (requiresQuit || result === 'quit-required') ? 'quit-required' : result
    }
    if (!this.failure && !manualInstallRequiresQuit(this.status())) return blocked()
    const eligibility = await safe()
    if (!eligibility) return blocked()
    let result: ManualInstallInfo
    if (this.failure === 'download') result = this.website('download-failed')
    else if (!artifact || artifact.version !== this.status().latest)
      result = this.website('unavailable')
    else if (!artifact.standalone || !artifact.format) result = this.website('not-standalone')
    else {
      try {
        await this.verify(artifact)
        result = {
          ...this.base(),
          kind: 'local',
          format: artifact.format,
          fileName: basename(artifact.path),
          size: artifact.size
        }
      } catch {
        result = this.website('unavailable')
      }
    }
    const finalEligibility = await safe()
    if (revision !== this.revision || snapshotKey(this.status()) !== snapshot || !finalEligibility)
      return blocked()
    if (revision !== this.revision || snapshotKey(this.status()) !== snapshot) return blocked()
    if (eligibility === 'quit-required' || finalEligibility === 'quit-required')
      result = { ...result, requiresQuitAndReleaseOccupancy: true }
    this.publishQualified(result)
    return result
  }
  revealInstaller(): Promise<ManualInstallInfo> {
    if (this.reveal) return this.reveal
    const pending = (async () => {
      // A previous entry check is drained, then repeat verification immediately before the OS action.
      if (this.check) await this.check
      const revision = this.revision
      const result = await this.get()
      if (result.kind !== 'local' || revision !== this.revision) return result
      const artifact = this.artifact!
      const snapshot = snapshotKey(this.status())
      if (result.identity !== artifact.identity) return this.blocked()
      try {
        if (!this.options.revealManualInstallerFile) throw new Error('File reveal is unavailable.')
        await this.options.revealManualInstallerFile(artifact.path)
      } catch {
        // Reveal errors are actionable only while the same artifact is still valid.
        const checked = await this.get()
        if (
          checked.kind !== 'local' ||
          checked.identity !== result.identity ||
          revision !== this.revision
        )
          return checked
        const failed = { ...checked, revealError: true }
        this.publishQualified(failed)
        return failed
      }
      if (revision !== this.revision || snapshotKey(this.status()) !== snapshot)
        return this.blocked()
      return result
    })()
    this.reveal = pending
    void pending
      .finally(() => {
        if (this.reveal === pending) this.reveal = undefined
      })
      .catch(() => {})
    return pending
  }
}

export function defaultManualInstallStorePath(userData: string): string {
  return join(userData, 'manual-update-artifact.json')
}

export async function verifyManualInstallerSignature(
  artifact: ManualInstallerArtifact,
  windowsVerifier?: (path: string) => Promise<string | null>
): Promise<void> {
  if (artifact.platform === 'darwin') {
    if (artifact.format === 'zip') {
      const { inspectMacUpdateArtifact } = await import('./installation-artifact')
      await inspectMacUpdateArtifact(artifact.path, artifact.version, AbortSignal.timeout(120_000))
    } else if (artifact.format === 'dmg') {
      const { runVerificationProcess } = await import('./verification-process')
      const options = { signal: AbortSignal.timeout(120_000) }
      await runVerificationProcess(
        '/usr/bin/codesign',
        ['--verify', '--strict', artifact.path],
        options
      )
      const signature = await runVerificationProcess(
        '/usr/bin/codesign',
        ['-d', '--verbose=4', artifact.path],
        options
      )
      if (
        !`${signature.stdout}\n${signature.stderr}`
          .split(/\r?\n/)
          .includes('TeamIdentifier=87G9WFU9H3')
      )
        throw new Error('The installer publisher differs from this application.')
      await runVerificationProcess(
        '/usr/sbin/spctl',
        ['--assess', '--type', 'open', '--context', 'context:primary-signature', artifact.path],
        options
      )
    } else throw new Error('Unsupported macOS installer format.')
  } else if (artifact.platform === 'win32') {
    if (!windowsVerifier) throw new Error('The update channel signature verifier is unavailable.')
    const error = await windowsVerifier(artifact.path)
    if (error) throw new Error(error)
  }
  // Linux distribution artifacts use the existing trusted HTTPS feed + digest channel.
}
