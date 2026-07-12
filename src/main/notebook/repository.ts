import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  NotebookRunDocument,
  NotebookRunRecord,
  NotebookWorkingFile
} from '../../shared/notebook'
import { NOTEBOOK_RUN_FILE, NOTEBOOKS_DIR } from '../../shared/notebook'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type LoadNotebookRunDocumentRequest = {
  projectName: string
  sessionId: string
  workspaceCwd: string
  artifactSessionId?: string
  pythonPath?: string
  kernelName?: string
}

type AppendNotebookRunRequest = {
  projectName: string
  sessionId: string
  run: NotebookRunRecord
}

type UpdateNotebookRunRequest = AppendNotebookRunRequest

type NormalizeNotebookRunDocumentRequest = Omit<LoadNotebookRunDocumentRequest, 'workspaceCwd'> & {
  workspaceCwd?: string
}

// Rejects path traversal and empty segments before composing notebook storage paths.
const assertSafeNotebookPathSegment = (segment: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`Invalid notebook path segment: ${segment}`)
  }

  return segment
}

// Detects the expected "run.json does not exist yet" case without hiding real IO failures.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

// Returns the shared runtime installation root used by notebook system instructions.
const getRuntimeRoot = (storageRoot: string): string => join(storageRoot, 'runtime')

// Builds the durable workspace root for a single notebook session.
const getNotebookSessionRoot = (
  storageRoot: string,
  projectName: string,
  sessionId: string
): string =>
  join(
    storageRoot,
    NOTEBOOKS_DIR,
    assertSafeNotebookPathSegment(projectName),
    assertSafeNotebookPathSegment(sessionId)
  )

// Resolves the persisted run history path for a notebook session.
const getNotebookRunJsonPath = (
  storageRoot: string,
  projectName: string,
  sessionId: string
): string => join(getNotebookSessionRoot(storageRoot, projectName, sessionId), NOTEBOOK_RUN_FILE)

// Resolves the notebook-owned data directory used for raw and processed files.
const getNotebookDataRoot = (storageRoot: string, projectName: string, sessionId: string): string =>
  join(getNotebookSessionRoot(storageRoot, projectName, sessionId), 'data')

// Creates the empty text projection used before an execution has produced output.
const emptyText = (): NotebookRunRecord['text'] => ({
  stdout: '',
  stderr: '',
  traceback: '',
  plain: []
})

// Normalizes generated working files and guarantees they remain inside the notebook workspace.
const normalizeWorkingFiles = (
  sessionRoot: string,
  runId: string,
  workingFiles: NotebookWorkingFile[] | undefined
): NotebookWorkingFile[] =>
  (workingFiles ?? []).map((file) => {
    const absolutePath = resolve(file.path)
    const root = resolve(sessionRoot)
    const relativePath = relative(root, absolutePath)

    if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error('Notebook working file is outside notebook session workspace.')
    }
    if (isAbsolute(relativePath)) {
      throw new Error('Notebook working file is outside notebook session workspace.')
    }

    return {
      ...file,
      path: absolutePath,
      relativePath: file.relativePath || relativePath,
      createdByRunId: file.createdByRunId ?? runId
    }
  })

// Fills optional run fields so old or partial records always have the current shape.
const normalizeRun = (sessionRoot: string, run: NotebookRunRecord): NotebookRunRecord => ({
  ...run,
  text: run.text ?? emptyText(),
  outputs: run.outputs ?? [],
  artifacts: run.artifacts ?? [],
  workingFiles: normalizeWorkingFiles(sessionRoot, run.runId, run.workingFiles)
})

// Repairs or initializes a run document with canonical paths and kernel metadata.
const normalizeDocument = (
  storageRoot: string,
  request: NormalizeNotebookRunDocumentRequest,
  document: NotebookRunDocument
): NotebookRunDocument => {
  const projectName = assertSafeNotebookPathSegment(request.projectName)
  const sessionId = assertSafeNotebookPathSegment(request.sessionId)

  return {
    ...document,
    version: 1,
    projectName,
    sessionId,
    artifactSessionId: request.artifactSessionId ?? document.artifactSessionId,
    workspaceCwd: request.workspaceCwd ?? document.workspaceCwd,
    notebookSessionRoot: getNotebookSessionRoot(storageRoot, projectName, sessionId),
    dataRoot: getNotebookDataRoot(storageRoot, projectName, sessionId),
    kernel: {
      ...document.kernel,
      language: 'python',
      pythonPath: request.pythonPath ?? document.kernel?.pythonPath,
      kernelName: request.kernelName ?? document.kernel?.kernelName ?? 'python3',
      runtimeRoot: getRuntimeRoot(storageRoot),
      lastKnownStatus: document.kernel?.lastKnownStatus ?? 'idle'
    },
    runs: document.runs ?? [],
    updatedAt: document.updatedAt ?? Date.now()
  }
}

