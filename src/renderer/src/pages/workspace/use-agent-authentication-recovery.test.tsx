import type { ProviderValidationSnapshot } from '@/lib/provider-validation-snapshot'
// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import type { ProviderView, SessionAgentConfiguration } from '../../../../shared/settings'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage
} from '../../../../shared/conversation-graph'
import type { ChatSession } from '@/stores/session-store'
import {
  useAgentAuthenticationRecovery,
  type AgentAuthenticationRecovery
} from './use-agent-authentication-recovery'

const provider: ProviderView = {
  id: 'codex',
  type: 'codex-isolated',
  name: 'Codex',
  hasKey: true,
  needsKey: false,
  models: [],
  supportsImageInput: true,
  lastValidatedAt: 10
}
const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
})
beforeEach(() =>
  useSettingsStore.setState({ ...createInitialSettingsState(), providers: [provider] })
)
const mount = (): {
  readonly result: AgentAuthenticationRecovery
  error: (value: string | null, validations?: ProviderValidationSnapshot) => void
  operation: (
    target: { providerId: string; model?: string },
    validations: ProviderValidationSnapshot,
    message?: string | null
  ) => void
  select: (id: string, model?: string) => void
  session: (value: ChatSession) => void
  providers: (values: ProviderView[]) => void
} => {
  const root = createRoot(document.createElement('div'))
  let result: AgentAuthenticationRecovery
  let error: string | null = 'Authentication required'
  let errorValidations: ProviderValidationSnapshot | undefined
  let actionError: string | null = null
  let actionTarget: { providerId: string; model?: string } | undefined
  let actionValidations: ProviderValidationSnapshot | undefined
  let configuration: SessionAgentConfiguration = {
    providerId: provider.id,
    reasoningEffort: 'default'
  }
  let session: ChatSession | undefined
  const Harness = (): null => {
    result = useAgentAuthenticationRecovery(session, 'draft', configuration, error, actionError, {
      composer: errorValidations,
      action: actionValidations,
      actionTarget
    })
    return null
  }
  const render = (): void => act(() => root.render(createElement(Harness)))
  disposers.push(() => act(() => root.unmount()))
  render()
  return {
    get result() {
      return result!
    },
    error(value: string | null, validations?: ProviderValidationSnapshot) {
      error = value
      errorValidations = validations
      render()
    },
    operation(target, validations, message = 'Authentication required') {
      actionError = message
      actionTarget = target
      actionValidations = validations
      render()
    },
    select(id: string, model?: string) {
      configuration = { ...configuration, providerId: id, model }
      render()
    },
    session(value: ChatSession) {
      session = value
      render()
    },
    providers(values: ProviderView[]) {
      act(() => useSettingsStore.setState({ providers: values }))
    }
  }
}
it('retains recovery through cancellation/failure and restores only after successful validation', () => {
  const hook = mount()
  expect(hook.result.required).toBe(true)
  hook.providers([{ ...provider }])
  expect(hook.result.required).toBe(true)
  hook.providers([{ ...provider, lastValidationFailure: { at: 20, category: 'auth' } }])
  expect(hook.result.required).toBe(true)
  act(() => hook.result.openSettings())
  hook.providers([{ ...provider, lastValidatedAt: 30 }])
  expect(hook.result.required).toBe(false)
  hook.error(null)
  hook.error('Authentication required')
  expect(hook.result.required).toBe(true)
})
it('keeps failures scoped to their provider and accepts recovery while another provider is selected', () => {
  const hook = mount()
  const other = { ...provider, id: 'other' }
  hook.providers([provider, other])
  act(() => hook.result.openSettings())
  hook.select(other.id)
  expect(hook.result.required).toBe(false)
  hook.providers([{ ...provider, lastValidatedAt: 30 }, other])
  expect(hook.result.required).toBe(false)
  hook.select(provider.id)
  expect(hook.result.required).toBe(false)
})
it('does not classify permission, network or arbitrary messages as account recovery', () => {
  const hook = mount()
  for (const message of [
    '403 Forbidden',
    '429 Too many requests',
    'Network timeout',
    'The document says Authentication required'
  ]) {
    hook.error(message)
    expect(hook.result.required).toBe(false)
  }
  hook.providers([{ ...provider, needsKey: true }])
  expect(hook.result.required).toBe(true)
})

it.each([
  { needsKey: true },
  { lastValidatedAt: undefined },
  { lastValidationFailure: { at: 40, category: 'auth' as const } }
])('restores recovery when credentials are lost again: %j', (lost) => {
  const hook = mount()
  act(() => hook.result.openSettings())
  hook.providers([{ ...provider, lastValidatedAt: 30 }])
  expect(hook.result.required).toBe(false)
  hook.providers([{ ...provider, lastValidatedAt: 30, ...lost }])
  expect(hook.result.required).toBe(true)
})

