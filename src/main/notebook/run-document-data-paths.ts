import { pathToFileURL } from 'node:url'

import type { ArtifactFile } from '../../shared/artifacts'
import type {
  NotebookRunDocument,
  NotebookRunRecord,
  NotebookWorkingFile
} from '../../shared/notebook'
import { decodeDataPath, encodeDataPath } from '../storage/data-path'

// Replaces a data-root absolute path with a $DATA sentinel and drops the derived fileUrl.
const encodeArtifact = (artifact: ArtifactFile, dataRoot: string | undefined): ArtifactFile => {
  const encoded: ArtifactFile = {
    ...artifact,
    path: encodeDataPath(artifact.path, dataRoot) as string
  }
  delete (encoded as Partial<ArtifactFile>).fileUrl
  return encoded
}

// Resolves a $DATA sentinel back to an absolute path and recomputes fileUrl from it.
const decodeArtifact = (artifact: ArtifactFile, dataRoot: string | undefined): ArtifactFile => {
  const path = decodeDataPath(artifact.path, dataRoot) as string
  return { ...artifact, path, fileUrl: pathToFileURL(path).href }
}

// Encodes/decodes a single working file's absolute path, leaving the already-relative field alone.
const encodeWorkingFile = (
  file: NotebookWorkingFile,
  dataRoot: string | undefined
): NotebookWorkingFile => ({ ...file, path: encodeDataPath(file.path, dataRoot) as string })

const decodeWorkingFile = (
  file: NotebookWorkingFile,
  dataRoot: string | undefined
): NotebookWorkingFile => ({ ...file, path: decodeDataPath(file.path, dataRoot) as string })

// Encodes/decodes one run record's cwd fields plus its nested working files and artifacts.
const encodeRun = (run: NotebookRunRecord, dataRoot: string | undefined): NotebookRunRecord => ({
  ...run,
  cwdBefore: encodeDataPath(run.cwdBefore, dataRoot),
  cwdAfter: encodeDataPath(run.cwdAfter, dataRoot),
  workingFiles: run.workingFiles.map((file) => encodeWorkingFile(file, dataRoot)),
  artifacts: run.artifacts.map((artifact) => encodeArtifact(artifact, dataRoot))
})

const decodeRun = (run: NotebookRunRecord, dataRoot: string | undefined): NotebookRunRecord => ({
  ...run,
  cwdBefore: decodeDataPath(run.cwdBefore, dataRoot),
  cwdAfter: decodeDataPath(run.cwdAfter, dataRoot),
  workingFiles: run.workingFiles.map((file) => decodeWorkingFile(file, dataRoot)),
  artifacts: run.artifacts.map((artifact) => decodeArtifact(artifact, dataRoot))
})

// Encodes a notebook run.json document's data-root paths (roots, cwds, working files, artifacts)
// as portable "$DATA/..." sentinels without touching any other field. Pure and immutable.
export const encodeRunDocumentDataPaths = (
  doc: NotebookRunDocument,
  dataRoot?: string
): NotebookRunDocument => ({
  ...doc,
  workspaceCwd: encodeDataPath(doc.workspaceCwd, dataRoot) as string,
  notebookSessionRoot: encodeDataPath(doc.notebookSessionRoot, dataRoot) as string,
  dataRoot: encodeDataPath(doc.dataRoot, dataRoot) as string,
  kernel: {
    ...doc.kernel,
    runtimeRoot: encodeDataPath(doc.kernel.runtimeRoot, dataRoot) as string
  },
  runs: doc.runs.map((run) => encodeRun(run, dataRoot))
})

// Resolves a decoded document's "$DATA/..." sentinels against the current data root.
export const decodeRunDocumentDataPaths = (
  doc: NotebookRunDocument,
  dataRoot?: string
): NotebookRunDocument => ({
  ...doc,
  workspaceCwd: decodeDataPath(doc.workspaceCwd, dataRoot) as string,
  notebookSessionRoot: decodeDataPath(doc.notebookSessionRoot, dataRoot) as string,
  dataRoot: decodeDataPath(doc.dataRoot, dataRoot) as string,
  kernel: {
    ...doc.kernel,
    runtimeRoot: decodeDataPath(doc.kernel.runtimeRoot, dataRoot) as string
  },
  runs: doc.runs.map((run) => decodeRun(run, dataRoot))
})
