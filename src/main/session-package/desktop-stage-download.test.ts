import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { englishNativeTranslator } from '../locale/main-process-messages'
import type { SessionPackagePreview, SessionPackageRequest } from '../../shared/session-package'
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
  onSensitiveContent?: (finding: PackageSensitiveContentError) => void
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
) => Promise<SessionPackagePreview>

const request = { projectId: 'project-1', sessionId: 'session-1' }
const stagingDirectory = tmpdir()
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

const writeArchive = async (archive: string): Promise<SessionPackagePreview> => {
  await writeFile(archive, 'package-bytes')
  return {
    title: 'Package fixture',
    projectName: 'Project fixture',
    branchCount: 1,
    messageCount: 0,
    fileCount: 0,
    totalBytes: Buffer.byteLength('package-bytes'),
    omissions: []
  }
}

const dateStamp = (now = new Date()): string =>
  [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')

const createDesktop = (exportTo: ExportTo): { desktop: SessionPackageDesktop } => {
  const desktop = new SessionPackageDesktop({
    service: { exportTo } as unknown as SessionPackageService,
    translate: englishNativeTranslator,
    withDataRootWrite: (work) => work(),
    afterImport: async () => undefined,
    onOperationChanged: (snapshot) => {
      if (
        snapshot.kind === 'export' &&
        snapshot.state === 'awaiting-selection' &&
        snapshot.progress.phase === 'selecting'
      )
        queueMicrotask(() => {
          void desktop.respond({
            action: 'select',
            operationId: snapshot.id,
            excludedStorageKeys: []
          })
        })
    }
  })
  return { desktop }
}

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
      return writeArchive(archive)
    }
  )
  const { desktop } = createDesktop(exportTo)
  try {
    const first = await desktop.export(request, undefined, undefined, { stageDownload: true })
    expect(first).toMatchObject({ saved: true })
    const firstPath = first.filePath!
    expect(dirname(dirname(dirname(firstPath)))).toBe(stagingDirectory)
    expect(extname(firstPath)).toBe('.science')
    expect(basename(firstPath)).toContain('Web Session')
    expect(basename(firstPath)).toContain(dateStamp())
    expect(await readFile(firstPath, 'utf8')).toBe('package-bytes')
    // The renderer downloads this path, so main never opens the native save dialog.
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()

    const second = await desktop.export(request, undefined, undefined, { stageDownload: true })
    expect(second).toMatchObject({ saved: true })
    // Same day and title: private export directories preserve both downloads.
    expect(second.filePath).not.toBe(firstPath)
    expect(dirname(second.filePath!)).not.toBe(dirname(firstPath))
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  } finally {
    await desktop.close()
  }
})

it('keeps the confirmed Web export on its browser download path', async () => {
  const exportTo = vi.fn(
    async (_request: SessionPackageRequest, archive: string, options: ExportToOptions) => {
      options.onSensitiveContent?.(
        new PackageSensitiveContentError(
          'session.json @0?token=synthetic-private-value',
          'token',
          buildSensitiveContentEvidence(
            'token=synthetic-private-value',
            { offset: 0, length: 5, rule: 'token' },
            'session.json'
          )
        )
      )
      await selectEverything(options, 'Private Session')
      return writeArchive(archive)
    }
  )
  const { desktop } = createDesktop(exportTo)
  try {
    const exporting = desktop.export(request, undefined, undefined, { stageDownload: true })
    await expect.poll(() => desktop.operations.snapshot?.sensitiveExportReview).toBeDefined()
    const pending = desktop.operations.snapshot!
    expect(pending.sensitiveExportReview?.destination).toBeUndefined()
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await desktop.respond(
      { action: 'export-with-sensitive-content', operationId: pending.id },
      'desktop'
    )
    await expect(exporting).resolves.toMatchObject({ saved: true })
    expect(exportTo).toHaveBeenCalledOnce()
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    const stagedPath = desktop.operations.snapshot!.result!.filePath!
    expect(dirname(dirname(dirname(stagedPath)))).toBe(stagingDirectory)
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
      return writeArchive(archive)
    }
  )
  const { desktop } = createDesktop(exportTo)
  try {
    await expect(desktop.export(request)).resolves.toEqual({ saved: true, filePath: destination })
    expect(dialog.showSaveDialog).toHaveBeenCalledOnce()
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
      return writeArchive(archive)
    }
  )
  const { desktop } = createDesktop(exportTo)
  try {
    await expect(desktop.export(request, 'cli-client', destination)).resolves.toEqual({
      saved: true,
      filePath: destination
    })
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(await readFile(destination, 'utf8')).toBe('package-bytes')
  } finally {
    await desktop.close()
  }
})

