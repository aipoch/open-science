import { realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { RELOCATABLE_DATA_DIRS } from './data-directories'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from './durable-json-file'
import { readMigrationMarker, removeMigrationMarker } from './migration-marker'
import { defaultFileDurability } from './file-durability'

const DATA_ROOT_CLEANUP_FILENAME = 'data-root-cleanup.json'
const CLEANUP_INTENT_VERSION = 1 as const
const ALLOWED_CLEANUP_DIRS = new Set([
  ...RELOCATABLE_DATA_DIRS,
  'runtime',
  join('runtime', 'pkgs'),
  join('runtime', 'provenance', 'environment-manifests')
])

type DataRootCleanupIntent = Readonly<{
  version: typeof CLEANUP_INTENT_VERSION
  token: string
  source: string
  target: string
  dirs: string[]
  createdAt: number
}>

type StageDataRootCleanupIntent = Omit<DataRootCleanupIntent, 'version'>
type DeleteSources = (
  source: string,
  dirs: string[]
) => Promise<{ deleted: string[]; failed: { dir: string; error: string }[] }>
type CleanupRecoveryResult = Readonly<{ pending: boolean; failureCount: number }>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const decodeCleanupIntent = (contents: string): DataRootCleanupIntent => {
  const value = JSON.parse(contents) as unknown
  if (!isRecord(value)) throw new Error('Invalid data-root cleanup intent.')
  if (value.version !== CLEANUP_INTENT_VERSION) {
    throw new DurableJsonRecoveryBarrierError('Unsupported data-root cleanup intent version.')
  }
  if (
    typeof value.token !== 'string' ||
    value.token.length === 0 ||
    typeof value.source !== 'string' ||
    !isAbsolute(value.source) ||
    typeof value.target !== 'string' ||
    !isAbsolute(value.target) ||
    !Array.isArray(value.dirs) ||
    value.dirs.length === 0 ||
    !value.dirs.every((dir) => typeof dir === 'string' && ALLOWED_CLEANUP_DIRS.has(dir)) ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    throw new Error('Invalid data-root cleanup intent.')
  }
  return {
    version: CLEANUP_INTENT_VERSION,
    token: value.token,
    source: resolve(value.source),
    target: resolve(value.target),
    dirs: [...value.dirs],
    createdAt: value.createdAt
  }
}

const isPathInsideOrEqual = (parent: string, candidate: string): boolean => {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

class DataRootCleanupJournal {
  private readonly filePath: string

  constructor(configRoot: string) {
    this.filePath = join(configRoot, DATA_ROOT_CLEANUP_FILENAME)
  }

  private async read(): Promise<DataRootCleanupIntent | undefined> {
    const result = await readDurableJsonFile(this.filePath, decodeCleanupIntent)
    return result.status === 'found' ? result.value : undefined
  }

  async stage(input: StageDataRootCleanupIntent): Promise<void> {
    if (input.dirs.length === 0 || !input.dirs.every((dir) => ALLOWED_CLEANUP_DIRS.has(dir))) {
      throw new Error('Refused unsafe data-root cleanup paths.')
    }
    const [source, target] = await Promise.all([realpath(input.source), realpath(input.target)])
    const canonicalSource = resolve(source)
    const canonicalTarget = resolve(target)
    if (
      isPathInsideOrEqual(canonicalSource, canonicalTarget) ||
      isPathInsideOrEqual(canonicalTarget, canonicalSource)
    ) {
      throw new Error('Refused overlapping data-root cleanup paths.')
    }
    const intent: DataRootCleanupIntent = {
      version: CLEANUP_INTENT_VERSION,
      token: input.token,
      source: canonicalSource,
      target: canonicalTarget,
      dirs: [...input.dirs],
      createdAt: input.createdAt
    }
    await writeDurableJsonFile(this.filePath, `${JSON.stringify(intent, null, 2)}\n`)
  }

  async clear(expectedToken?: string): Promise<void> {
    if (expectedToken) {
      const intent = await this.read()
      if (intent && intent.token !== expectedToken) return
    }
    await rm(this.filePath, { force: true })
    await defaultFileDurability.syncDirectory(dirname(this.filePath))
  }

  async hasPending(): Promise<boolean> {
    try {
      return (await this.read()) !== undefined
    } catch {
      return true
    }
  }

  async recover(
    currentDataRoot: string,
    deleteSources: DeleteSources
  ): Promise<CleanupRecoveryResult> {
    let intent: DataRootCleanupIntent | undefined
    try {
      intent = await this.read()
    } catch {
      return { pending: true, failureCount: 0 }
    }
    if (!intent) return { pending: false, failureCount: 0 }

    let current: string
    let source: string
    let target: string
    try {
      ;[current, source, target] = await Promise.all([
        realpath(currentDataRoot).then(resolve),
        realpath(intent.source).then(resolve),
        realpath(intent.target).then(resolve)
      ])
    } catch {
      return { pending: true, failureCount: 0 }
    }
    if (samePath(current, source)) {
      try {
        await this.clear(intent.token)
        return { pending: false, failureCount: 0 }
      } catch {
        return { pending: true, failureCount: 0 }
      }
    }
    if (
      !samePath(current, target) ||
      !samePath(source, intent.source) ||
      !samePath(target, intent.target) ||
      isPathInsideOrEqual(source, target) ||
      isPathInsideOrEqual(target, source)
    ) {
      return { pending: true, failureCount: 0 }
    }

    const marker = await readMigrationMarker(target)
    if (!marker || marker.status !== 'verified' || marker.token !== intent.token) {
      return { pending: true, failureCount: 0 }
    }
    let markerSource: string
    let markerTarget: string
    try {
      ;[markerSource, markerTarget] = await Promise.all([
        realpath(marker.source).then(resolve),
        realpath(marker.target).then(resolve)
      ])
    } catch {
      return { pending: true, failureCount: 0 }
    }
    if (!samePath(markerSource, source) || !samePath(markerTarget, target)) {
      return { pending: true, failureCount: 0 }
    }
    const markerDirs = new Set(marker.migratedDirs ?? RELOCATABLE_DATA_DIRS)
    const runtimeCleanupAllowed =
      markerDirs.has(join('runtime', 'pkgs')) &&
      markerDirs.has(join('runtime', 'provenance', 'environment-manifests'))
    if (
      intent.dirs.some((dir) => dir !== 'runtime' && !markerDirs.has(dir)) ||
      (intent.dirs.includes('runtime') && !runtimeCleanupAllowed)
    ) {
      return { pending: true, failureCount: 0 }
    }

    let result: Awaited<ReturnType<DeleteSources>>
    try {
      result = await deleteSources(source, [...intent.dirs])
    } catch {
      return { pending: true, failureCount: 1 }
    }
    if (result.failed.length > 0) {
      return { pending: true, failureCount: result.failed.length }
    }

    await this.clear(intent.token)
    await removeMigrationMarker(target).catch(() => undefined)
    return { pending: false, failureCount: 0 }
  }
}

export { DATA_ROOT_CLEANUP_FILENAME, DataRootCleanupJournal }
export type { CleanupRecoveryResult, DeleteSources, StageDataRootCleanupIntent }
