// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'
import { UpdateDialog } from './UpdateDialog'

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
})
