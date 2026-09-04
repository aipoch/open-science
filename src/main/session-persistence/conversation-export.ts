import { app, BrowserWindow, dialog, type SaveDialogOptions } from 'electron'

import { ipcMainHandle } from '../ipc-handler-registry'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createConversationExportDocument,
  renderConversationHtml,
  renderConversationMarkdown,
  sanitizeExportFilename,
  selectConversationExportMessages,
  type ExportConversationRequest,
  type ExportConversationResult
} from '../../shared/conversation-export'
import { hasCurrentRunningDelegatedAttempt } from '../../shared/delegated-work-projection'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'
import { publishUserFile } from '../user-file-publisher'

type ConversationExportPrintWindow = {
  loadFile(path: string): Promise<void>
  webContents: {
    executeJavaScript(code: string): Promise<unknown>
    printToPDF(options: Electron.PrintToPDFOptions): Promise<Buffer>
  }
  destroy(): void
}

type ConversationExportLimits = {
  maxMessages: number
  maxImageBase64Bytes: number
  maxHtmlBytes: number
  pdfPrintTimeoutMs: number
}

const DEFAULT_CONVERSATION_EXPORT_LIMITS: ConversationExportLimits = {
  maxMessages: 2000,
  maxImageBase64Bytes: 32 * 1024 * 1024,
  maxHtmlBytes: 64 * 1024 * 1024,
  pdfPrintTimeoutMs: 120_000
}

type ConversationExportDependencies = {
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  isSessionActive(projectId: string, sessionId: string): boolean
  showSaveDialog(
    parentWindow: Electron.BrowserWindow | undefined,
    options: SaveDialogOptions
  ): Promise<Electron.SaveDialogReturnValue>
  writeFile(path: string, data: string | Buffer): Promise<void>
  publishUserFile: typeof publishUserFile
  createTempDirectory(prefix: string): Promise<string>
  removeDirectory(path: string): Promise<void>
  createPrintWindow(): ConversationExportPrintWindow
  getDownloadsPath(): string
  getTempPath(): string
  now(): number
  translate: NativeTranslator
  exportLimits: ConversationExportLimits
}

type ConversationExportRequiredDependencies = Pick<
  ConversationExportDependencies,
  'loadSession' | 'isSessionActive'
>

type ConversationExportDefaultDependencies = Omit<
  ConversationExportDependencies,
  keyof ConversationExportRequiredDependencies
>

type ConversationExportService = {
  exportConversation(
    request: ExportConversationRequest,
    parentWindow?: Electron.BrowserWindow
  ): Promise<ExportConversationResult>
}

const assertExportConversationRequest = (
  request: ExportConversationRequest
): ExportConversationRequest => {
  const selectedPromptMessageIds = request?.selectedPromptMessageIds
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.projectId !== 'string' ||
    request.projectId.length === 0 ||
    typeof request.sessionId !== 'string' ||
    request.sessionId.length === 0 ||
    (request.format !== 'markdown' && request.format !== 'pdf') ||
    (selectedPromptMessageIds !== undefined &&
      (!Array.isArray(selectedPromptMessageIds) ||
        selectedPromptMessageIds.length === 0 ||
        selectedPromptMessageIds.some(
          (promptMessageId) => typeof promptMessageId !== 'string' || promptMessageId.length === 0
        ) ||
        new Set(selectedPromptMessageIds).size !== selectedPromptMessageIds.length))
  ) {
    throw new Error('Invalid conversation export request.')
  }

  return request
}

const createDefaultPrintWindow = (): ConversationExportPrintWindow =>
  new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

const defaultDependencies: ConversationExportDefaultDependencies = {
  showSaveDialog: (parentWindow, options) =>
    parentWindow ? dialog.showSaveDialog(parentWindow, options) : dialog.showSaveDialog(options),
  writeFile,
  publishUserFile,
  createTempDirectory: mkdtemp,
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
  createPrintWindow: createDefaultPrintWindow,
  getDownloadsPath: () => app.getPath('downloads'),
  getTempPath: () => app.getPath('temp'),
  now: Date.now,
  translate: englishNativeTranslator,
  exportLimits: DEFAULT_CONVERSATION_EXPORT_LIMITS
}

const printToPdfWithTimeout = (
  print: Promise<Buffer>,
  timeoutMs: number,
  timeoutError: () => Error
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(timeoutError()), timeoutMs)
    void print.then(
      (pdf) => {
        clearTimeout(timeout)
        resolve(pdf)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })

