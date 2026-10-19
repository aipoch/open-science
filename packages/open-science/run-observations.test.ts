import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OpenScienceClient } from './index.mjs'
import { CliUsageError, parseCliArgs, runCli, runTaskCommand } from './cli.mjs'

const methods = [
  'open',
  'snapshot',
  'history',
  'changes',
  'select',
  'selection',
  'revoke',
  'openRecorded',
  'readRecorded',
  'readProjectRecording',
  'selectRecordedFile',
  'selectRecordingFile',
  'recordingFileSelection',
  'recording',
  'selectRecording',
  'recordingSelection',
  'recordingStatus',
  'captureOptions',
  'capture',
  'captures',
  'captureContent'
] as const
const commandFor = (method: string): string =>
  ({
    openRecorded: 'open-recorded',
    readRecorded: 'read-recorded',
    readProjectRecording: 'read-project-recording',
    selectRecordedFile: 'select-recorded-file',
    selectRecordingFile: 'select-recording-file',
    recordingFileSelection: 'recording-file-selection',
    selectRecording: 'select-recording',
    recordingSelection: 'recording-selection',
    recordingStatus: 'recording-status',
    captureOptions: 'capture-options',
    captureContent: 'capture-content'
  })[method] ?? method
const recordedTarget = { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
const target = { projectId: 'project-a', sessionId: 'session-a', operationId: 'operation-a' }
const viewerId = '28f4a82c-b54e-4da0-81a9-b2e30d188924'
const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

describe('run observation SDK', () => {
  it('dispatches only authenticated observation POSTs and preserves permissions, exact cursors and null selection', async () => {
    const fetch = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(async () =>
      jsonResponse(null)
    )
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'sdk-token',
      fetch
    })
    expect(Object.keys(client.observations)).toEqual(methods)
    expect(Object.isFrozen(client.observations)).toBe(true)
    const inputs = {
      open: { target, allowInteraction: false, allowCancel: true },
      snapshot: { viewerId },
      history: { viewerId },
      changes: { viewerId, cursor: { epoch: 'viewer-epoch', sequence: 4 } },
      select: { viewerId, cursor: { epoch: 'viewer-epoch', sequence: 4 }, stepId: 'run:run-a' },
      selection: { viewerId },
      revoke: { viewerId },
      openRecorded: { target: recordedTarget },
      readRecorded: { target: recordedTarget },
      readProjectRecording: { target: recordedTarget },
      selectRecordedFile: { target: recordedTarget, mediaKey: 'file', format: 'project-recording' },
      selectRecordingFile: { viewerId, mediaKey: 'file' },
      recordingFileSelection: { viewerId },
      recording: { viewerId },
      selectRecording: { viewerId, stepKey: 'observation-0' },
      recordingSelection: { viewerId },
      recordingStatus: { target },
      captureOptions: { viewerId },
      captures: { viewerId },
      captureContent: { viewerId, captureId: 'capture-1', offset: 0, length: 1048576 },
      capture: {
        viewerId,
        request: { source: 'project-export', exportKey: 'frame.png', idempotencyKey: 'capture-1' }
      }
    }
    for (const method of methods) {
      await expect(client.observations[method](inputs[method])).resolves.toBeNull()
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(
      methods.map((method) => `http://127.0.0.1:44100/api/v1/observations/${method}`)
    )
    for (const [index, [, options]] of fetch.mock.calls.entries()) {
      expect(options).toMatchObject({
        method: 'POST',
        headers: { authorization: 'Bearer sdk-token' },
        body: JSON.stringify(inputs[methods[index]])
      })
    }
  })

  it('rejects extra open authority, arbitrary targets and ambiguous permission values before dispatch', () => {
    const fetch = vi.fn()
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'sdk-token',
      fetch
    })
    for (const input of [
      null,
      [],
      {},
      { target: {} },
      { target: { projectId: 'p', sessionId: 's' } },
      { target, command: 'node experiment.mjs' },
      { target, capability: 'untrusted' },
      { target, allowInteraction: 'true' },
      { target, allowCancel: 1 },
      { target: { ...target, url: 'http://localhost:1234' } },
      { target: { ...target, runId: '/private/path' } }
    ])
      expect(() => client.observations.open(input)).toThrow('Observation open requires')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns the local viewer URL without opening a browser or creating work', async () => {
    const view = {
      viewerId,
      target,
      expiresAt: 123456,
      url: 'http://127.0.0.1:40001/#grant=ephemeral'
    }
    const fetch = vi.fn(async () => jsonResponse(view))
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'sdk-token',
      fetch
    })
    await expect(client.observations.open({ target })).resolves.toEqual(view)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:44100/api/v1/observations/open')
  })

  it('rejects arbitrary capture destinations and unbounded or non-integer chunks before dispatch', () => {
    const fetch = vi.fn()
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'sdk-token',
      fetch
    })
    const request = { viewerId, captureId: 'capture-1' }
    for (const extra of [
      { path: '/private/frame.png' },
      { url: 'http://localhost/frame' },
      { target },
      { offset: -1 },
      { offset: 0.5 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { length: 0 },
      { length: 1048577 },
      { length: 1.1 },
      { length: '1' },
      { captureId: '../frame.png' },
      { viewerId: 'not-a-viewer' }
    ])
      expect(() => client.observations.captureContent({ ...request, ...extra })).toThrow(
        'Capture reads require'
      )
    for (const input of [null, {}, { viewerId, captureId: 'capture-1' }, { viewerId, target }])
      expect(() => client.observations.captures(input)).toThrow('Capture reads require')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns captured image chunks without creating a capture or following a resource URL', async () => {
    const chunk = {
      captureId: 'capture-1',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: 6,
      offset: 0,
      dataBase64: 'YWJj',
      nextOffset: 3
    }
    const fetch = vi.fn(async () => jsonResponse(chunk))
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'sdk-token',
      fetch
    })
    await expect(
      client.observations.captureContent({ viewerId, captureId: 'capture-1', length: 3 })
    ).resolves.toEqual(chunk)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:44100/api/v1/observations/captureContent')
  })

  it('does not cancel or revoke on aborted observation waits and forwards the project interface declaration', async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: 'running' }))
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'sdk-token',
      fetch
    })
    await expect(
      client.observations.snapshot(
        { viewerId },
        { signal: AbortSignal.abort(new Error('stop reading')) }
      )
    ).rejects.toThrow('stop reading')
    expect(fetch).not.toHaveBeenCalled()
    const input = {
      projectId: 'p',
      sessionId: 's',
      environmentId: 'environment',
      requestId: 'request',
      command: 'node server.mjs',
      localServicePort: 8080,
      projectView: {
        title: 'Controls',
        entryPath: '/controls',
        allowedRequestHeaders: ['x-project-csrf'],
        webSocketProtocols: ['events'],
        adaptFrameAncestors: true
      }
    }
    await client.execution.execute(input)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]).toMatchObject([
      'http://127.0.0.1:44100/api/v1/execution/execute',
      { body: JSON.stringify(input) }
    ])
  })
})

