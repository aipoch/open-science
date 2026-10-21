// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
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
const mount = (): {
  readonly result: AgentAuthenticationRecovery
  error: (value: string | null) => void
  select: (id: string, model?: string) => void
  session: (value: ChatSession) => void
  providers: (values: ProviderView[]) => void
} => {
  useSettingsStore.setState({ ...createInitialSettingsState(), providers: [provider] })
  const root = createRoot(document.createElement('div'))
  let result: AgentAuthenticationRecovery
  let error: string | null = 'Authentication required'
  let configuration: SessionAgentConfiguration = {
    providerId: provider.id,
    reasoningEffort: 'default'
  }
  let session: ChatSession | undefined
  const Harness = (): null => {
    result = useAgentAuthenticationRecovery(session, 'draft', configuration, error, null)
    return null
  }
  const render = (): void => act(() => root.render(createElement(Harness)))
  disposers.push(() => act(() => root.unmount()))
  render()
  return {
    get result() {
      return result!
    },
    error(value: string | null) {
      error = value
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
it('does not transfer a failed operation or an old login completion to another provider', () => {
  const hook = mount()
  const other = { ...provider, id: 'other' }
  hook.providers([provider, other])
  act(() => hook.result.openSettings())
  hook.select(other.id)
  expect(hook.result.required).toBe(false)
  hook.providers([{ ...provider, lastValidatedAt: 30 }, other])
  expect(hook.result.required).toBe(false)
  hook.select(provider.id)
  expect(hook.result.required).toBe(true)
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
