import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NestedWorkingFileOwner, type FrozenNestedWorkingFile } from './nested-working-file-owner'
import { runEvidenceWorker, startWorkingFileObservation } from './working-file-observer'

const scope = {
  projectId: 'project',
  sessionId: 'session',
  parentControlInvocationId: 'outer',
  rootExecutionId: 'turn'
}
const run = (runId: string, kernelKind: 'repl' | 'bash'): NotebookRunRecord => ({
  runId,
  cellId: runId,
  script: '',
  kernelKind,
  source: 'agent',
  status: 'completed',
  startedAt: 1,
  endedAt: 2,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: [],
  rootFrameId: 'frame',
  agentFrameId: 'frame',
  messageBranchId: 'branch',
  runtimeSegmentId: 'segment',
  promptMessageId: 'prompt'
})
let root: string
let child: NotebookRunRecord
let frozen: readonly FrozenNestedWorkingFile[]
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nested-working-file-owner-')))
  const notebookSessionRoot = join(root, 'notebook')
  const dataRoot = join(notebookSessionRoot, 'data')
  await mkdir(dataRoot, { recursive: true })
  const observer = await startWorkingFileObservation({
    runId: 'inner',
    dataRoot,
    notebookSessionRoot,
    fileEvidenceStorageRoot: root,
    onFrozenWorkingFiles: (files) => {
      frozen = files
    }
  })
  await writeFile(join(dataRoot, 'result.json'), '{"value":42}')
  const observed = await observer.finish()
  expect(observed.fileEvidence).toMatchObject({
    checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    generationCount: 1
  })
  child = {
    ...run('inner', 'bash'),
    fileEvidence: observed.fileEvidence,
    workingFiles: observed.workingFiles.map((file) => ({ ...file, createdByRunId: 'inner' }))
  }
  expect(frozen).toHaveLength(1)
  expect(frozen[0].evidenceChecksum).toBe(child.fileEvidence!.checksum)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('retains a committed child generation only during the exact parent invocation', () => {
  const owner = new NestedWorkingFileOwner()
  const parent = owner.open(scope, run('outer', 'repl'))
  owner.record(scope, child, frozen)
  expect(parent.read()).toHaveLength(1)
  expect(parent.read()[0].file).toEqual(child.workingFiles[0])
  owner.record(scope, child, frozen)
  expect(parent.read()).toHaveLength(1)
  parent.close()
  owner.record(scope, child, frozen)
  expect(parent.read()).toEqual([])
  const next = owner.open({ ...scope, rootExecutionId: 'next-turn' }, run('outer', 'repl'))
  owner.record(scope, child, frozen)
  expect(next.read()).toEqual([])
  parent.close()
  owner.record({ ...scope, rootExecutionId: 'next-turn' }, child, frozen)
  expect(next.read()).toHaveLength(1)
  next.close()
})

it.each(['projectId', 'sessionId', 'parentControlInvocationId', 'rootExecutionId'] as const)(
  'does not infer child membership from a mismatched %s',
  (field) => {
    const owner = new NestedWorkingFileOwner()
    const parent = owner.open(scope, run('outer', 'repl'))
    owner.record({ ...scope, [field]: 'other' }, child, frozen)
    expect(parent.read()).toEqual([])
    parent.close()
  }
)

it.each([
  'rootFrameId',
  'agentFrameId',
  'messageBranchId',
  'runtimeSegmentId',
  'promptMessageId'
] as const)('does not borrow a child from another %s', (field) => {
  const owner = new NestedWorkingFileOwner()
  const parent = owner.open(scope, run('outer', 'repl'))
  owner.record(scope, { ...child, [field]: 'other' }, frozen)
  expect(parent.read()).toEqual([])
  parent.close()
})

it.each(['running', 'queued'] as const)('does not borrow an uncommitted %s child', (status) => {
  const owner = new NestedWorkingFileOwner()
  const parent = owner.open(scope, run('outer', 'repl'))
  owner.record(scope, { ...child, status }, frozen)
  expect(parent.read()).toEqual([])
  parent.close()
})

it.each(['missing-evidence', 'wrong-evidence', 'wrong-generation', 'wrong-owner'] as const)(
  'does not borrow a child with %s',
  (invalid) => {
    const owner = new NestedWorkingFileOwner()
    const parent = owner.open(scope, run('outer', 'repl'))
    const changed = structuredClone(child)
    if (invalid === 'missing-evidence') delete changed.fileEvidence
    if (invalid === 'wrong-evidence') changed.fileEvidence!.checksum = '0'.repeat(64)
    if (invalid === 'wrong-generation') changed.workingFiles[0].generationId = 'other'
    if (invalid === 'wrong-owner') changed.workingFiles[0].createdByRunId = 'other'
    owner.record(scope, changed, frozen)
    expect(parent.read()).toEqual([])
    parent.close()
  }
)

it('keeps ambiguous ownership if a referenced file changes during outer publication', async () => {
  const notebookSessionRoot = join(root, 'race-notebook')
  const dataRoot = join(notebookSessionRoot, 'data')
  const outputRoot = join(dataRoot, 'outputs')
  await mkdir(outputRoot, { recursive: true })
  const path = join(outputRoot, 'result.json')
  const owner = new NestedWorkingFileOwner()
  const parent = owner.open(scope, run('outer', 'repl'))
  const outer = await startWorkingFileObservation(
    {
      runId: 'outer',
      dataRoot,
      notebookSessionRoot,
      fileEvidenceStorageRoot: root,
      nestedWorkingFiles: parent
    },
    {
      runEvidenceWorker: async (...args) => {
        const result = await runEvidenceWorker(...args)
        if (args[1].operation === 'persist') await writeFile(path, '{"changed":true}')
        return result
      }
    }
  )
  let innerFrozen: readonly FrozenNestedWorkingFile[] = []
  const inner = await startWorkingFileObservation({
    runId: 'race-inner',
    dataRoot: outputRoot,
    notebookSessionRoot,
    fileEvidenceStorageRoot: root,
    onFrozenWorkingFiles: (files) => {
      innerFrozen = files
    }
  })
  await writeFile(path, '{"value":42}')
  const observed = await inner.finish()
  const committed = {
    ...run('race-inner', 'bash'),
    fileEvidence: observed.fileEvidence,
    workingFiles: observed.workingFiles.map((file) => ({ ...file, createdByRunId: 'race-inner' }))
  }
  owner.record(scope, committed, innerFrozen)
  expect(parent.read()).toHaveLength(1)
  const result = await outer.finish()
  expect(result.fileEvidence.state).toBe('unavailable')
  expect(result.fileEvidence.reasonCodes).toContain('evidence-persistence-failed')
  expect(result.workingFiles).toHaveLength(1)
  expect(result.workingFiles[0].createdByRunId).toBeUndefined()
  expect(result.workingFiles[0].generationId).toBeUndefined()
  expect(await readFile(path, 'utf8')).toBe('{"changed":true}')
  parent.close()
})

;(await import('../../../test/runtime-metadata')).configureTestRuntimeMetadata()
