import { createArtifactHandlers } from './ipc'
import { ArtifactRunRegistry } from './run-registry'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type {
  ArtifactRpcCapabilityBinding,
  SaveArtifactVersionRequest
} from '../../shared/artifact-provenance'
import { strToU8, zipSync } from 'fflate'
import { ARTIFACT_LITERATURE_SIDECAR_SUFFIX } from '../../shared/artifact-literature'
import * as boundedIo from '../bounded-file-io'
import { defaultArtifactDurability } from './durability'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArtifactSaveFixture } from './save-test-fixtures'
import { writeArtifactFileForCurrentRun } from './mcp-server'
import { ArtifactProvenanceRepository } from './provenance-repository'
import { ArtifactWriteBudgetOwner } from './write-budget-owner'

const fixtures: Awaited<ReturnType<typeof createArtifactSaveFixture>>[] = []
const setup = async (): Promise<Awaited<ReturnType<typeof createArtifactSaveFixture>>> => {
  const f = await createArtifactSaveFixture()
  fixtures.push(f)
  return f
}
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})
const hash = (data: string): string => createHash('sha256').update(data).digest('hex')
const saveBinding = (
  binding: ArtifactRpcCapabilityBinding
): Omit<SaveArtifactVersionRequest, 'writeOperationId' | 'filename' | 'source'> => ({
  ...binding,
  messageBranchAncestry: binding.messageBranchAncestry
    ? [...binding.messageBranchAncestry]
    : undefined,
  messageAncestry: binding.messageAncestry ? [...binding.messageAncestry] : undefined
})

