import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionRequest, AcpRuntimeEvent } from '../../shared/acp'
import { ACP_PROMPT_FAILED_EVENT_TITLE } from '../../shared/acp'
import type { ComputeApprovalRequest } from '../../shared/compute'
import type { ConversationSkillImportApprovalRequest } from '../../shared/settings'
import {
  englishNativeTranslator,
  translateNativeMessage,
  type NativeTranslator
} from '../locale/main-process-messages'
import {
  describeConnectorApprovalNotification,
  describePermissionNotification,
  describeTaskNotification,
  TaskNotificationService,
  type TaskNotificationRequest,
  type TaskNotificationServiceDeps
} from './task-notifications'

const stopEvent = (stopReason: string, sessionId = 'session-1'): AcpRuntimeEvent => ({
  id: 'event-1',
  timestamp: 1,
  kind: 'stop',
  level: 'info',
  sessionId,
  title: 'Prompt stopped',
  text: stopReason
})

const errorEvent = (
  text: string,
  options: { sessionId?: string; recoverable?: 'context-overflow'; title?: string } = {}
): AcpRuntimeEvent => ({
  id: 'event-2',
  timestamp: 1,
  kind: 'error',
  level: 'error',
  sessionId: options.sessionId ?? 'session-1',
  title: options.title ?? ACP_PROMPT_FAILED_EVENT_TITLE,
  text,
  ...(options.recoverable ? { recoverable: options.recoverable } : {})
})

const elicitationEvent = (
  state: NonNullable<AcpRuntimeEvent['elicitation']>['state'],
  requestId = 'choice-1'
): AcpRuntimeEvent => ({
  id: `elicitation-${state}`,
  timestamp: 1,
  kind: 'tool',
  level: 'info',
  sessionId: 'session-1',
  toolCallId: 'tool-choice-1',
  title: 'Choose an approach',
  elicitation: {
    message: 'Choose an approach',
    fields: [],
    state,
    durable: { kind: 'agent-user-choice', requestId }
  }
})

const permissionRequest = (title: string, sessionId = 'session-1'): AcpPermissionRequest => ({
  requestId: 'req-1',
  sessionId,
  toolCallId: 'tool-1',
  title,
  options: []
})

describe('describePermissionNotification', () => {
  it('names the task and the tool waiting for approval', () => {
    expect(
      describePermissionNotification(permissionRequest('Run command'), 'Plot the curve')
    ).toEqual({
      title: 'Approval needed',
      genericBody: 'A task needs your approval. Open the app to review it.',
      body: '"Plot the curve" needs your approval: Run command',
      attention: true
    })
  })

  it('falls back to a generic body when no prompt was tracked', () => {
    expect(describePermissionNotification(permissionRequest('Edit results.csv'))).toEqual({
      title: 'Approval needed',
      genericBody: 'A task needs your approval. Open the app to review it.',
      body: 'The agent needs your approval: Edit results.csv',
      attention: true
    })
  })

  it('truncates long tool titles so platform limits cannot clip the status away', () => {
    const notification = describePermissionNotification(
      permissionRequest(`Bash: ${'x'.repeat(300)}`),
      'Plot the curve'
    )

    expect(notification.body.length).toBeLessThanOrEqual(200)
    expect(notification.body.endsWith('…')).toBe(true)
  })
})

describe('describeConnectorApprovalNotification', () => {
  it('names the task and the connector call waiting for approval', () => {
    expect(
      describeConnectorApprovalNotification(
        { connector: 'pubchem', method: 'search_compound' },
        'Plot the curve'
      )
    ).toEqual({
      title: 'Approval needed',
      genericBody: 'A task needs your approval. Open the app to review it.',
      body: '"Plot the curve" needs your approval: pubchem search compound',
      attention: true
    })
  })

  it('falls back to a generic body without a tracked prompt', () => {
    expect(describeConnectorApprovalNotification({ connector: 'zinc', method: 'search' })).toEqual({
      title: 'Approval needed',
      genericBody: 'A task needs your approval. Open the app to review it.',
      body: 'The agent needs your approval: zinc search',
      attention: true
    })
  })
})

