import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { defaultFileDurability } from './file-durability'

const FILE_REPLACEMENT_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const
const fileOperations = new Map<string, Promise<void>>()

type DurableJsonDirectoryEntry = {
  name: string
  isFile(): boolean
}

type DurableJsonFileStat = {
  mtimeMs: number
}

type DurableJsonWriteOptions = {
  encoding: 'utf8'
  flag: 'wx'
  mode: number
}

export type DurableJsonFileDependencies = {
  createTemporarySuffix(): string
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readDirectoryEntries(path: string): Promise<DurableJsonDirectoryEntry[]>
  readFile(path: string): Promise<string>
  remove(path: string, options: { force: true; recursive: false }): Promise<void>
  rename(source: string, destination: string): Promise<void>
  stat(path: string): Promise<DurableJsonFileStat>
  syncDirectory(path: string): Promise<void>
  syncFile(path: string): Promise<void>
  wait(delayMs: number): Promise<void>
  writeFile(path: string, contents: string, options: DurableJsonWriteOptions): Promise<void>
}

// Signals that a recognized temp may contain authoritative data this release cannot interpret.
// Recovery must preserve it and stop instead of falling back to an older decodable candidate.
export class DurableJsonRecoveryBarrierError extends Error {}

const DEFAULT_DEPENDENCIES: DurableJsonFileDependencies = {
  createTemporarySuffix: () => `${process.pid}-${randomUUID()}`,
  mkdir: (path, options) => mkdir(path, options),
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  readFile: (path) => readFile(path, 'utf8'),
  remove: (path, options) => rm(path, options),
  rename: (source, destination) => rename(source, destination),
  stat: (path) => stat(path),
  syncDirectory: (path) => defaultFileDurability.syncDirectory(path),
  syncFile: (path) => defaultFileDurability.syncFile(path),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  writeFile: (path, contents, options) => writeFile(path, contents, options)
}

const isRetryableFileReplacementError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const isExistingFileError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'

const runFileOperation = async <Result>(
  filePath: string,
  operation: () => Promise<Result>
): Promise<Result> => {
  const previous = fileOperations.get(filePath) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  fileOperations.set(filePath, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (fileOperations.get(filePath) === tail) fileOperations.delete(filePath)
  }
}

const renameWithRetry = async (
  source: string,
  destination: string,
  dependencies: DurableJsonFileDependencies
): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await dependencies.rename(source, destination)
      return
    } catch (error) {
      const delayMs = FILE_REPLACEMENT_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined || !isRetryableFileReplacementError(error)) throw error
      await dependencies.wait(delayMs)
    }
  }
}

export const writeDurableJsonFile = async (
  filePath: string,
  contents: string,
  dependencyOverrides: Partial<DurableJsonFileDependencies> = {}
): Promise<void> => {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  return runFileOperation(filePath, async () => {
    const directory = dirname(filePath)
    await dependencies.mkdir(directory, { recursive: true })
    const temporaryPath = `${filePath}.${dependencies.createTemporarySuffix()}.tmp`
    let ownsTemporaryPath = true

    try {
      try {
        await dependencies.writeFile(temporaryPath, contents, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600
        })
      } catch (error) {
        if (isExistingFileError(error)) ownsTemporaryPath = false
        throw error
      }
      await dependencies.syncFile(temporaryPath)
      await renameWithRetry(temporaryPath, filePath, dependencies)
      await dependencies.syncDirectory(directory)
    } catch (error) {
      if (ownsTemporaryPath) {
        await dependencies
          .remove(temporaryPath, { force: true, recursive: false })
          .catch(() => undefined)
      }
      throw error
    }
  })
}

type DurableJsonReadResult<Value> = { status: 'found'; value: Value } | { status: 'missing' }

type TemporaryCandidate = {
  name: string
  path: string
  mtimeMs: number
}

type RecognizedTemporarySuffix = {
  activeCreatorPid?: number
}

