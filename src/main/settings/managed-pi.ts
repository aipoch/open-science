import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { x as extract } from 'tar'
import type { ClaudeInstallEvent, ClaudeInstallResult } from '../../shared/settings'
import { managedPiRoot, piBootstrapPath, resolvePiExecutable } from '../agent-framework/pi-runtime'
import { nodeRuntimeEnvironment } from '../node-process-host'
import { DEFAULT_REGISTRIES, defaultFetchTarball, downloadAndVerify } from './managed-claude'

const execute = promisify(execFile)
type LockedPackage = {
  resolved?: string
  integrity?: string
  os?: string[]
  cpu?: string[]
  libc?: string[]
}
const matches = (values: string[] | undefined, value: string): boolean =>
  !values ||
  (!values.includes(`!${value}`) &&
    (!values.some((entry) => !entry.startsWith('!')) || values.includes(value)))

const downloadFailure = (error: unknown): { detail: string; retryable: boolean } => {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? error.cause : undefined
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
  return {
    detail: code ? `${message} (${code})` : message,
    retryable:
      /^(fetch failed|terminated)$/.test(message) ||
      /timed out/i.test(message) ||
      ['ECONNRESET', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
  }
}

// Only this directory is owned by the installer; Pi history and provider credentials live elsewhere.
export const uninstallManagedPi = async (configRoot: string): Promise<void> => {
  const root = managedPiRoot(configRoot)
  const siblings = await readdir(dirname(root), { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const owned = /^pi-managed\.(?:staging|backup)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
  for (const path of [
    root,
    ...siblings
      .filter((entry) => entry.isDirectory() && owned.test(entry.name))
      .map((entry) => join(dirname(root), entry.name))
  ]) {
    await rm(path, { recursive: true, force: true })
  }
}

export const installManagedPi = async ({
  configRoot,
  installId,
  onEvent,
  signal
}: {
  configRoot: string
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  signal: AbortSignal
}): Promise<ClaudeInstallResult> => {
  const root = managedPiRoot(configRoot)
  const staging = `${root}.staging-${randomUUID()}`
  const stagedRoot = managedPiRoot(staging)
  const backup = `${root}.backup-${randomUUID()}`
  let backedUp = false
  const log = (chunk: string): void =>
    onEvent({ kind: 'log', installId, stream: 'system', chunk: `${chunk}\n` })
  try {
    await mkdir(stagedRoot, { recursive: true })
    const bootstrap = piBootstrapPath()
    const lock = JSON.parse(await readFile(join(bootstrap, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, LockedPackage>
    }
    const report =
      process.platform === 'linux'
        ? (process.report.getReport() as { header: { glibcVersionRuntime?: string } })
        : undefined
    const libc = report?.header.glibcVersionRuntime ? 'glibc' : 'musl'
    onEvent({ kind: 'progress', installId, phase: 'resolving' })
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path) continue
      signal.throwIfAborted()
      if (
        !/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path) ||
        path.split('/').includes('..')
      ) {
        throw new Error('Invalid Pi dependency path.')
      }
      if (
        !matches(pkg.os, process.platform) ||
        !matches(pkg.cpu, process.arch) ||
        (process.platform === 'linux' && !matches(pkg.libc, libc))
      )
        continue
      if (!pkg.resolved?.startsWith('https://registry.npmjs.org/') || !pkg.integrity) {
        throw new Error(`Unpinned Pi dependency: ${path}`)
      }
      log(`Installing ${path}`)
      const archive = join(staging, 'download.tgz')
      let downloaded = false
      let downloadError: unknown
      for (const registry of DEFAULT_REGISTRIES) {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            await downloadAndVerify({
              url: pkg.resolved.replace('https://registry.npmjs.org', registry),
              integrity: pkg.integrity,
              destPath: archive,
              installId,
              onEvent,
              fetchTarball: defaultFetchTarball,
              signal
            })
            downloaded = true
            break
          } catch (error) {
            downloadError = error
            const failure = downloadFailure(error)
            log(`${registry} attempt ${attempt} failed for ${path}: ${failure.detail}`)
            signal.throwIfAborted()
            if (!failure.retryable || attempt === 2) break
            log(`Retrying ${path} once after a transient download failure.`)
            await delay(500, undefined, { signal })
          }
        }
        if (downloaded) break
      }
      if (!downloaded) throw downloadError
      const destination = join(stagedRoot, path)
      await mkdir(destination, { recursive: true })
      let invalidEntry: string | undefined
      await extract({
        file: archive,
        cwd: destination,
        strip: 1,
        strict: true,
        filter: (name, entry) => {
          // npm archives use both package/ and package-name/ as their single stripped root.
          // Do not throw from tar's event callback: capture the rejection and fail after closing it.
          if (
            name.startsWith('/') ||
            name.includes('\\') ||
            /^[A-Za-z]:/.test(name) ||
            name.split('/').includes('..') ||
            !('type' in entry) ||
            !['File', 'Directory'].includes(entry.type)
          ) {
            invalidEntry = name
            return false
          }
          return true
        }
      })
      if (invalidEntry) throw new Error(`Unsafe Pi archive entry: ${invalidEntry}`)
      await rm(archive, { force: true })
    }
    signal.throwIfAborted()
    log('Applying application permission guard and checking Pi compatibility.')
    await execute(
      process.execPath,
      [
        join(bootstrap, 'bootstrap.mjs'),
        join(stagedRoot, 'node_modules/@openma/pi-acp'),
        join(stagedRoot, 'adapter')
      ],
      { env: { ...process.env, ...nodeRuntimeEnvironment() }, signal, timeout: 30_000 }
    )
    await resolvePiExecutable({ configRoot: staging })
    signal.throwIfAborted()
    try {
      await rename(root, backup)
      backedUp = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await rename(stagedRoot, root)
    } catch (error) {
      if (backedUp) {
        try {
          await rename(backup, root)
        } catch (restoreError) {
          throw new Error(
            `Pi runtime replacement failed and the previous runtime remains at ${backup}: ${String(restoreError)}`,
            { cause: error }
          )
        }
      }
      throw error
    }
    if (backedUp)
      await rm(backup, { recursive: true, force: true }).catch((error) => {
        log(
          `Pi is installed, but the old runtime could not be removed at ${backup}: ${String(error)}`
        )
      })
    log('Installed compatible Pi SDK 1.4.0 / ACP 0.1.8.')
    return { installId, ok: true }
  } catch (error) {
    const message = downloadFailure(error).detail
    log(`Pi installation failed: ${message}`)
    return { installId, ok: false, error: message }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch((error) => {
      log(`Could not clean Pi staging directory ${staging}: ${String(error)}`)
    })
  }
}
