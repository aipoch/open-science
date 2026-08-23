// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NotebookOutput, NotebookRunRecord } from '../../../../shared/notebook'
import { resolveNotebookRunFigures } from './notebook-run-figures'
import { NotebookRunOutputs } from './NotebookRunOutputs'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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
  it('shows the truncation notice even when all output was omitted', () => {
    render([], { truncated: true })

    expect(container.querySelector('[data-testid="notebook-output-truncated"]')?.textContent).toBe(
      'Output was truncated to keep this Notebook responsive.'
    )
  })

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

  it('ignores saved working files when the run captured a figure', () => {
    const run = makeRun({
      outputs: [{ type: 'display', data: { 'image/png': 'SElTVE9SSUNBTA==' } }],
      workingFiles: [
        {
          path: '/workspace/sin.tiff',
          relativePath: 'sin.tiff',
          kind: 'other',
          size: 100,
          mtimeMs: 1,
          createdByRunId: 'r1'
        }
      ]
    })

    expect(resolveNotebookRunFigures(run)).toEqual([
      expect.objectContaining({
        source: 'captured',
        mimeType: 'image/png',
        payload: 'SElTVE9SSUNBTA=='
      })
    ])

    act(() => root.render(<NotebookRunOutputs run={run} />))

    expect(container.querySelectorAll('[data-testid="notebook-figure-output"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="notebook-output-tiff"]')).toBeNull()
  })

  it('does not treat saved working files as notebook output when the kernel captured no figure', () => {
    const run = makeRun({
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
    const figures = resolveNotebookRunFigures(run)

    expect(figures).toEqual([])

    act(() => root.render(<NotebookRunOutputs run={run} />))
    expect(container.querySelector('[data-testid="notebook-figure-outputs"]')).toBeNull()
  })

  it('keeps synthetic filenames when multiple saved-file associations are ambiguous', () => {
    const figures = resolveNotebookRunFigures(
      makeRun({
        outputs: [
          { type: 'display', data: { 'image/png': 'QUJD' } },
          { type: 'display', data: { 'image/png': 'QUJD' } }
        ],
        workingFiles: [
          {
            path: '/workspace/first.png',
            relativePath: 'charts/first.png',
            kind: 'other',
            createdByRunId: 'r1'
          },
          {
            path: '/workspace/second.png',
            relativePath: 'charts/second.png',
            kind: 'other',
            createdByRunId: 'r1'
          }
        ]
      })
    )

    expect(figures).toEqual([
      expect.objectContaining({ source: 'captured', mimeType: 'image/png', payload: 'QUJD' }),
      expect.objectContaining({ source: 'captured', mimeType: 'image/png', payload: 'QUJD' })
    ])
    expect(figures).toEqual([
      expect.not.objectContaining({ filename: expect.any(String) }),
      expect.not.objectContaining({ filename: expect.any(String) })
    ])
  })

  it('keeps a synthetic filename when saved-file association is ambiguous', () => {
    const figures = resolveNotebookRunFigures(
      makeRun({
        outputs: [{ type: 'display', data: { 'image/png': 'QUJD' } }],
        workingFiles: [
          {
            path: '/workspace/plot.pdf',
            relativePath: 'plot.pdf',
            kind: 'other',
            createdByRunId: 'r1'
          },
          {
            path: '/workspace/plot.tiff',
            relativePath: 'plot.tiff',
            kind: 'other',
            createdByRunId: 'r1'
          }
        ]
      })
    )

    expect(figures).toEqual([expect.not.objectContaining({ filename: expect.any(String) })])
  })

  it('keeps a synthetic filename for a single saved file with an incompatible type', () => {
    const figures = resolveNotebookRunFigures(
      makeRun({
        outputs: [{ type: 'display', data: { 'image/png': 'QUJD' } }],
        workingFiles: [
          {
            path: '/workspace/report.pdf',
            relativePath: 'report.pdf',
            kind: 'other',
            createdByRunId: 'r1'
          }
        ]
      })
    )

    expect(figures).toEqual([expect.not.objectContaining({ filename: expect.any(String) })])
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

  it('keeps timeout diagnostics neutral', () => {
    render(
      [{ type: 'error', message: 'execution limit reached', traceback: 'execution limit reached' }],
      {
        status: 'timeout'
      }
    )

    const output = container.querySelector('[data-testid="notebook-text-output"] pre')
    expect(output?.className).toContain('text-text-200')
    expect(output?.className).not.toContain('text-danger-000')
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
