// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Streamdown } from 'streamdown'

import { installStreamdown } from './install-streamdown'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('closes a focused table dialog with Escape when reduced motion is enabled', async () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
  const uninstall = installStreamdown()
  try {
    const { container } = render(
      <div className="agent-markdown-root">
        <Streamdown mode="static">{'| Name | Value |\n| --- | --- |\n| alpha | 1 |'}</Streamdown>
      </div>
    )
    fireEvent.click(container.querySelector('button[title="View fullscreen"]')!)
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute('title')).toBe('Exit fullscreen')
    )
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await vi.waitFor(() =>
      expect(document.querySelector('[data-streamdown="table-fullscreen"]')).toBeNull()
    )
  } finally {
    uninstall()
  }
})

it('expands the clicked table inside a positioned conversation, not the first table', async () => {
  const uninstall = installStreamdown()
  try {
    const markdown =
      '| A | Value |\n| --- | --- |\n| alpha | 1 |\n\n| B | Value |\n| --- | --- |\n| beta | 2 |'
    const { container, rerender } = render(
      <div className="relative agent-markdown-root">
        <Streamdown mode="static">{markdown}</Streamdown>
      </div>
    )
    const inline = [...container.querySelectorAll('table')].map((table) => table.innerHTML)
    for (const index of [1, 0, 1]) {
      fireEvent.click(container.querySelectorAll('button[title="View fullscreen"]')[index])
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await vi.waitFor(() => {
        const table = document.querySelector('[data-streamdown="table-fullscreen"] table')!
        expect(table.textContent).toContain(index === 1 ? 'beta' : 'alpha')
        expect(table.textContent).not.toContain(index === 1 ? 'alpha' : 'beta')
      })
      expect([...container.querySelectorAll('table')].map((table) => table.innerHTML)).toEqual(
        inline
      )
      fireEvent.click(document.querySelector('button[title="Exit fullscreen"]')!)
      await vi.waitFor(() =>
        expect(document.querySelector('[data-streamdown="table-fullscreen"]')).toBeNull()
      )
    }
    rerender(
      <div className="relative agent-markdown-root">
        <Streamdown key="new-session" mode="static">
          {'| C | Value |\n| --- | --- |\n| gamma | 3 |'}
        </Streamdown>
      </div>
    )
    fireEvent.click(container.querySelector('button[title="View fullscreen"]')!)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-streamdown="table-fullscreen"] table')?.textContent
      ).toContain('gamma')
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    await vi.waitFor(() =>
      expect(document.querySelector('[data-streamdown="table-fullscreen"]')).toBeNull()
    )
  } finally {
    uninstall()
  }
})

it('owns a real Streamdown table click without opening its native menu or saving twice', async () => {
  const saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
  const previousApi = window.api
  ;(window as unknown as { api: unknown }).api = { saveBlobFile }
  const uninstall = installStreamdown()
  try {
    const { container } = render(
      <div className="agent-markdown-root">
        <Streamdown mode="static">{'| Name | Value |\n| --- | --- |\n| alpha | 1 |'}</Streamdown>
      </div>
    )
    const trigger = container.querySelector<HTMLButtonElement>('button[title="Download table"]')!
    fireEvent.mouseDown(trigger)
    // The installed Streamdown uses onClick, not onMouseDown, for this trigger.
    expect(container.querySelector('.relative > .absolute')).toBeNull()
    fireEvent.mouseUp(trigger)
    fireEvent.click(trigger)
    expect(container.querySelector('.relative > .absolute')).toBeNull()
    const csv = document.querySelector<HTMLButtonElement>('[data-sd-table-format-menu] button')!
    expect(csv.textContent).toBe('CSV')
    fireEvent.mouseDown(csv)
    fireEvent.mouseUp(csv)
    fireEvent.click(csv)
    await vi.waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    expect(document.querySelector('[data-sd-table-format-menu]')).toBeNull()
  } finally {
    uninstall()
    window.api = previousApi
  }
})
