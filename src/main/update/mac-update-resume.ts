import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { installationFs } from './installation-filesystem'
import { verifyArtifactChecksum } from './installation-artifact'
import type { MacUpdateRecovery } from './mac-update-handoff'

/** Electron's native autoUpdater, which is also the final writer used by MacUpdater.
 * No private electron-updater fields or alternate application replacement engine. */
export interface MacNativeUpdater {
  setFeedURL(options: { url: string }): void
  checkForUpdates(): void
  quitAndInstall(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Replay the retained, original target through native Squirrel's public feed interface.
 * Called only for an already authorized durable handoff. This does not check a moving latest
 * feed, weaken native signature verification, or launch the target on behalf of a failed updater. */
export async function resumeMacUpdateHandoff(
  recovery: Extract<MacUpdateRecovery, { state: 'resume' }>,
  nativeUpdater?: MacNativeUpdater,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<void> {
  const updater =
    nativeUpdater ?? ((await import('electron')).autoUpdater as unknown as MacNativeUpdater)
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 120_000)
  const request = recovery.request
  await verifyArtifactChecksum(request.installerPath, request.installerSha512, signal)
  const size = (await installationFs.promises.stat(request.installerPath)).size
  const capability = randomBytes(32).toString('hex')
  const feedPath = `/${capability}/feed.json`
  const zipPath = `/${capability}/update.zip`
  let origin = ''
  let cleanupAfterSettlement: (() => void) | undefined
  const streams = new Set<ReturnType<typeof installationFs.createReadStream>>()
  const server = createServer((incoming, response) => {
    if (!['GET', 'HEAD'].includes(incoming.method ?? '')) {
      response.writeHead(405).end()
      return
    }
    if (incoming.url === feedPath) {
      const body = Buffer.from(
        JSON.stringify({ url: origin + zipPath, name: request.targetVersion })
      )
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      })
      response.end(incoming.method === 'HEAD' ? undefined : body)
      return
    }
    if (incoming.url !== zipPath) {
      response.writeHead(404).end()
      return
    }
    let start = 0,
      end = size - 1
    const range = incoming.headers.range
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (
        !match ||
        (start = Number(match[1])) >= size ||
        (end = match[2] ? Number(match[2]) : size - 1) < start ||
        end >= size ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end)
      ) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
        return
      }
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/zip',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    })
    if (incoming.method === 'HEAD') {
      response.end()
      return
    }
    const stream = installationFs.createReadStream(request.installerPath, { start, end, signal })
    streams.add(stream)
    stream.on('close', () => streams.delete(stream))
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        signal.removeEventListener('abort', abort)
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Mac recovery feed could not bind loopback.')
    origin = `http://127.0.0.1:${address.port}`
    await new Promise<void>((resolve, reject) => {
      const downloaded = (): void => {
        try {
          signal.throwIfAborted()
          recovery.handoff()
          // Only native Squirrel decides when replacement is complete and launches the target.
          updater.quitAndInstall()
          resolve()
        } catch (error) {
          reject(error)
        }
      }
      const failed = (error: unknown): void =>
        reject(error instanceof Error ? error : new Error(String(error)))
      const unavailable = (): void =>
        reject(new Error('The original update target was not accepted by the native updater.'))
      const aborted = (): void => reject(signal.reason)
      const cleanup = (): void => {
        updater.removeListener('update-downloaded', downloaded)
        updater.removeListener('error', failed)
        updater.removeListener('update-not-available', unavailable)
        signal.removeEventListener('abort', aborted)
      }
      updater.on('update-downloaded', downloaded)
      updater.on('error', failed)
      updater.on('update-not-available', unavailable)
      signal.addEventListener('abort', aborted, { once: true })
      // The updater can emit synchronously in a test or throw before it starts a request.
      try {
        signal.throwIfAborted()
        updater.setFeedURL({ url: origin + feedPath })
        updater.checkForUpdates()
      } catch (error) {
        reject(error)
      }
      // Promise.finally cannot be attached to its own value inside its executor.
      cleanupAfterSettlement = cleanup
    }).finally(() => {
      cleanupAfterSettlement?.()
      cleanupAfterSettlement = undefined
    })
  } finally {
    for (const stream of streams) stream.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  // Keep the native ownership lease until the initiating Desktop exits. A returned promise
  // means submission, never installation success; startup readiness settles the durable marker.
}
