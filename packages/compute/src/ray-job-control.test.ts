import { describe, expect, it, vi } from 'vitest'
import { inspectRayJob, readRayJobLogs, stopRayJob, submitRayJob } from './ray-job-control'

const claim = {
  submissionId: 'test-attempt-1',
  entrypoint: 'python worker.py',
  workingDir: 'gcs://_ray_pkg_' + 'a'.repeat(64) + '.zip',
  metadata: { attempt: 'test-attempt-1' },
  cpus: 1,
  gpus: 0
}
const record = {
  type: 'SUBMISSION',
  submission_id: claim.submissionId,
  entrypoint: claim.entrypoint,
  runtime_env: { working_dir: claim.workingDir },
  metadata: { ...claim.metadata, open_science_entrypoint_resources: '[1,0]' },
  status: 'RUNNING',
  driver_exit_code: null
}
function target(...responses: (Response | Error)[]): {
  endpoint: string
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
} {
  return {
    endpoint: 'http://127.0.0.1:8265',
    fetch: vi.fn<typeof fetch>(async () => {
      const response = responses.shift()
      if (!response || response instanceof Error) throw response ?? new Error('Extra request')
      return response
    })
  }
}

describe('Ray job control', () => {
  it('distinguishes an explicitly rejected creation from a lost reply', async () => {
    const server = target(new Response(null, { status: 422 }), new Response(null, { status: 404 }))
    await expect(submitRayJob(server, claim)).rejects.toMatchObject({ name: 'Error', status: 422 })
    expect(server.fetch).toHaveBeenCalledTimes(2)
  })

  it('reconciles a lost create response with one GET and no second POST', async () => {
    const server = target(new TypeError('connection lost'), Response.json(record))
    const signal = new AbortController().signal
    await expect(submitRayJob(server, claim, signal)).resolves.toEqual({
      status: 'RUNNING',
      exitCode: null
    })
    expect(
      server.fetch.mock.calls.map(([url, init]) => [
        new URL(String(url)).pathname,
        init?.method ?? 'GET',
        init?.redirect,
        init?.signal
      ])
    ).toEqual([
      ['/api/jobs/', 'POST', 'error', expect.any(AbortSignal)],
      ['/api/jobs/test-attempt-1', 'GET', 'error', expect.any(AbortSignal)]
    ])
  })

  it('binds entrypoint resources to a reserved claim on Ray versions that omit them', async () => {
    const server = target(
      Response.json({ submission_id: claim.submissionId }),
      Response.json(record)
    )
    await submitRayJob(server, claim)
    const [, init] = server.fetch.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      metadata: record.metadata,
      entrypoint_num_cpus: 1,
      entrypoint_num_gpus: 0
    })
    await expect(inspectRayJob(server, { ...claim, metadata: record.metadata })).rejects.toThrow(
      'Invalid Ray job declaration'
    )
  })

  it('leaves a missing attempt unresolved after a lost receipt', async () => {
    const server = target(new TypeError('connection lost'), new Response(null, { status: 404 }))
    await expect(submitRayJob(server, claim)).rejects.toThrow('unconfirmed')
    expect(server.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    { type: 'DRIVER' },
    { submission_id: 'another' },
    { entrypoint: 'unrelated' },
    { runtime_env: { working_dir: 'gcs://other' } },
    { metadata: {} },
    { metadata: { ...record.metadata, open_science_entrypoint_resources: '[2,0]' } },
    { entrypoint_num_cpus: 2 },
    { entrypoint_num_gpus: 1 },
    { status: 'UNKNOWN' }
  ])('rejects conflicting or unknown observation %j before stop', async (changed) => {
    const server = target(Response.json({ ...record, ...changed }))
    await expect(stopRayJob(server, claim)).rejects.toThrow()
    expect(server.fetch).toHaveBeenCalledTimes(1)
  })

  it('polls past a stop receipt and reports the actual terminal result', async () => {
    const server = target(
      Response.json(record),
      Response.json({ stopped: true }),
      Response.json(record),
      Response.json({ ...record, status: 'SUCCEEDED', driver_exit_code: 0 })
    )
    await expect(stopRayJob(server, claim)).resolves.toEqual({ status: 'SUCCEEDED', exitCode: 0 })
    expect(server.fetch.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'GET',
      'POST',
      'GET',
      'GET'
    ])
  })

  it('checks the JSON stream budget in bytes and cancels on overflow', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"logs":"'))
        controller.enqueue(new TextEncoder().encode('科学科学"}'))
      },
      cancel
    })
    const server = target(Response.json(record), new Response(stream))
    await expect(readRayJobLogs(server, claim, 16)).rejects.toThrow('exceeds byte limit')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reads a bounded log after verifying the declaration', async () => {
    const server = target(Response.json(record), Response.json({ logs: 'done\n' }))
    await expect(readRayJobLogs(server, claim, 32)).resolves.toBe('done\n')
  })

  it('does not reconcile an explicitly aborted create', async () => {
    const signal = AbortSignal.abort(new Error('cancelled'))
    const server = target(new Error('cancelled'))
    await expect(submitRayJob(server, claim, signal)).rejects.toThrow('cancelled')
    expect(server.fetch.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
