import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn(), reveal: vi.fn() }))
vi.mock('electron', () => ({
  dialog: { showSaveDialog: native.save, showOpenDialog: native.open },
  shell: { showItemInFolder: native.reveal }
}))

import type { PackageOperationSnapshot, SessionPackagePreview } from '../../shared/session-package'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { beginMigration, clearMigrationPending, endMigrationCopy } from '../storage/migration-state'
import type { SessionPackageService } from './service'
import { createSessionPackageDesktop } from './desktop-composition'

type Owners = Parameters<typeof createSessionPackageDesktop>[0]
type Desktop = ReturnType<typeof createSessionPackageDesktop>
const identity = { projectId: 'project-1', sessionId: 'session-1' }
const preview: SessionPackagePreview = {
  title: 'Research',
  projectName: 'Project',
  branchCount: 1,
  messageCount: 1,
  fileCount: 0,
  totalBytes: 7,
  omissions: []
}
// These records are opaque to composition; repository implementations are outside this baseline.
const project = { id: identity.projectId, name: 'Imported project' } as NonNullable<
  Awaited<ReturnType<Owners['projectRepository']['get']>>
>
const session = {
  id: identity.sessionId,
  projectId: identity.projectId,
  title: 'Imported session'
} as NonNullable<Awaited<ReturnType<Owners['sessionRepository']['loadSession']>>>
const order: string[] = []
const releasePersistence = vi.fn((): void => {
  order.push('release:persistence')
})
const releaseExport = vi.fn((): void => {
  order.push('release:archive')
})
const releaseImport = vi.fn((): void => {
  order.push('release:import')
})
const service = {
  assertExportIdle: vi.fn<SessionPackageService['assertExportIdle']>(),
  exportTo: vi.fn<SessionPackageService['exportTo']>(),
  importFrom: vi.fn<SessionPackageService['importFrom']>()
}
const archive = {
  reserveSessionExport: vi.fn<Owners['archiveCoordinator']['reserveSessionExport']>(),
  reserveProjectImport: vi.fn<Owners['archiveCoordinator']['reserveProjectImport']>()
}
const persistence = {
  reserveSessionExport: vi.fn<Owners['sessionPersistenceCoordinator']['reserveSessionExport']>()
}
const publish = vi.fn<Owners['applicationEvents']['publish']>()
const getProject = vi.fn<Owners['projectRepository']['get']>()
const loadSession = vi.fn<Owners['sessionRepository']['loadSession']>()
let held = false
let root: string
let desktop: Desktop

const selection = async (): Promise<string> => {
  await vi.waitFor((): void => {
    expect(desktop.operations.snapshot?.state).toBe('awaiting-selection')
  })
  return desktop.operations.snapshot!.id
}
const operationEvents = (): PackageOperationSnapshot[] =>
  publish.mock.calls.flatMap(([channel, payload]): PackageOperationSnapshot[] =>
    channel === 'sessions:package-operation-changed' ? [payload as PackageOperationSnapshot] : []
  )

beforeEach(async (): Promise<void> => {
  vi.resetAllMocks()
  clearMigrationPending()
  held = false
  order.length = 0
  root = await mkdtemp(join(tmpdir(), 'package-composition-'))
  await writeFile(join(root, 'input.science'), 'package')
  native.save.mockResolvedValue({ canceled: false, filePath: join(root, 'output.science') })
  native.open.mockResolvedValue({ canceled: false, filePaths: [join(root, 'input.science')] })
  releasePersistence.mockImplementation((): void => {
    order.push('release:persistence')
  })
  releaseExport.mockImplementation((): void => {
    order.push('release:archive')
  })
  releaseImport.mockImplementation((): void => {
    order.push('release:import')
  })
  persistence.reserveSessionExport.mockImplementation(async (): Promise<() => void> => {
    order.push('reserve:persistence')
    return releasePersistence
  })
  service.assertExportIdle.mockImplementation(async (): Promise<void> => {
    order.push('assert:idle')
  })
  archive.reserveSessionExport.mockImplementation(async (...args): Promise<() => void> => {
    order.push('reserve:archive')
    await args[2]()
    order.push('admitted:archive')
    return releaseExport
  })
  archive.reserveProjectImport.mockImplementation(async (): Promise<() => void> => {
    order.push('reserve:import')
    return releaseImport
  })
  // Service substitutes exercise desktop callbacks and staging with tiny bytes. They do not
  // validate or create real package archives, inspect research activity, or persist imported data.
  service.exportTo.mockImplementation(async (...args): Promise<SessionPackagePreview> => {
    const [, path, options] = args
    order.push('service:export')
    if (!options?.selectFiles || !options.signal)
      throw new Error('Missing desktop export callbacks')
    await options.selectFiles(
      [],
      options.signal,
      { retainedFiles: [], metadataBytes: 7 },
      preview.title
    )
    await writeFile(path, 'package')
    return preview
  })
  service.importFrom.mockImplementation(async (...args): Promise<typeof identity> => {
    const [path, signal, , confirm] = args
    order.push('service:import')
    expect(await readFile(path, 'utf8')).toBe('package')
    if (!confirm || !signal) throw new Error('Missing desktop import confirmation')
    await confirm(preview, signal)
    return identity
  })
  getProject.mockResolvedValue(project)
  loadSession.mockResolvedValue(session)
  desktop = createSessionPackageDesktop({
    sessionPackageService: service as unknown as SessionPackageService,
    translate: englishNativeTranslator,
    archiveCoordinator: archive,
    sessionPersistenceCoordinator: persistence,
    applicationEvents: { publish },
    projectRepository: { get: getProject },
    sessionRepository: { loadSession },
    isPackageHandoffHeld: (): boolean => held
  })
})
afterEach(async (): Promise<void> => {
  clearMigrationPending()
  await desktop.close()
  await rm(root, { recursive: true, force: true })
})

