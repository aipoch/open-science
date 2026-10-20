import type {
  PermissionGrantDefaultsRestoreView,
  PermissionGrantMutationView,
  PermissionGrantRestoreRequest,
  PermissionGrantRevokeRequest,
  PermissionGrantSnapshot,
  PermissionGrantUndoExtendRequest,
  PermissionGrantUndoReceipt,
  PermissionGrantsChangedEvent
} from '../permission-grants'

import { callable, type AcpListener, type RemoveListener, EVENT } from './definition'

export const contracts = {
  'permissions.extendUndo': callable<
    (request: PermissionGrantUndoExtendRequest) => Promise<PermissionGrantUndoReceipt | undefined>
  >()('permissions', ['permissions:extend-undo']),
  'permissions.list': callable<() => Promise<PermissionGrantSnapshot>>()('permissions', [
    'permissions:list'
  ]),
  'permissions.restoreDefaults': callable<() => Promise<PermissionGrantDefaultsRestoreView>>()(
    'permissions',
    ['permissions:restore-defaults']
  ),
  'permissions.onChanged': callable<
    (listener: AcpListener<PermissionGrantsChangedEvent>) => RemoveListener
  >()('permissions', ['permissions:changed', EVENT]),
  'permissions.restore': callable<
    (request: PermissionGrantRestoreRequest) => Promise<PermissionGrantMutationView>
  >()('permissions', ['permissions:restore']),
  'permissions.revoke': callable<
    (request: PermissionGrantRevokeRequest) => Promise<PermissionGrantMutationView>
  >()('permissions', ['permissions:revoke'])
} as const
