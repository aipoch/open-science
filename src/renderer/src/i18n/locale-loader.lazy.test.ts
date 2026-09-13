import { expect, it, vi } from 'vitest'

it('loads only the selected catalog and shares concurrent preparation before synchronous init', async () => {
  // Global render setup deliberately preloads test catalogs. Reset the runtime modules to exercise
  // a real cold instance rather than accidentally proving the preloaded test path.
  vi.resetModules()
  const { prepareI18nLocale, preparedI18nResources } = await import('./locale-loader')
  expect(prepareI18nLocale('en')).toBeUndefined()
  expect(preparedI18nResources('en')).toEqual({})
  expect(() => preparedI18nResources('ru')).toThrow('not been prepared')
  const first = prepareI18nLocale('ru')
  expect(prepareI18nLocale('ru')).toBe(first)
  await first
  expect(Object.keys(preparedI18nResources('ru'))).toEqual(['ru'])
  expect(Object.keys(preparedI18nResources('ru').ru)).toEqual(['common', 'renderer'])
  expect(prepareI18nLocale('ru')).toBeUndefined()
  const { initI18n } = await import('./index')
  const instance = initI18n('ru')
  expect(instance.language).toBe('ru')
  expect(instance.t('Settings')).toBe('Настройки')
  await prepareI18nLocale('de')
  expect(initI18n('de').t('Settings')).toBe('Einstellungen')
})
