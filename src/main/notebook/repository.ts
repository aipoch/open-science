import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  NotebookKernelMetadata,
  NotebookRunDocument,
  NotebookRunRecord,
  NotebookWorkingFile
} from '../../shared/notebook'
import { NOTEBOOK_RUN_FILE, NOTEBOOKS_DIR } from '../../shared/notebook'
import { decodeRunDocumentDataPaths, encodeRunDocumentDataPaths } from './run-document-data-paths'

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

type UpdateKernelStatusRequest = {
  projectName: string
  sessionId: string
  status: NotebookKernelMetadata['lastKnownStatus']
}

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

// Fills optional run fields so old or partial records always have the current shape. Legacy
// records predate kernelKind and were always python/r, so default (never overwrite) to 'python'.
const normalizeRun = (sessionRoot: string, run: NotebookRunRecord): NotebookRunRecord => ({
  ...run,
  kernelKind: run.kernelKind ?? 'python',
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
  const notebookSessionRoot = getNotebookSessionRoot(storageRoot, projectName, sessionId)

  return {
    ...document,
    version: 1,
    projectName,
    sessionId,
    artifactSessionId: request.artifactSessionId ?? document.artifactSessionId,
    workspaceCwd: request.workspaceCwd ?? document.workspaceCwd,
    notebookSessionRoot,
    dataRoot: getNotebookDataRoot(storageRoot, projectName, sessionId),
    kernel: {
      ...document.kernel,
      language: 'python',
      pythonPath: request.pythonPath ?? document.kernel?.pythonPath,
      kernelName: request.kernelName ?? document.kernel?.kernelName ?? 'python3',
      runtimeRoot: getRuntimeRoot(storageRoot),
      lastKnownStatus: document.kernel?.lastKnownStatus ?? 'idle'
    },
    runs: (document.runs ?? []).map((run) => normalizeRun(notebookSessionRoot, run)),
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
      // Decode $DATA sentinels against the current data root before recomputing session roots,
      // so a relocated data root and the decoded working-file paths agree.
      const decoded = decodeRunDocumentDataPaths(document, this.storageRoot)

      return normalizeDocument(this.storageRoot, request, decoded)
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
    return this.mutate(request.projectName, request.sessionId, (document) => ({
      ...document,
      runs: [...document.runs, normalizeRun(document.notebookSessionRoot, request.run)],
      updatedAt: Date.now()
    }))
  }

  // Replaces an existing execution record, used to turn the initial "running" entry final.
  async updateRun(request: UpdateNotebookRunRequest): Promise<NotebookRunDocument> {
    return this.mutate(request.projectName, request.sessionId, (document) => {
      const runIndex = document.runs.findIndex((run) => run.runId === request.run.runId)

      if (runIndex === -1) {
        throw new Error(`Notebook run not found: ${request.run.runId}`)
      }

      const runs = [...document.runs]

      runs[runIndex] = normalizeRun(document.notebookSessionRoot, request.run)

      return { ...document, runs, updatedAt: Date.now() }
    })
  }

  // Persists the kernel's last-known lifecycle status (e.g. 'restarting' while restart() is in
  // flight, 'terminated' once an idle proc is dropped), read back by state()/getSessionReference().
  async updateKernelStatus(request: UpdateKernelStatusRequest): Promise<NotebookRunDocument> {
    return this.mutate(request.projectName, request.sessionId, (document) => ({
      ...document,
      kernel: { ...document.kernel, lastKnownStatus: request.status },
      updatedAt: Date.now()
    }))
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
    // Decode before normalization for the same reason as loadOrCreate above.
    const decoded = decodeRunDocumentDataPaths(document, this.storageRoot)

    return normalizeDocument(
      this.storageRoot,
      {
        projectName: safeProjectName,
        sessionId: safeSessionId
      },
      decoded
    )
  }

  // Reads the current document, applies `transform`, and writes back the result -- the read and write
  // happen inside the same queued turn (not just the write, as writeDocument alone would give), so
  // overlapping callers touching the same session's run.json (e.g. two overlapping bash_execute calls,
  // which have no session-level lock of their own) can never race a stale read against another
  // writer's in-flight update.
  private async mutate(
    projectName: string,
    sessionId: string,
    transform: (document: NotebookRunDocument) => NotebookRunDocument
  ): Promise<NotebookRunDocument> {
    const operation = this.saveQueue.then(async () => {
      const document = await this.loadExisting(projectName, sessionId)
      const nextDocument = transform(document)

      await this.persist(nextDocument)

      return nextDocument
    })

    // Keep later saves moving even if this turn failed (bad transform or a write failure) and
    // surfaced to its caller.
    this.saveQueue = operation.then(
      () => undefined,
      () => undefined
    )

    return operation
  }

  // Queues an unconditional write, used by loadOrCreate's ENOENT branch where there is nothing to
  // read-modify (the file doesn't exist yet, so there is no stale-read race to guard against).
  private async writeDocument(document: NotebookRunDocument): Promise<void> {
    const operation = this.saveQueue.then(() => this.persist(document))

    this.saveQueue = operation.then(
      () => undefined,
      () => undefined
    )
    await operation
  }

  // Writes one document to disk via a temp file + atomic rename. Always invoked from inside the
  // saveQueue chain (mutate() or writeDocument() above), never called directly.
  private async persist(document: NotebookRunDocument): Promise<void> {
    const directory = document.notebookSessionRoot
    const filePath = join(directory, NOTEBOOK_RUN_FILE)

    this.saveSequence += 1
    // Ensure the full notebook workspace exists before exposing run.json to readers.
    await mkdir(join(directory, 'data', 'raw'), { recursive: true })
    await mkdir(join(directory, 'data', 'processed'), { recursive: true })
    await mkdir(join(directory, 'work'), { recursive: true })
    await mkdir(join(directory, 'cache'), { recursive: true })
    await mkdir(join(directory, 'scripts'), { recursive: true })
    // Cross-kernel handoff channel: the REPL fetches external data here and hands files to
    // python/r via disk; 'outputs' collects results kernels want to surface back out.
    await mkdir(join(directory, 'handoff'), { recursive: true })
    await mkdir(join(directory, 'outputs'), { recursive: true })

    const temporaryPath = `${filePath}.${Date.now()}-${this.saveSequence}.tmp`

    // Encode only the serialized copy: `directory` above must stay derived from the absolute in-memory
    // `document.notebookSessionRoot`, never from the $DATA-sentinel-encoded copy, so run.json stores
    // portable "$DATA/..." paths that survive a data-root relocation.
    const encoded = encodeRunDocumentDataPaths(document, this.storageRoot)
    await writeFile(temporaryPath, `${JSON.stringify(encoded, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, filePath)
  }
}

export { NotebookRunRepository, getNotebookRunJsonPath, getNotebookSessionRoot, getRuntimeRoot }
export type {
  AppendNotebookRunRequest,
  LoadNotebookRunDocumentRequest,
  UpdateKernelStatusRequest,
  UpdateNotebookRunRequest
}
