import type { ContentBlock } from '@agentclientprotocol/sdk'
import { readFile } from 'node:fs/promises'

import type { AcpPromptRequest } from '../../shared/acp'
import type { UploadedAttachment } from '../../shared/uploads'
import type { FileReference } from '../../shared/artifacts'
import { resolveFileTextBudget } from '../../shared/history-preamble'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import type { ResolvedAgentBackend } from '../agent-framework'
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
  notebook?: Readonly<{
    peekHandoffContext?: (sessionId: string) => NotebookHandoffContext | undefined
    registerTurnInputs?: (input: NotebookTurnInputs) => Promise<void>
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
      const skillPreparation = await input.turnSkill.prepareProvider({
        frameworkId: input.backend.framework.id,
        selectionText: [input.request.text, computeExecutionTargetReminder]
          .filter((segment): segment is string => Boolean(segment))
          .join('\n\n'),
        promptText: requestText,
        codex: {
          home: input.backend.adapter.codexHome,
          bridgeSkillsAvailable: input.bridgeSkillsAvailable,
          selectSkills: async (text, catalog, signal) =>
            (await this.options.selectBridgeSkills(text, catalog, signal)) ?? [],
          signal: input.signal
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
                observeUsage: ({ usage, sourceInvocationId }) => {
                  const contextUsedTokens = usage.inputTokens + (usage.cachedReadTokens ?? 0)
                  preDispatchModelCalls.push({
                    ...usage,
                    ...(sourceInvocationId ? { sourceInvocationId } : {}),
                    ...(Number.isSafeInteger(contextUsedTokens) ? { contextUsedTokens } : {})
                  })
                }
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
      const promptText = [
        input.protectedContext,
        input.request.historyPreamble,
        notebookHandoff ? notebookHandoffPrompt(notebookHandoff) : undefined,
        promptPrefix,
        buildSessionReferencePrompt(input.request.referencedSessions),
        skillPreparation.text
      ]
        .filter((segment): segment is string => Boolean(segment))
        .join('\n\n')

      const prepared = await this.options.promptContent.prepare({
        appSessionId: input.request.sessionId,
        projectId: input.projectId,
        connectionGeneration: input.connectionGeneration,
        text: promptText,
        historyImages: input.request.historyImages ?? [],
        historyUploads: input.request.historyAttachments ?? [],
        currentUploads: input.request.attachments ?? [],
        references: input.request.referencedArtifacts ?? [],
        codexSkillInputs,
        skillImportEnabled: input.skillImportEnabled,
        imageCompatibilityRelay:
          input.backend.context.supportsImageInput === false &&
          this.options.imageInputCompatibility !== undefined,
        fileTextBudget: resolveFileTextBudget(input.backend.context.window),
        skillImportTurnToken: input.skillImportTurnToken,
        onSkillImportAttachmentEligible: input.onSkillImportAttachmentEligible
      })
      releasePromptContent = prepared.close
      if (await cancelled()) return cancelPrepared()
      if (input.skillImportEnabled && this.options.authorizeReferencedUploads) {
        const paths = (prepared.turnInputs?.references ?? []).flatMap((reference) => {
          if (reference.source !== 'upload') return []
          const name = reference.name.toLowerCase()
          return name.endsWith('.skill') || name.endsWith('.zip') ? [reference.path] : []
        })
        releaseGrant = await this.options.authorizeReferencedUploads(
          input.projectId,
          input.request.sessionId,
          paths
        )
        if (await cancelled()) return cancelPrepared()
      }
      const providerContent = this.options.imageInputCompatibility
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
        await this.options.notebook.registerTurnInputs({
          projectId: input.projectId,
          appSessionId: input.request.sessionId,
          promptMessageId:
            input.request.provenanceContext?.promptMessageId ??
            input.fallbackPromptMessageId ??
            `prompt-unbound-${input.request.sessionId}-${input.skillImportTurnToken}`,
          uploads: prepared.turnInputs.uploads,
          references: prepared.turnInputs.references
        })
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
