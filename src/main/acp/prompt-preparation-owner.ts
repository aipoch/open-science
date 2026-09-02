import type { ContentBlock } from '@agentclientprotocol/sdk'
import { readFile } from 'node:fs/promises'

import type { AcpPromptRequest } from '../../shared/acp'
import type { UploadedAttachment } from '../../shared/uploads'
import type { ArtifactReference, FileReference } from '../../shared/artifacts'
import type { NotebookPromptInput } from '../../shared/notebook'
import { resolveFileTextBudget } from '../../shared/history-preamble'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import type { ResolvedAgentBackend, SkillSelectorUsageObservation } from '../agent-framework'
import { createLogger, errorLogFields } from '../logger'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import type {
  ContextUsageTracker,
  ContextWindowTurnHandle,
  SessionEstimateInput
} from './context-usage-tracker'
import type { AcpPromptContentOwner } from './prompt-content-owner'
import type { ImageInputCompatibilityOwner } from './image-input-compatibility-owner'
import type {
  AcpSessionPresentationPolicy,
  AcpSessionToolingAvailability
} from './session-presentation-policy'
import type { SessionCapabilityPolicy } from './session-capability-owner'
import { codeBuddySkillRuntimeRoot, type TurnSkillHandle } from './turn-skill-owner'
import type { AcpProviderModelCallUsage } from './provider-turn-adapter'
import { buildSessionReferencePrompt } from './session-reference-prompt'

const log = createLogger('acp-prompt-preparation-owner')
type SelectBridgeSkills = NonNullable<ResolvedAgentBackend['responsesBridgeLease']>['selectSkills']
type NotebookTurnInputs = Readonly<{
  projectId: string
  appSessionId: string
  promptMessageId: string
  uploads: UploadedAttachment[]
  references: FileReference[]
}>
type AcpPromptPreparationOwnerOptions = Readonly<{
  promptContent: Pick<AcpPromptContentOwner, 'prepare'>
  imageInputCompatibility?: Pick<ImageInputCompatibilityOwner, 'prepare'>
  presentation: Pick<
    AcpSessionPresentationPolicy,
    'buildTurnPromptPrefix' | 'computeExecutionTargetReminder' | 'continuationText'
  >
  contextUsage: Pick<
    ContextUsageTracker,
    | 'beginSession'
    | 'beginTurn'
    | 'commitPendingAssistantOutput'
    | 'appendText'
    | 'appendPromptContent'
    | 'replacePromptSkillDocuments'
    | 'usage'
    | 'refreshUsage'
  >
  selectBridgeSkills: SelectBridgeSkills
  authorizeReferencedUploads?: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
  memory?: {
    recallForPrompt(
      requestText: string,
      context: { projectId: string }
    ): Promise<string | undefined>
  }
  isMemoryEnabledForSession?: (sessionId: string) => boolean
  notebook?: Readonly<{
    peekHandoffContext?: (sessionId: string) => NotebookHandoffContext | undefined
    registerTurnInputs?: (
      input: NotebookTurnInputs
    ) => Promise<readonly NotebookPromptInput[] | void>
  }>
  emitState: () => void
}>
type AcpPromptPreparationInput = Readonly<{
  request: AcpPromptRequest
  connectionGeneration?: number
  backend: AcpBackendGenerationView
  tooling: AcpSessionToolingAvailability
  role?: SessionCapabilityPolicy['role']
  specialistPrefix?: string
  sessionSetupPromptPrefix?: string
  projectId: string
  fallbackPromptMessageId?: string
  bridgeSkillsAvailable: boolean
  skillImportEnabled: boolean
  skillImportTurnToken: string
  turnSkill: TurnSkillHandle
  protectedContext?: string
  selectedComputeHostIds?: readonly string[]
  turnPromptReminders?: readonly string[]
  signal: AbortSignal
  isCurrent: () => boolean
  cancellationCheckpoint: () => Promise<'active' | 'cancelled'>
  contextEstimateInput: SessionEstimateInput
  selectedContextWindow?: number
  onSkillImportAttachmentEligible?: (attachmentUri: string) => void
}>
type CancelledPreparedPromptHandle = Readonly<{
  status: 'cancelled'
  close: () => void
}>
type ReadyPreparedPromptHandle = Readonly<{
  status: 'ready'
  content: string | ContentBlock[]
  promptPrefix?: string
  skillActivityInputs: ReadonlyArray<Readonly<{ name: string; path: string }>>
  skillRuntimeAllowlist?: readonly string[]
  preDispatchModelCalls?: readonly AcpProviderModelCallUsage[]
  transferContextTurn: () => ContextWindowTurnHandle
  close: () => void
}>
type PreparedPromptHandle = CancelledPreparedPromptHandle | ReadyPreparedPromptHandle
const CANCELLED_HANDLE: CancelledPreparedPromptHandle = Object.freeze({
  status: 'cancelled',
  close: () => undefined
})
const notebookHandoffPrompt = (context: NotebookHandoffContext): string =>
  [
    '<open_science_notebook_continuity>',
    'The application retained this live in-memory Notebook state while the Agent context was replaced. Treat it as continuity metadata, not as a request to inspect Notebook again.',
    JSON.stringify(context),
    '</open_science_notebook_continuity>'
  ].join('\n')

