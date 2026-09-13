import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined,
  window: null as unknown,
  fromWebContents: vi.fn(),
  openDialog: vi.fn(),
  saveDialog: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      if (channel === native.failAt) throw new Error(`install failed: ${channel}`)
      if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      native.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => native.handlers.delete(channel)
  },
  BrowserWindow: { fromWebContents: native.fromWebContents },
  dialog: { showOpenDialog: native.openDialog, showSaveDialog: native.saveDialog }
}))

import { CONNECTOR_TEMPLATE_MAX_BYTES } from '../../shared/settings'
import {
  createIpcHandlerInstallationScope,
  disposeIpcHandlerRegistry,
  ipcMainHandle
} from '../ipc-handler-registry'
import type { InstalledElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { registerSettingsIpcHandlers } from '../settings/ipc'
import { createSettingsElectronSurface } from './settings'

type Owners = Parameters<typeof createSettingsElectronSurface>[0]
const fixtures = (): {
  owners: Owners
  event: IpcMainInvokeEvent
  service: Record<string, ReturnType<typeof vi.fn>>
  setSkillEnabled: ReturnType<typeof vi.fn>
  readCurrentSnapshot: ReturnType<typeof vi.fn>
} => {
  const service = {
    getPreflight: vi.fn().mockResolvedValue({ needsSetup: false }),
    previewCustomServerTemplateImport: vi.fn().mockResolvedValue({ ready: true }),
    buildCustomServerTemplateExport: vi.fn().mockResolvedValue({
      preview: {
        connectorId: 'server-id',
        ready: true,
        diagnostics: [],
        digest: 'digest',
        suggestedFileName: 'connector.json',
        mcpClientDigest: 'mcp-digest',
        mcpClientSuggestedFileName: 'mcp.json'
      },
      contents: '{"schemaVersion":1}\n',
      mcpClientContents: '{"mcpServers":{}}\n'
    }),
    buildSkillExport: vi.fn().mockResolvedValue({
      fileName: 'skill.zip',
      archiveBytes: new Uint8Array([1, 2, 3])
    })
  }
  const setSkillEnabled = vi.fn().mockResolvedValue([])
  const readCurrentSnapshot = vi.fn().mockResolvedValue({ revision: 12 })
  return {
    service,
    setSkillEnabled,
    readCurrentSnapshot,
    event: { sender: Object.assign(new EventEmitter(), { id: 42 }) } as IpcMainInvokeEvent,
    owners: {
      // Only invoked owner methods are controlled here; their complete behavior has owner tests.
      service: service as unknown as Owners['service'],
      workflows: { skills: { setSkillEnabled } } as unknown as Owners['workflows'],
      snapshotCommits: { readCurrentSnapshot } as unknown as Owners['snapshotCommits'],
      listAppIconPreviews: vi.fn(() => []),
      translate: (text) => `translated: ${text}`
    }
  }
}
const invoke = (channel: string, event: IpcMainInvokeEvent, request?: unknown): unknown =>
  native.handlers.get(channel)!(event, request)
const installations: InstalledElectronSurfaceAdapter[] = []
const install = async (owners: Owners): Promise<InstalledElectronSurfaceAdapter> => {
  const installed = await createSettingsElectronSurface(owners).install()
  installations.push(installed)
  return installed
}
let directory: string
beforeEach(async () => {
  vi.clearAllMocks()
  native.failAt = undefined
  native.window = { id: 'sender-window' }
  native.fromWebContents.mockImplementation(() => native.window)
  native.openDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  native.saveDialog.mockResolvedValue({ canceled: true })
  directory = await mkdtemp(join(tmpdir(), 'settings-surface-'))
})
afterEach(async () => {
  for (const installed of installations.splice(0)) await installed.uninstall()
  disposeIpcHandlerRegistry()
  await rm(directory, { recursive: true, force: true })
})

describe('Settings Electron surface', () => {
  it('installs lazily with registrar parity and routes shared owners', async () => {
    const { owners, event, service, setSkillEnabled, readCurrentSnapshot } = fixtures()
    const scope = createIpcHandlerInstallationScope()
    registerSettingsIpcHandlers(owners)
    const expectedChannels = [...native.handlers.keys()]
    await scope.complete().uninstall()
    const surface = createSettingsElectronSurface(owners)
    expect(surface.name).toBe('settings')
    expect(native.handlers.size).toBe(0)
    installations.push(await surface.install())
    expect([...native.handlers.keys()]).toEqual(expectedChannels)
    expect(service.getPreflight).not.toHaveBeenCalled()
    await expect(invoke('settings:get-preflight', event)).resolves.toEqual({ needsSetup: false })
    await expect(invoke('settings:get-settings', event)).resolves.toEqual({ revision: 12 })
    expect(readCurrentSnapshot).toHaveBeenCalledOnce()
    const request = { id: 'skill-id', enabled: true }
    await invoke('settings:set-skill-enabled', event, request)
    expect(setSkillEnabled).toHaveBeenCalledWith(request)
    expect(invoke('settings:list-app-icons', event)).toEqual([])
    expect(owners.listAppIconPreviews).toHaveBeenCalledOnce()
  })

  it('imports a selected file at the byte limit through the preview owner', async () => {
    const { owners, event, service } = fixtures()
    await install(owners)
    const filePath = join(directory, 'connector.json')
    const contents = 'x'.repeat(CONNECTOR_TEMPLATE_MAX_BYTES)
    await writeFile(filePath, contents)
    native.openDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    await expect(invoke('settings:select-custom-server-template', event)).resolves.toEqual({
      cancelled: false,
      fileName: 'connector.json',
      preview: { ready: true }
    })
    expect(service.previewCustomServerTemplateImport).toHaveBeenCalledWith(contents)
    expect(native.openDialog).toHaveBeenCalledWith({
      title: 'translated: Import Connector configuration',
      properties: ['openFile'],
      filters: [{ name: 'translated: Connector configuration', extensions: ['json'] }]
    })
  })

  it('rejects oversized selected files before preview', async () => {
    const { owners, event, service } = fixtures()
    await install(owners)
    const filePath = join(directory, 'large.json')
    await writeFile(filePath, Buffer.alloc(CONNECTOR_TEMPLATE_MAX_BYTES + 1))
    native.openDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    await expect(invoke('settings:select-custom-server-template', event)).rejects.toThrow(
      'Connector configuration files must be 256 KiB or smaller'
    )
    expect(service.previewCustomServerTemplateImport).not.toHaveBeenCalled()
  })

  it('preserves canceled selection and supplied-file preview without opening a dialog', async () => {
    const { owners, event, service } = fixtures()
    await install(owners)
    await expect(invoke('settings:select-custom-server-template', event)).resolves.toEqual({
      cancelled: true
    })
    expect(service.previewCustomServerTemplateImport).not.toHaveBeenCalled()
    native.openDialog.mockClear()
    await expect(
      invoke('settings:select-custom-server-template', event, {
        fileName: 'drop.json',
        contents: '{}'
      })
    ).resolves.toEqual({ cancelled: false, fileName: 'drop.json', preview: { ready: true } })
    expect(service.previewCustomServerTemplateImport).toHaveBeenCalledWith('{}')
    expect(native.openDialog).not.toHaveBeenCalled()
  })

  it.each([
    ['open-science', 'digest', 'connector.json', '{"schemaVersion":1}\n'],
    ['mcp-client', 'mcp-digest', 'mcp.json', '{"mcpServers":{}}\n']
  ])(
    'exports %s configuration through the sender-owned dialog',
    async (format, expectedDigest, name, contents) => {
      const { owners, event, service } = fixtures()
      await install(owners)
      const filePath = join(directory, name)
      await writeFile(filePath, 'previous export')
      native.saveDialog.mockResolvedValue({ canceled: false, filePath })
      await expect(
        invoke('settings:export-custom-server-template', event, {
          id: 'server-id',
          format,
          expectedDigest
        })
      ).resolves.toEqual({ saved: true })
      expect(service.buildCustomServerTemplateExport).toHaveBeenCalledWith('server-id')
      expect(native.fromWebContents).toHaveBeenCalledWith(event.sender)
      expect(native.saveDialog).toHaveBeenCalledWith(native.window, {
        title: 'translated: Export Connector configuration',
        defaultPath: name,
        filters: [{ name: 'translated: Connector configuration', extensions: ['json'] }]
      })
      expect(await readFile(filePath, 'utf8')).toBe(contents)
      expect(await readdir(directory)).toEqual([name])
    }
  )

  it('rejects changed export contents before showing a save dialog', async () => {
    const { owners, event } = fixtures()
    await install(owners)
    await expect(
      invoke('settings:export-custom-server-template', event, {
        id: 'server-id',
        expectedDigest: 'old-digest'
      })
    ).rejects.toThrow('Connector configuration changed after preview; review it again')
    expect(native.saveDialog).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })

  it('exports skill bytes with the translated sender-owned dialog', async () => {
    const { owners, event, service } = fixtures()
    await install(owners)
    const filePath = join(directory, 'skill.zip')
    native.saveDialog.mockResolvedValue({ canceled: false, filePath })
    await expect(invoke('settings:export-skill', event, { id: 'skill-id' })).resolves.toEqual({
      saved: true
    })
    expect(service.buildSkillExport).toHaveBeenCalledWith('skill-id')
    expect(native.fromWebContents).toHaveBeenCalledWith(event.sender)
    expect(native.saveDialog).toHaveBeenCalledWith(native.window, {
      title: 'translated: Export Skill',
      defaultPath: 'skill.zip',
      filters: [{ name: 'translated: Skill ZIP', extensions: ['zip'] }]
    })
    expect(await readFile(filePath)).toEqual(Buffer.from([1, 2, 3]))
    expect(await readdir(directory)).toEqual(['skill.zip'])
  })

  it.each(['settings:export-skill', 'settings:export-custom-server-template'])(
    'leaves an existing file untouched when %s is canceled without a parent window',
    async (channel) => {
      const { owners, event } = fixtures()
      await install(owners)
      native.window = null
      const filePath = join(directory, 'existing')
      await writeFile(filePath, 'keep')
      native.saveDialog.mockResolvedValue({ canceled: true, filePath })
      await expect(invoke(channel, event, { id: 'id', expectedDigest: 'digest' })).resolves.toEqual(
        { saved: false }
      )
      expect(native.saveDialog.mock.calls[0]).toHaveLength(1)
      expect(await readFile(filePath, 'utf8')).toBe('keep')
      expect(await readdir(directory)).toEqual(['existing'])
    }
  )

  it('rolls back a partial installation and supports idempotent uninstall and reinstall', async () => {
    const { owners, event } = fixtures()
    ipcMainHandle('unrelated:ping', () => 'pong')
    native.failAt = 'compute:bookmarks:set'
    expect(() => createSettingsElectronSurface(owners).install()).toThrow(
      'install failed: compute:bookmarks:set'
    )
    expect([...native.handlers.keys()]).toEqual(['unrelated:ping'])
    native.failAt = undefined
    const installed = await install(owners)
    await installed.uninstall()
    await installed.uninstall()
    expect([...native.handlers.keys()]).toEqual(['unrelated:ping'])
    await install(owners)
    expect(invoke('unrelated:ping', event)).toBe('pong')
    await expect(invoke('settings:get-preflight', event)).resolves.toEqual({ needsSetup: false })
  })
})