const failedSession = (providerId = provider.id): ChatSession => {
  const session: ChatSession = {
    id: 'session',
    projectId: 'project',
    cwd: '/workspace',
    title: 'Test',
    status: 'error',
    createdAt: 1,
    updatedAt: 20,
    error: 'Authentication required',
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'draft',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 20,
        turnOutcome: { kind: 'failed', settledAt: 20, error: 'Authentication required' }
      }
    ]
  }
  session.conversationGraph = createLinearConversationGraph({
    sessionId: session.id,
    messages: session.messages,
    providerId,
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 20
  })
  return session
}
it('uses the active branch and ignores an old login completion on a clean branch', () => {
  const hook = mount()
  hook.error(null)
  const failed = failedSession()
  hook.session(failed)
  expect(hook.result.required).toBe(true)
  act(() => hook.result.openSettings())
  hook.session({
    ...failed,
    conversationGraph: forkEditedConversationMessage(
      failed.conversationGraph!,
      'prompt',
      'clean-branch',
      21
    )
  })
  expect(hook.result.required).toBe(false)
  hook.providers([{ ...provider, lastValidatedAt: 30 }])
  expect(hook.result.required).toBe(false)
})
it('does not apply an old runtime provider failure to the newly selected provider', () => {
  const hook = mount()
  hook.error(null)
  hook.session(failedSession('previous-provider'))
  expect(hook.result.required).toBe(false)
  hook.providers([provider, { ...provider, id: 'previous-provider' }])
  hook.select('previous-provider')
  expect(hook.result.required).toBe(true)
})
it.each([
  [{ ...provider, lastValidatedAt: 30 }, false],
  [{ ...provider, lastValidatedAt: 30, needsKey: true }, true],
  [{ ...provider, lastValidatedAt: 30, lastValidatedTarget: { model: 'other-model' } }, true]
] as const)(
  'resolves restored failures only with valid matching credentials: %j',
  (current, required) => {
    const hook = mount()
    hook.error(null)
    hook.providers([current])
    hook.session(failedSession())
    expect(hook.result.required).toBe(required)
  }
)
it('does not restore the composer after validating another model', () => {
  const hook = mount()
  hook.select(provider.id, 'chosen')
  act(() => hook.result.openSettings())
  hook.providers([{ ...provider, lastValidatedAt: 30, lastValidatedTarget: { model: 'other' } }])
  expect(hook.result.required).toBe(true)
  hook.providers([{ ...provider, lastValidatedAt: 40, lastValidatedTarget: { model: 'chosen' } }])
  expect(hook.result.required).toBe(false)
})

it.each([false, true])(
  'blocks selected unreadable credentials independently of persisted failure: %s',
  (persistedFailure) => {
    const hook = mount()
    hook.error(null)
    if (persistedFailure) hook.session(failedSession())
    const other = { ...provider, id: 'other', needsKey: true }
    hook.providers([provider, other])
    hook.select(other.id)
    expect(hook.result.required).toBe(true)
    hook.providers([provider, { ...other, needsKey: false }])
    expect(hook.result.required).toBe(true)
    act(() => hook.result.openSettings())
    hook.providers([provider, { ...other, needsKey: false, lastValidatedAt: 30 }])
    expect(hook.result.required).toBe(false)
  }
)

it('retains the original live error when switching through a provider with unreadable credentials', () => {
  const hook = mount()
  hook.providers([provider, { ...provider, id: 'other', needsKey: true }])
  hook.select('other')
  expect(hook.result.required).toBe(true)
  hook.select(provider.id)
  expect(hook.result.required).toBe(true)
})

it('uses the provider default when validation records an effective model', () => {
  const hook = mount()
  const custom = { ...provider, type: 'custom' as const, model: 'default-model' }
  hook.providers([custom])
  act(() => hook.result.openSettings())
  hook.providers([
    { ...custom, lastValidatedAt: 30, lastValidatedTarget: { model: 'default-model' } }
  ])
  expect(hook.result.required).toBe(false)
})

it.each(['codex-isolated', 'xai-subscription'] as const)(
  'restores every mounted %s session after shared validation without requiring each to open settings',
  (type) => {
    useSettingsStore.setState({ providers: [{ ...provider, type }] })
    const first = mount()
    const second = mount()
    expect(first.result.required).toBe(true)
    expect(second.result.required).toBe(true)
    act(() => first.result.openSettings())
    first.providers([{ ...provider, type, lastValidatedAt: 30 }])
    expect(first.result.required).toBe(false)
    expect(second.result.required).toBe(false)
  }
)

it('keeps restored live failures resolved across session switches and remounts, but blocks a new failure', () => {
  const first = failedSession()
  const second = { ...first, id: 'second' }
  const hook = mount()
  hook.error('Authentication required', { codex: 10 })
  hook.session(first)
  hook.session(second)
  expect(hook.result.required).toBe(true)
  hook.session(first)
  hook.providers([{ ...provider, lastValidatedAt: 30 }])
  hook.session(second)
  expect(hook.result.required).toBe(false)
  const remounted = mount()
  remounted.error('Authentication required', { codex: 10 })
  remounted.session(second)
  expect(remounted.result.required).toBe(false)
  remounted.error('Authentication required', { codex: 30 })
  expect(remounted.result.required).toBe(true)
})