describe('run observation CLI', () => {
  it.each(methods)(
    'routes observations %s without starting, waiting for or cancelling execution',
    async (method) => {
      const call = vi
        .fn()
        .mockResolvedValue(
          method === 'open' ? { viewerId, target, url: 'http://local-viewer' } : null
        )
      const execute = vi.fn()
      const cancelOperation = vi.fn()
      const openBrowser = vi.fn()
      const input = method === 'open' ? { target } : { viewerId }
      const log = vi.fn()
      await runTaskCommand(
        parseCliArgs([
          'observations',
          commandFor(method),
          '--input-json',
          JSON.stringify(input),
          '--json'
        ]),
        {
          connect: async () => ({
            observations: { [method]: call },
            execution: { execute, cancelOperation }
          }),
          openBrowser,
          log
        }
      )
      expect(call).toHaveBeenCalledExactlyOnceWith(input)
      expect(execute).not.toHaveBeenCalled()
      expect(cancelOperation).not.toHaveBeenCalled()
      expect(openBrowser).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledTimes(1)
    }
  )

  it('reads exact viewer selection requests from a file and stdin with a request-only timeout', async () => {
    const selection = vi.fn().mockResolvedValue({ snapshot: { stepId: 'run:a' } })
    const readRequest = vi.fn().mockResolvedValue(JSON.stringify({ viewerId }))
    await runTaskCommand(
      parseCliArgs([
        'observations',
        'selection',
        '--input-file',
        'viewer.json',
        '--timeout-ms',
        '500',
        '--json'
      ]),
      {
        connect: async () => ({ observations: { selection } }),
        readFile: readRequest,
        log: vi.fn()
      }
    )
    expect(readRequest).toHaveBeenCalledExactlyOnceWith(resolve('viewer.json'))
    expect(selection).toHaveBeenCalledExactlyOnceWith({ viewerId }, { timeoutMs: 500 })
    const select = vi.fn().mockResolvedValue(null)
    const input = { viewerId, cursor: { epoch: 'epoch', sequence: 3 }, stepId: 'run:a' }
    await runTaskCommand(parseCliArgs(['observations', 'select', '--json']), {
      connect: async () => ({ observations: { select } }),
      readStdin: async () => JSON.stringify(input),
      stdinIsTTY: false,
      log: vi.fn()
    })
    expect(select).toHaveBeenCalledExactlyOnceWith(input)
  })

  it('prints observation help without connecting and rejects malformed inputs before dispatch', async () => {
    const connect = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await runCli(['observations', '--help'], { connect })
      expect(connect).not.toHaveBeenCalled()
      expect(log.mock.calls.flat().join('\n')).toContain('observations open | snapshot | history')
    } finally {
      log.mockRestore()
    }
    const snapshot = vi.fn()
    for (const source of ['not-json', '[]', 'null', '7']) {
      await expect(
        runTaskCommand(parseCliArgs(['observations', 'snapshot', '--input-json', source]), {
          connect: async () => ({ observations: { snapshot } })
        })
      ).rejects.toBeInstanceOf(CliUsageError)
    }
    await expect(
      runTaskCommand(parseCliArgs(['observations', 'snapshot']), {
        connect: async () => ({ observations: { snapshot } }),
        stdinIsTTY: true
      })
    ).rejects.toBeInstanceOf(CliUsageError)
    expect(snapshot).not.toHaveBeenCalled()
  })

  it.each([
    ['observations', 'unknown'],
    ['observations', 'open', 'extra'],
    ['observations', 'snapshot', '--wait'],
    ['observations', 'snapshot', '--timeout-ms', '5', '--cancel-on-timeout'],
    ['observations', 'open', '--input-json', '{}', '--input-file', 'input.json'],
    ['observations', 'open', '--idempotency-key', 'request']
  ])('rejects incompatible observation flags %j', (...args) => {
    expect(() => parseCliArgs(args)).toThrow(CliUsageError)
  })
})

