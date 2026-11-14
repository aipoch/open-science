// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LibrarySourceCitationLink } from './LibrarySourceCitationLink'
import type { LiteratureSourceCitation } from '../../../../shared/literature-source-citation'

const harness = vi.hoisted(() => ({
  reveal: vi.fn(),
  openReference: vi.fn(),
  projectId: 'project-1' as string | undefined
}))
vi.mock('./annotations/annotation-reveal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./annotations/annotation-reveal')>()),
  requestPdfSourceReveal: harness.reveal
}))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: {
    getState: () => ({
      activeProjectId: harness.projectId,
      openLiteratureItem: harness.openReference
    })
  }
}))

const citation: LiteratureSourceCitation = {
  itemId: 'paper-1',
  title: 'A cohort study',
  kind: 'pdf',
  quote: 'Treatment improved survival.',
  source: {
    attachmentId: 'attachment-1',
    versionId: 'original-version',
    checksum: 'a'.repeat(64),
    name: 'study.pdf'
  },
  pageStart: 3,
  pageEnd: 4
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  harness.reveal
    .mockReset()
    .mockReturnValue({ admitted: true, result: Promise.resolve('revealed') })
  harness.openReference.mockReset()
  harness.projectId = 'project-1'
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const click = async (button: Element): Promise<void> => {
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent === text)
  expect(found).toBeTruthy()
  return found!
}
const show = async (value = citation): Promise<void> => {
  await act(async () =>
    root.render(<LibrarySourceCitationLink citation={value}>1</LibrarySourceCitationLink>)
  )
  await click(button('1'))
}

it('shows the excerpt on demand and reveals the original immutable PDF version at its page', async () => {
  await show()
  expect(document.body.textContent).toContain(citation.quote)
  expect(document.body.textContent).toContain('Page 3')
  await click(button('View source page'))
  expect(harness.reveal).toHaveBeenCalledWith(
    {
      id: 'library-citation:original-version:3',
      kind: 'pdf',
      source: {
        kind: 'literature-attachment-version',
        sourceFileId: 'attachment-1',
        versionId: 'original-version',
        checksum: 'a'.repeat(64),
        name: 'study.pdf',
        path: 'literature-attachment-version:original-version'
      },
      selector: { kind: 'page-note', pageNumber: 3, pageRotation: 0, coordinateVersion: 1 }
    },
    { projectId: 'project-1', signal: expect.any(AbortSignal) }
  )
  expect(harness.reveal.mock.calls[0][0].source.projectId).toBeUndefined()
})

it('labels abstract evidence and opens the bibliographic record without claiming PDF evidence', async () => {
  await show({ itemId: 'paper-1', title: citation.title, kind: 'abstract', quote: citation.quote })
  expect(document.body.textContent).toContain('Abstract only')
  expect(document.body.textContent).not.toContain('View source page')
  await click(button('View reference'))
  expect(harness.openReference).toHaveBeenCalledWith('paper-1', 'user')
  expect(harness.reveal).not.toHaveBeenCalled()
})

it('keeps the original excerpt and offers retry if the old version cannot be located', async () => {
  harness.reveal.mockReturnValue({ admitted: true, result: Promise.resolve('source-unavailable') })
  await show()
  await click(button('View source page'))
  expect(document.body.textContent).toContain('The source could not be opened.')
  expect(document.body.textContent).toContain(citation.quote)
  expect(button('View source page').disabled).toBe(false)
})

it('does not start a reveal without an owning workspace and aborts a pending reveal on unmount', async () => {
  harness.projectId = undefined
  await show()
  await click(button('View source page'))
  expect(harness.reveal).not.toHaveBeenCalled()
  harness.projectId = 'project-1'
  harness.reveal.mockImplementation((_target, options) => ({
    admitted: false,
    result: new Promise((resolve) =>
      options.signal.addEventListener('abort', () => resolve('cancelled'))
    )
  }))
  await click(button('View source page'))
  const signal = harness.reveal.mock.calls[0][1].signal as AbortSignal
  await act(async () => root.unmount())
  expect(signal.aborted).toBe(true)
  root = createRoot(container)
})

it('keeps a deferred navigation usable without treating a cancelled leave as a source failure', async () => {
  let complete!: (outcome: string) => void
  harness.reveal.mockReturnValue({
    admitted: false,
    result: new Promise((resolve) => {
      complete = resolve
    })
  })
  await show()
  await click(button('View source page'))
  expect(button('View source page').disabled).toBe(false)
  expect(document.body.textContent).toContain(citation.quote)
  expect(document.body.textContent).not.toContain('The source could not be opened.')
  await act(async () => complete('cancelled'))
  expect(document.body.textContent).not.toContain('The source could not be opened.')
})

it('shows adjoining limitations and numerical results immediately with the original quote highlighted', async () => {
  const context =
    'Only adults were included; no pediatric inference is supported. Treatment improved survival. Median survival was 24 versus 18 months, with follow-up still ongoing.'
  await show({ ...citation, context })
  expect(document.querySelector('blockquote')?.textContent).toBe(context)
  expect(document.querySelector('mark')?.textContent).toBe(citation.quote)
  expect(document.querySelector('details')).toBeNull()
  await click(button('View source page'))
  expect(harness.reveal).toHaveBeenCalledOnce()
})