describe('Session package desktop composition baseline', () => {
  it('reads handoff, migration-copy and migration-pending gates after construction', async (): Promise<void> => {
    for (const gate of ['handoff', 'migration-copy', 'migration-pending']) {
      vi.clearAllMocks()
      if (gate === 'handoff') held = true
      else {
        beginMigration()
        if (gate === 'migration-pending') endMigrationCopy()
      }
      await expect(desktop.export(identity)).rejects.toThrow('application handoff')
      await expect(
        desktop.import(undefined, 'client', { projectId: identity.projectId })
      ).rejects.toThrow('application handoff')
      expect(archive.reserveSessionExport).not.toHaveBeenCalled()
      expect(archive.reserveProjectImport).not.toHaveBeenCalled()
      expect(service.exportTo).not.toHaveBeenCalled()
      expect(service.importFrom).not.toHaveBeenCalled()
      expect(native.open).not.toHaveBeenCalled()
      expect(native.save).not.toHaveBeenCalled()
      expect(
        operationEvents()
          .filter(({ state }) => state === 'failed')
          .map(({ kind }) => kind)
      ).toEqual(['export', 'import'])
      // The same instance admits work again once the live gate clears.
      held = false
      clearMigrationPending()
      native.open.mockResolvedValueOnce({ canceled: true, filePaths: [] })
      await expect(
        desktop.import(undefined, undefined, { projectId: identity.projectId })
      ).resolves.toBeNull()
      expect(archive.reserveProjectImport).toHaveBeenCalledOnce()
      expect(releaseImport).toHaveBeenCalledOnce()
    }
  })

  it.each(['persistence', 'idle', 'archive-after-callback'] as const)(
    'releases only the acquired persistence reservation when %s rejects export admission',
    async (failure): Promise<void> => {
      const error = new Error(`rejected at ${failure}`)
      if (failure === 'persistence') persistence.reserveSessionExport.mockRejectedValueOnce(error)
      else if (failure === 'idle') service.assertExportIdle.mockRejectedValueOnce(error)
      else
        archive.reserveSessionExport.mockImplementationOnce(async (...args): Promise<never> => {
          await args[2]()
          throw error
        })
      await expect(desktop.export(identity)).rejects.toBe(error)
      expect(persistence.reserveSessionExport).toHaveBeenCalledExactlyOnceWith(
        identity.projectId,
        identity.sessionId
      )
      expect(service.assertExportIdle).toHaveBeenCalledTimes(failure === 'persistence' ? 0 : 1)
      expect(releasePersistence).toHaveBeenCalledTimes(failure === 'persistence' ? 0 : 1)
      expect(releaseExport).not.toHaveBeenCalled()
      expect(service.exportTo).not.toHaveBeenCalled()
      expect(desktop.operations.snapshot?.state).toBe('failed')
      expect(desktop.operations.active).toBe(false)
    }
  )

  it('exports through archive → persistence → idle, publishes operations, then releases in order', async (): Promise<void> => {
    const pending = desktop.export(identity)
    const operationId = await selection()
    expect(order).toEqual([
      'reserve:archive',
      'reserve:persistence',
      'assert:idle',
      'admitted:archive',
      'service:export'
    ])
    expect(service.assertExportIdle).toHaveBeenCalledExactlyOnceWith(identity)
    const signal = archive.reserveSessionExport.mock.calls[0][3]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(service.exportTo.mock.calls[0][2]?.signal).toBe(signal)
    expect(releasePersistence).not.toHaveBeenCalled()
    await desktop.respond({ action: 'select', operationId, excludedStorageKeys: [] })
    const destination = join(root, 'output.science')
    await expect(pending).resolves.toEqual({ saved: true, filePath: destination })
    expect(await readFile(destination, 'utf8')).toBe('package')
    expect(order.slice(-2)).toEqual(['release:persistence', 'release:archive'])
    expect(releasePersistence).toHaveBeenCalledOnce()
    expect(releaseExport).toHaveBeenCalledOnce()
    expect(operationEvents().map(({ state }) => state)).toContain('awaiting-selection')
    expect(operationEvents().at(-1)).toEqual(desktop.operations.snapshot)
    expect(await desktop.respond({ action: 'snapshot' })).toMatchObject({
      id: operationId,
      state: 'succeeded',
      result: { filePath: destination }
    })
    await desktop.respond({ action: 'reveal', operationId })
    expect(native.reveal).toHaveBeenCalledExactlyOnceWith(destination)
  })

  it.each([true, false])(
    'imports with projectCreated=%s and publishes repository records with the correct origin',
    async (projectCreated): Promise<void> => {
      const target = projectCreated
        ? { projectName: 'New project' }
        : { projectId: identity.projectId }
      const origin: string | undefined = projectCreated ? undefined : 'renderer-client'
      const pending = desktop.import(undefined, origin, target)
      const operationId = await selection()
      expect(desktop.operations.snapshot?.importPreview).toEqual(preview)
      expect(publish.mock.calls.some(([channel]) => channel === 'session:created')).toBe(false)
      expect(releaseImport).not.toHaveBeenCalled()
      await desktop.respond({ action: 'confirm-import', operationId })
      await expect(pending).resolves.toEqual(identity)
      if (projectCreated) expect(archive.reserveProjectImport).not.toHaveBeenCalled()
      else {
        expect(archive.reserveProjectImport).toHaveBeenCalledExactlyOnceWith(
          identity.projectId,
          expect.any(AbortSignal)
        )
        expect(service.importFrom.mock.calls[0][1]).toBe(
          archive.reserveProjectImport.mock.calls[0][1]
        )
        expect(order).toEqual(['reserve:import', 'service:import', 'release:import'])
      }
      expect(service.importFrom.mock.calls[0][4]).toEqual(target)
      expect(getProject).toHaveBeenCalledExactlyOnceWith(identity.projectId)
      expect(loadSession).toHaveBeenCalledExactlyOnceWith(identity.projectId, identity.sessionId)
      expect(
        publish.mock.calls.filter(([channel]) => channel !== 'sessions:package-operation-changed')
      ).toEqual([
        ...(projectCreated ? [['project:created', project]] : []),
        ['session:created', { session, originClientId: origin ?? 'session-package-import' }]
      ])
      expect(releaseImport).toHaveBeenCalledTimes(projectCreated ? 0 : 1)
      expect(operationEvents().at(-1)).toEqual(desktop.operations.snapshot)
      expect(desktop.operations.snapshot).toMatchObject({
        state: 'succeeded',
        result: { imported: identity }
      })
    }
  )

  it('skips creation notifications for missing repository records without changing the import result', async (): Promise<void> => {
    getProject.mockResolvedValue(null)
    loadSession.mockResolvedValue(undefined)
    const pending = desktop.import(undefined, undefined, { projectName: 'New project' })
    await desktop.respond({ action: 'confirm-import', operationId: await selection() })
    await expect(pending).resolves.toEqual(identity)
    expect(getProject).toHaveBeenCalledExactlyOnceWith(identity.projectId)
    expect(loadSession).toHaveBeenCalledExactlyOnceWith(identity.projectId, identity.sessionId)
    expect(
      publish.mock.calls.every(([channel]) => channel === 'sessions:package-operation-changed')
    ).toBe(true)
    expect(desktop.operations.snapshot?.state).toBe('succeeded')
  })

  it('keeps the committed import successful and releases admission when notification delivery throws', async (): Promise<void> => {
    publish.mockImplementation((channel): void => {
      if (channel === 'session:created') throw new Error('Notification unavailable')
    })
    const pending = desktop.import(undefined, 'client', { projectId: identity.projectId })
    await desktop.respond({ action: 'confirm-import', operationId: await selection() })
    await expect(pending).resolves.toEqual(identity)
    expect(publish).toHaveBeenCalledWith('session:created', { session, originClientId: 'client' })
    expect(releaseImport).toHaveBeenCalledOnce()
    expect(desktop.operations.snapshot).toMatchObject({
      state: 'succeeded',
      result: { imported: identity }
    })
    expect(operationEvents().at(-1)).toEqual(desktop.operations.snapshot)
  })

  it('close cancels an active export selection, joins it, and releases both reservations once', async (): Promise<void> => {
    const pending = desktop.export(identity)
    const rejected = expect(pending).rejects.toThrow()
    await selection()
    expect(desktop.hasActiveTransfer()).toBe(true)
    await desktop.close()
    await rejected
    expect(archive.reserveSessionExport.mock.calls[0][3]?.aborted).toBe(true)
    expect(order.slice(-2)).toEqual(['release:persistence', 'release:archive'])
    expect(desktop.operations.snapshot?.state).toBe('cancelled')
    expect(desktop.operations.active).toBe(false)
    await desktop.close()
    expect(releasePersistence).toHaveBeenCalledOnce()
    expect(releaseExport).toHaveBeenCalledOnce()
    expect(native.save).not.toHaveBeenCalled()
  })
})
