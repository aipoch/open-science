import { BrowserWindow, app, dialog, type OpenDialogOptions } from 'electron'
import { Zip, ZipDeflate } from 'fflate'

import { ipcMainHandle } from './ipc-handler-registry'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveProjectArtifactFailure,
  SaveProjectArtifactsRequest,
  SaveProjectArtifactsResult,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
} from '../shared/file-save'
import { englishNativeTranslator, type NativeTranslator } from './locale/main-process-messages'
import { toErrorMessage } from './error-message'
import { publishUserFile } from './user-file-publisher'

type RegisterFileSaveHandlersOptions = {
  resolveManagedFilePath?: (
    source: 'local',
    request: {
      path: string
      projectId?: string
      sessionId?: string
      fileId?: string
      versionId?: string
    }
  ) => Promise<ManagedFilePathResolution>
  openManagedFile?: (sourcePath: string) => Promise<ManagedFileHandle>
  openNotebookInput?: (request: { path: string }) => Promise<ManagedFileHandle>
  openLatestManagedFile?: (
    source: 'artifact' | 'upload',
    request: { projectId: string; fileId: string }
  ) => Promise<ManagedFileVersionHandle>
  openManagedFileVersion?: (
    source: 'artifact' | 'upload',
    request: { projectId: string; fileId: string; versionId: string }
  ) => Promise<ManagedFileVersionHandle>
  createProjectArtifactTemporaryRoot?: () => Promise<string>
  projectArtifactExportLimits?: ProjectArtifactExportLimits
  publishUserFile?: typeof publishUserFile
  translate?: NativeTranslator
}

type ManagedFilePathResolution =
  | string
  | {
      path: string
      expectedSize: number
      expectedChecksum: string
    }

type ProjectArtifactExportLimits = {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

const PROJECT_ARTIFACT_EXPORT_LIMITS: ProjectArtifactExportLimits = {
  maxFiles: 5000,
  maxFileBytes: 1024 ** 3,
  maxTotalBytes: 2 * 1024 ** 3
}

const PROJECT_ARTIFACT_STREAM_CHUNK_BYTES = 64 * 1024

type ManagedFileHandle = {
  copyTo: (destinationPath: string, options?: { exclusive?: boolean }) => Promise<void>
  assertCanCopyTo?: (destinationPath: string) => Promise<void>
  close: () => Promise<void>
}

// The verified Version lease exposes bounded reads from the inode selected by the DB lookup.
type ManagedFileVersionHandle = ManagedFileHandle & {
  size: number
  readRange: (begin: number, end: number) => Promise<Uint8Array>
  verifyUnchanged: () => Promise<void>
}

// IPC input is renderer-controlled; reject malformed sources and paths before any filesystem work.
const assertSaveManagedFileRequest: (
  request: unknown
) => asserts request is SaveManagedFileRequest = (request) => {
  if (typeof request !== 'object' || request === null) {
    throw new Error('Invalid managed file save request.')
  }
  const candidate = request as Record<string, unknown>
  const source = candidate.source
  if (
    (source !== 'artifact' &&
      source !== 'upload' &&
      source !== 'notebook-input' &&
      source !== 'local') ||
    typeof candidate.suggestedName !== 'string'
  ) {
    throw new Error('Invalid managed file save request.')
  }
  if (source === 'artifact' || source === 'upload') {
    if (
      typeof candidate.projectId !== 'string' ||
      candidate.projectId.trim().length === 0 ||
      typeof candidate.fileId !== 'string' ||
      candidate.fileId.trim().length === 0
    ) {
      throw new Error('Managed file save requires a logical identity.')
    }
    if (
      candidate.versionId !== undefined &&
      (typeof candidate.versionId !== 'string' || candidate.versionId.trim().length === 0)
    ) {
      throw new Error('Invalid managed file save request.')
    }
    return
  }
  if (typeof candidate.path !== 'string' || candidate.path.trim().length === 0) {
    throw new Error('Invalid managed file save request.')
  }
}

const assertSaveSessionArtifactsRequest: (
  request: unknown
) => asserts request is SaveSessionArtifactsRequest = (request) => {
  const candidate = request as Record<string, unknown> | null
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.projectId !== 'string' ||
    candidate.projectId.trim().length === 0 ||
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId.trim().length === 0 ||
    !Array.isArray(candidate.files) ||
    candidate.files.length === 0 ||
    candidate.files.some((file) => {
      if (
        typeof file !== 'object' ||
        file === null ||
        typeof file.fileId !== 'string' ||
        file.fileId.trim().length === 0 ||
        typeof file.versionId !== 'string' ||
        file.versionId.trim().length === 0 ||
        typeof file.suggestedName !== 'string'
      ) {
        return true
      }
      if ('path' in file && file.path !== undefined) return true
      return false
    })
  ) {
    throw new Error('Invalid Session Artifact save request.')
  }
}

