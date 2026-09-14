import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { dialog, shell } from 'electron'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { SessionRepository } from '../session-persistence/repository'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { SessionPackageService } from './service'
import { SessionPackageDesktop } from './desktop'
import { sessionPackageCommandContracts } from '../../shared/session-package'
import * as fileIo from '../bounded-file-io'
import * as fs from 'node:fs'
import nativeFs from 'node:fs'
import * as zlib from 'node:zlib'
import * as storageUsage from '../storage/usage'
import * as fsPromises from 'node:fs/promises'
import { c as createTar, x as extractTar } from 'tar'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>())
}))
vi.mock('node:zlib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:zlib')>())
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() }
}))
// Drive the public confirmation command for transfer tests that do not inspect the UI wait itself.
const createDesktop = (
  options: ConstructorParameters<typeof SessionPackageDesktop>[0],
  review: (
    snapshot: import('../../shared/session-package').PackageOperationSnapshot
  ) => boolean | Promise<boolean> = () => true
): SessionPackageDesktop => {
  const desktop = new SessionPackageDesktop({
    ...options,
    onOperationChanged: (snapshot) => {
      options.onOperationChanged?.(snapshot)
      if (snapshot.state === 'awaiting-selection' && snapshot.importPreview) {
        void Promise.resolve(review(snapshot)).then((accept) => {
          if (desktop.operations.snapshot?.state === 'awaiting-selection')
            desktop.respond({
              action: accept ? 'confirm-import' : 'cancel',
              operationId: snapshot.id
            })
        })
      }
    }
  })
  return desktop
}
const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

it.each(['menu', 'drop', 'open'] as const)(
  'retries the original %s package and destination without reopening either picker',
  async (entry) => {
    const fixture = await createProvenanceTestFixture()
    fixtures.push(fixture)
    await fixture.client.project.create({ data: { id: 'source', name: 'Source' } })
    await fixture.client.project.create({ data: { id: 'target', name: 'Target' } })
    const repo = new SessionRepository(fixture.storageRoot)
    await repo.saveSession({
      id: 'session',
      projectId: 'source',
      title: 'Retry evidence',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const service = new SessionPackageService({
      storageRoot: fixture.storageRoot,
      getClient: async () => fixture.client
    })
    const archive = join(fixture.storageRoot, 'retry.science')
    await service.exportTo({ projectId: 'source', sessionId: 'session' }, archive)
    const importFrom = vi
      .spyOn(service, 'importFrom')
      .mockRejectedValueOnce(new Error('Temporary validation failure'))
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [archive] })
    let destinations = 0
    const selectedOperations = new Set<string>()
    const reserve = vi.fn<(projectId: string) => Promise<() => void>>(async () => () => undefined)
    const desktop = createDesktop({
      service,
      translate: englishNativeTranslator,
      withDataRootWrite: async (work) => work(),
      reserveImport: reserve,
      afterImport: async () => undefined,
      onOperationChanged: (snapshot) => {
        if (
          snapshot.state === 'awaiting-selection' &&
          !snapshot.importPreview &&
          !selectedOperations.has(snapshot.id)
        ) {
          selectedOperations.add(snapshot.id)
          destinations++
          queueMicrotask(() =>
            desktop.respond({
              action: 'select-project',
              operationId: snapshot.id,
              target: { projectId: 'target' }
            })
          )
        }
      }
    })
    try {
      if (entry === 'open') desktop.enqueueFile(archive)
      else
        await expect(
          desktop.import(
            undefined,
            'client',
            { projectId: 'target' },
            entry === 'drop' ? archive : undefined
          )
        ).rejects.toThrow()
      await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('failed'))
      const failed = desktop.operations.snapshot!
      expect(failed.importRequestId).toEqual(expect.any(String))
      expect(failed.importTarget).toEqual({ projectId: 'target' })
      desktop.respond({ action: 'retry-import', operationId: failed.id })
      await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('succeeded'), {
        timeout: 10000
      })
      expect(dialog.showOpenDialog).toHaveBeenCalledTimes(entry === 'menu' ? 1 : 0)
      expect(destinations).toBe(entry === 'open' ? 1 : 0)
      expect(reserve.mock.calls.map(([project]) => project)).toEqual(['target', 'target'])
      expect(importFrom).toHaveBeenCalledTimes(2)
      expect(desktop.operations.snapshot?.result?.imported?.projectId).toBe('target')
      expect(() => desktop.respond({ action: 'retry-import', operationId: failed.id })).toThrow(
        'no longer active'
      )
    } finally {
      await desktop.close()
      await service.close()
    }
  }
)

it('keeps a missing original retryable and lets the user deliberately choose another package', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  await fixture.client.project.create({ data: { id: 'target', name: 'Target' } })
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const importFrom = vi.spyOn(service, 'importFrom').mockRejectedValue(new Error('Invalid package'))
  const original = join(fixture.storageRoot, 'missing.science')
  await writeFile(original, 'invalid package')
  const replacement = join(fixture.storageRoot, 'replacement.science')
  await writeFile(replacement, 'different invalid package')
  const desktop = createDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    afterImport: async () => undefined
  })
  try {
    await expect(
      desktop.import(undefined, undefined, { projectId: 'target' }, original)
    ).rejects.toThrow()
    await fsPromises.unlink(original)
    desktop.respond({ action: 'retry-import', operationId: desktop.operations.snapshot!.id })
    await vi.waitFor(() =>
      expect(desktop.operations.snapshot).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('The original package is unavailable.'),
        importTarget: { projectId: 'target' },
        importRequestId: expect.any(String)
      })
    )
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
    expect(importFrom).toHaveBeenCalledTimes(1)
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [replacement]
    })
    await expect(
      desktop.import(undefined, undefined, desktop.operations.snapshot!.importTarget)
    ).rejects.toThrow()
    expect(dialog.showOpenDialog).toHaveBeenCalledOnce()
    expect(desktop.operations.snapshot?.importFilename).toBe('replacement.science')
    desktop.respond({ action: 'retry-import', operationId: desktop.operations.snapshot!.id })
    await vi.waitFor(() => expect(importFrom).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('failed'))
    expect(dialog.showOpenDialog).toHaveBeenCalledOnce()
    expect(desktop.operations.snapshot?.importFilename).toBe('replacement.science')
  } finally {
    await desktop.close()
    await service.close()
  }
})

