import { ipcMainHandle } from '../ipc-handler-registry'
import type { LocalModelOwner } from './owner'

export const registerLocalModelIpcHandlers = (
  owner: Pick<LocalModelOwner, 'getSnapshot' | 'install' | 'cancel' | 'remove'>
): void => {
  ipcMainHandle('local-models:get-snapshot', () => owner.getSnapshot())
  ipcMainHandle('local-models:install', () => owner.install())
  ipcMainHandle('local-models:cancel', () => owner.cancel())
  ipcMainHandle('local-models:remove', () => owner.remove())
}