const createConversationExportService = (
  dependencies: ConversationExportRequiredDependencies &
    Partial<ConversationExportDefaultDependencies>
): ConversationExportService => {
  const deps: ConversationExportDependencies = { ...defaultDependencies, ...dependencies }

  return {
    exportConversation: async (rawRequest, parentWindow) => {
      const request = assertExportConversationRequest(rawRequest)
      const session = await deps.loadSession(request.projectId, request.sessionId)
      if (!session) throw new Error('Conversation not found.')
      if (
        deps.isSessionActive(request.projectId, request.sessionId) ||
        hasCurrentRunningDelegatedAttempt(session) ||
        session.runtimeContext?.delegatedWork?.questionRequests?.some(
          (question) => question.status === 'pending'
        ) ||
        session.status === 'running' ||
        session.status === 'waiting-for-user' ||
        session.status === 'waiting-permission' ||
        session.status === 'waiting-plan-approval'
      ) {
        throw new Error('Wait for the conversation to finish before exporting it.')
      }
      if (session.messages.length === 0) throw new Error('Conversation has no messages to export.')

      const selectedMessages = selectConversationExportMessages(
        session.messages,
        request.selectedPromptMessageIds
      )
      const exceedsMessageBudget = selectedMessages.length > deps.exportLimits.maxMessages
      const imageBase64Bytes =
        request.format === 'pdf'
          ? selectedMessages.reduce(
              (total, message) =>
                total +
                (message.images ?? []).reduce(
                  (messageTotal, image) => messageTotal + Buffer.byteLength(image.data, 'ascii'),
                  0
                ),
              0
            )
          : 0
      if (exceedsMessageBudget || imageBase64Bytes > deps.exportLimits.maxImageBase64Bytes) {
        throw new Error(
          deps.translate('Conversation export is too large. Select fewer conversation turns.')
        )
      }

      const document = createConversationExportDocument(
        session,
        deps.now(),
        request.selectedPromptMessageIds
      )
      const extension = request.format === 'markdown' ? 'md' : 'pdf'
      const defaultPath = join(
        deps.getDownloadsPath(),
        `${sanitizeExportFilename(document.title)}.${extension}`
      )
      const dialogResult = await deps.showSaveDialog(parentWindow, {
        title: deps.translate('Export conversation'),
        defaultPath,
        filters: [
          request.format === 'markdown'
            ? { name: deps.translate('Markdown'), extensions: ['md'] }
            : { name: deps.translate('PDF'), extensions: ['pdf'] }
        ]
      })

      if (dialogResult.canceled || !dialogResult.filePath) return { saved: false }

      if (request.format === 'markdown') {
        await deps.publishUserFile(dialogResult.filePath, (temporaryPath) =>
          deps.writeFile(temporaryPath, renderConversationMarkdown(document))
        )
        return { saved: true, filePath: dialogResult.filePath }
      }

      const html = renderConversationHtml(document)
      if (Buffer.byteLength(html, 'utf8') > deps.exportLimits.maxHtmlBytes) {
        throw new Error(
          deps.translate('Conversation export is too large. Select fewer conversation turns.')
        )
      }
      const tempDirectory = await deps.createTempDirectory(
        join(deps.getTempPath(), 'open-science-conversation-export-')
      )
      try {
        const htmlPath = join(tempDirectory, 'conversation.html')
        await deps.writeFile(htmlPath, html)

        const printWindow = deps.createPrintWindow()
        try {
          await printWindow.loadFile(htmlPath)
          await printWindow.webContents.executeJavaScript(
            'document.fonts ? document.fonts.ready.then(() => true) : true'
          )
          const pdf = await printToPdfWithTimeout(
            printWindow.webContents.printToPDF({
              pageSize: 'A4',
              printBackground: true,
              margins: {
                top: 0.2,
                bottom: 0.2,
                left: 0.2,
                right: 0.2
              }
            }),
            deps.exportLimits.pdfPrintTimeoutMs,
            () =>
              new Error(
                deps.translate(
                  'Conversation PDF export timed out. Select fewer conversation turns.'
                )
              )
          )
          await deps.publishUserFile(dialogResult.filePath, (temporaryPath) =>
            deps.writeFile(temporaryPath, pdf)
          )
          return { saved: true, filePath: dialogResult.filePath }
        } finally {
          printWindow.destroy()
        }
      } finally {
        await deps.removeDirectory(tempDirectory)
      }
    }
  }
}

const registerConversationExportIpcHandler = (service: ConversationExportService): void => {
  ipcMainHandle(
    'sessions:export-conversation',
    (event, request: ExportConversationRequest): Promise<ExportConversationResult> =>
      service.exportConversation(request, BrowserWindow.fromWebContents(event.sender) ?? undefined)
  )
}

export { createConversationExportService, registerConversationExportIpcHandler }
export type {
  ConversationExportDependencies,
  ConversationExportLimits,
  ConversationExportPrintWindow,
  ConversationExportService
}
