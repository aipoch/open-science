import { ipcMain, type IpcMainEvent } from 'electron'
import { createLogger, errorLogFields } from './logger'
import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import {
  ELECTRON_APPLICATION_COMMAND_CHANNELS,
  RENDERER_CONTRACT_CATALOG
} from '../shared/renderer-contract-catalog'
import { toApplicationCommandErrorEnvelope } from '../shared/application-command-contract'
import type { ApplicationCallerLease } from './application-command-router'
import { callerLeaseForEvent } from './caller-lifecycle'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import { ipcMainHandle, createIpcHandlerInstallationScope } from './ipc-handler-registry'

// Keep the existing preload contract, including the command-outcome envelopes that its validated
// commands unwrap. The main process forwards requests; it never creates a business owner.
export function installDesktopRuntimeElectronAdapter(
  client: Pick<DesktopRuntimeClient, 'commandNames' | 'invoke' | 'release'>,
  isApplicationWindow: (sender: WebContents) => boolean
): { uninstall(): void; documentFor(clientId: string): WebContents | undefined } {
  const scope = createIpcHandlerInstallationScope()
  const documents = new WeakMap<ApplicationCallerLease, string>()
  const senders = new Map<string, { sender: WebContents; lease: ApplicationCallerLease }>()
  const releaseCallbacks = new Set<() => void>()
  const enveloped = new Set([...ELECTRON_APPLICATION_COMMAND_CHANNELS, 'sessions:save-session'])
  const rendererChannels = new Set(
    RENDERER_CONTRACT_CATALOG.filter(({ kind }) => kind === 'method').map(({ channel }) => channel)
  )
  const forward = async (
    invoked: IpcMainInvokeEvent | IpcMainEvent,
    channel: string,
    args: unknown[],
    boundLease?: ApplicationCallerLease
  ): Promise<unknown> => {
    if (
      !isApplicationWindow(invoked.sender) ||
      !invoked.senderFrame ||
      invoked.senderFrame !== invoked.sender.mainFrame
    ) {
      throw new Error('Application commands require the main application frame.')
    }
    const lease = boundLease ?? callerLeaseForEvent(invoked)
    let document = documents.get(lease)
    if (!document) {
      document = randomUUID()
      documents.set(lease, document)
      const identity = document
      senders.set(identity, { sender: invoked.sender, lease })
      const release = (): void => {
        lease.signal.removeEventListener('abort', release)
        releaseCallbacks.delete(release)
        documents.delete(lease)
        senders.delete(identity)
        client.release(identity)
      }
      releaseCallbacks.add(release)
      lease.signal.addEventListener('abort', release, { once: true })
    }
    if (lease.signal.aborted || !lease.isCurrent())
      throw new Error('Application caller is no longer current.')
    // Electron preserves an explicit trailing undefined; JSON encodes it as null. Omit
    // optional trailing slots so the command owner keeps its existing default behavior.
    while (args.length && args[args.length - 1] === undefined) args.pop()
    return client.invoke(document, channel, args)
  }
  const reportChannel = 'office-preview:report-state'
  const report = (event: IpcMainEvent, ...args: unknown[]): void => {
    // ipcMain.on events do not pass through ipcMainHandle's lease binder. Reports may only
    // reuse the live document that already opened/attached the preview, never mint authority.
    const document = [...senders.values()].find(
      ({ sender, lease }) => sender === event.sender && !lease.signal.aborted && lease.isCurrent()
    )
    if (!document) return
    void forward(event, reportChannel, args, document.lease).catch((error) =>
      createLogger('office-preview').warn(
        'desktop preview state forwarding failed',
        errorLogFields(error)
      )
    )
  }
  try {
    if (client.commandNames().includes(reportChannel)) ipcMain.on(reportChannel, report)
    for (const channel of client.commandNames()) {
      if (!rendererChannels.has(channel)) continue
      ipcMainHandle(channel, async (event, ...args) => {
        const invoke = (): Promise<unknown> => forward(event, channel, args)
        if (!enveloped.has(channel)) return invoke()
        try {
          return { ok: true, result: await invoke() }
        } catch (error) {
          return { ok: false, error: toApplicationCommandErrorEnvelope(error) }
        }
      })
    }
    const installation = scope.complete(() => {
      ipcMain.removeListener(reportChannel, report)
      for (const release of releaseCallbacks) release()
    })
    return {
      ...installation,
      documentFor: (clientId) => {
        const current = senders.get(clientId)
        return current &&
          !current.lease.signal.aborted &&
          current.lease.isCurrent() &&
          !current.sender.isDestroyed()
          ? current.sender
          : undefined
      }
    }
  } catch (error) {
    ipcMain.removeListener(reportChannel, report)
    scope.rollback()
    throw error
  }
}
