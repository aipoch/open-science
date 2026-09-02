import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

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

const ensureInputDirectory = async (
  storageRoot: string,
  projectId: string,
  appSessionId: string
): Promise<string> => {
  const dataRoot = getNotebookDataRoot(storageRoot, projectId, appSessionId)
  const relativeDataRoot = relative(resolve(storageRoot), resolve(dataRoot))
  if (
    !relativeDataRoot ||
    relativeDataRoot === '..' ||
    relativeDataRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeDataRoot)
  ) {
    throw new Error('Notebook input path is outside trusted Notebook storage.')
  }

  let current = await realpath(storageRoot)
  for (const segment of [...relativeDataRoot.split(sep), INPUTS_DIR]) {
    const candidate = join(current, segment)
    try {
      await mkdir(candidate, { mode: 0o700 })
    } catch (error) {
      if (!isFileExistsError(error)) throw error
    }
    const state = await lstat(candidate)
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error('Notebook input path is not trusted Notebook storage.')
    }
    const resolvedCandidate = await realpath(candidate)
    if (relative(current, resolvedCandidate) !== segment) {
      throw new Error('Notebook input path is outside trusted Notebook storage.')
    }
    current = resolvedCandidate
  }
  return current
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
  const inputsRoot = await ensureInputDirectory(
    request.storageRoot,
    request.projectId,
    request.appSessionId
  )
  const candidates = [
    inputFilename(request.input.filename, request.input.checksum),
    inputFilename(request.input.filename, request.input.checksum, true)
  ]

  for (const candidate of candidates) {
    const verifiedInputsRoot = await ensureInputDirectory(
      request.storageRoot,
      request.projectId,
      request.appSessionId
    )
    if (verifiedInputsRoot !== inputsRoot) {
      throw new Error('Notebook input path changed outside trusted Notebook storage.')
    }
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
