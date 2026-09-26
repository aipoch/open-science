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

const dualIdentifierDraft = {
  ...draft,
  identifiers: [
    ...draft.identifiers,
    { scheme: 'pmid' as const, value: '12345678', isPrimary: false }
  ]
}

it('tries PMID after a successful DOI result lacks an abstract, preserving earlier verified fields', async () => {
  const lookup = vi
    .fn()
    .mockResolvedValueOnce({
      ...resolved,
      containerTitle: 'Crossref journal',
      typeFields: { volume: '12' }
    })
    .mockResolvedValueOnce({
      ...dualIdentifierDraft,
      title: 'Alternate source title',
      abstract: 'PubMed supplies the missing abstract.',
      containerTitle: 'Alternative journal',
      language: 'eng',
      typeFields: { volume: '99', pages: '10-20' }
    })
  install(lookup)
  const notice = vi.fn()
  const completed = await completeLiteraturePdfDraft(dualIdentifierDraft, notice)
  expect(lookup.mock.calls).toEqual([[draft.identifiers[0].value], ['pmid:12345678']])
  expect(completed).toMatchObject({
    title: resolved.title,
    abstract: 'PubMed supplies the missing abstract.',
    containerTitle: 'Crossref journal',
    language: 'eng',
    typeFields: { volume: '12', pages: '10-20' },
    identifiers: dualIdentifierDraft.identifiers
  })
  expect(notice).not.toHaveBeenCalled()
  expect(dualIdentifierDraft.abstract).toBe('')
})

it.each(['offline', 'conflicting', 'empty'])(
  'retains DOI metadata and reports one notice after an unhelpful PMID lookup: %s',
  async (outcome) => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce({ ...resolved, containerTitle: 'Verified journal' })
    if (outcome === 'offline') lookup.mockRejectedValueOnce(new Error('offline'))
    else
      lookup.mockResolvedValueOnce({
        ...dualIdentifierDraft,
        abstract: outcome === 'empty' ? '' : 'Unrelated abstract',
        identifiers:
          outcome === 'conflicting'
            ? [
                { scheme: 'doi', value: '10.1234/unrelated', isPrimary: true },
                dualIdentifierDraft.identifiers[1]
              ]
            : dualIdentifierDraft.identifiers
      })
    install(lookup)
    const notice = vi.fn()
    expect(await completeLiteraturePdfDraft(dualIdentifierDraft, notice)).toMatchObject({
      title: resolved.title,
      containerTitle: 'Verified journal',
      abstract: '',
      identifiers: dualIdentifierDraft.identifiers
    })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(notice).toHaveBeenCalledExactlyOnceWith({ lookupFailed: true })
  }
)

it('stops after a verified result already includes an abstract', async () => {
  const lookup = vi.fn().mockResolvedValue({ ...resolved, abstract: 'Available abstract.' })
  install(lookup)
  const notice = vi.fn()
  expect((await completeLiteraturePdfDraft(dualIdentifierDraft, notice)).abstract).toBe(
    'Available abstract.'
  )
  expect(lookup).toHaveBeenCalledExactlyOnceWith(draft.identifiers[0].value)
  expect(notice).not.toHaveBeenCalled()
})

it('does not report a lookup failure when local metadata has no lookup identifier', async () => {
  const lookup = vi.fn()
  install(lookup)
  const notice = vi.fn()
  const local = {
    ...draft,
    title: 'Locally extracted title',
    abstract: 'Locally extracted abstract',
    identifiers: []
  }
  expect(await completeLiteraturePdfDraft(local, notice)).toBe(local)
  expect(lookup).not.toHaveBeenCalled()
  expect(notice).not.toHaveBeenCalled()
})
