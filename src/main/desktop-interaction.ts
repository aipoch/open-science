import type { z } from 'zod'
import type {
  desktopOpenOptionsSchema,
  desktopSaveOptionsSchema,
  desktopMessageOptionsSchema,
  DesktopNativeOperation
} from './desktop-native-contract'
import { readFile, rm } from 'node:fs/promises'
import { ApplicationCommandError } from '../shared/application-command-contract'
import type { dialog, shell, WebContents, BrowserWindow, Notification } from 'electron'

// Only user interactions requiring a local desktop are represented here. Business operations,
// authorization, persistence and file reads stay in their existing owners.
export type DesktopInteraction = Readonly<{
  cliLauncherEnvironment: () => import('./cli-install/launcher').CliLauncherEnv
  installPackageQuitGuard: (active: () => boolean, blocked: () => void) => () => void
  notificationCtor: typeof Notification
  hasFocusedWindow: () => boolean
  hasWindow: () => boolean
  printConversationPdf(request: {
    htmlPath: string
    timeoutMs: number
    timeoutMessage: string
  }): Promise<Buffer>
  chooseFiles: typeof dialog.showOpenDialog
  chooseSavePath: typeof dialog.showSaveDialog
  chooseSavePathForCaller(
    callerId: string | undefined,
    options: z.infer<typeof desktopSaveOptionsSchema>
  ): Promise<{ canceled: boolean; filePath?: string }>
  confirm: typeof dialog.showMessageBox
  confirmSync: typeof dialog.showMessageBoxSync
  openPath: typeof shell.openPath
  revealPath: typeof shell.showItemInFolder
  openExternal: typeof shell.openExternal
  sender: (id: number) => WebContents | undefined
  parentWindow: (sender: WebContents) => BrowserWindow | null
}>

let interaction: DesktopInteraction | undefined

export class DesktopCapabilityUnavailable extends ApplicationCommandError {
  constructor(capability: string) {
    super(
      'command-unavailable',
      `${capability} requires the Open-Science desktop app. It is unavailable in the Node backend.`
    )
    this.name = 'DesktopCapabilityUnavailable'
  }
}

export function configureDesktopInteraction(value: DesktopInteraction): void {
  if (interaction) throw new Error('Desktop interaction is already configured.')
  interaction = value
}

export function desktopInteraction(capability: string): DesktopInteraction {
  if (!interaction) throw new DesktopCapabilityUnavailable(capability)
  return interaction
}

export const hasDesktopInteraction = (): boolean => interaction !== undefined

// File dialogs and printing are the native operations used by runtime-owned export workflows.
// They carry data and document identities, never Electron window objects.
export type DesktopFileInteraction = Readonly<{
  chooseFiles(
    options: z.infer<typeof desktopOpenOptionsSchema>,
    callerId?: string
  ): Promise<{ canceled: boolean; filePaths: string[] }>
  chooseSavePath(
    options: z.infer<typeof desktopSaveOptionsSchema>,
    callerId?: string
  ): Promise<{ canceled: boolean; filePath?: string }>
  confirm(
    options: z.infer<typeof desktopMessageOptionsSchema>,
    callerId?: string
  ): Promise<{ response: number }>
  printConversationPdf: DesktopInteraction['printConversationPdf']
}>
let fileInteraction: DesktopFileInteraction | undefined
export function configureDesktopFileInteraction(value: DesktopFileInteraction): void {
  if (fileInteraction) throw new Error('Desktop file interaction is already configured.')
  fileInteraction = value
}
export function desktopFileInteraction(): DesktopFileInteraction {
  if (fileInteraction) return fileInteraction
  const host = desktopInteraction('Native file dialogs and printing')
  return {
    chooseFiles: async (options, callerId) => {
      if (callerId === undefined) return host.chooseFiles(options)
      const sender = host.sender(Number(callerId))
      const parent = sender && !sender.isDestroyed() ? host.parentWindow(sender) : null
      if (!parent || parent.isDestroyed())
        throw new Error('Desktop command window is no longer available.')
      return host.chooseFiles(parent, options)
    },
    chooseSavePath: (options, callerId) => host.chooseSavePathForCaller(callerId, options),
    confirm: (options) => host.confirm(options),
    printConversationPdf: host.printConversationPdf
  }
}
export function createRemoteDesktopFileInteraction(
  request: (operation: DesktopNativeOperation, callerId?: string) => Promise<unknown>
): DesktopFileInteraction {
  return {
    chooseFiles: async (options, callerId) =>
      (await request({ operation: 'open-dialog', options }, callerId)) as {
        canceled: boolean
        filePaths: string[]
      },
    chooseSavePath: async (options, callerId) =>
      (await request({ operation: 'save-dialog', options }, callerId)) as {
        canceled: boolean
        filePath?: string
      },
    confirm: async (options, callerId) =>
      (await request({ operation: 'message-box', options }, callerId)) as { response: number },
    printConversationPdf: async (options) => {
      // The runtime created and owns this private export directory. A file handoff avoids limiting
      // existing exports to the WebSocket frame budget; normal export cleanup removes it on failure.
      const output = (await request({ operation: 'conversation-pdf', ...options })) as string
      try {
        return await readFile(output)
      } finally {
        await rm(output, { force: true })
      }
    }
  }
}

export type DesktopShellInteraction = Readonly<{
  openPath(path: string): Promise<string>
  revealPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
}>
let shellInteraction: DesktopShellInteraction | undefined
export function configureDesktopShellInteraction(value: DesktopShellInteraction): void {
  if (shellInteraction) throw new Error('Desktop shell interaction is already configured.')
  shellInteraction = value
}
export function desktopShellInteraction(): DesktopShellInteraction {
  if (shellInteraction) return shellInteraction
  const host = desktopInteraction('Opening a file or browser')
  return {
    openPath: host.openPath,
    openExternal: host.openExternal,
    revealPath: async (path) => host.revealPath(path)
  }
}
export function createRemoteDesktopShellInteraction(
  request: (operation: DesktopNativeOperation) => Promise<unknown>
): DesktopShellInteraction {
  return {
    openPath: async (path) => (await request({ operation: 'open-path', path })) as string,
    revealPath: async (path) => {
      await request({ operation: 'reveal-path', path })
    },
    openExternal: async (url) => {
      await request({ operation: 'open-external', url })
    }
  }
}
