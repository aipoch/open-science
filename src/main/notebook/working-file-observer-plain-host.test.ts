import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runEvidenceWorker } from './working-file-observer'

// Plain-Node hosts (runtime certification, SDK consumers) configure no host entry. The evidence
// worker must still resolve via the source-tree candidate instead of demanding runtime metadata.

let fixture: string
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'evidence-worker-plain-host-'))
})
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})

it('runs the evidence worker without configured runtime metadata', async () => {
  const evidenceRoot = join(fixture, 'execution-file-evidence')
  await mkdir(evidenceRoot)
  const metadata = await stat(evidenceRoot)
  await expect(
    runEvidenceWorker(evidenceRoot, {
      operation: 'ensure-project',
      projectName: 'project-plain',
      expectedRootIdentity: { dev: metadata.dev, ino: metadata.ino }
    })
  ).resolves.toBeDefined()
})
