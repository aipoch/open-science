// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ScenarioModelList } from './ScenarioModelList'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined

const renderList = (): Root => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<ScenarioModelList />))
  return root
}

const rowButton = (scenario: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(`[aria-label="Expand ${scenario} settings"]`) ??
  document.body.querySelector<HTMLButtonElement>(`[aria-label="Collapse ${scenario} settings"]`)

describe('ScenarioModelList', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportsSkills: true,
          supportedApiTypes: ['openai']
        }
      ],
      setSubagentModel: vi.fn(async () => undefined),
      setReviewerModel: vi.fn(async () => undefined),
      setSessionDetailsModel: vi.fn(async () => undefined),
      setVisionModel: vi.fn(async () => undefined)
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('summarizes inherited, follow-active, and unconfigured scenarios without badges', () => {
    const root = renderList()

    expect(document.body.textContent).toContain('Scenario models')
    expect(document.body.textContent).toContain(
      'Models for session details, subagents, review, and image understanding.'
    )

    const sessionDetailsRow = rowButton('Session details')
    const subagentRow = rowButton('Subagent')
    const reviewerRow = rowButton('Reviewer')
    const visionRow = rowButton('Vision')
    expect(sessionDetailsRow?.getAttribute('aria-expanded')).toBe('false')
    expect(subagentRow?.getAttribute('aria-expanded')).toBe('false')
    expect(reviewerRow?.getAttribute('aria-expanded')).toBe('false')
    expect(visionRow?.getAttribute('aria-expanded')).toBe('false')
    expect(visionRow?.compareDocumentPosition(sessionDetailsRow!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLButtonElement>(
          '[aria-controls^="scenario-model-panel-"]'
        )
      ).map((row) => row.getAttribute('aria-label'))
    ).toEqual([
      'Expand Subagent settings',
      'Expand Reviewer settings',
      'Expand Vision settings',
      'Expand Session details settings'
    ])

    expect(sessionDetailsRow?.textContent).toContain('Same as main model')
    expect(sessionDetailsRow?.textContent).toContain('Low')
    expect(sessionDetailsRow?.querySelector('[data-slot="badge"]')?.className).toContain('bg-muted')
    expect(sessionDetailsRow?.querySelector('[data-slot="badge"]')?.className).toContain(
      'text-muted-foreground'
    )
    expect(sessionDetailsRow?.querySelector('[data-slot="badge"]')?.className).not.toContain(
      'status-info'
    )
    expect(subagentRow?.textContent).toContain('Same as main model')
    expect(reviewerRow?.textContent).toContain('Follow main model')
    expect(visionRow?.textContent).toContain('Not configured')
    // Inherited and unconfigured rows state their routing and nothing more — no effort badge.
    expect(subagentRow?.querySelector('[data-slot="badge"]')).toBeNull()
    expect(reviewerRow?.querySelector('[data-slot="badge"]')).toBeNull()
    expect(visionRow?.querySelector('[data-slot="badge"]')).toBeNull()

    act(() => root.unmount())
  })

  it('expands rows as an accordion and renders the matching policy selector inline', () => {
    const root = renderList()

    act(() => rowButton('Subagent')?.click())
    expect(rowButton('Subagent')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[aria-label="Subagent model Model"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Runs delegated tasks spawned by the main agent.')

    // Opening another row closes the first one.
    act(() => rowButton('Reviewer')?.click())
    expect(rowButton('Subagent')?.getAttribute('aria-expanded')).toBe('false')
    expect(rowButton('Reviewer')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[aria-label="Subagent model Model"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Reviewer model Model"]')).not.toBeNull()

    // Clicking the open row collapses it.
    act(() => rowButton('Reviewer')?.click())
    expect(rowButton('Reviewer')?.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.querySelector('[aria-label="Reviewer model Model"]')).toBeNull()

    act(() => root.unmount())
  })

  it('summarizes a fixed scenario with its catalog label, provider, and effort', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-b',
          type: 'custom',
          name: 'Provider B',
          apiEndpoints: ['openai'],
          model: 'model-b',
          models: ['model-b'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      reviewerModel: {
        mode: 'fixed',
        providerId: 'provider-b',
        model: 'model-b',
        reasoningEffort: 'high'
      }
    })
    const root = renderList()

    const reviewerRow = rowButton('Reviewer')
    // Model and provider render as separate groups split by the divider, not one joined string.
    expect(reviewerRow?.textContent).toContain('model-b')
    expect(reviewerRow?.textContent).toContain('Provider B')
    expect(reviewerRow?.textContent).toContain('High')
    expect(reviewerRow?.textContent).not.toContain('Inherits')

    act(() => root.unmount())
  })

  it('keeps an unavailable fixed reference visible with its effort badge', () => {
    useSettingsStore.setState({
      subagentModel: {
        mode: 'fixed',
        providerId: 'removed-provider',
        model: 'removed-model',
        reasoningEffort: 'medium'
      }
    })
    const root = renderList()

    const subagentRow = rowButton('Subagent')
    expect(subagentRow?.textContent).toContain('removed-model')
    expect(subagentRow?.textContent).toContain('Unavailable')
    expect(subagentRow?.textContent).toContain('Medium')

    act(() => root.unmount())
  })

  it("projects a fixed scenario badge onto that scenario's own provider ladder", () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-ds',
          type: 'custom',
          name: 'DeepSeek',
          apiEndpoints: ['openai'],
          model: 'deepseek-v4-flash',
          models: ['deepseek-v4-flash'],
          reasoningEffortPreset: 'none-high-max',
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      reviewerModel: {
        mode: 'fixed',
        providerId: 'provider-ds',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'medium'
      }
    })
    const root = renderList()

    const reviewerRow = rowButton('Reviewer')
    expect(reviewerRow?.textContent).toContain('deepseek-v4-flash')
    expect(reviewerRow?.textContent).toContain('DeepSeek')
    expect(reviewerRow?.textContent).toContain('High')
    expect(reviewerRow?.textContent).not.toContain('Medium')

    act(() => root.unmount())
  })

  it('summarizes a configured Vision model against the image-capable catalog', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-v',
          type: 'custom',
          name: 'Provider V',
          apiEndpoints: ['openai'],
          model: 'vision-model',
          models: ['vision-model'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ],
      visionModel: {
        providerId: 'provider-v',
        model: 'vision-model',
        reasoningEffort: 'low'
      }
    })
    const root = renderList()

    const visionRow = rowButton('Vision')
    expect(visionRow?.textContent).toContain('vision-model')
    expect(visionRow?.textContent).toContain('Provider V')
    expect(visionRow?.textContent).toContain('Low')
    expect(visionRow?.textContent).not.toContain('Not configured')

    act(() => root.unmount())
  })

  it('summarizes an image-capable Codex subscription Vision model as available', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportsSkills: true,
          supportedApiTypes: ['responses']
        }
      ],
      providers: [
        {
          id: 'builtin-codex-isolated',
          type: 'codex-isolated',
          name: 'Codex subscription',
          apiEndpoints: ['responses'],
          models: ['gpt-5.6-sol'],
          supportsImageInput: true,
          hasKey: false,
          needsKey: false
        }
      ],
      visionModel: {
        providerId: 'builtin-codex-isolated',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high'
      }
    })
    const root = renderList()

    const visionRow = rowButton('Vision')
    expect(visionRow?.textContent).toContain('gpt-5.6-sol')
    expect(visionRow?.textContent).toContain('Codex subscription')
    expect(visionRow?.textContent).not.toContain('Unavailable')

    act(() => root.unmount())
  })

  it('marks a Vision model without image input as unavailable', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-t',
          type: 'custom',
          name: 'Provider T',
          apiEndpoints: ['openai'],
          model: 'text-only-model',
          models: ['text-only-model'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      visionModel: {
        providerId: 'provider-t',
        model: 'text-only-model',
        reasoningEffort: 'low'
      }
    })
    const root = renderList()

    const visionRow = rowButton('Vision')
    expect(visionRow?.textContent).toContain('text-only-model')
    expect(visionRow?.textContent).toContain('Unavailable')
    // The provider still exists, so the tail keeps its name rather than the raw id.
    expect(visionRow?.textContent).toContain('Provider T')

    act(() => root.unmount())
  })

  it('marks a persisted Codex subscription Session details target unavailable', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'codex-shared',
          type: 'codex-shared',
          name: 'Codex subscription',
          apiEndpoints: ['openai'],
          model: 'gpt-5.6',
          models: ['gpt-5.6'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ],
      sessionDetailsModel: {
        mode: 'fixed',
        providerId: 'codex-shared',
        model: 'gpt-5.6',
        reasoningEffort: 'low'
      }
    })
    const root = renderList()

    const sessionDetailsRow = rowButton('Session details')
    expect(sessionDetailsRow?.textContent).toContain('gpt-5.6')
    expect(sessionDetailsRow?.textContent).toContain('Unavailable')

    act(() => root.unmount())
  })

  it('keeps the provider name and icon in the tail when only the model went missing', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-b',
          type: 'custom',
          name: 'Provider B',
          apiEndpoints: ['openai'],
          model: 'model-b',
          models: ['model-b'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      subagentModel: {
        mode: 'fixed',
        providerId: 'provider-b',
        model: 'removed-model',
        reasoningEffort: 'high'
      }
    })
    const root = renderList()

    const subagentRow = rowButton('Subagent')
    expect(subagentRow?.textContent).toContain('removed-model')
    expect(subagentRow?.textContent).toContain('Unavailable')
    expect(subagentRow?.textContent).toContain('Provider B')
    expect(subagentRow?.textContent).not.toContain('provider-b')

    act(() => root.unmount())
  })
})
