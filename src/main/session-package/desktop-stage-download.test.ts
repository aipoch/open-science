import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { englishNativeTranslator } from '../locale/main-process-messages'
import type { SessionPackageRequest } from '../../shared/session-package'
import { SessionPackageDesktop } from './desktop'
import { PackageSensitiveContentError, buildSensitiveContentEvidence } from './sensitive-content'
import type { SessionPackageService } from './service'

const testTemporaryRoot = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return mkdtemp(join(tmpdir(), 'package-download-tests-'))
})
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  tmpdir: () => testTemporaryRoot
}))
afterAll(() => rm(testTemporaryRoot, { recursive: true, force: true }))

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() }
}))

await (
  await import('../../../test/runtime-host')
).configureTestElectronHost(await import('electron'))

type ExportToOptions = {
  allowSensitiveContent?: boolean
  signal: AbortSignal
  selectFiles?: (
    files: unknown[],
    signal: AbortSignal,
    summary: { retainedFiles: never[]; metadataBytes: number },
    title: string
  ) => Promise<unknown>
}
type ExportTo = (
  request: SessionPackageRequest,
  archive: string,
  options: ExportToOptions
) => Promise<void>

const request = { projectId: 'project-1', sessionId: 'session-1' }
const stagingDirectory = join(tmpdir(), 'open-science-package-exports')
const temporaryDirectories: string[] = []

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'stage-download-test-'))
  temporaryDirectories.push(directory)
  return directory
}

const selectEverything = async (options: ExportToOptions, title: string): Promise<void> => {
  if (!options.selectFiles) throw new Error('Expected the desktop file-selection callback.')
  await options.selectFiles([], options.signal, { retainedFiles: [], metadataBytes: 0 }, title)
}

const writeArchive = async (archive: string): Promise<void> => {
  await writeFile(archive, 'package-bytes')
}

