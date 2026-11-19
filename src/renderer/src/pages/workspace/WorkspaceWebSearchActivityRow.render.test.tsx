// @vitest-environment jsdom
import { act } from 'react'
import { setupWebActivityRender } from './workspace-web-render-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceWebSearchActivityRow } from './WorkspaceWebSearchActivityRow'
import { formatWebSearchDetails } from './workspace-web-search-details'
import { searchActivity, searchResult } from './workspace-web-search-test-fixtures'
import type { ToolExecutionPhase } from './tool-execution-phase'

describe('built-in search row', () => {
  const view = setupWebActivityRender()
  const renderRow = (
    activity: ReturnType<typeof searchActivity>,
    phase: ToolExecutionPhase = 'completed',
    onToggleSearch = vi.fn()
  ): Promise<void> =>
    view.render(
      <WorkspaceWebSearchActivityRow
        activity={activity}
        phase={phase}
        details={formatWebSearchDetails(activity)}
        isExpanded
        onToggleSearch={onToggleSearch}
      />
    )

  it('reads restricted metadata without showing zero results or suggesting another search', async () => {
    const result = searchResult(0)
    result.schema = 'open-science.web.v3'
    result.result_kind = 'restricted_grounded_result'
    result.presentation = {
      status: 'presentation_only',
      handle: 'volatile_handle_12345678',
      expires_at: '2027-01-01T00:00:00.000Z'
    }
    delete result.returned_count
    delete result.effective_filters
    result.provider = { id: 'google', auth_mode: 'platform', data_policy_version: 'fixture' }
    result.routing = {
      mode: 'auto',
      requested_target: 'auto',
      selected_target: 'current_model',
      config_revision: 1
    }
    result.attempts = [
      {
        index: 1,
        provider: result.provider as {
          id: string
          auth_mode: 'platform'
          data_policy_version: string
        },
        execution: 'model_search',
        protocol: 'google-generate-content',
        started_at: result.retrieved_at,
        duration_ms: 1,
        status: 'ok',
        search_executed: true
      }
    ]
    const activity = searchActivity({}, result)
    await renderRow(activity)
    expect(view.container.textContent).toContain('Result unavailable')
    expect(view.container.textContent).not.toContain('0 results')
    expect(view.container.textContent).not.toContain('No results found')
    expect(view.container.querySelector('a, img, iframe')).toBeNull()
  })

  it('renders sources from a saved v2 result', async () => {
    const result = searchResult(1)
    result.schema = 'open-science.web.v2'
    result.provider = { id: 'tavily', auth_mode: 'anonymous', data_policy_version: 'tavily-v1' }
    result.routing = {
      mode: 'auto',
      requested_target: 'auto',
      selected_target: 'tavily',
      config_revision: 2,
      fallback_reason: 'NATIVE_TIMEOUT'
    }
    result.attempts = [
      {
        index: 1,
        provider: { id: 'openai', auth_mode: 'platform', data_policy_version: 'openai-v1' },
        execution: 'model_search',
        model: 'gpt-5.4',
        protocol: 'responses',
        started_at: result.retrieved_at,
        duration_ms: 12000,
        status: 'error',
        error: { code: 'TIMEOUT', retryable: true }
      },
      {
        index: 2,
        provider: { id: 'tavily', auth_mode: 'anonymous', data_policy_version: 'tavily-v1' },
        execution: 'direct_search',
        started_at: result.retrieved_at,
        duration_ms: 125,
        status: 'ok',
        search_executed: true,
        usage: { credits: 1 }
      }
    ]
    result.sources[0].attempt_index = 2
    const activity = searchActivity({}, result)
    await renderRow(activity)
    expect(
      view.container.querySelector('[data-testid="web-search-source"]')?.textContent
    ).toContain('Scientific search excerpt 1')
    expect(view.container.querySelector('details')).toBeNull()
  })

  it('shows eight sources initially and expands to all ten with inert excerpts', async () => {
    const result = searchResult()
    result.sources[0].snippet = '<img src="https://tracker.example/pixel"><script>alert(1)</script>'
    const activity = searchActivity({}, result)
    const onToggleSearch = vi.fn()
    await renderRow(activity, 'completed', onToggleSearch)
    expect(view.container.querySelectorAll('[data-testid="web-search-source"]')).toHaveLength(8)
    expect(view.container.querySelector('img, script, iframe')).toBeNull()
    expect(view.container.querySelector('article a')?.getAttribute('href')).toBe(
      result.sources[0].url
    )
    expect(view.container.querySelector('article time')?.getAttribute('datetime')).toBe(
      result.sources[0].published_at
    )
    expect(view.container.textContent).toContain(result.sources[0].snippet)
    expect(
      view.container.querySelector('time[datetime="2026-11-16T12:00:00.000Z"]')?.parentElement
        ?.textContent
    ).toMatch(/^Exa · /)
    const button = view.container.querySelector<HTMLButtonElement>('[data-testid="tool-chip"]')!
    expect(button.textContent).toContain('10 results · 125 ms')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const showAll = Array.from(view.container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Show all results'
    )!
    await act(async () => showAll.click())
    expect(view.container.querySelectorAll('[data-testid="web-search-source"]')).toHaveLength(10)
    button.focus()
    await act(async () => button.click())
    expect(onToggleSearch).toHaveBeenCalledWith(activity.id, false)
    expect(document.activeElement).toBe(button)
  })

  it('distinguishes a successful empty set from a failed response', async () => {
    const activity = searchActivity({}, searchResult(0))
    await renderRow(activity)
    expect(view.container.textContent).toContain('No results found')
    expect(view.container.textContent).not.toContain('The web search could not finish')
  })
  it('shows localized rate-limit guidance before collapsed error details', async () => {
    const result = searchResult(0)
    result.status = 'error'
    result.error = { code: 'RATE_LIMITED', retryable: true, retry_after_ms: 30000 }
    result.duration_ms = 15000
    const activity = searchActivity({ status: 'failed' }, result)
    await renderRow(activity, 'failed')
    expect(view.container.textContent).toContain('Wait a moment, then ask to try again.')
    expect(view.container.textContent).not.toContain('No results found')
    expect(view.container.querySelector('details')?.open).toBe(false)
    expect(view.container.textContent).toContain('RATE_LIMITED')
    expect(view.container.querySelectorAll('details')).toHaveLength(1)
    expect(view.container.querySelector('details')!.textContent).toContain('RATE_LIMITED')
  })
  it('shows known CANCELLED as stopped when ACP reports failed, without retry or source content', async () => {
    const result = searchResult()
    result.status = 'error'
    result.error = { code: 'CANCELLED', retryable: false }
    const activity = searchActivity({ status: 'failed' }, result)
    await renderRow(activity, 'failed')
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Cancelled')
    expect(view.container.querySelector('[data-testid="tool-chip"]')?.textContent).toContain(
      'Cancelled'
    )
    expect(view.container.textContent).not.toContain('Failed')
    expect(view.container.textContent).not.toContain('The web search could not finish')
    expect(view.container.textContent).not.toContain('Retry')
    expect(view.container.textContent).not.toContain('Scientific search excerpt')
    expect(view.container.textContent).not.toContain('10 results')
    expect(view.container.querySelectorAll('[data-testid="web-search-source"]')).toHaveLength(0)
  })

  it.each(['cancelled', 'declined', 'closed'] as ToolExecutionPhase[])(
    'does not let a late success overwrite authoritative %s',
    async (phase) => {
      const activity = searchActivity()
      await renderRow(activity, phase)
      expect(view.container.querySelectorAll('[data-testid="web-search-source"]')).toHaveLength(0)
      expect(view.container.querySelector('[role="status"]')).not.toBeNull()
      expect(view.container.textContent).not.toContain('10 results')
    }
  )
})