it('documents observation-only entrypoints, the selected evidence cutoff and all CLI commands', async () => {
  const [readme, cli] = await Promise.all([
    readFile(resolve('packages/open-science/README.md'), 'utf8'),
    readFile(resolve('packages/open-science/CLI.md'), 'utf8')
  ])
  expect(readme).toContain('Opening a viewer does not')
  expect(readme).toContain("coverage: 'process-local'")
  expect(readme).toContain('client.observations.selection')
  expect(readme).toContain('projectView:')
  expect(cli).toContain('without cancelling the Run')
  for (const method of methods)
    expect(cli).toContain(`open-science observations ${commandFor(method)} `)
  const openLine = cli
    .split('\n')
    .find((line) => line.startsWith('open-science observations open '))!
  const documentedInput = JSON.parse(openLine.split("'")[1])
  const fetch = vi.fn(async () => jsonResponse({ viewerId }))
  const client = new OpenScienceClient({
    baseUrl: 'http://127.0.0.1:44100',
    token: 'sdk-token',
    fetch
  })
  await client.observations.open(documentedInput)
  expect(fetch).toHaveBeenCalledOnce()
})

it('rejects recorded viewers that request live authority or lack receiving Version identity', () => {
  const fetch = vi.fn()
  const client = new OpenScienceClient({
    baseUrl: 'http://127.0.0.1:44100',
    token: 'sdk-token',
    fetch
  })
  for (const input of [
    { target: recordedTarget, allowInteraction: true },
    { target: recordedTarget, format: 'live' },
    { target },
    { target: { ...recordedTarget, runId: 'author-run' } },
    { target: { ...recordedTarget, versionId: '../v' } }
  ])
    expect(() => client.observations.openRecorded(input)).toThrow('receiving Artifact Version')
  expect(fetch).not.toHaveBeenCalled()
})

it('opens a fixed independent project recording format without live execution permissions', async () => {
  const fetch = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(async () =>
    jsonResponse({ viewerId, format: 'project-recording' })
  )
  const client = new OpenScienceClient({
    baseUrl: 'http://127.0.0.1:44100',
    token: 'sdk-token',
    fetch
  })
  const request = { target: recordedTarget, format: 'project-recording' }
  await client.observations.openRecorded(request)
  expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify(request))
})
