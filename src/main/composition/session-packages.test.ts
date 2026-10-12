import { afterEach, expect, it, vi } from 'vitest'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { composeSessionPackageSurfaces } from './session-packages'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

const native = vi.hoisted(() => ({ confirm: vi.fn(), installQuitGuard: vi.fn() }))
vi.mock('../desktop-interaction', () => ({
  desktopFileInteraction: () => ({ confirm: native.confirm }),
  desktopInteraction: () => ({ installPackageQuitGuard: native.installQuitGuard })
}))
vi.mock('../session-package/inspection-worker-entry?nodeWorker', () => ({ default: vi.fn() }))
afterEach(() => vi.resetAllMocks())
configureTestRuntimeMetadata()

it.each(['update', 'quit'])(
  'keeps the %s guard active while browser receipt is awaiting consent',
  async (kind) => {
    let answer!: (result: { response: number }) => void
    native.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
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
          port: '49231',
          name: 'study.science',
          size: '5'
        })
    )
    try {
      expect(surfaces.sessionPackageDesktop.operations.active).toBe(false)
      expect(kind === 'update' ? lifecycle.isActive() : canBlockQuit()).toBe(true)
      answer({ response: 0 })
      await opening
      expect(lifecycle.isActive()).toBe(false)
      expect(canBlockQuit()).toBe(false)
    } finally {
      answer({ response: 0 })
      await opening
      await lifecycle.close()
    }
  }
)
