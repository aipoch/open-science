import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_R_STAGE_CHECKPOINT_BYTES, validRStageCheckpointForRun } from '@aipoch/reproducibility'
import {
  assertRStageReplayPaths,
  installRStageCheckpointBlob,
  prepareRStageCheckpoint
} from './r-stage-checkpoint'
import type { NotebookSessionExecutionResult } from './session-aggregate'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const run = { runId: 'original-run', kernelEpochId: 'original-epoch', script: 'y <- x + 1' }
const result = (): NotebookSessionExecutionResult => ({
  status: 'completed',
  stdout: '',
  stderr: '',
  traceback: '',
  outputs: [],
  cwdAfter: '/data',
  stageCheckpointCapture: { state: 'available', inputNames: ['x'], outputNames: ['y'] },
  environmentLock: {
    state: 'available',
    format: 'environment-lock-bundle',
    lockChecksum: 'a'.repeat(64)
  }
})
const fixture = async (): Promise<{
  root: string
  owner: Awaited<ReturnType<typeof prepareRStageCheckpoint>>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'r-stage-capture-'))
  roots.push(root)
  const owner = await prepareRStageCheckpoint(join(root, 'session'), root)
  await writeFile(owner.paths.inputPath, 'original-input')
  await writeFile(owner.paths.outputPath, 'original-output')
  return { root, owner }
}

