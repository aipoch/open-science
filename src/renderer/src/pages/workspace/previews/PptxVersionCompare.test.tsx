// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import type { ManagedFileVersionDescriptor } from '../../../../../shared/managed-file-versions'
import type { DeckOutline } from '../../../../../shared/pptx-edit'
import { PptxVersionCompare } from './PptxVersionCompare'
import type { PptxVersionView } from './use-pptx-outline'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))
  })
}))

vi.mock('./renderers/OfficePreview', () => ({
  OfficePreviewContent: ({ staged }: { staged: { key: string; slideIndex: number } }) => (
    <div data-testid="pane-preview" data-key={staged.key} data-slide={staged.slideIndex} />
  )
}))

const views = new Map<string, PptxVersionView>()
vi.mock('./use-pptx-outline', () => ({
  usePptxVersionView: (_identity: unknown, versionId: string) =>
    views.get(versionId) ?? { view: undefined, failed: false }
}))

afterEach(() => {
  cleanup()
  views.clear()
})

type SlideFixture = {
  slideId: number
  index: number
  part: string
  notes: string
  shapes: { shapeId: number; name: string; kind: string; text: string }[]
}

const slide = (slideId: number, text: string): SlideFixture => ({
  slideId,
  index: 0,
  part: `ppt/slides/slide${slideId}.xml`,
  notes: '',
  shapes: [{ shapeId: 2, name: 'Title', kind: 'text', text }]
})
const deck = (...slides: SlideFixture[]): DeckOutline =>
  ({ slideSize: { cx: 1, cy: 1 }, layouts: [], slides }) as unknown as DeckOutline

const ready = (versionId: string, outline: DeckOutline): void => {
  views.set(versionId, {
    view: { stagedKey: `${versionId}-session:0`, outline } as PptxVersionView['view'],
    failed: false
  })
}

const item = { id: 'i', name: 'deck.pptx' } as unknown as PreviewFileItem
const base = { id: 'v1', versionNumber: 1 } as ManagedFileVersionDescriptor
const target = { id: 'v2', versionNumber: 2 } as ManagedFileVersionDescriptor
const identity = { source: 'upload', projectId: 'p', fileId: 'f' } as const

const renderCompare = (onClose = vi.fn()): void => {
  render(
    <PptxVersionCompare
      item={item}
      source="upload"
      identity={identity}
      base={base}
      target={target}
      onClose={onClose}
    />
  )
}

const panes = (): string[] =>
  screen.getAllByRole('region').map((pane) => {
    const preview = within(pane).queryByTestId('pane-preview')
    return preview ? `${preview.dataset.key}@${preview.dataset.slide}` : 'missing'
  })

describe('PptxVersionCompare', () => {
  it('lists changed slides and previews both versions of the selected one', () => {
    ready('v1', deck(slide(256, 'A'), slide(257, 'B')))
    ready('v2', deck(slide(256, 'A'), slide(257, 'B2'), slide(300, 'New')))
    renderCompare()
    const list = within(screen.getByRole('list', { name: 'Changed slides' }))
    const entries = list.getAllByRole('button')
    expect(entries.map((entry) => entry.textContent)).toEqual(['Slide 2Text', 'Slide 3Slide added'])
    expect(panes()).toEqual(['v1-session:0@1', 'v2-session:0@1'])
    fireEvent.click(entries[1]!)
    expect(panes()).toEqual(['missing', 'v2-session:0@2'])
    expect(screen.getByText('This slide is not in this version.')).toBeTruthy()
  })

  it('says when nothing changed and closes on request', () => {
    ready('v1', deck(slide(256, 'A')))
    ready('v2', deck(slide(256, 'A')))
    const onClose = vi.fn()
    renderCompare(onClose)
    expect(screen.getByText('No slides changed.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close comparison' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('reports a version that could not be opened', () => {
    ready('v1', deck(slide(256, 'A')))
    views.set('v2', { view: undefined, failed: true })
    renderCompare()
    expect(screen.getByRole('alert').textContent).toBe('These versions could not be compared.')
  })
})
