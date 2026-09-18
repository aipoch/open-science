import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined,
  root: '',
  getPath: vi.fn(),
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
  app: { getPath: native.getPath },
  BrowserWindow: { fromWebContents: native.fromWebContents },
  dialog: { showOpenDialog: native.openDialog, showSaveDialog: native.saveDialog }
}))
vi.mock('../storage-root', () => ({
  resolveDataRoot: () => native.root,
  resolveStorageRoot: () => native.root
}))

import type { NotebookEnvironmentLock } from '../../shared/notebook'
import { registerArtifactIpcHandlers } from '../artifacts/ipc'
import { registerArtifactReproducibilityIpcHandlers } from '../artifacts/artifact-reproducibility-ipc'
import {
  ArtifactReproducibilityReceiptStore,
  bindArtifactReproducibilityReceipts
} from '../artifacts/artifact-reproducibility-receipts'
import { bindArtifactReproducibilityExecutionEvidence } from '../artifacts/provenance-reproducibility-execution-evidence'
import { sha256 } from '../artifacts/provenance-canonical'
import {
  createIpcHandlerInstallationScope,
  disposeIpcHandlerRegistry,
  ipcMainHandle
} from '../ipc-handler-registry'
import type { InstalledElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { beginMigration, clearMigrationPending } from '../storage/migration-state'
import { createArtifactElectronSurface } from './artifacts'

type Owners = Parameters<typeof createArtifactElectronSurface>[0]
const scope = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1'
}
const lock: NotebookEnvironmentLock = {
  schemaVersion: 1,
  format: 'environment-lock-bundle',
  kernelKind: 'python',
  environmentName: 'analysis',
  components: [
    {
      ecosystem: 'conda',
      format: 'conda-explicit-md5',
      resolution: 'locked',
      explicitLock:
        '@EXPLICIT\nhttps://repo.example.test/python-3.12.conda#0123456789abcdef0123456789abcdef\n',
      packages: ['python']
    }
  ]
}
const serializedLock = `${JSON.stringify(lock)}\n`
const lockChecksum = sha256(serializedLock)
const lockRequest = { ...scope, lockChecksum }
const installations: InstalledElectronSurfaceAdapter[] = []
const invoke = (channel: string, event: IpcMainInvokeEvent, request: unknown): unknown => {
  const handler = native.handlers.get(channel)
  if (!handler) throw new Error(`missing channel: ${channel}`)
  return handler(event, request)
}
const install = async (owners: Owners): Promise<InstalledElectronSurfaceAdapter> => {
  const installation = await createArtifactElectronSurface(owners).install()
  installations.push(installation)
  return installation
}
const fixtures = (): {
  owners: Owners
  owner: Record<'start' | 'cancelOwner', ReturnType<typeof vi.fn>>
  order: string[]
  handlers: { getLineage: ReturnType<typeof vi.fn> }
  store: ArtifactReproducibilityReceiptStore
  importEnvironmentLock: ReturnType<typeof vi.fn>
  sender: EventEmitter & Pick<WebContents, 'id' | 'isDestroyed' | 'send'>
  event: IpcMainInvokeEvent
} => {
  const order: string[] = []
  const gate =
    (name: string) =>
    async <T>(operation: () => Promise<T>): Promise<T> => {
      order.push(`${name}:enter`)
      try {
        return await operation()
      } finally {
        order.push(`${name}:exit`)
      }
    }
  const runSessionMutation = vi.fn(
    <T>(_project: string, _session: string, operation: () => Promise<T>) =>
      gate('session')(operation)
  )
  const withSessionAvailable = vi.fn(
    <T>(_project: string, _session: string, operation: () => Promise<T>) =>
      gate('archive')(operation)
  )
  const withIdleVersion = vi.fn(<T>(_scope: unknown, operation: () => Promise<T>) =>
    gate('idle')(operation)
  )
  const owner = {
    start: vi.fn(async (_request, _sender, report) => {
      order.push('start')
      report({ attemptId: 'attempt-1' })
      return { attemptId: 'attempt-1' }
    }),
    cancel: vi.fn(),
    cancelOwner: vi.fn(),
    sessionCommand: vi.fn(async () => undefined),
    getCheck: vi.fn(),
    getCheckLog: vi.fn(),
    listReceipts: vi.fn(),
    withIdleVersion
  }
  const handlers = {
    getLineage: vi.fn(async () => ({ shared: true })),
    finalizeRunArtifacts: vi.fn(async () => [])
  }
  const provenance = { getLineage: vi.fn(async () => ({ selectedVersion: undefined })) }
  const store = new ArtifactReproducibilityReceiptStore({
    resolveVersionDirectory: async () => join(native.root, 'version')
  })
  bindArtifactReproducibilityReceipts(provenance, store)
  const readExecution = vi.fn(async () => ({
    reproducibilityRecipe: {
      environmentRequirements: [
        { lockChecksum, kernelKind: 'python', environmentName: 'analysis', lockState: 'available' }
      ]
    }
  }))
  bindArtifactReproducibilityExecutionEvidence(provenance, readExecution as never)
  const importEnvironmentLock = vi.fn(async () => ({ environmentName: 'repro-env', reused: false }))
  const sender = Object.assign(new EventEmitter(), {
    id: 42,
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  })
  const owners: Owners = {
    // Shared owner identities are controlled; real registrars, exporter, receipt store and registry run.
    artifactRepository: {} as Owners['artifactRepository'],
    artifactRunRegistry: {} as Owners['artifactRunRegistry'],
    artifactProvenanceRepository: provenance as unknown as Owners['artifactProvenanceRepository'],
    artifactHandlers: handlers as unknown as Owners['artifactHandlers'],
    artifactReproducibilityAttemptOwnerRef: {
      current: owner as unknown as NonNullable<
        Owners['artifactReproducibilityAttemptOwnerRef']['current']
      >
    },
    archiveCoordinator: {
      withSessionAvailable:
        withSessionAvailable as Owners['archiveCoordinator']['withSessionAvailable']
    },
    sessionPersistenceCoordinator: {
      runSessionMutation:
        runSessionMutation as Owners['sessionPersistenceCoordinator']['runSessionMutation']
    },
    notebookService: { importEnvironmentLock },
    translate: (text) => `translated: ${text}`
  }
  return {
    owners,
    owner,
    order,
    handlers,
    store,
    importEnvironmentLock,
    sender,
    event: { sender } as unknown as IpcMainInvokeEvent
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  native.failAt = undefined
  native.root = await mkdtemp(join(tmpdir(), 'artifact-surface-'))
  native.getPath.mockReturnValue(native.root)
  native.fromWebContents.mockReturnValue({ id: 'sender-window' })
  native.openDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  native.saveDialog.mockResolvedValue({ canceled: true })
  const locks = join(native.root, 'runtime', 'provenance', 'environment-locks')
  await mkdir(locks, { recursive: true })
  await writeFile(join(locks, `${lockChecksum}.json`), serializedLock)
})
afterEach(async () => {
  clearMigrationPending()
  for (const installation of installations.splice(0)) await installation.uninstall()
  disposeIpcHandlerRegistry()
  await rm(native.root, { recursive: true, force: true })
})

