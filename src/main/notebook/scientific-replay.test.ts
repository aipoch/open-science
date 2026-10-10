import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  decodeSnapshot,
  readPathsBeforeOverwrite,
  sha256,
  verifyReplayCapture
} from './scientific-replay.test-support'
import { startWorkingFileObservation } from './working-file-observer'

type Capture = Awaited<ReturnType<typeof verifyReplayCapture>>
type Observation = Awaited<
  ReturnType<Awaited<ReturnType<typeof startWorkingFileObservation>>['finish']>
>
let root: string
let result: Observation
let captured: Capture
const outputs = ['outputs/counts.tsv']

// Fault injection uses real observer evidence, not hand-built sidecars or model-generated oracles.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scientific-capture-check-'))
  const dataRoot = join(root, 'data')
  await mkdir(join(dataRoot, 'outputs'), { recursive: true })
  await writeFile(join(dataRoot, 'source.txt'), 'A\nA\nC\n')
  const observer = await startWorkingFileObservation({
    dataRoot,
    notebookSessionRoot: dataRoot,
    cwd: dataRoot,
    fileEvidenceStorageRoot: root,
    runId: 'capture-check'
  })
  await writeFile(join(dataRoot, outputs[0]), 'base\tcount\nA\t2\nC\t1\n')
  result = await observer.finish()
  captured = await verifyReplayCapture(root, result, outputs)
})

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

const replaceSidecar = async (): Promise<void> => {
  const bytes = JSON.stringify(captured)
  await writeFile(join(root, result.fileEvidence.storageKey!), bytes)
  result.fileEvidence.checksum = sha256(bytes)
}

it('accepts real evidence and portable audit paths without changing the audit list', async () => {
  const auditPaths = ['outputs\\counts.tsv']
  await verifyReplayCapture(root, result, auditPaths)
  expect(auditPaths).toEqual(['outputs\\counts.tsv'])
})

it.each(['missing', 'unexpected', 'duplicate'] as const)(
  'rejects %s working files even when expected outputs would be a matching subset',
  async (kind) => {
    if (kind === 'missing') result.workingFiles = []
    else
      result.workingFiles.push({
        ...result.workingFiles[0],
        relativePath: kind === 'unexpected' ? 'outputs/extra.tsv' : outputs[0]
      })
    await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow(
      'captured output paths'
    )
  }
)

it('rejects sidecar bytes changed without updating their checksum', async () => {
  await writeFile(join(root, result.fileEvidence.storageKey!), '{}')
  await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow('evidence checksum')
})

it.each(['activityId', 'evidenceId'] as const)(
  'rejects a sidecar with mismatched %s',
  async (field) => {
    captured[field] = 'different-execution'
    await replaceSidecar()
    await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow(
      field === 'activityId' ? 'evidence activity' : 'evidence identity'
    )
  }
)

it.each(['missing', 'duplicate', 'absent-content'] as const)(
  'rejects %s output generations even with an intact working file',
  async (kind) => {
    const output = captured.relations.find((r) => r.relation === 'created')!
    if (kind === 'missing') captured.relations = captured.relations.filter((r) => r !== output)
    else if (kind === 'duplicate') captured.relations.push(structuredClone(output))
    else delete output.generation!.contentStorageKey
    await replaceSidecar()
    await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow(
      kind === 'absent-content' ? 'stored output' : 'output generation paths'
    )
  }
)

it.each(['created', 'present-before'])('rejects a corrupted %s content blob', async (relation) => {
  const entry = captured.relations.find((r) => r.relation === relation)!
  await writeFile(join(root, entry.generation!.contentStorageKey!), 'corrupted')
  await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow('stored checksum')
})

it('rejects a valid blob belonging to a different output generation', async () => {
  const output = captured.relations.find((r) => r.relation === 'created')!
  output.generation = captured.relations.find((r) => r.relation === 'present-before')!.generation
  await replaceSidecar()
  await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow(
    'output generation identity'
  )
})

it('rejects modified evidence presented as a newly created working file', async () => {
  captured.relations.find((r) => r.relation === 'created')!.relation = 'modified'
  await replaceSidecar()
  await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow('output change')
})

it('rejects presence upgraded to observed-read authority', async () => {
  captured.relations.find((r) => r.relation === 'present-before')!.authority = 'observed-read'
  await replaceSidecar()
  await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow('presence authority')
})

it('rejects a working file overwritten after capture', async () => {
  await writeFile(result.workingFiles[0].path, 'later-cell-result')
  await expect(verifyReplayCapture(root, result, outputs)).rejects.toThrow('working checksum')
})

it('checks compressed source bytes and metadata before independent scientific validation', async () => {
  const bytes = await readFile(result.workingFiles[0].path)
  const snapshot = {
    bytes: bytes.length,
    sha256: sha256(bytes),
    gzipBase64: gzipSync(bytes).toString('base64')
  }
  expect(decodeSnapshot(snapshot)).toEqual(bytes)
  expect(() => decodeSnapshot({ ...snapshot, bytes: bytes.length + 1 })).toThrow(
    'snapshot byte count'
  )
  expect(() => decodeSnapshot({ ...snapshot, sha256: sha256('other') })).toThrow(
    'snapshot checksum'
  )
})

it('distinguishes confirmed intermediates from read-modify-write, append and failed opens', () => {
  const read = { path: 'outputs/model.py', kind: 'read' }
  const truncate = {
    path: 'outputs\\model.py',
    kind: 'write',
    truncates: true,
    successful_open: true
  }
  expect(readPathsBeforeOverwrite([truncate, read])).toEqual([])
  expect(readPathsBeforeOverwrite([read, truncate, read])).toEqual(['outputs/model.py'])
  expect(readPathsBeforeOverwrite([{ ...truncate, truncates: false }, read])).toEqual([
    'outputs/model.py'
  ])
  expect(readPathsBeforeOverwrite([{ ...truncate, successful_open: false }, read])).toEqual([
    'outputs/model.py'
  ])
  expect(readPathsBeforeOverwrite([{ path: read.path, kind: 'write', readable: true }])).toEqual([
    'outputs/model.py'
  ])
  expect(readPathsBeforeOverwrite([{ ...truncate, readable: true }, read])).toEqual([])
  // State is scoped to one cell: the previously generated module is an input later.
  expect(readPathsBeforeOverwrite([read])).toEqual(['outputs/model.py'])
})

configureTestRuntimeMetadata()
