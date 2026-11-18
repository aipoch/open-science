// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { NotebookNetworkLogs } from './NotebookNetworkLogs'
let root: Root, container: HTMLDivElement
const query = vi.fn(),
  retention = vi.fn()
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  query.mockReset().mockResolvedValue({ records: [], retentionDays: 90, warnings: [] })
  retention.mockReset().mockResolvedValue(30)
  ;(window as unknown as { api: unknown }).api = {
    network: { queryNotebookLogs: query, setNotebookLogRetention: retention }
  }
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})
it('loads only when opened and shows an empty state without a standalone export action', async () => {
  await act(async () => root.render(<NotebookNetworkLogs />))
  expect(query).not.toHaveBeenCalled()
  await act(async () => container.querySelector('button')!.click())
  expect(query).toHaveBeenCalledWith({})
  expect(document.body.textContent).toContain('No matching network records.')
  expect(document.body.textContent).not.toContain('Export')
})
it('requires confirmation before shortening retention and preserves the previous value on cancellation', async () => {
  await act(async () => root.render(<NotebookNetworkLogs />))
  await act(async () => container.querySelector('button')!.click())
  const input = document.querySelector<HTMLInputElement>('[aria-label="Retention days"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '30')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')!
  await act(async () => save.click())
  expect(retention).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Shorten network log retention?')
  await act(async () =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click()
  )
  expect(retention).not.toHaveBeenCalled()
})

it('keeps the last successful query when a new filter fails before loading more', async () => {
  const firstPage = {
    records: [
      {
        t: '2026-11-12T00:00:00.000Z',
        level: 'info' as const,
        scope: 'notebook:network' as const,
        msg: 'network access' as const,
        data: {
          requestId: 'request-1',
          mode: 'relaxed' as const,
          projectId: 'project-1',
          sessionId: 'session-1',
          runtime: 'python',
          host: 'example.org',
          port: 443,
          protocol: 'https' as const,
          notebookRunId: 'run-1'
        }
      }
    ],
    cursor: 'cursor-relaxed',
    retentionDays: 90,
    warnings: []
  }
  let calls = 0
  query.mockImplementation(async (request: Record<string, unknown>) => {
    calls++
    if (calls === 1) return firstPage
    if (request.mode === 'strict') throw new Error('temporary read failure')
    return { ...firstPage, records: [] }
  })
  await act(async () => root.render(<NotebookNetworkLogs />))
  await act(async () => container.querySelector('button')!.click())
  await act(async () => {
    fireEvent.change(document.querySelector('[aria-label="Network mode"]')!, {
      target: { value: 'strict' }
    })
    fireEvent.submit(document.querySelector('form')!)
  })
  expect(document.body.textContent).toContain('Could not load network logs.')
  await act(async () =>
    fireEvent.click(
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Load more')!
    )
  )
  expect(query).toHaveBeenLastCalledWith({ cursor: 'cursor-relaxed' })
})
