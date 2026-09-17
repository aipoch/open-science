import { test, expect } from 'vitest'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { nativeLocaleAssets } from './native-locale-assets'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureNativeQuitDialog } from '../e2e/fixtures/native-quit-dialog'
import type { App, Dialog } from 'electron'

test('captures real native translations when the catalog is inlined into an arbitrary main bundle', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'native-quit-bundle-')))
  const require = createRequire(join(fixture, 'package.json'))
  const previousRoot = process.env.OPEN_SCIENCE_STORAGE_ROOT
  try {
    const main = join(fixture, 'out', 'main')
    const config = join(fixture, 'config')
    await mkdir(main, { recursive: true })
    await mkdir(config)
    await mkdir(join(fixture, 'node_modules', 'electron'), { recursive: true })
    await writeFile(
      join(fixture, 'node_modules', 'electron', 'index.js'),
      `
      module.exports = {
        app: { isPackaged: true, getPath: () => ${JSON.stringify(fixture)} },
        dialog: { showMessageBox: async () => { throw new Error('Native UI must be intercepted') } },
        ipcMain: new (require('node:events').EventEmitter)()
      }
    `
    )
    const bundle = join(main, 'arbitrary-bundle.cjs')
    buildSync({
      stdin: {
        contents:
          "export { LocalePreferenceOwner } from './src/main/locale/owner'; export { createElectronCloseConfirm } from './src/main/window-close-confirm'",
        resolveDir: resolve('.')
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      define: { __OPEN_SCIENCE_NATIVE_LOCALE_DIRECTORY__: JSON.stringify('native-locales') }
    })
    const hook = nativeLocaleAssets().buildStart!
    const emitNativeLocales = typeof hook === 'function' ? hook : hook.handler
    await emitNativeLocales.call(
      {
        addWatchFile: () => {},
        emitFile: (asset: { fileName: string; source: string }) => {
          mkdirSync(join(main, 'native-locales'), { recursive: true })
          writeFileSync(join(main, asset.fileName), asset.source)
        }
      } as never,
      {} as never
    )
    // Electron can cache synthetic modules without a filename (and entries are not necessarily
    // complete NodeJS.Module objects). These precede the real bundle in cache traversal order.
    for (const [index, filename] of [undefined, null, 42, {}].entries()) {
      require.cache[join(main, `synthetic-${index}`)] = {
        ...(filename === undefined ? {} : { filename }),
        exports: {
          LocalePreferenceOwner: () => {
            throw new Error('Synthetic export must be skipped')
          }
        }
      } as unknown as NodeJS.Module
    }
    require(bundle)
    const { dialog } = require('electron') as { dialog: Dialog }
    process.env.OPEN_SCIENCE_STORAGE_ROOT = config
    for (const [locale, expected] of [
      [
        'ru',
        {
          buttons: ['Отмена', 'Выйти'],
          detail: 'Выполнение ещё не завершено. При выходе работа будет прервана.',
          message: 'Выйти из Open-Science?'
        }
      ],
      [
        'de',
        {
          buttons: ['Abbrechen', 'Beenden'],
          detail: 'Die Arbeit läuft noch und wird beim Beenden unterbrochen.',
          message: 'Open-Science beenden?'
        }
      ]
    ] as const) {
      await writeFile(join(config, 'settings.json'), JSON.stringify({ localePreference: locale }))
      expect(
        await captureNativeQuitDialog({ app: { getAppPath: () => fixture } as App, dialog })
      ).toEqual({
        ...expected,
        includesRendererCatalog: false
      })
    }
  } finally {
    if (previousRoot === undefined) delete process.env.OPEN_SCIENCE_STORAGE_ROOT
    else process.env.OPEN_SCIENCE_STORAGE_ROOT = previousRoot
    for (const key of Object.keys(require.cache))
      if (key.startsWith(fixture)) delete require.cache[key]
    await rm(fixture, { recursive: true, force: true })
  }
})