it('validates dropped package commands without expanding the destination model', () => {
  const parse = sessionPackageCommandContracts.import.args.parse
  expect(parse([{ projectId: 'target' }, '/data/research.SCIENCE'])).toEqual([
    { projectId: 'target' },
    '/data/research.SCIENCE'
  ])
  for (const args of [
    [{}, '/data/research.science'],
    [{ projectName: 'New' }, '/data/research.science'],
    [{ projectId: 'target' }, '/data/data.csv'],
    [{ projectId: 'target' }, '']
  ]) {
    expect(() => parse(args)).toThrow()
  }
})

it('imports a dropped package into its Project without a picker or destination prompt', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  await fixture.client.project.create({ data: { id: 'source', name: 'Source' } })
  await fixture.client.project.create({ data: { id: 'target', name: 'Target' } })
  const repo = new SessionRepository(fixture.storageRoot)
  await repo.saveSession({
    id: 'session',
    projectId: 'source',
    title: 'Dropped research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const archive = join(fixture.storageRoot, 'research.science')
  await service.exportTo({ projectId: 'source', sessionId: 'session' }, archive)
  const reserveImport = vi.fn(async () => release)
  const release = vi.fn()
  const afterImport = vi.fn(async () => undefined)
  const states: string[] = []
  let promptedForProject = false
  const desktop = createDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    reserveImport,
    afterImport,
    onOperationChanged: (snapshot) => {
      states.push(snapshot.progress.phase)
      if (
        snapshot.state === 'awaiting-selection' &&
        snapshot.importFilename &&
        !snapshot.importPreview
      ) {
        promptedForProject = true
        queueMicrotask(() => desktop.respond({ action: 'cancel', operationId: snapshot.id }))
      }
    }
  })
  const result = await desktop.import(undefined, 'desktop-client', { projectId: 'target' }, archive)
  expect(promptedForProject).toBe(false)
  expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  expect(dialog.showMessageBox).not.toHaveBeenCalled()
  expect(reserveImport).toHaveBeenCalledExactlyOnceWith('target', expect.any(AbortSignal))
  expect(release).toHaveBeenCalledOnce()
  expect(result?.projectId).toBe('target')
  expect(afterImport).toHaveBeenCalledWith(result, 'desktop-client', false)
  expect(states).toContain('copying')
  expect(states).toContain('validating')
  expect(states).toContain('confirming')
  const saved = await repo.loadSession('target', result!.sessionId)
  expect(saved?.title).toBe('Dropped research')
  expect(saved?.packageOrigin).toBeDefined()
})

it.each([
  { kind: 'export', failure: 'cancel' },
  { kind: 'export', failure: 'ENOSPC' },
  { kind: 'import', failure: 'cancel' },
  { kind: 'import', failure: 'ENOSPC' }
] as const)(
  'closes the active $kind file before releasing the Session on $failure',
  async ({ kind, failure }) => {
    const fixture = await createProvenanceTestFixture()
    fixtures.push(fixture)
    await fixture.client.project.create({ data: { id: 'source', name: 'Cancellation' } })
    await new SessionRepository(fixture.storageRoot).saveSession({
      id: 'session',
      projectId: 'source',
      title: 'Cancellation',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const payload = join(fixture.storageRoot, 'notebooks/source/session/data/results.bin')
    await mkdir(dirname(payload), { recursive: true })
    await writeFile(payload, Buffer.alloc(2 * 1024 ** 2))
    const destination = join(fixture.storageRoot, 'existing.science')
    await writeFile(destination, 'Keep existing output')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: destination })
    const opened = new Set<number>()
    const openAtRelease: number[] = []
    const release = vi.fn(() => {
      openAtRelease.push(opened.size)
    })
    const service = new SessionPackageService({
      storageRoot: fixture.storageRoot,
      getClient: async () => fixture.client
    })
    const archive = join(fixture.storageRoot, 'source.science')
    if (kind === 'import')
      await service.exportTo({ projectId: 'source', sessionId: 'session' }, archive)
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [archive] })
    const desktop = createDesktop({
      service,
      translate: englishNativeTranslator,
      withDataRootWrite: async (work) => work(),
      reserveExport: async () => release,
      reserveImport: async () => release,
      afterImport: async () => undefined,
      onOperationChanged: (snapshot) => {
        if (snapshot.kind === 'export' && snapshot.state === 'awaiting-selection')
          queueMicrotask(() =>
            desktop.respond({ action: 'select', operationId: snapshot.id, excludedStorageKeys: [] })
          )
      }
    })
    // Observe native descriptors without replacing the tar writer or service. Delay one real read
    // completion so cancellation happens with a file operation still in flight on every platform.
    const originalOpen = nativeFs.open
    const originalRead = nativeFs.read
    const originalWrite = nativeFs.write
    const originalClose = nativeFs.close
    const originalCreateWriteStream = fs.createWriteStream
    let output: fs.WriteStream | undefined
    vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args)
      if (desktop.operations.snapshot?.progress.phase === 'compressing') output = stream
      return stream
    })
    vi.spyOn(nativeFs, 'open').mockImplementation((...args) => {
      const callback = args.at(-1) as (error: NodeJS.ErrnoException | null, fd: number) => void
      const track =
        desktop.operations.snapshot?.progress.phase ===
          (kind === 'export' ? 'compressing' : 'validating') &&
        /[/\\]objects[/\\]/.test(String(args[0]))
      return Reflect.apply(originalOpen, nativeFs, [
        ...args.slice(0, -1),
        (error: NodeJS.ErrnoException | null, fd: number) => {
          if (!error && track) opened.add(fd)
          callback(error, fd)
        }
      ])
    })
    vi.spyOn(nativeFs, 'close').mockImplementation((fd, callback) =>
      originalClose(fd, (error) => {
        if (!error) opened.delete(fd)
        callback?.(error)
      })
    )
    let cancelled = false
    let readsAfterFailure = 0
    vi.spyOn(nativeFs, 'read').mockImplementation((...args) => {
      if (kind === 'export' && opened.has(args[0]) && !cancelled) {
        cancelled = true
        if (failure === 'cancel') desktop.operations.cancel()
        else
          output!.destroy(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }))
        setTimeout(() => Reflect.apply(originalRead, nativeFs, args), 50)
        return
      }
      if (kind === 'export' && opened.has(args[0]) && cancelled) readsAfterFailure++
      return Reflect.apply(originalRead, nativeFs, args)
    })
    vi.spyOn(nativeFs, 'write').mockImplementation((...args) => {
      if (kind === 'import' && opened.has(args[0]) && !cancelled) {
        cancelled = true
        if (failure === 'cancel') {
          desktop.operations.cancel()
          setTimeout(() => Reflect.apply(originalWrite, nativeFs, args), 50)
        } else {
          const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void
          setTimeout(
            () => callback(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })),
            50
          )
        }
        return
      }
      return Reflect.apply(originalWrite, nativeFs, args)
    })
    try {
      const pending =
        kind === 'export'
          ? desktop.export({ projectId: 'source', sessionId: 'session' })
          : desktop.import(undefined, undefined, { projectId: 'source' })
      if (failure === 'cancel')
        await expect(pending).resolves.toEqual(kind === 'export' ? { saved: false } : null)
      else await expect(pending).rejects.toThrow('Could not complete')
      expect(cancelled).toBe(true)
      expect(release).toHaveBeenCalledOnce()
      expect(openAtRelease).toEqual([0])
      expect(opened.size).toBe(0)
      expect(readsAfterFailure).toBe(0)
      expect(desktop.operations.active).toBe(false)
      expect(await readFile(destination, 'utf8')).toBe('Keep existing output')
    } finally {
      await vi.waitFor(() => expect(opened.size).toBe(0))
      await desktop.close()
      await service.close()
    }
  }
)

