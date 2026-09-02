import { ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import { callerContextForEvent, type CallerContext } from './caller-context'
import {
  ApplicationCallerLeaseRegistry,
  bindCallerLeaseToEvent,
  type OwnedApplicationCallerLease
} from './caller-lifecycle'
import {
  invokeWithIpcRejectionDiagnostics,
  type IpcRejectionLogger
} from './diagnostics/ipc-rejection'
import { createLogger } from './logger'

type IpcHandlerInstallation = {
  uninstall(): void
}

type IpcHandlerInstallationScope = {
  complete(cleanup?: () => void): IpcHandlerInstallation
  rollback(): void
}

type IpcHandlerRegistry = {
  ipcMainHandle: IpcMain['handle']
  createInstallationScope(): IpcHandlerInstallationScope
  dispose(): void
}

type IpcHandlerRegistryDiagnostics = {
  log?: IpcRejectionLogger
  now?: () => number
}

type CallerLeaseEpoch = {
  registry: ApplicationCallerLeaseRegistry
  nativeCallers: WeakMap<object, OwnedApplicationCallerLease>
  disposed: boolean
}

const createCallerLeaseEpoch = (): CallerLeaseEpoch => ({
  registry: new ApplicationCallerLeaseRegistry(),
  nativeCallers: new WeakMap(),
  disposed: false
})

const diagnosticCallerContextForEvent = (
  event: IpcMainInvokeEvent
): Pick<CallerContext, 'surface' | 'location' | 'principalKind' | 'actionOrigin'> => {
  try {
    return callerContextForEvent(event)
  } catch {
    return {
      surface: 'electron',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    }
  }
}

const createIpcHandlerRegistry = (
  target: Pick<IpcMain, 'handle'> & Partial<Pick<IpcMain, 'removeHandler'>>,
  diagnostics: IpcHandlerRegistryDiagnostics = {}
): IpcHandlerRegistry => {
  const diagnosticLog =
    diagnostics.log ??
    ({
      warn: (message, data) => createLogger('ipc').warn(message, data)
    } satisfies IpcRejectionLogger)
  const registeredChannels = new Set<string>()
  let activeCallerLeaseEpoch = createCallerLeaseEpoch()
  const destroyedNativeCallers = new WeakSet<object>()
  const destructionBoundNativeCallers = new WeakSet<object>()

  const callerLeaseEpochForRegistration = (): CallerLeaseEpoch => {
    if (activeCallerLeaseEpoch.disposed) activeCallerLeaseEpoch = createCallerLeaseEpoch()
    return activeCallerLeaseEpoch
  }

  const nativeCallerLease = (
    epoch: CallerLeaseEpoch,
    event: IpcMainInvokeEvent
  ): OwnedApplicationCallerLease => {
    const sender = event.sender as object
    if (destroyedNativeCallers.has(sender)) {
      throw new Error('Caller lease is no longer current.')
    }
    const existing = epoch.nativeCallers.get(sender)
    if (existing && !existing.lease.signal.aborted && existing.lease.isCurrent()) return existing

    const ownedLease = epoch.registry.acquire(callerContextForEvent(event))
    epoch.nativeCallers.set(sender, ownedLease)
    const lifecycleSender = event.sender as typeof event.sender & {
      on?: (name: string, listener: (...args: never[]) => void) => unknown
      once?: (name: string, listener: () => void) => unknown
      removeListener?: (name: string, listener: (...args: never[]) => void) => unknown
    }
    if (!destructionBoundNativeCallers.has(sender) && lifecycleSender.once) {
      destructionBoundNativeCallers.add(sender)
      lifecycleSender.once('destroyed', () => {
        destroyedNativeCallers.add(sender)
        const currentLease = activeCallerLeaseEpoch.nativeCallers.get(sender)
        activeCallerLeaseEpoch.nativeCallers.delete(sender)
        currentLease?.release()
      })
    }
    const releaseCurrentLease = (): void => {
      if (epoch.nativeCallers.get(sender) !== ownedLease) return
      epoch.nativeCallers.delete(sender)
      ownedLease.release()
    }
    const releaseOnMainFrameNavigation = (details: {
      isMainFrame: boolean
      isSameDocument: boolean
    }): void => {
      if (!details.isMainFrame || details.isSameDocument) return
      releaseCurrentLease()
    }
    const removeLifecycleBindings = (): void => {
      lifecycleSender.removeListener?.('did-start-navigation', releaseOnMainFrameNavigation)
      lifecycleSender.removeListener?.('render-process-gone', releaseCurrentLease)
    }
    lifecycleSender.on?.('did-start-navigation', releaseOnMainFrameNavigation)
    lifecycleSender.once?.('render-process-gone', releaseCurrentLease)
    ownedLease.lease.signal.addEventListener('abort', removeLifecycleBindings, { once: true })
    if (ownedLease.lease.signal.aborted) removeLifecycleBindings()
    return ownedLease
  }

  const assertCurrentLease = (lease: OwnedApplicationCallerLease['lease']): void => {
    if (lease.signal.aborted || !lease.isCurrent()) {
      throw new Error('Caller lease is no longer current.')
    }
  }

  const ipcMainHandle: IpcMain['handle'] = (channel, listener) => {
    const callerLeaseEpoch = callerLeaseEpochForRegistration()
    target.handle(channel, (event, ...args) =>
      invokeWithIpcRejectionDiagnostics({
        channel,
        callerContext: diagnosticCallerContextForEvent(event),
        invoke: () => {
          // Electron always supplies an invoke event. Isolated handler registrars historically call
          // their injected target without Electron, so keep that pure test seam lease-neutral.
          const invokedEvent = event as IpcMainInvokeEvent | undefined
          if (!invokedEvent?.sender || typeof invokedEvent.sender !== 'object') {
            return listener(event, ...args)
          }
          const { lease } = nativeCallerLease(callerLeaseEpoch, invokedEvent)
          bindCallerLeaseToEvent(invokedEvent, lease)
          assertCurrentLease(lease)
          return listener(invokedEvent, ...args)
        },
        log: diagnosticLog,
        now: diagnostics.now
      })
    )
    registeredChannels.add(channel)
  }

  const removeChannels = (channels: Iterable<string>): void => {
    for (const channel of channels) {
      target.removeHandler?.(channel)
      registeredChannels.delete(channel)
    }
  }

  return {
    ipcMainHandle,
    createInstallationScope: () => {
      const before = new Set(registeredChannels)
      let settled = false
      const addedChannels = (): string[] =>
        [...registeredChannels].filter((channel) => !before.has(channel))
      return {
        complete: (cleanup) => {
          if (settled) throw new Error('IPC handler installation scope is already settled.')
          settled = true
          const channels = addedChannels()
          let uninstalled = false
          return {
            uninstall: () => {
              if (uninstalled) return
              uninstalled = true
              try {
                cleanup?.()
              } finally {
                removeChannels(channels)
              }
            }
          }
        },
        rollback: () => {
          if (settled) return
          settled = true
          removeChannels(addedChannels())
        }
      }
    },
    dispose: () => {
      activeCallerLeaseEpoch.registry.dispose()
      activeCallerLeaseEpoch.disposed = true
    }
  }
}

const defaultRegistry = createIpcHandlerRegistry(ipcMain)

const ipcMainHandle = defaultRegistry.ipcMainHandle
const disposeIpcHandlerRegistry = (): void => defaultRegistry.dispose()
const createIpcHandlerInstallationScope = (): IpcHandlerInstallationScope =>
  defaultRegistry.createInstallationScope()

export {
  createIpcHandlerInstallationScope,
  createIpcHandlerRegistry,
  disposeIpcHandlerRegistry,
  ipcMainHandle
}
export type { IpcHandlerInstallation, IpcHandlerInstallationScope, IpcHandlerRegistryDiagnostics }
