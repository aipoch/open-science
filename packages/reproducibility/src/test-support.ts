import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { createReproductionRecipes, createReproductionExecutor } from './index'
import type { ReproductionEvidence, ReproductionFileIO } from './ports'
// Tests supply their own storage and IO capabilities; they never import host code.
export const reproductionEvidence = (root: string): ReproductionEvidence => ({
  resolveFile: (key) => join(root, ...key.split('/')),
  readEnvironmentLock: (checksum, signal) =>
    readFile(join(root, 'runtime/provenance/environment-locks', checksum + '.json'), {
      encoding: 'utf8',
      signal
    })
})
const digest = (bytes: Buffer): { sizeBytes: number; checksum: string } => ({
  sizeBytes: bytes.length,
  checksum: createHash('sha256').update(bytes).digest('hex')
})
export const fileIO: ReproductionFileIO = {
  digestFile: async (path, max, signal) => {
    const bytes = await readFile(path, { signal })
    if (bytes.length > max) throw Error('File budget exceeded')
    return digest(bytes)
  },
  copyFile: async (source, destination, max, signal) => {
    const bytes = await readFile(source, { signal })
    if (bytes.length > max) throw Error('File budget exceeded')
    await writeFile(destination, bytes, { flag: 'wx', signal })
    return digest(bytes)
  }
}
// Captured input naming is supplied by the host. These fixtures use simple ASCII filenames.
export const reproductionRecipes = createReproductionRecipes({
  fileIO,
  inputPath: (filename, checksum) => {
    const extension = extname(filename)
    return 'inputs/' + basename(filename, extension) + '-' + checksum.slice(0, 12) + extension
  }
})
export const executeArtifactReproducibility = createReproductionExecutor({
  fileIO,
  recipes: reproductionRecipes
})

export type PersistedArtifactExecutionSnapshot = import('./evidence').ReproductionSnapshot & {
  schemaVersion: 2
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  terminalPromptMessageId: string
  producerRunId: string
  producerRunIndex: number
  createdAt: string
}
