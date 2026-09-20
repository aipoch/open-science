// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Streamdown } from 'streamdown'

import { installStreamdown } from './install-streamdown'

afterEach(cleanup)

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
