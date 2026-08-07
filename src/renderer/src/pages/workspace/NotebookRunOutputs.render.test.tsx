// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookOutput, NotebookRunRecord } from '../../../../shared/notebook'
import { resolveNotebookRunFigures } from './notebook-run-figures'
import { NotebookRunOutputs } from './NotebookRunOutputs'

vi.mock('./previews/renderers/PdfThumbnail', () => ({
  PdfThumbnail: ({
    name,
    fit,
    align,
    renderWidth
  }: {
    name: string
    fit?: string
    align?: string
    renderWidth?: number
  }) => (
    <div
      data-testid="mock-pdf-thumbnail"
      data-fit={fit}
      data-align={align}
      data-render-width={renderWidth}
    >
      {name}
    </div>
  )
}))
vi.mock('./previews/renderers/TiffPreview', () => ({
  TiffPreviewContent: ({
    name,
    variant,
    align
  }: {
    name: string
    variant?: string
    align?: string
  }) => (
    <div data-testid="mock-tiff-preview" data-variant={variant} data-align={align}>
      {name}
    </div>
  )
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.api = {
    previewResources: {
      acquire: vi.fn(async (request) => ({
        id: `resource-${request.path}`,
        url: `open-science-preview://${request.path.split('/').pop()}`,
        size: request.size ?? 100,
        mimeType: request.mimeType ?? 'image/png',
        version: 1
      })),
      readRange: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined)
    }
  } as unknown as Window['api']
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'agent',
  kernelKind: 'python',
  script: 'x = 1',
  status: 'completed',
  startedAt: 0,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

const render = (outputs: NotebookOutput[], textOverride?: Partial<NotebookRunRecord>): void => {
  act(() => root.render(<NotebookRunOutputs run={makeRun({ outputs, ...textOverride })} />))
}

describe('NotebookRunOutputs', () => {
  it('renders a repl echoed result (display text/plain) that has no stdout', () => {
    render([{ type: 'display', data: { 'text/plain': '{ pmids: [ "1", "2" ] }' } }])

    const text = container.querySelector('[data-testid="notebook-output-text"]')
    expect(text?.textContent).toContain('pmids')
    // Nothing was on stdout, yet the panel now shows the echoed value instead of nothing.
    expect(container.querySelector('[data-testid="notebook-run-outputs"]')).not.toBeNull()
  })

  it('keeps figures in separate always-visible frames while only text output is collapsible', () => {
    render([
      { type: 'stream', name: 'stdout', text: 'saved: plot.png\n' },
      { type: 'display', data: { 'image/png': 'QUJD' } }
    ])

    const image = container.querySelector(
      '[data-testid="notebook-output-image"]'
    ) as HTMLImageElement
    const textOutput = container.querySelector('[data-testid="notebook-text-output"]')
    const figure = container.querySelector('[data-testid="notebook-figure-output"]')

    expect(image).not.toBeNull()
    expect(image.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    expect(textOutput?.tagName).toBe('DETAILS')
    expect(textOutput?.hasAttribute('open')).toBe(true)
    expect(textOutput?.contains(figure)).toBe(false)
    expect(figure?.querySelectorAll('[data-testid="notebook-output-image"]')).toHaveLength(1)
    expect(figure?.className).not.toContain('border-border-200')
    expect(figure?.className).not.toContain('overflow-x-auto')
    expect(figure?.className).not.toContain('border-border-100')
    expect(figure?.className).not.toContain('shadow')
    expect(figure?.firstElementChild?.className).toContain('justify-center')
    expect(image.className).toContain('max-h-[16rem]')
    expect(image.className).toContain('max-w-full')
    expect(image.className).toContain('w-auto')
    expect(image.className).toContain('h-auto')
    expect(image.className).toContain('object-contain')
    expect(image.className).toContain('rounded-lg')
    expect(image.className).toContain('border-border-200')
    expect(image.classList.contains('w-full')).toBe(false)
  })

  it('shows every captured figure from the same run in its own frame', () => {
    render([
      { type: 'display', data: { 'image/png': 'U0FNRQ==' } },
      { type: 'display', data: { 'image/png': 'U0FNRQ==' } }
    ])

    const figures = container.querySelectorAll('[data-testid="notebook-figure-output"]')
    expect(figures).toHaveLength(2)
    expect(figures[0]?.querySelector('img')?.getAttribute('src')).toContain('U0FNRQ==')
    expect(figures[1]?.querySelector('img')?.getAttribute('src')).toContain('U0FNRQ==')
  })

  it('falls back to every saved image when the kernel has no captured figure', () => {
    const figures = resolveNotebookRunFigures(
      makeRun({
        workingFiles: [
          {
            path: '/workspace/first.png',
            relativePath: 'first.png',
            kind: 'other',
            createdByRunId: 'r1'
          },
          {
            path: '/workspace/notes.txt',
            relativePath: 'notes.txt',
            kind: 'other',
            createdByRunId: 'r1'
          },
          {
            path: '/workspace/second.webp',
            relativePath: 'charts/second.webp',
            kind: 'other',
            createdByRunId: 'r1'
          },
          {
            path: '/workspace/third.tiff',
            relativePath: 'charts/third.tiff',
            kind: 'other',
            createdByRunId: 'r1'
          },
          {
            path: '/workspace/fourth.pdf',
            relativePath: 'charts/fourth.pdf',
            kind: 'other',
            createdByRunId: 'r1'
          }
        ]
      })
    )

    expect(figures).toEqual([
      expect.objectContaining({ source: 'working-file', path: '/workspace/first.png' }),
      expect.objectContaining({ source: 'working-file', path: '/workspace/second.webp' }),
      expect.objectContaining({
        source: 'working-file',
        path: '/workspace/third.tiff',
        previewKind: 'tiff',
        mimeType: 'image/tiff'
      }),
      expect.objectContaining({
        source: 'working-file',
        path: '/workspace/fourth.pdf',
        previewKind: 'pdf',
        mimeType: 'application/pdf'
      })
    ])
  })

  it('preserves every captured occurrence and saved images while deduplicating saved paths', () => {
    const figures = resolveNotebookRunFigures(
      makeRun({
        outputs: [
          { type: 'display', data: { 'image/png': 'QUJD' } },
          { type: 'display', data: { 'image/png': 'QUJD' } }
        ],
        workingFiles: [
          {
            path: '/workspace/plot.png',
            relativePath: 'plot.png',
            kind: 'other',
            createdByRunId: 'r1'
          },
          {
            path: '/workspace/plot.png',
            relativePath: 'plot.png',
            kind: 'other',
            createdByRunId: 'r1'
          }
        ]
      })
    )

    expect(figures).toEqual([
      expect.objectContaining({ source: 'captured', mimeType: 'image/png', payload: 'QUJD' }),
      expect.objectContaining({ source: 'captured', mimeType: 'image/png', payload: 'QUJD' }),
      expect.objectContaining({ source: 'working-file', path: '/workspace/plot.png' })
    ])
  })

  it('renders every saved-only image through local preview resources', async () => {
    await act(async () => {
      root.render(
        <NotebookRunOutputs
          run={makeRun({
            workingFiles: [
              {
                path: '/workspace/first.png',
                relativePath: 'first.png',
                kind: 'other',
                size: 101
              },
              {
                path: '/workspace/second.webp',
                relativePath: 'second.webp',
                kind: 'other',
                size: 202
              },
              {
                path: '/workspace/third.tiff',
                relativePath: 'third.tiff',
                kind: 'other',
                size: 303
              },
              {
                path: '/workspace/fourth.pdf',
                relativePath: 'fourth.pdf',
                kind: 'other',
                size: 404
              }
            ]
          })}
        />
      )
    })

    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-testid="notebook-output-image"]')).toHaveLength(2)
    })
    expect(container.querySelectorAll('[data-testid="notebook-figure-output"]')).toHaveLength(4)
    expect(container.querySelector('[data-testid="notebook-output-tiff"]')?.textContent).toBe(
      'third.tiff'
    )
    expect(container.querySelector('[data-testid="notebook-output-pdf"]')?.textContent).toBe(
      'fourth.pdf'
    )
    const tiffPreview = container.querySelector('[data-testid="notebook-output-tiff"]')
    const pdfPreview = container.querySelector('[data-testid="notebook-output-pdf"]')
    expect(tiffPreview?.className).toContain('h-64')
    expect(tiffPreview?.className).not.toContain('border-border-200')
    expect(tiffPreview?.className).not.toContain('bg-bg-100')
    expect(pdfPreview?.className).toContain('min-h-24')
    expect(pdfPreview?.classList.contains('h-64')).toBe(false)
    expect(pdfPreview?.className).not.toContain('border-border-200')
    expect(pdfPreview?.className).not.toContain('bg-bg-100')
    expect(
      container.querySelector<HTMLElement>('[data-testid="mock-tiff-preview"]')?.dataset
    ).toMatchObject({ variant: 'thumbnail', align: 'center' })
    expect(
      container.querySelector<HTMLElement>('[data-testid="mock-pdf-thumbnail"]')?.dataset
    ).toMatchObject({ fit: 'intrinsic', align: 'center', renderWidth: '768' })
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
    expect(
      Array.from(container.querySelectorAll('img'), (image) => image.getAttribute('src'))
    ).toEqual(['open-science-preview://first.png', 'open-science-preview://second.webp'])
  })

  it('renders stream stdout text', () => {
    render([{ type: 'stream', name: 'stdout', text: 'hello\n' }])

    expect(container.querySelector('[data-testid="notebook-run-outputs"]')?.textContent).toContain(
      'hello'
    )
  })

  it('renders an error output as the traceback alone (no doubled header)', () => {
    // A real traceback already ends with the type/message, so we render it verbatim — not a
    // synthesized "name: message" header on top of it (which caused a doubled "Traceback …" line).
    const traceback =
      'Traceback (most recent call last):\n  File "<cell>", line 1\nValueError: boom'
    render([{ type: 'error', name: 'ValueError', message: 'boom', traceback }])

    const outputs = container.querySelector('[data-testid="notebook-run-outputs"]')
    expect(outputs?.textContent).toContain('ValueError: boom')
    expect(outputs?.textContent).toContain('Traceback (most recent call last):')
    // The message is not prepended as a separate header: "Traceback …" appears exactly once.
    expect(outputs?.textContent?.match(/Traceback \(most recent call last\):/g)).toHaveLength(1)
  })

  it('renders ANSI SGR color codes as styled text, stripping the escapes', () => {
    render([{ type: 'stream', name: 'stdout', text: '[31mred[0m normal' }])

    const outputs = container.querySelector('[data-testid="notebook-text-output"] > div')
    expect(outputs?.textContent).toBe('red normal') // escape chars stripped, text preserved
    const span = outputs?.querySelector('span[style]') as HTMLElement | null
    expect(span?.textContent).toBe('red')
    expect(span?.style.color).not.toBe('') // colored
  })

  it('falls back to flattened text.stdout for legacy runs without outputs[]', () => {
    render([], { text: { stdout: 'legacy out', stderr: '', traceback: '', plain: [] } })

    expect(container.querySelector('[data-testid="notebook-run-outputs"]')?.textContent).toContain(
      'legacy out'
    )
  })

  it('renders nothing when there is neither structured output nor text', () => {
    render([])

    expect(container.querySelector('[data-testid="notebook-run-outputs"]')).toBeNull()
  })
})
