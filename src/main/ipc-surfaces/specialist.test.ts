import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined,
  appPath: '',
  getVersion: vi.fn(() => '1.2.3'),
  open: vi.fn(),
  save: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getVersion: native.getVersion, getAppPath: () => native.appPath },
  dialog: { showOpenDialog: native.open, showSaveDialog: native.save },
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      if (native.failAt === channel) throw new Error(`install failed: ${channel}`)
      if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      native.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => native.handlers.delete(channel)
  }
}))

import { SPECIALIST_IPC } from '../../shared/specialist'
import { SPECIALIST_MARKETPLACE_IPC } from '../../shared/specialist-marketplace'
import { SPECIALIST_PACKAGE_ARCHIVE_LIMITS } from '../../shared/specialist-package'
import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import { createSpecialistElectronSurface } from './specialist'

type Owners = Parameters<typeof createSpecialistElectronSurface>[0]
const invoke = (channel: string, request?: unknown): unknown => {
  const handler = native.handlers.get(channel)
  if (!handler) throw new Error(`missing channel: ${channel}`)
  return handler(event, request)
}
let root: string
let event: IpcMainInvokeEvent
const report = { diagnostics: [], installable: false }
const archive = { fileName: 'research.zip', archiveBytes: new Uint8Array([1, 2, 3]) }
const fixtures = (): {
  owners: Owners
  packages: Record<'preview' | 'previewOversizedArchive' | 'export' | 'report' | 'dispose', Mock>
  service: Record<'subscribe' | 'listForSettingsSnapshot' | 'setEnabled' | 'update', Mock>
  applicationOwner: { beginUpload: Mock }
  requestSwitch: Mock
  resolve: Mock
  marketplace: Record<'list' | 'installedSpecialistProvenance', Mock>
  reload: Mock
} => {
  const packages = {
    preview: vi.fn(async () => ({ candidateToken: 'candidate' })),
    previewOversizedArchive: vi.fn(async () => ({ candidateToken: 'oversized' })),
    export: vi.fn(async () => archive),
    report: vi.fn(() => report),
    dispose: vi.fn()
  }
  const service = {
    subscribe: vi.fn(),
    listForSettingsSnapshot: vi.fn(async () => ({ items: [], integrity: { status: 'ok' } })),
    setEnabled: vi.fn(async () => ({ id: 'specialist' })),
    update: vi.fn(async () => ({ id: 'specialist' }))
  }
  const applicationOwner = {
    beginUpload: vi.fn(async () => ({ receivedBytes: 0 }))
  }
  const requestSwitch = vi.fn(async () => ({ status: 'applied', contextReset: false }))
  const resolve = vi.fn(async () => ({ kind: 'main' }))
  const marketplace = {
    list: vi.fn(async () => ({ items: [] })),
    installedSpecialistProvenance: vi.fn(async () => new Map())
  }
  const reload = vi.fn()
  const owners = {
    specialistService: service,
    sessionBindingService: { resolve },
    sessionSpecialistReconfiguration: { requestSwitch },
    onProfilesChanged: reload,
    specialistPackageService: packages,
    marketplaceService: marketplace,
    specialistApplicationOwner: applicationOwner,
    translate: (text: string) => `translated:${text}`
  } as unknown as Owners
  return {
    owners,
    packages,
    service,
    applicationOwner,
    requestSwitch,
    resolve,
    marketplace,
    reload
  }
}

beforeEach(async () => {
  native.failAt = undefined
  vi.clearAllMocks()
  native.open.mockResolvedValue({ canceled: true, filePaths: [] })
  native.save.mockResolvedValue({ canceled: true })
  root = await mkdtemp(join(tmpdir(), 'specialist-surface-'))
  native.appPath = join(root, 'app.asar')
  const sender = Object.assign(new EventEmitter(), {
    id: 2701,
    isDestroyed: () => false,
    send: vi.fn()
  })
  event = { sender } as unknown as IpcMainInvokeEvent
})
afterEach(async () => {
  disposeIpcHandlerRegistry()
  await rm(root, { recursive: true, force: true })
})

