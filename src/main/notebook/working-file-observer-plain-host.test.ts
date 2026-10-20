import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runEvidenceWorker } from './working-file-observer'
import { NotebookKernelExecutor } from './kernel-executor'
import { analyzePythonNotebookSource } from '@aipoch/notebook-analysis'
import { resolveBundleDir } from './environment-resources'
import { resolveMicromamba } from '@aipoch/environment'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

// Plain-Node hosts (runtime certification, SDK consumers) configure no host entry. Resource
// resolution must fall back to the source-tree candidates instead of demanding runtime metadata.

let fixture: string
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'evidence-worker-plain-host-'))
})
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})

it('runs the evidence worker without configured runtime metadata or a visible Windows console', async () => {
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
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    expect.arrayContaining([expect.stringContaining('file_evidence_worker.js')]),
    expect.objectContaining({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  )
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
