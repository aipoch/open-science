import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import type { ArtifactFile, ArtifactWriteSource } from '../../shared/artifacts'
import { createPngBytes, createPngInlineSource } from './artifact-test-fixtures'
import { ArtifactRepository } from './repository'
import {
  createArtifactHandlers,
  createDefaultArtifactRepository,
  registerArtifactIpcHandlers
} from './ipc'
import { ArtifactRunRegistry } from './run-registry'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

// Capture every ipcMain.handle registration so registerArtifactIpcHandlers can be verified directly.
// The mock is set up here (before importing the IPC module) so registering handlers in tests is
// observable without depending on a real Electron process.
const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      ipcHandlers.set(channel, handler)
    }
  },
  shell: { openPath: vi.fn().mockResolvedValue('') },
  dialog: { showMessageBoxSync: vi.fn() }
}))

// Lock the data root to a known path so createDefaultArtifactRepository is testable in isolation.
// Existing tests don't touch the data-root resolver — they construct ArtifactRepository directly
// with a tempdir — so this stub doesn't affect their setup.
const ARTIFACT_DATA_ROOT = '/tmp/open-science-artifact-data-root'
vi.mock('../storage-root', () => ({
  resolveDataRoot: () => ARTIFACT_DATA_ROOT,
  resolveStorageRoot: () => '/tmp/open-science-artifact-config-root'
}))

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-ipc-'))
  return storageRoot
}

const createInlineSource = (
  content: string,
  encoding: 'utf8' | 'base64' = 'utf8'
): ArtifactWriteSource => ({
  kind: 'inline' as const,
  content,
  encoding
})

