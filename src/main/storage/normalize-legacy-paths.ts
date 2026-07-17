import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { NotebookRunDocument } from '../../shared/notebook'
import { NOTEBOOKS_DIR, NOTEBOOK_RUN_FILE } from '../../shared/notebook'
import { encodeRunDocumentDataPaths } from '../notebook/run-document-data-paths'
import type { PreviewStateRepository } from '../projects/preview-repository'
import type { ProjectRepository } from '../projects/repository'
import type { SessionRepository } from '../session-persistence/repository'

type NormalizeDeps = {
  sessionRepository: SessionRepository
  previewStateRepository: PreviewStateRepository
  projectRepository: ProjectRepository
  // Used only for the direct notebook run.json walk below.
  dataRoot: string
}

// Distinguishes an expected missing file/dir from a real IO failure.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

// Re-persists every session: the read decodes a legacy absolute path as a passthrough (see
// decodeDataPath), and the write encodes it to $DATA — converting it in place.
const normalizeSessions = async (sessionRepository: SessionRepository): Promise<void> => {
  const { sessions } = await sessionRepository.loadAll()

  for (const session of sessions) {
    await sessionRepository.saveSession(session)
  }
}

// Re-persists each project's preview state for the same read-decode/write-encode reason.
const normalizePreviewStates = async (
  projectRepository: ProjectRepository,
  previewStateRepository: PreviewStateRepository
): Promise<void> => {
  const projects = await projectRepository.list()

  for (const project of projects) {
    const state = await previewStateRepository.get(project.id)

    if (state) await previewStateRepository.save(project.id, state)
  }
}

// Lists subdirectory names, tolerating a missing parent (e.g. a fresh install with no notebooks/).
const listDirNames = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })

    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (isMissingFileError(error)) return []

    throw error
  }
}

// Walks notebooks/<projectName>/<sessionId>/run.json two levels deep and encodes each document's
// data-root paths in place with an atomic temp+rename write. A session directory without a run.json
// yet is skipped; any other read/write failure propagates so the caller can retry next launch.
const normalizeNotebookRunFiles = async (dataRoot: string): Promise<void> => {
  const notebooksDir = join(dataRoot, NOTEBOOKS_DIR)
  const projectNames = await listDirNames(notebooksDir)

  for (const projectName of projectNames) {
    const projectDir = join(notebooksDir, projectName)
    const sessionIds = await listDirNames(projectDir)

    for (const sessionId of sessionIds) {
      const filePath = join(projectDir, sessionId, NOTEBOOK_RUN_FILE)
      let raw: string

      try {
        raw = await readFile(filePath, 'utf8')
      } catch (error) {
        if (isMissingFileError(error)) continue

        throw error
      }

      const document = JSON.parse(raw) as NotebookRunDocument
      const encoded = encodeRunDocumentDataPaths(document, dataRoot)
      const temporaryPath = `${filePath}.normalize.tmp`

      await writeFile(temporaryPath, `${JSON.stringify(encoded, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, filePath)
    }
  }
}

// One-time pass that converts every legacy absolute data-root path already on disk into the portable
// "$DATA/..." sentinel, by re-persisting each store through its existing (sentinel-aware) write path
// plus a direct walk for notebook run.json files. Idempotent: re-encoding an already-$DATA value is a
// no-op (see data-path.ts / normalize-legacy-paths.test.ts). Errors are NOT caught here — the caller
// wraps this call and only sets the "done" marker on success, so a failure simply retries next launch.
export const normalizeLegacyDataPaths = async (deps: NormalizeDeps): Promise<void> => {
  await normalizeSessions(deps.sessionRepository)
  await normalizePreviewStates(deps.projectRepository, deps.previewStateRepository)
  await normalizeNotebookRunFiles(deps.dataRoot)
}
