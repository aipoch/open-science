import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { startWorkingFileObservation } from './working-file-observer'

it.each([true, false])(
  'validates the actual initial generation before certifying the RDS reader (match=%s)',
  async (match) => {
    const root = await mkdtemp(join(tmpdir(), 'rds-capture-')),
      session = join(root, 'session'),
      data = join(session, 'data')
    try {
      await mkdir(data, { recursive: true })
      const bytes = 'small fake payload: the observer must not deserialize RDS'
      await writeFile(join(data, 'intermediate.rds'), bytes)
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const observation = await startWorkingFileObservation({
        dataRoot: data,
        notebookSessionRoot: session,
        cwd: data,
        language: 'r',
        runId: 'reader',
        code: 'd<-readRDS("intermediate.rds"); d$status<-factor(d$status); p<-subset(d,status!="NS"); saveRDS(p,"out.rds")',
        sourceFileAccessContext: {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          serializedValueFiles: [
            {
              path: 'data/intermediate.rds',
              format: 'rds',
              valueType: 'r-value',
              checksum: match ? checksum : 'b'.repeat(64)
            }
          ],
          verifiedSerializedValues: [
            { path: 'intermediate.rds', format: 'rds', valueType: 'r-value' }
          ]
        }
      })
      await writeFile(join(data, 'out.rds'), 'simulated output')
      const result = await observation.finish()
      expect(result.fileEvidence.fileReads).toBe(match ? 'complete' : 'partial')
      expect(result.fileEvidence.writerAttribution).toBe(match ? 'complete' : 'partial')
      if (match) expect(result.confirmedReadPaths).toEqual(['data/intermediate.rds'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)
