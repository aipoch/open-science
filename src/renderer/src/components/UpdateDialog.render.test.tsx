// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'
import { UpdateDialog } from './UpdateDialog'
import { APP } from '../../../shared/app-config'

// Markdown rendering is covered by AgentMarkdown's own tests; stub it to a plain passthrough so this
// render test stays deterministic and independent of the streamdown pipeline.
vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div data-slot="markdown">{content}</div>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useUpdateStore.setState({ isDialogOpen: false, status: { state: 'idle', current: '' } })
})

describe('UpdateDialog', () => {
  it('renders nothing when the dialog is closed', () => {
    useUpdateStore.setState({
      isDialogOpen: false,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).not.toContain('Update available')
  })

  it('shows the current/new version and release notes when present', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0', notes: 'Shiny new things' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('v0.1.0')
    expect(document.body.textContent).toContain('v0.2.0')
    expect(document.body.textContent).toContain('Shiny new things')
  })

  it('links to the matching GitHub release when notes are missing', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' }
    })
    act(() => root.render(<UpdateDialog />))
    const link = document.body.querySelector('a[href*="/releases/tag/v0.2.0"]')
    expect(link).not.toBeNull()
  })

  it('invokes download when the download button is clicked', () => {
    const download = vi.fn()
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' },
      download
    })
    act(() => root.render(<UpdateDialog />))
    const button = Array.from(document.body.querySelectorAll('button')).find((element) =>
      /download update/i.test(element.textContent ?? '')
    )
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(download).toHaveBeenCalled()
  })

  it('shows "Restart to update" when a ready update applies in place (win/linux)', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'ready', current: '0.1.0', latest: '0.2.0', applyKind: 'restart' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Restart to update')
    expect(document.body.textContent).not.toContain('Open installer')
  })

  it('shows "Open installer" when a ready update applies via installer (mac)', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'ready', current: '0.1.0', latest: '0.2.0', applyKind: 'installer' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Open installer')
    expect(document.body.textContent).not.toContain('Restart to update')
  })

  it('offers a manual download fallback when the update errors', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'error', current: '0.1.0', latest: '0.2.0', error: 'Install failed' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Install failed')
    const link = document.body.querySelector(`a[href="${APP.update.downloadPage}"]`)
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('Download manually')
  })

  it('shows download size on the download button when totalBytes is present', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'available',
        current: '0.1.0',
        latest: '0.2.0',
        totalBytes: 12.5 * 1024 * 1024
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Download update (12.5 MB)')
  })

  it('shows downloaded and total bytes alongside the progress bar while downloading', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'downloading',
        current: '0.1.0',
        latest: '0.2.0',
        progress: 42,
        downloadedBytes: 4200,
        totalBytes: 10000
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('4.1 KB')
    expect(document.body.textContent).toContain('9.8 KB')
    expect(document.body.textContent).toContain('42%')
  })

  it('falls back to percent-only when byte counts are missing while downloading', () => {
    // When transferred/total are unknown the label should show only the percent, not "0 B / 0 B".
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'downloading',
        current: '0.1.0',
        latest: '0.2.0',
        progress: 35,
        downloadedBytes: undefined,
        totalBytes: undefined
      }
    })
    act(() => root.render(<UpdateDialog />))
    // Should NOT show byte formatting — just the percent.
    expect(document.body.textContent).not.toContain('0 B')
  })

  it('falls back to percent-only when downloadedBytes is 0 while downloading', () => {
    // A fresh download that hasn't received its first progress event yet: downloadedBytes is 0,
    // so the label should show percent, not "0 B / 9.8 KB".
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'downloading',
        current: '0.1.0',
        latest: '0.2.0',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 10000
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).not.toContain('0 B')
  })
})
