import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep
} from 'node:path'

import type { NotebookPromptInput, NotebookRunInputFile } from '../../shared/notebook'
import { toSafeUploadFilename } from '../uploads/storage-helpers'
import { getNotebookDataRoot, getNotebookSessionRoot } from './repository'

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

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT'

const inputFilename = (filename: string, checksum: string, fullChecksum = false): string => {
  const safeName = toSafeUploadFilename(filename)
  const extension = extname(safeName)
  const stem = basename(safeName, extension)
  const suffix = `-${checksum.slice(0, fullChecksum ? checksum.length : 12)}`
  const maxStemBytes = MAX_FILENAME_BYTES - Buffer.byteLength(extension) - suffix.length
  return `${stem.slice(0, maxStemBytes)}${suffix}${extension}`
}

const resolveTrustedDirectory = async (
  storageRoot: string,
  target: string,
  create: boolean
): Promise<string | undefined> => {
  const relativeTarget = relative(resolve(storageRoot), resolve(target))
  if (
    !relativeTarget ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error('Notebook input path is outside trusted Notebook storage.')
  }

  let current: string
  try {
    current = await realpath(storageRoot)
  } catch (error) {
    if (!create && isMissingFileError(error)) return undefined
    throw error
  }
  for (const segment of relativeTarget.split(sep)) {
    const candidate = join(current, segment)
    if (create) {
      try {
        await mkdir(candidate, { mode: 0o700 })
      } catch (error) {
        if (!isFileExistsError(error)) throw error
      }
    }
    let state
    try {
      state = await lstat(candidate)
    } catch (error) {
      if (!create && isMissingFileError(error)) return undefined
      throw error
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      if (!create) return undefined
      throw new Error('Notebook input path is not trusted Notebook storage.')
    }
    const resolvedCandidate = await realpath(candidate)
    if (relative(current, resolvedCandidate) !== segment) {
      if (!create) return undefined
      throw new Error('Notebook input path is outside trusted Notebook storage.')
    }
    current = resolvedCandidate
  }
  return current
}

const ensureInputDirectory = async (
  storageRoot: string,
  projectId: string,
  appSessionId: string
): Promise<string> => {
  const inputRoot = await resolveTrustedDirectory(
    storageRoot,
    join(getNotebookDataRoot(storageRoot, projectId, appSessionId), INPUTS_DIR),
    true
  )
  if (!inputRoot) throw new Error('Notebook input path is not trusted Notebook storage.')
  return inputRoot
}

const deleteNotebookPromptInputDirectory = async (
  storageRoot: string,
  sessionRoot: string
): Promise<void> => {
  const inputRoot = await resolveTrustedDirectory(
    storageRoot,
    join(sessionRoot, 'data', INPUTS_DIR),
    false
  )
  if (inputRoot) await rm(inputRoot, { recursive: true, force: true })
}

const deleteNotebookSessionPromptInputs = (
  storageRoot: string,
  projectId: string,
  appSessionId: string
): Promise<void> =>
  deleteNotebookPromptInputDirectory(
    storageRoot,
    getNotebookSessionRoot(storageRoot, projectId, appSessionId)
  )

const deleteNotebookProjectPromptInputs = async (
  storageRoot: string,
  projectId: string
): Promise<void> => {
  const projectPath = dirname(getNotebookSessionRoot(storageRoot, projectId, 'session'))
  const projectRoot = await resolveTrustedDirectory(storageRoot, projectPath, false)
  if (!projectRoot) return
  const sessions = await readdir(projectRoot, { withFileTypes: true })
  await Promise.all(
    sessions
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) =>
        deleteNotebookPromptInputDirectory(storageRoot, join(projectPath, entry.name))
      )
  )
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

export {
  deleteNotebookProjectPromptInputs,
  deleteNotebookSessionPromptInputs,
  materializeNotebookPromptInput
}