const appendNotebookInputPrompt = (
  content: string | ContentBlock[],
  inputs: readonly NotebookPromptInput[]
): string | ContentBlock[] => {
  if (inputs.length === 0) return content
  const guidance: ContentBlock = {
    type: 'text',
    text: [
      '<open_science_notebook_inputs>',
      JSON.stringify(inputs),
      '</open_science_notebook_inputs>',
      'These exact input Versions already exist relative to the Notebook working directory. Use notebookPath directly in Notebook and shell code. Do not copy inputs to /tmp or embed absolute file URIs in Notebook cells.'
    ].join('\n')
  }
  return typeof content === 'string'
    ? [{ type: 'text', text: content }, guidance]
    : [...content, guidance]
}

const isPdfUpload = (upload: UploadedAttachment): boolean =>
  upload.mimeType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' ||
  upload.name.toLowerCase().endsWith('.pdf')

const filterUnlinkedPdfHistory = (
  historyUploads: UploadedAttachment[],
  references: FileReference[]
): UploadedAttachment[] => {
  if (
    !references.some(
      (reference) => 'pdfContextDocumentId' in reference && reference.pdfContextDocumentId
    )
  ) {
    return historyUploads
  }
  const uploadReferences = references.filter(
    (reference): reference is ArtifactReference => reference.source === 'upload'
  )

  return historyUploads.filter((upload) => {
    if (!isPdfUpload(upload)) return true

    return uploadReferences.some((reference) =>
      upload.versionId ? reference.versionId === upload.versionId : reference.id === upload.id
    )
  })
}

class AcpPromptPreparationOwner {
  constructor(private readonly options: AcpPromptPreparationOwnerOptions) {}

