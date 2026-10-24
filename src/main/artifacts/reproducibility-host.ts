import { readFile } from 'node:fs/promises'
import {
  createReproductionRecipes,
  createWorkflowSlices,
  type ReproductionEvidence
} from '@aipoch/reproducibility'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
import { notebookPromptInputPath } from '../notebook/prompt-input-materialization'
import { resolveStorageKey, storageKey } from './provenance-storage'

// Host storage layout and file IO policy never cross into the package implementation.
export const reproductionEvidence = (storageRoot: string): ReproductionEvidence => ({
  resolveFile: (key) => resolveStorageKey(storageRoot, key),
  readEnvironmentLock: (checksum, signal) =>
    readFile(
      resolveStorageKey(
        storageRoot,
        storageKey('runtime', 'provenance', 'environment-locks', checksum + '.json')
      ),
      { encoding: 'utf8', signal }
    )
})
const fileIO = { copyFile: copyFileWithinBudget, digestFile: digestFileWithinBudget }
export const reproductionRecipes = createReproductionRecipes({
  inputPath: notebookPromptInputPath,
  fileIO
})

export const reproductionWorkflowSlices = createWorkflowSlices({
  inputPath: notebookPromptInputPath,
  fileIO
})
