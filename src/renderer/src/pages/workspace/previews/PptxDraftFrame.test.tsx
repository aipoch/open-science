// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import type { PptxDraftSummary } from '../../../../../shared/pptx-draft'
import type { PptxEditSessionView } from '../../../../../shared/pptx-edit-session'
import { PptxDraftFrame, type PptxDraftFrameProps } from './PptxDraftFrame'
import type { PptxDraftState } from './use-pptx-draft'

const staged = vi.hoisted(() => vi.fn())
vi.mock('./renderers/OfficePreview', () => ({
  OfficePreviewContent: (props: {
    staged: { key: string; slideIndex: number }
    slideRequest?: { slideIndex: number; serial: number }
  }) => {
    staged({ ...props.staged, request: props.slideRequest })
    return <div data-testid="staged-preview">{props.staged.slideIndex}</div>
  }
}))
afterEach(() => {
  cleanup()
  staged.mockClear()
})

const draft: PptxDraftSummary = {
  draftId: 'd1',
  basedOnVersionId: 'v1',
  summary: 'Retitle slide 2',
  opCount: 1,
  createdAt: 1,
  operations: [{ op: 'deleteShape', slideId: 257, shapeId: 2 }]
}
const slide = (
  slideId: number,
  index: number
): PptxEditSessionView['outline']['slides'][number] => ({
  slideId,
  index,
  part: `ppt/slides/slide${index + 1}.xml`,
  notes: '',
  shapes: []
})
const view = {
  stagedKey: 'staged-1',
  outline: { slides: [slide(256, 0), slide(257, 1), slide(258, 2)] }
} as unknown as PptxEditSessionView

const state = (patch: Partial<PptxDraftState> = {}): PptxDraftState => ({
  draft,
  busy: false,
  problem: undefined,
  accept: vi.fn(),
  reject: vi.fn(),
  ...patch
})
const setup = (
  patch: Partial<PptxDraftFrameProps> = {}
): { props: PptxDraftFrameProps; container: HTMLElement } => {
  const props: PptxDraftFrameProps = {
    item: { name: 'deck.pptx' } as PreviewFileItem,
    source: 'artifact' as never,
    state: state(),
    preview: { view, failed: false },
    reviewing: false,
    onReview: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
    children: <div data-testid="file-content" />,
    ...patch
  }
  const { container } = render(<PptxDraftFrame {...props} />)
  return { props, container }
}

it('renders the file content unchanged when there is no draft', () => {
  const { container } = setup({ state: state({ draft: null }) })
  expect(container.innerHTML).toBe('<div data-testid="file-content"></div>')
})

it('shows the draft summary and forwards review, accept and reject', () => {
  const { props } = setup()
  expect(screen.getByTestId('pptx-draft-banner').textContent).toContain('Retitle slide 2')
  fireEvent.click(screen.getByRole('button', { name: 'Review edits' }))
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
  expect(props.onReview).toHaveBeenCalledOnce()
  expect(props.onAccept).toHaveBeenCalledOnce()
  expect(props.onReject).toHaveBeenCalledOnce()
  expect(screen.getByTestId('file-content')).toBeTruthy()
})

it('disables actions while busy and shows a problem without a draft', () => {
  setup({ state: state({ busy: true }) })
  expect(screen.getByRole('button', { name: 'Accept' })).toHaveProperty('disabled', true)
  cleanup()
  setup({ state: state({ draft: null, problem: 'stale' }) })
  expect(screen.getByRole('status').textContent).toContain('The file changed after')
  expect(screen.queryByRole('button')).toBeNull()
})

it('reviews the staged preview and jumps between changed slides', () => {
  setup({ reviewing: true })
  expect(screen.queryByRole('button', { name: 'Review edits' })).toBeNull()
  expect(screen.queryByTestId('file-content')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Slide 2' }))
  expect(screen.queryByRole('button', { name: 'Slide 1' })).toBeNull()
  expect(staged).toHaveBeenLastCalledWith(
    expect.objectContaining({
      key: 'staged-1',
      slideIndex: 1,
      request: { slideIndex: 1, serial: 1 }
    })
  )
})

it('explains when the suggested edits cannot be previewed', () => {
  setup({ reviewing: true, preview: { view: undefined, failed: true } })
  expect(screen.getByRole('alert').textContent).toBe('The suggested edits could not be previewed.')
  expect(staged).not.toHaveBeenCalled()
})
