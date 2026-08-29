import { remoteAccessApplicationCommandContracts } from '../../shared/remote-access'
import { callerContextForEvent, hasCallerAuthority, type CallerContext } from '../caller-context'
import { ipcMainHandle } from '../ipc-handler-registry'
import { RemoteAccessService } from './service'

const isDesktopCaller = (context: CallerContext): boolean => context.surface === 'electron'

const requireDesktopCaller = (context: CallerContext): void => {
  if (!isDesktopCaller(context)) {
    throw new Error('This action must be approved from the Open Science desktop app.')
  }
}

const canManagePairing = (context: CallerContext): boolean =>
  isDesktopCaller(context) ||
  (context.surface === 'web' &&
    context.location === 'remote' &&
    hasCallerAuthority(context, 'manage-remote-pairing'))

const requirePairingManager = (context: CallerContext): void => {
  if (!canManagePairing(context)) {
    throw new Error(
      'Pairing can only be managed from the Open Science desktop app or an approved browser.'
    )
  }
}

export const registerRemoteAccessIpcHandlers = (service: RemoteAccessService): void => {
  ipcMainHandle('remote-access:get-snapshot', (event, ...args) => {
    remoteAccessApplicationCommandContracts.getSnapshot.args.parse(args)
    const context = callerContextForEvent(event)
    const desktop = isDesktopCaller(context)
    return service.snapshot(desktop, canManagePairing(context))
  })
  ipcMainHandle('remote-access:detect', async (event, ...args) => {
    remoteAccessApplicationCommandContracts.detect.args.parse(args)
    requireDesktopCaller(callerContextForEvent(event))
    return service.detect()
  })
  ipcMainHandle('remote-access:set-mode', async (event, ...args) => {
    const [request] = remoteAccessApplicationCommandContracts.setMode.args.parse(args)
    requireDesktopCaller(callerContextForEvent(event))
    return service.setMode(request.mode)
  })
  ipcMainHandle('remote-access:disable', async (event, ...args) => {
    remoteAccessApplicationCommandContracts.disable.args.parse(args)
    requireDesktopCaller(callerContextForEvent(event))
    return service.disable()
  })
  ipcMainHandle('remote-access:approve', async (event, ...args) => {
    const [request] = remoteAccessApplicationCommandContracts.approve.args.parse(args)
    const context = callerContextForEvent(event)
    requirePairingManager(context)
    const desktop = isDesktopCaller(context)
    return service.approve(request, desktop, canManagePairing(context))
  })
  ipcMainHandle('remote-access:reject', (event, ...args) => {
    const [request] = remoteAccessApplicationCommandContracts.reject.args.parse(args)
    const context = callerContextForEvent(event)
    requirePairingManager(context)
    const desktop = isDesktopCaller(context)
    return service.reject(request.requestId, desktop, canManagePairing(context))
  })
  ipcMainHandle('remote-access:revoke-browser', async (event, ...args) => {
    const [request] = remoteAccessApplicationCommandContracts.revokeBrowser.args.parse(args)
    const context = callerContextForEvent(event)
    requirePairingManager(context)
    const desktop = isDesktopCaller(context)
    return service.revoke(request.browserId, desktop, canManagePairing(context))
  })
}

export { canManagePairing, isDesktopCaller, requireDesktopCaller, requirePairingManager }
