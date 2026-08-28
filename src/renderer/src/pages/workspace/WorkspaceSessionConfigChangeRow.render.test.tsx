// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n'
import type { PersistedMessageAgentTarget } from '../../../../shared/session-persistence'
import type { AgentFrameworkView, ProviderView } from '../../../../shared/settings'
import { WorkspaceSessionConfigChangeRow } from './WorkspaceSessionConfigChangeRow'

const scrollerItemProps: Array<Record<string, unknown>> = []

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: (props: { children: ReactNode }) => {
    scrollerItemProps.push({ ...props, children: undefined })
    return <div>{props.children}</div>
  }
}))

// renderToStaticMarkup reads zustand's server snapshot (the initial state), so the store hook is
// stubbed with plain fixture state instead of seeding the real store.
const settingsFixture: { agentFrameworks: AgentFrameworkView[]; providers: ProviderView[] } = {
  agentFrameworks: [],
  providers: []
}

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: <Selection,>(
    selector: (state: typeof settingsFixture) => Selection
  ): Selection => selector(settingsFixture)
}))

const agentTarget = (
  overrides: Partial<PersistedMessageAgentTarget> = {}
): PersistedMessageAgentTarget => ({
  frameworkId: 'claude-code',
  providerId: 'provider-a',
  model: 'model-a',
  reasoningEffort: 'high',
  ...overrides
})

beforeEach(() => {
  scrollerItemProps.length = 0
  settingsFixture.agentFrameworks = [
    { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
    { id: 'codex', displayName: 'Codex', supportsSkills: true }
  ]
  settingsFixture.providers = [
    {
      id: 'provider-a',
      type: 'custom',
      name: 'Gateway',
      models: ['model-a'],
      supportsImageInput: false,
      hasKey: true,
      needsKey: false
    }
  ]
})

const renderRow = (overrides?: Partial<PersistedMessageAgentTarget>): string =>
  renderToStaticMarkup(
    <WorkspaceSessionConfigChangeRow
      id="session-config-change-message-2"
      agentTarget={agentTarget(overrides)}
    />
  )

describe('WorkspaceSessionConfigChangeRow', () => {
  it('renders the current framework, model, and effort as a quiet non-interactive divider', () => {
    const html = renderRow()

    expect(html).toContain('Claude Code · model-a · High')
    expect(html).toContain(
      'aria-label="Session configuration changed to Claude Code · model-a · High"'
    )
    expect(html).toContain('bg-border-200')
    expect(html).not.toContain('role="status"')
    expect(html).not.toContain('<button')
  })

  it('renders the framework and provider brand icons inline without a badge circle', () => {
    const html = renderRow()

    // ClaudeCode brand mark (lobehub ClaudeColor) plus the custom-provider kind icon.
    expect(html).toContain('<title>Claude</title>')
    expect(html).toContain('lucide-circle-plus')
    expect(html).not.toContain('lucide-sliders-horizontal')
    expect(html).not.toContain('rounded-full border')
  })

  it('omits the provider icon when the provider no longer resolves', () => {
    settingsFixture.providers = []
    const html = renderRow()

    expect(html).toContain('Claude Code · model-a · High')
    expect(html).toContain('<title>Claude</title>')
    expect(html).not.toContain('lucide-circle-plus')
  })

  it('labels an omitted model with the provider name like the Composer model picker', () => {
    const html = renderRow({ model: undefined })

    expect(html).toContain('Claude Code · Gateway · High')
  })

  it('labels the default effort like the Composer model picker', () => {
    const html = renderRow({ reasoningEffort: 'default' })

    expect(html).toContain('Claude Code · model-a · Default')
  })

  it('opts out of content-visibility containment so the short row never renders as a placeholder', () => {
    renderRow()

    expect(scrollerItemProps).toHaveLength(1)
    expect(scrollerItemProps[0]).toMatchObject({
      messageId: 'session-config-change-message-2',
      disableContainment: true
    })
  })

  it('falls back to the raw framework id when the framework is unknown', () => {
    settingsFixture.agentFrameworks = []
    const html = renderRow()

    expect(html).toContain('claude-code · model-a · High')
  })
})