const recognizeTemporarySuffix = (
  filePath: string,
  name: string
): RecognizedTemporarySuffix | undefined => {
  const prefix = `${basename(filePath)}.`
  const suffix = name.slice(prefix.length, -'.tmp'.length)
  const currentMatch =
    /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.exec(suffix)
  if (currentMatch) {
    const activeCreatorPid = Number(currentMatch[1])
    return Number.isSafeInteger(activeCreatorPid) && activeCreatorPid > 0
      ? { activeCreatorPid }
      : undefined
  }

  // Older Settings/Session/Notebook/Specialist writers used Date.now() plus a sequence. Older
  // Remote Access and Web state writers used a PID alone. Those formats never had a reliable live
  // ownership marker, so treat them as crash residue even if a later process happens to reuse the PID.
  if (/^\d{13}-\d+$/u.test(suffix) || /^\d+$/u.test(suffix)) return {}
  return undefined
}

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

const listTemporaryCandidates = async (
  filePath: string,
  dependencies: DurableJsonFileDependencies
): Promise<TemporaryCandidate[]> => {
  const directory = dirname(filePath)
  const prefix = `${basename(filePath)}.`
  let entries: DurableJsonDirectoryEntry[]
  try {
    entries = await dependencies.readDirectoryEntries(directory)
  } catch (error) {
    if (isMissingFileError(error)) return []
    throw error
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) {
          return false
        }
        const recognized = recognizeTemporarySuffix(filePath, entry.name)
        return recognized && !isProcessAlive(recognized.activeCreatorPid ?? 0)
      })
      .map(async (entry) => {
        const path = join(directory, entry.name)
        return { name: entry.name, path, mtimeMs: (await dependencies.stat(path)).mtimeMs }
      })
  )
  return candidates.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name)
  )
}

const cleanupTemporaryCandidates = async (
  candidates: readonly TemporaryCandidate[],
  dependencies: DurableJsonFileDependencies
): Promise<void> => {
  await Promise.all(
    candidates.map((candidate) =>
      dependencies.remove(candidate.path, { force: true, recursive: false }).catch(() => undefined)
    )
  )
}

export const readDurableJsonFile = async <Value>(
  filePath: string,
  decode: (contents: string) => Value,
  dependencyOverrides: Partial<DurableJsonFileDependencies> = {}
): Promise<DurableJsonReadResult<Value>> => {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  return runFileOperation(filePath, async () => {
    let primaryContents: string
    try {
      primaryContents = await dependencies.readFile(filePath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
      const candidates = await listTemporaryCandidates(filePath, dependencies)
      for (const candidate of candidates) {
        let candidateContents: string
        try {
          candidateContents = await dependencies.readFile(candidate.path)
        } catch (candidateReadError) {
          if (isMissingFileError(candidateReadError)) continue
          throw candidateReadError
        }

        let value: Value
        try {
          value = decode(candidateContents)
        } catch (error) {
          if (error instanceof DurableJsonRecoveryBarrierError) throw error
          continue
        }

        await dependencies.syncFile(candidate.path)
        await renameWithRetry(candidate.path, filePath, dependencies)
        await dependencies.syncDirectory(dirname(filePath))
        await cleanupTemporaryCandidates(candidates, dependencies)
        return { status: 'found', value }
      }
      return { status: 'missing' }
    }

    const value = decode(primaryContents)
    await cleanupTemporaryCandidates(
      await listTemporaryCandidates(filePath, dependencies),
      dependencies
    )
    return { status: 'found', value }
  })
}

export const recoverDurableJsonDirectory = async (
  directory: string,
  decode: (targetPath: string, contents: string) => unknown,
  dependencyOverrides: Partial<DurableJsonFileDependencies> = {}
): Promise<void> => {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  let entries: DurableJsonDirectoryEntry[]
  try {
    entries = await dependencies.readDirectoryEntries(directory)
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }

  const targetNames = new Set(
    entries.flatMap((entry) => {
      if (!entry.isFile()) return []
      const match =
        /^(.+\.json)\.(?:\d{13}-\d+|\d+|\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.tmp$/iu.exec(
          entry.name
        )
      return match?.[1] ? [match[1]] : []
    })
  )
  for (const targetName of [...targetNames].sort()) {
    const targetPath = join(directory, targetName)
    try {
      await dependencies.stat(targetPath)
      continue
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    await readDurableJsonFile(targetPath, (contents) => decode(targetPath, contents), dependencies)
  }
}