it('keeps the import confirmation short and offers every omitted item on demand', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  await fixture.client.project.create({ data: { id: 'source', name: 'Source' } })
  await new SessionRepository(fixture.storageRoot).saveSession({
    id: 'original',
    projectId: 'source',
    title: 'Research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const archive = join(fixture.storageRoot, 'session.science')
  await service.exportTo({ projectId: 'source', sessionId: 'original' }, archive)
  const unpacked = join(fixture.storageRoot, 'unpacked')
  await mkdir(unpacked)
  await extractTar({ file: archive, cwd: unpacked, gzip: true })
  const manifestPath = join(unpacked, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const descriptions = Array.from(
    { length: 40 },
    (_, index) => `File ${index}: ${'result '.repeat(30)}`
  )
  manifest.omissions = descriptions.map((description) => ({ kind: 'external', description }))
  await writeFile(manifestPath, JSON.stringify(manifest))
  await createTar({ file: archive, cwd: unpacked, gzip: true }, await readdir(unpacked))
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [archive] })
  let observed: import('../../shared/session-package').SessionPackagePreview | undefined
  const desktop = createDesktop(
    {
      service,
      translate: englishNativeTranslator,
      withDataRootWrite: async (work) => work(),
      afterImport: async () => undefined
    },
    (snapshot) => {
      observed = snapshot.importPreview
      return true
    }
  )
  expect(await desktop.import()).not.toBeNull()
  expect(observed?.omissions.map((item) => item.description)).toEqual(descriptions)
  expect(dialog.showMessageBox).not.toHaveBeenCalled()
  await desktop.close()
  await service.close()
})

it('rejects an import snapshot before reading the archive when temporary space is insufficient', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  const archive = join(fixture.storageRoot, 'source.science')
  await writeFile(archive, 'Archive bytes must not be read')
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [archive] })
  const filesystem = await fsPromises.statfs(fixture.storageRoot)
  const statfs = vi.spyOn(fsPromises, 'statfs').mockResolvedValue({ ...filesystem, bavail: 0 })
  const capacity = vi.spyOn(storageUsage, 'availableBytes')
  const list = vi.spyOn(fsPromises, 'readdir')
  const read = vi.spyOn(fsPromises, 'readFile')
  const copy = vi.spyOn(fileIo, 'copyFileWithinBudget')
  const desktop = createDesktop({
    service: new SessionPackageService({
      storageRoot: fixture.storageRoot,
      getClient: async () => fixture.client
    }),
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    afterImport: async () => undefined
  })
  await expect(desktop.import()).rejects.toThrow('Not enough disk space')
  expect(copy).not.toHaveBeenCalled()
  expect(capacity).toHaveBeenCalledTimes(1)
  expect(statfs).toHaveBeenCalledTimes(1)
  expect(list).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(String(capacity.mock.calls[0][0])).toContain('open-science-package-dialog-')
  expect(desktop.operations.snapshot?.state).toBe('failed')
  expect(vi.mocked(dialog.showMessageBox)).not.toHaveBeenCalled()
  await desktop.close()
})