afterEach(async () => {
  clearMigrationPending()
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

// Reset the captured-IPC map between tests so registerArtifactIpcHandlers does not see
// registrations from a prior test case. Individual tests re-register as needed.
beforeEach(() => {
  ipcHandlers.clear()
})

describe('artifact IPC handlers', () => {
  const createFinalizedArtifact = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
    id: 'session-1:message-1:result.txt',
    projectName: 'default-project',
    sessionId: 'session-1',
    messageId: 'message-1',
    name: 'result.txt',
    path: '/tmp/result.txt',
    fileUrl: 'file:///tmp/result.txt',
    size: 2,
    mtimeMs: 1710000000000,
    ...overrides
  })

  it('finalizes pending files and lists message files through the repository', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const runRegistry = new ArtifactRunRegistry()
    const handlers = createArtifactHandlers(repository, runRegistry)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })

    const claimId = runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })

    const finalized = await handlers.finalizeRunArtifacts({
      claimId,
      messageId: 'message-1'
    })
    const listed = await repository.listMessageFiles({
      projectName: 'default-project',
      sessionId: 'session-1',
      messageId: 'message-1'
    })

    expect(finalized.map((file) => file.name)).toEqual(['result.txt'])
    expect(listed).toEqual(finalized)
  })

  it('serializes concurrent finalize requests for the same claim', async () => {
    const finalizedArtifact = createFinalizedArtifact()
    let releaseFinalize: (() => void) | undefined
    const repository = {
      finalizeRunArtifacts: vi.fn(
        () =>
          new Promise<ArtifactFile[]>((resolve) => {
            releaseFinalize = () => resolve([finalizedArtifact])
          })
      ),
      listMessageFiles: vi.fn().mockResolvedValue([finalizedArtifact])
    } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()
    const handlers = createArtifactHandlers(repository, runRegistry)
    const claimId = runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })

    const firstFinalize = handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    const secondFinalize = handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })

    await Promise.resolve()

    expect(repository.finalizeRunArtifacts).toHaveBeenCalledTimes(1)

    releaseFinalize?.()

    await expect(Promise.all([firstFinalize, secondFinalize])).resolves.toEqual([
      [finalizedArtifact],
      [finalizedArtifact]
    ])
    expect(repository.listMessageFiles).toHaveBeenCalledTimes(1)
  })

  it('finalizes compatibility files and provenance inside the shared Session mutation', async () => {
    const finalizedArtifact = createFinalizedArtifact()
    const callOrder: string[] = []
    const repository = {
      finalizeRunArtifacts: vi.fn(async () => {
        callOrder.push('compatibility')
        return [finalizedArtifact]
      })
    } as unknown as ArtifactRepository
    const provenance = {
      validateFinalizationOwnership: vi.fn(async () => {
        callOrder.push('preflight')
      }),
      finalizeRun: vi.fn(async () => {
        callOrder.push('sqlite')
        return [finalizedArtifact]
      })
    }
    const mutationScopes: Array<{ projectId: string; sessionId: string }> = []
    const withSessionMutation = async <Result>(
      projectId: string,
      sessionId: string,
      mutation: () => Promise<Result>
    ): Promise<Result> => {
      mutationScopes.push({ projectId, sessionId })
      return mutation()
    }
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      messageBranchAncestry: ['branch-parent', 'branch-1'],
      messageAncestry: ['prompt-1', 'message-1'],
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1'
    })
    const handlers = createArtifactHandlers(repository, registry, {
      provenance: provenance as never,
      withSessionMutation
    })

    await handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })

    expect(mutationScopes).toEqual([{ projectId: 'default-project', sessionId: 'session-1' }])
    expect(callOrder).toEqual(['preflight', 'compatibility', 'sqlite'])
    expect(provenance.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-1',
        promptMessageId: 'prompt-1'
      })
    )
    expect(provenance.finalizeRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageAncestry: expect.anything() })
    )
  })

  it('does not move compatibility files when durable provenance ownership is rejected', async () => {
    const repository = {
      finalizeRunArtifacts: vi.fn()
    } as unknown as ArtifactRepository
    const provenance = {
      validateFinalizationOwnership: vi
        .fn()
        .mockRejectedValue(new Error('durable Session graph rejected message')),
      finalizeRun: vi.fn()
    }
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1'
    })
    const handlers = createArtifactHandlers(repository, registry, {
      provenance: provenance as never
    })

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-forged' })
    ).rejects.toThrow(/durable Session graph/i)
    expect(repository.finalizeRunArtifacts).not.toHaveBeenCalled()
    expect(provenance.finalizeRun).not.toHaveBeenCalled()
    expect(registry.resolve(claimId).finalizedMessageId).toBeUndefined()
  })

  it('leaves a recoverable compatibility marker when SQLite finalization fails', async () => {
    const finalizedArtifact = createFinalizedArtifact()
    const repository = {
      finalizeRunArtifacts: vi.fn().mockResolvedValue([finalizedArtifact])
    } as unknown as ArtifactRepository
    const provenance = {
      validateFinalizationOwnership: vi.fn().mockResolvedValue(undefined),
      finalizeRun: vi.fn().mockRejectedValue(new Error('SQLite unavailable'))
    }
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1'
    })
    const handlers = createArtifactHandlers(repository, registry, {
      provenance: provenance as never
    })

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    ).rejects.toThrow(/SQLite unavailable/)
    expect(repository.finalizeRunArtifacts).toHaveBeenCalledOnce()
    expect(provenance.finalizeRun).toHaveBeenCalledOnce()
    expect(registry.resolve(claimId).finalizedMessageId).toBeUndefined()
  })

  it('keeps migration drain pending until an artifact finalization already in progress finishes', async () => {
    let releaseFinalize: (() => void) | undefined
    const repository = {
      finalizeRunArtifacts: vi.fn(
        () =>
          new Promise<ArtifactFile[]>((resolve) => {
            releaseFinalize = () => resolve([createFinalizedArtifact()])
          })
      )
    } as unknown as ArtifactRepository
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })
    const handlers = createArtifactHandlers(repository, registry)

    const finalizePromise = handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    releaseFinalize?.()
    await finalizePromise
    await drainPromise
    expect(drained).toBe(true)
  })

  it('opens only files inside the managed artifact root', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const openPath = vi.fn().mockResolvedValue('')
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry(), { openPath })
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })

    await handlers.openFile({ path: artifact.path })

    expect(openPath).toHaveBeenCalledWith(await realpath(artifact.path))
    await expect(handlers.openFile({ path: join(tmpdir(), 'outside.txt') })).rejects.toThrow(
      /outside artifact storage/
    )
  })

  it('reads only bounded preview text from managed artifact files', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('alpha\nbeta\ngamma')
    })

    await expect(handlers.readPreview({ path: artifact.path, maxBytes: 10 })).resolves.toEqual({
      content: 'alpha\nbeta',
      encoding: 'utf8',
      size: 16,
      truncated: true
    })
  })

  it('reads bounded base64 previews for small managed image artifacts', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'pixel.png',
      source: createPngInlineSource('png-bytes'),
      mimeType: 'image/png'
    })

    await expect(
      handlers.readPreview({ path: artifact.path, maxBytes: 1024, encoding: 'base64' })
    ).resolves.toEqual({
      content: createPngBytes('png-bytes').toString('base64'),
      encoding: 'base64',
      size: createPngBytes('png-bytes').length,
      truncated: false
    })
  })

  it('rejects invalid preview encodings from renderer IPC input', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('alpha')
    })

    await expect(
      handlers.readPreview({ path: artifact.path, encoding: 'hex' as 'utf8' })
    ).rejects.toThrow(/Invalid artifact preview encoding/)
  })

  it('rejects preview reads outside the managed artifact root', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())

    await expect(handlers.readPreview({ path: join(tmpdir(), 'outside.txt') })).rejects.toThrow(
      /outside artifact storage/
    )
  })

  it('rejects unknown artifact finalize claims', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())

    await expect(
      handlers.finalizeRunArtifacts({
        claimId: 'missing-claim',
        messageId: 'message-1'
      })
    ).rejects.toThrow(/Artifact run claim not found/)
  })

  it('allows finalize replay only for the original message owner', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const runRegistry = new ArtifactRunRegistry()
    const handlers = createArtifactHandlers(repository, runRegistry)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })
    const claimId = runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })

    await handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-2' })
    ).rejects.toThrow(/already finalized/)
    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'result.txt',
        messageId: 'message-1'
      })
    ])
  })

  it('does not expose message file listing as a renderer IPC handler', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())

    expect('listMessageFiles' in handlers).toBe(false)
  })

  it('excludes both prompt-active runs and unfinalized claims from the orphan scan', async () => {
    const listProjectArtifacts = vi.fn().mockResolvedValue([])
    const repository = { listProjectArtifacts } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()

    // A run whose files were emitted and are awaiting the renderer's finalize call — it has left the
    // runtime's prompt-active set but must still be treated as in-flight, not orphaned.
    runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-awaiting-finalize'
    })

    const handlers = createArtifactHandlers(repository, runRegistry, {
      getActiveArtifactRunIds: () => ['run-in-prompt']
    })

    await handlers.listProjectFiles({ projectName: 'default-project' })

    const passedSet = listProjectArtifacts.mock.calls[0][1] as Set<string>
    expect([...passedSet].sort()).toEqual(['run-awaiting-finalize', 'run-in-prompt'])
  })

  it('drops a run from the exclusion set once its claim is finalized', async () => {
    const listProjectArtifacts = vi.fn().mockResolvedValue([])
    const repository = { listProjectArtifacts } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()
    const claimId = runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-done'
    })
    runRegistry.markFinalized(claimId, 'message-1')

    const handlers = createArtifactHandlers(repository, runRegistry)
    await handlers.listProjectFiles({ projectName: 'default-project' })

    const passedSet = listProjectArtifacts.mock.calls[0][1] as Set<string>
    expect(passedSet.has('run-done')).toBe(false)
  })
})

