// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ReplayViewerClient } from './client'
import { ObservationCaptureControls } from './ObservationCaptureControls'
import type { ObservationMediaCaptureResult } from '../../shared/run-observation-capture'
const result: ObservationMediaCaptureResult = {
  captureId: 'capture',
  recordingId: 'recording',
  stepKey: 'durable-step',
  artifactId: 'image',
  versionId: 'image-v1',
  checksum: 'a'.repeat(64),
  sizeBytes: 10,
  mimeType: 'image/png',
  publication: 'awaiting-publication',
  capture: {
    source: 'project-export',
    association: 'current-observation',
    startedAt: 2000,
    finishedAt: 3000,
    observedAt: 1000,
    width: 10,
    height: 10
  }
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('uses only declared exports and keeps one capture key across an uncertain retry and inspection', async () => {
  const client = new ReplayViewerClient()
  vi.spyOn(client, 'captureOptions').mockResolvedValue({
    hostView: false,
    projectExports: ['frame']
  })
  const capture = vi
    .spyOn(client, 'capture')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue(result)
  const view = render(<ObservationCaptureControls client={client} enabled hostViewOpen={false} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Save project image: frame' }))
  await screen.findByText('Could not confirm the saved image. Retry the same capture.')
  expect(screen.queryByRole('button', { name: 'Save project screenshot' })).toBeNull()
  const request = capture.mock.calls[0][0]
  expect(request).toMatchObject({
    source: 'project-export',
    exportKey: 'frame',
    idempotencyKey: expect.any(String)
  })
  view.rerender(<ObservationCaptureControls client={client} enabled={false} hostViewOpen={false} />)
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  view.rerender(<ObservationCaptureControls client={client} enabled hostViewOpen={false} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  fireEvent.click(await screen.findByText('This captured image is awaiting archive publication.'))
  await screen.findByText(
    'Image captured for recorded step durable-step; awaiting archive publication.'
  )
  expect(capture.mock.calls[1][0]).toEqual(request)
  expect(
    screen.getByText('Captured from 1970-01-01T00:00:02.000Z to 1970-01-01T00:00:03.000Z.')
  ).toBeTruthy()
  expect(screen.queryByText('Image published for recorded step durable-step.')).toBeNull()
})
it('does not offer capture without actual capabilities or before a host project view opens', async () => {
  const client = new ReplayViewerClient(),
    capture = vi.spyOn(client, 'capture')
  const options = vi
    .spyOn(client, 'captureOptions')
    .mockResolvedValue({ hostView: true, projectExports: [] })
  const view = render(
    <ObservationCaptureControls client={client} enabled={false} hostViewOpen={false} />
  )
  expect(options).not.toHaveBeenCalled()
  view.rerender(<ObservationCaptureControls client={client} enabled hostViewOpen={false} />)
  const button = await screen.findByRole('button', { name: 'Save project screenshot' })
  expect(button).toHaveProperty('disabled', true)
  fireEvent.click(button)
  expect(capture).not.toHaveBeenCalled()
  view.rerender(<ObservationCaptureControls client={client} enabled hostViewOpen />)
  await waitFor(() => expect(button).toHaveProperty('disabled', false))
})
it('refreshes host capture capability when the project interface opens without changing follow mode', async () => {
  const client = new ReplayViewerClient()
  const options = vi
    .spyOn(client, 'captureOptions')
    .mockResolvedValueOnce({ hostView: false, projectExports: [] })
    .mockResolvedValueOnce({ hostView: true, projectExports: [] })
    .mockResolvedValue({ hostView: false, projectExports: [] })
  const capture = vi.spyOn(client, 'capture').mockResolvedValue({
    ...result,
    capture: { ...result.capture, source: 'host-view' }
  })
  const view = render(<ObservationCaptureControls client={client} enabled hostViewOpen={false} />)
  await waitFor(() => expect(options).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('button', { name: 'Save project screenshot' })).toBeNull()

  view.rerender(<ObservationCaptureControls client={client} enabled hostViewOpen />)
  const button = await screen.findByRole('button', { name: 'Save project screenshot' })
  expect(options).toHaveBeenCalledTimes(2)
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
  expect(capture.mock.calls[0][0]).toMatchObject({ source: 'host-view' })

  view.rerender(<ObservationCaptureControls client={client} enabled hostViewOpen={false} />)
  await waitFor(() => {
    expect(options).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('button', { name: 'Save project screenshot' })).toBeNull()
  })
})
