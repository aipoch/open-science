import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { RemoteAccessMode } from '../../shared/remote-access'

const REMOTE_ACCESS_FILE = 'remote-access.json'

export type StoredTrustedBrowser = {
  id: string
  browser: string
  platform: string
  tokenHash: string
  createdAt: number
  lastSeenAt: number
}

export type StoredRemoteAccess = {
  version: 4
  mode: RemoteAccessMode
  remoteItAppServiceId?: string
  remoteItBrowserServiceId?: string
  remoteItPublicUrl?: string
  trustedBrowsers: StoredTrustedBrowser[]
}

const defaults = (): StoredRemoteAccess => ({
  version: 4,
  mode: 'off',
  trustedBrowsers: []
})

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const parseBrowser = (value: unknown): StoredTrustedBrowser | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const id = optionalString(input.id)
  const browser = optionalString(input.browser)
  const platform = optionalString(input.platform)
  const tokenHash = optionalString(input.tokenHash)
  if (!id || !browser || !platform || !tokenHash) return undefined
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : Date.now()
  const lastSeenAt = typeof input.lastSeenAt === 'number' ? input.lastSeenAt : createdAt
  return { id, browser, platform, tokenHash, createdAt, lastSeenAt }
}

const parseStored = (value: unknown): StoredRemoteAccess => {
  if (!value || typeof value !== 'object') return defaults()
  const input = value as Record<string, unknown>
  const mode: RemoteAccessMode =
    input.mode === 'remoteit' || input.mode === 'remoteit-public' || input.mode === 'off'
      ? input.mode
      : 'off'
  const legacyServiceId = optionalString(input.remoteItServiceId)
  return {
    version: 4,
    mode,
    // Before v4 both App and Browser access shared one service. Preserve that service as the
    // private App entry; Browser access creates its own managed service on first use.
    remoteItAppServiceId: optionalString(input.remoteItAppServiceId) ?? legacyServiceId,
    remoteItBrowserServiceId: optionalString(input.remoteItBrowserServiceId),
    remoteItPublicUrl:
      optionalString(input.remoteItBrowserServiceId) !== undefined
        ? optionalString(input.remoteItPublicUrl)
        : undefined,
    trustedBrowsers: Array.isArray(input.trustedBrowsers)
      ? input.trustedBrowsers.flatMap((entry) => {
          const parsed = parseBrowser(entry)
          return parsed ? [parsed] : []
        })
      : []
  }
}

export class RemoteAccessRepository {
  private readonly path: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(configRoot: string) {
    this.path = join(configRoot, REMOTE_ACCESS_FILE)
  }

  async load(): Promise<StoredRemoteAccess> {
    try {
      return parseStored(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {
      return defaults()
    }
  }

  save(value: StoredRemoteAccess): Promise<void> {
    const snapshot = JSON.stringify(value, null, 2)
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporaryPath = `${this.path}.${process.pid}.tmp`
      await writeFile(temporaryPath, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.path)
    })
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}

export { REMOTE_ACCESS_FILE, defaults as defaultRemoteAccessState, parseStored }
