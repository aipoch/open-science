import { expect, it, vi } from 'vitest'
import { nativeLocaleAssets } from './native-locale-assets'
import { LOCALES } from '../src/shared/locale'

it('ships all eight native catalogs without renderer copy and watches their source files', async () => {
  const plugin = nativeLocaleAssets()
  const emitFile = vi.fn()
  const addWatchFile = vi.fn()
  const hook = plugin.buildStart!
  const handler = typeof hook === 'function' ? hook : hook.handler
  await handler.call({ emitFile, addWatchFile } as never, {} as never)
  expect(emitFile).toHaveBeenCalledTimes(8)
  expect(addWatchFile).toHaveBeenCalledTimes(8)
  expect(emitFile.mock.calls.map(([asset]) => asset.fileName).sort()).toEqual(
    LOCALES.filter((locale) => locale !== 'en')
      .map((locale) => `native-locales/${locale}.json`)
      .sort()
  )
  for (const [asset] of emitFile.mock.calls) {
    expect(asset.type).toBe('asset')
    expect(Object.keys(JSON.parse(asset.source)).sort()).toEqual(['common', 'native'])
  }
})