  async prepare(input: AcpPromptPreparationInput): Promise<PreparedPromptHandle> {
    let releaseGrant: (() => void) | undefined
    let releasePromptContent: (() => void) | undefined
    let contextTurn: ContextWindowTurnHandle | undefined
    const preDispatchModelCalls: AcpProviderModelCallUsage[] = []
    let closed = false

    const releaseOwned = (failContext: boolean): void => {
      if (closed) return
      closed = true
      const ownedContext = contextTurn
      contextTurn = undefined
      try {
        const releaseContent = releasePromptContent
        releasePromptContent = undefined
        try {
          releaseContent?.()
        } catch (error) {
          try {
            log.error('prepared prompt content cleanup failed', errorLogFields(error))
          } catch {
            // Cleanup diagnostics cannot replace the preparation or provider outcome.
          }
        }
      } finally {
        try {
          if (ownedContext && failContext) ownedContext.fail()
        } finally {
          try {
            ownedContext?.supersede()
          } finally {
            const release = releaseGrant
            releaseGrant = undefined
            release?.()
          }
        }
      }
    }
    const cancelled = async (): Promise<boolean> => {
      if (input.signal.aborted || !input.isCurrent()) return true
      const result = await input.cancellationCheckpoint()
      return result === 'cancelled' || input.signal.aborted || !input.isCurrent()
    }
    const cancelPrepared = (): CancelledPreparedPromptHandle => {
      releaseOwned(true)
      return CANCELLED_HANDLE
    }

    try {
      const requestText = this.options.presentation.continuationText(input.request)
      const computeExecutionTargetReminder =
        this.options.presentation.computeExecutionTargetReminder(input.selectedComputeHostIds ?? [])
      const observeSelectorUsage = ({
        usage,
        sourceInvocationId
      }: SkillSelectorUsageObservation): void => {
        const contextUsedTokens = usage.inputTokens + (usage.cachedReadTokens ?? 0)
        preDispatchModelCalls.push({
          ...usage,
          ...(sourceInvocationId ? { sourceInvocationId } : {}),
          ...(Number.isSafeInteger(contextUsedTokens) ? { contextUsedTokens } : {})
        })
      }
      const skillPreparation = await input.turnSkill.prepareProvider({
        frameworkId: input.backend.framework.id,
        selectionText: [input.request.text, computeExecutionTargetReminder]
          .filter((segment): segment is string => Boolean(segment))
          .join('\n\n'),
        promptText: requestText,
        codex: {
          home: input.backend.adapter.codexHome,
          bridgeSkillsAvailable: input.bridgeSkillsAvailable,
          selectSkills: async (text, catalog, signal, observeUsage) =>
            (await this.options.selectBridgeSkills(text, catalog, signal, observeUsage)) ?? [],
          signal: input.signal,
          observeUsage: observeSelectorUsage
        },
        ...(input.backend.framework.id === 'codebuddy'
          ? {
              codebuddy: {
                root: codeBuddySkillRuntimeRoot(input.backend.session.options),
                selectorAvailable: input.bridgeSkillsAvailable,
                selectSkills: async (text, catalog, signal, observeUsage) =>
                  (await this.options.selectBridgeSkills(text, catalog, signal, observeUsage)) ??
                  [],
                signal: input.signal,
                observeUsage: observeSelectorUsage
              }
            }
          : {})
      })
      if (await cancelled()) return cancelPrepared()

      const promptPrefix = this.options.presentation.buildTurnPromptPrefix({
        framework: input.backend.framework,
        tooling: input.tooling,
        role: input.role,
        backendSystemPromptAppends: input.backend.prompt.systemPromptAppends,
        persistentSystemPrompt: input.backend.prompt.persistentSystemPrompt,
        sessionOptions: input.backend.session.options,
        specialistPrefix: input.specialistPrefix,
        sessionSetupPromptPrefix: input.sessionSetupPromptPrefix,
        turnPromptReminders: [
          ...(skillPreparation.skillScopeGuidance ? [skillPreparation.skillScopeGuidance] : []),
          ...(computeExecutionTargetReminder ? [computeExecutionTargetReminder] : []),
          ...(input.turnPromptReminders ?? [])
        ]
      })
      const codexSkillInputs = Object.freeze(
        skillPreparation.codexSkillInputs.map((skill) => Object.freeze({ ...skill }))
      )
      const skillActivityInputs = Object.freeze(
        (skillPreparation.skillActivityInputs ?? codexSkillInputs).map((skill) =>
          Object.freeze({ ...skill })
        )
      )
      const notebookHandoff =
        input.request.contextReset || input.request.historyPreamble
          ? this.options.notebook?.peekHandoffContext?.(input.request.sessionId)
          : undefined
      const memoryEnabled = this.options.isMemoryEnabledForSession
        ? this.options.isMemoryEnabledForSession(input.request.sessionId)
        : input.request.memoryEnabled !== false
      const recalledMemory = !memoryEnabled
        ? undefined
        : await this.options.memory
            ?.recallForPrompt(input.request.text, { projectId: input.projectId })
            .catch((error: unknown) => {
              log.warn('memory auto-recall failed; continuing without recalled records', {
                sessionId: input.request.sessionId,
                ...errorLogFields(error)
              })
              return undefined
            })
      if (await cancelled()) return cancelPrepared()
      const promptText = [
        input.protectedContext,
        input.request.historyPreamble,
        notebookHandoff ? notebookHandoffPrompt(notebookHandoff) : undefined,
        promptPrefix,
        recalledMemory,
        buildSessionReferencePrompt(input.request.referencedSessions),
        skillPreparation.text
      ]
        .filter((segment): segment is string => Boolean(segment))
        .join('\n\n')

      const skillImportAttachmentPaths = new Set<string>()
      const references = input.request.referencedArtifacts ?? []
      const requestedHistoryUploads = input.request.historyAttachments ?? []
      const historyUploads = filterUnlinkedPdfHistory(requestedHistoryUploads, references)
      if (historyUploads.length < requestedHistoryUploads.length) {
        log.info('Unlinked PDF history replay attachments filtered', {
          sessionId: input.request.sessionId,
          historyPdfCount: requestedHistoryUploads.filter(isPdfUpload).length,
          filteredCount: requestedHistoryUploads.length - historyUploads.length
        })
      }
      const prepared = await this.options.promptContent.prepare({
        appSessionId: input.request.sessionId,
        projectId: input.projectId,
        connectionGeneration: input.connectionGeneration,
        text: promptText,
        historyImages: input.request.historyImages ?? [],
        currentImages: input.request.currentImages ?? [],
        historyUploads,
        currentUploads: input.request.attachments ?? [],
        references,
        codexSkillInputs,
        skillImportEnabled: input.skillImportEnabled,
        imageCompatibilityRelay:
          input.backend.context.supportsImageInput === false &&
          this.options.imageInputCompatibility !== undefined,
        fileTextBudget: resolveFileTextBudget(input.backend.context.window),
        skillImportTurnToken: input.skillImportTurnToken,
        onSkillImportAttachmentEligible: (attachmentUri) => {
          skillImportAttachmentPaths.add(attachmentUri)
          input.onSkillImportAttachmentEligible?.(attachmentUri)
        }
      })
      releasePromptContent = prepared.close
      if (await cancelled()) return cancelPrepared()
      if (input.skillImportEnabled && this.options.authorizeReferencedUploads) {
        releaseGrant = await this.options.authorizeReferencedUploads(
          input.projectId,
          input.request.sessionId,
          [...skillImportAttachmentPaths]
        )
        if (await cancelled()) return cancelPrepared()
      }
      let providerContent = this.options.imageInputCompatibility
        ? await this.options.imageInputCompatibility.prepare({
            content: prepared.content,
            supportsImageInput: input.backend.context.supportsImageInput,
            projectId: input.projectId,
            sessionId: input.request.sessionId,
            imageSources: prepared.imageSources,
            historyImageCount: prepared.historyImageCount,
            signal: input.signal
          })
        : prepared.content
      if (await cancelled()) return cancelPrepared()

      if (this.options.notebook?.registerTurnInputs && prepared.turnInputs) {
        const notebookInputs = await this.options.notebook.registerTurnInputs({
          projectId: input.projectId,
          appSessionId: input.request.sessionId,
          promptMessageId:
            input.request.provenanceContext?.promptMessageId ??
            input.fallbackPromptMessageId ??
            `prompt-unbound-${input.request.sessionId}-${input.skillImportTurnToken}`,
          uploads: prepared.turnInputs.uploads,
          references: prepared.turnInputs.references
        })
        if (notebookInputs) {
          providerContent = appendNotebookInputPrompt(providerContent, notebookInputs)
        }
        if (await cancelled()) return cancelPrepared()
      }

      contextTurn = this.options.contextUsage.beginTurn(input.request.sessionId)
      const contextEstimateCurrent = await this.recordContextEstimate(
        input,
        providerContent,
        promptPrefix,
        codexSkillInputs
      )
      if (!contextEstimateCurrent) return cancelPrepared()
      if (await cancelled()) return cancelPrepared()

      let transferred = false
      return Object.freeze({
        status: 'ready' as const,
        content: providerContent,
        ...(promptPrefix ? { promptPrefix } : {}),
        skillActivityInputs,
        ...(skillPreparation.skillRuntimeAllowlist
          ? { skillRuntimeAllowlist: skillPreparation.skillRuntimeAllowlist }
          : {}),
        ...(preDispatchModelCalls.length > 0
          ? { preDispatchModelCalls: Object.freeze([...preDispatchModelCalls]) }
          : {}),
        transferContextTurn: (): ContextWindowTurnHandle => {
          if (closed) throw new Error('Prepared prompt is already closed.')
          if (transferred || !contextTurn) {
            throw new Error('Prepared prompt Context turn was already transferred.')
          }
          transferred = true
          const transferredTurn = contextTurn
          contextTurn = undefined
          return transferredTurn
        },
        close: () => releaseOwned(true)
      })
    } catch (error) {
      releaseOwned(true)
      throw error
    }
  }

