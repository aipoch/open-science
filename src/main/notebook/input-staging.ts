import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const NOTEBOOK_INPUTS_DIR = 'notebook-inputs'
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const STAGED_VERSION_KEY_PATTERN = /^[a-f0-9]{64}$/

const safeSegment = (value: string, label: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid Notebook input ${label}: ${value}`)
  }
  return value
}

const notebookInputProjectRoot = (storageRoot: string, projectId: string): string =>
  join(storageRoot, NOTEBOOK_INPUTS_DIR, safeSegment(projectId, 'Project id'))

const getNotebookInputRoot = (storageRoot: string, projectId: string, sessionId: string): string =>
  join(notebookInputProjectRoot(storageRoot, projectId), safeSegment(sessionId, 'Session id'))

const ensureNotebookInputRoot = async (
  storageRoot: string,
  projectId: string,
  sessionId: string
): Promise<void> => {
  await mkdir(getNotebookInputRoot(storageRoot, projectId, sessionId), { recursive: true })
}

const deleteNotebookSessionInputs = (
  storageRoot: string,
  projectId: string,
  sessionId: string
): Promise<void> =>
  rm(getNotebookInputRoot(storageRoot, projectId, sessionId), { recursive: true, force: true })

const deleteNotebookProjectInputs = (storageRoot: string, projectId: string): Promise<void> =>
  rm(notebookInputProjectRoot(storageRoot, projectId), { recursive: true, force: true })

const resolveNotebookStagedInputPath = async (
  storageRoot: string,
  projectId: string,
  sessionId: string,
  candidatePath: string
): Promise<string | undefined> => {
  if (!isAbsolute(candidatePath)) return undefined
  const inputRoot = resolve(getNotebookInputRoot(storageRoot, projectId, sessionId))
  const candidate = resolve(candidatePath)
  const lexicalRelative = relative(inputRoot, candidate)
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) return undefined
  const segments = lexicalRelative.split(sep)
  if (
    segments.length !== 3 ||
    !['artifact-version', 'upload-version'].includes(segments[0]!) ||
    !STAGED_VERSION_KEY_PATTERN.test(segments[1]!) ||
    segments[2] !== 'content'
  ) {
    throw new Error('Compute input is not an exact staged Notebook input file.')
  }

  const [resolvedRoot, resolvedCandidate] = await Promise.all([
    realpath(inputRoot),
    realpath(candidate)
  ])
  const resolvedRelative = relative(resolvedRoot, resolvedCandidate)
  if (resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) {
    throw new Error('Compute input escapes the current Notebook Session input root.')
  }
  if (!(await stat(resolvedCandidate)).isFile()) {
    throw new Error('Compute input is not a staged Notebook input file.')
  }
  return resolvedCandidate
}

export {
  deleteNotebookProjectInputs,
  deleteNotebookSessionInputs,
  ensureNotebookInputRoot,
  getNotebookInputRoot,
  resolveNotebookStagedInputPath
}