it.each(['insufficient', 'exact', 'unavailable'] as const)(
  'checks the chosen export volume after the save picker with %s capacity',
  async (capacityResult) => {
    const fixture = await createProvenanceTestFixture()
    fixtures.push(fixture)
    await fixture.client.project.create({ data: { id: 'project-1', name: 'Capacity' } })
    await new SessionRepository(fixture.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Capacity',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const destination = join(fixture.storageRoot, 'existing.science')
    await writeFile(destination, 'Keep existing file')
    let chosen = false
    let archiveBytes = 0
    const queried: { path: string; afterPicker: boolean }[] = []
    vi.mocked(dialog.showSaveDialog).mockImplementation(async () => {
      chosen = true
      return { canceled: false, filePath: destination }
    })
    const originalStat = stat
    const capacity = vi.spyOn(storageUsage, 'availableBytes').mockImplementation(async (path) => {
      queried.push({ path, afterPicker: chosen })
      if (dirname(path) !== fixture.storageRoot) return 100 * 1024 ** 3
      if (capacityResult === 'unavailable') throw new Error('Unsupported statfs')
      return 2 * 1024 ** 3 + archiveBytes - (capacityResult === 'insufficient' ? 1 : 0)
    })
    vi.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
      const result = await originalStat(...args)
      if (chosen && String(args[0]).includes('open-science-package-dialog-'))
        archiveBytes = Number(result.size)
      return result
    })
    const release = vi.fn()
    const desktop = createDesktop({
      service: new SessionPackageService({
        storageRoot: fixture.storageRoot,
        getClient: async () => fixture.client
      }),
      translate: englishNativeTranslator,
      withDataRootWrite: async (work) => work(),
      afterImport: async () => undefined,
      reserveExport: async () => release,
      onOperationChanged: (snapshot) => {
        if (snapshot.kind === 'export' && snapshot.state === 'awaiting-selection')
          queueMicrotask(() =>
            desktop.respond({ action: 'select', operationId: snapshot.id, excludedStorageKeys: [] })
          )
      }
    })
    const result = desktop.export({ projectId: 'project-1', sessionId: 'session-1' })
    if (capacityResult === 'insufficient') {
      await expect(result).rejects.toThrow('Free up at least 1 B')
      expect(await readFile(destination, 'utf8')).toBe('Keep existing file')
      expect(desktop.operations.snapshot?.state).toBe('failed')
    } else {
      await expect(result).resolves.toMatchObject({ saved: true })
      expect((await stat(destination)).size).toBe(archiveBytes)
    }
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^Capacity-\d{4}-\d{2}-\d{2}\.science$/)
      })
    )
    expect(capacity).toHaveBeenCalledTimes(4)
    expect(queried.every((query) => query.afterPicker)).toBe(true)
    expect(queried[0].path).toContain('open-science-package-export-')
    expect(queried[1].path).toContain('open-science-package-validation-')
    expect(queried[2].path).toContain('open-science-package-dialog-')
    expect(dirname(queried[3].path)).toBe(fixture.storageRoot)
    expect(release).toHaveBeenCalledTimes(1)
    expect(
      (await readdir(fixture.storageRoot)).filter((name) => name.startsWith('.open-science-save-'))
    ).toEqual([])
    await desktop.close()
  }
)

it.each([
  { kind: 'export', phase: 'saving', failure: 'ENOSPC' },
  { kind: 'export', phase: 'saving', failure: 'cancel' },
  { kind: 'export', phase: 'compressing', failure: 'cancel' },
  { kind: 'import', phase: 'copying', failure: 'ENOSPC' },
  { kind: 'import', phase: 'importing', failure: 'ENOSPC' }
] as const)('cleans a partial $kind $phase write on $failure', async ({ kind, phase, failure }) => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Write failure' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Write failure',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: []
  })
  const payload = join(
    source.storageRoot,
    'notebooks',
    'project-1',
    'session-1',
    'data',
    'results.csv'
  )
  await mkdir(dirname(payload), { recursive: true })
  await writeFile(payload, 'sample,value\nA,1\n'.repeat(1024))
  const sourceService = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  const archive = join(source.storageRoot, 'source.science')
  if (kind === 'import')
    await sourceService.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const destination = join(target.storageRoot, 'existing.science')
  await writeFile(destination, 'Keep the existing user file')
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: destination })
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [archive] })
  const release = vi.fn()
  const afterImport = vi.fn(async () => undefined)
  const service =
    kind === 'export'
      ? sourceService
      : new SessionPackageService({
          storageRoot: target.storageRoot,
          getClient: async () => target.client
        })
  const desktop = createDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    afterImport,
    reserveExport: async () => release,
    onOperationChanged: (snapshot) => {
      if (snapshot.kind === 'export' && snapshot.state === 'awaiting-selection')
        queueMicrotask(() =>
          desktop.respond({ action: 'select', operationId: snapshot.id, excludedStorageKeys: [] })
        )
    }
  })
  const original = fileIo.copyFileWithinBudget
  let partialPath = ''
  let reached!: () => void
  const writing = new Promise<void>((resolve) => {
    reached = resolve
  })
  if (phase === 'compressing') {
    const createGzip = zlib.createGzip
    const createWriteStream = fs.createWriteStream
    vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      if (desktop.operations.snapshot?.progress.phase === 'compressing')
        partialPath = String(args[0])
      return createWriteStream(...args)
    })
    vi.spyOn(zlib, 'createGzip').mockImplementation((options) => {
      const stream = createGzip(options)
      stream.once('data', () => reached())
      return stream
    })
  }
  vi.spyOn(fileIo, 'copyFileWithinBudget').mockImplementation(async (...args) => {
    if (phase === 'compressing') return original(...args)
    // The initial import copy reports its byte phase on the first progress callback.
    const entryPhase = kind === 'import' && phase === 'copying' ? 'preparing' : phase
    if (desktop.operations.snapshot?.progress.phase !== entryPhase) return original(...args)
    partialPath = args[1]
    await writeFile(partialPath, 'partial output', { flag: 'wx' })
    args[4]?.(Buffer.byteLength('partial output'))
    reached()
    if (failure === 'cancel') {
      const signal = args[3]!
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      signal.throwIfAborted()
    }
    throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
  })
  const pending = (
    kind === 'export'
      ? desktop.export({ projectId: 'project-1', sessionId: 'session-1' })
      : desktop.import()
  ).catch((error: unknown) => error)
  await writing
  expect(desktop.operations.active).toBe(true)
  if (failure === 'cancel') desktop.operations.cancel()
  const result = await pending
  if (failure === 'cancel') expect(result).toEqual({ saved: false })
  else expect(result).toBeInstanceOf(Error)
  expect(desktop.operations.snapshot?.state).toBe(failure === 'cancel' ? 'cancelled' : 'failed')
  expect(desktop.operations.active).toBe(false)
  expect(desktop.operations.snapshot?.result).toBeUndefined()
  await expect(stat(partialPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(destination, 'utf8')).toBe('Keep the existing user file')
  expect(
    (await readdir(target.storageRoot)).filter((name) => name.startsWith('.open-science-save-'))
  ).toEqual([])
  expect(await target.client.project.count()).toBe(0)
  expect(await new SessionRepository(target.storageRoot).loadAll()).toMatchObject({ sessions: [] })
  expect(afterImport).not.toHaveBeenCalled()
  if (kind === 'export') expect(release).toHaveBeenCalledOnce()
  expect(await readFile(payload, 'utf8')).toContain('sample,value')
  await desktop.close()
  await service.close()
})

