import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, type Dirent } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'

import type { ClaudeInstallEvent } from '../../shared/settings'
import { CODEBUDDY_VERSION } from './codebuddy-install'
import {
  DEFAULT_REGISTRIES,
  defaultFetchJson,
  defaultFetchTarball,
  downloadAndVerify,
  type FetchJson,
  type FetchTarball,
  type ManagedInstallOutcome
} from './managed-claude'

const execFileAsync = promisify(execFile)
const CODEBUDDY_PACKAGE = '@tencent-ai/codebuddy-code'
export { CODEBUDDY_VERSION } from './codebuddy-install'
const TAR_BLOCK = 512

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

export const managedCodeBuddyRoot = (dataRoot: string): string =>
  join(dataRoot, 'codebuddy-managed')

export const managedCodeBuddyDir = (dataRoot: string): string =>
  join(managedCodeBuddyRoot(dataRoot), 'bin')

const codeBuddyBinary = (root: string, platform: NodeJS.Platform): string =>
  join(root, 'bin', platform === 'win32' ? 'codebuddy.cmd' : 'codebuddy')

export const managedCodeBuddyBinary = (
  dataRoot: string,
  platform: NodeJS.Platform = process.platform
): string => codeBuddyBinary(managedCodeBuddyRoot(dataRoot), platform)

export const isManagedCodeBuddyPath = (resolvedPath: string, dataRoot: string): boolean =>
  resolve(dirname(resolvedPath)) === resolve(managedCodeBuddyDir(dataRoot))

const ORPHANED_CODEBUDDY_RUNTIME_PATTERN =
  /^codebuddy-managed\.(?:staging|backup)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

export const uninstallManagedCodeBuddy = async (dataRoot: string): Promise<void> => {
  const root = managedCodeBuddyRoot(dataRoot)
  const siblings = await readdir(dirname(root), { withFileTypes: true }).catch(() => [] as Dirent[])
  await Promise.all(
    [
      root,
      ...siblings
        .filter(
          (entry) => entry.isDirectory() && ORPHANED_CODEBUDDY_RUNTIME_PATTERN.test(entry.name)
        )
        .map((entry) => join(dirname(root), entry.name))
    ].map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined))
  )
}

const resolvePackage = async (
  registry: string,
  version: string | undefined,
  fetchJson: FetchJson,
  signal?: AbortSignal
): Promise<{ version: string; tarball: string; integrity: string }> => {
  const encodedName = '@tencent-ai%2Fcodebuddy-code'
  const packageMeta = asRecord(await fetchJson(`${registry}/${encodedName}`, signal))
  const resolvedVersion =
    version ??
    (typeof asRecord(packageMeta['dist-tags']).latest === 'string'
      ? (asRecord(packageMeta['dist-tags']).latest as string)
      : CODEBUDDY_VERSION)
  const versionMeta = asRecord(
    packageMeta.versions && asRecord(packageMeta.versions)[resolvedVersion]
      ? asRecord(packageMeta.versions)[resolvedVersion]
      : await fetchJson(`${registry}/${encodedName}/${resolvedVersion}`, signal)
  )
  const dist = asRecord(versionMeta.dist)
  const tarball = dist.tarball
  const integrity = dist.integrity

  if (typeof tarball !== 'string' || typeof integrity !== 'string') {
    throw new Error(`Incomplete registry metadata for ${CODEBUDDY_PACKAGE}`)
  }

  return { version: resolvedVersion, tarball, integrity }
}

const readTarText = (header: Buffer, start: number, end: number): string => {
  const field = header.subarray(start, end)
  const nul = field.indexOf(0)
  return field.toString('utf8', 0, nul === -1 ? field.length : nul)
}

const readTarName = (header: Buffer): string => {
  const name = readTarText(header, 0, 100)
  const prefix = readTarText(header, 345, 500)
  return prefix ? `${prefix}/${name}` : name
}

const readTarOctal = (header: Buffer, start: number, end: number): number => {
  const raw = header.toString('utf8', start, end).replace(/\0/g, '').trim()
  return raw ? Number.parseInt(raw, 8) : 0
}

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0)

const writeAll = async (file: FileHandle, data: Buffer): Promise<void> => {
  let offset = 0
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset)
    if (bytesWritten === 0) throw new Error('Could not write extracted CodeBuddy resource')
    offset += bytesWritten
  }
}

class TarPackageExtractor extends Writable {
  private leftover = Buffer.alloc(0)
  private state: 'header' | 'body' = 'header'
  private remaining = 0
  private padding = 0
  private currentFile: FileHandle | undefined
  private currentPath: string | undefined
  private currentMode = 0o644
  private entries = 0

