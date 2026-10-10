import { callerContextForEvent } from '../caller-context'
import { desktopFileInteraction, type DesktopInteraction } from '../desktop-interaction'
import { tmpdir } from 'node:os'
import { runtimeMetadata } from '../runtime-metadata'

import { ipcMainHandle } from '../ipc-handler-registry'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createConversationExportDocument,
  hashConversationExportContent,
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
import { createLogger, diagnosticErrorFields } from '../logger'

const log = createLogger('conversation-export')

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
  reserveExport(projectId: string, sessionId: string): Promise<() => void>
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  isSessionActive(projectId: string, sessionId: string): boolean
  showSaveDialog: DesktopInteraction['chooseSavePathForCaller']
  writeFile(path: string, data: string | Buffer): Promise<void>
  publishUserFile: typeof publishUserFile
  createTempDirectory(prefix: string): Promise<string>
  removeDirectory(path: string): Promise<void>
  printPdf(request: {
    htmlPath: string
    timeoutMs: number
    timeoutMessage: string
  }): Promise<Buffer>
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
    callerId?: string
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
    (request.expectedContentHash !== undefined &&
      (typeof request.expectedContentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.expectedContentHash))) ||
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

const defaultDependencies: ConversationExportDefaultDependencies = {
  reserveExport: async () => () => {},
  showSaveDialog: (callerId, options) => desktopFileInteraction().chooseSavePath(options, callerId),
  writeFile,
  publishUserFile,
  createTempDirectory: mkdtemp,
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
  printPdf: (request) => desktopFileInteraction().printConversationPdf(request),
  getDownloadsPath: () => runtimeMetadata().downloadsPath,
  getTempPath: () => tmpdir(),
  now: Date.now,
  translate: englishNativeTranslator,
  exportLimits: DEFAULT_CONVERSATION_EXPORT_LIMITS
}

const createConversationExportService = (
  dependencies: ConversationExportRequiredDependencies &
    Partial<ConversationExportDefaultDependencies>
): ConversationExportService => {
  const deps: ConversationExportDependencies = { ...defaultDependencies, ...dependencies }

  const performExport: ConversationExportService['exportConversation'] = async (
    rawRequest,
    callerId
  ) => {
    const request = assertExportConversationRequest(rawRequest)
    const session = await deps.loadSession(request.projectId, request.sessionId)
    if (!session) throw new Error('Conversation not found.')
    if (
      request.expectedContentHash !== undefined &&
      request.expectedContentHash !== (await hashConversationExportContent(session))
    ) {
      throw new Error(
        deps.translate('The conversation changed. Close and reopen export to review it.')
      )
    }
    if (
      deps.isSessionActive(request.projectId, request.sessionId) ||
      (!session.packageOrigin &&
        (hasCurrentRunningDelegatedAttempt(session) ||
          session.runtimeContext?.permission?.state === 'pending' ||
          session.runtimeContext?.plan?.approval === 'pending' ||
          session.runtimeContext?.delegatedWork?.messageCommands?.some(
            (command) =>
              command.receipt.status === 'queued' ||
              (command.receipt.status === 'uncertain' && command.receipt.resolution === 'pending')
          ) ||
          (session.runtimeContext?.plan?.delivery &&
            ['queued', 'delivering'].includes(session.runtimeContext.plan.delivery.state)) ||
          session.runtimeContext?.delegatedWork?.questionRequests?.some(
            (question) => question.status === 'pending'
          ) ||
          session.activeRun ||
          session.status === 'running' ||
          session.status.startsWith('waiting-')))
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
    const dialogResult = await deps.showSaveDialog(callerId, {
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

      const pdf = await deps.printPdf({
        htmlPath,
        timeoutMs: deps.exportLimits.pdfPrintTimeoutMs,
        timeoutMessage: deps.translate(
          'Conversation PDF export timed out. Select fewer conversation turns.'
        )
      })
      await deps.publishUserFile(dialogResult.filePath, (temporaryPath) =>
        deps.writeFile(temporaryPath, pdf)
      )
      return { saved: true, filePath: dialogResult.filePath }
    } finally {
      try {
        await deps.removeDirectory(tempDirectory)
      } catch (error) {
        log.warn(
          'Failed to remove conversation export temporary directory',
          diagnosticErrorFields(error)
        )
      }
    }
  }
  return {
    exportConversation: async (rawRequest, callerId) => {
      const request = assertExportConversationRequest(rawRequest)
      const release = await deps.reserveExport(request.projectId, request.sessionId)
      try {
        return await performExport(request, callerId)
      } finally {
        release()
      }
    }
  }
}

const registerConversationExportIpcHandler = (service: ConversationExportService): void => {
  ipcMainHandle(
    'sessions:export-conversation',
    (event, request: ExportConversationRequest): Promise<ExportConversationResult> =>
      service.exportConversation(request, callerContextForEvent(event).clientId)
  )
}

export { createConversationExportService, registerConversationExportIpcHandler }
export type { ConversationExportDependencies, ConversationExportLimits, ConversationExportService }
