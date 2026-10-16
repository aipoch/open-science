import { expect, it, vi } from 'vitest'
import {
  createClassificationAttempt,
  ClassificationHttpError,
  type ClassificationInput
} from './classification'
import { classificationProviders } from '../providers/classification'
const classificationAttempt = (
  fetchImpl: typeof fetch,
  maxResponseBytes?: number
): {
  request(
    input: ClassificationInput & { url: string; key?: string; model: string }
  ): ReturnType<ReturnType<typeof createClassificationAttempt>['request']>
} => ({
  request: ({
    url,
    key,
    model,
    ...input
  }: ClassificationInput & { url: string; key?: string; model: string }) =>
    createClassificationAttempt('custom', model, url, key, fetchImpl, maxResponseBytes).request(
      input
    )
})
const input = {
  url: 'https://provider.example.test/classify',
  key: 'secret',
  model: 'm',
  state: 'text',
  questions: { q: { type: 'noul' } }
}
const usage = { input_tokens: 2, output_tokens: 1 }
it.each(
  Object.entries(classificationProviders).map(([id, definition]) => [id, definition!.endpoint])
)('encodes the %s endpoint without host configuration', async (_, url) => {
  const fetch = vi.fn(async () =>
    Response.json({ model: 'm', usage, answers: { q: { type: 'noul', noul: 0.8 } } })
  )
  const exchange = await classificationAttempt(fetch).request({ ...input, url })
  expect(fetch.mock.calls[0]).toEqual([
    url,
    expect.objectContaining({
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({ model: 'm', state: 'text', questions: input.questions })
    })
  ])
  expect(await exchange.read()).toMatchObject({ answers: { q: { noul: 0.8 } } })
})
it('owns immutable classification definitions distinct from chat models', () => {
  expect(classificationProviders.typesafe!.models).toEqual([
    { id: 'jev-latest', label: 'Jev Latest' },
    { id: 'jev-preview', label: 'Jev Preview' }
  ])
  expect(Object.isFrozen(classificationProviders.opencode!.models[0])).toBe(true)
})
it.each([
  { model: 'm', usage, answers: { q: { type: 'noul', noul: 2 } } },
  { model: 'm', usage, answers: { q: { type: 'choice', choice: 3 } } },
  { usage, answers: {} }
])('reports billed usage before rejecting malformed answers: %j', async (payload) => {
  const measured = vi.fn()
  const exchange = await classificationAttempt(async () => Response.json(payload)).request(input)
  await expect(exchange.read(measured)).rejects.toThrow()
  expect(measured).toHaveBeenCalledWith({ model: 'm', inputTokens: 2, outputTokens: 1 })
})
it('preserves arbitrary choice labels for caller-owned business validation', async () => {
  const exchange = await classificationAttempt(async () =>
    Response.json({
      model: 'm',
      usage,
      answers: {
        q: {
          type: 'choice',
          choice: 'caller-label',
          confidence: 0.9,
          probabilities: { 'caller-label': 0.9, other: 0.1 }
        }
      }
    })
  ).request(input)
  expect((await exchange.read()).answers.q).toMatchObject({
    choice: 'caller-label',
    probabilities: { other: 0.1 }
  })
})
it('reports usage on HTTP failures and leaves retry admission to the caller', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ usage, error: { message: 'busy' } }, { status: 429 })
  )
  const measured = vi.fn(),
    exchange = await classificationAttempt(fetch).request(input)
  await expect(exchange.read(measured)).rejects.toBeInstanceOf(ClassificationHttpError)
  expect(measured).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
})
it('allows a retry owner to discard the response before reading', async () => {
  const cancel = vi.fn()
  const exchange = await classificationAttempt(
    async () => new Response(new ReadableStream({ cancel }), { status: 529 })
  ).request(input)
  await exchange.cancel()
  expect(cancel).toHaveBeenCalledOnce()
})
it('bounds response bytes independently of host setup', async () => {
  const exchange = await classificationAttempt(
    async () => new Response('x'.repeat(33)),
    32
  ).request(input)
  await expect(exchange.read()).rejects.toThrow('exceeded 32 bytes')
})
it('retains completed usage after a caller cancels and passes the network signal through', async () => {
  const controller = new AbortController(),
    measured = vi.fn()
  const exchange = await classificationAttempt(async (_url, init) => {
    expect(init?.signal).toBe(controller.signal)
    return Response.json({ model: 'm', usage, answers: { q: { type: 'noul', noul: 1 } } })
  }).request({ ...input, signal: controller.signal })
  controller.abort()
  await exchange.read(measured)
  expect(measured).toHaveBeenCalledOnce()
})