describe('Specialist Electron surface', () => {
  it('installs lazily with the existing owners and invalidates callers on runtime disposal', async () => {
    const f = fixtures()
    const surface = createSpecialistElectronSurface(f.owners)
    expect(surface.name).toBe('specialist')
    expect(native.handlers.size).toBe(0)
    expect(native.getVersion).not.toHaveBeenCalled()
    await surface.install()
    expect(native.getVersion).toHaveBeenCalledOnce()
    expect([...native.handlers.keys()]).toMatchInlineSnapshot(`
      [
        "specialist:package-upload-begin",
        "specialist:package-upload-preview",
        "specialist:package-upload-abort",
        "specialist:list",
        "specialist:create",
        "specialist:export-preview",
        "specialist:export-save",
        "specialist:package-select",
        "specialist:package-install",
        "specialist:package-cancel",
        "specialist:package-report-save",
        "specialist:marketplace-list",
        "specialist:marketplace-source-inspect-github",
        "specialist:marketplace-source-add",
        "specialist:marketplace-source-remove",
        "specialist:marketplace-release-get",
        "specialist:marketplace-install-prepare",
        "specialist:marketplace-candidate-cancel",
        "specialist:marketplace-install",
        "specialist:update",
        "specialist:set-enabled",
        "specialist:delete-preview",
        "specialist:delete",
        "specialist:duplicate",
        "specialist:export-contribution-template",
        "specialist:set-session-specialist",
        "specialist:resolve-session-specialist",
      ]
    `)
    expect(f.service.subscribe).not.toHaveBeenCalled()
    const upload = { transferId: 'transfer', name: 'research.zip', size: 3 }
    await invoke('specialist:package-upload-begin', upload)
    const invocation = f.applicationOwner.beginUpload.mock.calls[0][0] as unknown as {
      callerContext: unknown
      callerLease: { isCurrent(): boolean }
      args: unknown[]
    }
    expect(invocation).toMatchObject({
      callerContext: { surface: 'electron', clientId: '2701' },
      args: [upload]
    })
    expect(invocation.callerLease.isCurrent()).toBe(true)
    await invoke(SPECIALIST_IPC.SET_SESSION_SPECIALIST, {
      sessionId: 'session',
      specialistId: 'specialist'
    })
    expect(f.requestSwitch).toHaveBeenCalledWith('session', 'specialist')
    await invoke(SPECIALIST_IPC.RESOLVE_SESSION_SPECIALIST, { sessionId: 'session' })
    expect(f.resolve).toHaveBeenCalledWith('session')
    await invoke(SPECIALIST_IPC.SET_ENABLED, { id: 'specialist', enabled: true })
    expect(f.reload).toHaveBeenCalledOnce()
    await invoke(SPECIALIST_IPC.UPDATE, { id: 'specialist', revision: 4, iconKey: 'flask' })
    expect(f.reload).toHaveBeenCalledOnce()
    await invoke(SPECIALIST_MARKETPLACE_IPC.LIST, { forceRefresh: true })
    expect(f.marketplace.list).toHaveBeenCalledWith({ forceRefresh: true })
    disposeIpcHandlerRegistry()
    expect(invocation.callerLease.isCurrent()).toBe(false)
  })

  it.each([SPECIALIST_IPC.SELECT_PACKAGE, SPECIALIST_IPC.RESOLVE_SESSION_SPECIALIST])(
    'rolls back a failed installation at %s without removing external channels',
    async (channel) => {
      ipcMainHandle('test:external', () => 'external')
      native.failAt = channel
      const f = fixtures()
      expect(() => createSpecialistElectronSurface(f.owners).install()).toThrow(
        `install failed: ${channel}`
      )
      expect([...native.handlers.keys()]).toEqual(['test:external'])
      expect(f.service.subscribe).not.toHaveBeenCalled()
      native.failAt = undefined
      const installed = await createSpecialistElectronSurface(f.owners).install()
      const channels = [...native.handlers.keys()]
      await installed.uninstall()
      await installed.uninstall()
      expect([...native.handlers.keys()]).toEqual(['test:external'])
      const replacement = await createSpecialistElectronSurface(f.owners).install()
      expect([...native.handlers.keys()]).toEqual(channels)
      await replacement.uninstall()
    }
  )

  it('selects native ZIP bytes for the renderer owner and preserves cancellation and size admission', async () => {
    const f = fixtures()
    await createSpecialistElectronSurface(f.owners).install()
    await expect(invoke(SPECIALIST_IPC.SELECT_PACKAGE)).resolves.toEqual({ cancelled: true })
    expect(f.packages.preview).not.toHaveBeenCalled()
    const path = join(root, 'research.zip')
    await writeFile(path, archive.archiveBytes)
    native.open.mockResolvedValue({ canceled: false, filePaths: [path] })
    await expect(invoke(SPECIALIST_IPC.SELECT_PACKAGE)).resolves.toEqual({
      candidateToken: 'candidate'
    })
    expect(f.packages.preview).toHaveBeenCalledWith(archive.archiveBytes, 2701)
    expect(native.open).toHaveBeenLastCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'translated:Specialist ZIP', extensions: ['zip'] }]
    })
    await truncate(path, SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes + 1)
    await invoke(SPECIALIST_IPC.SELECT_PACKAGE)
    expect(f.packages.previewOversizedArchive).toHaveBeenCalledWith(
      SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes + 1,
      2701
    )
    expect(f.packages.preview).toHaveBeenCalledOnce()
    native.open.mockResolvedValue({ canceled: false, filePaths: [join(root, 'missing.zip')] })
    await expect(invoke(SPECIALIST_IPC.SELECT_PACKAGE)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes exported ZIP bytes and UTF-8 reports through native save dialogs', async () => {
    const f = fixtures()
    await createSpecialistElectronSurface(f.owners).install()
    const request = { specialistId: 'specialist', expectedRevision: 4, includedSkillIds: [] }
    await expect(invoke(SPECIALIST_IPC.EXPORT, request)).resolves.toEqual({ saved: false })
    const zipPath = join(root, 'saved.zip')
    native.save.mockResolvedValue({ canceled: false, filePath: zipPath })
    await expect(invoke(SPECIALIST_IPC.EXPORT, request)).resolves.toEqual({ saved: true })
    expect(f.packages.export).toHaveBeenLastCalledWith(request)
    expect(new Uint8Array(await readFile(zipPath))).toEqual(archive.archiveBytes)
    const reportPath = join(root, 'report.json')
    native.save.mockResolvedValue({ canceled: false, filePath: reportPath })
    await expect(
      invoke(SPECIALIST_IPC.SAVE_PACKAGE_REPORT, { candidateToken: 'candidate' })
    ).resolves.toEqual({ saved: true })
    expect(f.packages.report).toHaveBeenCalledWith('candidate', 2701)
    expect(await readFile(reportPath, 'utf8')).toBe(`${JSON.stringify(report, null, 2)}\n`)
    expect(native.save).toHaveBeenLastCalledWith({
      defaultPath: 'specialist-package-diagnostics.json',
      filters: [{ name: 'translated:JSON report', extensions: ['json'] }]
    })
  })

  it('reads the current unpacked template only after consent and preserves export errors', async () => {
    const f = fixtures()
    await createSpecialistElectronSurface(f.owners).install()
    await expect(invoke(SPECIALIST_IPC.EXPORT_CONTRIBUTION_TEMPLATE)).resolves.toEqual({
      saved: false
    })
    const readmeDirectory = join(
      root,
      'app.asar.unpacked',
      'resources',
      'specialists',
      'template',
      'v1'
    )
    await mkdir(readmeDirectory, { recursive: true })
    await writeFile(join(readmeDirectory, 'README.txt'), 'Template 文本', 'utf8')
    const destination = join(root, 'template.zip')
    native.save.mockResolvedValue({ canceled: false, filePath: destination })
    await expect(invoke(SPECIALIST_IPC.EXPORT_CONTRIBUTION_TEMPLATE)).resolves.toEqual({
      saved: true
    })
    const originalZip = await readFile(destination)
    const zip = unzipSync(originalZip)
    expect(strFromU8(zip['README.txt'])).toBe('Template 文本')
    expect(JSON.parse(strFromU8(zip['manifest.json']))).toMatchObject({
      exported_with_app_version: '1.2.3'
    })
    expect(native.save).toHaveBeenLastCalledWith({
      title: 'translated:Save contribution template',
      defaultPath: 'openscience-specialist-template.zip',
      filters: [{ name: 'translated:ZIP archive', extensions: ['zip'] }]
    })
    native.appPath = join(root, 'missing-app')
    await expect(invoke(SPECIALIST_IPC.EXPORT_CONTRIBUTION_TEMPLATE)).rejects.toThrow(
      'Could not save contribution template.'
    )
    expect(await readFile(destination)).toEqual(originalZip)
  })
})