// Owns durable run.json persistence for one app storage root.
class NotebookRunRepository {
  private saveQueue: Promise<void> = Promise.resolve()
  private saveSequence = 0

  constructor(private readonly storageRoot: string) {}

  // Loads an existing history file or creates the directory skeleton and first run.json.
  async loadOrCreate(request: LoadNotebookRunDocumentRequest): Promise<NotebookRunDocument> {
    const projectName = assertSafeNotebookPathSegment(request.projectName)
    const sessionId = assertSafeNotebookPathSegment(request.sessionId)
    const filePath = getNotebookRunJsonPath(this.storageRoot, projectName, sessionId)

    try {
      const rawDocument = await readFile(filePath, 'utf8')
      const document = JSON.parse(rawDocument) as NotebookRunDocument

      return normalizeDocument(this.storageRoot, request, document)
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }

      const document = normalizeDocument(this.storageRoot, request, {
        version: 1,
        projectName,
        sessionId,
        workspaceCwd: request.workspaceCwd,
        notebookSessionRoot: '',
        dataRoot: '',
        kernel: {
          language: 'python',
          pythonPath: request.pythonPath,
          kernelName: request.kernelName ?? 'python3',
          runtimeRoot: '',
          lastKnownStatus: 'idle'
        },
        runs: [],
        updatedAt: Date.now()
      })

      await this.writeDocument(document)

      return document
    }
  }

  // Appends a new execution record, including "running" records created before execution starts.
  async appendRun(request: AppendNotebookRunRequest): Promise<NotebookRunDocument> {
    const document = await this.loadExisting(request.projectName, request.sessionId)
    const nextDocument = {
      ...document,
      runs: [...document.runs, normalizeRun(document.notebookSessionRoot, request.run)],
      updatedAt: Date.now()
    }

    await this.writeDocument(nextDocument)

    return nextDocument
  }

  // Replaces an existing execution record, used to turn the initial "running" entry final.
  async updateRun(request: UpdateNotebookRunRequest): Promise<NotebookRunDocument> {
    const document = await this.loadExisting(request.projectName, request.sessionId)
    const runIndex = document.runs.findIndex((run) => run.runId === request.run.runId)

    if (runIndex === -1) {
      throw new Error(`Notebook run not found: ${request.run.runId}`)
    }

    const runs = [...document.runs]

    runs[runIndex] = normalizeRun(document.notebookSessionRoot, request.run)

    const nextDocument = {
      ...document,
      runs,
      updatedAt: Date.now()
    }

    await this.writeDocument(nextDocument)

    return nextDocument
  }

  // Reads an existing history document without creating one, returning null when none exists yet.
  // Used to detect notebooks that predate the current app launch so the UI can rehydrate entries.
  async findExisting(projectName: string, sessionId: string): Promise<NotebookRunDocument | null> {
    try {
      return await this.loadExisting(projectName, sessionId)
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }

      throw error
    }
  }

  // Loads a history document that must already exist for mutating operations.
  private async loadExisting(projectName: string, sessionId: string): Promise<NotebookRunDocument> {
    const safeProjectName = assertSafeNotebookPathSegment(projectName)
    const safeSessionId = assertSafeNotebookPathSegment(sessionId)
    const filePath = getNotebookRunJsonPath(this.storageRoot, safeProjectName, safeSessionId)
    const rawDocument = await readFile(filePath, 'utf8')
    const document = JSON.parse(rawDocument) as NotebookRunDocument

    return normalizeDocument(
      this.storageRoot,
      {
        projectName: safeProjectName,
        sessionId: safeSessionId
      },
      document
    )
  }

  // Serializes writes and atomically renames a temporary file into run.json.
  private async writeDocument(document: NotebookRunDocument): Promise<void> {
    const writeOperation = this.saveQueue.then(async () => {
      const directory = document.notebookSessionRoot
      const filePath = join(directory, NOTEBOOK_RUN_FILE)

      this.saveSequence += 1
      // Ensure the full notebook workspace exists before exposing run.json to readers.
      await mkdir(join(directory, 'data', 'raw'), { recursive: true })
      await mkdir(join(directory, 'data', 'processed'), { recursive: true })
      await mkdir(join(directory, 'work'), { recursive: true })
      await mkdir(join(directory, 'cache'), { recursive: true })
      await mkdir(join(directory, 'scripts'), { recursive: true })

      const temporaryPath = `${filePath}.${Date.now()}-${this.saveSequence}.tmp`

      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, filePath)
    })

    // Keep later saves moving even if the previous write failed and surfaced to its caller.
    this.saveQueue = writeOperation.then(
      () => undefined,
      () => undefined
    )
    await writeOperation
  }
}

export { NotebookRunRepository, getNotebookRunJsonPath, getNotebookSessionRoot, getRuntimeRoot }
export type { AppendNotebookRunRequest, LoadNotebookRunDocumentRequest, UpdateNotebookRunRequest }