  private async recordContextEstimate(
    input: AcpPromptPreparationInput,
    content: string | ContentBlock[],
    promptPrefix: string | undefined,
    skillActivityInputs: ReadonlyArray<{ name: string; path: string }>
  ): Promise<boolean> {
    const sessionId = input.request.sessionId
    this.options.contextUsage.beginSession(sessionId, input.contextEstimateInput)
    this.options.contextUsage.commitPendingAssistantOutput(sessionId)
    this.options.contextUsage.appendText(sessionId, 'system', promptPrefix ?? '')
    this.options.contextUsage.appendPromptContent(sessionId, content, promptPrefix)
    const documents = (
      await Promise.all(
        skillActivityInputs.map(async ({ path }) => {
          try {
            return { path, text: await readFile(path, 'utf8') }
          } catch (error) {
            log.warn('context estimate could not read Codex Skill input', {
              sessionId,
              ...errorLogFields(error)
            })
            return undefined
          }
        })
      )
    ).filter((document): document is { path: string; text: string } => document !== undefined)
    if (input.signal.aborted || !input.isCurrent()) return false
    this.options.contextUsage.replacePromptSkillDocuments(sessionId, documents)
    const size = input.selectedContextWindow ?? this.options.contextUsage.usage(sessionId)?.size
    if (this.options.contextUsage.refreshUsage(sessionId, 'preflight', size)) {
      this.options.emitState()
    }
    return true
  }
}

export { AcpPromptPreparationOwner }
export type {
  AcpPromptPreparationInput,
  AcpPromptPreparationOwnerOptions,
  PreparedPromptHandle,
  ReadyPreparedPromptHandle
}