describe('artifact IPC handler registration', () => {
  it('creates the default repository rooted at the data root', () => {
    // Line 139: createDefaultArtifactRepository must use resolveDataRoot (artifacts follow the
    // relocatable data root), not the config root. Smoke-check the constructor wiring by reading the
    // private `storageRoot` field the constructor assigns. Do NOT default to ARTIFACT_DATA_ROOT when
    // the field is missing — that would hide a regression where someone passes the config root or
    // stops forwarding resolveDataRoot() entirely.
    const repository = createDefaultArtifactRepository()

    expect(repository).toBeInstanceOf(ArtifactRepository)
    const storedRoot = (repository as unknown as { storageRoot: string }).storageRoot
    expect(storedRoot).toBe(ARTIFACT_DATA_ROOT)
  })

  it('registers every renderer-visible artifact channel exactly once', () => {
    registerArtifactIpcHandlers()

    // Every command and Provenance query must be registered. Anything missing here is invisible to
    // the renderer — a regression we want to catch.
    expect([...ipcHandlers.keys()].sort()).toEqual([
      'artifacts:finalize-run',
      'artifacts:get-lineage',
      'artifacts:get-version-execution',
      'artifacts:get-version-messages',
      'artifacts:get-version-provenance',
      'artifacts:get-version-review',
      'artifacts:list-project-files',
      'artifacts:open-file',
      'artifacts:read-preview',
      'artifacts:reconcile-pending'
    ])
  })

  it('delegates each registered channel to the matching handler implementation', async () => {
    // Register with lightweight repositories whose methods are spies — this exercises the entire
    // ipcMain.handle -> createArtifactHandlers -> method chain for every channel.
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([])
    const listProjectArtifacts = vi.fn().mockResolvedValue([])
    const reconcilePendingArtifactPaths = vi.fn().mockResolvedValue([])
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/inside.txt')
    const readManagedFilePreview = vi.fn().mockResolvedValue({
      content: 'preview',
      encoding: 'utf8',
      size: 7,
      truncated: false
    })
    const repository = {
      finalizeRunArtifacts,
      listProjectArtifacts,
      reconcilePendingArtifactPaths,
      resolveManagedFilePath,
      readManagedFilePreview
    } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()
    const claimId = runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })
    registerArtifactIpcHandlers(repository, runRegistry)

    await ipcHandlers.get('artifacts:finalize-run')?.(
      {},
      {
        claimId,
        messageId: 'message-1'
      }
    )
    expect(finalizeRunArtifacts).toHaveBeenCalledWith({
      projectName: 'default-project',
      sourceSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    await ipcHandlers.get('artifacts:list-project-files')?.(
      {},
      {
        projectName: 'default-project'
      }
    )
    expect(listProjectArtifacts).toHaveBeenCalledWith('default-project', expect.any(Set))

    await ipcHandlers.get('artifacts:reconcile-pending')?.(
      {},
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        messageId: 'message-1',
        pendingPaths: ['/p/.pending/run-1/a.txt']
      }
    )
    expect(reconcilePendingArtifactPaths).toHaveBeenCalledWith({
      projectName: 'default-project',
      sessionId: 'session-1',
      messageId: 'message-1',
      pendingPaths: ['/p/.pending/run-1/a.txt']
    })

    await ipcHandlers.get('artifacts:open-file')?.({}, { path: '/managed/inside.txt' })
    expect(resolveManagedFilePath).toHaveBeenCalledWith({ path: '/managed/inside.txt' })

    await ipcHandlers.get('artifacts:read-preview')?.(
      {},
      {
        path: '/managed/inside.txt',
        maxBytes: 16
      }
    )
    expect(readManagedFilePreview).toHaveBeenCalledWith({
      path: '/managed/inside.txt',
      maxBytes: 16
    })
  })

  it('resolves native Version preview locators through Provenance instead of filesystem paths', async () => {
    const root = await createStorageRoot()
    const contentPath = join(root, 'immutable-content')
    await writeFile(contentPath, 'version bytes')
    const readManagedFilePreview = vi.fn()
    const resolveVersionContent = vi.fn().mockResolvedValue({
      path: contentPath,
      filename: 'result.txt',
      contentType: 'text/plain'
    })
    const handlers = createArtifactHandlers(
      { readManagedFilePreview } as unknown as ArtifactRepository,
      new ArtifactRunRegistry(),
      { provenance: { resolveVersionContent } } as never
    )
    const identity = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-2'
    }

    await expect(
      handlers.readPreview({
        path: createArtifactVersionLocator(identity),
        maxBytes: 64
      })
    ).resolves.toMatchObject({ content: 'version bytes', size: 13, truncated: false })
    expect(resolveVersionContent).toHaveBeenCalledWith(identity)
    expect(readManagedFilePreview).not.toHaveBeenCalled()
  })

  it('threads a live getActiveArtifactRunIds closure into list-project-files', async () => {
    // Without getActiveArtifactRunIds the in-flight set defaults to empty. The registry-based
    // unfinalized-claim exclusion is exercised in the main suite; here we pin the runtime-side
    // thread (default vs. supplied) so a regression that loses the dependency is caught.
    const listProjectArtifacts = vi.fn().mockResolvedValue([])
    const repository = { listProjectArtifacts } as unknown as ArtifactRepository
    const activeIds = vi.fn().mockReturnValue(['run-active'])

    registerArtifactIpcHandlers(repository, new ArtifactRunRegistry(), activeIds)
    await ipcHandlers.get('artifacts:list-project-files')?.(
      {},
      {
        projectName: 'default-project'
      }
    )

    expect(activeIds).toHaveBeenCalled()
    const passedSet = listProjectArtifacts.mock.calls[0][1] as Set<string>
    expect([...passedSet]).toEqual(['run-active'])
  })
})

