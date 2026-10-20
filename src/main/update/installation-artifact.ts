import { installationFs } from './installation-filesystem'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateLifecycleError } from '../../shared/update'
import {
  captureInstallationManifestAsync,
  type InstallationManifest
} from './installation-protection'

import { runVerificationProcess, verificationDirectoryIsSettled } from './verification-process'

const { mkdtemp, readdir, rm } = installationFs.promises

// The archive is electron-updater's checksum-verified macOS download. Validate its code signature
// and version independently before persisting a target manifest outside the installation.
export async function inspectMacUpdateArtifact(
  archive: string,
  targetVersion: string,
  signal?: AbortSignal,
  retainBundle?: (bundle: string) => Promise<void>
): Promise<InstallationManifest> {
  if (process.platform !== 'darwin')
    throw new UpdateLifecycleError('installation-busy', 'This artifact verifier requires macOS.')
  const run = (command: string, args: string[]): ReturnType<typeof runVerificationProcess> =>
    runVerificationProcess(command, args, { signal })
  await validateZipArchivePaths(archive, signal)
  const directory = await mkdtemp(join(tmpdir(), 'open-science-update-'))
  try {
    await runVerificationProcess('/usr/bin/ditto', ['-x', '-k', archive, directory], {
      signal,
      cwd: directory
    })
    const apps = (await readdir(directory)).filter((name) => name.endsWith('.app'))
    if (apps.length !== 1)
      throw new UpdateLifecycleError(
        'install-failed',
        'The update archive does not contain exactly one application.'
      )
    const bundle = join(directory, apps[0])
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
    const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])
    const lines = new Set(`${signature.stdout}\n${signature.stderr}`.split(/\r?\n/))
    if (!lines.has('Identifier=com.aipoch.open-science') || !lines.has('TeamIdentifier=87G9WFU9H3'))
      throw new UpdateLifecycleError(
        'install-failed',
        'The update application signature does not match this publisher.'
      )
    const version = (
      await run('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleShortVersionString',
        join(bundle, 'Contents', 'Info.plist')
      ])
    ).stdout.trim()
    if (version !== targetVersion)
      throw new UpdateLifecycleError(
        'install-failed',
        'The update application version does not match the offered version.'
      )
    const manifest = await captureInstallationManifestAsync(bundle, version, signal)
    await retainBundle?.(bundle)
    return manifest
  } finally {
    if (verificationDirectoryIsSettled(directory))
      await rm(directory, { recursive: true, force: true })
  }
}

/** Reads package identity without loading JavaScript from the replacement application. */
export async function readPackagedVersion(root: string): Promise<string> {
  const { open, readFile } = installationFs.promises
  try {
    return JSON.parse(await readFile(join(root, 'resources/app/package.json'), 'utf8')).version
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const file = await open(join(root, 'resources/app.asar'), 'r')
  try {
    const size = Buffer.alloc(8)
    await file.read(size, 0, 8, 0)
    const headerSize = size.readUInt32LE(4)
    if (headerSize < 8 || headerSize > 32 * 1024 * 1024)
      throw new Error('Invalid application archive header.')
    const header = Buffer.alloc(headerSize)
    await file.read(header, 0, headerSize, 8)
    const jsonSize = header.readUInt32LE(4)
    if (jsonSize > headerSize - 8) throw new Error('Invalid application archive header.')
    const data = JSON.parse(header.subarray(8, 8 + jsonSize).toString())
    const entry = data.files?.['package.json']
    if (
      !entry ||
      entry.unpacked ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > 1024 * 1024 ||
      !/^\d+$/.test(entry.offset)
    )
      throw new Error('Invalid application package identity.')
    const content = Buffer.alloc(entry.size)
    await file.read(content, 0, entry.size, 8 + headerSize + Number(entry.offset))
    const version = JSON.parse(content.toString()).version
    if (typeof version !== 'string') throw new Error('Missing application version.')
    return version
  } finally {
    await file.close()
  }
}

export async function verifyArtifactChecksum(
  archive: string,
  sha512: string,
  signal?: AbortSignal
): Promise<void> {
  const { createReadStream } = installationFs
  const { createHash } = await import('node:crypto')
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sha512))
    throw new UpdateLifecycleError(
      'install-failed',
      'A trusted update artifact checksum is required.'
    )
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(archive, { signal })) hash.update(chunk)
  if (hash.digest('base64') !== sha512)
    throw new UpdateLifecycleError(
      'install-failed',
      'The downloaded update artifact checksum has changed.'
    )
}

export async function inspectDebUpdateArtifact(
  archive: string,
  targetVersion: string,
  installationRoot: string,
  signal?: AbortSignal
): Promise<InstallationManifest> {
  const { isAbsolute, relative } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'open-science-deb-'))
  try {
    const { stdout } = await runVerificationProcess('dpkg-deb', ['--field', archive, 'Version'], {
      signal
    })
    if (stdout.trim() !== targetVersion)
      throw new UpdateLifecycleError(
        'install-failed',
        'The Debian package version differs from the offered update.'
      )
    await runVerificationProcess('dpkg-deb', ['--extract', archive, directory], {
      signal,
      cwd: directory
    })
    const rel = relative('/', installationRoot)
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new UpdateLifecycleError('install-failed', 'Invalid Debian installation directory.')
    const payload = join(directory, rel)
    if ((await readPackagedVersion(payload)) !== targetVersion)
      throw new UpdateLifecycleError(
        'install-failed',
        'The Debian application version differs from the offered update.'
      )
    return await captureInstallationManifestAsync(payload, targetVersion, signal)
  } finally {
    if (verificationDirectoryIsSettled(directory))
      await rm(directory, { recursive: true, force: true })
  }
}

