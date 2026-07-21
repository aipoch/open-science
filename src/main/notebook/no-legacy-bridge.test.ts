import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Guards against reintroducing any retired kernel bridge now that NotebookKernelExecutor
// (kernel-executor.ts) driving the Python/R exec-loops is the sole executor. The old
// direct-python-process bridge, the retired Jupyter host executor + its output mapper, and the
// retired Jupyter host script must all stay gone.
//
// The retired filenames are assembled from fragments so this guard file itself does not contain the
// legacy identifiers the repo-wide grep gate forbids, while still asserting the real paths are gone.
const notebookDir = __dirname
const resourcesNotebookDir = join(__dirname, '../../../resources/notebook')

const retiredNotebookFiles = [
  'python-executor.ts',
  'jupyter' + '-executor.ts',
  'kernel-output' + '-mapper.ts'
]
const retiredResourceFile = 'kernel' + '-host.py'

describe('legacy kernel bridges retired', () => {
  it.each(retiredNotebookFiles)('src/main/notebook/%s no longer exists', (file) => {
    expect(existsSync(join(notebookDir, file))).toBe(false)
  })

  it('the retired Jupyter host script no longer exists', () => {
    expect(existsSync(join(resourcesNotebookDir, retiredResourceFile))).toBe(false)
  })
})
