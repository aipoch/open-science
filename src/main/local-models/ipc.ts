import type { LocalModelApi, LocalModelCapability } from '../../shared/local-models'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { LocalModelOwner } from './owner'

// Both Electron and host commands use the same capability validation and owner routing.
export const createLocalModelApi = (
  tables: Pick<LocalModelOwner, 'getSnapshot' | 'install' | 'cancel' | 'remove'>,
  translation: Pick<LocalModelOwner, 'getSnapshot' | 'install' | 'cancel' | 'remove'>
): LocalModelApi => {
  const owner = (capability?: LocalModelCapability): typeof tables => {
    if (capability === undefined || capability === 'pdf-tables') return tables
    if (capability === 'pdf-translation') return translation
    throw new Error('Unsupported local model capability.')
  }
  return {
    getSnapshot: (capability) => owner(capability).getSnapshot(),
    install: (capability) => owner(capability).install(),
    cancel: (capability) => owner(capability).cancel(),
    remove: (capability) => owner(capability).remove()
  }
}

export const registerLocalModelIpcHandlers = (api: LocalModelApi): void => {
  ipcMainHandle('local-models:get-snapshot', (_event, capability) => api.getSnapshot(capability))
  ipcMainHandle('local-models:install', (_event, capability) => api.install(capability))
  ipcMainHandle('local-models:cancel', (_event, capability) => api.cancel(capability))
  ipcMainHandle('local-models:remove', (_event, capability) => api.remove(capability))
}