it.each([false, true])(
  'imports reviewed bytes and retains the destination (existing: %s)',
  async (existing) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Reviewed research' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Selected evidence',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const sourceService = new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    })
    const archive = join(source.storageRoot, 'reviewed.science')
    await sourceService.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
    const service = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [archive] })
    const afterImport = vi.fn(async () => {
      throw new Error('Notification transport closed after durable import')
    })
    const desktop = createDesktop(
      {
        service,
        translate: englishNativeTranslator,
        withDataRootWrite: async (work) => work(),
        afterImport
      },
      async (snapshot) => {
        expect(snapshot.importPreview?.title).toBe('Selected evidence')
        await writeFile(archive, 'Replaced after preview')
        return true
      }
    )
    if (existing)
      await target.client.project.create({ data: { id: 'existing', name: 'Destination' } })
    const request = existing ? { projectId: 'existing' } : {}
    expect(sessionPackageCommandContracts.import.args.parse([request])).toEqual([request])
    const imported = await desktop.import(undefined, undefined, request)
    expect(desktop.operations.snapshot?.importTarget).toEqual(request)
    if (existing) expect(imported?.projectId).toBe('existing')
    expect(imported).not.toBeNull()
    expect(desktop.operations.snapshot?.result).toEqual({ imported })
    expect(() =>
      sessionPackageCommandContracts.operation.result.parse(desktop.operations.snapshot)
    ).not.toThrow()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(afterImport).toHaveBeenCalledWith(imported, undefined, !existing)
    expect(
      await new SessionRepository(target.storageRoot).loadSession(
        imported!.projectId,
        imported!.sessionId
      )
    ).toMatchObject({ title: 'Selected evidence', packageOrigin: expect.any(Object) })
    await service.close()
    await expect(service.importFrom(archive)).rejects.toThrow('closed')
  }
)

it('does not publish a project when the native file picker is cancelled', async () => {
  const target = await createProvenanceTestFixture()
  fixtures.push(target)
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
  const afterImport = vi.fn(async () => undefined)
  const desktop = createDesktop({
    service: new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    }),
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    afterImport
  })
  await expect(desktop.import()).resolves.toBeNull()
  expect(dialog.showMessageBox).not.toHaveBeenCalled()
  expect(afterImport).not.toHaveBeenCalled()
  expect(await new SessionRepository(target.storageRoot).loadAll()).toMatchObject({ sessions: [] })
})

it('stops waiting for a native picker on shutdown and rejects later import admission', async () => {
  const target = await createProvenanceTestFixture()
  fixtures.push(target)
  vi.mocked(dialog.showOpenDialog).mockReturnValue(new Promise(() => undefined))
  const afterImport = vi.fn(async () => undefined)
  const desktop = createDesktop({
    service: new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    }),
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    afterImport
  })
  const pending = desktop.import().catch((error: unknown) => error)
  await vi.waitFor(() => expect(dialog.showOpenDialog).toHaveBeenCalled())
  await desktop.close()
  expect(await pending).toBeInstanceOf(Error)
  await expect(desktop.import()).rejects.toThrow('closed')
  expect(afterImport).not.toHaveBeenCalled()
})

it('cancels without waiting for a native picker and ignores a later file selection', async () => {
  let choose!: (selection: Electron.OpenDialogReturnValue) => void
  vi.mocked(dialog.showOpenDialog).mockReturnValue(
    new Promise((resolve) => {
      choose = resolve
    })
  )
  const getClient = vi.fn(async () => {
    throw new Error('Database must not be accessed')
  })
  const afterImport = vi.fn(async () => undefined)
  const desktop = createDesktop({
    service: new SessionPackageService({ storageRoot: '/unused', getClient }),
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    afterImport
  })
  const pending = desktop.import()
  await vi.waitFor(() => expect(dialog.showOpenDialog).toHaveBeenCalled())
  desktop.operations.cancel()
  await expect(pending).resolves.toBeNull()
  expect(desktop.operations.snapshot?.state).toBe('cancelled')
  expect(desktop.operations.active).toBe(false)
  choose({ canceled: false, filePaths: ['/unused/late.science'] })
  await Promise.resolve()
  expect(getClient).not.toHaveBeenCalled()
  expect(afterImport).not.toHaveBeenCalled()
  await desktop.close()
})

