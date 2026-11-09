import { describe, expect, it, vi } from 'vitest'
import {
  cancelHuggingFaceJob,
  inspectHuggingFaceJob,
  readHuggingFaceJobLogs
} from './hugging-face-job-control'

const request = { namespace: 'lab', jobId: 'job-1', token: 'fake-token' }
const endpoint = 'https://huggingface.co/api/jobs/lab/job-1'
const status = (stage: string, message?: string): Response =>
  Response.json({ id: request.jobId, status: { stage, message } })
const headers = { 'Content-Type': 'text/event-stream; charset=utf-8' }
const collect = async (logs: AsyncIterable<string>): Promise<string[]> => {
  const lines = []
  for await (const log of logs) lines.push(log)
  return lines
}

describe('Hugging Face job control', () => {
  it.each([204, 200])(
    'acknowledges an empty %i cancellation, then inspects the actual state',
    async (code) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(null, { status: code }))
        .mockResolvedValueOnce(status('RUNNING'))
        .mockResolvedValueOnce(status('CANCELED'))
      expect(await cancelHuggingFaceJob({ ...request, fetch })).toBe('requested')
      expect(await inspectHuggingFaceJob({ ...request, fetch })).toMatchObject({ phase: 'running' })
      expect(await inspectHuggingFaceJob({ ...request, fetch })).toMatchObject({
        phase: 'cancelled',
        exitCode: null
      })
      expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
        [endpoint + '/cancel', 'POST'],
        [endpoint, 'GET'],
        [endpoint, 'GET']
      ])
      for (const [, init] of fetch.mock.calls) {
        expect(init?.redirect).toBe('error')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-token')
      }
    }
  )
  it.each([
    ['SCHEDULING', 'queued', null],
    ['COMPLETED', 'succeeded', 0],
    ['ERROR', 'failed', 7],
    ['DELETED', 'unreconciled', null],
    ['NEW_STAGE', 'unreconciled', null]
  ] as const)('preserves the provider stage %s', async (stage, phase, exitCode) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(status(stage, 'Job failed with exit code: 7. Reason: OOM'))
    expect(await inspectHuggingFaceJob({ ...request, fetch })).toMatchObject({
      stage,
      phase,
      exitCode
    })
  })
  it('rejects unsafe handles, pre-abort, wrong response identity, and non-2xx without leaking body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 'wrong', status: { stage: 'COMPLETED' } }))
      .mockResolvedValueOnce(new Response('confidential', { status: 403 }))
    await expect(cancelHuggingFaceJob({ ...request, jobId: '../other', fetch })).rejects.toThrow(
      'required'
    )
    await expect(
      inspectHuggingFaceJob({ ...request, signal: AbortSignal.abort(), fetch })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(inspectHuggingFaceJob({ ...request, fetch })).rejects.toThrow('Invalid')
    await expect(cancelHuggingFaceJob({ ...request, fetch })).rejects.toThrow(
      'Hugging Face job cancel failed (HTTP 403).'
    )
  })
  it('decodes split UTF-8, CRLF, multi-line SSE and replayed history', async () => {
    const wire =
      ':keepalive\r\n\r\ndata: {"data":"===== Job started x"}\r\n\r\ndata: {"data":"old"}\n\ndata: {\rdata: "data":"新🧪"}\r\rdata: {"data":""}\n\ndata: {"data":"incomplete"}\n'
    const bytes = new TextEncoder().encode(wire)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(Uint8Array.of(b))
        controller.close()
      }
    })
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(stream, { headers }))
    expect(await collect(readHuggingFaceJobLogs({ ...request, fetch, skip: 1 }))).toEqual([
      '新🧪',
      ''
    ])
    expect(String(fetch.mock.calls[0][0])).toBe(endpoint + '/logs')
    expect(fetch.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      method: 'GET',
      signal: expect.any(AbortSignal)
    })
  })
  it('stops before delivering another buffered log when the caller aborts', async () => {
    const controller = new AbortController()
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('data: {"data":"one"}\n\ndata: {"data":"two"}\n\n', { headers })
      )
    const logs = readHuggingFaceJobLogs({ ...request, fetch, signal: controller.signal })
    expect((await logs.next()).value).toBe('one')
    controller.abort()
    await expect(logs.next()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels the response body when the consumer stops or the frame exceeds its budget', async () => {
    for (const oversized of [false, true]) {
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(oversized ? 'x'.repeat(300_000) : 'data: {"data":"ok"}\n\n')
          )
        },
        cancel
      })
      const fetch = vi.fn().mockResolvedValue(new Response(stream, { headers }))
      const logs = readHuggingFaceJobLogs({ ...request, fetch })
      if (oversized) await expect(logs.next()).rejects.toThrow('size limit')
      else {
        expect((await logs.next()).value).toBe('ok')
        await logs.return(undefined)
      }
      expect(cancel).toHaveBeenCalledOnce()
    }
  })
})