describe('R stage checkpoint capture owner', () => {
  it('imports bounded, checksummed blobs using the same immutable publication owner', async () => {
    const { root, owner } = await fixture()
    const bytes = Buffer.from('original-input')
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const expected = {
      storageKey: `runtime/provenance/r-stage-checkpoints/${checksum}.rds`,
      checksum,
      sizeBytes: bytes.length
    }
    await expect(
      installRStageCheckpointBlob(root, owner.paths.inputPath, expected)
    ).resolves.toEqual(expected)
    await expect(
      installRStageCheckpointBlob(root, owner.paths.inputPath, expected)
    ).resolves.toEqual(expected)
    await writeFile(owner.paths.inputPath, 'changed')
    await expect(
      installRStageCheckpointBlob(root, owner.paths.inputPath, expected)
    ).rejects.toThrow('checksum mismatch')
    expect(await readFile(join(root, expected.storageKey), 'utf8')).toBe('original-input')
    await expect(
      installRStageCheckpointBlob(root, owner.paths.inputPath, {
        ...expected,
        storageKey: '../escape'
      })
    ).rejects.toThrow('metadata')
    await owner.dispose()
  })

  it('seals exact run/epoch/source/environment identity and immutable content, then removes temporary state', async () => {
    const { root, owner } = await fixture()
    const execution = result()
    const checkpoint = await owner.seal(run, execution)
    expect(checkpoint.state).toBe('available')
    if (checkpoint.state !== 'available') throw new Error('expected captured state')
    expect(
      validRStageCheckpointForRun({
        ...run,
        kernelKind: 'r',
        status: 'completed',
        environmentLock: execution.environmentLock,
        stageCheckpoint: checkpoint
      })
    ).toBe(true)
    expect(checkpoint.sourceChecksum).toBe(createHash('sha256').update(run.script).digest('hex'))
    expect(checkpoint.input.storageKey).toBe(
      `runtime/provenance/r-stage-checkpoints/${checkpoint.input.checksum}.rds`
    )
    await writeFile(owner.paths.inputPath, 'later-input')
    expect(await readFile(join(root, checkpoint.input.storageKey), 'utf8')).toBe('original-input')
    expect(
      validRStageCheckpointForRun({
        ...run,
        runId: 'later-run',
        kernelKind: 'r',
        status: 'completed',
        environmentLock: execution.environmentLock,
        stageCheckpoint: checkpoint
      })
    ).toBe(false)
    await owner.dispose()
    expect(await readdir(join(root, 'session', '.r-stage-checkpoints'))).toEqual([])
  })

  it('seals validated proof alongside immutable run identities and keeps legacy checkpoints readable', async () => {
    const { owner } = await fixture()
    const execution = result()
    const proof = { schemaVersion: 1 as const, packages: [{ name: 'DESeq2', version: '1.48.2' }] }
    execution.stageCheckpointCapture = {
      state: 'available',
      inputNames: ['x'],
      outputNames: ['y'],
      environmentProof: proof
    }
    const pending = owner.seal(run, execution)
    proof.packages[0]!.version = 'changed'
    const checkpoint = await pending
    expect(checkpoint.state).toBe('available')
    if (checkpoint.state !== 'available') throw new Error('missing checkpoint')
    expect(checkpoint.environmentProof).toEqual({
      schemaVersion: 1,
      packages: [{ name: 'DESeq2', version: '1.48.2' }]
    })
    expect(checkpoint.environmentProof?.packages[0]?.version).toBe('1.48.2')
    const evidence = {
      ...run,
      kernelKind: 'r' as const,
      status: 'completed' as const,
      environmentLock: execution.environmentLock,
      stageCheckpoint: checkpoint
    }
    expect(validRStageCheckpointForRun(evidence)).toBe(true)
    expect(validRStageCheckpointForRun({ ...evidence, script: 'tampered' })).toBe(false)
    expect(validRStageCheckpointForRun({ ...evidence, kernelEpochId: 'other' })).toBe(false)
    expect(
      validRStageCheckpointForRun({
        ...evidence,
        stageCheckpoint: {
          ...checkpoint,
          environmentProof: Object.assign({}, checkpoint.environmentProof!, { extra: true })
        }
      })
    ).toBe(false)
    const legacy = { ...checkpoint }
    delete legacy.environmentProof
    expect(validRStageCheckpointForRun({ ...evidence, stageCheckpoint: legacy })).toBe(true)
    await owner.dispose()
  })

  it('refuses to seal malformed proof from an injected executor', async () => {
    const { owner } = await fixture()
    const execution = result()
    execution.stageCheckpointCapture = {
      state: 'available',
      inputNames: [],
      outputNames: [],
      environmentProof: {
        schemaVersion: 1,
        packages: [
          { name: 'DESeq2', version: '1' },
          { name: 'DESeq2', version: '2' }
        ]
      }
    }
    await expect(owner.seal(run, execution)).resolves.toEqual({
      state: 'unavailable',
      reason: 'invalid-checkpoint-environment-proof'
    })
    await owner.dispose()
  })

  it.each([
    'missing-output',
    'oversize',
    'symlink',
    'changed-durable-object',
    'storage-parent-link'
  ])('fails closed on %s', async (scenario) => {
    const { root, owner } = await fixture()
    if (scenario === 'missing-output') await rm(owner.paths.outputPath)
    if (scenario === 'oversize')
      await truncate(owner.paths.inputPath, MAX_R_STAGE_CHECKPOINT_BYTES + 1)
    if (scenario === 'symlink') {
      await rm(owner.paths.inputPath)
      await symlink(owner.paths.outputPath, owner.paths.inputPath)
    }
    if (scenario === 'storage-parent-link') {
      const outside = join(root, 'outside')
      await mkdir(outside)
      await symlink(outside, join(root, 'runtime'))
    }
    if (scenario === 'changed-durable-object') {
      const hash = createHash('sha256').update('original-input').digest('hex')
      const { mkdir } = await import('node:fs/promises')
      const directory = join(root, 'runtime/provenance/r-stage-checkpoints')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${hash}.rds`), 'corrupt')
    }
    await expect(owner.seal(run, result())).resolves.toEqual({
      state: 'unavailable',
      reason: 'checkpoint-publication-failed'
    })
    await owner.dispose()
  })

  it('does not publish state without an exact environment lock or successful execution', async () => {
    const { root, owner } = await fixture()
    await expect(owner.seal(run, { ...result(), environmentLock: undefined })).resolves.toEqual({
      state: 'unavailable',
      reason: 'checkpoint-environment-lock-unavailable'
    })
    await expect(owner.seal(run, { ...result(), status: 'cancelled' })).resolves.toEqual({
      state: 'unavailable',
      reason: 'run-not-completed'
    })
    await expect(
      readFile(join(root, 'runtime/provenance/r-stage-checkpoints'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await owner.dispose()
  })

  it('preserves unsupported R capture reasons and never substitutes a later state', async () => {
    const { owner } = await fixture()
    await expect(
      owner.seal(run, {
        ...result(),
        stageCheckpointCapture: { state: 'unavailable', reason: 'external-pointer' }
      })
    ).resolves.toEqual({ state: 'unavailable', reason: 'external-pointer' })
    await expect(
      owner.seal(run, { ...result(), stageCheckpointCapture: undefined })
    ).resolves.toEqual({ state: 'unavailable', reason: 'checkpoint-response-missing' })
    await owner.dispose()
  })
})

describe('R stage replay paths', () => {
  it('accepts only the materialized current run boundary and rejects links or arbitrary paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r-stage-replay-'))
    roots.push(root)
    const directory = join(
      root,
      '.r-stage-checkpoints',
      createHash('sha256').update(run.runId).digest('hex')
    )
    await mkdir(directory, { recursive: true })
    const paths = {
      inputPath: join(directory, 'input.rds'),
      expectedOutputPath: join(directory, 'output.rds')
    }
    await writeFile(paths.inputPath, 'input')
    await writeFile(paths.expectedOutputPath, 'output')
    await expect(assertRStageReplayPaths(root, run.runId, paths)).resolves.toBeUndefined()
    const stageSupplement = { ...paths, names: ['clean'] }
    await expect(
      assertRStageReplayPaths(root, run.runId, undefined, undefined, stageSupplement)
    ).resolves.toBeUndefined()
    await expect(
      assertRStageReplayPaths(root, run.runId, paths, undefined, stageSupplement)
    ).rejects.toThrow('Conflicting')
    await expect(
      assertRStageReplayPaths(root, 'other-run', undefined, undefined, stageSupplement)
    ).rejects.toThrow()
    await expect(
      assertRStageReplayPaths(root, run.runId, undefined, undefined, {
        ...stageSupplement,
        expectedOutputPath: '/etc/passwd'
      })
    ).rejects.toThrow()
    for (const names of [
      [],
      ['clean', 'clean'],
      [''],
      ['x'.repeat(1025)],
      Array.from({ length: 4097 }, (_, i) => `x${i}`),
      [1]
    ] as unknown as string[][]) {
      await expect(
        assertRStageReplayPaths(root, run.runId, undefined, undefined, {
          ...stageSupplement,
          names
        })
      ).rejects.toThrow('Invalid R stage supplement names')
    }

    await expect(
      assertRStageReplayPaths(root, run.runId, undefined, paths.expectedOutputPath)
    ).resolves.toBeUndefined()
    await expect(assertRStageReplayPaths(root, 'other-run', paths)).rejects.toThrow()
    await expect(
      assertRStageReplayPaths(root, run.runId, { ...paths, inputPath: '/etc/passwd' })
    ).rejects.toThrow()
    await rm(paths.inputPath)
    await symlink(paths.expectedOutputPath, paths.inputPath)
    await expect(assertRStageReplayPaths(root, run.runId, paths)).rejects.toThrow()
    await expect(
      assertRStageReplayPaths(root, run.runId, undefined, undefined, stageSupplement)
    ).rejects.toThrow()
  })
})
