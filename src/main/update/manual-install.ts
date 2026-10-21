import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { installationFs } from './installation-filesystem'
import { isNewer } from '../../shared/update'
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
  inspectManualInstallSafety?: () => Promise<boolean>
  // Native result/process evidence is required. An unchanged running version is never failure proof.
  observeManualInstallHandoff?: (
    artifact: ManualInstallerArtifact,
    operationId?: string
  ) => Promise<void>
  manualInstallRecovery?: (
    artifact: ManualInstallerArtifact,
    operationId?: string
  ) => Promise<'failed' | 'pending' | 'installed'>
}
type Stored = {
  schema: 1
  artifact?: ManualInstallerArtifact
  failure?: 'download' | 'install'
  attempt?: { identity: string; version: string; operationId?: string; state: 'pending' | 'failed' }
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
  private stored: Stored = { schema: 1 }
  private revision = 0
  private check?: Promise<ManualInstallInfo>
  private checkSnapshot?: string
  private formatHint?: ManualInstallerFormat
  private reveal?: Promise<ManualInstallInfo>
  private readonly options: ManualInstallerOptions
  constructor(
    private readonly platform: ManualInstallInfo['platform'],
    private readonly arch: string,
    currentVersion: string,
    options: ManualInstallerOptions,
    private readonly status: () => UpdateStatus,
    private readonly publish: (info: ManualInstallInfo | undefined) => void,
    private readonly publishRecovery?: (status: Partial<UpdateStatus>) => void
  ) {
    this.options = options
    if (options.manualInstallStorePath) {
      try {
        const file = installationFs.lstatSync(options.manualInstallStorePath)
        if (!file.isFile() || file.size > 64 * 1024) return
        const stored = JSON.parse(
          installationFs.readFileSync(options.manualInstallStorePath, 'utf8')
        ) as Stored
        const a = stored.artifact
        if (
          stored.schema === 1 &&
          a &&
          a.platform === platform &&
          a.arch === arch &&
          isNewer(a.version, currentVersion) &&
          typeof a.path === 'string' &&
          typeof a.identity === 'string' &&
          ['sha256', 'sha512'].includes(a.algorithm) &&
          Number.isSafeInteger(a.size) &&
          a.size > 0 &&
          typeof a.checksum === 'string'
        )
          this.stored = stored
        else if (a && !isNewer(a.version, currentVersion)) this.persist()
      } catch {
        /* Missing or malformed provenance never grants access to a cache file. */
      }
    }
  }
  private persist(): void {
    const file = this.options.manualInstallStorePath
    if (!file) return
    installationFs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const descriptor = installationFs.openSync(temporary, 'wx', 0o600)
      try {
        installationFs.writeFileSync(descriptor, JSON.stringify(this.stored))
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
  restoredStatus(): Partial<UpdateStatus> | undefined {
    const { artifact, attempt, failure } = this.stored
    if (!artifact || (!failure && !attempt)) return undefined
    return {
      state: 'ready',
      latest: artifact.version,
      localPath: artifact.path,
      ...(artifact.algorithm === 'sha512'
        ? { artifactSha512: artifact.checksum }
        : { download: { url: artifact.source, size: artifact.size, sha256: artifact.checksum } }),
      reason: 'install-failed',
      error: 'The previous update requires verification.',
      recovery: {
        phase: 'install-check',
        runtime: 'unknown',
        installation: attempt?.state === 'pending' ? 'pending' : 'unknown',
        canCancel: false,
        canRetryInstall: false,
        canRecover: true
      }
    }
  }
  async capture(
    input: Omit<ManualInstallerArtifact, 'identity' | 'device' | 'inode' | 'modified'>
  ): Promise<void> {
    if (this.hasPendingAttempt())
      throw new Error('A native installation attempt is still unresolved.')
    const revision = ++this.revision
    this.stored = { schema: 1 }
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
    this.stored = { schema: 1, artifact }
    this.persist()
  }
  supersede(version?: string): void {
    if (this.hasPendingAttempt()) return
    if (!this.stored.artifact || this.stored.artifact.version === version) return
    ++this.revision
    this.stored = { schema: 1 }
    this.persist()
    this.publish(undefined)
  }
  failed(kind: 'download' | 'install'): void {
    if (kind === 'download' && this.hasPendingAttempt()) return
    this.stored.failure = kind
    if (this.stored.attempt) this.stored.attempt.state = 'failed'
    this.persist()
  }
  retainProtectedHandoffContext(): void {
    // The existing installation-protection record owns executor settlement and startup admission.
    // Retain the release/artifact offer across a crash without creating a second pending native gate.
    if (!this.stored.artifact) return
    this.stored.failure = 'install'
    this.persist()
  }
  clearFailure(): void {
    if (this.hasPendingAttempt()) return
    this.stored.failure = undefined
    this.persist()
  }
  async beforeHandoff(operationId: string = randomUUID()): Promise<void> {
    const artifact = this.stored.artifact
    if (!artifact) throw new Error('Verified update artifact provenance is unavailable.')
    this.stored.attempt = {
      identity: artifact.identity,
      version: artifact.version,
      operationId,
      state: 'pending'
    }
    this.persist()
    await this.options.observeManualInstallHandoff?.(artifact, operationId)
  }
  hasPendingAttempt(): boolean {
    return this.stored.attempt?.state === 'pending'
  }
  async confirmAttemptSettled(): Promise<boolean> {
    if (!this.hasPendingAttempt()) return true
    await this.get()
    return !this.hasPendingAttempt()
  }
  recovered(): void {
    if (this.hasPendingAttempt()) return
    if (this.stored.attempt) this.stored.attempt.state = 'failed'
    this.stored.failure = 'install'
    this.persist()
  }
  setOfferFormat(format: ManualInstallerFormat | undefined): void {
    this.formatHint = format
  }
  entry(): ManualInstallInfo | undefined {
    if (
      !this.stored.failure ||
      !manualInstallIsSafe(this.status()) ||
      this.stored.attempt?.state === 'pending'
    )
      return undefined
    return this.website(this.stored.failure === 'download' ? 'download-failed' : 'unavailable')
  }
  private base(): Pick<ManualInstallInfo, 'identity' | 'platform' | 'arch' | 'version'> {
    return {
      identity:
        this.stored.artifact?.identity ??
        `${this.platform}:${this.arch}:${this.status().latest ?? ''}`,
      platform: this.platform,
      arch: this.arch,
      version: this.status().latest
    }
  }
  private website(reason: 'download-failed' | 'unavailable' | 'not-standalone'): ManualInstallInfo {
    return {
      ...this.base(),
      kind: 'website',
      reason,
      ...((this.stored.artifact?.format ?? this.formatHint)
        ? { format: this.stored.artifact?.format ?? this.formatHint }
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
      if (this.checkSnapshot === snapshot) return this.check
      return this.check.then(() => this.get())
    }
    const pending = this.inspect()
    this.check = pending
    this.checkSnapshot = snapshot
    void pending
      .finally(() => {
        if (this.check === pending) this.check = undefined
      })
      .catch(() => {})
    return pending
  }
  private async inspect(): Promise<ManualInstallInfo> {
    const revision = this.revision
    let snapshot = snapshotKey(this.status())
    const artifact = this.stored.artifact
    if (
      this.stored.attempt?.state === 'pending' &&
      artifact &&
      this.options.manualInstallRecovery
    ) {
      const result = await this.options
        .manualInstallRecovery(artifact, this.stored.attempt?.operationId)
        .catch(() => 'pending' as const)
      if (revision !== this.revision || snapshotKey(this.status()) !== snapshot)
        return this.blocked()
      if (result === 'failed') {
        this.failed('install')
      } else return this.blocked()
    }
    if (
      this.stored.failure &&
      !this.hasPendingAttempt() &&
      this.status().recovery?.phase === 'install-check'
    ) {
      // A failed process is separate from a usable running service. Keep the recovery UI until
      // current runtime control, occupancy and active work have also been checked in main.
      const current = this.status()
      const eligible =
        manualInstallIsSafe({ ...current, recovery: undefined, reason: undefined }) &&
        (!this.options.inspectManualInstallSafety ||
          (await this.options.inspectManualInstallSafety().catch(() => false)))
      if (revision !== this.revision || snapshotKey(this.status()) !== snapshot)
        return this.blocked()
      if (!eligible) return this.blocked()
      this.publishRecovery?.({
        recovery: undefined,
        reason: undefined,
        state: 'ready',
        error: 'The previous installer stopped before completing the update.'
      })
      snapshot = snapshotKey(this.status())
    }
    const safe = async (): Promise<boolean> =>
      manualInstallIsSafe(this.status()) &&
      (!this.options.inspectManualInstallSafety ||
        (await this.options.inspectManualInstallSafety().catch(() => false)))
    if (!this.stored.failure || this.stored.attempt?.state === 'pending' || !(await safe()))
      return this.blocked()
    let result: ManualInstallInfo
    if (this.stored.failure === 'download') result = this.website('download-failed')
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
    if (revision !== this.revision || snapshotKey(this.status()) !== snapshot || !(await safe()))
      return this.blocked()
    if (revision !== this.revision || snapshotKey(this.status()) !== snapshot) return this.blocked()
    this.publish(result)
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
      const artifact = this.stored.artifact!
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
        this.publish(failed)
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
