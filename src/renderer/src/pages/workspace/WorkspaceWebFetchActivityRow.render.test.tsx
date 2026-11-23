// @vitest-environment jsdom
import { act } from 'react'
import { setupWebActivityRender } from './workspace-web-render-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceWebFetchActivityRow } from './WorkspaceWebFetchActivityRow'
import { fetchActivity, fetchResult } from './workspace-web-fetch-test-fixtures'
import type { ToolExecutionPhase } from './tool-execution-phase'

describe('fetch activity detail surface', () => {
  const view = setupWebActivityRender()
  const renderRow = (
    result: ReturnType<typeof fetchResult>,
    phase: ToolExecutionPhase,
    activity = fetchActivity(),
    onToggle = vi.fn()
  ): Promise<void> =>
    view.render(
      <WorkspaceWebFetchActivityRow
        activity={activity}
        result={result}
        phase={phase}
        isExpanded
        onToggle={onToggle}
      />
    )

  it('renders immutable metadata and inert text without remote images or HTML', async () => {
    const result = fetchResult()
    result.document!.text =
      '<img src="https://tracking.example/image"><script>alert(1)</script>\n![x](https://tracking.example/pixel)'
    result.document!.truncated = true
    result.cache = { hit: true, age_ms: 450 }
    const onToggle = vi.fn()
    await renderRow(result, 'completed', fetchActivity(), onToggle)
    expect(view.container.textContent).toContain(result.document!.text)
    expect(view.container.querySelector('img, script, iframe')).toBeNull()
    expect(view.container.textContent).toContain('Partial page text')
    expect(Array.from(view.container.querySelectorAll('time'), (time) => time.dateTime)).toEqual([
      result.document!.fetched_at
    ])
    const details = view.container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(Array.from(details.querySelectorAll('dt'), (item) => item.textContent)).toEqual([
      'Original URL',
      'Final URL',
      'Fetched at'
    ])
    expect(view.container.querySelector('section a')?.getAttribute('href')).toBe(
      'https://example.org/final'
    )
    const links = view.container.querySelectorAll<HTMLAnchorElement>('details a')
    expect(Array.from(links, (link) => link.href)).toEqual([
      'https://example.org/start',
      'https://example.org/final'
    ])
    const button = view.container.querySelector<HTMLButtonElement>('[data-testid="tool-chip"]')!
    expect(button.textContent).toContain('Completed · 123 ms')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    button.focus()
    await act(async () => button.click())
    expect(onToggle).toHaveBeenCalledWith('tool-1', false)
    expect(document.activeElement).toBe(button)
    expect(
      view.container
        .querySelector('[data-testid="tool-web-fetch-details"]')!
        .getAttribute('aria-live')
    ).toBeNull()
  })

  it('keeps failed evidence in one closed Details without manual retry', async () => {
    const result = fetchResult()
    result.status = 'error'
    delete result.document
    result.error = { code: 'NETWORK_ERROR', retryable: true }
    await renderRow(result, 'failed', fetchActivity({ status: 'failed' }))
    expect(view.container.textContent).toContain('NETWORK_ERROR')
    expect(view.container.querySelectorAll('details')).toHaveLength(1)
    expect(view.container.querySelector('details')?.open).toBe(false)
    expect(view.container.textContent).not.toContain('Retry')
  })

  it('shows known CANCELLED as stopped when ACP reports failed, without retry or page content', async () => {
    const result = fetchResult()
    result.status = 'error'
    delete result.document
    result.error = { code: 'CANCELLED', retryable: false }
    await renderRow(result, 'failed', fetchActivity({ status: 'failed' }))
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Cancelled')
    expect(view.container.querySelector('[data-testid="tool-chip"]')?.textContent).toContain(
      'Cancelled'
    )
    expect(view.container.textContent).not.toContain('Failed')
    expect(view.container.textContent).not.toContain('The web page could not be read')
    expect(view.container.textContent).not.toContain('Retry')
    expect(view.container.textContent).not.toContain('Saved page text')
    expect(view.container.querySelector('pre')).toBeNull()
  })

  it.each(['declined', 'cancelled', 'closed', 'interrupted'] as ToolExecutionPhase[])(
    'keeps authoritative %s without showing a late success body',
    async (phase) => {
      await renderRow(fetchResult(), phase)
      expect(view.container.textContent).not.toContain('Saved page text')
      expect(view.container.textContent).not.toContain('Completed')
      expect(view.container.querySelector('[role="status"]')).not.toBeNull()
    }
  )

  it('uses a localized error summary and collapsed code diagnostics without a fake retry', async () => {
    const result = fetchResult()
    result.status = 'error'
    delete result.document
    result.error = { code: 'EXTRACTION_FAILED', retryable: false }
    await renderRow(result, 'failed', fetchActivity({ status: 'failed' }))
    expect(view.container.textContent).toContain('No readable page text was found.')
    const diagnostics = view.container.querySelector('details')!
    expect(diagnostics.open).toBe(false)
    expect(diagnostics.textContent).toContain('EXTRACTION_FAILED')
    expect(view.container.querySelectorAll('details')).toHaveLength(1)
    expect(view.container.querySelectorAll('button')).toHaveLength(1)
    expect(view.container.textContent).not.toContain('Saved page text')
  })
})