describe('Artifact Electron surface', () => {
  it('installs both real registrars lazily and routes the shared command owner', async () => {
    const { owners, owner, handlers, event } = fixtures()
    const registration = createIpcHandlerInstallationScope()
    registerArtifactIpcHandlers(
      owners.artifactRepository,
      owners.artifactRunRegistry,
      owners.artifactProvenanceRepository,
      undefined,
      owners.artifactHandlers
    )
    registerArtifactReproducibilityIpcHandlers(owner as never, {} as never)
    const expectedChannels = [...native.handlers.keys()]
    await registration.complete().uninstall()
    const surface = createArtifactElectronSurface(owners)
    expect(surface.name).toBe('artifacts')
    expect(native.handlers.size).toBe(0)
    expect(native.getPath).not.toHaveBeenCalled()
    installations.push(await surface.install())
    expect([...native.handlers.keys()]).toEqual(expectedChannels)
    expect(native.getPath).not.toHaveBeenCalled()
    await expect(invoke('artifacts:get-lineage', event, scope)).resolves.toEqual({ shared: true })
    expect(handlers.getLineage).toHaveBeenCalledWith(scope)
    await expect(
      invoke('artifacts:finalize-run', event, { claimId: 'claim-1', messageId: 'message-1' })
    ).resolves.toEqual({ ok: true, artifacts: [] })
  })

  it('resolves the lifecycle owner at install time and rejects a missing owner before registering', async () => {
    const { owners, owner } = fixtures()
    const reference: Owners['artifactReproducibilityAttemptOwnerRef'] = {}
    owners.artifactReproducibilityAttemptOwnerRef = reference
    const surface = createArtifactElectronSurface(owners)
    expect(() => surface.install()).toThrow('Artifact reproducibility lifecycle is not configured.')
    expect(native.handlers.size).toBe(0)
    Object.assign(reference, { current: owner })
    installations.push(await surface.install())
    expect(native.handlers.size).toBeGreaterThan(0)
  })

  it('preserves archive/session admission and renderer progress and cancellation identity', async () => {
    const { owners, order, event, sender, owner } = fixtures()
    await install(owners)
    const request = { ...scope, frontierId: 'original-inputs' }
    await invoke('artifacts:start-reproducibility-check', event, request)
    expect(order).toEqual([
      'archive:enter',
      'session:enter',
      'start',
      'session:exit',
      'archive:exit'
    ])
    expect(owners.archiveCoordinator.withSessionAvailable).toHaveBeenCalledWith(
      scope.projectId,
      scope.appSessionId,
      expect.any(Function)
    )
    expect(owners.sessionPersistenceCoordinator.runSessionMutation).toHaveBeenCalledWith(
      scope.projectId,
      scope.appSessionId,
      expect.any(Function)
    )
    expect(owner.start).toHaveBeenCalledWith(request, sender.id, expect.any(Function))
    expect(sender.send).toHaveBeenCalledWith('artifacts:reproducibility-check-changed', {
      attemptId: 'attempt-1'
    })
    sender.emit('destroyed')
    expect(owner.cancelOwner).toHaveBeenCalledWith(sender.id)
  })

  it('does not start a check when archive admission rejects', async () => {
    const { owners, owner, event } = fixtures()
    vi.mocked(owners.archiveCoordinator.withSessionAvailable).mockRejectedValueOnce(
      new Error('archived')
    )
    await install(owners)
    await expect(
      invoke('artifacts:start-reproducibility-check', event, {
        ...scope,
        frontierId: 'original-inputs'
      })
    ).rejects.toThrow('archived')
    expect(owner.start).not.toHaveBeenCalled()
    expect(owners.sessionPersistenceCoordinator.runSessionMutation).not.toHaveBeenCalled()
  })

  it('keeps output cleanup inside all admission gates and the data-root write gate', async () => {
    const { owners, order, store, event } = fixtures()
    const clear = vi.spyOn(store, 'clearOutputs')
    await install(owners)
    beginMigration()
    await expect(invoke('artifacts:clear-reproducibility-outputs', event, scope)).rejects.toThrow()
    expect(clear).not.toHaveBeenCalled()
    expect(order).toEqual([
      'archive:enter',
      'session:enter',
      'idle:enter',
      'idle:exit',
      'session:exit',
      'archive:exit'
    ])
    clearMigrationPending()
    order.length = 0
    await invoke('artifacts:clear-reproducibility-outputs', event, scope)
    expect(clear).toHaveBeenCalledWith(scope)
    expect(order).toEqual([
      'archive:enter',
      'session:enter',
      'idle:enter',
      'idle:exit',
      'session:exit',
      'archive:exit'
    ])
  })

  it.each([true, false])(
    'exports a lock and imports its bytes with parent window = %s',
    async (hasParent) => {
      const { owners, event, sender, importEnvironmentLock } = fixtures()
      const parent = hasParent ? { id: 'sender-window' } : null
      native.fromWebContents.mockReturnValue(parent)
      const destination = join(native.root, 'environment')
      native.saveDialog.mockResolvedValue({ canceled: false, filePath: destination })
      await install(owners)
      await expect(
        invoke('artifacts:export-environment-lock', event, lockRequest)
      ).resolves.toEqual({ saved: true })
      expect(native.fromWebContents).toHaveBeenCalledWith(sender)
      const options = expect.objectContaining({
        title: 'translated: Save file',
        filters: [{ name: 'translated: ZIP archive', extensions: ['zip'] }]
      })
      expect(native.saveDialog).toHaveBeenCalledWith(...(hasParent ? [parent, options] : [options]))
      const archive = unzipSync(await readFile(`${destination}.zip`))
      expect(Object.values(archive).some((bytes) => strFromU8(bytes) === serializedLock)).toBe(true)
      expect((await readdir(native.root)).filter((name) => name.includes('.tmp'))).toEqual([])
      native.openDialog.mockResolvedValue({ canceled: false, filePaths: [`${destination}.zip`] })
      await expect(
        invoke('artifacts:import-environment-lock', event, { projectId: scope.projectId })
      ).resolves.toEqual({
        imported: true,
        environmentName: 'repro-env',
        kernelKind: 'python',
        reused: false
      })
      const openOptions = expect.objectContaining({
        title: 'translated: Import Environment lock',
        properties: ['openFile']
      })
      expect(native.openDialog).toHaveBeenCalledWith(
        ...(hasParent ? [parent, openOptions] : [openOptions])
      )
      expect(importEnvironmentLock).toHaveBeenCalledWith({
        projectId: scope.projectId,
        language: 'python',
        lock,
        lockChecksum
      })
    }
  )

  it('cancels native file operations without publishing or creating an environment', async () => {
    const { owners, event, importEnvironmentLock } = fixtures()
    await install(owners)
    await expect(invoke('artifacts:export-environment-lock', event, lockRequest)).resolves.toEqual({
      saved: false
    })
    await expect(invoke('artifacts:import-environment-lock', event, {})).resolves.toEqual({
      imported: false
    })
    expect(importEnvironmentLock).not.toHaveBeenCalled()
    expect(await readdir(native.root)).toEqual(['runtime'])
  })

  it('keeps imported source lock reads on their bound receipt store', async () => {
    const { owners, store, event } = fixtures()
    vi.spyOn(store, 'source').mockResolvedValue({
      sourceScope: { ...scope, projectId: 'source-project' },
      entityIds: {},
      lockChecksums: [lockChecksum],
      omittedOutputChecksums: []
    })
    const readLock = vi.spyOn(store, 'environmentLock').mockResolvedValue(serializedLock)
    await rm(join(native.root, 'runtime'), { recursive: true })
    await install(owners)
    await expect(
      invoke('artifacts:describe-environment-lock', event, lockRequest)
    ).resolves.toMatchObject({ lockChecksum, kernelKind: 'python' })
    expect(readLock).toHaveBeenCalledWith(scope, lockChecksum)
  })

  it.each(['artifacts:read-preview', 'artifacts:export-reproducibility-receipt'])(
    'rolls back partial registration at %s and supports idempotent uninstall and reinstall',
    async (channel) => {
      const { owners } = fixtures()
      ipcMainHandle('external:unrelated', () => 'kept')
      native.failAt = channel
      expect(() => createArtifactElectronSurface(owners).install()).toThrow(
        `install failed: ${channel}`
      )
      expect([...native.handlers.keys()]).toEqual(['external:unrelated'])
      native.failAt = undefined
      const installed = await install(owners)
      await installed.uninstall()
      await installed.uninstall()
      expect([...native.handlers.keys()]).toEqual(['external:unrelated'])
      await install(owners)
      expect(native.handlers.has(channel)).toBe(true)
    }
  )
})
