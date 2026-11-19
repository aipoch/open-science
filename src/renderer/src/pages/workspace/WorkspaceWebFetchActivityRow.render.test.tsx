// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceWebFetchActivityRow } from './WorkspaceWebFetchActivityRow'
import { fetchActivity, fetchResult } from './workspace-web-fetch-test-fixtures'
import type { ToolExecutionPhase } from './tool-execution-phase'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('fetch activity detail surface', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders immutable metadata and inert text without remote images or HTML', async () => {
    const result = fetchResult()
    result.document!.text =
      '<img src="https://tracking.example/image"><script>alert(1)</script>\n![x](https://tracking.example/pixel)'
    result.document!.truncated = true
    result.cache = { hit: true, age_ms: 450 }
    const onToggle = vi.fn()
    await act(async () =>
      root.render(
        <WorkspaceWebFetchActivityRow
          activity={fetchActivity()}
          result={result}
          phase="completed"
          isExpanded
          onToggle={onToggle}
        />
      )
    )
    expect(container.textContent).toContain(result.document!.text)
    expect(container.querySelector('img, script, iframe')).toBeNull()
    expect(container.textContent).toContain('Partial page text')
    expect(Array.from(container.querySelectorAll('time'), (time) => time.dateTime)).toEqual([
      result.document!.fetched_at
    ])
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(Array.from(details.querySelectorAll('dt'), (item) => item.textContent)).toEqual([
      'Original URL',
      'Final URL',
      'Fetched at'
    ])
    expect(container.querySelector('section a')?.getAttribute('href')).toBe(
      'https://example.org/final'
    )
    const links = container.querySelectorAll<HTMLAnchorElement>('details a')
    expect(Array.from(links, (link) => link.href)).toEqual([
      'https://example.org/start',
      'https://example.org/final'
    ])
    const button = container.querySelector<HTMLButtonElement>('[data-testid="tool-chip"]')!
    expect(button.textContent).toContain('Completed · 123 ms')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    button.focus()
    await act(async () => button.click())
    expect(onToggle).toHaveBeenCalledWith('tool-1', false)
    expect(document.activeElement).toBe(button)
    expect(
      container.querySelector('[data-testid="tool-web-fetch-details"]')!.getAttribute('aria-live')
    ).toBeNull()
  })

  it('keeps failed evidence in one closed Details without manual retry', async () => {
    const result = fetchResult()
    result.status = 'error'
    delete result.document
    result.error = { code: 'NETWORK_ERROR', retryable: true }
    await act(async () =>
      root.render(
        <WorkspaceWebFetchActivityRow
          activity={fetchActivity({ status: 'failed' })}
          result={result}
          phase="failed"
          isExpanded
          onToggle={vi.fn()}
        />
      )
    )
    expect(container.textContent).toContain('NETWORK_ERROR')
    expect(container.querySelectorAll('details')).toHaveLength(1)
    expect(container.querySelector('details')?.open).toBe(false)
    expect(container.textContent).not.toContain('Retry')
  })

  it('shows known CANCELLED as stopped when ACP reports failed, without retry or page content', async () => {
    const result = fetchResult()
    result.status = 'error'
    delete result.document
    result.error = { code: 'CANCELLED', retryable: false }
    await act(async () =>
      root.render(
        <WorkspaceWebFetchActivityRow
          activity={fetchActivity({ status: 'failed' })}
          result={result}
          phase="failed"
          isExpanded
          onToggle={vi.fn()}
        />
      )
    )
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Cancelled')
    expect(container.querySelector('[data-testid="tool-chip"]')?.textContent).toContain('Cancelled')
    expect(container.textContent).not.toContain('Failed')
    expect(container.textContent).not.toContain('The web page could not be read')
    expect(container.textContent).not.toContain('Retry')
    expect(container.textContent).not.toContain('Saved page text')
    expect(container.querySelector('pre')).toBeNull()
  })

  it.each(['declined', 'cancelled', 'closed', 'interrupted'] as ToolExecutionPhase[])(
    'keeps authoritative %s without showing a late success body',
    async (phase) => {
      await act(async () =>
        root.render(
          <WorkspaceWebFetchActivityRow
            activity={fetchActivity()}
            result={fetchResult()}
            phase={phase}
            isExpanded
            onToggle={vi.fn()}
          />
        )
      )
      expect(container.textContent).not.toContain('Saved page text')
      expect(container.textContent).not.toContain('Completed')
      expect(container.querySelector('[role="status"]')).not.toBeNull()
    }
  )

  it('uses a localized error summary and collapsed code diagnostics without a fake retry', async () => {
    const result = fetchResult()
    result.status = 'error'
    delete result.document
    result.error = { code: 'EXTRACTION_FAILED', retryable: false }
    await act(async () =>
      root.render(
        <WorkspaceWebFetchActivityRow
          activity={fetchActivity({ status: 'failed' })}
          result={result}
          phase="failed"
          isExpanded
          onToggle={vi.fn()}
        />
      )
    )
    expect(container.textContent).toContain('No readable page text was found.')
    const diagnostics = container.querySelector('details')!
    expect(diagnostics.open).toBe(false)
    expect(diagnostics.textContent).toContain('EXTRACTION_FAILED')
    expect(container.querySelectorAll('details')).toHaveLength(1)
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.textContent).not.toContain('Saved page text')
  })
})
