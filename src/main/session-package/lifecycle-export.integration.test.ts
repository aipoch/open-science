import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { KernelProcessLifecycleOwner } from '../notebook/kernel-process-lifecycle.windows-posix'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { SessionPackageService } from './service'
import { readPackageArchive } from './archive'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

async function createSessionFixture(): Promise<{
  fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  request: { projectId: string; sessionId: string }
}> {
  const fixture = await createProvenanceTestFixture()
  initDataRoot(fixture.storageRoot)
  const request = { projectId: 'project', sessionId: 'session' }
  await fixture.client.project.create({ data: { id: request.projectId, name: 'Research' } })
  await new SessionRepository(fixture.storageRoot).saveSession({
    id: request.sessionId,
    projectId: request.projectId,
    title: 'Retained research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  return { fixture, request }
}

it('holds a direct package export until its host reservation is ready and releases after publication', async () => {
  const { fixture, request } = await createSessionFixture()
  const ready = Promise.withResolvers<() => void>()
  const release = vi.fn()
  const reserve = vi.fn(async () => ready.promise)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client,
    reserveExport: reserve
  })
  const destination = join(fixture.storageRoot, 'research.science')
  const pending = service.exportTo(request, destination)
  void pending.catch(() => undefined)
  try {
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce())
    expect(reserve.mock.calls[0]).toEqual([request, expect.any(AbortSignal)])
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(release).not.toHaveBeenCalled()
    ready.resolve(release)
    await expect(pending).resolves.toMatchObject({ title: 'Retained research' })
    expect((await stat(destination)).size).toBeGreaterThan(0)
    expect(release).toHaveBeenCalledOnce()
  } finally {
    ready.resolve(release)
    await pending.catch(() => undefined)
    await service.close()
    await fixture.dispose()
  }
})

it('holds a direct fork through child publication with exactly one source reservation', async () => {
  const { fixture, request } = await createSessionFixture()
  const ready = Promise.withResolvers<() => void>()
  let held = false
  const release = vi.fn(() => {
    held = false
  })
  const reserve = vi.fn(async () => {
    held = true
    return ready.promise
  })
  const published = vi.fn(async () => {
    expect(held).toBe(true)
  })
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client,
    reserveExport: reserve,
    onSessionPublished: published
  })
  const pending = service.fork(request)
  void pending.catch(() => undefined)
  try {
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce())
    expect(published).not.toHaveBeenCalled()
    ready.resolve(release)
    const child = await pending
    expect(child).toMatchObject({ projectId: request.projectId })
    expect(child.sessionId).not.toBe(request.sessionId)
    expect(
      await new SessionRepository(fixture.storageRoot).loadSession(child.projectId, child.sessionId)
    ).toMatchObject({ forkOrigin: { sourceSessionId: request.sessionId } })
    expect(published).toHaveBeenCalledOnce()
    expect(reserve).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  } finally {
    ready.resolve(release)
    await pending.catch(() => undefined)
    await service.close()
    await fixture.dispose()
  }
})

it('keeps original Windows process receipts local through package export and cold import', async () => {
  const { fixture, request } = await createSessionFixture()
  const target = await createProvenanceTestFixture()
  const owner = new KernelProcessLifecycleOwner({
    storageRoot: fixture.storageRoot,
    platform: 'win32'
  })
  const intent = owner.beginSpawn(
    { laneKey: 'local-lane', processKey: 'repl', kernelEpochId: 'local-epoch' },
    'local-process-authority',
    {
      path: 'C:/Users/Researcher/.open-science-process-tree-terminated-local-proof.proof',
      token: 'local-proof-authority',
      requestPath:
        'C:/Users/Researcher/.open-science-process-tree-terminated-local-proof.proof.request'
    },
    true
  )
  const receipt = owner.recordSpawned(intent, { pid: 424242, processStartToken: 'local-birth' })
  const original = await readFile(receipt.path, 'utf8')
  const exporter = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  try {
    const archive = join(fixture.storageRoot, 'portable.science')
    await exporter.exportTo(request, archive)
    const expanded = join(fixture.storageRoot, 'expanded')
    await mkdir(expanded)
    await readPackageArchive(archive, expanded, new AbortController().signal)
    const manifest = JSON.parse(await readFile(join(expanded, 'manifest.json'), 'utf8'))
    for (const entry of manifest.inventory) {
      expect(entry.storageKey ?? '').not.toContain('runtime/kernel-processes')
      const bytes = await readFile(join(expanded, entry.path), 'utf8')
      expect(bytes).not.toContain('local-process-authority')
      expect(bytes).not.toContain('local-proof-authority')
      expect(bytes).not.toContain(intent.record.windowsJobName)
    }
    await expect(importer.importFrom(archive)).resolves.toMatchObject({
      projectId: expect.any(String),
      sessionId: expect.any(String)
    })
    await expect(
      stat(join(target.storageRoot, 'runtime', 'kernel-processes'))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(receipt.path, 'utf8')).toBe(original)
  } finally {
    await exporter.close()
    await importer.close()
    await fixture.dispose()
    await target.dispose()
  }
})
