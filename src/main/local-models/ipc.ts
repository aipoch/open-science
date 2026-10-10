import type { LocalModelApi } from '../../shared/local-models'
import { ipcMainHandle } from '../ipc-handler-registry'
export { createLocalModelApi } from './owner'

export const registerLocalModelIpcHandlers = (api: LocalModelApi): void => {
  ipcMainHandle('local-models:get-snapshot', (_event, capability) => api.getSnapshot(capability))
  ipcMainHandle('local-models:install', (_event, capability) => api.install(capability))
  ipcMainHandle('local-models:cancel', (_event, capability) => api.cancel(capability))
  ipcMainHandle('local-models:remove', (_event, capability) => api.remove(capability))
}
