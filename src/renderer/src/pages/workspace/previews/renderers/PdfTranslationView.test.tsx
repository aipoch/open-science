// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  PdfTranslationMarkers,
  PdfTranslationSidebar,
  PdfTranslationView
} from './PdfTranslationView'
import type { PdfTranslation } from './pdf-translation'

afterEach(() => {
  cleanup()
  document.getSelection()?.removeAllRanges()
})
const translation: PdfTranslation = {
  resourceRequestKey: 'key',
  fingerprint: 'fp',
  pages: [
    { width: 600, height: 800 },
    { width: 600, height: 800 }
  ],
  units: [
    {
      id: 'accepted',
      source: 'Current',
      translationSource: 'Current',
      translation: '完整段落跨页。',
      fragments: [1, 2].map((pageNumber) => ({
        pageNumber,
        rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
        items: [{ index: 0, text: 'Current' }]
      }))
    },
    {
      id: 'review',
      source: 'Changed',
      translationSource: 'Old',
      translation: '旧版译文',
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 0.1, y: 0.3, width: 0.8, height: 0.1 },
          items: [{ index: 1, text: 'Changed' }]
        }
      ]
    }
  ]
}
it('preserves the complete cross-page paragraph and reveals each physical fragment', () => {
  const onSelect = vi.fn()
  render(
    <PdfTranslationView
      page={<canvas />}
      pageNumber={1}
      translation={translation}
      onSelect={onSelect}
    />
  )
  expect(screen.getByText('完整段落跨页。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Source: page 2, fragment 2' }))
  expect(onSelect).toHaveBeenCalledWith(translation.units[0], 1)
  expect(screen.getByText('Source changed. This translation is for review only.')).toBeTruthy()
  const reviewArticle = screen.getByText('旧版译文').closest('article')!
  fireEvent.click(within(reviewArticle).getByRole('button', { name: 'Original text' }))
  expect(screen.getByText('Old')).toBeTruthy()
})
it('searches accepted translations without presenting stale results as current', () => {
  render(
    <PdfTranslationSidebar
      translation={translation}
      query="旧版"
      onQueryChange={() => undefined}
      onSelect={() => undefined}
      onCollapse={() => undefined}
    />
  )
  expect(screen.getByRole('status').textContent).toBe('No translation matches')
})

it('allows the source-changed suffix to wrap while keeping the page number together', () => {
  render(
    <PdfTranslationSidebar
      translation={translation}
      query=""
      onQueryChange={() => undefined}
      onSelect={() => undefined}
      onCollapse={() => undefined}
    />
  )
  const suffix = screen.getByText('· Source changed')
  expect(suffix.className).toContain('whitespace-normal')
  expect(suffix.parentElement?.className).toContain('whitespace-nowrap')
  expect(suffix.parentElement?.textContent).toBe('Page 1 · #2 · Source changed')
  const currentLabel = screen.getByText('Page 1 · #1')
  expect(currentLabel.className).toContain('whitespace-nowrap')
  expect(currentLabel.children).toHaveLength(0)
})

it('selects only the complete translation and focuses it for the normal copy shortcut', () => {
  render(
    <PdfTranslationView
      page={<canvas />}
      pageNumber={1}
      translation={translation}
      onSelect={() => undefined}
    />
  )
  const buttons = screen.getAllByRole('button', { name: 'Select full paragraph' })
  fireEvent.click(buttons[0])
  expect(document.getSelection()?.toString()).toBe('完整段落跨页。')
  expect(document.activeElement).toBe(screen.getByText('完整段落跨页。'))
  expect((buttons[1] as HTMLButtonElement).disabled).toBe(true)
})