  constructor(private readonly destination: string) {
    super()
  }

  foundEntries(): boolean {
    return this.entries > 0
  }

  async _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): Promise<void> {
    try {
      this.leftover = Buffer.concat([this.leftover, chunk])
      await this.consume()
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.currentFile) {
      callback(error)
      return
    }

    this.currentFile.close().then(() => callback(error), callback)
  }

  private outputPath(entryName: string): string | undefined {
    const normalized = posix.normalize(entryName)
    if (normalized !== 'package' && !normalized.startsWith('package/')) return undefined

    const relative = normalized.slice('package/'.length)
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('../') ||
      posix.isAbsolute(relative)
    ) {
      return undefined
    }

    const output = resolve(this.destination, ...relative.split('/'))
    const root = resolve(this.destination)
    if (output !== root && !output.startsWith(`${root}${sep}`)) {
      throw new Error(`Unsafe CodeBuddy archive path: ${entryName}`)
    }

    return output
  }

  private async beginEntry(header: Buffer): Promise<void> {
    const name = readTarName(header)
    const output = this.outputPath(name)
    const type = String.fromCharCode(header[156] ?? 0)
    this.remaining = readTarOctal(header, 124, 136)
    this.padding = (TAR_BLOCK - (this.remaining % TAR_BLOCK)) % TAR_BLOCK
    this.currentMode = readTarOctal(header, 100, 108) || 0o644
    this.currentPath = undefined

    if (!output) return
    if (type === '5') {
      await mkdir(output, { recursive: true })
      this.entries += 1
      return
    }
    if (type !== '0' && type !== '\0') {
      throw new Error(`Unsupported entry type in CodeBuddy archive: ${name}`)
    }

    await mkdir(dirname(output), { recursive: true })
    this.currentFile = await open(output, 'w', this.currentMode)
    this.currentPath = output
    this.entries += 1
  }

  private async finishEntry(): Promise<void> {
    const file = this.currentFile
    const output = this.currentPath
    this.currentFile = undefined
    this.currentPath = undefined

    if (file) await file.close()
    if (output && process.platform !== 'win32') await chmod(output, this.currentMode)
  }

  private async consume(): Promise<void> {
    for (;;) {
      if (this.state === 'header') {
        if (this.leftover.length < TAR_BLOCK) return
        const header = this.leftover.subarray(0, TAR_BLOCK)
        this.leftover = this.leftover.subarray(TAR_BLOCK)
        if (isZeroBlock(header)) continue

        await this.beginEntry(header)
        this.state = 'body'
        continue
      }

      if (this.remaining > 0) {
        if (this.leftover.length === 0) return
        const take = Math.min(this.remaining, this.leftover.length)
        const piece = this.leftover.subarray(0, take)
        this.leftover = this.leftover.subarray(take)
        this.remaining -= take
        if (this.currentFile) await writeAll(this.currentFile, piece)
        continue
      }

      if (this.padding > 0) {
        if (this.leftover.length === 0) return
        const take = Math.min(this.padding, this.leftover.length)
        this.leftover = this.leftover.subarray(take)
        this.padding -= take
        continue
      }

      await this.finishEntry()
      this.state = 'header'
    }
  }
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const writeShim = async ({
  root,
  packageRoot = root,
  platform,
  execPath
}: {
  root: string
  packageRoot?: string
  platform: NodeJS.Platform
  execPath: string
}): Promise<string> => {
  const binPath = codeBuddyBinary(root, platform)
  const packageBin = join(packageRoot, 'package', 'bin', 'codebuddy')
  await mkdir(dirname(binPath), { recursive: true })

  if (platform === 'win32') {
    await writeFile(
      binPath,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${packageBin}" %*\r\n`
    )
    return binPath
  }

  await writeFile(
    binPath,
    [
      '#!/bin/sh',
      'ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_RUN_AS_NODE',
      `exec ${shellQuote(execPath)} ${shellQuote(packageBin)} "$@"`,
      ''
    ].join('\n')
  )
  await chmod(binPath, 0o755)
  return binPath
}

const extractPackage = async (
  tgzPath: string,
  destination: string,
  signal?: AbortSignal
): Promise<void> => {
  const extractor = new TarPackageExtractor(destination)
  await pipeline(createReadStream(tgzPath), createGunzip(), extractor, { signal })
  if (!extractor.foundEntries()) {
    throw new Error(`CodeBuddy package did not contain package/`)
  }
}

type VersionCommandRunner = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; shell?: boolean; signal?: AbortSignal }
) => Promise<{ stdout: string }>