it.each(['invalid', 'cancelled', 'rolled-back'] as const)(
  'retains cleanup retry after a failed or cancelled import (%s) without replacing its outcome',
  async (outcome) => {
    const fixture = await createProvenanceTestFixture()
    fixtures.push(fixture)
    await fixture.client.project.create({ data: { id: 'source', name: 'Research' } })
    await new SessionRepository(fixture.storageRoot).saveSession({
      id: 'original',
      projectId: 'source',
      title: 'Shared research',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const service = new SessionPackageService({
      storageRoot: fixture.storageRoot,
      getClient: async () => fixture.client
    })
    const archive = join(fixture.storageRoot, 'research.science')
    await service.exportTo({ projectId: 'source', sessionId: 'original' }, archive)
    if (outcome === 'invalid') await writeFile(archive, 'Invalid archive')
    if (outcome === 'rolled-back')
      await fixture.client.$executeRawUnsafe(
        `CREATE TRIGGER reject_import BEFORE INSERT ON "FileOriginSession" BEGIN SELECT RAISE(ABORT, 'Injected publication failure'); END`
      )
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [archive] })
    const imported = vi.spyOn(service, 'importFrom')
    const afterImport = vi.fn(async () => undefined)
    const desktop = createDesktop(
      {
        service,
        translate: englishNativeTranslator,
        withDataRootWrite: async (work) => work(),
        afterImport
      },
      () => outcome !== 'cancelled'
    )
    const remove = fsPromises.rm
    const retained = new Set<string>()
    const cleanup = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, ...args) => {
      const matches =
        outcome === 'rolled-back'
          ? dirname(String(path)) === join(fixture.storageRoot, 'artifacts', 'source') &&
            basename(String(path)).startsWith('import-')
          : dirname(String(path)) === join(fixture.storageRoot, 'session-package-imports')
      if (matches) {
        retained.add(String(path))
        throw new Error('Private cleanup failed')
      }
      return remove(path, ...args)
    })
    try {
      const pending = desktop.import(undefined, undefined, { projectId: 'source' })
      const result = await pending.catch((error: unknown) => error)
      const snapshot = desktop.operations.snapshot!
      expect(retained.size).toBe(1)
      expect(snapshot).toMatchObject({
        state: outcome === 'cancelled' ? 'cancelled' : 'failed',
        cleanupPending: true
      })
      if (outcome === 'cancelled') expect(result).toBeNull()
      else if (outcome === 'invalid')
        expect(result).toMatchObject({
          cause: { message: expect.stringContaining('TAR_BAD_ARCHIVE') }
        })
      // Prisma maps the trigger's SQLITE_CONSTRAINT result to P2003 for this model operation.
      else expect(result).toMatchObject({ cause: { code: 'P2003' } })
      await expect(
        desktop.respond({ action: 'retry-cleanup', operationId: snapshot.id })
      ).rejects.toThrow('Temporary files could not be removed')
      cleanup.mockRestore()
      await desktop.respond({ action: 'retry-cleanup', operationId: snapshot.id })
      expect(desktop.operations.snapshot).toMatchObject({
        state: snapshot.state,
        cleanupPending: false
      })
      for (const path of retained)
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(join(fixture.storageRoot, 'session-package-imports'))).toEqual([])
      expect(imported).toHaveBeenCalledOnce()
      expect(afterImport).not.toHaveBeenCalled()
      expect((await new SessionRepository(fixture.storageRoot).loadAll()).sessions).toHaveLength(1)
      expect(await fixture.client.fileOriginSession.count()).toBe(0)
    } finally {
      cleanup.mockRestore()
      await desktop.close()
      await service.close()
    }
  }
)

it.each(['import', 'dialog'] as const)(
  'keeps an imported Session successful when %s staging cleanup fails',
  async (scope) => {
    const source = await createProvenanceTestFixture()
    fixtures.push(source)
    await source.client.project.create({ data: { id: 'source', name: 'Research' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'original',
      projectId: 'source',
      title: 'Shared research',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const service = new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    })
    const archive = join(source.storageRoot, 'research.science')
    await service.exportTo({ projectId: 'source', sessionId: 'original' }, archive)
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [archive] })
    const imported = vi.spyOn(service, 'importFrom')
    const afterImport = vi.fn(async () => undefined)
    const desktop = createDesktop({
      service,
      translate: englishNativeTranslator,
      withDataRootWrite: async (work) => work(),
      afterImport
    })
    const remove = fsPromises.rm
    const retained: string[] = []
    const cleanup = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, ...args) => {
      const matches =
        scope === 'dialog'
          ? basename(String(path)).startsWith('open-science-package-dialog-')
          : dirname(String(path)) === join(source.storageRoot, 'session-package-imports')
      if (matches) {
        retained.push(String(path))
        throw new Error('Private cleanup failed')
      }
      return remove(path, ...args)
    })
    const result = await desktop.import(undefined, undefined, { projectId: 'source' })
    expect(result).not.toBeNull()
    const snapshot = desktop.operations.snapshot!
    expect(snapshot).toMatchObject({
      state: 'succeeded',
      cleanupPending: true,
      result: { imported: result }
    })
    await expect(
      desktop.respond({ action: 'retry-cleanup', operationId: snapshot.id })
    ).rejects.toThrow('Temporary files could not be removed')
    expect(desktop.operations.snapshot).toMatchObject({ state: 'succeeded', cleanupPending: true })
    cleanup.mockRestore()
    await desktop.respond({ action: 'retry-cleanup', operationId: snapshot.id })
    expect(desktop.operations.snapshot).toMatchObject({ state: 'succeeded', cleanupPending: false })
    expect(imported).toHaveBeenCalledOnce()
    expect(afterImport).toHaveBeenCalledOnce()
    expect((await new SessionRepository(source.storageRoot).loadAll()).sessions).toHaveLength(2)
    for (const path of retained) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

