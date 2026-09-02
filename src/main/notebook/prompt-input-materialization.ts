import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, posix, relative } from 'node:path'

import type { NotebookPromptInput, NotebookRunInputFile } from '../../shared/notebook'
import { toSafeUploadFilename } from '../uploads/storage-helpers'
import { getNotebookDataRoot } from './repository'

const INPUTS_DIR = 'inputs'
const MAX_FILENAME_BYTES = 255

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const isFileExistsError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'EEXIST'

const inputFilename = (filename: string, checksum: string, fullChecksum = false): string => {
  const safeName = toSafeUploadFilename(filename)
  const extension = extname(safeName)
  const stem = basename(safeName, extension)
  const suffix = `-${checksum.slice(0, fullChecksum ? checksum.length : 12)}`
  const maxStemBytes = MAX_FILENAME_BYTES - Buffer.byteLength(extension) - suffix.length
  return `${stem.slice(0, maxStemBytes)}${suffix}${extension}`
}

const ensureInputDirectory = async (dataRoot: string): Promise<string> => {
  const inputsRoot = join(dataRoot, INPUTS_DIR)
  await mkdir(inputsRoot, { recursive: true, mode: 0o700 })
  const state = await lstat(inputsRoot)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error('Notebook input path is not a trusted directory.')
  }
  const [resolvedDataRoot, resolvedInputsRoot] = await Promise.all([
    realpath(dataRoot),
    realpath(inputsRoot)
  ])
  const relativePath = relative(resolvedDataRoot, resolvedInputsRoot)
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error('Notebook input directory escapes the current Notebook data root.')
  }
  return resolvedInputsRoot
}

const matchesInput = async (path: string, input: NotebookRunInputFile): Promise<boolean> => {
  const state = await lstat(path)
  return (
    state.isFile() &&
    !state.isSymbolicLink() &&
    state.size === input.sizeBytes &&
    (await sha256File(path)) === input.checksum
  )
}

const materializeNotebookPromptInput = async (request: {
  storageRoot: string
  projectId: string
  appSessionId: string
  input: NotebookRunInputFile
  stagedPath: string
}): Promise<NotebookPromptInput> => {
  const dataRoot = getNotebookDataRoot(
    request.storageRoot,
    request.projectId,
    request.appSessionId
  )
  const inputsRoot = await ensureInputDirectory(dataRoot)
  const candidates = [
    inputFilename(request.input.filename, request.input.checksum),
    inputFilename(request.input.filename, request.input.checksum, true)
  ]

  for (const candidate of candidates) {
    const destination = join(inputsRoot, candidate)
    try {
      await copyFile(request.stagedPath, destination, constants.COPYFILE_EXCL)
      try {
        await chmod(destination, 0o444)
      } catch (error) {
        await rm(destination, { force: true })
        throw error
      }
      return {
        sourceKind: request.input.sourceKind,
        inputFileVersionId: request.input.inputFileVersionId,
        filename: request.input.filename,
        notebookPath: posix.join(INPUTS_DIR, candidate)
      }
    } catch (error) {
      if (!isFileExistsError(error)) throw error
      if (await matchesInput(destination, request.input)) {
        await chmod(destination, 0o444)
        return {
          sourceKind: request.input.sourceKind,
          inputFileVersionId: request.input.inputFileVersionId,
          filename: request.input.filename,
          notebookPath: posix.join(INPUTS_DIR, candidate)
        }
      }
    }
  }

  throw new Error(`Notebook input path conflicts with another file: ${request.input.filename}`)
}

export { materializeNotebookPromptInput }