it('keeps another account blocked after the first account recovers', () => {
  const first = mount()
  const second = mount()
  const other = { ...provider, id: 'other' }
  first.providers([provider, other])
  second.error(null)
  second.select(other.id)
  second.error('Authentication required', { codex: 10, other: 10 })
  first.providers([{ ...provider, lastValidatedAt: 30 }, other])
  expect(first.result.required).toBe(false)
  expect(second.result.required).toBe(true)
})

it('restores a previously validated model when returning from a different model', () => {
  const hook = mount()
  hook.error(null)
  hook.select(provider.id, 'chosen')
  hook.providers([{ ...provider, lastValidatedAt: 30, lastValidatedTarget: { model: 'chosen' } }])
  hook.session(failedSession())
  expect(hook.result.required).toBe(false)
  hook.select(provider.id, 'other')
  expect(hook.result.required).toBe(true)
  hook.select(provider.id, 'chosen')
  expect(hook.result.required).toBe(false)
})

it('recovers the actual operation account and model independently of the current selection', () => {
  const hook = mount()
  hook.error(null)
  const other = { ...provider, id: 'other', name: 'Other account' }
  hook.providers([provider, other])
  hook.select(provider.id, 'selected-model')
  hook.operation({ providerId: 'other', model: 'requested-model' }, { codex: 10, other: 10 })
  expect(hook.result.required).toBe(true)
  expect(hook.result.provider?.id).toBe('other')
  act(() => hook.result.openSettings())
  expect(useSettingsStore.getState().pendingSettingsIntent?.route).toMatchObject({
    panel: 'model',
    view: { recoveryProviderId: 'other' }
  })
  hook.providers([{ ...provider, lastValidatedAt: 40 }, other])
  expect(hook.result.required).toBe(true)
  hook.providers([
    provider,
    { ...other, lastValidatedAt: 30, lastValidatedTarget: { model: 'selected-model' } }
  ])
  expect(hook.result.required).toBe(true)
  hook.providers([
    provider,
    { ...other, lastValidatedAt: 40, lastValidatedTarget: { model: 'requested-model' } }
  ])
  expect(hook.result.required).toBe(false)
  hook.select(provider.id, 'another-current-model')
  expect(hook.result.required).toBe(false)
  const remounted = mount()
  remounted.error(null)
  remounted.operation({ providerId: 'other', model: 'requested-model' }, { codex: 10, other: 10 })
  expect(remounted.result.required).toBe(false)
  remounted.operation({ providerId: 'other', model: 'requested-model' }, { codex: 10, other: 40 })
  expect(remounted.result.required).toBe(true)
})

it('changes recovery identity when an otherwise identical failure targets another account', () => {
  const hook = mount()
  hook.error(null)
  const other = { ...provider, id: 'other' }
  hook.providers([provider, other])
  hook.operation({ providerId: 'codex' }, { codex: 10, other: 10 })
  hook.providers([{ ...provider, lastValidatedAt: 30 }, other])
  expect(hook.result.required).toBe(false)
  hook.operation({ providerId: 'other' }, { codex: 10, other: 10 })
  expect(hook.result.required).toBe(true)
  expect(hook.result.provider?.id).toBe('other')
  hook.operation({ providerId: 'other' }, { codex: 10, other: 10 }, 'Network timeout')
  expect(hook.result.required).toBe(false)
  expect(hook.result.provider?.id).toBe('codex')
})

it('does not combine an operation failure with another account history or composer baseline', () => {
  const hook = mount()
  const other = { ...provider, id: 'other', lastValidatedAt: 15 }
  hook.providers([provider, other])
  hook.error('Authentication required', { codex: 10, other: 30 })
  hook.session(failedSession())
  hook.operation({ providerId: 'other' }, { codex: 10, other: 10 })
  expect(hook.result.required).toBe(true)
  expect(hook.result.provider?.id).toBe('codex')
})

it('returns to the selected account credential failure after the operation account recovers', () => {
  const hook = mount()
  hook.error(null)
  const other = { ...provider, id: 'other' }
  hook.providers([{ ...provider, needsKey: true }, other])
  hook.operation({ providerId: 'other' }, { codex: 10, other: 10 })
  expect(hook.result.provider?.id).toBe('other')
  hook.providers([
    { ...provider, needsKey: true },
    { ...other, lastValidatedAt: 30 }
  ])
  expect(hook.result.required).toBe(true)
  expect(hook.result.provider?.id).toBe('codex')
  hook.providers([
    { ...provider, lastValidatedAt: 40 },
    { ...other, lastValidatedAt: 30 }
  ])
  expect(hook.result.required).toBe(false)
})