it.each(['none', 'dialog', 'export'] as const)(
  'reports the saved result despite %s cleanup failure',
  async (cleanupScope) => {
    const source = await createProvenanceTestFixture()
    fixtures.push(source)
    await source.client.project.create({ data: { id: 'project-1', name: 'Saved research' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Saved research',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const remove = fsPromises.rm
    const retained: string[] = []
    const cleanup = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, ...args) => {
      if (
        cleanupScope !== 'none' &&
        basename(String(path)).startsWith(`open-science-package-${cleanupScope}-`)
      ) {
        retained.push(String(path))
        throw new Error('Temporary cleanup failed')
      }
      return remove(path, ...args)
    })
    const filePath = join(source.storageRoot, 'saved.science')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath })
    const release = vi.fn()
    const changes: string[] = []
    const desktop = createDesktop({
      service: new SessionPackageService({
        storageRoot: source.storageRoot,
        getClient: async () => source.client
      }),
      translate: englishNativeTranslator,
      withDataRootWrite: async (work) => work(),
      afterImport: async () => undefined,
      reserveExport: async () => release,
      onOperationChanged: (snapshot) => {
        changes.push(snapshot.progress.phase)
        if (snapshot.kind === 'export' && snapshot.state === 'awaiting-selection')
          queueMicrotask(() =>
            desktop.respond({ action: 'select', operationId: snapshot.id, excludedStorageKeys: [] })
          )
      }
    })
    expect(() => desktop.respond({ action: 'reveal', operationId: 'unknown' })).toThrow(
      'No completed export'
    )
    await expect(
      desktop.export({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toEqual({ saved: true, filePath })
    const snapshot = desktop.operations.snapshot!
    expect(() => sessionPackageCommandContracts.operation.result.parse(snapshot)).not.toThrow()
    expect(() =>
      sessionPackageCommandContracts.operation.args.parse([
        { action: 'reveal', operationId: snapshot.id, filePath: '/unowned' }
      ])
    ).toThrow()
    expect(snapshot).toMatchObject({
      state: 'succeeded',
      result: { filePath },
      progress: {
        phase: 'saving',
        completedBytes: expect.any(Number),
        totalBytes: expect.any(Number)
      }
    })
    if (cleanupScope !== 'none') {
      expect(snapshot).toMatchObject({ cleanupPending: true })
      expect(retained.length).toBeGreaterThan(0)
      const before = await readFile(filePath)
      cleanup.mockRestore()
      await desktop.respond({ action: 'retry-cleanup', operationId: snapshot.id })
      expect(desktop.operations.snapshot).toMatchObject({
        state: 'succeeded',
        cleanupPending: false,
        result: { filePath }
      })
      expect(await readFile(filePath)).toEqual(before)
      for (const path of retained)
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(dialog.showSaveDialog).toHaveBeenCalledOnce()
    }
    expect(changes).toContain('choosing-location')
    expect(release).toHaveBeenCalledOnce()
    desktop.respond({ action: 'reveal', operationId: snapshot.id })
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(filePath)
    expect(() => desktop.respond({ action: 'reveal', operationId: 'stale' })).toThrow(
      'No completed export'
    )
  }
)

it('confirms a selected import in the operation window without a native message box', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  const input = join(fixture.storageRoot, 'review.science')
  await writeFile(input, 'fixture archive')
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [input] })
  vi.mocked(dialog.showMessageBox).mockImplementation(() => new Promise(() => undefined))
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const preview = {
    title: 'Source research',
    projectName: 'Source',
    branchCount: 1,
    messageCount: 2,
    fileCount: 0,
    totalBytes: 42,
    omissions: []
  }
  const importFrom = vi
    .spyOn(service, 'importFrom')
    .mockImplementation(async (_path, signal, _progress, confirm) => {
      await confirm?.(preview, signal!)
      return { projectId: 'target', sessionId: 'imported' }
    })
  const desktop = new SessionPackageDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    afterImport: async () => undefined
  })
  const pending = desktop.import(undefined, undefined, { projectId: 'target' })
  // Attach immediately: the old native-confirmation path may reject before observation.
  const settled = pending.catch(() => null)
  try {
    await vi.waitFor(() => expect(importFrom).toHaveBeenCalledOnce())
    expect(desktop.operations.snapshot).toMatchObject({
      state: 'awaiting-selection',
      importPreview: preview,
      progress: { phase: 'confirming' }
    })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    desktop.respond({ action: 'confirm-import', operationId: desktop.operations.snapshot!.id })
    await expect(settled).resolves.toEqual({ projectId: 'target', sessionId: 'imported' })
  } finally {
    await desktop.close()
    await settled
    await service.close()
  }
})

it('queues OS files without reading payloads before project selection and cancels duplicates once', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  const first = join(fixture.storageRoot, 'first.science')
  const second = join(fixture.storageRoot, 'second.science')
  await writeFile(first, 'first')
  await writeFile(second, 'second')
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const reserve = vi.fn<(projectId: string) => Promise<() => void>>(async () => () => undefined)
  const copy = vi.spyOn(fileIo, 'copyFileWithinBudget')
  const desktop = new SessionPackageDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    reserveImport: reserve,
    afterImport: async () => undefined
  })
  try {
    desktop.enqueueFile(first)
    desktop.enqueueFile(first)
    desktop.enqueueFile(second)
    await vi.waitFor(() =>
      expect(desktop.operations.snapshot).toMatchObject({
        importFilename: 'first.science',
        state: 'awaiting-selection',
        pendingImports: [{ filename: 'second.science' }]
      })
    )
    expect(copy).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(desktop.hasActiveTransfer()).toBe(false)
    expect(JSON.stringify(desktop.operations.snapshot)).not.toContain(fixture.storageRoot)
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
    const initial = desktop.operations.snapshot!
    desktop.respond({ action: 'cancel', operationId: initial.id })
    await vi.waitFor(() =>
      expect(desktop.operations.snapshot).toMatchObject({
        importFilename: 'second.science',
        state: 'awaiting-selection',
        pendingImports: []
      })
    )
    expect(() =>
      desktop.respond({
        action: 'select-project',
        operationId: initial.id,
        target: { projectId: 'target' }
      })
    ).toThrow('no longer active')
    await desktop.close()
    expect(copy).not.toHaveBeenCalled()
  } finally {
    await desktop.close()
    await service.close()
  }
})