export const verifyCodeBuddyVersion = async (
  binPath: string,
  platform: NodeJS.Platform = process.platform,
  run: VersionCommandRunner = execFileAsync as VersionCommandRunner,
  signal?: AbortSignal
): Promise<string | undefined> => {
  try {
    const useShell = platform === 'win32' && /\.(cmd|bat)$/i.test(binPath)
    const { stdout } = await run(useShell ? `"${binPath}"` : binPath, ['--version'], {
      timeout: 15_000,
      windowsHide: true,
      ...(useShell ? { shell: true } : {}),
      ...(signal ? { signal } : {})
    })
    const parsed = stdout.match(/\d+\.\d+\.[\w.-]+/)?.[0] ?? stdout.trim()
    return parsed || undefined
  } catch {
    return undefined
  }
}

export type InstallManagedCodeBuddyOptions = {
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  dataRoot: string
  registries?: string[]
  version?: string
  platform?: NodeJS.Platform
  execPath?: string
  fetchJson?: FetchJson
  fetchTarball?: FetchTarball
  verify?: (binPath: string, signal?: AbortSignal) => Promise<string | undefined>
  signal?: AbortSignal
  renamePath?: typeof rename
}

export const installManagedCodeBuddy = async ({
  installId,
  onEvent,
  dataRoot,
  registries = DEFAULT_REGISTRIES,
  version = CODEBUDDY_VERSION,
  platform = process.platform,
  execPath = process.execPath,
  fetchJson = defaultFetchJson,
  fetchTarball = defaultFetchTarball,
  verify,
  signal,
  renamePath = rename
}: InstallManagedCodeBuddyOptions): Promise<ManagedInstallOutcome> => {
  const root = managedCodeBuddyRoot(dataRoot)
  const binPath = managedCodeBuddyBinary(dataRoot, platform)
  const scratch = `${root}.staging-${randomUUID()}`
  const backup = `${root}.backup-${randomUUID()}`
  const packageStage = join(scratch, 'package')
  let lastError = 'no registries configured'

  await mkdir(scratch, { recursive: true })

  for (const registry of registries) {
    const tgzPath = join(scratch, `codebuddy-download-${Date.now()}.tgz`)

    try {
      onEvent({ kind: 'progress', installId, phase: 'resolving' })
      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `Resolving CodeBuddy from ${registry} …\n`
      })
      const resolution = await resolvePackage(registry, version, fetchJson, signal)
      await downloadAndVerify({
        url: resolution.tarball,
        integrity: resolution.integrity,
        destPath: tgzPath,
        installId,
        onEvent,
        fetchTarball,
        signal
      })

      onEvent({ kind: 'progress', installId, phase: 'extracting' })
      await rm(packageStage, { recursive: true, force: true })
      await mkdir(packageStage, { recursive: true })
      await extractPackage(tgzPath, packageStage, signal)

      const stagedBinPath = await writeShim({ root: scratch, platform, execPath })

      const verifiedVersion = await (verify
        ? signal
          ? verify(stagedBinPath, signal)
          : verify(stagedBinPath)
        : verifyCodeBuddyVersion(stagedBinPath, platform, undefined, signal))
      if (verifiedVersion !== CODEBUDDY_VERSION) {
        throw new Error(
          verifiedVersion
            ? `The installed CodeBuddy runtime reported unsupported version ${verifiedVersion}; expected ${CODEBUDDY_VERSION}.`
            : 'The installed CodeBuddy runtime could not report its version.'
        )
      }

      await writeShim({ root: scratch, packageRoot: root, platform, execPath })
      signal?.throwIfAborted()

      let backedUp = false
      try {
        await renamePath(root, backup)
        backedUp = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }

      try {
        await renamePath(scratch, root)
      } catch (swapError) {
        if (backedUp) {
          try {
            await renamePath(backup, root)
          } catch (restoreError) {
            const swapMessage = swapError instanceof Error ? swapError.message : String(swapError)
            const restoreMessage =
              restoreError instanceof Error ? restoreError.message : String(restoreError)
            throw new Error(
              `CodeBuddy runtime swap failed: ${swapMessage}. The previous runtime remains at ${backup} because restore failed: ${restoreMessage}.`
            )
          }
        }
        throw swapError
      }
      await rm(backup, { recursive: true, force: true }).catch(() => undefined)

      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `Installed CodeBuddy ${verifiedVersion}.\n`
      })

      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      return {
        result: { installId, ok: true },
        resolvedPath: binPath,
        version: verifiedVersion
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `${registry} failed: ${lastError}\n`
      })
      if (signal?.aborted) break
    } finally {
      await rm(tgzPath, { force: true }).catch(() => undefined)
    }
  }

  await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  return { result: { installId, ok: false, error: lastError } }
}
