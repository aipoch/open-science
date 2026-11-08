import { describe, expect, it, vi } from 'vitest'
import {
  findHuggingFaceJobForRun,
  HUGGING_FACE_RUN_LABEL,
  recoverApprovedHuggingFaceJob,
  submitHuggingFaceJob
} from './hugging-face-job-submission'

const request = { namespace: 'research-team', runId: 'attempt-1', token: 'test-token' }
const match = { id: 'remote-id', labels: { [HUGGING_FACE_RUN_LABEL]: request.runId } }

describe('Hugging Face Jobs recovery', () => {
  it('reads every page within the namespace and matches the local attempt', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json([{ ...match, labels: { unrelated: 'value' } }], {
          headers: { Link: '<?cursor=2>; rel="next"' }
        })
      )
      .mockResolvedValueOnce(Response.json([match, match]))
    expect(await findHuggingFaceJobForRun({ ...request, fetch })).toBe(match.id)
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetch.mock.calls) {
      const url = new URL(String(input))
      expect(url.origin + url.pathname).toBe('https://huggingface.co/api/jobs/research-team')
      expect(url.searchParams.get('labels')).toBe(HUGGING_FACE_RUN_LABEL + '=attempt-1')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token')
    }
  })

  it('distinguishes a complete empty lookup from an ambiguous or failed lookup', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([match, { ...match, id: 'second' }]))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    expect(await findHuggingFaceJobForRun({ ...request, fetch })).toBeNull()
    await expect(findHuggingFaceJobForRun({ ...request, fetch })).rejects.toThrow('Multiple')
    await expect(findHuggingFaceJobForRun({ ...request, fetch })).rejects.toThrow('403')
  })

  it.each(['https://third-party.example/jobs', '/api/jobs/other', '?labels=ignored'])(
    'stops before sending credentials to an unsafe or repeating next page: %s',
    async (next) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        Response.json([match], {
          headers: { Link: '<' + next + '>; rel="next"' }
        })
      )
      await expect(findHuggingFaceJobForRun({ ...request, fetch })).rejects.toThrow(/pagination/)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )
})

it('recovers a lost create response without creating another billable job', async () => {
  const spec = {
    ...request,
    image: 'ubuntu:24.04',
    command: ['bash', '-c', 'cp /inputs/sample /outputs/result'],
    flavor: 'cpu-basic',
    timeoutSeconds: 60,
    inputs: { bucket: 'research-team/private', prefix: 'run/in' },
    outputs: { bucket: 'research-team/private', prefix: 'run/out' }
  }
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new Error('connection lost after acceptance'))
    .mockResolvedValueOnce(Response.json([match]))
  await expect(submitHuggingFaceJob({ ...spec, outputs: spec.inputs, fetch })).rejects.toThrow(
    'overlap'
  )
  expect(fetch).not.toHaveBeenCalled()
  await expect(submitHuggingFaceJob({ ...spec, fetch })).rejects.toThrow('connection lost')
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
  const found = { ...body, ...match, owner: { name: request.namespace } }
  fetch.mockResolvedValueOnce(Response.json({ ...found, flavor: 'wrong' }))
  await expect(recoverApprovedHuggingFaceJob({ ...spec, fetch })).rejects.toThrow('does not match')
  fetch.mockResolvedValueOnce(Response.json([match])).mockResolvedValueOnce(Response.json(found))
  expect(await recoverApprovedHuggingFaceJob({ ...spec, fetch })).toBe(match.id)
  const [[url, init], [, lookup]] = fetch.mock.calls
  expect(String(url)).toBe('https://huggingface.co/api/jobs/research-team')
  expect(init?.method).toBe('POST')
  expect(lookup?.method ?? 'GET').toBe('GET')
  expect(JSON.parse(String(init?.body))).toEqual({
    dockerImage: spec.image,
    command: spec.command,
    flavor: 'cpu-basic',
    timeoutSeconds: 60,
    attempts: 1,
    labels: match.labels,
    volumes: [
      {
        type: 'bucket',
        source: spec.inputs.bucket,
        path: 'run/in',
        mountPath: '/inputs',
        readOnly: true
      },
      {
        type: 'bucket',
        source: spec.outputs.bucket,
        path: 'run/out',
        mountPath: '/outputs',
        readOnly: false
      }
    ]
  })
})
