import { createHash } from 'node:crypto'
import { mkdirSync, lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const notebookOutputRequestId = (runId: string): string =>
  `output-${createHash('sha256').update(runId).digest('hex')}`

export const notebookOutputDirectory = (notebookRoot: string): string => {
  // All Frame lanes belong to the same Session and its recursive package lifecycle.
  const root =
    basename(dirname(notebookRoot)) === 'frames' ? dirname(dirname(notebookRoot)) : notebookRoot
  return join(root, 'outputs')
}

export const ensureNotebookOutputDirectory = (notebookRoot: string): string => {
  const directory = notebookOutputDirectory(notebookRoot)
  mkdirSync(directory, { recursive: true })
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error('Notebook output storage must be a regular Session directory.')
  }
  return directory
}
