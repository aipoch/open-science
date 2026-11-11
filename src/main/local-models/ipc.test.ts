import { expect, it, vi } from 'vitest'
import type { LocalModelCapability } from '../../shared/local-models'
import { createLocalModelApi } from './ipc'
import type { LocalModelOwner } from './owner'
vi.mock('../ipc-handler-registry', () => ({ ipcMainHandle: vi.fn() }))
const owner = (): Pick<LocalModelOwner, 'getSnapshot' | 'install' | 'cancel' | 'remove'> => ({
  getSnapshot: vi.fn<LocalModelOwner['getSnapshot']>(),
  install: vi.fn<LocalModelOwner['install']>(),
  cancel: vi.fn<LocalModelOwner['cancel']>(),
  remove: vi.fn<LocalModelOwner['remove']>()
})
it('routes capabilities independently and rejects unknown model names before mutation', async () => {
  const tables = owner(),
    translation = owner(),
    ocr = owner(),
    api = createLocalModelApi(tables, translation, ocr)
  for (const action of ['getSnapshot', 'cancel', 'remove'] as const) {
    await api[action]()
    expect(tables[action]).toHaveBeenCalledOnce()
    expect(translation[action]).not.toHaveBeenCalled()
    expect(ocr[action]).not.toHaveBeenCalled()
    await api[action]('ocr')
    expect(ocr[action]).toHaveBeenCalledOnce()
    await api[action]('pdf-translation')
    expect(translation[action]).toHaveBeenCalledOnce()
    expect(() => api[action]('../other' as LocalModelCapability)).toThrow(
      'Unsupported local model capability'
    )
    expect(tables[action]).toHaveBeenCalledOnce()
    expect(translation[action]).toHaveBeenCalledOnce()
  }
})

it('keeps Figure/Table installation available and rejects translation downloads before mutation', async () => {
  const tables = owner(),
    translation = owner(),
    ocr = owner(),
    api = createLocalModelApi(tables, translation, ocr)
  await api.install()
  await api.install('pdf-tables')
  await api.install('ocr')
  expect(ocr.install).toHaveBeenCalledOnce()
  expect(tables.install).toHaveBeenCalledTimes(2)
  await expect(api.install('pdf-translation')).rejects.toThrow('Local translation is unavailable.')
  expect(translation.install).not.toHaveBeenCalled()
  expect(() => api.install('../other' as LocalModelCapability)).toThrow(
    'Unsupported local model capability'
  )
})