describe('describeTaskNotification', () => {
  it('names the task from the prompt snippet when a turn completes', () => {
    expect(describeTaskNotification(stopEvent('end_turn'), 'Plot the curve')).toEqual({
      title: 'Task completed',
      genericBody: 'A task completed. Open the app to view it.',
      body: 'The agent finished responding to "Plot the curve".'
    })
  })

  it('falls back to a generic body when no prompt was tracked', () => {
    expect(describeTaskNotification(stopEvent('end_turn'))).toEqual({
      title: 'Task completed',
      genericBody: 'A task completed. Open the app to view it.',
      body: 'The agent finished responding.'
    })
  })

  it('stays silent for user-cancelled turns', () => {
    expect(describeTaskNotification(stopEvent('cancelled'), 'Plot the curve')).toBeNull()
  })

  it('explains a max_tokens stop in plain language', () => {
    expect(describeTaskNotification(stopEvent('max_tokens'), 'Plot the curve')).toEqual({
      title: 'Task needs attention',
      genericBody: 'A task needs attention. Open the app for details.',
      body: '"Plot the curve" stopped early — the answer hit the model\'s length limit.'
    })
  })

  it('explains a max_turn_requests stop as waiting for the user', () => {
    expect(describeTaskNotification(stopEvent('max_turn_requests'), 'Plot the curve')).toEqual({
      title: 'Task needs attention',
      genericBody: 'A task needs attention. Open the app for details.',
      body: '"Plot the curve" paused — send a message to keep it going.'
    })
  })

  it('explains a refusal without jargon', () => {
    expect(describeTaskNotification(stopEvent('refusal'), 'Plot the curve')).toEqual({
      title: 'Task needs attention',
      genericBody: 'A task needs attention. Open the app for details.',
      body: '"Plot the curve" was declined by the agent.'
    })
    expect(describeTaskNotification(stopEvent('refusal'))?.body).toBe(
      'The agent declined the request.'
    )
  })

  it('does not misreport an unknown stop reason as success', () => {
    expect(describeTaskNotification(stopEvent('budget_exceeded'), 'Plot the curve')).toEqual({
      title: 'Task needs attention',
      genericBody: 'A task needs attention. Open the app for details.',
      body: '"Plot the curve" finished without a clean completion status (budget exceeded).'
    })
    expect(describeTaskNotification(stopEvent('budget_exceeded'))?.body).toBe(
      'The agent finished without a clean completion status (budget exceeded).'
    )
  })

  it('does not treat an absent stop reason as a clean completion', () => {
    // Defensive: the runtime always emits a stop reason in practice, but missing text must not
    // silently claim success either.
    const event: AcpRuntimeEvent = {
      id: 'event-5',
      timestamp: 1,
      kind: 'stop',
      level: 'info',
      sessionId: 'session-1',
      title: 'Prompt stopped'
    }

    expect(describeTaskNotification(event, 'Plot the curve')).toEqual({
      title: 'Task needs attention',
      genericBody: 'A task needs attention. Open the app for details.',
      body: '"Plot the curve" finished without a clean completion status.'
    })
  })

  it('sanitizes control characters and whitespace from unknown reasons', () => {
    const event: AcpRuntimeEvent = {
      id: 'event-6',
      timestamp: 1,
      kind: 'stop',
      level: 'info',
      sessionId: 'session-1',
      title: 'Prompt stopped',
      text: 'budget\n\rexceeded\u0007 extra'
    }

    // Control characters become spaces, then whitespace folds — no word concatenation.
    expect(describeTaskNotification(event, 'Plot the curve')?.body).toBe(
      '"Plot the curve" finished without a clean completion status (budget exceeded extra).'
    )
  })

  it('turns underscores into spaces in unknown reasons', () => {
    expect(describeTaskNotification(stopEvent('budget_exceeded'), 'Plot the curve')?.body).toBe(
      '"Plot the curve" finished without a clean completion status (budget exceeded).'
    )
  })

  it('includes the error text when a turn fails', () => {
    expect(describeTaskNotification(errorEvent('Rate limit reached'), 'Plot the curve')).toEqual({
      title: 'Task failed',
      body: '"Plot the curve" failed: Rate limit reached',
      genericBody: 'A task failed. Open the app for details.',
      alwaysGeneric: true
    })
  })

  it('stays silent for recoverable context overflows (the renderer auto-retries)', () => {
    expect(
      describeTaskNotification(
        errorEvent('Prompt is too long', { recoverable: 'context-overflow' }),
        'Plot the curve'
      )
    ).toBeNull()
  })

  it.each(['Artifact cleanup failed', 'Prompt cancellation timed out'])(
    'stays silent for ancillary session-scoped errors (%s)',
    (title) => {
      expect(describeTaskNotification(errorEvent('boom', { title }), 'Plot the curve')).toBeNull()
    }
  )

  it('ignores non-terminal events', () => {
    const event: AcpRuntimeEvent = {
      id: 'event-3',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      sessionId: 'session-1',
      role: 'assistant',
      text: 'working…'
    }

    expect(describeTaskNotification(event, 'Plot the curve')).toBeNull()
  })

  it('truncates long bodies so platform limits cannot clip the status away', () => {
    const longSnippet = 'x'.repeat(200)
    const notification = describeTaskNotification(errorEvent('boom'), longSnippet)

    expect(notification?.body.length).toBeLessThanOrEqual(200)
    expect(notification?.body.endsWith('…')).toBe(true)
  })
})

