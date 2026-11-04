import { afterEach, expect, it, vi } from 'vitest'
import { parseUseCases } from '../../../../shared/use-cases'
import { UseCaseIntroductionLoader } from './use-case-introduction-loader'

const cases = parseUseCases(
  ['viewed', 'unopened'].map((name) => ({
    name,
    title: name,
    cover: { file_name: 'cover.png' },
    introduction: { file_name: 'intro.md' },
    case: { file_name: 'case.science', bytes: 3, sha256: 'a'.repeat(64) }
  }))
)
afterEach(() => vi.unstubAllGlobals())

it('keeps visible cached content during revalidation and only notifies about changed text', async () => {
  const introduction = vi.fn().mockResolvedValue('# Original')
  vi.stubGlobal('window', { api: { sessions: { useCaseIntroduction: introduction } } })
  const loader = new UseCaseIntroductionLoader()
  await loader.load(cases[0])
  const displayed: (string | null)[] = []
  const unsubscribe = loader.subscribe(cases[0], (content) => displayed.push(content))
  await loader.refreshCached(cases)
  expect(displayed).toEqual([])
  let finish!: (content: string) => void
  introduction.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const refresh = loader.refreshCached(cases)
  await vi.waitFor(() => expect(introduction).toHaveBeenCalledTimes(3))
  expect(await loader.load(cases[0])).toBe('# Original')
  finish('# Updated')
  await refresh
  expect(displayed).toEqual(['# Updated'])
  expect(await loader.load(cases[0])).toBe('# Updated')
  expect(introduction.mock.calls.every(([slug]) => slug === 'viewed')).toBe(true)
  unsubscribe()
  introduction.mockResolvedValue('# Later')
  await loader.refreshCached(cases)
  expect(displayed).toEqual(['# Updated'])
})

it('preserves warm content on failure and rechecks after a later manual refresh', async () => {
  const introduction = vi.fn().mockResolvedValue('# Original')
  vi.stubGlobal('window', { api: { sessions: { useCaseIntroduction: introduction } } })
  const loader = new UseCaseIntroductionLoader()
  await loader.load(cases[0])
  introduction.mockRejectedValue(new Error('offline'))
  await loader.refreshCached(cases)
  expect(loader.peek(cases[0])).toBe('# Original')
  introduction.mockResolvedValue('# Recovered')
  await loader.refreshCached(cases)
  expect(loader.peek(cases[0])).toBe('# Recovered')
})

it('finishes an older renderer read before requesting the refreshed native cache', async () => {
  let finish!: (content: string) => void
  const introduction = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValue('# New')
  vi.stubGlobal('window', { api: { sessions: { useCaseIntroduction: introduction } } })
  const loader = new UseCaseIntroductionLoader()
  const older = loader.load(cases[0])
  const refresh = loader.refreshCached(cases)
  finish('# Old')
  await older
  await refresh
  expect(loader.peek(cases[0])).toBe('# New')
})