it('isolates hosts and prunes only their own expired export directories', async () => {
  const exportTo: ExportTo = async (_request, archive, options) => {
    await selectEverything(options, 'Same title')
    return writeArchive(archive)
  }
  const first = createDesktop(exportTo).desktop
  const second = createDesktop(exportTo).desktop
  try {
    const [a, b] = await Promise.all([
      first.export(request, undefined, undefined, { stageDownload: true }),
      second.export(request, undefined, undefined, { stageDownload: true })
    ])
    expect(a.filePath).not.toBe(b.filePath)
    expect(basename(a.filePath!)).toBe(basename(b.filePath!))
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(dirname(a.filePath!), old, old)
    await utimes(dirname(b.filePath!), old, old)
    await first.export(request, undefined, undefined, { stageDownload: true })
    await expect(stat(a.filePath!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(b.filePath!, 'utf8')).toBe('package-bytes')
    await first.close()
    expect(await readFile(b.filePath!, 'utf8')).toBe('package-bytes')
  } finally {
    await first.close()
    await second.close()
  }
})

it('reclaims an exited host download root without touching a live host or legacy files', async () => {
  const exportTo: ExportTo = async (_request, archive, options) => {
    await selectEverything(options, 'Web Session')
    return writeArchive(archive)
  }
  const previous = createDesktop(exportTo).desktop
  const other = createDesktop(exportTo).desktop
  const next = createDesktop(exportTo).desktop
  const legacy = await mkdtemp(join(stagingDirectory, 'open-science-package-exports-'))
  const legacyArchive = join(legacy, 'legacy.science')
  const host = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore']
  })
  const exited = once(host, 'close')
  // Observe launch errors even if a fixture operation fails before we await the exit.
  void exited.catch(() => {})
  let abandoned: string | undefined
  try {
    const oldDownload = await previous.export(request, undefined, undefined, {
      stageDownload: true
    })
    const oldRoot = dirname(dirname(oldDownload.filePath!))
    const otherRoot = join(
      stagingDirectory,
      basename(oldRoot).replace(`-${process.pid}-`, `-${host.pid}-`)
    )
    if (otherRoot !== oldRoot) await rename(oldRoot, otherRoot)
    abandoned = otherRoot
    await writeArchive(legacyArchive)

    await other.export(request, undefined, undefined, { stageDownload: true })
    const oldArchive = join(
      otherRoot,
      basename(dirname(oldDownload.filePath!)),
      basename(oldDownload.filePath!)
    )
    expect(await readFile(oldArchive, 'utf8')).toBe('package-bytes')
    host.stdin.end()
    expect((await exited)[0]).toBe(0)

    await next.export(request, undefined, undefined, { stageDownload: true })
    await expect(stat(otherRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(legacyArchive, 'utf8')).toBe('package-bytes')
  } finally {
    host.stdin.end()
    await exited.catch(() => {})
    await Promise.all([previous.close(), other.close(), next.close()])
    if (abandoned) await rm(abandoned, { recursive: true, force: true })
    await rm(legacy, { recursive: true, force: true })
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
    return writeArchive(archive)
  })
  try {
    const pending = desktop.export(request, undefined, undefined, { stageDownload: true })
    await expect(desktop.export(request)).rejects.toThrow('already in progress')
    release()
    const result = await pending
    expect(result.filePath).toContain(stagingDirectory)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  } finally {
    release()
    await desktop.close()
  }
})
