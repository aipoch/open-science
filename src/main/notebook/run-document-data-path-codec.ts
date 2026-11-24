import { pathToFileURL } from 'node:url'
import { isAbsolute, resolve } from 'node:path'

import type { ArtifactFile } from '../../shared/artifacts'
import type {
  NotebookRunDocument,
  NotebookRunRecord,
  NotebookWorkingFile
} from '../../shared/notebook'
import { decodeDataPath, encodeDataPath } from '../storage/data-path-codec'

const PROJECT_PREFIX = '$PROJECT/'

// Project paths have their own root, independently of app-managed $DATA paths. Only declared path
// fields pass through this codec: user code, output text and relative output names remain verbatim.
const encodePath = (
  path: string | undefined,
  dataRoot: string,
  projectRoot?: string
): string | undefined => {
  if (!path || !projectRoot || path.startsWith('$DATA/')) return encodeDataPath(path, dataRoot)
  if (path.startsWith(PROJECT_PREFIX)) {
    return encodeDataPath(`$DATA/${path.slice(PROJECT_PREFIX.length)}`, projectRoot)?.replace(
      '$DATA/',
      PROJECT_PREFIX
    )
  }
  if (!isAbsolute(path)) return path
  if (resolve(path) === resolve(projectRoot)) return PROJECT_PREFIX
  const encoded = encodeDataPath(path, projectRoot)
  return encoded?.startsWith('$DATA/')
    ? `${PROJECT_PREFIX}${encoded.slice('$DATA/'.length)}`
    : encodeDataPath(path, dataRoot)
}

const decodePath = (
  path: string | undefined,
  dataRoot: string,
  projectRoot?: string
): string | undefined => {
  if (path?.startsWith(PROJECT_PREFIX)) {
    if (!projectRoot)
      throw new Error('Notebook project record path has no registered project root.')
    return decodeDataPath(`$DATA/${path.slice(PROJECT_PREFIX.length)}`, projectRoot)
  }
  return decodeDataPath(path, dataRoot)
}

// Persisted documents are versionless historical input: once the canonical field exists it wins,
// while legacy documents fall back to the old alias.
const persistedProjectId = (scope: { projectId?: string; projectName?: string }): string => {
  const projectId = scope.projectId ?? scope.projectName
  if (!projectId) throw new Error('A persisted projectId is required.')
  return projectId
}

// Replaces a data-root absolute path with a $DATA sentinel and drops the derived fileUrl.
const encodeArtifact = (
  artifact: ArtifactFile,
  dataRoot: string,
  projectRoot?: string
): ArtifactFile => {
  const projectId = persistedProjectId(artifact)
  const current = { ...artifact } as ArtifactFile & {
    projectName?: string
  }
  delete current.projectName
  delete (current as { fileUrl?: string }).fileUrl
  return {
    ...current,
    projectId,
    path: encodePath(artifact.path, dataRoot, projectRoot) as string
  } as ArtifactFile
}

// Resolves a $DATA sentinel back to an absolute path and recomputes fileUrl from it.
const decodeArtifact = (
  artifact: ArtifactFile,
  dataRoot: string,
  projectRoot?: string
): ArtifactFile => {
  const path = decodePath(artifact.path, dataRoot, projectRoot) as string
  const projectId = persistedProjectId(artifact)
  const current = { ...artifact } as ArtifactFile & {
    projectName?: string
  }
  delete current.projectName
  delete (current as { fileUrl?: string }).fileUrl
  return { ...current, projectId, path, fileUrl: pathToFileURL(path).href }
}

// Encodes/decodes a single working file's absolute path, leaving the already-relative field alone.
const encodeWorkingFile = (
  file: NotebookWorkingFile,
  dataRoot: string,
  projectRoot?: string
): NotebookWorkingFile => ({
  ...file,
  path: encodePath(file.path, dataRoot, projectRoot) as string
})

const decodeWorkingFile = (
  file: NotebookWorkingFile,
  dataRoot: string,
  projectRoot?: string
): NotebookWorkingFile => ({
  ...file,
  path: decodePath(file.path, dataRoot, projectRoot) as string
})