// Drives the service with injected gates so each filtering rule is pinned independently.
const createService = (overrides: {
  isEnabled?: () => Promise<boolean>
  showContent?: () => Promise<boolean>
  isAppFocused?: () => boolean
  show?: (request: TaskNotificationRequest) => void
  onDeliveryError?: (error: unknown) => void
  requestAttention?: () => void
  clearAttention?: () => void
  onAttentionError?: (error: unknown) => void
  inbox?: TaskNotificationServiceDeps['inbox']
  onInboxError?: (error: unknown) => void
  hasNonTerminalComputeJobs?: (sessionId: string) => Promise<boolean>
  translate?: NativeTranslator
}): {
  service: TaskNotificationService
  shown: TaskNotificationRequest[]
  deliveryErrors: unknown[]
  attentionRequests: number[]
  attentionErrors: unknown[]
  inboxErrors: unknown[]
} => {
  const shown: TaskNotificationRequest[] = []
  const deliveryErrors: unknown[] = []
  const attentionRequests: number[] = []
  const attentionErrors: unknown[] = []
  const inboxErrors: unknown[] = []
  const deps: TaskNotificationServiceDeps = {
    isEnabled: overrides.isEnabled ?? (() => Promise.resolve(true)),
    showContent: overrides.showContent ?? (() => Promise.resolve(true)),
    isAppFocused: overrides.isAppFocused ?? (() => false),
    show: overrides.show ?? ((request) => shown.push(request)),
    onDeliveryError: overrides.onDeliveryError ?? ((error) => deliveryErrors.push(error)),
    onAttentionError: overrides.onAttentionError ?? ((error) => attentionErrors.push(error)),
    inbox: overrides.inbox,
    onInboxError: overrides.onInboxError ?? ((error) => inboxErrors.push(error)),
    hasNonTerminalComputeJobs: overrides.hasNonTerminalComputeJobs,
    translate: overrides.translate ?? englishNativeTranslator
  }
  const service = new TaskNotificationService(deps)
  service.setAttentionHandlers({
    request: overrides.requestAttention ?? (() => attentionRequests.push(1)),
    clear: overrides.clearAttention ?? (() => undefined)
  })
  return {
    service,
    shown,
    deliveryErrors,
    attentionRequests,
    attentionErrors,
    inboxErrors
  }
}