describe('Main-issued Artifact expected content', () => {
  it.each(['changed-size', 'same-size-restored-mtime'] as const)(
    'rejects a real local source race (%s) without pending or database residue',
    async (change) => {
      const f = await setup()
      const workspace = join(f.storageRoot, 'workspace')
      await mkdir(workspace)
      const path = join(workspace, 'source.txt')
      const original = 'old bytes'
      const replacement = change === 'changed-size' ? 'replacement is longer' : 'new bytes'
      const modifiedAt = new Date('2026-01-01T00:00:00.000Z')
      await writeFile(path, original)
      await utimes(path, modifiedAt, modifiedAt)
      const before = await stat(path)
      const expectedContent = { checksum: hash(original), sizeBytes: before.size }
      const replace = async (): Promise<void> => {
        await writeFile(path, replacement)
        await utimes(path, modifiedAt, modifiedAt)
      }
      const copy = boundedIo.copyOpenFileWithinBudget
      const copied = vi.spyOn(boundedIo, 'copyOpenFileWithinBudget')
      if (change === 'changed-size') {
        await replace()
      } else {
        // The source has already passed its original stat check when copying starts.
        copied.mockImplementationOnce(async (...args) => {
          await replace()
          expect(await stat(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs })
          return copy(...args)
        })
      }
      const release = vi.spyOn(ArtifactWriteBudgetOwner.prototype, 'release')
      const request = {
        ...saveBinding(f.binding),
        writeOperationId: 'expected-content-race',
        filename: 'result.txt',
        source: { kind: 'localPath' as const, path }
      }
      const scope = { allowedImportRoots: [workspace], expectedContent }
      await expect(f.repository.saveVersion(request, scope)).rejects.toThrow(
        'Artifact source content does not match the expected content.'
      )
      expect(await copied.mock.results[0].value).toMatchObject({
        checksum: hash(replacement),
        sizeBytes: Buffer.byteLength(replacement)
      })
      expect(release).toHaveBeenCalledTimes(1)
      expect(await f.client.artifactVersion.count()).toBe(0)
      expect(await f.client.artifactLineage.count()).toBe(0)
      expect(await f.client.contentBlob.count()).toBe(0)
      const pendingDirectory = join(
        f.storageRoot,
        'artifacts/project-1/artifact-session-1/.pending/artifact-run-1'
      )
      expect(
        (await readdir(pendingDirectory, { recursive: true, withFileTypes: true })).filter(
          (entry) => entry.isFile()
        )
      ).toEqual([])
      // The failed write operation and budget can be reused once Main supplies current evidence.
      const result = await f.repository.saveVersion(request, {
        ...scope,
        expectedContent: { checksum: hash(replacement), sizeBytes: Buffer.byteLength(replacement) }
      })
      expect(await readFile(result.path, 'utf8')).toBe(replacement)
      expect(await f.client.artifactVersion.count()).toBe(1)
    }
  )

  it('captures the expected content before the session lock can delay a save', async () => {
    const f = await setup()
    const workspace = join(f.storageRoot, 'workspace')
    await mkdir(workspace)
    const path = join(workspace, 'source.txt')
    await writeFile(path, 'old')
    const entered = deferred()
    const proceed = deferred()
    const reserve = ArtifactWriteBudgetOwner.prototype.reserve
    vi.spyOn(ArtifactWriteBudgetOwner.prototype, 'reserve').mockImplementationOnce(async function (
      this: ArtifactWriteBudgetOwner,
      request
    ) {
      entered.resolve()
      await proceed.promise
      return reserve.call(this, request)
    })
    const first = f.repository.saveVersion(
      {
        ...saveBinding(f.binding),
        writeOperationId: 'blocking-write',
        filename: 'first.txt',
        source: {
          kind: 'inline',
          content: Buffer.from('first').toString('base64'),
          encoding: 'base64'
        }
      },
      { allowedImportRoots: [] }
    )
    await entered.promise
    const expectedContent = { checksum: hash('old'), sizeBytes: 3 }
    const scope = { allowedImportRoots: [workspace], expectedContent }
    const queued = f.repository.saveVersion(
      {
        ...saveBinding(f.binding),
        writeOperationId: 'queued-write',
        filename: 'result.txt',
        source: { kind: 'localPath', path }
      },
      scope
    )
    const rejection = expect(queued).rejects.toThrow('does not match the expected content')
    try {
      await writeFile(path, 'replacement')
      expectedContent.checksum = hash('replacement')
      expectedContent.sizeBytes = Buffer.byteLength('replacement')
      scope.expectedContent = { ...expectedContent }
    } finally {
      proceed.resolve()
    }
    await Promise.all([first, rejection])
    expect(await f.client.artifactVersion.count()).toBe(1)
    expect(
      await f.compatibilityRepository.listPendingRunFiles({
        projectId: f.binding.projectId,
        sessionId: f.binding.artifactStorageSessionId,
        runId: f.binding.artifactRunId
      })
    ).toEqual([expect.objectContaining({ name: 'first.txt' })])
  })

  it.each(['checksum', 'size'] as const)(
    'enforces the expected inline %s on decoded bytes',
    async (field) => {
      const f = await setup()
      const content = 'inline content'
      const request = {
        ...saveBinding(f.binding),
        writeOperationId: 'expected-inline',
        filename: 'result.txt',
        source: {
          kind: 'inline' as const,
          content: Buffer.from(content).toString('base64'),
          encoding: 'base64' as const
        }
      }
      const expectedContent = { checksum: hash(content), sizeBytes: Buffer.byteLength(content) }
      await expect(
        f.repository.saveVersion(request, {
          allowedImportRoots: [],
          expectedContent: {
            checksum: field === 'checksum' ? hash('other') : expectedContent.checksum,
            sizeBytes: field === 'size' ? expectedContent.sizeBytes + 1 : expectedContent.sizeBytes
          }
        })
      ).rejects.toThrow('does not match the expected content')
      expect(await f.client.artifactVersion.count()).toBe(0)
      const result = await f.repository.saveVersion(request, {
        allowedImportRoots: [],
        expectedContent
      })
      expect(result).toMatchObject({
        checksum: expectedContent.checksum,
        size: expectedContent.sizeBytes
      })
      expect(await readFile(result.path, 'utf8')).toBe(content)
    }
  )

  it.each(['localPath', 'inline'] as const)(
    'checks expected content during %s idempotent replay',
    async (kind) => {
      const f = await setup()
      const workspace = join(f.storageRoot, 'workspace')
      await mkdir(workspace)
      const path = join(workspace, 'source.txt')
      const content = 'original'
      await writeFile(path, content)
      const request = {
        ...saveBinding(f.binding),
        writeOperationId: 'expected-replay',
        filename: 'result.txt',
        source:
          kind === 'localPath'
            ? { kind, path }
            : {
                kind,
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64' as const
              }
      }
      const scope = {
        allowedImportRoots: [workspace],
        expectedContent: { checksum: hash(content), sizeBytes: Buffer.byteLength(content) }
      }
      const first = await f.repository.saveVersion(request, scope)
      await rm(path)
      for (const expectedContent of [
        { ...scope.expectedContent, checksum: hash('other') },
        { ...scope.expectedContent, sizeBytes: scope.expectedContent.sizeBytes + 1 }
      ]) {
        await expect(
          f.repository.saveVersion(request, { ...scope, expectedContent })
        ).rejects.toThrow('does not match the expected content')
      }
      expect(await f.repository.saveVersion(request, scope)).toEqual(first)
      expect(await f.client.artifactVersion.count()).toBe(1)
      expect(await readFile(first.path, 'utf8')).toBe(content)
    }
  )

  it.each([true, false])(
    'does not accept a public expectedContent override (trusted constraint: %s)',
    async (constrained) => {
      const f = await setup()
      const content = 'actual bytes'
      const expectedContent = {
        checksum: hash('old bytes'),
        sizeBytes: Buffer.byteLength('old bytes')
      }
      const env = await f.environment({
        allowedImportRoots: [],
        ...(constrained ? { expectedContent } : {})
      })
      const context = JSON.parse(await readFile(env.currentRunFile, 'utf8'))
      const forged = constrained
        ? { checksum: hash(content), sizeBytes: Buffer.byteLength(content) }
        : expectedContent
      const save = vi.spyOn(f.repository, 'saveVersion')
      const response = await fetch(env.rpcEndpoint!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.rpcCapabilityToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'artifactSaveVersion',
          params: {
            ...saveBinding(f.binding),
            writeOperationId: 'public-override',
            filename: 'result.txt',
            source: {
              kind: 'inline',
              content: Buffer.from(content).toString('base64'),
              encoding: 'base64'
            },
            expectedContent: forged,
            sourceScope: { allowedImportRoots: [], expectedContent: forged }
          }
        })
      })
      expect(save).toHaveBeenCalledTimes(1)
      expect(save.mock.calls[0][0]).not.toHaveProperty('expectedContent')
      expect(save.mock.calls[0][0]).not.toHaveProperty('sourceScope')
      expect(save.mock.calls[0][1].expectedContent).toEqual(
        constrained ? expectedContent : undefined
      )
      if (constrained) {
        expect(response.ok).toBe(false)
        expect(await response.text()).toContain('does not match the expected content')
        expect(await f.client.artifactVersion.count()).toBe(0)
      } else {
        expect(response.ok).toBe(true)
        expect(await f.client.artifactVersion.count()).toBe(1)
      }
    }
  )

  it.each([
    null,
    { checksum: 'invalid', sizeBytes: 1 },
    { checksum: 'A'.repeat(64), sizeBytes: 1 },
    { checksum: hash('x'), sizeBytes: -1 },
    { checksum: hash('x'), sizeBytes: 0.5 },
    { checksum: hash('x'), sizeBytes: Number.NaN },
    { checksum: hash('x'), sizeBytes: 1024 ** 3 + 1 }
  ])(
    'rejects malformed Main expected content before pending writes: %j',
    async (expectedContent) => {
      const f = await setup()
      const pending = vi.spyOn(f.compatibilityRepository, 'withPendingFileTransaction')
      await expect(
        f.repository.saveVersion(
          {
            ...saveBinding(f.binding),
            writeOperationId: 'invalid-expected',
            filename: 'result.txt',
            source: {
              kind: 'inline',
              content: Buffer.from('x').toString('base64'),
              encoding: 'base64'
            }
          },
          { allowedImportRoots: [], expectedContent: expectedContent as never }
        )
      ).rejects.toThrow('requires a SHA-256 checksum and a bounded size')
      expect(pending).not.toHaveBeenCalled()
      expect(await f.client.artifactVersion.count()).toBe(0)
    }
  )
})

