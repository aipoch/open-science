import { join } from 'node:path'

import type { RemoteAccessMode } from '../../shared/remote-access'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'

const REMOTE_ACCESS_FILE = 'remote-access.json'
const REMOTE_ACCESS_VERSION = 4 as const

export type StoredTrustedBrowser = {
  id: string
  browser: string
  platform: string
  tokenHash: string
  createdAt: number
  lastSeenAt: number
}

export type StoredRemoteAccess = {
  version: typeof REMOTE_ACCESS_VERSION
  mode: RemoteAccessMode
  remoteItAppServiceId?: string
  remoteItBrowserServiceId?: string
  remoteItPublicUrl?: string
  trustedBrowsers: StoredTrustedBrowser[]
}

const defaults = (): StoredRemoteAccess => ({
  version: REMOTE_ACCESS_VERSION,
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid remote access configuration.')
  }
  const input = value as Record<string, unknown>
  if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1) {
    throw new Error('Invalid remote access configuration version.')
  }
  if (input.version > REMOTE_ACCESS_VERSION) {
    throw new Error(
      `Remote access configuration version ${input.version} was created by a newer version of Open Science.`
    )
  }
  const mode: RemoteAccessMode =
    input.mode === 'remoteit' || input.mode === 'remoteit-public' || input.mode === 'off'
      ? input.mode
      : 'off'
  const legacyServiceId = optionalString(input.remoteItServiceId)
  return {
    version: REMOTE_ACCESS_VERSION,
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
    const result = await readDurableJsonFile(this.path, (contents) =>
      parseStored(JSON.parse(contents))
    )
    return result.status === 'found' ? result.value : defaults()
  }

  save(value: StoredRemoteAccess): Promise<void> {
    const snapshot = JSON.stringify(value, null, 2)
    const operation = this.writeQueue.then(async () => {
      await writeDurableJsonFile(this.path, `${snapshot}\n`)
    })
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}

export { REMOTE_ACCESS_FILE, defaults as defaultRemoteAccessState, parseStored }
