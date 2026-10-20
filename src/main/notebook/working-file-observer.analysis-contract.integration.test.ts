import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { startWorkingFileObservation } from './working-file-observer'

// These cases cover host namespace/capture boundaries. Language and plotting variants
// belong to notebook-analysis, whose native tests compare predictions with real execution.
it.each(['python', 'r'] as const)(
  'captures %s analysis paths in the host evidence namespace',
  async (language) => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-capture-contract-'))
    const notebookSessionRoot = join(root, 'notebook')
    const dataRoot = join(notebookSessionRoot, 'data')
    const code =
      language === 'python'
        ? 'text = open("inputs/source.csv").read()\nopen("copy.csv", "w").write(text)\nopen("summary.csv", "w").write("summary")'
        : 'text <- readLines("inputs/source.csv")\nwriteLines(text, "copy.csv")\nwriteLines("summary", "summary.csv")'
    try {
      await mkdir(join(dataRoot, 'inputs'), { recursive: true })
      await writeFile(join(dataRoot, 'inputs/source.csv'), 'group\nCtrl\nIRI\n')
      await writeFile(join(dataRoot, 'copy.csv'), 'previous output')
      const observation = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot,
        cwd: dataRoot,
        code,
        language,
        runId: 'run'
      })
      // Execution is outside this contract: exercise actual observation and evidence writes.
      await writeFile(join(dataRoot, 'copy.csv'), 'group\nCtrl\nIRI\n')
      await writeFile(join(dataRoot, 'summary.csv'), 'summary')
      const evidence = await observation.finish()
      expect(evidence.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete',
        reasonCodes: []
      })
      expect(evidence.confirmedReadPaths).toEqual(['data/inputs/source.csv'])
      expect(evidence.confirmedReadPaths).not.toContain('data/copy.csv')
      expect(evidence.workingFiles.map((file) => file.relativePath).sort()).toEqual([
        'data/copy.csv',
        'data/summary.csv'
      ])
      for (const file of evidence.workingFiles) {
        const bytes = await readFile(join(notebookSessionRoot, file.relativePath))
        expect(file.size).toBe(bytes.length)
        expect(file.checksum).toBe(createHash('sha256').update(bytes).digest('hex'))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

configureTestRuntimeMetadata()
