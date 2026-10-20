import { afterEach, expect, it, vi } from 'vitest'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { composeSessionPackageSurfaces } from './session-packages'
import { findBrowserImportPort } from '../session-package/test-helpers/browser-import-port'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

const native = vi.hoisted(() => ({ installQuitGuard: vi.fn() }))
vi.mock('../desktop-interaction', () => ({
  desktopInteraction: () => ({ installPackageQuitGuard: native.installQuitGuard })
}))
vi.mock('../session-package/inspection-worker-entry?nodeWorker', () => ({ default: vi.fn() }))
afterEach(() => vi.resetAllMocks())
configureTestRuntimeMetadata()

it.each(['update', 'quit'])(
  'keeps the %s guard active while browser receipt is in progress',
  async (kind) => {
    const lifecycle = { isActive: () => false, close: async () => {} }
    // No export/import is started: unrelated repository dependencies are never called.
    const surfaces = composeSessionPackageSurfaces({
      declareElectronAdapter: (name, install) => {
        if (name === 'session-package-quit-guard') install()
      },
      sessionPackageDesktopLifecycle: lifecycle,
      packageHandoffHeld: { current: false },
      translate: englishNativeTranslator
    } as Parameters<typeof composeSessionPackageSurfaces>[0])
    const canBlockQuit = native.installQuitGuard.mock.calls[0][0] as () => boolean
    const opening = surfaces.browserPackageImport.begin(
      'open-science://import?' +
        new URLSearchParams({
          version: '1',
          origin: 'https://example.com',
          secret: 'ab'.repeat(32),
          port: String(await findBrowserImportPort()),
          name: 'study.science',
          size: '5'
        })
    )
    try {
      expect(surfaces.sessionPackageDesktop.operations.active).toBe(false)
      expect(kind === 'update' ? lifecycle.isActive() : canBlockQuit()).toBe(true)
      await opening
      expect(lifecycle.isActive()).toBe(true)
      await lifecycle.close()
      expect(lifecycle.isActive()).toBe(false)
      expect(canBlockQuit()).toBe(false)
    } finally {
      await opening
      await lifecycle.close()
    }
  }
)

it('routes receipt progress and targeted cancellation through the existing package surface', async () => {
  const lifecycle = { isActive: () => false, close: async () => {} }
  const publish = vi.fn()
  const surfaces = composeSessionPackageSurfaces({
    declareElectronAdapter: () => {},
    sessionPackageDesktopLifecycle: lifecycle,
    packageHandoffHeld: { current: false },
    applicationEvents: { publish },
    translate: englishNativeTranslator
  } as unknown as Parameters<typeof composeSessionPackageSurfaces>[0])
  try {
    await surfaces.browserPackageImport.begin(
      'open-science://import?' +
        new URLSearchParams({
          version: '1',
          origin: 'https://example.com',
          secret: 'ab'.repeat(32),
          port: String(await findBrowserImportPort()),
          name: 'study.science',
          size: '5'
        })
    )
    const snapshot = surfaces.sessionPackageDesktop.operations.snapshot!
    expect(snapshot.browserTransfers).toMatchObject([
      { filename: 'study.science', state: 'waiting', completedBytes: 0 }
    ])
    expect(publish).toHaveBeenCalledWith(
      'sessions:package-operation-changed',
      expect.objectContaining({ browserTransfers: snapshot.browserTransfers })
    )
    await surfaces.sessionPackageDesktop.respond({
      action: 'cancel-browser-transfer',
      operationId: snapshot.id,
      transferId: snapshot.browserTransfers![0].id
    })
    expect(surfaces.sessionPackageDesktop.operations.snapshot?.browserTransfers).toMatchObject([
      { state: 'cancelled' }
    ])
    expect(lifecycle.isActive()).toBe(false)
  } finally {
    await lifecycle.close()
  }
})
