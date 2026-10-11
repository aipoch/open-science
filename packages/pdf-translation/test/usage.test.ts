import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationUsageRecorder } from '../src/public-storage.js'
import { memoryUsage } from './support/usage-memory.js'
let memory: ReturnType<typeof memoryUsage>
let recorder: PdfTranslationUsageRecorder
const context = {
  runId: 'translation',
  sourceId: 'version',
  sourceIndex: 2,
  providerId: 'provider',
  frameworkId: 'direct-api',
  model: 'model'
}
const usage = {
  inputTokens: 40,
  cacheTokens: 12,
  cachedReadTokens: 10,
  cachedWriteTokens: 2,
  outputTokens: 8
}
beforeEach(() => {
  memory = memoryUsage()
  recorder = new PdfTranslationUsageRecorder(async () => memory.repository)
})
afterEach(() => vi.restoreAllMocks())
it('recovers interrupted attempts without inventing zero usage or resetting live attempts', async () => {
  await recorder.start(context)
  const restarted = new PdfTranslationUsageRecorder(async () => memory.repository)
  await restarted.recover()
  await restarted.start(context)
  await restarted.recover()
  const rows = [...memory.rows.values()]
  expect(rows.map((row) => row.status).sort()).toEqual(['interrupted', 'started'])
  expect(rows.every((row) => row.inputTokens === null && row.usageIncomplete)).toBe(true)
})

it('retries only failed writes and blocks new attempts until completion storage recovers', async () => {
  const finish = await recorder.start(context)
  const write = vi
    .spyOn(memory.repository, 'completeAttempt')
    .mockRejectedValue(new Error('disk unavailable'))
  await finish({ status: 'completed', usage })
  await expect(recorder.start(context)).rejects.toThrow('disk unavailable')
  expect(memory.rows.size).toBe(1)
  expect([...memory.rows.values()][0]).toMatchObject({
    status: 'started',
    usageIncomplete: true
  })
  write.mockRestore()
  await recorder.flush()
  await recorder.flush()
  expect([...memory.rows.values()][0]).toMatchObject({
    status: 'completed',
    inputTokens: 40n,
    outputTokens: 8n
  })
  expect(memory.rows.size).toBe(1)
})

it('uses null for malformed usage and distinguishes an explicitly reported zero', async () => {
  await (
    await recorder.start(context)
  )({ status: 'failed', usage: { ...usage, inputTokens: -1 } })
  await (
    await recorder.start(context)
  )({ status: 'completed', usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0 } })
  const rows = [...memory.rows.values()]
  expect(rows.find((row) => row.status === 'failed')).toMatchObject({
    usageIncomplete: true,
    inputTokens: null
  })
  expect(rows.find((row) => row.status === 'completed')).toMatchObject({
    usageIncomplete: false,
    inputTokens: 0n
  })
})