// Minimal issued source snapshots from the real A04 model acceptance run (synthetic records).
it.each([
  {
    itemId: 'cmwfsr9x4000ahs65gdl01592',
    title: '验收夹具(非论文)A:RIVET-42 缓存实验记录',
    kind: 'abstract' as const,
    quote: '本条是纯合成验收夹具，不是论文。',
    context:
      '本条是纯合成验收夹具，不是论文。RIVET-42 在固定协议 P、样本量 80、同一终点 T 下，两组均值分别为 12 与 8；记录 A 的结论是干预提高 T。无额外测量误差信息。'
  },
  {
    itemId: 'cmwfsr9x7000bhs65gikh5z35',
    title: '验收夹具(非论文)B:RIVET-42 缓存实验记录',
    kind: 'abstract' as const,
    quote: '本条是纯合成验收夹具，不是论文。',
    context:
      '本条是纯合成验收夹具，不是论文。RIVET-42 在固定协议 P、样本量 80、同一终点 T 下，两组均值分别为 8 与 12；记录 B 的结论是干预降低 T。无额外测量误差信息。'
  }
])(
  'shows the actual A04 direction and numbers beside its disclaimer quote ($itemId)',
  async (value) => {
    await show(value)
    expect(document.querySelector('blockquote')?.textContent).toBe(value.context)
    expect(document.querySelector('mark')?.textContent).toBe(value.quote)
    expect(document.querySelector('details')).toBeNull()
    expect(document.body.textContent).toContain('Abstract only')
    expect(document.body.textContent).not.toContain('View source page')
    await click(button('View reference'))
    expect(harness.openReference).toHaveBeenCalledWith(value.itemId, 'user')
  }
)

it.each(['original-version', 'replacement-version'])(
  'marks a long context preview as partial and expands exact source text while preserving PDF navigation (%s)',
  async (versionId) => {
    const context =
      'Earlier observations remain inconclusive. '.repeat(30) +
      'Only adults were included. ' +
      citation.quote +
      ' Median survival was 24 versus 18 months. ' +
      'Later observations require further follow-up. '.repeat(30)
    await show({ ...citation, source: { ...citation.source!, versionId }, context })
    const preview = document.querySelector('blockquote')!
    expect(preview.textContent).not.toBe(context)
    expect(preview.textContent?.startsWith('…')).toBe(true)
    expect(preview.textContent?.endsWith('…')).toBe(true)
    expect(preview.textContent).toContain('Only adults were included.')
    expect(preview.textContent).toContain('Median survival was 24 versus 18 months.')
    expect(preview.querySelector('mark')?.textContent).toBe(citation.quote)
    const details = document.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('View surrounding text')
    expect(details.querySelector('blockquote')?.textContent).toBe(context)
    await click(details.querySelector('summary')!)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(details.open).toBe(true)
    expect(document.querySelectorAll('blockquote')).toHaveLength(1)
    expect(document.querySelector('blockquote')?.textContent).toBe(context)
    expect(document.querySelector('mark')?.textContent).toBe(citation.quote)
    await click(details.querySelector('summary')!)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(details.open).toBe(false)
    expect(document.querySelector('blockquote')?.textContent).toBe(preview.textContent)
    await click(button('View source page'))
    expect(harness.reveal).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          versionId,
          path: `literature-attachment-version:${versionId}`
        }),
        selector: expect.objectContaining({ pageNumber: 3 })
      }),
      { projectId: 'project-1', signal: expect.any(AbortSignal) }
    )
  }
)

it('preserves an unmatched quote verbatim alongside available context without rewriting either', async () => {
  const context = 'Treatment\nimproved survival. Median survival was 24 versus 18 months.'
  await show({ ...citation, context })
  const excerpts = [...document.querySelectorAll('blockquote')]
  expect(excerpts.map((entry) => entry.textContent)).toEqual([context, citation.quote])
  expect(document.querySelector('mark')?.textContent).toBe(citation.quote)
})

it('keeps a replacement short excerpt visible after expanding a previous long context', async () => {
  await show({
    ...citation,
    context: `${'Earlier observations remain inconclusive. '.repeat(30)}${citation.quote}`
  })
  const details = document.querySelector('details')!
  await click(details.querySelector('summary')!)
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(details.open).toBe(true)

  await act(async () =>
    root.render(<LibrarySourceCitationLink citation={citation}>1</LibrarySourceCitationLink>)
  )
  expect(document.querySelector('details')).toBeNull()
  expect(document.querySelector('blockquote')?.textContent).toBe(citation.quote)
})

it.each([undefined, '', '   ', citation.quote, `  ${citation.quote}  `])(
  'omits surrounding text when it is absent, empty, or repeats the excerpt (%s)',
  async (context) => {
    await show({ ...citation, context })
    expect(document.querySelector('details')).toBeNull()
    expect(document.querySelectorAll('blockquote')).toHaveLength(1)
    expect(document.querySelector('blockquote')?.textContent).toBe(citation.quote)
  }
)
