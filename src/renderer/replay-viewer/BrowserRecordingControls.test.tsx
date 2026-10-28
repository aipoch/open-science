// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserRecordingStatus } from '../../shared/browser-recording'
import { ReplayViewerClient } from './client'
import { BrowserRecordingControls } from './BrowserRecordingControls'

const status = (state: BrowserRecordingStatus['state'] = 'idle'): BrowserRecordingStatus => ({
  state,
  recordingId: state === 'idle' ? undefined : 'recording',
  elapsedMs: 1200,
  segments: 0,
  bytes: 0,
  droppedFrames: 0
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const clientForTest = (): ReplayViewerClient => {
  const client = new ReplayViewerClient()
  vi.spyOn(client, 'inspectBrowserRecording').mockResolvedValue({ supported: true })
  vi.spyOn(client, 'browserRecordingStatus').mockResolvedValue(status())
  return client
}
it('does not start a recording until an explicit click, and stops capture independently', async () => {
  const client = clientForTest()
  const control = vi
    .spyOn(client, 'controlBrowserRecording')
    .mockResolvedValueOnce(status('recording'))
    .mockResolvedValueOnce(status('paused'))
    .mockResolvedValueOnce(status('finalized'))
  const cancel = vi.spyOn(client, 'cancel')
  render(<BrowserRecordingControls client={client} enabled hostViewOpen />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Record webpage' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  expect(control).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Record webpage' }))
  await screen.findByRole('button', { name: 'Pause recording' })
  fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }))
  await screen.findByRole('button', { name: 'Resume recording' })
  fireEvent.click(screen.getByRole('button', { name: 'Stop and save recording' }))
  await screen.findByText(/Web recording saved/)
  expect(control.mock.calls.map(([method]) => method)).toEqual(['start', 'pause', 'stop'])
  expect(control.mock.calls[2][1].recordingId).toBe('recording')
  expect(cancel).not.toHaveBeenCalled()
})
it('reuses an uncertain request identity instead of duplicating recording on retry', async () => {
  const client = clientForTest()
  const control = vi
    .spyOn(client, 'controlBrowserRecording')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(status('recording'))
  render(<BrowserRecordingControls client={client} enabled hostViewOpen />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Record webpage' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Record webpage' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: 'Pause recording' })
  expect(control.mock.calls[0]).toEqual(control.mock.calls[1])
})
it('restores an active recording on remount and does not silently stop it on unmount', async () => {
  const client = clientForTest()
  vi.mocked(client.inspectBrowserRecording).mockResolvedValue({
    supported: true,
    active: status('recording')
  })
  const control = vi.spyOn(client, 'controlBrowserRecording')
  const { unmount } = render(<BrowserRecordingControls client={client} enabled hostViewOpen />)
  await screen.findByRole('button', { name: 'Stop and save recording' })
  unmount()
  await act(async () => {})
  expect(control).not.toHaveBeenCalled()
})
it('offers archived playback only after a receiving Artifact Version has been published', async () => {
  const client = clientForTest()
  const saved = {
    ...status('finalized'),
    target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
  }
  vi.mocked(client.inspectBrowserRecording).mockResolvedValue({ supported: false, active: saved })
  const open = vi.fn()
  render(
    <BrowserRecordingControls
      client={client}
      enabled={false}
      hostViewOpen={false}
      playbackReady
      onOpen={open}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'View recording' }))
  expect(open).toHaveBeenCalledWith(saved)
})
it('keeps published partial footage available and permits a new recording', async () => {
  const client = clientForTest()
  const saved = {
    ...status('partial'),
    target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
  }
  vi.mocked(client.inspectBrowserRecording).mockResolvedValue({ supported: true, active: saved })
  render(<BrowserRecordingControls client={client} enabled hostViewOpen />)
  await screen.findByText(
    'Recording ended early. Saved footage remains available. You can start a new recording.'
  )
  expect(screen.getByRole('button', { name: 'Record webpage' }).hasAttribute('disabled')).toBe(
    false
  )
})

it('keeps saved footage unavailable until execution publication settles, without stopping the run', async () => {
  const client = clientForTest()
  const saved = {
    ...status('finalized'),
    target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
  }
  vi.mocked(client.inspectBrowserRecording).mockResolvedValue({ supported: true, active: saved })
  const open = vi.fn()
  const cancel = vi.spyOn(client, 'cancel')
  const { rerender } = render(
    <BrowserRecordingControls
      client={client}
      enabled
      hostViewOpen
      playbackReady={false}
      onOpen={open}
    />
  )
  await screen.findByText('Recording saved. Playback will be available when this run finishes.')
  const button = screen.getByRole('button', { name: 'View recording' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(open).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  rerender(
    <BrowserRecordingControls
      client={client}
      enabled={false}
      hostViewOpen={false}
      playbackReady
      onOpen={open}
    />
  )
  expect(
    screen.queryByText('Recording saved. Playback will be available when this run finishes.')
  ).toBeNull()
  expect(button.hasAttribute('disabled')).toBe(false)
  fireEvent.click(button)
  expect(open).toHaveBeenCalledWith(saved)
})
