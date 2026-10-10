import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runEvidenceWorker } from './working-file-observer'
import { NotebookKernelExecutor } from './kernel-executor'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { resolveBundleDir } from './bundle-local'
import { resolveMicromamba } from './micromamba'

// Plain-Node hosts (runtime certification, SDK consumers) configure no host entry. Resource
// resolution must fall back to the source-tree candidates instead of demanding runtime metadata.

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

it('constructs the default kernel executor without configured runtime metadata', () => {
  expect(() => new NotebookKernelExecutor()).not.toThrow()
})

it('analyzes notebook sources without configured runtime metadata', async () => {
  await expect(analyzePythonNotebookSource('print(1)\n')).resolves.toBeDefined()
})

it('resolves micromamba and env bundles without configured runtime metadata', () => {
  expect(() => resolveMicromamba()).not.toThrow()
  expect(() => resolveBundleDir()).not.toThrow()
})
