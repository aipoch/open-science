// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@streamdown/code', () => ({ code: {} }))
vi.mock('@streamdown/cjk', () => ({ cjk: {} }))
vi.mock('@streamdown/math', () => ({ createMathPlugin: () => ({}) }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: {} }))
vi.mock('streamdown', () => ({
  Streamdown: (): React.JSX.Element => {
    throw new Error('synthetic Markdown renderer failure')
  }
}))

const { ManagedTextDiffTaskRunner } =
  await import('../../../../main/managed-file-versions/diff-task')
const { ManagedVersionDiffContent } = await import('./ManagedVersionDiffContent')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ManagedVersionDiffContent Markdown recovery', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.restoreAllMocks()
    container.remove()
  })

  it('shows exact raw segments without internal tags when rich Markdown rendering fails', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'markdown-diff-renderer-failure',
      before: '# Stable heading\n\nSub title two\n',
      after: '# Stable heading\n\nSub title three\n'
    })

    await act(async () => {
      root.render(
        <ManagedVersionDiffContent
          result={{ baseVersionId: 'v1', selectedVersionId: 'v2', lines }}
          format="markdown"
          name="README.md"
        />
      )
    })

    const fallback = container.querySelector('[data-managed-version-diff-fallback]')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toContain('# Stable heading')
    expect(fallback?.querySelector('del [data-managed-diff-content]')?.textContent).toBe('wo')
    expect(fallback?.querySelector('ins [data-managed-diff-content]')?.textContent).toBe('hree')
    expect(fallback?.textContent).not.toContain('managed-diff-added-')
    expect(fallback?.textContent).not.toContain('managed-diff-removed-')
  })

  it('shows the original Markdown source when a visible-character projection fails to render', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'rendered-markdown-diff-renderer-failure',
      before: 'Prefix old **stable** and **removed formatting** suffix.\n',
      after: 'Prefix new **stable** suffix.\n'
    })

    await act(async () => {
      root.render(
        <ManagedVersionDiffContent
          result={{ baseVersionId: 'v1', selectedVersionId: 'v2', lines }}
          format="markdown"
          name="README.md"
        />
      )
    })

    const fallback = container.querySelector('[data-managed-version-diff-fallback]')
    const sourceText = Array.from(fallback?.childNodes ?? [])
      .flatMap((node) =>
        node instanceof HTMLElement && (node.matches('ins') || node.matches('del'))
          ? [node.querySelector('[data-managed-diff-content]')?.textContent ?? '']
          : [node.textContent ?? '']
      )
      .join('')
    const removed = Array.from(
      fallback?.querySelectorAll('del [data-managed-diff-content]') ?? [],
      (element) => element.textContent
    )
    const added = Array.from(
      fallback?.querySelectorAll('ins [data-managed-diff-content]') ?? [],
      (element) => element.textContent
    )

    expect(sourceText).toBe('Prefix oldnew **stable** and **removed formatting** suffix.\n')
    expect(removed).toEqual(['old', 'and **removed formatting** '])
    expect(added).toEqual(['new'])
    expect(fallback?.textContent).toContain('**stable**')
    expect(fallback?.textContent).toContain('**removed formatting**')
    expect(fallback?.textContent).not.toContain('<strong>')
    expect(fallback?.textContent).not.toContain('managed-diff-added-')
    expect(fallback?.textContent).not.toContain('managed-diff-removed-')
  })

  it('marks the exact source of a complex added list item in the raw fallback', async () => {
    const addedSource = '**important** [guide](https://example.com)'
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'complex-list-diff-renderer-failure',
      before: '- stable item\n',
      after: `- stable item\n- ${addedSource}\n`
    })

    await act(async () => {
      root.render(
        <ManagedVersionDiffContent
          result={{ baseVersionId: 'v1', selectedVersionId: 'v2', lines }}
          format="markdown"
          name="README.md"
        />
      )
    })

    const fallback = container.querySelector('[data-managed-version-diff-fallback]')
    expect(fallback?.querySelector('ins [data-managed-diff-content]')?.textContent).toBe(
      addedSource
    )
    expect(fallback?.textContent).toContain('- stable item\n- ')
    expect(fallback?.textContent).not.toContain('managed-diff-added-')
  })

  it('preserves the exact CRLF source when rich Markdown rendering fails', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'markdown-diff-crlf-renderer-failure',
      before: '<h1>Old value</h1>\r\n',
      after: '<h1>New value</h1>\r\n'
    })

    await act(async () => {
      root.render(
        <ManagedVersionDiffContent
          result={{ baseVersionId: 'v1', selectedVersionId: 'v2', lines }}
          format="markdown"
          name="README.md"
        />
      )
    })

    const fallback = container.querySelector('[data-managed-version-diff-fallback]')
    const sourceText = Array.from(fallback?.childNodes ?? [])
      .flatMap((node) =>
        node instanceof HTMLElement && (node.matches('ins') || node.matches('del'))
          ? [node.querySelector('[data-managed-diff-content]')?.textContent ?? '']
          : [node.textContent ?? '']
      )
      .join('')

    expect(sourceText).toBe('<h1>OldNew value</h1>\r\n')
    expect(fallback?.textContent).not.toContain('managed-diff-added-')
    expect(fallback?.textContent).not.toContain('managed-diff-removed-')
  })
})
