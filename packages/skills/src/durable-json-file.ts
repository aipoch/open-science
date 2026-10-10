import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { defaultFileDurability } from './file-durability'
import { retryFileReplacement } from './file-replacement'

const fileOperations = new Map<string, Promise<void>>()

type DurableJsonDirectoryEntry = {
  name: string
  isFile(): boolean
}

type DurableJsonFileStat = {
  mtimeMs: number
  size: number
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
  readFileWithinLimit(path: string, maxBytes: number): Promise<string>
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

export class DurableJsonReadLimitError extends DurableJsonRecoveryBarrierError {
  constructor(
    readonly fileName: string,
    readonly maxBytes: number
  ) {
    super(`${fileName} exceeds the ${maxBytes} byte read limit.`)
    this.name = 'DurableJsonReadLimitError'
  }
}

const BOUNDED_READ_CHUNK_BYTES = 64 * 1024

export const readFileWithinLimit = async (path: string, maxBytes: number): Promise<string> => {
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error(`${basename(path)} is not a regular file.`)
    if (metadata.size > maxBytes) throw new DurableJsonReadLimitError(basename(path), maxBytes)

    const decoder = new StringDecoder('utf8')
    const parts: string[] = []
    // StringDecoder consumes each chunk synchronously, so subsequent reads can reuse it.
    const buffer = Buffer.allocUnsafe(Math.min(BOUNDED_READ_CHUNK_BYTES, maxBytes + 1))
    let bytesReadTotal = 0
    while (bytesReadTotal <= maxBytes) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, maxBytes + 1 - bytesReadTotal),
        null
      )
      if (bytesRead === 0) break
      bytesReadTotal += bytesRead
      if (bytesReadTotal > maxBytes) {
        throw new DurableJsonReadLimitError(basename(path), maxBytes)
      }
      parts.push(decoder.write(buffer.subarray(0, bytesRead)))
    }
    parts.push(decoder.end())
    return parts.join('')
  } finally {
    await file.close()
  }
}

const DEFAULT_DEPENDENCIES: DurableJsonFileDependencies = {
  createTemporarySuffix: () => `${process.pid}-${randomUUID()}`,
  mkdir: (path, options) => mkdir(path, options),
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  readFile: (path) => readFile(path, 'utf8'),
  readFileWithinLimit,
  remove: (path, options) => rm(path, options),
  rename: (source, destination) => rename(source, destination),
  stat: (path) => stat(path),
  syncDirectory: (path) => defaultFileDurability.syncDirectory(path),
  syncFile: (path) => defaultFileDurability.syncFile(path),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  writeFile: (path, contents, options) => writeFile(path, contents, options)
}

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
      await retryFileReplacement(
        () => dependencies.rename(temporaryPath, filePath),
        dependencies.wait
      )
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
