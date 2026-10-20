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
    api = createLocalModelApi(tables, translation)
  for (const action of ['getSnapshot', 'install', 'cancel', 'remove'] as const) {
    await api[action]()
    expect(tables[action]).toHaveBeenCalledOnce()
    expect(translation[action]).not.toHaveBeenCalled()
    await api[action]('pdf-translation')
    expect(translation[action]).toHaveBeenCalledOnce()
    expect(() => api[action]('../other' as LocalModelCapability)).toThrow(
      'Unsupported local model capability'
    )
    expect(tables[action]).toHaveBeenCalledOnce()
    expect(translation[action]).toHaveBeenCalledOnce()
  }
})