export async function inspectUpdateArtifact(options: {
  archive: string
  targetVersion: string
  installationRoot: string
  sha512?: string
  signal?: AbortSignal
  platform?: NodeJS.Platform
}): Promise<InstallationManifest> {
  const platform = options.platform ?? process.platform
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000)
  if (options.sha512) await verifyArtifactChecksum(options.archive, options.sha512, signal)
  if (platform === 'darwin')
    return inspectMacUpdateArtifact(options.archive, options.targetVersion, signal)
  if (!options.sha512)
    throw new UpdateLifecycleError(
      'install-failed',
      'A trusted update artifact checksum is required.'
    )
  if (platform === 'linux' && options.archive.toLowerCase().endsWith('.appimage'))
    return inspectAppImageUpdateArtifact(
      options.archive,
      options.targetVersion,
      options.installationRoot,
      signal
    )
  if (platform === 'linux' && options.archive.toLowerCase().endsWith('.deb'))
    return inspectDebUpdateArtifact(
      options.archive,
      options.targetVersion,
      options.installationRoot,
      signal
    )

  throw new UpdateLifecycleError(
    'installation-busy',
    'This package format requires its original installation channel.'
  )
}

export async function inspectAppImageUpdateArtifact(
  archive: string,
  targetVersion: string,
  installationRoot: string,
  signal?: AbortSignal
): Promise<InstallationManifest> {
  const { basename } = await import('node:path')
  const { stat } = installationFs.promises
  const existingName = basename(installationRoot)
  // electron-updater renames versioned images. A stable/custom filename is the supported channel
  // until cross-filename aliases can remain atomic across old and new launchers.
  if (
    !(await stat(installationRoot)).isFile() ||
    (existingName !== basename(archive) && /\d+\.\d+\.\d+/.test(existingName))
  )
    throw new UpdateLifecycleError(
      'installation-busy',
      'Automatic AppImage verification requires a stable application filename. Rename the closed image without a version number, then reopen it, or use the original installation channel.'
    )
  const directory = await mkdtemp(join(tmpdir(), 'open-science-appimage-'))
  try {
    // This is the checksum-verified AppImage runtime extraction mode, not the application entry.
    await runVerificationProcess(archive, ['--appimage-extract'], { cwd: directory, signal })
    if ((await readPackagedVersion(join(directory, 'squashfs-root'))) !== targetVersion)
      throw new UpdateLifecycleError(
        'install-failed',
        'The AppImage version differs from the offered update.'
      )
    return await captureInstallationManifestAsync(archive, targetVersion, signal)
  } finally {
    if (verificationDirectoryIsSettled(directory))
      await rm(directory, { recursive: true, force: true })
  }
}

/** Inspect symlink targets before ditto writes anything; signature validation happens afterwards. */
export async function validateZipArchivePaths(
  archive: string,
  signal?: AbortSignal
): Promise<void> {
  const { open } = installationFs.promises
  const { posix } = await import('node:path')
  const { inflateRawSync } = await import('node:zlib')
  const file = await open(archive, 'r')
  const unsafe = (): never => {
    throw new UpdateLifecycleError(
      'install-failed',
      'The update archive contains unsafe or unsupported paths.'
    )
  }
  try {
    const size = (await file.stat()).size
    const tail = Buffer.alloc(Math.min(size, 65557))
    await file.read(tail, 0, tail.length, size - tail.length)
    let end = tail.length - 22
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--
    if (end < 0) unsafe()
    const count = tail.readUInt16LE(end + 10),
      centralSize = tail.readUInt32LE(end + 12),
      offset = tail.readUInt32LE(end + 16)
    if (
      count === 65535 ||
      offset === 0xffffffff ||
      centralSize > 32 * 1024 * 1024 ||
      offset + centralSize > size
    )
      unsafe()
    const central = Buffer.alloc(centralSize)
    await file.read(central, 0, centralSize, offset)
    const seen = new Set<string>()
    let cursor = 0
    for (let i = 0; i < count; i++) {
      signal?.throwIfAborted()
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) unsafe()
      const method = central.readUInt16LE(cursor + 10),
        compressed = central.readUInt32LE(cursor + 20),
        uncompressed = central.readUInt32LE(cursor + 24)
      const nameLength = central.readUInt16LE(cursor + 28),
        extraLength = central.readUInt16LE(cursor + 30),
        commentLength = central.readUInt16LE(cursor + 32)
      const mode = central.readUInt32LE(cursor + 38) >>> 16,
        localOffset = central.readUInt32LE(cursor + 42)
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      if (
        !name ||
        name.includes('\\') ||
        name.includes('\0') ||
        name.startsWith('/') ||
        name.split('/').includes('..') ||
        seen.has(name)
      )
        unsafe()
      seen.add(name)
      if ((mode & 0o170000) === 0o120000) {
        if (uncompressed > 4096 || compressed > 8192 || localOffset + 30 + compressed > size)
          unsafe()
        const header = Buffer.alloc(30)
        await file.read(header, 0, 30, localOffset)
        if (header.readUInt32LE(0) !== 0x04034b50) unsafe()
        const start = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
        const contents = Buffer.alloc(compressed)
        await file.read(contents, 0, compressed, start)
        const target = (
          method === 0
            ? contents
            : method === 8
              ? inflateRawSync(contents, { maxOutputLength: 4096 })
              : unsafe()
        ).toString('utf8')
        const resolved = posix.normalize(posix.join(posix.dirname(name), target))
        if (
          !target ||
          target.startsWith('/') ||
          target.includes('\\') ||
          target.includes('\0') ||
          resolved === '..' ||
          resolved.startsWith('../')
        )
          unsafe()
      }
      cursor += 46 + nameLength + extraLength + commentLength
    }
    if (cursor !== central.length) unsafe()
  } finally {
    await file.close()
  }
}
