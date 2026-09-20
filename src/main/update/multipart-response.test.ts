import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { expect, it, vi } from 'vitest'

// Exercise the installed dependency, including our patch-package fix. The strategy's FakeUpdater
// cannot reproduce an error emitted by Electron's response stream outside downloadUpdate's promise.
const require = createRequire(import.meta.url)
const {
  executeTasksUsingMultipleRangeRequests
} = require('electron-updater/out/differentialDownloader/multipleRangeDownloader')

it('rejects a multipart download when its response resets instead of throwing a main-process exception', async () => {
  const response = Object.assign(new PassThrough(), {
    statusCode: 206,
    headers: { 'content-type': 'multipart/byteranges; boundary=regression' }
  })
  const output = new PassThrough()
  const request = Object.assign(new EventEmitter(), { end: vi.fn() })
  let rejectDownload!: (error: Error) => void
  const download = new Promise<void>((_resolve, reject) => {
    rejectDownload = reject
  })
  const error = new Error('net::ERR_CONNECTION_RESET')
  // Attach the assertion before delivering the asynchronous transport event.
  const rejected = expect(download).rejects.toBe(error)
  const downloader = {
    createRequestOptions: () => ({ headers: {} }),
    httpExecutor: {
      createRequest: (_options: unknown, onResponse: (value: typeof response) => void) => {
        request.end.mockImplementation(() => onResponse(response))
        return request
      },
      addErrorAndTimeoutHandlers: (req: typeof request, reject: (error: Error) => void) =>
        req.on('error', reject)
    },
    options: {}
  }

  try {
    executeTasksUsingMultipleRangeRequests(
      downloader,
      [
        { kind: 1, start: 0, end: 4 },
        { kind: 1, start: 8, end: 12 }
      ],
      output,
      -1,
      rejectDownload
    )(0)
    // This event arrives after the response callback, just as SimpleURLLoaderWrapper emits it.
    // Without the patch it throws this exact error and leaves the download promise pending.
    expect(() => response.emit('error', error)).not.toThrow()
    await rejected
  } finally {
    // Settle the assertion even on the red run, without letting a hung promise mask the real failure.
    rejectDownload(error)
    await rejected
    response.destroy()
    output.destroy()
  }
})