const shellContextPaths = (
  context: NonNullable<NotebookRunRecord['frozenShellContext']>,
  transform: (path: string) => string
): NonNullable<NotebookRunRecord['frozenShellContext']> => ({
  ...context,
  cwd: transform(context.cwd),
  handoffDir: transform(context.handoffDir),
  runtimeRoot: transform(context.runtimeRoot),
  notebookSessionRoot: transform(context.notebookSessionRoot),
  inputRoot: transform(context.inputRoot),
  protectedDirs: context.protectedDirs.map(transform),
  environment: {
    ...context.environment,
    ...(context.environment.OPEN_SCIENCE_NOTEBOOK_OUTPUT_DIR
      ? {
          OPEN_SCIENCE_NOTEBOOK_OUTPUT_DIR: transform(
            context.environment.OPEN_SCIENCE_NOTEBOOK_OUTPUT_DIR
          )
        }
      : {})
  }
})

// Encodes/decodes one run record's cwd fields plus working files and historical artifacts.
export const encodeNotebookRunDataPaths = (
  run: NotebookRunRecord,
  dataRoot: string,
  projectRoot?: string
): NotebookRunRecord => ({
  ...run,
  ...(run.frozenShellContext
    ? {
        frozenShellContext: shellContextPaths(
          run.frozenShellContext,
          (path) => encodePath(path, dataRoot, projectRoot) as string
        )
      }
    : {}),
  cwdBefore: encodePath(run.cwdBefore, dataRoot, projectRoot),
  cwdAfter: encodePath(run.cwdAfter, dataRoot, projectRoot),
  workingFiles: run.workingFiles.map((file) => encodeWorkingFile(file, dataRoot, projectRoot)),
  ...(run.artifacts
    ? {
        artifacts: run.artifacts.map((artifact) => encodeArtifact(artifact, dataRoot, projectRoot))
      }
    : {})
})

const decodeRun = (
  run: NotebookRunRecord,
  dataRoot: string,
  projectRoot?: string
): NotebookRunRecord => ({
  ...run,
  ...(run.frozenShellContext
    ? {
        frozenShellContext: shellContextPaths(
          run.frozenShellContext,
          (path) => decodePath(path, dataRoot, projectRoot) as string
        )
      }
    : {}),
  cwdBefore: decodePath(run.cwdBefore, dataRoot, projectRoot),
  cwdAfter: decodePath(run.cwdAfter, dataRoot, projectRoot),
  workingFiles: (run.workingFiles ?? []).map((file) =>
    decodeWorkingFile(file, dataRoot, projectRoot)
  ),
  ...(run.artifacts
    ? {
        artifacts: run.artifacts.map((artifact) => decodeArtifact(artifact, dataRoot, projectRoot))
      }
    : {})
})

// Encodes a notebook run.json document's data-root paths (roots, cwds, working files, artifacts)
// as portable "$DATA/..." sentinels without touching any other field. Pure and immutable.
export const encodeRunDocumentDataPaths = (
  doc: NotebookRunDocument,
  dataRoot: string,
  projectRoot?: string
): NotebookRunDocument => {
  const projectId = persistedProjectId(doc)
  const current = { ...doc } as NotebookRunDocument & {
    projectName?: string
  }
  delete current.projectName
  return {
    ...current,
    projectId,
    workspaceCwd: encodePath(doc.workspaceCwd, dataRoot, projectRoot) as string,
    notebookSessionRoot: encodePath(doc.notebookSessionRoot, dataRoot, projectRoot) as string,
    dataRoot: encodePath(doc.dataRoot, dataRoot, projectRoot) as string,
    kernel: {
      ...doc.kernel,
      runtimeRoot: encodePath(doc.kernel.runtimeRoot, dataRoot, projectRoot) as string
    },
    runs: doc.runs.map((run) => encodeNotebookRunDataPaths(run, dataRoot, projectRoot))
  }
}

// Resolves a decoded document's "$DATA/..." sentinels against the current data root.
export const decodeRunDocumentDataPaths = (
  doc: NotebookRunDocument,
  dataRoot: string,
  projectRoot?: string
): NotebookRunDocument => {
  const projectId = persistedProjectId(doc)
  const current = { ...doc } as NotebookRunDocument & {
    projectName?: string
  }
  delete current.projectName
  return {
    ...current,
    projectId,
    workspaceCwd: decodePath(doc.workspaceCwd, dataRoot, projectRoot) as string,
    notebookSessionRoot: decodePath(doc.notebookSessionRoot, dataRoot, projectRoot) as string,
    dataRoot: decodePath(doc.dataRoot, dataRoot, projectRoot) as string,
    kernel: {
      ...doc.kernel,
      runtimeRoot: decodePath(doc.kernel.runtimeRoot, dataRoot, projectRoot) as string
    },
    runs: doc.runs.map((run) => decodeRun(run, dataRoot, projectRoot))
  }
}
