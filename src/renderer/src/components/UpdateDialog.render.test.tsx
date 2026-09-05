// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
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
  it('preserves a covered update request while suppressing its presentation', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' }
    })

    act(() => root.render(<UpdateDialog active={false} />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(useUpdateStore.getState().isDialogOpen).toBe(true)
  })

  it('uses shared settings dialog chrome and prevents outside-click dismissal', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' }
    })
    act(() => root.render(<UpdateDialog />))

    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(dialog?.className).toContain('overflow-hidden')
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-b border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-t border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
  })

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

  it('selects localized notes and reacts to a live language change', async () => {
    await act(async () => i18next.changeLanguage('en'))
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'available',
        current: '0.18.0',
        latest: '0.19.0',
        notes: 'English notes',
        localizedNotes: { 'zh-Hans': '简体中文说明' }
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('English notes')

    await act(async () => i18next.changeLanguage('zh-Hans'))
    expect(document.body.textContent).toContain('简体中文说明')
    expect(document.body.textContent).not.toContain('English notes')
    expect(document.body.textContent).not.toContain('暂无本地化发行说明')
    await act(async () => i18next.changeLanguage('en'))
  })

  it('clearly identifies the English fallback when localized notes are missing', async () => {
    await act(async () => i18next.changeLanguage('fr'))
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'available',
        current: '0.18.0',
        latest: '0.19.0',
        notes: 'English notes'
      }
    })
    act(() => root.render(<UpdateDialog />))

    expect(document.body.textContent).toContain('English notes')
    expect(document.body.textContent).toContain(
      'Les notes de version localisées ne sont pas disponibles'
    )
    await act(async () => i18next.changeLanguage('en'))
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

  it('explains the install wait and locks actions while applying', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'applying', current: '0.1.0', latest: '0.2.0', applyKind: 'restart' }
    })
    act(() => root.render(<UpdateDialog />))

    expect(document.body.textContent).toContain('Preparing update…')
    expect(document.body.textContent).toContain('update may take a moment')
    expect(document.body.textContent).toContain("please don't reopen the app")
    expect(
      Array.from(document.body.querySelectorAll('button')).every((button) => button.disabled)
    ).toBe(true)
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

  it('shows an installer-open error without replacing the ready retry action', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'ready',
        current: '0.1.0',
        latest: '0.2.0',
        applyKind: 'installer',
        localPath: '/data/update/Open-Science.dmg',
        error: 'Could not open the update installer: no associated application'
      }
    })
    act(() => root.render(<UpdateDialog />))

    expect(document.body.textContent).toContain(
      'Could not open the update installer: no associated application'
    )
    expect(document.body.textContent).toContain('Open installer')
    expect(document.body.textContent).not.toContain('Download update')
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

  it('guides background-process shutdown failures to diagnostics and GitHub issues', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'error',
        current: '0.17.0',
        latest: '0.18.0',
        error: 'Could not fully stop background processes before updating. Please try again.'
      }
    })

    act(() => root.render(<UpdateDialog />))

    expect(document.body.textContent).toContain(
      'use Reveal in Settings → General → Diagnostics to locate the log file'
    )
    expect(document.body.textContent).toContain('Quit and reopen Open Science')
    const issueLink = document.body.querySelector(`a[href="${APP.links.githubIssues}"]`)
    expect(issueLink?.textContent).toContain('open a GitHub issue')
  })

  it('localizes the active Agent Runtime installation blocker', async () => {
    await act(async () => i18next.changeLanguage('zh-Hans'))
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'error',
        current: '0.17.0',
        latest: '0.18.0',
        error:
          'An Agent Runtime is still installing. Wait for it to finish before restarting to update.'
      }
    })

    act(() => root.render(<UpdateDialog />))

    expect(document.body.textContent).toContain(
      '智能体运行时仍在安装。请等待安装完成后再重启更新。'
    )
    expect(document.body.textContent).not.toContain('An Agent Runtime is still installing')
    await act(async () => i18next.changeLanguage('en'))
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

  it('renders the download line without a percent when total is unknown', () => {
    // No downloadProgress yet and unknown total: the shared line shows bytes downloaded, no percent,
    // rather than a misleading fixed percentage against an unknown total.
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
    // Scope the percent check to the download line itself (the last .tabular-nums; the first is the
    // version subtitle). The download button label separately shows "Downloading 35%".
    const lines = document.body.querySelectorAll('.tabular-nums')
    const line = lines[lines.length - 1]
    expect(line?.textContent).toContain('downloaded')
    expect(line?.textContent).not.toContain('%')
  })

  it('mirrors the full download detail (speed) from downloadProgress while downloading', () => {
    // Once a progress broadcast arrives, the store carries the superset detail and the dialog shows
    // the speed line from the shared DownloadProgressLine.
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'downloading',
        current: '0.1.0',
        latest: '0.2.0',
        progress: 42,
        downloadedBytes: 4200,
        totalBytes: 10000,
        downloadProgress: {
          phase: 'downloading',
          transferred: 4200,
          total: 10000,
          percent: 42,
          bytesPerSecond: 2_411_724,
          attempt: 0
        }
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('2.3 MB/s')
    expect(document.body.textContent).toContain('42%')
  })
})