describe('artifact handler edge cases', () => {
  it('throws when the injected openPath returns a non-empty error string', async () => {
    // Lines 88-95: openFile shells out via the (dependency-injected) openPath; a non-empty return
    // value is an OS error message that must be propagated as a thrown Error so the renderer sees it.
    const repository = new ArtifactRepository(await createStorageRoot())
    const openPath = vi.fn().mockResolvedValue('no application is registered for this file type')
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry(), { openPath })
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })

    await expect(handlers.openFile({ path: artifact.path })).rejects.toThrow(
      /no application is registered for this file type/
    )
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('delegates reconcilePendingArtifacts through withDataRootWrite and the repository', async () => {
    // Lines 86-87: reconcilePendingArtifacts wraps the repository call in withDataRootWrite so a
    // pending migration can block it. With no migration pending the gate is transparent and the
    // request reaches the repository verbatim.
    const reconcilePendingArtifactPaths = vi.fn().mockResolvedValue([])
    const repository = { reconcilePendingArtifactPaths } as unknown as ArtifactRepository
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())

    const request = {
      projectName: 'default-project',
      sessionId: 'session-1',
      messageId: 'message-1',
      pendingPaths: ['/p/.pending/run-1/a.txt', '/p/.pending/run-1/b.txt']
    }
    await handlers.reconcilePendingArtifacts(request)

    expect(reconcilePendingArtifactPaths).toHaveBeenCalledWith(request)
  })
})
