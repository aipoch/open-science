import type {
  PermissionGrantRestoreRequest,
  PermissionGrantRevokeRequest,
  PermissionGrantUndoExtendRequest,
  PermissionGrantsChangedEvent
} from '../../shared/permission-grants'
import { ipcMainHandle } from '../ipc-handler-registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import {
  createPermissionGrantProjectionController,
  type PermissionGrantProjection,
  type PermissionGrantProjectionController,
  type PermissionGrantProjectionControllerOptions
} from './projection-controller'

type PermissionGrantIpcOptions = Omit<
  PermissionGrantProjectionControllerOptions,
  'publishChanged'
> & {
  broadcast?: (channel: string, payload: PermissionGrantsChangedEvent) => void
}

type PermissionGrantIpcController = Pick<
  PermissionGrantProjectionController,
  'dispose' | 'invalidateProjection'
>

// This adapter owns only Electron/Web handler registration. Supplying the projection keeps its
// Registry subscription and revision lifetime application-owned and shareable with command routing.
const registerPermissionGrantIpcAdapter = (owner: PermissionGrantProjection): void => {
  ipcMainHandle('permissions:list', () => owner.list())
  ipcMainHandle('permissions:restore-defaults', () => owner.restoreDefaults())
  ipcMainHandle('permissions:revoke', (_event, request: PermissionGrantRevokeRequest) =>
    owner.revoke(request)
  )
  ipcMainHandle('permissions:extend-undo', (_event, request: PermissionGrantUndoExtendRequest) =>
    owner.extendUndo(request)
  )
  ipcMainHandle('permissions:restore', (_event, request: PermissionGrantRestoreRequest) =>
    owner.restore(request)
  )
}

// Compatibility composition for the current Electron runtime. The application composition can
// construct the same owner directly and call registerPermissionGrantIpcAdapter during transport
// cutover without changing any channel or projection semantics.
const registerPermissionGrantIpcHandlers = (
  options: PermissionGrantIpcOptions
): PermissionGrantIpcController => {
  const { broadcast: broadcastOverride, ...projectionOptions } = options
  const broadcast = broadcastOverride ?? broadcastToRenderers
  const owner = createPermissionGrantProjectionController({
    ...projectionOptions,
    publishChanged: (payload) => broadcast('permissions:changed', payload)
  })
  try {
    registerPermissionGrantIpcAdapter(owner)
    return owner
  } catch (error) {
    try {
      owner.dispose()
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'Permission Grant IPC registration and owner disposal failed.'
      )
    }
    throw error
  }
}

export { registerPermissionGrantIpcAdapter, registerPermissionGrantIpcHandlers }
export type { PermissionGrantIpcController, PermissionGrantIpcOptions }