describe('complete Artifact save over the production local RPC', () => {
  it('delivers bounded redacted diagnostics with the committed Version identity over RPC and MCP', async () => {
    const f = await setup()
    const env = await f.environment()
    vi.spyOn(
      f.repository as unknown as { toArtifactVersionFile: () => Promise<never> },
      'toArtifactVersionFile'
    ).mockRejectedValueOnce(
      new Error(
        'projection failed password="ARTIFACT_SECRET"\n' + 'x'.repeat(20_000) + '\nprojection tail'
      )
    )
    const error = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'receipt.txt',
      content: 'saved bytes'
    }).then(
      () => {
        throw new Error('Expected projection failure')
      },
      (failure: Error) => failure
    )
    const committed = await f.client.artifactVersion.findFirstOrThrow()
    expect(committed.state).toBe('pending')
    expect(error.message).toContain(committed.id)
    expect(error.message).toContain('committed as pending')
    expect(error.message).toContain('not yet a finalized Artifact')
    expect(error.message).toMatch(/do not.*repeat/i)
    expect(error.message).toContain('projection failed')
    expect(error.message).toContain('projection tail')
    expect(error.message).toContain('[redacted]')
    expect(error.message).toContain('[diagnostic truncated]')
    expect(error.message).not.toContain('ARTIFACT_SECRET')
    expect(error.message.length).toBeLessThan(2_100)
  })

  it('saves five mixed files on their first concurrent calls without MCP pending writes', async () => {
    const f = await setup()
    const workspace = join(f.storageRoot, 'workspace')
    await mkdir(workspace)
    const env = await f.environment({ allowedImportRoots: [workspace], workspaceCwd: workspace })
    const pendingSpy = vi.spyOn(f.compatibilityRepository, 'withPendingFileTransaction')
    const calls = Array.from({ length: 5 }, (_, i) => ({
      filename: `report-${i}.txt`,
      content: `report ${i}`
    }))
    await Promise.all(calls.map((c) => writeFile(join(workspace, c.filename), c.content)))
    const results = await Promise.all(
      calls.map((c, i) =>
        writeArtifactFileForCurrentRun(
          // A separate repository makes any accidental MCP write observable.
          {
            withPendingFileTransaction: () => {
              throw new Error('MCP wrote pending')
            }
          } as never,
          env,
          i % 2 ? { filename: c.filename, source: { kind: 'localPath', path: c.filename } } : c,
          { requestId: i }
        )
      )
    )
    expect(pendingSpy).toHaveBeenCalledTimes(5)
    expect(await f.client.artifactVersion.count()).toBe(5)
    for (let i = 0; i < results.length; i++) {
      expect(await readFile(results[i].path, 'utf8')).toBe(calls[i].content)
      expect(results[i]).toMatchObject({
        checksum: hash(calls[i].content),
        sessionId: 'session-1',
        runId: 'artifact-run-1'
      })
    }
  })

  it('replays after local source deletion and rejects changed inline content without touching a newer version', async () => {
    const f = await setup()
    const workspace = join(f.storageRoot, 'workspace')
    await mkdir(workspace)
    const env = await f.environment({ allowedImportRoots: [workspace], workspaceCwd: workspace })
    const path = join(workspace, 'report.txt')
    await writeFile(path, 'local')
    const input = { filename: 'report.txt', source: { kind: 'localPath' as const, path } }
    const first = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, input, {
      requestId: 'local'
    })
    await rm(path)
    expect(
      await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, input, {
        requestId: 'local'
      })
    ).toEqual(first)
    const inline = { filename: 'same.txt', content: 'original' }
    const original = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, inline, {
      requestId: 'inline'
    })
    const newer = await writeArtifactFileForCurrentRun(
      f.compatibilityRepository,
      env,
      { ...inline, content: 'newer' },
      { requestId: 'newer' }
    )
    await expect(
      writeArtifactFileForCurrentRun(
        f.compatibilityRepository,
        env,
        { ...inline, content: 'conflict' },
        { requestId: 'inline' }
      )
    ).rejects.toThrow(/reused/)
    expect(
      await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, inline, {
        requestId: 'inline'
      })
    ).toEqual(original)
    expect(await readFile(newer.path, 'utf8')).toBe('newer')
    expect(await f.client.artifactVersion.count()).toBe(3)
  })

  it('cancels queued work promptly, drains accepted saves, and serializes another repository instance', async () => {
    const f = await setup()
    const env = await f.environment()
    const entered = deferred()
    const proceed = deferred()
    const reserve = ArtifactWriteBudgetOwner.prototype.reserve
    let reservations = 0
    vi.spyOn(ArtifactWriteBudgetOwner.prototype, 'reserve').mockImplementation(async function (
      this: ArtifactWriteBudgetOwner,
      request
    ) {
      reservations++
      if (reservations === 1) {
        entered.resolve()
        await proceed.promise
      }
      return reserve.call(this, request)
    })
    const first = writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'first.txt',
      content: 'first'
    })
    await entered.promise
    const queuedEntered = deferred()
    const save = f.repository.saveVersion.bind(f.repository)
    vi.spyOn(f.repository, 'saveVersion').mockImplementation((request, scope, signal) => {
      const result = save(request, scope, signal)
      if (request.filename === 'cancel.txt') queuedEntered.resolve()
      return result
    })
    const controller = new AbortController()
    const queued = writeArtifactFileForCurrentRun(
      f.compatibilityRepository,
      env,
      { filename: 'cancel.txt', content: 'cancel' },
      { signal: controller.signal }
    )
    const cancelled = expect(queued).rejects.toThrow()
    await queuedEntered.promise
    controller.abort()
    await cancelled
    await expect(queued).rejects.toThrow()
    const other = new ArtifactProvenanceRepository(f.repositoryOptions)
    const app = other.writeAppGeneratedVersion({
      ...f.binding,
      messageBranchAncestry: undefined,
      messageAncestry: undefined,
      filename: 'app.txt',
      content: 'app'
    })
    const context = JSON.parse(await readFile(env.currentRunFile, 'utf8'))
    let drained = false
    const drain = f.server.revokeArtifactRunCapability(context.rpcCapabilityToken).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(reservations).toBe(1)
    proceed.resolve()
    await Promise.all([first, app, drain])
    expect(reservations).toBe(2)
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
        filename: 'late.txt',
        content: 'late'
      })
    ).rejects.toThrow(/Invalid/)
    expect(await f.client.artifactVersion.count()).toBe(2)
  })
  it('restores an overwritten file and metadata on pre-commit failure before the next budget check', async () => {
    const f = await setup()
    const env = await f.environment()
    const first = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'same.txt',
      content: 'old content'
    })
    const pending = join(
      f.storageRoot,
      'artifacts/project-1/artifact-session-1/.pending/artifact-run-1/same.txt'
    )
    const before = await readFile(pending)
    const sync = defaultArtifactDurability.syncFile
    let fail = true
    vi.spyOn(defaultArtifactDurability, 'syncFile').mockImplementation(async (path) => {
      if (fail && path.includes('.staging') && path.endsWith('content')) {
        fail = false
        throw new Error('injected pre-commit failure')
      }
      return sync(path)
    })
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
        filename: 'same.txt',
        content: 'x'
      })
    ).rejects.toThrow('injected')
    expect(await readFile(pending)).toEqual(before)
    expect(
      (
        await f.compatibilityRepository.listPendingRunFiles({
          projectId: 'project-1',
          sessionId: 'artifact-session-1',
          runId: 'artifact-run-1'
        })
      )[0]
    ).toMatchObject({ versionId: first.versionId })
    await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'next.txt',
      content: 'next'
    })
    expect(await f.client.artifactVersion.count()).toBe(2)
  })

  it('cancels an active bounded copy, rolls back, and lets the following save execute', async () => {
    const f = await setup()
    const workspace = join(f.storageRoot, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'source.txt'), 'bounded source')
    const env = await f.environment({ allowedImportRoots: [workspace], workspaceCwd: workspace })
    const entered = deferred()
    const release = deferred()
    const aborted = deferred()
    const controller = new AbortController()
    const copy = boundedIo.copyOpenFileWithinBudget
    vi.spyOn(boundedIo, 'copyOpenFileWithinBudget').mockImplementationOnce(async (...args) => {
      args[3]!.addEventListener('abort', () => aborted.resolve(), { once: true })
      entered.resolve()
      await release.promise
      return copy(...args)
    })
    const context = JSON.parse(await readFile(env.currentRunFile, 'utf8'))
    const save = writeArtifactFileForCurrentRun(
      f.compatibilityRepository,
      env,
      { filename: 'copy.txt', source: { kind: 'localPath', path: 'source.txt' } },
      { signal: controller.signal }
    )
    await entered.promise
    const rejected = expect(save).rejects.toThrow()
    controller.abort()
    await aborted.promise
    release.resolve()
    await rejected
    await f.server.revokeArtifactRunCapability(context.rpcCapabilityToken)
    expect(await f.client.artifactVersion.count()).toBe(0)
    expect(
      await f.compatibilityRepository.listPendingRunFiles({
        projectId: context.projectId,
        sessionId: context.artifactStorageSessionId,
        runId: context.artifactRunId
      })
    ).toEqual([])
    const newEnv = await f.environment()
    // ensureStarted rotates transport after close, so use the new live endpoint.
    const connection = await f.server.ensureStarted()
    await writeArtifactFileForCurrentRun(
      f.compatibilityRepository,
      { ...newEnv, rpcEndpoint: connection.endpoint },
      { filename: 'after.txt', content: 'after' }
    )
  })

  it('preserves durable staging bytes after cancellation and recovers the original operation', async () => {
    const f = await setup()
    const env = await f.environment()
    const controller = new AbortController()
    const save = f.repository.saveVersion.bind(f.repository)
    vi.spyOn(f.repository, 'saveVersion').mockImplementationOnce((request, scope, signal) =>
      save(request, scope, AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]))
    )
    const sync = defaultArtifactDurability.syncFile
    let fail = true
    vi.spyOn(defaultArtifactDurability, 'syncFile').mockImplementation(async (path) => {
      await sync(path)
      if (fail && path.includes('.staging') && path.endsWith('evidence.json')) {
        fail = false
        controller.abort(new Error('cancel at durable staging'))
      }
    })
    const input = { filename: 'staged.txt', content: 'recoverable' }
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, env, input, {
        requestId: 'staging'
      })
    ).rejects.toThrow(/aborted/)
    expect(await f.client.artifactVersion.findFirst()).toMatchObject({ state: 'staging' })
    const restored = new ArtifactProvenanceRepository(f.repositoryOptions)
    await restored.reconcileSession('project-1', 'session-1')
    const replay = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, input, {
      requestId: 'staging'
    })
    expect(await readFile(replay.path, 'utf8')).toBe('recoverable')
    expect(await f.client.artifactVersion.count()).toBe(1)
  })

  it('rejects the seventeenth accepted session request and recovers admission after queued cancellations', async () => {
    const f = await setup()
    const env = await f.environment()
    const context = JSON.parse(await readFile(env.currentRunFile, 'utf8'))
    const entered = deferred()
    const release = deferred()
    const allEntered = deferred()
    const reserve = ArtifactWriteBudgetOwner.prototype.reserve
    vi.spyOn(ArtifactWriteBudgetOwner.prototype, 'reserve').mockImplementationOnce(async function (
      this: ArtifactWriteBudgetOwner,
      request
    ) {
      entered.resolve()
      await release.promise
      return reserve.call(this, request)
    })
    let count = 0
    const save = f.repository.saveVersion.bind(f.repository)
    vi.spyOn(f.repository, 'saveVersion').mockImplementation((...args) => {
      const result = save(...args)
      if (++count === 16) allEntered.resolve()
      return result
    })
    const first = writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'first.txt',
      content: 'first'
    })
    await entered.promise
    const aborts = Array.from({ length: 15 }, () => new AbortController())
    const queued = aborts.map((abort, i) =>
      writeArtifactFileForCurrentRun(
        f.compatibilityRepository,
        env,
        { filename: `queue-${i}.txt`, content: 'queued' },
        { signal: abort.signal }
      ).catch((error) => error)
    )
    await allEntered.promise
    const response = await fetch(env.rpcEndpoint!, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.rpcCapabilityToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ method: 'artifactSaveVersion', params: {} })
    })
    expect(response.status).toBe(429)
    expect(await response.text()).toContain('ARTIFACT_SAVE_RESOURCE_LIMIT')
    aborts.forEach((abort) => abort.abort())
    await Promise.all(queued)
    release.resolve()
    await first
    await f.server.revokeArtifactRunCapability(context.rpcCapabilityToken)
    const fresh = await f.environment()
    await writeArtifactFileForCurrentRun(f.compatibilityRepository, fresh, {
      filename: 'reclaimed.txt',
      content: 'ok'
    })
    expect(await f.client.artifactVersion.count()).toBe(2)
  })

  it('resolves prepared literature in main, checks its digest, and gives explicit literature precedence', async () => {
    const f = await setup()
    const workspace = join(f.storageRoot, 'workspace')
    await mkdir(workspace)
    const env = await f.environment({ allowedImportRoots: [workspace], workspaceCwd: workspace })
    await f.client.literatureItem.create({
      data: { id: 'paper', title: 'A cited paper', itemType: 'journalArticle' }
    })
    const bytes = Buffer.from(zipSync({ 'main.tex': strToU8('Scientific report') }))
    const path = join(workspace, 'report.zip')
    await writeFile(path, bytes)
    const literature = {
      styleId: 'apa',
      locale: 'en-US',
      citations: [{ citationId: 'cite-1', itemId: 'paper' }]
    }
    const sidecar = {
      schemaVersion: 1,
      contentChecksum: createHash('sha256').update(bytes).digest('hex'),
      literature
    }
    await writeFile(path + ARTIFACT_LITERATURE_SIDECAR_SUFFIX, JSON.stringify(sidecar))
    const input = { filename: 'report.zip', source: { kind: 'localPath' as const, path } }
    const result = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, input)
    const row = await f.client.artifactVersion.findUniqueOrThrow({
      where: { id: result.versionId },
      include: { literatureManifest: true }
    })
    expect(row.literatureManifest?.manifestJson).toContain('A cited paper')
    await writeFile(
      path + ARTIFACT_LITERATURE_SIDECAR_SUFFIX,
      JSON.stringify({ ...sidecar, contentChecksum: '0'.repeat(64) })
    )
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, env, input)
    ).rejects.toThrow('Prepared citation metadata does not match')
    await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, { ...input, literature })
    expect(await f.client.artifactVersion.count()).toBe(2)
  })

  it('rejects oversized prepared sidecars before pending mutation and leaves the next save usable', async () => {
    const f = await setup()
    const workspace = join(f.storageRoot, 'workspace')
    await mkdir(workspace)
    const env = await f.environment({ allowedImportRoots: [workspace], workspaceCwd: workspace })
    const path = join(workspace, 'report.zip')
    await writeFile(path, 'source')
    const sidecar = path + ARTIFACT_LITERATURE_SIDECAR_SUFFIX
    await writeFile(sidecar, '')
    await truncate(sidecar, 64 * 1024 ** 2 + 1)
    const reserve = vi.spyOn(ArtifactWriteBudgetOwner.prototype, 'reserve')
    const pending = vi.spyOn(f.compatibilityRepository, 'withPendingFileTransaction')
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
        filename: 'report.zip',
        source: { kind: 'localPath', path }
      })
    ).rejects.toThrow(/request budget exceeded/)
    expect(reserve).not.toHaveBeenCalled()
    expect(pending).not.toHaveBeenCalled()
    expect(await f.client.artifactVersion.count()).toBe(0)
    await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'after-sidecar.txt',
      content: 'ok'
    })
    expect(await f.client.artifactVersion.count()).toBe(1)
  })

  it('transports 32 MiB of UTF-8 controls as base64 and preserves the existing request checksum', async () => {
    const f = await setup()
    const env = await f.environment()
    const content = '\u0000'.repeat(32 * 1024 ** 2)
    const result = await writeArtifactFileForCurrentRun(
      f.compatibilityRepository,
      env,
      { filename: 'controls.bin', content },
      { requestId: 'controls' }
    )
    expect(result.size).toBe(32 * 1024 ** 2)
    const row = await f.client.artifactVersion.findUniqueOrThrow({
      where: { id: result.versionId }
    })
    expect(row.writeRequestChecksum).toBe(
      hash(
        JSON.stringify({
          contentChecksum: hash(content),
          contentType: null,
          filename: 'controls.bin',
          producerRunId: null,
          literature: null,
          sourceKind: 'inline',
          sourceFileObservation: null
        })
      )
    )
    expect(
      await writeArtifactFileForCurrentRun(
        f.compatibilityRepository,
        env,
        {
          filename: 'controls.bin',
          source: {
            kind: 'inline',
            content: Buffer.from(content).toString('base64'),
            encoding: 'base64'
          }
        },
        { requestId: 'controls' }
      )
    ).toEqual(result)
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
        filename: 'too-big.bin',
        content: content + 'x'
      })
    ).rejects.toThrow(/budget/)
    // The decoded content fits, but the complete request including metadata must still fit.
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
        filename: 'metadata-too-big.bin',
        content,
        mimeType: 'x'.repeat(22 * 1024 ** 2)
      })
    ).rejects.toThrow(/request.*budget/)
    expect(await f.client.artifactVersion.count()).toBe(1)
  })

  it('rejects caller-provided roots and scope changes while another session can make progress', async () => {
    const f = await setup()
    const workspace = join(f.storageRoot, 'workspace')
    await mkdir(workspace)
    const outside = join(f.storageRoot, 'outside.txt')
    await writeFile(outside, 'secret')
    const env = await f.environment({ allowedImportRoots: [workspace], workspaceCwd: workspace })
    await expect(
      writeArtifactFileForCurrentRun(
        f.compatibilityRepository,
        { ...env, allowedImportRoots: [f.storageRoot] },
        { filename: 'outside.txt', source: { kind: 'localPath', path: outside } }
      )
    ).rejects.toThrow(/outside allowed/)
    const entered = deferred()
    const release = deferred()
    const locked = f.repository.withSessionMutation(f.binding, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const waiting = writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'wait.txt',
      content: 'wait'
    })
    const other = await f.environment(
      { allowedImportRoots: [] },
      {
        appSessionId: 'other-session',
        artifactStorageSessionId: 'other-storage',
        artifactRunId: 'other-run'
      }
    )
    const otherResult = await writeArtifactFileForCurrentRun(f.compatibilityRepository, other, {
      filename: 'other.txt',
      content: 'other'
    })
    expect(await readFile(otherResult.path, 'utf8')).toBe('other')
    release.resolve()
    await Promise.all([locked, waiting])
  })

  it('keeps old-run final publication ahead of new-run budget scans and retains exact message ownership', async () => {
    const f = await setup()
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'write',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'message-1',
        role: 'agent',
        content: 'done',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages,
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'publication',
      cwd: f.storageRoot,
      status: 'idle',
      messages,
      conversationGraph: graph,
      createdAt: 1,
      updatedAt: 2
    }
    const context = {
      rootFrameId: graph.rootFrameId,
      agentFrameId: graph.activeFrameId,
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: graph.runtimeSegments[0].id,
      promptMessageId: 'prompt-1'
    }
    const env = await f.environment({ allowedImportRoots: [] }, context)
    const first = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'old.txt',
      content: 'old version'
    })
    const oldVersions = [
      first,
      ...(await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
            filename: `old-${i}.txt`,
            content: `old ${i}`
          })
        )
      ))
    ]
    const provenance = new ArtifactProvenanceRepository({
      ...f.repositoryOptions,
      loadSession: async () => session
    })
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactSessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      ...context,
      artifactVersionIds: oldVersions.map((version) => version.versionId)
    })
    const handlers = createArtifactHandlers(f.compatibilityRepository, registry, { provenance })
    const entered = deferred()
    const release = deferred()
    const publish = f.compatibilityRepository.finalizeRunArtifacts.bind(f.compatibilityRepository)
    vi.spyOn(f.compatibilityRepository, 'finalizeRunArtifacts').mockImplementationOnce(
      async (request) => {
        entered.resolve()
        await release.promise
        return publish(request)
      }
    )
    const finalization = handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    await entered.promise
    const nextEntered = deferred()
    let budgetStarted = false
    const reserve = ArtifactWriteBudgetOwner.prototype.reserve
    vi.spyOn(ArtifactWriteBudgetOwner.prototype, 'reserve').mockImplementation(async function (
      this: ArtifactWriteBudgetOwner,
      request
    ) {
      budgetStarted = true
      return reserve.call(this, request)
    })
    const save = f.repository.saveVersion.bind(f.repository)
    vi.spyOn(f.repository, 'saveVersion').mockImplementation((...args) => {
      const result = save(...args)
      nextEntered.resolve()
      return result
    })
    const nextEnv = await f.environment(
      { allowedImportRoots: [] },
      { ...context, artifactRunId: 'next-run' }
    )
    const next = writeArtifactFileForCurrentRun(f.compatibilityRepository, nextEnv, {
      filename: 'new.txt',
      content: 'new version'
    })
    await nextEntered.promise
    expect(budgetStarted).toBe(false)
    release.resolve()
    await Promise.all([finalization, next])
    expect(budgetStarted).toBe(true)
    expect(await f.client.artifactVersion.count({ where: { messageId: 'message-1' } })).toBe(5)
    expect(
      await f.client.artifactVersion.findUniqueOrThrow({ where: { id: first.versionId } })
    ).toMatchObject({ state: 'finalized', messageId: 'message-1' })
    expect(
      await readFile(join(f.storageRoot, 'artifacts/project-1/session-1/message-1/old.txt'), 'utf8')
    ).toBe('old version')
    expect(
      (await f.client.artifactVersion.findMany({ where: { artifactRunId: 'next-run' } }))[0]
    ).toMatchObject({ state: 'pending', messageId: null })
  })

  it('keeps case and Unicode normalized names in one lineage under concurrent saves', async () => {
    const f = await setup()
    const env = await f.environment()
    const results = await Promise.all(
      ['Caf\u00e9.txt', 'cafe\u0301.TXT'].map((filename, i) =>
        writeArtifactFileForCurrentRun(
          f.compatibilityRepository,
          env,
          { filename, content: `version ${i}` },
          { requestId: i }
        )
      )
    )
    expect(new Set(results.map((result) => result.artifactId)).size).toBe(1)
    expect(results.map((result) => result.versionNumber).sort()).toEqual([1, 2])
    expect(await readFile(results[0].path, 'utf8')).toBe('version 0')
    expect(await readFile(results[1].path, 'utf8')).toBe('version 1')
  })
  it('uses the captured run source scope even when current-run changes while queued', async () => {
    const f = await setup()
    const originalRoot = join(f.storageRoot, 'original')
    const replacementRoot = join(f.storageRoot, 'replacement')
    await Promise.all([mkdir(originalRoot), mkdir(replacementRoot)])
    await writeFile(join(originalRoot, 'source.txt'), 'original source')
    await writeFile(join(replacementRoot, 'source.txt'), 'replacement source')
    const env = await f.environment({
      allowedImportRoots: [originalRoot],
      workspaceCwd: originalRoot
    })
    const entered = deferred()
    const release = deferred()
    const accepted = deferred()
    const lock = f.repository.withSessionMutation(f.binding, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const save = f.repository.saveVersion.bind(f.repository)
    vi.spyOn(f.repository, 'saveVersion').mockImplementationOnce((...args) => {
      const result = save(...args)
      accepted.resolve()
      return result
    })
    const waiting = writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'output.txt',
      source: { kind: 'localPath', path: 'source.txt' }
    })
    await accepted.promise
    const replacement = await f.environment(
      { allowedImportRoots: [replacementRoot], workspaceCwd: replacementRoot },
      { artifactRunId: 'replacement-run' }
    )
    await writeFile(env.currentRunFile, await readFile(replacement.currentRunFile))
    release.resolve()
    await lock
    const result = await waiting
    expect(result.runId).toBe('artifact-run-1')
    expect(await readFile(result.path, 'utf8')).toBe('original source')
  })
  it('enforces turn and session budgets for first-attempt concurrent saves without leaking reservations', async () => {
    const f = await setup()
    const bounded = new ArtifactProvenanceRepository({
      ...f.repositoryOptions,
      resourceBudgets: { artifactTurnBytes: 8, artifactSessionBytes: 12 }
    })
    vi.spyOn(f.repository, 'saveVersion').mockImplementation((...args) =>
      bounded.saveVersion(...args)
    )
    const env = await f.environment()
    const result = await Promise.allSettled(
      ['aaaaaa', 'bbbbbb'].map((content, i) =>
        writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
          filename: `bounded-${i}.txt`,
          content
        })
      )
    )
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter((item) => item.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          message: expect.stringContaining('turn budget exceeded')
        })
      })
    ])
    const next = await f.environment(
      { allowedImportRoots: [] },
      { artifactRunId: 'next-budget-run' }
    )
    await writeArtifactFileForCurrentRun(f.compatibilityRepository, next, {
      filename: 'next.txt',
      content: 'cccccc'
    })
    const last = await f.environment(
      { allowedImportRoots: [] },
      { artifactRunId: 'last-budget-run' }
    )
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, last, {
        filename: 'over.txt',
        content: 'd'
      })
    ).rejects.toThrow('session budget exceeded')
    expect(await f.client.artifactVersion.count()).toBe(2)
  })
})
