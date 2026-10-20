import { ipcMainHandle } from '../ipc-handler-registry'
import type { SideChatCommandOwner } from './command-owner'

export const registerSideChatIpcHandlers = (owner: SideChatCommandOwner): void => {
  ipcMainHandle('side-chat:list', () => owner.list())
  ipcMainHandle('side-chat:start', (_event, request) => owner.start(request))
  ipcMainHandle('side-chat:send', (_event, request) => owner.send(request))
  ipcMainHandle('side-chat:cancel', (_event, request) => owner.cancel(request))
  ipcMainHandle('side-chat:close', (_event, request) => owner.close(request))
}
