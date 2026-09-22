import { createHash } from 'node:crypto'
import { constants, mkdirSync, lstatSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createLogger, errorLogFields } from '../logger'

const log = createLogger('notebook:output-storage')

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

// Loop-managed stderr is already in the sidecar. Append only the separate process pipe captured
// by the host (R messages, native-library diagnostics, and sandbox annotations).
export const appendNotebookProcessStderr = async (
  notebookRoot: string,
  runId: string,
  stderr: string,
  truncated: boolean
): Promise<boolean> => {
  if (!stderr && !truncated) return true
  const outputPath = join(notebookOutputDirectory(notebookRoot), notebookOutputRequestId(runId))
  const invalidateReceipt = async (): Promise<void> => {
    await unlink(outputPath + '.complete').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  let directoryVerified = false
  try {
    ensureNotebookOutputDirectory(notebookRoot)
    directoryVerified = true
    const descriptor = await open(
      outputPath + '.txt',
      constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      if (!(await descriptor.stat()).isFile())
        throw new Error('Notebook output is not a regular file.')
      if (stderr) await descriptor.writeFile('\n[process stderr]\n' + stderr, 'utf8')
      await descriptor.sync()
    } finally {
      await descriptor.close()
    }
    if (truncated) await invalidateReceipt()
    return true
  } catch (error) {
    // Capturing diagnostics must never turn a completed, side-effectful execution into a failure.
    // Preserve the full stdout file and the stderr already recorded in run.json/the Notebook UI.
    if (directoryVerified) await invalidateReceipt().catch(() => undefined)
    log.warn('Could not append Notebook process stderr to saved output.', errorLogFields(error))
    return false
  }
}
