import { mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import { acquireRuntimeDirectorySync, type RuntimeDirectoryLease } from '../runtime-ownership'

export type OpenCodeStoreLease = Readonly<{ release(): void }>

type Store = {
  major: 1 | 2
  users: number
  lock: RuntimeDirectoryLease
  ready: Promise<void>
}
const stores = new Map<string, Store>()
const markerName = 'open-science-runtime-version.json'

// Persist before either 2.x process starts: even a failed startup may have migrated native data.
async function checkVersion(root: string, major: 1 | 2): Promise<void> {
  const path = join(root, markerName)
  const marker = await readDurableJsonFile(
    path,
    (text) => {
      const value: unknown = JSON.parse(text)
      if (
        !value ||
        typeof value !== 'object' ||
        !('minimumMajorVersion' in value) ||
        !Number.isSafeInteger(value.minimumMajorVersion) ||
        Number(value.minimumMajorVersion) < 2
      ) {
        throw new Error(
          'Invalid OpenCode storage version marker. Restore the marker before starting OpenCode.'
        )
      }
      return Number(value.minimumMajorVersion)
    },
    {},
    { maxBytes: 1024 }
  )
  if (marker.status === 'found' && marker.value > major) {
    throw new Error(
      `This OpenCode storage requires OpenCode ${marker.value}.x or later. Downgrading is not supported.`
    )
  }
  if (major === 2 && marker.status === 'missing') {
    await writeDurableJsonFile(path, JSON.stringify({ minimumMajorVersion: 2 }))
  }
}

export async function acquireOpenCodeStore(
  dataHome: string,
  major: 1 | 2
): Promise<OpenCodeStoreLease> {
  if (!dataHome || !isAbsolute(dataHome))
    throw new Error('OpenCode requires an app-owned absolute data directory.')
  const directory = join(dataHome, 'opencode')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const root = realpathSync(directory)
  let store = stores.get(root)
  if (store && store.major !== major) {
    throw new Error('Close existing OpenCode sessions before changing the OpenCode major version.')
  }
  if (!store) {
    const lock = acquireRuntimeDirectorySync(root)
    store = { major, users: 0, lock, ready: checkVersion(root, major) }
    stores.set(root, store)
  }
  store.users++
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    if (--store.users === 0) {
      store.lock.release()
      stores.delete(root)
    }
  }
  try {
    await store.ready
    return { release }
  } catch (error) {
    release()
    throw error
  }
}
