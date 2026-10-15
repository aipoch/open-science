// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiteratureRendererProvider, type LiteratureRendererHost } from './public/host'
import { useLiteratureClient } from './literature-read-pages'
import { useLiteratureChanges } from './useLiteratureChanges'
import { useJournalDatasets } from './journals/journal-attribute-store'
import { useAttachmentOperationsStore } from './workflows/literature-attachment-operations'

// A minimal consumer supplies only the capabilities exercised by these surfaces.
const host = (literature: object): LiteratureRendererHost =>
  ({
    api: { literature, projects: {} }
  }) as LiteratureRendererHost

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('requires an explicit host instead of silently reading the application bridge', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => renderHook(useLiteratureClient)).toThrow('LiteratureRendererProvider is required')
})

it('keeps simultaneous consumers on their own injected transport without window.api', async () => {
  const globalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    get: () => {
      throw new Error('Unexpected application bridge access')
    }
  })
  try {
    const first = host({ search: vi.fn(async () => ({ entries: [{ id: 'first' }] })) })
    const second = host({ search: vi.fn(async () => ({ entries: [{ id: 'second' }] })) })
    const left = renderHook(useLiteratureClient, {
      wrapper: ({ children }) => (
        <LiteratureRendererProvider host={first}>{children}</LiteratureRendererProvider>
      )
    })
    const right = renderHook(useLiteratureClient, {
      wrapper: ({ children }) => (
        <LiteratureRendererProvider host={second}>{children}</LiteratureRendererProvider>
      )
    })
    expect(
      (await left.result.current.readLiteratureDisplayPage({ scope: 'library' })).entries
    ).toEqual([{ id: 'first' }])
    expect(
      (await right.result.current.readLiteratureDisplayPage({ scope: 'library' })).entries
    ).toEqual([{ id: 'second' }])
  } finally {
    if (globalApi) Object.defineProperty(window, 'api', globalApi)
    else Reflect.deleteProperty(window, 'api')
  }
})

it('removes subscriptions and discards queued invalidations on unmount before reinstall', async () => {
  let changed: Parameters<LiteratureRendererHost['api']['literature']['onChanged']>[0] | undefined
  const remove = vi.fn()
  const ports = host({
    onChanged: vi.fn((listener) => {
      changed = listener
      return remove
    })
  })
  const invalidate = vi.fn()
  function Consumer(): null {
    useLiteratureChanges(invalidate)
    return null
  }
  const first = render(
    <LiteratureRendererProvider host={ports}>
      <Consumer />
    </LiteratureRendererProvider>
  )
  act(() => changed?.({ revision: 1, itemIds: ['old'] }))
  first.unmount()
  await act(async () => {
    await Promise.resolve()
  })
  expect(remove).toHaveBeenCalledTimes(1)
  expect(invalidate).not.toHaveBeenCalled()
  render(
    <LiteratureRendererProvider host={ports}>
      <Consumer />
    </LiteratureRendererProvider>
  )
  await act(async () => changed?.({ revision: 2, itemIds: ['new'] }))
  expect(invalidate).toHaveBeenCalledTimes(1)
})

it('does not carry journal responses or operation state into a new mounted instance', async () => {
  let finish!: (result: unknown) => void
  const old = new Promise((resolve) => {
    finish = resolve
  })
  const journals = vi.fn().mockReturnValueOnce(old).mockResolvedValue({ datasets: [] })
  const ports = host({ journals, onChanged: () => () => {} })
  function Consumer(): React.JSX.Element {
    const datasets = useJournalDatasets()
    const operations = useAttachmentOperationsStore()
    return (
      <div data-testid="state">
        {JSON.stringify({ datasets, operations: operations((state) => state.operations) })}
      </div>
    )
  }
  const first = render(
    <LiteratureRendererProvider host={ports}>
      <Consumer />
    </LiteratureRendererProvider>
  )
  await waitFor(() => expect(journals).toHaveBeenCalledTimes(1))
  first.unmount()
  render(
    <LiteratureRendererProvider host={ports}>
      <Consumer />
    </LiteratureRendererProvider>
  )
  await waitFor(() => expect(journals).toHaveBeenCalledTimes(2))
  await act(async () => finish({ datasets: [{ id: 'old' }] }))
  expect(screen.getByTestId('state').textContent).toBe('{"datasets":[],"operations":[]}')
})

it('lets an old attachment mutation settle without publishing into a reinstalled renderer', async () => {
  const { literatureItemInputSchema } = await import('@aipoch/literature-library/item')
  const item = {
    id: 'paper',
    metadataRevision: 1,
    item: literatureItemInputSchema.parse({ title: 'Paper', itemType: 'journalArticle' }),
    projectIds: [],
    collectionIds: [],
    createdAt: 1,
    updatedAt: 1,
    attachments: [
      {
        id: 'attachment',
        kind: 'fullText' as const,
        title: 'PDF',
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
        versions: []
      }
    ]
  }
  let finish!: (receipt: object) => void
  const mutation = new Promise((resolve) => {
    finish = resolve
  })
  const ports = host({ transact: () => mutation })
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <LiteratureRendererProvider host={ports}>{children}</LiteratureRendererProvider>
  )
  const first = renderHook(useAttachmentOperationsStore, { wrapper })
  const pending = first.result.current
    .getState()
    .run(item, 'attachment', 'remove', undefined, async () => ({ ...item, attachments: [] }))
  expect(first.result.current.getState().operations[0].pending).toBe(true)
  first.unmount()
  const second = renderHook(useAttachmentOperationsStore, { wrapper })
  expect(second.result.current.getState().operations).toEqual([])
  finish({ id: item.id })
  await pending
  expect(first.result.current.getState().operations[0].pending).toBe(false)
  expect(second.result.current.getState().operations).toEqual([])
})