const assertSaveProjectArtifactsRequest = (request: SaveProjectArtifactsRequest): void => {
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.projectId !== 'string' ||
    request.projectId.trim().length === 0 ||
    typeof request.suggestedArchiveName !== 'string' ||
    !Array.isArray(request.files) ||
    request.files.length === 0 ||
    request.files.length > 10000 ||
    request.files.some((file) => {
      if (
        typeof file !== 'object' ||
        file === null ||
        (file.source !== 'artifact' && file.source !== 'upload') ||
        typeof file.sessionId !== 'string' ||
        file.sessionId.trim().length === 0 ||
        typeof file.suggestedName !== 'string'
      ) {
        return true
      }
      if (typeof file.fileId !== 'string' || file.fileId.trim().length === 0) return true
      if (typeof file.versionId !== 'string' || file.versionId.trim().length === 0) return true
      if ('path' in file) return true
      return false
    })
  ) {
    throw new Error('Invalid Project Artifact save request.')
  }
}

// Holds the validated source inode across Save As so a pending artifact rename cannot change identity.
const openManagedFile = async (sourcePath: string): Promise<ManagedFileHandle> => {
  const sourceHandle = await open(sourcePath, 'r')

  const assertCanCopyTo = async (destinationPath: string): Promise<void> => {
    let destinationHandle: FileHandle | undefined
    try {
      destinationHandle = await open(destinationPath, 'r')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    try {
      const sourceStat = await sourceHandle.stat()
      const destinationStat = await destinationHandle.stat()
      if (destinationStat.dev === sourceStat.dev && destinationStat.ino === sourceStat.ino) {
        throw new Error('Cannot save a managed file over its source.')
      }
    } finally {
      await destinationHandle.close()
    }
  }

  return {
    assertCanCopyTo,
    copyTo: async (destinationPath, options) => {
      // Open without truncation, then check and write through the same handle to prevent path swaps.
      const destinationHandle = await open(
        destinationPath,
        constants.O_CREAT | constants.O_RDWR | (options?.exclusive ? constants.O_EXCL : 0),
        0o666
      )

      try {
        const sourceStat = await sourceHandle.stat()
        const destinationStat = await destinationHandle.stat()
        if (destinationStat.dev === sourceStat.dev && destinationStat.ino === sourceStat.ino) {
          throw new Error('Cannot save a managed file over its source.')
        }

        await destinationHandle.truncate(0)
        await pipeline(
          sourceHandle.createReadStream({ autoClose: false, start: 0 }),
          destinationHandle.createWriteStream({ autoClose: true, start: 0 })
        )
      } finally {
        await destinationHandle.close()
      }
    },
    close: () => sourceHandle.close()
  }
}

const getManagedFilePath = (resolved: ManagedFilePathResolution): string =>
  typeof resolved === 'string' ? resolved : resolved.path

const appendArchiveChunk = async (handle: FileHandle, chunk: Uint8Array): Promise<void> => {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null)
    if (bytesWritten === 0) throw new Error('Failed to make progress writing Project Artifact ZIP.')
    offset += bytesWritten
  }
}

