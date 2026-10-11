import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ReproducibilityOutputPreview } from '../../shared/artifact-reproducibility'
import { sha256 } from './provenance-canonical'
import { publishUserFile } from '../user-file-publisher'

import {
  MAX_REPRODUCIBILITY_OUTPUT_BYTES,
  readReproducibilityOutputFile
} from '@aipoch/reproducibility'
const MAX_STORED_BYTES = 256 * 1024 * 1024
const MAX_STORED_FILES = 128
const OUTPUT_DIRECTORY = 'outputs'
const OUTPUT_NAME = /^sha256-([a-f0-9]{64})\.bin$/u

const reproducibilityOutputUsage = async (
  directory: string
): Promise<{ sizeBytes: number; fileCount: number }> => {
  const outputs = join(directory, OUTPUT_DIRECTORY)
  const stat = await lstat(outputs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) return { sizeBytes: 0, fileCount: 0 }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Invalid reproduced output directory.')
  }
  let sizeBytes = 0
  const entries = await readdir(outputs, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !OUTPUT_NAME.test(entry.name))
      throw new Error('Invalid reproduced output entry.')
    const file = await lstat(join(outputs, entry.name))
    if (!file.isFile() || file.nlink !== 1) throw new Error('Invalid reproduced output entry.')
    sizeBytes += file.size
  }
  return { sizeBytes, fileCount: entries.length }
}

const writeReproducibilityOutput = async (directory: string, bytes: Buffer): Promise<boolean> => {
  if (bytes.length > MAX_REPRODUCIBILITY_OUTPUT_BYTES) return false
  const outputs = join(directory, OUTPUT_DIRECTORY)
  await mkdir(outputs, { recursive: true })
  const outputsStat = await lstat(outputs)
  if (outputsStat.isSymbolicLink() || !outputsStat.isDirectory()) {
    throw new Error('Invalid reproduced output directory.')
  }
  const checksum = sha256(bytes)
  const destination = join(outputs, `sha256-${checksum}.bin`)
  const entries = await readdir(outputs, { withFileTypes: true })
  if (entries.some((entry) => entry.name === `sha256-${checksum}.bin`)) {
    if (sha256(await readReproducibilityOutputFile(destination)) !== checksum)
      throw new Error('Reproduced output checksum mismatch.')
    return true
  }
  if (entries.length >= MAX_STORED_FILES) return false
  let size = bytes.length
  for (const entry of entries) {
    if (!entry.isFile() || !OUTPUT_NAME.test(entry.name))
      throw new Error('Invalid reproduced output entry.')
    size += (await lstat(join(outputs, entry.name))).size
  }
  if (size > MAX_STORED_BYTES) return false
  await publishUserFile(destination, (path) => writeFile(path, bytes, { mode: 0o600 }))
  return true
}

const pendingWrites = new Map<string, Promise<boolean>>()
const retainReproducibilityOutput = async (directory: string, bytes: Buffer): Promise<boolean> => {
  const previous = pendingWrites.get(directory) ?? Promise.resolve(true)
  const write = previous.catch(() => false).then(() => writeReproducibilityOutput(directory, bytes))
  pendingWrites.set(directory, write)
  try {
    return await write
  } finally {
    if (pendingWrites.get(directory) === write) pendingWrites.delete(directory)
  }
}

const readRetainedReproducibilityOutput = async (
  directory: string,
  checksum: string,
  sizeBytes: number
): Promise<Buffer> => {
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error('Invalid reproduced output checksum.')
  const outputs = join(directory, OUTPUT_DIRECTORY)
  const outputsStat = await lstat(outputs)
  if (outputsStat.isSymbolicLink() || !outputsStat.isDirectory()) {
    throw new Error('Invalid reproduced output directory.')
  }
  const bytes = await readReproducibilityOutputFile(join(outputs, `sha256-${checksum}.bin`))
  if (bytes.length !== sizeBytes || sha256(bytes) !== checksum)
    throw new Error('Reproduced output checksum mismatch.')
  return bytes
}

// The attempt owner admits one check per Artifact Version. Call this within its
// storage lease, before execution and after receipt publication or cancellation.
const pruneReproducibilityOutputs = async (
  directory: string,
  referenced: Set<string>
): Promise<void> => {
  const outputs = join(directory, OUTPUT_DIRECTORY)
  const stat = await lstat(outputs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) return
  if (!stat.isDirectory()) throw new Error('Invalid reproduced output directory.')
  for (const entry of await readdir(outputs, { withFileTypes: true })) {
    const checksum = entry.isFile() ? OUTPUT_NAME.exec(entry.name)?.[1] : undefined
    if (!checksum) throw new Error('Invalid reproduced output entry.')
    if (!referenced.has(checksum)) await rm(join(outputs, entry.name))
  }
}

const validateReproducibilityOutputs = async (directory: string): Promise<void> => {
  const outputs = join(directory, OUTPUT_DIRECTORY)
  const stat = await lstat(outputs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) return
  if (!stat.isDirectory()) throw new Error('Invalid reproduced output directory.')
  const entries = await readdir(outputs, { withFileTypes: true })
  if (entries.length > MAX_STORED_FILES)
    throw new Error('Reproduced output storage limit exceeded.')
  let size = 0
  for (const entry of entries) {
    const checksum = entry.isFile() ? OUTPUT_NAME.exec(entry.name)?.[1] : undefined
    if (!checksum) throw new Error('Invalid reproduced output entry.')
    const bytes = await readReproducibilityOutputFile(join(outputs, entry.name))
    if (sha256(bytes) !== checksum) throw new Error('Reproduced output checksum mismatch.')
    size += bytes.length
    if (size > MAX_STORED_BYTES) throw new Error('Reproduced output storage limit exceeded.')
  }
}

const outputPreview = (filename: string, bytes: Buffer): ReproducibilityOutputPreview => {
  const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
        ? 'image/gif'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
          ? 'image/webp'
          : undefined
  if (mime && bytes.length <= 8 * 1024 * 1024)
    return { kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  if (
    ['.csv', '.tsv', '.txt', '.json', '.log', '.r', '.py'].includes(extname(filename).toLowerCase())
  )
    return {
      kind: 'text',
      text: bytes.subarray(0, 64 * 1024).toString('utf8'),
      truncated: bytes.length > 64 * 1024
    }
  return { kind: 'unsupported' }
}

export {
  reproducibilityOutputUsage,
  OUTPUT_DIRECTORY,
  outputPreview,
  pruneReproducibilityOutputs,
  validateReproducibilityOutputs,
  readRetainedReproducibilityOutput,
  retainReproducibilityOutput
}
