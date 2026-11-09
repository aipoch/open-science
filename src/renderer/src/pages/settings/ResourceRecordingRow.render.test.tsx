// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import type { ResourceRecordingState } from '../../../../shared/resource-recording'
import { ResourceRecordingRow } from './ResourceRecordingRow'

let root: Root
let container: HTMLDivElement
let listener: (state: ResourceRecordingState) => void
let api: NonNullable<typeof window.api.resourceRecording>
beforeEach(async () => {
  await i18next.changeLanguage('en')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  api = {
    getState: vi.fn(async () => 'off' as const),
    start: vi.fn(async () => 'recording' as const),
    stop: vi.fn(async () => 'off' as const),
    onChanged: vi.fn((fn) => {
      listener = fn
      return vi.fn()
    })
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { resourceRecording: api } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('requires explicit confirmation, shows event-driven pauses, and stops without enabling export consent', async () => {
  await act(async () => root.render(<ResourceRecordingRow />))
  expect(api.start).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Not recording')
  await act(async () =>
    fireEvent.click(within(container).getByRole('button', { name: 'Start recording…' }))
  )
  const dialog = within(document.body).getByRole('alertdialog')
  expect(dialog.textContent).toContain('64 MiB')
  expect(dialog.textContent).toContain('stops on restart')
  expect(api.start).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })))
  expect(api.start).not.toHaveBeenCalled()
  await act(async () =>
    fireEvent.click(within(container).getByRole('button', { name: 'Start recording…' }))
  )
  await act(async () =>
    fireEvent.click(within(document.body).getByRole('button', { name: 'Start recording' }))
  )
  expect(api.start).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Recording')
  await act(async () => listener('idle'))
  expect(container.textContent).toContain('Paused')
  await act(async () => listener('suspended'))
  expect(container.textContent).toContain('Paused')
  await act(async () =>
    fireEvent.click(within(container).getByRole('button', { name: 'Stop recording' }))
  )
  expect(api.stop).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Not recording')
  expect(api.getState).toHaveBeenCalledOnce()
})

it('does not overwrite a newer event with a late initial status response', async () => {
  const pending = Promise.withResolvers<ResourceRecordingState>()
  vi.mocked(api.getState).mockReturnValue(pending.promise)
  await act(async () => root.render(<ResourceRecordingRow />))
  await act(async () => listener('recording'))
  await act(async () => pending.resolve('off'))
  expect(container.textContent).toContain('Recording')
})

it('shows errors and permits a status retry without starting a recording', async () => {
  vi.mocked(api.getState).mockRejectedValueOnce(new Error('private path'))
  await act(async () => root.render(<ResourceRecordingRow />))
  expect(container.textContent).toContain('Could not update resource recording.')
  expect(container.textContent).not.toContain('private path')
  await act(async () => fireEvent.click(within(container).getByRole('button', { name: 'Retry' })))
  expect(container.textContent).toContain('Not recording')
  expect(api.start).not.toHaveBeenCalled()
})
