/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it, vi } from 'vitest'
import { PdfTranslationUsageRecorder } from '../src/usage.js'
import type { TranslationUsageRepository } from '../src/usage-storage.js'
import type { TranslationWriteAdmission } from '../src/ports.js'

const context = {
  runId: 'run',
  sourceIndex: 0,
  providerId: 'provider',
  frameworkId: 'adapter',
  model: 'model'
}
const usage = { inputTokens: 4, outputTokens: 2, cacheTokens: 0 }

function setup() {
  let writing = false
  const writes: TranslationWriteAdmission = {
    async write(operation) {
      if (writing) throw new Error('write admission is not reentrant')
      writing = true
      try {
        return await operation()
      } finally {
        writing = false
      }
    },
    recover: (operation) => operation()
  }
  const repository = {
    recoverStarted: vi.fn(async () => undefined),
    createAttempt: vi.fn<TranslationUsageRepository['createAttempt']>(async () => undefined),
    completeAttempt: vi.fn<TranslationUsageRepository['completeAttempt']>(async () => ({
      count: 1
    })),
    hasAttempt: vi.fn(async () => true)
  }
  return { repository, recorder: new PdfTranslationUsageRecorder(async () => repository, writes) }
}

it('retries completion before a new attempt with non-reentrant write admission', async () => {
  const { repository, recorder } = setup()
  const finish = await recorder.start(context)
  repository.completeAttempt.mockRejectedValueOnce(new Error('disk unavailable'))
  await finish({ status: 'completed', usage })
  expect(repository.completeAttempt).toHaveBeenCalledOnce()
  const next = await recorder.start({ ...context, sourceIndex: 1 })
  expect(repository.completeAttempt).toHaveBeenCalledTimes(2)
  expect(repository.completeAttempt).toHaveBeenLastCalledWith(
    repository.createAttempt.mock.calls[0][0].eventId,
    expect.objectContaining({ status: 'completed', inputTokens: 4n, outputTokens: 2n })
  )
  expect(repository.createAttempt).toHaveBeenCalledTimes(2)
  await finish({ status: 'failed' })
  await next({ status: 'completed', usage })
  await recorder.flush()
  expect(repository.completeAttempt).toHaveBeenCalledTimes(3)
  expect(repository.recoverStarted).toHaveBeenCalledOnce()
})

it('keeps new attempts blocked while a pending completion cannot be stored', async () => {
  const { repository, recorder } = setup()
  const finish = await recorder.start(context)
  repository.completeAttempt.mockRejectedValue(new Error('disk unavailable'))
  await finish({ status: 'interrupted', usage })
  await expect(recorder.start(context)).rejects.toThrow('disk unavailable')
  expect(repository.createAttempt).toHaveBeenCalledOnce()
  repository.completeAttempt.mockResolvedValue({ count: 1 })
  await recorder.flush()
  expect(repository.completeAttempt).toHaveBeenLastCalledWith(
    repository.createAttempt.mock.calls[0][0].eventId,
    expect.objectContaining({ status: 'interrupted', inputTokens: 4n })
  )
  await recorder.start(context)
  expect(repository.createAttempt).toHaveBeenCalledTimes(2)
})