const writeProjectArtifactArchive = async (options: {
  destinationPath: string
  projectId: string
  files: SaveProjectArtifactsRequest['files']
  openManagedFileVersion: NonNullable<
    RegisterFileSaveHandlersOptions['openManagedFileVersion']
  >
  publishUserFile: typeof publishUserFile
  failures: SaveProjectArtifactFailure[]
  limits: ProjectArtifactExportLimits
  createTemporaryRoot: () => Promise<string>
}): Promise<boolean> => {
  let temporaryRoot: string | undefined
  let archiveHandle: FileHandle | undefined
  let archiveHandleClosed = false
  let zip: Zip | undefined

  try {
    temporaryRoot = await options.createTemporaryRoot()
    const temporaryArchivePath = join(temporaryRoot, 'project-artifacts.zip')
    archiveHandle = await open(temporaryArchivePath, 'wx', 0o600)
    let archiveFailure: Error | undefined
    let pendingArchiveWrite = Promise.resolve()
    let streamedEntries = 0
    let streamedBytes = 0
    const takenNames = new Set<string>()

    zip = new Zip((error, chunk) => {
      if (error) {
        archiveFailure ??= error
        return
      }
      if (!chunk) return
      pendingArchiveWrite = pendingArchiveWrite
        .then(() => (archiveFailure ? undefined : appendArchiveChunk(archiveHandle!, chunk)))
        .catch((writeError) => {
          archiveFailure = writeError instanceof Error ? writeError : new Error(String(writeError))
        })
    })

    const throwIfArchiveFailed = (): void => {
      if (archiveFailure) throw archiveFailure
    }

    for (const file of options.files) {
      let managedSource: ManagedFileVersionHandle | undefined
      let entryStarted = false
      try {
        if (streamedEntries >= options.limits.maxFiles) {
          throw new Error('Project export exceeds the file-count limit.')
        }
        managedSource = await options.openManagedFileVersion(file.source, {
          projectId: options.projectId,
          fileId: file.fileId,
          versionId: file.versionId
        })
        const sourceSize = managedSource.size
        if (!Number.isSafeInteger(sourceSize) || sourceSize < 0) {
          throw new Error('Project export source size is invalid.')
        }
        const chunks = (async function* (): AsyncGenerator<Uint8Array> {
          for (let begin = 0; begin < managedSource.size;) {
            const end = Math.min(begin + PROJECT_ARTIFACT_STREAM_CHUNK_BYTES, managedSource.size)
            const chunk = new Uint8Array(await managedSource.readRange(begin, end))
            if (chunk.byteLength !== end - begin) {
              throw new Error('Project export source changed while streaming.')
            }
            begin = end
            yield chunk
          }
        })()

        if (sourceSize > options.limits.maxFileBytes) {
          throw new Error('Project export file exceeds the per-file size limit.')
        }
        if (streamedBytes + sourceSize > options.limits.maxTotalBytes) {
          throw new Error('Project export exceeds the total size limit.')
        }

        const categoryDirectory = file.source === 'upload' ? 'uploads' : 'generated'
        const entryName = claimZipEntryName(
          takenNames,
          `${categoryDirectory}/${getSafeZipEntryName(file.suggestedName)}`
        )
        takenNames.add(entryName.toLowerCase())
        const zipEntry = new ZipDeflate(entryName, { level: 6 })
        zip.add(zipEntry)
        entryStarted = true
        let entryBytes = 0
        for await (const chunk of chunks) {
          entryBytes += chunk.byteLength
          if (entryBytes > options.limits.maxFileBytes) {
            throw new Error('Project export file exceeds the per-file size limit.')
          }
          if (streamedBytes + entryBytes > options.limits.maxTotalBytes) {
            throw new Error('Project export exceeds the total size limit.')
          }

          zipEntry.push(chunk, false)
          await pendingArchiveWrite
          throwIfArchiveFailed()
          // Bound each synchronous compression slice and explicitly let Electron service IPC,
          // window, and lifecycle events between source chunks.
          await yieldToEventLoop()
        }
        await managedSource.verifyUnchanged()
        zipEntry.push(new Uint8Array(0), true)
        await pendingArchiveWrite
        throwIfArchiveFailed()
        streamedBytes += entryBytes
        streamedEntries += 1
      } catch (error) {
        if (entryStarted) throw error
        options.failures.push({
          ...file,
          message: toErrorMessage(error)
        })
      } finally {
        await managedSource?.close()
      }
    }

    if (streamedEntries === 0) {
      zip.terminate()
      return false
    }

    zip.end()
    await pendingArchiveWrite
    throwIfArchiveFailed()
    await archiveHandle.close()
    archiveHandleClosed = true
    await options.publishUserFile(options.destinationPath, (temporaryPath) =>
      copyFile(temporaryArchivePath, temporaryPath, constants.COPYFILE_EXCL)
    )
    return true
  } catch (error) {
    zip?.terminate()
    throw error
  } finally {
    if (archiveHandle && !archiveHandleClosed) {
      await archiveHandle.close().catch(() => undefined)
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

const isAlreadyExistsError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST'

const addFilenameCollisionSuffix = (filename: string, suffix: number): string => {
  const extension = extname(filename)
  const stem = basename(filename, extension)
  return `${stem} (${suffix})${extension}`
}

// Zip entries share one archive-wide namespace; claim the first free name with the same collision
// suffix scheme used for on-disk batch exports. The suffix applies to the file name part only so
// category prefixes like 'generated/' survive renaming. Name claims compare case-insensitively
// because the archive may be extracted onto case-insensitive file systems.
const claimZipEntryName = (takenNames: ReadonlySet<string>, entryName: string): string => {
  const slashIndex = entryName.lastIndexOf('/')
  const directory = slashIndex === -1 ? '' : entryName.slice(0, slashIndex + 1)
  const fileName = slashIndex === -1 ? entryName : entryName.slice(slashIndex + 1)
  for (let suffix = 1; ; suffix += 1) {
    const candidate =
      suffix === 1 ? entryName : `${directory}${addFilenameCollisionSuffix(fileName, suffix)}`
    if (!takenNames.has(candidate.toLowerCase())) return candidate
  }
}

// fflate keeps archive entries in a plain object, where assigning '__proto__' writes to the
// prototype instead of creating an entry. Rename that one dangerous key; content is preserved.
const ZIP_FORBIDDEN_ENTRY_NAMES = new Set(['__proto__'])

// Zip entry names must also be safe on Windows: normalize backslashes before basename so a
// suggestedName like '..\..\evil.exe' collapses to a plain file name, then strip the characters
// Windows rejects in file names.
const getSafeZipEntryName = (suggestedName: string): string => {
  const safeName = basename(suggestedName.trim().replaceAll('\\', '/'))
    // Windows rejects these characters in file names; control characters are never valid.
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[<>:"|?*\x00-\x1f]/g, '-')
  return safeName &&
    safeName !== '.' &&
    safeName !== '..' &&
    !ZIP_FORBIDDEN_ENTRY_NAMES.has(safeName)
    ? safeName
    : 'file'
}

const getSafeZipBaseName = (suggestedArchiveName: string): string => {
  const trimmed = suggestedArchiveName
    .trim()
    .replaceAll('/', '-')
    .replaceAll('\\', '-')
    // Windows rejects these characters in file names; control characters are never valid.
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[<>:"|?*\x00-\x1f]/g, '-')
  return trimmed.length > 0 && trimmed !== '.' && trimmed !== '..' ? trimmed : 'project'
}

const getSafeFilename = (suggestedName: string, sourcePath: string): string => {
  const requestedBaseName = basename(suggestedName.trim())
  return requestedBaseName && requestedBaseName !== '.' && requestedBaseName !== '..'
    ? requestedBaseName
    : basename(sourcePath)
}

// Atomically claims the first available filename so batch exports never overwrite existing files.
const copyToAvailableDestination = async (
  managedFile: ManagedFileHandle,
  destinationDirectory: string,
  safeName: string,
  publish: typeof publishUserFile
): Promise<string> => {
  for (let suffix = 1; ; suffix += 1) {
    const filename = suffix === 1 ? safeName : addFilenameCollisionSuffix(safeName, suffix)
    const destinationPath = join(destinationDirectory, filename)
    try {
      await publish(
        destinationPath,
        (temporaryPath) => managedFile.copyTo(temporaryPath, { exclusive: true }),
        { exclusive: true }
      )
      return destinationPath
    } catch (error) {
      if (isAlreadyExistsError(error)) continue
      throw error
    }
  }
}

const extensionForMime = (mimeType: string): string | undefined => {
  switch (mimeType) {
    case 'image/svg+xml':
      return 'svg'
    case 'image/png':
      return 'png'
    case 'text/plain':
      return 'txt'
    case 'text/x-python':
      return 'py'
    case 'text/x-r':
      return 'R'
    case 'text/x-sh':
      return 'sh'
    case 'text/csv':
      return 'csv'
    case 'text/tab-separated-values':
      return 'tsv'
    case 'text/markdown':
      return 'md'
    default:
      return undefined
  }
}

const registerFileSaveHandlers = (options: RegisterFileSaveHandlersOptions = {}): void => {
  const publish = options.publishUserFile ?? publishUserFile
  ipcMainHandle(
    'file:save-blob',
    async (event, request: SaveBlobFileRequest): Promise<SaveBlobFileResult> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      const extension = extensionForMime(request.mimeType)
      const dialogOptions = {
        defaultPath: request.suggestedName,
        filters: extension
          ? [{ name: extension.toUpperCase(), extensions: [extension] }]
          : undefined
      }
      const { canceled, filePath } = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)

      if (canceled || !filePath) {
        return { saved: false }
      }

      await publish(filePath, (temporaryPath) =>
        writeFile(temporaryPath, Buffer.from(request.data))
      )
      return { saved: true, filePath }
    }
  )

  // Managed-file export stays in main so large files never pass through renderer memory.
  ipcMainHandle(
    'file:save-managed',
    async (event, request: SaveManagedFileRequest): Promise<SaveManagedFileResult> => {
      assertSaveManagedFileRequest(request)
      const versionedRequest =
        request.source === 'artifact' || request.source === 'upload' ? request : undefined
      const notebookInputRequest = request.source === 'notebook-input' ? request : undefined
      const localRequest = request.source === 'local' ? request : undefined
      if (versionedRequest) {
        if (
          versionedRequest.versionId
            ? !options.openManagedFileVersion
            : !options.openLatestManagedFile
        ) {
          throw new Error('Managed file Version lease is not configured.')
        }
      } else if (
        notebookInputRequest ? !options.openNotebookInput : !options.resolveManagedFilePath
      ) {
        throw new Error('Managed file resolver is not configured.')
      }

      const pathManagedFile = notebookInputRequest
        ? await options.openNotebookInput!({ path: notebookInputRequest.path })
        : localRequest
          ? await (options.openManagedFile ?? openManagedFile)(
              getManagedFilePath(
                await options.resolveManagedFilePath!('local', { path: localRequest.path })
              )
            )
          : undefined
      const requestedBaseName = basename(request.suggestedName.trim())
      const safeName =
        requestedBaseName && requestedBaseName !== '.' && requestedBaseName !== '..'
          ? requestedBaseName
          : versionedRequest
            ? versionedRequest.fileId
            : basename((notebookInputRequest ?? localRequest)!.path)
      const dialogOptions = {
        defaultPath: join(app.getPath('downloads'), safeName),
        title: (options.translate ?? englishNativeTranslator)('Save file')
      }
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      try {
        const { canceled, filePath } = parentWindow
          ? await dialog.showSaveDialog(parentWindow, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)

        if (canceled || !filePath) return { saved: false }

        // Resolve managed identities after confirmation so the default export observes the DB head.
        const managedFile = versionedRequest
          ? versionedRequest.versionId
            ? await options.openManagedFileVersion!(versionedRequest.source, {
                projectId: versionedRequest.projectId,
                fileId: versionedRequest.fileId,
                versionId: versionedRequest.versionId
              })
            : await options.openLatestManagedFile!(versionedRequest.source, {
                projectId: versionedRequest.projectId,
                fileId: versionedRequest.fileId
              })
          : pathManagedFile!
        try {
          await publish(filePath, (temporaryPath) => managedFile.copyTo(temporaryPath), {
            ...(managedFile.assertCanCopyTo
              ? { validateDestination: () => managedFile.assertCanCopyTo!(filePath) }
              : {})
          })
          return { saved: true, filePath }
        } finally {
          if (versionedRequest) await managedFile.close()
        }
      } finally {
        await pathManagedFile?.close()
      }
    }
  )

  ipcMainHandle(
    'file:save-session-artifacts',
    async (event, request: SaveSessionArtifactsRequest): Promise<SaveSessionArtifactsResult> => {
      assertSaveSessionArtifactsRequest(request)
      const openManagedFileVersion = options.openManagedFileVersion
      if (!openManagedFileVersion) {
        throw new Error('Managed file Version resolver is not configured.')
      }
      const parentWindow = BrowserWindow.fromWebContents(event.sender)

      if (request.files.length === 1) {
        const [file] = request.files
        const safeName = getSafeFilename(file.suggestedName, file.fileId)
        const dialogOptions = {
          defaultPath: join(app.getPath('downloads'), safeName),
          title: (options.translate ?? englishNativeTranslator)('Save artifact')
        }
        const { canceled, filePath } = parentWindow
          ? await dialog.showSaveDialog(parentWindow, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)

        if (canceled || !filePath) return { saved: false }

        const managedFile = await openManagedFileVersion('artifact', {
          projectId: request.projectId,
          fileId: file.fileId,
          versionId: file.versionId
        })

        try {
          await publish(filePath, (temporaryPath) => managedFile.copyTo(temporaryPath), {
            ...(managedFile.assertCanCopyTo
              ? { validateDestination: () => managedFile.assertCanCopyTo!(filePath) }
              : {})
          })
          return { saved: true, filePaths: [filePath] }
        } finally {
          await managedFile.close()
        }
      }

      const directoryDialogOptions: OpenDialogOptions = {
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
        title: (options.translate ?? englishNativeTranslator)('Choose where to save artifacts')
      }
      const { canceled, filePaths } = parentWindow
        ? await dialog.showOpenDialog(parentWindow, directoryDialogOptions)
        : await dialog.showOpenDialog(directoryDialogOptions)
      const destinationDirectory = filePaths[0]
      if (canceled || !destinationDirectory) return { saved: false }

      const savedPaths: string[] = []
      const failures: NonNullable<
        Extract<SaveSessionArtifactsResult, { saved: true }>['failures']
      > = []
      for (const file of request.files) {
        let managedFile: ManagedFileHandle | undefined
        try {
          managedFile = await openManagedFileVersion('artifact', {
            projectId: request.projectId,
            fileId: file.fileId,
            versionId: file.versionId
          })
          const safeName = getSafeFilename(file.suggestedName, file.fileId)
          savedPaths.push(
            await copyToAvailableDestination(managedFile, destinationDirectory, safeName, publish)
          )
        } catch (error) {
          failures.push({
            ...file,
            message: toErrorMessage(error)
          })
        } finally {
          await managedFile?.close()
        }
      }
      return {
        saved: true,
        filePaths: savedPaths,
        ...(failures.length > 0 ? { failures } : {})
      }
    }
  )

  // Project-wide export packs every Artifact and Upload into one zip, grouped under uploads/ and
  // generated/ by source.
  ipcMainHandle(
    'file:save-project-artifacts',
    async (event, request: SaveProjectArtifactsRequest): Promise<SaveProjectArtifactsResult> => {
      assertSaveProjectArtifactsRequest(request)
      const openManagedFileVersion = options.openManagedFileVersion
      if (!openManagedFileVersion) {
        throw new Error('Managed file Version resolver is not configured.')
      }

      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      const dialogOptions = {
        defaultPath: join(
          app.getPath('downloads'),
          `${getSafeZipBaseName(request.suggestedArchiveName)}-artifacts.zip`
        ),
        title: (options.translate ?? englishNativeTranslator)('Download project artifacts'),
        filters: [
          {
            name: (options.translate ?? englishNativeTranslator)('ZIP archive'),
            extensions: ['zip']
          }
        ]
      }
      const dialogResult = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      const { canceled, filePath } = dialogResult
      if (canceled || !filePath) return { saved: false }

      const failures: SaveProjectArtifactFailure[] = []
      const wroteArchive = await writeProjectArtifactArchive({
        destinationPath: filePath,
        projectId: request.projectId,
        files: request.files,
        openManagedFileVersion,
        publishUserFile: publish,
        failures,
        limits: options.projectArtifactExportLimits ?? PROJECT_ARTIFACT_EXPORT_LIMITS,
        createTemporaryRoot:
          options.createProjectArtifactTemporaryRoot ??
          (() => mkdtemp(join(tmpdir(), 'open-science-project-export-')))
      })
      return {
        saved: true,
        ...(wroteArchive ? { filePath } : {}),
        ...(failures.length > 0 ? { failures } : {})
      }
    }
  )
}

export { registerFileSaveHandlers }
export type { RegisterFileSaveHandlersOptions }