describe('TaskNotificationService', () => {
  it('localizes system delivery while keeping the inbox title as a stable English key', async () => {
    const inbox = {
      record: vi.fn(async () => undefined),
      settleAction: vi.fn(async () => undefined),
      settleAuthorization: vi.fn(async () => undefined)
    }
    const { service, shown } = createService({
      inbox,
      translate: (key, options) => translateNativeMessage('zh-Hans', key, options)
    })

    service.trackPrompt({ sessionId: 'session-1', text: '绘制曲线' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown[0]).toMatchObject({
      title: '任务已完成',
      body: '智能体已完成对"绘制曲线"的回复。'
    })
    expect(inbox.record).toHaveBeenCalledWith(expect.objectContaining({ title: 'Task completed' }))
  })

  it('keeps prompt text and provider errors out of native notifications by default', async () => {
    const shown: TaskNotificationRequest[] = []
    const service = new TaskNotificationService({
      isEnabled: async () => true,
      isAppFocused: () => false,
      translate: (key) => key,
      show: (request) => shown.push(request)
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Secret research prompt' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))
    service.trackPrompt({ sessionId: 'session-1', text: 'Another secret prompt' })
    await service.handleRuntimeEvent(errorEvent('Provider leaked request details'))

    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: 'Task completed', body: 'A task completed. Open the app to view it.' },
      { title: 'Task failed', body: 'A task failed. Open the app for details.' }
    ])
  })

  it('localizes privacy-safe native bodies independently of localized titles', async () => {
    const { service, shown } = createService({
      showContent: async () => false,
      translate: (key, options) => translateNativeMessage('zh-Hans', key, options)
    })

    service.trackPrompt({ sessionId: 'session-1', text: '敏感提示词' })
    await service.handleRuntimeEvent({ ...stopEvent('end_turn'), id: 'event-2' })

    service.trackPrompt({ sessionId: 'session-1', text: '另一个敏感提示词' })
    await service.handlePermissionRequest(permissionRequest('运行命令'))
    await service.handleRuntimeEvent(elicitationEvent('pending'))
    await service.handlePlanApproval({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'plan-version-1',
      summary: '敏感计划'
    })
    await service.handleRuntimeEvent(stopEvent('max_tokens'))

    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: '任务已完成', body: '任务已完成。打开应用即可查看。' },
      { title: '需要批准', body: '任务需要您的批准。打开应用进行查看。' },
      { title: '需要回复', body: '任务需要您的回复。打开应用以继续。' },
      { title: '计划需要批准', body: '计划已准备好等待批准。打开应用进行查看。' },
      { title: '任务需要注意', body: '任务需要注意。打开应用查看详细信息。' }
    ])
  })

  it('keeps localized provider failures generic even when detailed content is enabled', async () => {
    const { service, shown } = createService({
      showContent: async () => true,
      translate: (key, options) => translateNativeMessage('zh-Hans', key, options)
    })

    service.trackPrompt({ sessionId: 'session-1', text: '敏感提示词' })
    await service.handleRuntimeEvent(errorEvent('敏感 provider 错误'))

    expect(shown[0]).toMatchObject({
      title: '任务失败',
      body: '任务失败。打开应用查看详细信息。'
    })
  })

  it('notifies on completion using the tracked prompt as the task name', async () => {
    const { service, shown, attentionRequests } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: '\nPlot the curve\nand fit a model' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      title: 'Task completed',
      body: 'The agent finished responding to "Plot the curve".'
    })
    expect(attentionRequests).toEqual([])
  })

  it('defers completion while the Session owns non-terminal remote compute', async () => {
    const inbox = {
      record: vi.fn(async () => undefined),
      settleAction: vi.fn(async () => undefined),
      settleAuthorization: vi.fn(async () => undefined)
    }
    const hasNonTerminalComputeJobs = vi.fn(async () => true)
    const { service, shown } = createService({ inbox, hasNonTerminalComputeJobs })

    service.trackPrompt({ sessionId: 'session-1', text: 'Run the remote analysis' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
    expect(inbox.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task.completed' })
    )
    expect(hasNonTerminalComputeJobs).toHaveBeenCalledWith('session-1')
  })

  it('still records and delivers completion when the compute activity query fails', async () => {
    const queryError = new Error('compute database unavailable')
    const inbox = {
      record: vi.fn(async () => undefined),
      settleAction: vi.fn(async () => undefined),
      settleAuthorization: vi.fn(async () => undefined)
    }
    const { service, shown, deliveryErrors } = createService({
      inbox,
      hasNonTerminalComputeJobs: vi.fn(async () => Promise.reject(queryError))
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Run the remote analysis' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(deliveryErrors).toEqual([queryError])
    expect(inbox.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task.completed' }))
    expect(shown).toHaveLength(1)
  })

  it('collapses multiline prompts to their first line', async () => {
    const { service, shown } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: 'First line\nSecond line' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown[0]?.body).toBe('The agent finished responding to "First line".')
  })

  it('records task outcomes and authorization requests even when native delivery is suppressed', async () => {
    const inbox = {
      record: vi.fn(async () => undefined),
      settleAction: vi.fn(async () => undefined),
      settleAuthorization: vi.fn(async () => undefined)
    }
    const show = vi.fn()
    const service = new TaskNotificationService({
      isEnabled: async () => false,
      isAppFocused: () => true,
      translate: englishNativeTranslator,
      show,
      inbox
    })
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handlePermissionRequest(permissionRequest('Run command'))
    await service.handlePlanApproval({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'plan-version-1',
      summary: 'Plot the curve safely.'
    })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(inbox.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        dedupeKey: 'authorization:agent-tool:req-1',
        kind: 'authorization.required',
        attentionReason: 'waiting-permission',
        summary: 'A tool request needs your approval.',
        actionState: 'pending'
      })
    )
    expect(inbox.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        dedupeKey: 'authorization:session-plan:plan-version-1',
        source: 'session-plan',
        attentionReason: 'waiting-plan-approval',
        summary: 'A plan needs your approval.'
      })
    )
    expect(inbox.record).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        dedupeKey: 'task:event-1',
        kind: 'task.completed',
        source: 'agent-runtime',
        summary: 'A task completed.'
      })
    )
    expect(show).not.toHaveBeenCalled()
  })

  it('tracks an attachment-only user turn and uses a generic completion body', async () => {
    const { service, shown } = createService({})

    expect(service.trackPrompt({ sessionId: 'session-1', text: '' })).toEqual({
      token: 1
    })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown[0]).toMatchObject({
      title: 'Task completed',
      body: 'The agent finished responding.'
    })
  })

  it('parks completion on a question and settles it before the continuation completes', async () => {
    const inbox = {
      record: vi.fn(async () => undefined),
      settleAction: vi.fn(async () => undefined),
      settleAuthorization: vi.fn(async () => undefined)
    }
    const { service, shown, attentionRequests } = createService({ inbox })

    service.trackPrompt({ sessionId: 'session-1', text: 'Build a small internal tool' })
    await service.handleRuntimeEvent(elicitationEvent('pending'))
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      title: 'Response needed',
      body: '"Build a small internal tool" needs your response.'
    })
    expect(attentionRequests).toEqual([1])
    expect(inbox.record).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'input:agent-question:choice-1',
        kind: 'task.needs-attention',
        source: 'agent-question',
        attentionReason: 'waiting-for-user',
        actionState: 'pending'
      })
    )
    expect(inbox.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task.completed' })
    )

    await service.handleRuntimeEvent(elicitationEvent('answered'))
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(inbox.settleAction).toHaveBeenCalledWith('input:agent-question:choice-1', 'resolved')
    expect(inbox.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task.completed' }))
  })

  it('does not redeliver a question when more steps append to the same request', async () => {
    const { service, shown } = createService({})
    service.trackPrompt({ sessionId: 'session-1', text: 'Build a small internal tool' })

    await service.handleRuntimeEvent(elicitationEvent('pending'))
    await service.handleRuntimeEvent(elicitationEvent('pending'))

    expect(shown).toHaveLength(1)
  })

  it('does not notify while the app is focused', async () => {
    const { service, shown, attentionRequests } = createService({
      isAppFocused: () => true
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
    expect(attentionRequests).toHaveLength(0)
  })

  it('does not notify when the preference is disabled', async () => {
    const { service, shown, attentionRequests } = createService({
      isEnabled: () => Promise.resolve(false)
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
    expect(attentionRequests).toHaveLength(0)
  })

  it('fails closed when the preference read throws', async () => {
    const { service, shown } = createService({
      isEnabled: () => Promise.reject(new Error('disk gone'))
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
  })

  it('stays silent for internal turns that never tracked a prompt (reviewer correction)', async () => {
    const { service, shown } = createService({})

    // The reviewer's auditor-correction calls runtime.sendPrompt directly (no IPC, no trackPrompt).
    await service.handleRuntimeEvent(stopEvent('end_turn', 'main-session'))
    await service.handleRuntimeEvent(errorEvent('boom', { sessionId: 'main-session' }))

    expect(shown).toHaveLength(0)
  })

  it('ignores terminal events without a session id', async () => {
    const { service, shown } = createService({})

    await service.handleRuntimeEvent(stopEvent('end_turn', ''))

    expect(shown).toHaveLength(0)
  })

  it('ignores non-terminal events', async () => {
    const { service, shown } = createService({})
    const event: AcpRuntimeEvent = {
      id: 'event-4',
      timestamp: 1,
      kind: 'tool',
      level: 'info',
      sessionId: 'session-1'
    }

    await service.handleRuntimeEvent(event)

    expect(shown).toHaveLength(0)
  })

  it('forgets the prompt once the turn terminates', async () => {
    const { service, shown } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))
    // A later terminal event on the same session without a tracked prompt is not user-initiated:
    // no snippet remains, so it must stay silent.
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(1)
  })

  it('routes clicks to the activation handler with the session id', async () => {
    const order: string[] = []
    const { service, shown } = createService({
      clearAttention: () => order.push('clear')
    })
    const onActivate = vi.fn(() => order.push('activate'))

    service.setActivationHandler(onActivate)
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))
    shown[0]?.onClick()

    expect(onActivate).toHaveBeenCalledWith('session-1')
    expect(order).toEqual(['clear', 'activate'])
  })

  it('reports a click-clear error and still activates the notification target', async () => {
    const error = new Error('attention clear failed')
    const { service, shown, attentionErrors } = createService({
      clearAttention: () => {
        throw error
      }
    })
    const onActivate = vi.fn()

    service.setActivationHandler(onActivate)
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(() => shown[0]?.onClick()).not.toThrow()
    expect(attentionErrors).toEqual([error])
    expect(onActivate).toHaveBeenCalledWith('session-1')
  })

  it('reports activation errors without throwing from the notification click', async () => {
    const error = new Error('window was destroyed')
    const { service, shown, deliveryErrors } = createService({})

    service.setActivationHandler(() => {
      throw error
    })
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(() => shown[0]?.onClick()).not.toThrow()
    expect(deliveryErrors).toEqual([error])
  })

  it('keeps the tracked prompt when an ancillary error precedes the turn failure', async () => {
    const { service, shown } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    // Cancel-timeout escalation is not the turn's terminal state.
    await service.handleRuntimeEvent(
      errorEvent('cancel timed out', { title: 'Prompt cancellation timed out' })
    )
    await service.handleRuntimeEvent(errorEvent('process killed'))

    expect(shown).toHaveLength(1)
    expect(shown[0]?.body).toBe('A task failed. Open the app for details.')
  })

  it('swallows delivery errors and reports them instead of rejecting', async () => {
    const boom = new Error('Notification unavailable')
    const { service, deliveryErrors, attentionRequests } = createService({
      show: () => {
        throw boom
      }
    })

    // Must not reject: the caller voids this promise on the broadcast path.
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(deliveryErrors).toEqual([boom])
    expect(attentionRequests).toEqual([])
  })

  it('fails closed when the focus probe throws and reports the delivery error', async () => {
    const error = new Error('window was destroyed')
    const { service, shown, deliveryErrors } = createService({
      isAppFocused: () => {
        throw error
      }
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })

    await expect(service.handleRuntimeEvent(stopEvent('end_turn'))).resolves.toBeUndefined()
    expect(shown).toHaveLength(0)
    expect(deliveryErrors).toEqual([error])
  })

  it('reports approval attention errors without blocking the system notification', async () => {
    const boom = new Error('taskbar unavailable')
    const { service, shown, attentionErrors } = createService({
      requestAttention: () => {
        throw boom
      }
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handlePermissionRequest(permissionRequest('Run command'))

    expect(shown).toHaveLength(1)
    expect(attentionErrors).toEqual([boom])
  })

  it.each([
    ['clean completion', stopEvent('end_turn'), 'task.completed', 'A task completed.'],
    [
      'abnormal stop',
      stopEvent('max_tokens'),
      'task.needs-attention',
      'A task needs attention. Open the conversation for details.'
    ],
    [
      'task failure',
      errorEvent('Rate limit reached'),
      'task.failed',
      'A task failed. Open the conversation for details.'
    ]
  ])(
    'records a fixed, non-sensitive message-center summary for a tracked %s',
    async (_label, event, kind, summary) => {
      const record = vi.fn(async () => undefined)
      const { service } = createService({
        inbox: {
          record,
          settleAction: vi.fn(async () => undefined),
          settleAuthorization: vi.fn(async () => undefined)
        }
      })

      service.trackPrompt({ sessionId: 'session-1', text: 'secret prompt text' })
      await service.handleRuntimeEvent(event)

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ kind, sessionId: 'session-1', summary })
      )
      expect(record).not.toHaveBeenCalledWith(
        expect.objectContaining({ summary: expect.stringContaining('secret prompt text') })
      )
      expect(record).not.toHaveBeenCalledWith(
        expect.objectContaining({ summary: expect.stringContaining('Rate limit reached') })
      )
    }
  )

  it.each([
    ['max_tokens', 'task-max-tokens'],
    ['max_turn_requests', 'task-max-turn-requests'],
    ['refusal', 'task-refusal'],
    ['future_provider_reason', 'task-unclean-stop']
  ] as const)(
    'maps stop reason %s into bounded inbox metadata',
    async (stopReason, attentionReason) => {
      const record = vi.fn(async () => undefined)
      const { service } = createService({
        inbox: {
          record,
          settleAction: vi.fn(async () => undefined),
          settleAuthorization: vi.fn(async () => undefined)
        }
      })

      service.trackPrompt({ sessionId: 'session-1', text: 'Task' })
      await service.handleRuntimeEvent(stopEvent(stopReason))

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'agent-runtime',
          attentionReason
        })
      )
      expect(record).not.toHaveBeenCalledWith(
        expect.objectContaining({ attentionReason: stopReason })
      )
    }
  )

  it.each([
    ['abnormal stop', stopEvent('max_tokens')],
    ['task failure', errorEvent('Rate limit reached')]
  ])('does not request native attention for a tracked %s', async (_label, event) => {
    const { service, attentionRequests } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(event)

    expect(attentionRequests).toEqual([])
  })

  it('does not record task outcomes for cancellation or recoverable retries', async () => {
    const record = vi.fn(async () => undefined)
    const { service } = createService({
      inbox: {
        record,
        settleAction: vi.fn(async () => undefined),
        settleAuthorization: vi.fn(async () => undefined)
      }
    })

    service.trackPrompt({ sessionId: 'cancelled', text: 'Cancel me' })
    await service.handleRuntimeEvent(stopEvent('cancelled', 'cancelled'))

    service.trackPrompt({ sessionId: 'retrying', text: 'Retry me' })
    await service.handleRuntimeEvent(
      errorEvent('Prompt is too long', {
        sessionId: 'retrying',
        recoverable: 'context-overflow'
      })
    )

    expect(record).not.toHaveBeenCalled()
  })

  it('isolates inbox persistence errors and still delivers the system notification', async () => {
    const error = new Error('inbox persistence failed')
    const { service, shown, inboxErrors } = createService({
      inbox: {
        record: () => Promise.reject(error),
        settleAction: vi.fn(async () => undefined),
        settleAuthorization: vi.fn(async () => undefined)
      }
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await expect(service.handleRuntimeEvent(stopEvent('end_turn'))).resolves.toBeUndefined()

    expect(inboxErrors).toEqual([error])
    expect(shown).toHaveLength(1)
  })

  it('does not delay the system notification while inbox persistence is pending', async () => {
    let finishInbox: (() => void) | undefined
    const { service, shown } = createService({
      inbox: {
        record: () =>
          new Promise<void>((resolve) => {
            finishInbox = resolve
          }),
        settleAction: vi.fn(async () => undefined),
        settleAuthorization: vi.fn(async () => undefined)
      }
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    const handling = service.handleRuntimeEvent(stopEvent('end_turn'))
    await vi.waitFor(() => expect(shown).toHaveLength(1))

    finishInbox?.()
    await handling
  })

  it('peeks without consuming and only takes the expected notification target', () => {
    const { service } = createService({})

    expect(service.peekPendingOpenSession()).toBeNull()

    service.setPendingOpenSession('session-7')

    expect(service.peekPendingOpenSession()).toEqual({ sessionId: 'session-7', token: 1 })
    expect(service.peekPendingOpenSession()).toEqual({ sessionId: 'session-7', token: 1 })
    expect(service.takePendingOpenSession(2)).toBeNull()
    expect(service.peekPendingOpenSession()).toEqual({ sessionId: 'session-7', token: 1 })
    expect(service.takePendingOpenSession(1)).toEqual({ sessionId: 'session-7', token: 1 })
    expect(service.peekPendingOpenSession()).toBeNull()
  })

  it('does not let an older same-session click consume a newer target', () => {
    const { service } = createService({})

    service.setPendingOpenSession('session-7')
    const older = service.peekPendingOpenSession()

    service.setPendingOpenSession('session-7')
    const newer = service.peekPendingOpenSession()

    expect(older?.sessionId).toBe('session-7')
    expect(newer?.sessionId).toBe('session-7')
    expect(newer?.token).not.toBe(older?.token)
    expect(service.takePendingOpenSession(older!.token)).toBeNull()
    expect(service.peekPendingOpenSession()).toEqual(newer)
    expect(service.takePendingOpenSession(newer!.token)).toEqual(newer)
  })

  it('surfaces the window on click even without a session (degraded connector approval)', async () => {
    const { service, shown } = createService({})
    const onActivate = vi.fn()

    service.setActivationHandler(onActivate)
    // A connector approval with no in-flight turn: no session to open, but the window must focus.
    await service.handleConnectorApproval({ connector: 'pubchem', method: 'search_compound' })

    shown[0]?.onClick()

    expect(onActivate).toHaveBeenCalledWith(undefined)
  })

  it('notifies when a task parks on a permission request', async () => {
    const { service, shown, attentionRequests } = createService({})
    const onActivate = vi.fn()

    service.setActivationHandler(onActivate)
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handlePermissionRequest(permissionRequest('Run command'))

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      title: 'Approval needed',
      body: '"Plot the curve" needs your approval: Run command'
    })
    expect(attentionRequests).toEqual([1])

    // Clicking surfaces the same conversation as a terminal notification.
    shown[0]?.onClick()
    expect(onActivate).toHaveBeenCalledWith('session-1')
  })

  it('notifies when an attachment-only user turn parks on a permission request', async () => {
    const { service, shown, attentionRequests } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: '' })
    await service.handlePermissionRequest(permissionRequest('Read attachment'))

    expect(shown[0]).toMatchObject({
      title: 'Approval needed',
      body: 'The agent needs your approval: Read attachment'
    })
    expect(attentionRequests).toEqual([1])
  })

  it('notifies for a tracked Compute approval and targets its conversation', async () => {
    const { service, shown, attentionRequests } = createService({})
    const request: ComputeApprovalRequest = {
      id: 'compute-1',
      operation: 'call_command',
      provider_id: 'ssh:cluster',
      provider_name: 'Research Cluster',
      shape: 'scheduler_cluster',
      intent: 'Run molecular dynamics',
      command_preview: 'run-md',
      command_full: 'run-md'
    }

    service.trackPrompt({ sessionId: 'session-1', text: 'Simulate the protein' })
    await service.handleComputeApproval(request, 'session-1')

    expect(shown[0]).toMatchObject({
      title: 'Approval needed',
      body: '"Simulate the protein" needs your approval: Research Cluster — Run molecular dynamics'
    })
    expect(attentionRequests).toEqual([1])
  })

  it('notifies for a tracked conversation Skill import approval', async () => {
    const { service, shown, attentionRequests } = createService({})
    const request: ConversationSkillImportApprovalRequest = {
      id: 'skill-1',
      sessionId: 'session-1',
      source: { kind: 'attachment', label: 'analysis-tools.skill' },
      previews: [],
      skipped: []
    }

    service.trackPrompt({ sessionId: 'session-1', text: 'Import these tools' })
    await service.handleSkillImportApproval(request)

    expect(shown[0]).toMatchObject({
      title: 'Approval needed',
      body: '"Import these tools" needs your approval: Import analysis-tools.skill'
    })
    expect(attentionRequests).toEqual([1])
  })

  it('stays silent for permission requests on internal turns', async () => {
    const { service, shown } = createService({})

    // No tracked prompt: the turn was not user-initiated (e.g. reviewer correction).
    await service.handlePermissionRequest(permissionRequest('Run command', 'main-session'))

    expect(shown).toHaveLength(0)
  })

  it('does not notify for permission requests while the app is focused', async () => {
    const { service, shown } = createService({ isAppFocused: () => true })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handlePermissionRequest(permissionRequest('Run command'))

    expect(shown).toHaveLength(0)
  })

  it('does not notify for permission requests when the preference is disabled', async () => {
    const { service, shown } = createService({ isEnabled: () => Promise.resolve(false) })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handlePermissionRequest(permissionRequest('Run command'))

    expect(shown).toHaveLength(0)
  })

  it('notifies for a connector approval even without a tracked prompt', async () => {
    const { service, shown } = createService({})

    // The data-egress gate blocks the call regardless of which turn triggered it.
    await service.handleConnectorApproval({ connector: 'pubchem', method: 'search_compound' })

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      title: 'Approval needed',
      body: 'The agent needs your approval: pubchem search compound'
    })
  })

  it('stays silent for connector approvals from an internal turn', async () => {
    const { service, shown, attentionRequests } = createService({})

    await service.handleConnectorApproval(
      { connector: 'pubchem', method: 'search_compound' },
      'internal-session'
    )

    expect(shown).toHaveLength(0)
    expect(attentionRequests).toHaveLength(0)
  })

  it('targets the triggering turn for a connector approval click', async () => {
    const { service, shown } = createService({})
    const onActivate = vi.fn()

    service.setActivationHandler(onActivate)
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleConnectorApproval(
      { connector: 'pubchem', method: 'search_compound' },
      'session-1'
    )

    expect(shown[0]?.body).toBe('"Plot the curve" needs your approval: pubchem search compound')
    shown[0]?.onClick()
    expect(onActivate).toHaveBeenCalledWith('session-1')
  })

  it('records a Session credential request as a navigable response wait', async () => {
    const inbox = {
      record: vi.fn(async () => undefined),
      settleAction: vi.fn(async () => undefined),
      settleAuthorization: vi.fn(async () => undefined)
    }
    const { service, shown } = createService({ inbox })
    const onActivate = vi.fn()

    service.setActivationHandler(onActivate)
    service.trackPrompt({ sessionId: 'session-1', text: 'Search OpenAlex' })
    await service.handleConnectorCredentialRequest({
      id: 'credential-1',
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_search_works',
      sessionId: 'session-1'
    })

    expect(inbox.record).toHaveBeenCalledWith({
      dedupeKey: 'input:connector-credential:credential-1',
      kind: 'task.needs-attention',
      source: 'connector',
      attentionReason: 'waiting-for-user',
      sessionId: 'session-1',
      originId: 'credential-1',
      title: 'Response needed',
      summary: 'The agent is waiting for your response.',
      actionState: 'pending'
    })
    expect(shown[0]).toMatchObject({
      title: 'Response needed',
      body: '"Search OpenAlex" needs your response.'
    })
    shown[0]?.onClick()
    expect(onActivate).toHaveBeenCalledWith('session-1')
  })

  it('settles credential waits without creating an entry for the sessionless dialog', async () => {
    const inbox = {
      record: vi.fn(async () => undefined),
      settleAction: vi.fn(async () => undefined),
      settleAuthorization: vi.fn(async () => undefined)
    }
    const { service, shown } = createService({ inbox })

    await service.handleConnectorCredentialRequest({
      id: 'credential-sessionless',
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_search_works'
    })
    await service.settleConnectorCredentialRequest('credential-1', true)
    await service.settleConnectorCredentialRequest('credential-2', false)

    expect(inbox.record).not.toHaveBeenCalled()
    expect(shown).toHaveLength(0)
    expect(inbox.settleAction).toHaveBeenNthCalledWith(
      1,
      'input:connector-credential:credential-1',
      'resolved'
    )
    expect(inbox.settleAction).toHaveBeenNthCalledWith(
      2,
      'input:connector-credential:credential-2',
      'cancelled'
    )
  })

  it('does not notify for connector approvals while the app is focused', async () => {
    const { service, shown } = createService({ isAppFocused: () => true })

    await service.handleConnectorApproval({ connector: 'pubchem', method: 'search_compound' })

    expect(shown).toHaveLength(0)
  })

  it('restores the previous prompt when a send is rejected before the turn starts', async () => {
    const { service, shown } = createService({})

    // A turn is running for prompt A; prompt B is tracked, then rejected pre-turn (e.g. another
    // prompt already in flight). A's completion must still name A, not B.
    const trackedA = service.trackPrompt({ sessionId: 'session-1', text: 'Prompt A' })
    const trackedB = service.trackPrompt({ sessionId: 'session-1', text: 'Prompt B' })

    expect(trackedA).toEqual({ token: 1 })
    expect(trackedB).toEqual({ token: 2 })

    service.untrackPrompt('session-1', trackedB)
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown[0]?.body).toBe('The agent finished responding to "Prompt A".')
  })

  it('does not corrupt a still-running turn when rejections arrive in sequence', async () => {
    const { service, shown } = createService({})

    // A running, then B tracked (pending), then C tracked (pending). B rejected (no-op, current
    // is C), then C rejected (pops both B and C from the chain; A's snippet survives).
    const trackedA = service.trackPrompt({ sessionId: 'session-1', text: 'Prompt A' })
    const trackedB = service.trackPrompt({ sessionId: 'session-1', text: 'Prompt B' })
    const trackedC = service.trackPrompt({ sessionId: 'session-1', text: 'Prompt C' })

    void trackedA
    service.untrackPrompt('session-1', trackedB)
    service.untrackPrompt('session-1', trackedC)
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown[0]?.body).toBe('The agent finished responding to "Prompt A".')
  })

  it('untrackPrompt is a no-op once a terminal event consumed the snippet', async () => {
    const { service, shown } = createService({})

    const tracked = service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))
    service.untrackPrompt('session-1', tracked)

    // The snippet was consumed by the stop event; a late untrack must not resurrect it.
    await service.handleRuntimeEvent(stopEvent('end_turn'))
    expect(shown).toHaveLength(1)
  })

  it('does not deliver if the user switches back during the settings read', async () => {
    // The focus check passes before the async settings read, but the user returns mid-read.
    const focusState = { focused: false }
    const { service, shown } = createService({
      isAppFocused: () => focusState.focused,
      isEnabled: async () => {
        // Simulate the user switching back during the disk read.
        focusState.focused = true
        return true
      }
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
  })
})