it('finds and selects a whole cross-page unit from the sidebar without a mounted source page', () => {
  const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  try {
    const onCollapse = vi.fn()
    const onSelect = vi.fn()
    const view = render(
      <PdfTranslationSidebar
        translation={translation}
        query="段落跨页"
        selectedId="accepted"
        onQueryChange={() => undefined}
        onSelect={onSelect}
        onCollapse={onCollapse}
      />
    )
    expect(screen.queryByText('No translation matches')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Select full paragraph' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Locate paragraph on page 2' })).toBeTruthy()
    const trigger = screen.getByRole('button', { expanded: true })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(trigger)
    expect(onCollapse).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    view.rerender(
      <PdfTranslationSidebar
        translation={translation}
        query="段落跨页"
        onQueryChange={() => undefined}
        onSelect={onSelect}
        onCollapse={onCollapse}
      />
    )
    expect(screen.queryByRole('button', { name: 'Select full paragraph' })).toBeNull()
    const collapsed = screen.getByRole('button', { expanded: false, name: /^Page/ })
    expect(collapsed.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(collapsed)
    expect(onSelect).toHaveBeenCalledWith(translation.units[0], 0)
  } finally {
    if (scrollIntoView)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

it('shows one original-page action per page for fragmented paragraphs', () => {
  const scrollIntoView = HTMLElement.prototype.scrollIntoView
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  const fragmentedTranslation: PdfTranslation = {
    ...translation,
    units: [
      {
        ...translation.units[0],
        fragments: [
          ...translation.units[0].fragments,
          ...translation.units[0].fragments.slice(0, 1),
          ...translation.units[0].fragments.slice(0, 1)
        ]
      }
    ]
  }
  try {
    render(
      <PdfTranslationSidebar
        translation={fragmentedTranslation}
        query=""
        selectedId="accepted"
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onCollapse={() => undefined}
      />
    )
    expect(screen.getAllByRole('button', { name: 'Locate paragraph on page 1' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Locate paragraph on page 2' })).toHaveLength(1)
  } finally {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
  }
})

it('shows selected paragraph tooltips above the translation sidebar', async () => {
  vi.useFakeTimers()
  const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  try {
    render(
      <PdfTranslationSidebar
        translation={translation}
        query=""
        selectedId="accepted"
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onCollapse={() => undefined}
      />
    )
    const copy = screen.getByRole('button', { name: 'Copy' })
    fireEvent.pointerOver(copy, { pointerType: 'mouse' })
    fireEvent.pointerMove(copy, { pointerType: 'mouse' })
    await act(async () => vi.advanceTimersByTimeAsync(100))
    const tooltip = document.body.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
    expect(tooltip?.textContent).toContain('Copy')
    expect(tooltip?.className).toContain('z-[120]')
  } finally {
    if (scrollIntoView)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    vi.useRealTimers()
  }
})

it('keeps the translation list open when only the selected paragraph is collapsed', () => {
  const scrollIntoView = HTMLElement.prototype.scrollIntoView
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  try {
    const onReviewOpenChange = vi.fn()
    const view = render(
      <PdfTranslationSidebar
        translation={translation}
        query=""
        selectedId="accepted"
        collapsed
        onReviewOpenChange={onReviewOpenChange}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onCollapse={() => undefined}
      />
    )
    const section = screen.getByRole('button', { name: /^Translation/ })
    expect(section.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('textbox', { name: 'Search translation' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Search translation' }))
    expect(screen.getByRole('textbox', { name: 'Search translation' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }))
    expect(screen.queryByRole('textbox', { name: 'Search translation' })).toBeNull()
    expect(
      Array.from(document.querySelectorAll('div')).some(
        (element) =>
          element.className.includes('content-visibility:auto') &&
          element.textContent?.includes('Changed')
      )
    ).toBe(true)
    const paragraph = screen.getByRole('button', { expanded: true })
    fireEvent.click(paragraph)
    view.rerender(
      <PdfTranslationSidebar
        translation={translation}
        query=""
        collapsed
        onReviewOpenChange={onReviewOpenChange}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onCollapse={() => undefined}
      />
    )
    expect(section.getAttribute('aria-pressed')).toBe('true')
    expect(onReviewOpenChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(section)
    expect(onReviewOpenChange).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Search translation' }))
    expect(onReviewOpenChange).toHaveBeenLastCalledWith(true)
  } finally {
    if (scrollIntoView)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView
      })
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

it('does not retain a selected old translation when the supplied result changes', () => {
  const props = { page: <canvas />, pageNumber: 1, onSelect: () => undefined }
  const view = render(<PdfTranslationView {...props} translation={translation} />)
  fireEvent.click(screen.getAllByRole('button', { name: 'Select full paragraph' })[0])
  view.rerender(
    <PdfTranslationView
      {...props}
      translation={{
        ...translation,
        units: [{ ...translation.units[0], translation: '替换后的段落。' }]
      }}
    />
  )
  expect(document.getSelection()?.toString()).not.toContain('完整段落跨页。')
  fireEvent.click(screen.getByRole('button', { name: 'Select full paragraph' }))
  expect(document.getSelection()?.toString()).toBe('替换后的段落。')
})

it('disables complete selection when translation is unavailable', () => {
  render(
    <PdfTranslationView
      page={<canvas />}
      pageNumber={1}
      translation={{ ...translation, units: [{ ...translation.units[0], translation: '' }] }}
      onSelect={() => undefined}
    />
  )
  expect(
    (screen.getByRole('button', { name: 'Select full paragraph' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(screen.getByText('Translation unavailable')).toBeTruthy()
})

it('shows only complete translated text in compare, including paragraphs continuing from another page', () => {
  const onSelect = vi.fn()
  const { container } = render(
    <PdfTranslationView
      textOnly
      page={<canvas />}
      pageNumber={2}
      translation={translation}
      onSelect={onSelect}
    />
  )
  expect(container.querySelector('canvas')).toBeNull()
  expect(container.querySelector('[data-translation-source]')).toBeNull()
  expect(screen.getByText('完整段落跨页。')).toBeTruthy()
  expect(screen.queryByText('旧版译文')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Source: page 2, fragment 2' }))
  expect(onSelect).toHaveBeenCalledWith(translation.units[0], 1)
})

it('does not repeat cross-page paragraphs in the translation-only document', () => {
  render(
    <PdfTranslationView
      textOnly
      includeContinuations={false}
      pageNumber={2}
      translation={translation}
      onSelect={() => undefined}
    />
  )
  expect(screen.queryByText('完整段落跨页。')).toBeNull()
})

it('offers separate layout and translation retries for a retained passage', async () => {
  const previousScroll = HTMLElement.prototype.scrollIntoView
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn()
  })
  try {
    const onRetryUnit = vi.fn(),
      onRetryLayout = vi.fn()
    const props = {
      translation,
      query: '',
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onCollapse: vi.fn(),
      selectedId: 'accepted',
      retainedUnitIds: ['accepted'],
      onRetryUnit,
      onRetryLayout
    }
    const view = render(<PdfTranslationSidebar {...props} selectedId={undefined} />)
    expect(screen.getAllByRole('img', { name: 'Text kept in original layout' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Retry PDF layout' })).toBeNull()
    view.rerender(<PdfTranslationSidebar {...props} />)
    expect(
      screen.queryByText(
        'This passage is translated, but its original layout was retained in the PDF.'
      )
    ).toBeNull()
    const warning = screen.getByRole('img', { name: 'Text kept in original layout' })
    fireEvent.focus(warning)
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'This passage is translated, but its original layout was retained in the PDF.'
    )
    fireEvent.blur(warning)
    fireEvent.click(screen.getByRole('button', { name: 'Retry PDF layout' }))
    expect(onRetryLayout).toHaveBeenCalledOnce()
    expect(onRetryUnit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retranslate this paragraph' }))
    expect(onRetryUnit).toHaveBeenCalledWith('accepted')
    view.rerender(<PdfTranslationSidebar {...props} retryingUnitId="accepted" retryDisabled />)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Translating paragraph…' }).disabled
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Retry PDF layout' }).disabled
    ).toBe(true)
    view.rerender(<PdfTranslationSidebar {...props} unchangedLayoutUnitIds={['accepted']} />)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Layout unchanged' }).disabled
    ).toBe(true)
    expect(
      screen.queryByText('Retrying did not change this passage. You can read its translation here.')
    ).toBeNull()
    fireEvent.focus(warning)
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'Retrying did not change this passage.'
    )
    fireEvent.blur(warning)
    fireEvent.click(screen.getByRole('button', { name: 'Layout unchanged' }))
    expect(onRetryLayout).toHaveBeenCalledOnce()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Retranslate this paragraph' }).disabled
    ).toBe(false)
    view.rerender(<PdfTranslationSidebar {...props} unchangedLayoutUnitIds={[]} />)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Retry PDF layout' }).disabled
    ).toBe(false)
    view.rerender(<PdfTranslationSidebar {...props} retainedUnitIds={[]} />)
    expect(screen.queryByRole('img', { name: 'Text kept in original layout' })).toBeNull()
  } finally {
    if (previousScroll) HTMLElement.prototype.scrollIntoView = previousScroll
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

it('filters retained passages together with search and can restore the full list', () => {
  const props = {
    translation,
    retainedUnitIds: ['accepted'],
    query: '',
    collapsed: true,
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onCollapse: vi.fn()
  }
  const view = render(<PdfTranslationSidebar {...props} />)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Filter translations' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Translation issues' }))
  expect(
    screen.getByRole('button', { name: 'Filter translations' }).getAttribute('aria-pressed')
  ).toBe('true')
  expect(screen.getByRole('button', { name: /^Translation\s*1 \/ 2$/ })).toBeTruthy()
  expect(screen.getByText('完整段落跨页。')).toBeTruthy()
  expect(screen.queryByText('Changed')).toBeNull()
  view.rerender(<PdfTranslationSidebar {...props} query="missing" />)
  expect(screen.getByText('No translation matches')).toBeTruthy()
  view.rerender(<PdfTranslationSidebar {...props} />)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Filter translations' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Translation issues' }))
  expect(screen.getByText('Changed')).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Filter translations' }).getAttribute('aria-pressed')
  ).toBe('false')
})

it.each(['1 Translated', '0 Failed', '1 Not in PDF'])(
  'clears the %s progress filter on its second click and keeps the list open',
  (label) => {
    const { container } = render(
      <PdfTranslationSidebar
        translation={translation}
        retainedUnitIds={['accepted']}
        query=""
        collapsed
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onCollapse={vi.fn()}
      />
    )
    const button = screen.getByRole('button', { name: label })
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelectorAll('[data-translation-row]')).toHaveLength(
      label === '0 Failed' ? 0 : 1
    )
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(
      screen.getByRole('button', { name: 'Filter translations' }).getAttribute('aria-pressed')
    ).toBe('false')
    expect(container.querySelectorAll('[data-translation-row]')).toHaveLength(2)
    expect(screen.getByText('完整段落跨页。')).toBeTruthy()
    expect(screen.getByText('Changed')).toBeTruthy()
  }
)

it('keeps sidebar and PDF marker numbers stable when earlier parallel results arrive', () => {
  const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  try {
    const numbered = {
      ...translation,
      units: [
        { ...translation.units[0], paragraphNumber: 1 },
        {
          ...translation.units[1],
          paragraphNumber: 2,
          translationSource: translation.units[1].source,
          translation: 'Second translation'
        }
      ]
    }
    const props = {
      translation: numbered,
      retainedUnitIds: ['review'],
      query: '',
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onCollapse: vi.fn()
    }
    const view = render(
      <PdfTranslationSidebar {...props} translation={{ ...numbered, units: [numbered.units[1]] }} />
    )
    expect(screen.getByText('Page 1 · #2')).toBeTruthy()
    expect(screen.queryByText('Page 1 · #1')).toBeNull()
    view.rerender(<PdfTranslationSidebar {...props} />)
    expect(screen.getByText('Page 1 · #1')).toBeTruthy()
    expect(screen.getByText('Page 1 · #2')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Filter translations' }), {
      key: 'ArrowDown'
    })
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Translation issues' }))
    expect(screen.queryByText('Page 1 · #1')).toBeNull()
    expect(screen.getByText('Page 1 · #2')).toBeTruthy()
    view.rerender(<PdfTranslationSidebar {...props} query="Second" selectedId="review" />)
    expect(screen.getByText('Page 1 · #2')).toBeTruthy()
    view.unmount()
    const markers = render(
      <PdfTranslationMarkers
        units={[numbered.units[1]]}
        visibleUnitIds={['review']}
        pageNumber={1}
        onSelect={props.onSelect}
      />
    )
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Read paragraph 2 translation' }).textContent).toBe(
      '2'
    )
    markers.rerender(
      <PdfTranslationMarkers units={numbered.units} pageNumber={2} onSelect={props.onSelect} />
    )
    expect(screen.getByRole('button', { name: 'Read paragraph 1 translation' }).textContent).toBe(
      '1'
    )
  } finally {
    if (scrollIntoView)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
  }
})

it('shows a skipped block as an issue with source text, location and individual retry', () => {
  const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  const unit = { ...translation.units[0], translation: '', translationFailed: true as const }
  const onRetryUnit = vi.fn(),
    onSelect = vi.fn()
  const props = {
    translation: { ...translation, units: [unit, translation.units[1]] },
    query: '',
    onQueryChange: vi.fn(),
    onSelect,
    onCollapse: vi.fn(),
    onRetryUnit
  }
  const view = render(<PdfTranslationSidebar {...props} />)
  expect(screen.getAllByRole('img', { name: 'Translation failed' }).length).toBeGreaterThan(0)
  expect(
    screen.queryByText(
      'This passage could not be translated and was skipped. Retry it individually.'
    )
  ).toBeNull()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Filter translations' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Translation issues' }))
  expect(screen.queryByText('Changed')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Page 1 · #1/ }))
  expect(onSelect).toHaveBeenCalledWith(unit, 0)
  view.rerender(<PdfTranslationSidebar {...props} selectedId={unit.id} />)
  expect(
    screen.queryByText(
      'This passage could not be translated and was skipped. Retry it individually.'
    )
  ).toBeNull()
  expect(screen.getByText('Current', { selector: 'p' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retranslate this paragraph' }))
  expect(onRetryUnit).toHaveBeenCalledWith(unit.id)
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

it.each([
  {
    reasonCode: 'missing-numeric-literals' as const,
    description: 'The translation changed or omitted numeric values.'
  },
  {
    reasonCode: 'changed-numeric-unit' as const,
    description: 'The translation changed or omitted units associated with numeric values.'
  }
])(
  'separates progress and keeps $reasonCode failures actionable',
  async ({ reasonCode, description }) => {
    const failed = {
      ...translation.units[1],
      translation: '',
      translationFailed: true as const,
      failure: { reasonCode, pageNumbers: [1], attempts: 4 }
    }
    const onSelect = vi.fn(),
      onRetryLayout = vi.fn(),
      onRetryUnit = vi.fn()
    const props = {
      translation: { ...translation, units: [translation.units[0], failed] },
      unfilledUnitIds: ['accepted'],
      query: '',
      collapsed: true,
      onQueryChange: vi.fn(),
      onCollapse: vi.fn(),
      onSelect,
      onRetryLayout,
      onRetryUnit
    }
    const view = render(<PdfTranslationSidebar {...props} />)
    const progress = screen.getByRole('group', { name: 'Translation progress' })
    expect(within(progress).getByRole('button', { name: '1 Translated' })).toBeTruthy()
    expect(within(progress).getByRole('button', { name: '1 Failed' })).toBeTruthy()
    fireEvent.click(within(progress).getByRole('button', { name: '1 Not in PDF' }))
    expect(screen.getByText('完整段落跨页。')).toBeTruthy()
    expect(screen.queryByText('Changed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Page 1 · #1/ }))
    expect(onSelect).toHaveBeenCalledWith(translation.units[0], 0)
    const previousScroll = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = vi.fn()
    try {
      view.rerender(<PdfTranslationSidebar {...props} selectedId="accepted" />)
      expect(
        screen.queryByText('This translation is not yet placed in the PDF. You can read it here.')
      ).toBeNull()
      const layoutWarning = screen.getByRole('img', { name: 'Not in PDF' })
      fireEvent.focus(layoutWarning)
      expect((await screen.findByRole('tooltip')).textContent).toContain(
        'This translation is not yet placed in the PDF.'
      )
      fireEvent.blur(layoutWarning)
      fireEvent.click(screen.getByRole('button', { name: 'Retry PDF layout' }))
      expect(onRetryLayout).toHaveBeenCalledWith('accepted')
      fireEvent.click(within(progress).getByRole('button', { name: '1 Failed' }))
      expect(screen.queryByText('完整段落跨页。')).toBeNull()
      view.rerender(<PdfTranslationSidebar {...props} selectedId="review" />)
      expect(screen.queryByText(description)).toBeNull()
      const failureWarning = screen.getAllByRole('img', { name: 'Translation failed' }).at(-1)!
      fireEvent.focus(failureWarning)
      const tip = await screen.findByRole('tooltip')
      expect(tip.textContent).toContain(description)
      expect(tip.textContent).toContain('Translation attempts: 4')
      fireEvent.blur(failureWarning)
      fireEvent.click(screen.getByRole('button', { name: 'Retranslate this paragraph' }))
      expect(onRetryUnit).toHaveBeenCalledWith('review')
      view.rerender(<PdfTranslationSidebar {...props} selectedId="review" unfilledUnitIds={[]} />)
      expect(screen.getByRole('button', { name: '0 Not in PDF' })).toBeTruthy()
    } finally {
      if (previousScroll) HTMLElement.prototype.scrollIntoView = previousScroll
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
  }
)

it('keeps persisted layout failure details in a focusable tip beside the readable translation', async () => {
  const previousScroll = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = vi.fn()
  try {
    render(
      <PdfTranslationSidebar
        translation={translation}
        retainedUnitIds={['accepted']}
        unfilledUnitIds={['accepted']}
        layoutFailures={{
          accepted: { code: 'overflow', phase: 'planning', pageNumbers: [1, 2], fragmentCount: 2 }
        }}
        selectedId="accepted"
        query=""
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onCollapse={() => undefined}
      />
    )
    expect(
      screen.queryByText(
        'This passage is translated, but its original layout was retained in the PDF.'
      )
    ).toBeNull()
    expect(screen.queryByText('The translated text does not fit its original region.')).toBeNull()
    const warning = screen.getByRole('img', { name: 'Text kept in original layout' })
    expect(warning.tabIndex).toBe(0)
    fireEvent.focus(warning)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toContain(
      'This passage is translated, but its original layout was retained in the PDF.'
    )
    expect(tip.textContent).toContain('The translated text does not fit its original region.')
    expect(screen.getAllByText('完整段落跨页。').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Locate paragraph on page 2' })).toBeTruthy()
  } finally {
    if (previousScroll) HTMLElement.prototype.scrollIntoView = previousScroll
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

it('withholds unknown PDF placement counts until validation and keeps a verified count during refresh', () => {
  const props = {
    translation,
    query: '',
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onCollapse: vi.fn(),
    unfilledUnitIds: ['accepted']
  }
  const view = render(<PdfTranslationSidebar {...props} layoutPending layoutBusy />)
  const pending = screen.getByRole('button', { name: 'Not in PDF' })
  expect(pending.getAttribute('aria-disabled')).toBe('true')
  expect(pending.textContent).toContain('—')
  expect(screen.queryByRole('button', { name: '1 Not in PDF' })).toBeNull()
  expect(screen.queryByRole('img', { name: 'Not in PDF' })).toBeNull()
  fireEvent.click(pending)
  expect(pending.getAttribute('aria-pressed')).toBe('false')
  view.rerender(<PdfTranslationSidebar {...props} layoutPending={false} layoutBusy />)
  expect(screen.getByRole('button', { name: '1 Not in PDF' }).getAttribute('aria-disabled')).toBe(
    'false'
  )
  view.rerender(<PdfTranslationSidebar {...props} unfilledUnitIds={[]} />)
  expect(screen.getByRole('button', { name: '0 Not in PDF' })).toBeTruthy()
})

it('keeps every long-document row reachable while mounting only the selected paragraph body', async () => {
  const units = Array.from({ length: 768 }, (_, index) => {
    const source = `Original paragraph ${index + 1}`
    return {
      ...translation.units[0],
      id: `paragraph ${index + 1}`,
      source,
      translationSource: source,
      translation: `Translated paragraph ${index + 1}${index === 767 ? ' with a unique ending' : ''}`,
      fragments: [{ ...translation.units[0].fragments[0], pageNumber: Math.floor(index / 8) + 1 }]
    }
  })
  const last = units[767]
  last.fragments = [
    { ...last.fragments[0], pageNumber: 95 },
    { ...last.fragments[0], pageNumber: 96 }
  ]
  const props = {
    translation: {
      ...translation,
      pages: Array.from({ length: 96 }, () => ({ width: 600, height: 800 })),
      units
    },
    query: '',
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onCollapse: vi.fn()
  }
  const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const scrollIntoView = vi.fn()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  })
  try {
    const view = render(<PdfTranslationSidebar {...props} />)
    const rowElements = [...view.container.querySelectorAll<HTMLElement>('[data-translation-row]')]
    const rows = rowElements.map((row) => row.querySelector<HTMLButtonElement>('button')!)
    expect(rows).toHaveLength(768)
    expect(rows.every((row) => row.type === 'button' && row.tabIndex === 0)).toBe(true)
    expect(view.container.querySelectorAll('[data-translation-text]')).toHaveLength(0)
    // Structural budget: the old Radix row mounted ten elements, including
    // hidden content. Keep the list below nine per row, with room for its header.
    expect(view.container.querySelectorAll('*').length).toBeLessThan(768 * 9 + 120)
    const trigger = rows[767]
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    expect(props.onSelect).toHaveBeenCalledWith(last, 0)
    view.rerender(<PdfTranslationSidebar {...props} selectedId={last.id} />)
    expect(
      within(rowElements[767]).getByRole('button', { expanded: true, name: /^Page 95 · #768/ })
    ).toBe(trigger)
    expect(document.activeElement).toBe(trigger)
    expect(scrollIntoView).toHaveBeenCalled()
    const content = document.getElementById(trigger.getAttribute('aria-controls')!)
    expect(content?.querySelector('[data-translation-text]')?.textContent).toBe(last.translation)
    expect(view.container.querySelectorAll('[data-translation-text]')).toHaveLength(1)
    await act(async () =>
      fireEvent.click(within(rowElements[767]).getByRole('button', { name: 'Copy' }))
    )
    expect(writeText).toHaveBeenCalledWith(last.translation)
    fireEvent.click(
      within(rowElements[767]).getByRole('button', { name: 'Locate paragraph on page 96' })
    )
    expect(props.onSelect).toHaveBeenLastCalledWith(last, 1)
    trigger.focus()
    fireEvent.click(trigger)
    expect(props.onCollapse).toHaveBeenCalledOnce()
    view.rerender(<PdfTranslationSidebar {...props} />)
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.hasAttribute('aria-controls')).toBe(false)
    expect(view.container.querySelector('[data-translation-text]')).toBeNull()
    view.rerender(<PdfTranslationSidebar {...props} query="unique ending" />)
    expect([...view.container.querySelectorAll('[data-translation-row]')]).toEqual([
      rowElements[767]
    ])
    expect(trigger.textContent).toContain('#768')
    fireEvent.click(trigger)
    expect(props.onSelect).toHaveBeenLastCalledWith(last, 0)
    view.rerender(<PdfTranslationSidebar {...props} />)
    expect(view.container.querySelectorAll('[data-translation-row]')).toHaveLength(768)
  } finally {
    if (previousScroll)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
