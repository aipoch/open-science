// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NotebookOutput, NotebookRunRecord } from '../../../../shared/notebook'
import { NotebookRunOutputs } from './NotebookRunOutputs'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
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

  it('renders a figure (display image/png) inline as an image', () => {
    render([{ type: 'display', data: { 'image/png': 'QUJD' } }])

    const image = container.querySelector(
      '[data-testid="notebook-output-image"]'
    ) as HTMLImageElement
    expect(image).not.toBeNull()
    expect(image.getAttribute('src')).toBe('data:image/png;base64,QUJD')
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

    const outputs = container.querySelector('[data-testid="notebook-run-outputs"]')
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
