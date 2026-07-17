// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'

describe('ManagedFileDownloadButton', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const renderButton = async (): Promise<HTMLButtonElement> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ManagedFileDownloadButton
          source="artifact"
          path="/managed/report.csv"
          suggestedName="report.csv"
        />
      )
    })

    return container.querySelector('button')!
  }

  it('disables duplicate saves while the first request is pending', async () => {
    let resolveSave: ((result: { saved: boolean }) => void) | undefined
    const saveManagedFile = vi.fn(
      () =>
        new Promise<{ saved: boolean }>((resolve) => {
          resolveSave = resolve
        })
    )
    window.api = { saveManagedFile } as unknown as Window['api']
    const button = await renderButton()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(saveManagedFile).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('Saving report.csv')

    await act(async () => resolveSave?.({ saved: false }))
  })

  it('uses the same container hover background as the close button', async () => {
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: false })
    } as unknown as Window['api']

    const button = await renderButton()
    const classNames = button.className.split(/\s+/)

    expect(classNames).toContain('hover:bg-muted')
    expect(classNames).not.toContain('hover:bg-bg-000')
  })

  it('does not carry an in-flight result to a different file', async () => {
    let resolveSave: ((result: { saved: boolean }) => void) | undefined
    const saveManagedFile = vi.fn(
      () =>
        new Promise<{ saved: boolean }>((resolve) => {
          resolveSave = resolve
        })
    )
    window.api = { saveManagedFile } as unknown as Window['api']
    const button = await renderButton()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    await act(async () => {
      root.render(
        <ManagedFileDownloadButton
          source="upload"
          path="/managed/notes.txt"
          suggestedName="notes.txt"
        />
      )
    })

    const notesButton = container.querySelector<HTMLButtonElement>('button')!
    expect(notesButton.disabled).toBe(false)
    expect(notesButton.getAttribute('aria-label')).toBe('Download notes.txt')

    await act(async () => resolveSave?.({ saved: true }))

    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Download notes.txt')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('')
  })

  it('resets the state when switching away and back to the same file', async () => {
    vi.useFakeTimers()
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true })
    } as unknown as Window['api']
    const button = await renderButton()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(button.getAttribute('aria-label')).toBe('Saved report.csv')

    await act(async () => {
      root.render(
        <ManagedFileDownloadButton
          source="upload"
          path="/managed/notes.txt"
          suggestedName="notes.txt"
        />
      )
      await Promise.resolve()
    })
    await act(async () => {
      root.render(
        <ManagedFileDownloadButton
          source="artifact"
          path="/managed/report.csv"
          suggestedName="report.csv"
        />
      )
    })

    const reportButton = container.querySelector<HTMLButtonElement>('button')!
    expect(reportButton.disabled).toBe(false)
    expect(reportButton.getAttribute('aria-label')).toBe('Download report.csv')
  })

  it('keeps unavailable and saving states discoverable through the tooltip trigger', async () => {
    window.api = {
      saveManagedFile: vi.fn(() => new Promise<{ saved: boolean }>(() => undefined))
    } as unknown as Window['api']
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ManagedFileDownloadButton
          source="artifact"
          path="/managed/missing.csv"
          suggestedName="missing.csv"
          disabled
        />
      )
    })

    const unavailableButton = container.querySelector('button')
    expect(unavailableButton?.closest('[data-testid="download-tooltip-trigger"]')).not.toBeNull()
    expect(
      unavailableButton
        ?.closest('[data-testid="download-tooltip-trigger"]')
        ?.getAttribute('tabindex')
    ).toBe('0')

    await act(async () => {
      root.render(
        <ManagedFileDownloadButton
          source="artifact"
          path="/managed/report.csv"
          suggestedName="report.csv"
        />
      )
    })
    const downloadButton = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      downloadButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(
      container
        .querySelector('button')
        ?.closest('[data-testid="download-tooltip-trigger"]')
        ?.getAttribute('tabindex')
    ).toBe('0')
  })

  it('announces a successful save before restoring the download action', async () => {
    vi.useFakeTimers()
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true })
    } as unknown as Window['api']
    const button = await renderButton()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(button.getAttribute('aria-label')).toBe('Saved report.csv')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Saved report.csv')
    expect(button.className).toContain('text-emerald-600')
    expect(button.className).toContain('hover:bg-muted')

    await act(async () => vi.advanceTimersByTime(1600))
    expect(button.getAttribute('aria-label')).toBe('Download report.csv')
  })

  it('keeps a failed save visible and allows retrying', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const saveManagedFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ saved: false })
    window.api = { saveManagedFile } as unknown as Window['api']
    const button = await renderButton()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(button.getAttribute('aria-label')).toBe('Download failed for report.csv')

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(saveManagedFile).toHaveBeenCalledTimes(2)
    expect(button.getAttribute('aria-label')).toBe('Download report.csv')
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to download managed file: report.csv',
      expect.any(Error)
    )
  })
})