it('checks project admission before copying an OS file and keeps a failed request retryable', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  const input = join(fixture.storageRoot, 'research.science')
  await writeFile(input, 'not read before admission')
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const reserve = vi.fn(async () => {
    throw new Error('Project was archived')
  })
  const copy = vi.spyOn(fileIo, 'copyFileWithinBudget')
  const desktop = new SessionPackageDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    reserveImport: reserve,
    afterImport: async () => undefined
  })
  try {
    desktop.enqueueFile(input)
    await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('awaiting-selection'))
    desktop.respond({
      action: 'select-project',
      operationId: desktop.operations.snapshot!.id,
      target: { projectId: 'archived' }
    })
    await vi.waitFor(() =>
      expect(desktop.operations.snapshot).toMatchObject({
        state: 'failed',
        error: 'Project was archived'
      })
    )
    expect(copy).not.toHaveBeenCalled()
    expect(reserve).toHaveBeenCalledWith('archived', expect.any(AbortSignal))
    desktop.respond({ action: 'retry-import', operationId: desktop.operations.snapshot!.id })
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(2))
    expect(desktop.operations.snapshot?.importTarget).toEqual({ projectId: 'archived' })
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  } finally {
    await desktop.close()
    await service.close()
  }
})

it('retries the same opened file once when it is already queued after failure', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const desktop = new SessionPackageDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    afterImport: async () => undefined,
    assertCanStart: () => {
      throw new Error('Handoff in progress')
    }
  })
  try {
    desktop.enqueueFile(join(fixture.storageRoot, 'first.science'))
    await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('awaiting-selection'))
    desktop.respond({
      action: 'select-project',
      operationId: desktop.operations.snapshot!.id,
      target: { projectId: 'target' }
    })
    await vi.waitFor(() =>
      expect(desktop.operations.snapshot).toMatchObject({
        state: 'failed',
        importFilename: 'first.science',
        importRequestId: expect.any(String)
      })
    )
    desktop.enqueueFile(join(fixture.storageRoot, 'second.science'))
    // A new explicit open after the failed operation may begin the next request.
    await vi.waitFor(() =>
      expect(desktop.operations.snapshot?.importFilename).toBe('second.science')
    )
    desktop.respond({
      action: 'select-project',
      operationId: desktop.operations.snapshot!.id,
      target: { projectId: 'target' }
    })
    await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('failed'))
    desktop.enqueueFile(join(fixture.storageRoot, 'third.science'))
    desktop.enqueueFile(join(fixture.storageRoot, 'second.science'))
    await vi.waitFor(() =>
      expect(desktop.operations.snapshot?.importFilename).toBe('third.science')
    )
    desktop.respond({
      action: 'select-project',
      operationId: desktop.operations.snapshot!.id,
      target: { projectId: 'target' }
    })
    await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('failed'))
    desktop.enqueueFile(join(fixture.storageRoot, 'third.science'))
    await vi.waitFor(() => expect(desktop.operations.snapshot?.pendingImports).toHaveLength(2))
    desktop.respond({ action: 'retry-import', operationId: desktop.operations.snapshot!.id })
    await vi.waitFor(() =>
      expect(desktop.operations.snapshot).toMatchObject({
        importFilename: 'third.science',
        state: 'failed',
        importTarget: { projectId: 'target' },
        pendingImports: [{ filename: 'second.science' }]
      })
    )
    desktop.reportOpenOverflow()
    expect(desktop.operations.snapshot?.importQueueFull).toBe(true)
    desktop.respond({
      action: 'dismiss-queue-warning',
      operationId: desktop.operations.snapshot!.id
    })
    expect(desktop.operations.snapshot?.importQueueFull).toBe(false)
  } finally {
    await desktop.close()
    await service.close()
  }
})

it('carries a new-project draft from OS file selection through confirmation without creating it early', async () => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  await fixture.client.project.create({ data: { id: 'source', name: 'Source' } })
  await new SessionRepository(fixture.storageRoot).saveSession({
    id: 'session',
    projectId: 'source',
    title: 'Study',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const archive = join(fixture.storageRoot, 'research.science')
  await service.exportTo({ projectId: 'source', sessionId: 'session' }, archive)
  const reserveImport = vi.fn(async () => () => undefined)
  const afterImport = vi.fn(async () => undefined)
  const desktop = new SessionPackageDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: async (work) => work(),
    reserveImport,
    afterImport
  })
  try {
    desktop.enqueueFile(archive)
    await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('awaiting-selection'))
    desktop.respond({
      action: 'select-project',
      operationId: desktop.operations.snapshot!.id,
      target: { projectName: 'Reproduction study' }
    })
    await vi.waitFor(() => expect(desktop.operations.snapshot?.importPreview).toBeDefined())
    expect(desktop.operations.snapshot?.importTarget).toEqual({ projectName: 'Reproduction study' })
    expect(await fixture.client.project.count()).toBe(1)
    expect(reserveImport).not.toHaveBeenCalled()
    desktop.respond({ action: 'confirm-import', operationId: desktop.operations.snapshot!.id })
    await vi.waitFor(() => expect(desktop.operations.snapshot?.state).toBe('succeeded'))
    const imported = desktop.operations.snapshot!.result!.imported!
    expect(
      await fixture.client.project.findUnique({ where: { id: imported.projectId } })
    ).toMatchObject({ name: 'Reproduction study' })
    expect(afterImport).toHaveBeenCalledWith(imported, undefined, true)
  } finally {
    await desktop.close()
    await service.close()
  }
})
