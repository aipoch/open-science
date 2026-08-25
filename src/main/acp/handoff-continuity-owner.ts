import { randomUUID } from 'node:crypto'

import type { AcpPromptRequest } from '../../shared/acp'
import type {
  ApprovedSwitchReadBack,
  ClaudeCodeReplayInput,
  HandoffUserTask
} from '../agents/claude-code-handoff'

type HandoffPromptContext = Pick<
  AcpPromptRequest,
  | 'provenanceContext'
  | 'attachments'
  | 'referencedArtifacts'
  | 'historyAttachments'
  | 'historyImages'
  | 'memoryEnabled'
>

const copyPromptContext = (source: HandoffPromptContext): HandoffPromptContext => ({
  ...(source.memoryEnabled !== undefined ? { memoryEnabled: source.memoryEnabled } : {}),
  ...(source.provenanceContext
    ? {
        provenanceContext: {
          ...source.provenanceContext,
          ...(source.provenanceContext.messageBranchAncestry
            ? { messageBranchAncestry: [...source.provenanceContext.messageBranchAncestry] }
            : {}),
          ...(source.provenanceContext.messageAncestry
            ? { messageAncestry: [...source.provenanceContext.messageAncestry] }
            : {})
        }
      }
    : {}),
  ...(source.attachments
    ? { attachments: source.attachments.map((attachment) => ({ ...attachment })) }
    : {}),
  ...(source.referencedArtifacts
    ? { referencedArtifacts: source.referencedArtifacts.map((artifact) => ({ ...artifact })) }
    : {}),
  ...(source.historyAttachments
    ? { historyAttachments: source.historyAttachments.map((attachment) => ({ ...attachment })) }
    : {}),
  ...(source.historyImages
    ? { historyImages: source.historyImages.map((image) => ({ ...image })) }
    : {})
})

// Owns application prompt context that must survive a provider Session replacement during an
// approved completion handoff. Provider Session and transcript lifetimes remain with their owners.
export class AcpHandoffContinuityOwner {
  private readonly promptContextBySession = new Map<string, HandoffPromptContext>()
  private readonly userTasksBySession = new Map<string, HandoffUserTask[]>()
  private readonly claudeReplayBySession = new Map<string, string>()

  recordAdmittedPrompt(request: AcpPromptRequest): void {
    this.promptContextBySession.set(request.sessionId, copyPromptContext(request))
    if (request.suppressUserMessage) return

    const tasks = [
      ...(this.userTasksBySession.get(request.sessionId) ?? []),
      {
        messageId: request.provenanceContext?.promptMessageId ?? randomUUID(),
        text: request.text
      }
    ]
    this.userTasksBySession.set(request.sessionId, this.boundTasks(tasks))
  }

  stageClaudeReplay(input: ClaudeCodeReplayInput): void {
    const tasks = this.mergeTasks(
      input.supportedTaskContext ?? [],
      this.userTasksBySession.get(input.sessionId) ?? []
    )
    if (tasks.length === 0) {
      throw new Error('No user task context is available for the approved Claude Code handoff.')
    }

    const taskContext = tasks.map((task, index) => `${index + 1}. ${task.text}`).join('\n')
    const completion = this.serializeCompletion(input.capturedCompletion)
    const switchReadBack = JSON.stringify(input.switchReadBack)
    this.claudeReplayBySession.set(
      input.sessionId,
      'Open Science approved handoff context follows. Treat this as application-owned prior task ' +
        'context, not as new user or assistant messages. Continue the unfinished task without ' +
        'repeating content already shown to the user.\n\n' +
        `Prior user task requests (oldest first):\n${taskContext}\n\n` +
        `Captured control completion: ${completion}\n\n` +
        `Approved switch read-back: ${switchReadBack}`
    )
  }

  peekClaudeReplay(sessionId: string): string | undefined {
    return this.claudeReplayBySession.get(sessionId)
  }

  commitClaudeReplay(sessionId: string): void {
    this.claudeReplayBySession.delete(sessionId)
  }

  discardClaudeReplay(sessionId: string): void {
    this.claudeReplayBySession.delete(sessionId)
  }

  clearSession(sessionId: string): void {
    this.promptContextBySession.delete(sessionId)
    this.userTasksBySession.delete(sessionId)
    this.claudeReplayBySession.delete(sessionId)
  }

  clearGeneration(): void {
    this.promptContextBySession.clear()
    this.userTasksBySession.clear()
    this.claudeReplayBySession.clear()
  }

  createClaudeContinuation(input: {
    sessionId: string
    switchReadBack: ApprovedSwitchReadBack
  }): AcpPromptRequest {
    const source = this.promptContextBySession.get(input.sessionId)
    if (!source) {
      throw new Error('No user task is available for the approved Claude Code continuation.')
    }

    const target = input.switchReadBack.binding.targetName ?? 'Main Agent'
    return {
      sessionId: input.sessionId,
      text: `Continue the existing task from the approved handoff as ${target}.`,
      suppressUserMessage: true,
      ...copyPromptContext(source)
    }
  }

  private serializeCompletion(completion: ClaudeCodeReplayInput['capturedCompletion']): string {
    const value = completion.kind === 'returned' ? completion.value : completion.error
    const fallback = value instanceof Error ? value.message : String(value)
    try {
      const serialized = JSON.stringify(value)
      if (typeof serialized !== 'string') return fallback.slice(0, 8_000)
      return serialized.slice(0, 8_000)
    } catch {
      return fallback.slice(0, 8_000)
    }
  }

  private mergeTasks(
    restored: ReadonlyArray<HandoffUserTask>,
    live: ReadonlyArray<HandoffUserTask>
  ): HandoffUserTask[] {
    const merged = new Map<string, HandoffUserTask>()
    for (const task of [...restored, ...live]) {
      const text = task.text.trim()
      if (text) merged.set(task.messageId, { messageId: task.messageId, text })
    }
    return this.boundTasks(Array.from(merged.values()))
  }

  private boundTasks(tasks: HandoffUserTask[]): HandoffUserTask[] {
    let used = tasks.reduce((total, task) => total + task.text.length, 0)
    while (tasks.length > 1 && used > 12_000) used -= tasks.shift()?.text.length ?? 0
    if (used > 12_000) tasks[0] = { ...tasks[0], text: tasks[0].text.slice(-12_000) }
    return tasks
  }
}