const dateStamp = (now = new Date()): string =>
  [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')

type DesktopHandle = {
  desktop: SessionPackageDesktop
  rememberedLastExports: unknown[]
}

const createDesktop = (exportTo: ExportTo): DesktopHandle => {
  const rememberedLastExports: unknown[] = []
  const desktop = new SessionPackageDesktop({
    service: { exportTo } as unknown as SessionPackageService,
    translate: englishNativeTranslator,
    withDataRootWrite: (work) => work(),
    afterImport: async () => undefined,
    onOperationChanged: (snapshot) => {
      // lastExport is private and cleared on success; capture it while an export holds it.
      const remembered = (desktop as unknown as { lastExport?: unknown }).lastExport
      if (remembered) rememberedLastExports.push(remembered)
      if (snapshot.kind === 'export' && snapshot.state === 'awaiting-selection')
        queueMicrotask(() => {
          void desktop.respond({
            action: 'select',
            operationId: snapshot.id,
            excludedStorageKeys: []
          })
        })
    }
  })
  return { desktop, rememberedLastExports }
}

const stageDownloadPolicy = (desktop: SessionPackageDesktop): boolean =>
  (desktop as unknown as { stageDownloadForRetries: boolean }).stageDownloadForRetries

afterEach(async () => {
  vi.clearAllMocks()
  vi.mocked(dialog.showSaveDialog).mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

it('stages the .science download for stageDownload callers without a native dialog', async () => {
  const exportTo = vi.fn(
    async (_request: SessionPackageRequest, archive: string, options: ExportToOptions) => {
      await selectEverything(options, 'Web Session')
      await writeArchive(archive)
    }
  )
  const { desktop, rememberedLastExports } = createDesktop(exportTo)
  try {
    const first = await desktop.export(request, undefined, undefined, { stageDownload: true })
    expect(first).toMatchObject({ saved: true })
    const firstPath = first.filePath!
    expect(dirname(firstPath)).toBe(stagingDirectory)
    expect(extname(firstPath)).toBe('.science')
    expect(basename(firstPath)).toContain('Web Session')
    expect(basename(firstPath)).toContain(dateStamp())
    expect(await readFile(firstPath, 'utf8')).toBe('package-bytes')
    // The renderer downloads this path, so main never opens the native save dialog.
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(
      rememberedLastExports.some((entry) => (entry as { filePath?: string }).filePath === firstPath)
    ).toBe(true)
    expect(stageDownloadPolicy(desktop)).toBe(true)

    const second = await desktop.export(request, undefined, undefined, { stageDownload: true })
    expect(second).toMatchObject({ saved: true })
    // Same day and title: the collision suffix keeps the first download intact.
    expect(second.filePath).not.toBe(firstPath)
    expect(dirname(second.filePath!)).toBe(stagingDirectory)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  } finally {
    await desktop.close()
  }
})

it('keeps the sensitive-content retry on the staged path instead of the native dialog', async () => {
  const exportTo = vi.fn(
    async (_request: SessionPackageRequest, archive: string, options: ExportToOptions) => {
      if (!options.allowSensitiveContent)
        throw new PackageSensitiveContentError(
          'session.json @0?token=synthetic-private-value',
          'token',
          buildSensitiveContentEvidence(
            'token=synthetic-private-value',
            { offset: 0, length: 5, rule: 'token' },
            'session.json'
          )
        )
      await selectEverything(options, 'Private Session')
      await writeArchive(archive)
    }
  )
  const { desktop } = createDesktop(exportTo)
  try {
    await expect(
      desktop.export(request, undefined, undefined, { stageDownload: true })
    ).rejects.toThrow('Sensitive content detected')
    const failed = desktop.operations.snapshot!
    expect(failed.sensitiveContent).toHaveLength(1)
    expect(stageDownloadPolicy(desktop)).toBe(true)

    await expect(
      desktop.respond({ action: 'export-with-sensitive-content', operationId: failed.id })
    ).resolves.toMatchObject({ state: 'succeeded' })
    // respond() passes no export options: the retry must inherit the staged policy and never
    // fall into the headless native-dialog branch.
    expect(stageDownloadPolicy(desktop)).toBe(true)
    expect(exportTo).toHaveBeenCalledTimes(2)
    expect(exportTo.mock.calls[1][2].allowSensitiveContent).toBe(true)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    const stagedPath = desktop.operations.snapshot!.result!.filePath!
    expect(dirname(stagedPath)).toBe(stagingDirectory)
    expect(extname(stagedPath)).toBe('.science')
    expect(await readFile(stagedPath, 'utf8')).toBe('package-bytes')
  } finally {
    await desktop.close()
  }
})

it('keeps the Electron save-dialog path when stageDownload is not requested', async () => {
  const destination = join(await createTemporaryDirectory(), 'electron.science')
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: destination })
  const exportTo = vi.fn(
    async (_request: SessionPackageRequest, archive: string, options: ExportToOptions) => {
      await selectEverything(options, 'Desktop Session')
      await writeArchive(archive)
    }
  )
  const { desktop } = createDesktop(exportTo)
  try {
    await expect(desktop.export(request)).resolves.toEqual({ saved: true, filePath: destination })
    expect(dialog.showSaveDialog).toHaveBeenCalledOnce()
    expect(stageDownloadPolicy(desktop)).toBe(false)
    expect(await readFile(destination, 'utf8')).toBe('package-bytes')
  } finally {
    await desktop.close()
  }
})

it('keeps explicit-destination CLI exports dialog-free and outside the staging directory', async () => {
  const destination = join(await createTemporaryDirectory(), 'cli.science')
  const exportTo = vi.fn(
    async (_request: SessionPackageRequest, archive: string, options: ExportToOptions) => {
      expect(options.selectFiles).toBeUndefined()
      await writeArchive(archive)
    }
  )
  const { desktop } = createDesktop(exportTo)
  try {
    await expect(desktop.export(request, 'cli-client', destination)).resolves.toEqual({
      saved: true,
      filePath: destination
    })
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(stageDownloadPolicy(desktop)).toBe(false)
    expect(await readFile(destination, 'utf8')).toBe('package-bytes')
  } finally {
    await desktop.close()
  }
})

it('prunes staged downloads older than one hour before staging a new one', async () => {
  await mkdir(stagingDirectory, { recursive: true })
  const stale = join(stagingDirectory, 'stale-check.science')
  const fresh = join(stagingDirectory, 'fresh-check.science')
  await writeFile(stale, 'stale')
  await writeFile(fresh, 'fresh')
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(stale, twoHoursAgo, twoHoursAgo)
  const exportTo = vi.fn(
    async (_request: SessionPackageRequest, archive: string, options: ExportToOptions) => {
      await selectEverything(options, 'Prune Session')
      await writeArchive(archive)
    }
  )
  const { desktop } = createDesktop(exportTo)
  try {
    const result = await desktop.export(request, undefined, undefined, { stageDownload: true })
    expect(result).toMatchObject({ saved: true })
    expect(dirname(result.filePath!)).toBe(stagingDirectory)
    await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(fresh)).isFile()).toBe(true)
  } finally {
    await desktop.close()
    await rm(stale, { force: true })
    await rm(fresh, { force: true })
  }
})

it('keeps the admitted export policy when a concurrent desktop export is rejected', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const { desktop } = createDesktop(async (_request, archive, options) => {
    await blocked
    await selectEverything(options, 'Concurrent Session')
    await writeArchive(archive)
  })
  try {
    const pending = desktop.export(request, undefined, undefined, { stageDownload: true })
    await expect(desktop.export(request)).rejects.toThrow('already in progress')
    expect(stageDownloadPolicy(desktop)).toBe(true)
    release()
    await pending
  } finally {
    release()
    await desktop.close()
  }
})
