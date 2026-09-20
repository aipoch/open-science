import { afterEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '../../../../shared/literature'
import { completeLiteraturePdfDraft } from './literature-pdf-metadata'

const draft = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 's11914-026-00956-3',
  identifiers: [{ scheme: 'doi', value: '10.1007/s11914-026-00956-3', isPrimary: true }]
})
const resolved = { ...draft, title: 'Metabolism in Tumour-Induced Bone Disease' }
const install = (lookupMetadata: ReturnType<typeof vi.fn>): void => {
  vi.stubGlobal('window', { api: { literature: { lookupMetadata } } })
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('replaces the filename title and shares in-flight and cached DOI lookups', async () => {
  const lookup = vi.fn().mockResolvedValue(resolved)
  install(lookup)
  const [first, second] = await Promise.all([
    completeLiteraturePdfDraft(draft),
    completeLiteraturePdfDraft(draft)
  ])
  expect(first.title).toBe(resolved.title)
  expect(second).toEqual(first)
  await completeLiteraturePdfDraft(draft)
  expect(lookup).toHaveBeenCalledExactlyOnceWith(draft.identifiers[0].value)
  expect(draft.title).toBe('s11914-026-00956-3')
})

it('retains local fields on failure, retries failed lookups, and expires successful entries', async () => {
  vi.useFakeTimers()
  const lookup = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(resolved)
  install(lookup)
  expect(await completeLiteraturePdfDraft(draft)).toBe(draft)
  expect((await completeLiteraturePdfDraft(draft)).title).toBe(resolved.title)
  vi.advanceTimersByTime(5 * 60_000 + 1)
  await completeLiteraturePdfDraft(draft)
  expect(lookup).toHaveBeenCalledTimes(3)
})

it('does not query without a DOI or erase local authors absent from Crossref', async () => {
  const lookup = vi.fn().mockResolvedValue(resolved)
  install(lookup)
  const noDoi = { ...draft, identifiers: [] }
  expect(await completeLiteraturePdfDraft(noDoi)).toBe(noDoi)
  expect(lookup).not.toHaveBeenCalled()
  const creators = [
    {
      nameMode: 'person' as const,
      givenName: 'Renee T.',
      familyName: 'Ormsby',
      creatorType: 'author'
    }
  ]
  expect((await completeLiteraturePdfDraft({ ...draft, creators })).creators).toEqual(creators)
})

it('keeps a frequently used DOI under cache pressure instead of evicting by insertion order', async () => {
  const lookup = vi.fn().mockResolvedValue(resolved)
  install(lookup)
  await completeLiteraturePdfDraft(draft)
  for (let i = 0; i < 40; i++) {
    await completeLiteraturePdfDraft({
      ...draft,
      identifiers: [{ scheme: 'doi', value: `10.1000/paper-${i}`, isPrimary: true }]
    })
    await completeLiteraturePdfDraft(draft)
  }
  expect(lookup.mock.calls.filter(([doi]) => doi === draft.identifiers[0].value)).toHaveLength(1)
  expect(lookup).toHaveBeenCalledTimes(41)
})

it('starts TTL at successful completion and shares a slow request past the TTL window', async () => {
  vi.useFakeTimers()
  let finish!: (item: typeof resolved) => void
  const lookup = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValue(resolved)
  install(lookup)
  const first = completeLiteraturePdfDraft(draft)
  vi.advanceTimersByTime(5 * 60_000 + 1)
  const second = completeLiteraturePdfDraft(draft)
  expect(lookup).toHaveBeenCalledTimes(1)
  finish(resolved)
  await Promise.all([first, second])
  await completeLiteraturePdfDraft(draft)
  expect(lookup).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(5 * 60_000 + 1)
  await completeLiteraturePdfDraft(draft)
  expect(lookup).toHaveBeenCalledTimes(2)
})
