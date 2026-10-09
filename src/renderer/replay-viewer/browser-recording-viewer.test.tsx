// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  browserPayloadFixture,
  browserMomentFixture
} from '../src/pages/workspace/replay/BrowserRecording.test-support'
import { ViewerApp } from './ViewerApp'
import { ReplayViewerClient } from './client'

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('loads readonly browser footage and retains an exact selected moment without live calls', async () => {
  const payload = browserPayloadFixture()
  const fetcher = vi.fn<typeof fetch>(async (path, options) => {
    if (path === '/api/context')
      return json({
        mode: 'recorded',
        format: 'web-recording',
        viewerId: 'viewer',
        target: payload.receiving,
        expiresAt: 999999,
        canInteract: false,
        canCancel: false,
        canCapture: false,
        canRecord: false,
        canReadArtifacts: true
      })
    if (path === '/api/recording') return json(payload)
    if (path === '/api/recording/moment')
      return json(
        options?.method === 'POST'
          ? browserMomentFixture(JSON.parse(String(options.body)).offsetMs)
          : null
      )
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  render(<ViewerApp client={new ReplayViewerClient(fetcher)} />)
  await screen.findByLabelText('Recorded webpage')
  fireEvent.change(screen.getByRole('slider'), { target: { value: '3200' } })
  fireEvent.loadedMetadata(screen.getByLabelText('Recorded webpage'))
  fireEvent.loadedData(screen.getByLabelText('Recorded webpage'))
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this moment' }))
  const reference = (await screen.findByRole('textbox', {
    name: 'Recorded moment reference'
  })) as HTMLTextAreaElement
  expect(JSON.parse(reference.value)).toMatchObject({
    viewerId: 'viewer',
    offsetMs: 3200,
    segmentOffsetMs: 1200,
    receiving: payload.receiving,
    indexChecksum: payload.indexChecksum
  })
  expect(screen.queryByRole('button', { name: 'Record webpage' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open project interface' })).toBeNull()
  expect(
    fetcher.mock.calls
      .map(([path]) => String(path))
      .every((path) => ['/api/context', '/api/recording', '/api/recording/moment'].includes(path))
  ).toBe(true)
})
it('rejects substituted media versions and moments belonging to another receiving copy', async () => {
  const payload = browserPayloadFixture()
  const client = new ReplayViewerClient(
    vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ...browserMomentFixture(),
        receiving: { ...payload.receiving, versionId: 'other-index' }
      })
    )
  )
  await expect(client.selectBrowserMoment(payload, 1200)).rejects.toThrow()
  expect(
    client.browserRecordingMediaUrl(
      { ...payload, media: [{ ...payload.media[0], checksum: 'f'.repeat(64) }] },
      'media-0'
    )
  ).toBeNull()
  await act(async () => {})
})
