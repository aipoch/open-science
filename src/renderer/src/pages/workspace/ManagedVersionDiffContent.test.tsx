// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ManagedTextDiffTaskRunner } from '../../../../main/managed-file-versions/diff-task'
import type { ManagedFileVersionDiffResult } from '../../../../shared/managed-file-versions'
import { ManagedVersionDiffContent } from './ManagedVersionDiffContent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ManagedVersionDiffContent', () => {
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

  it('renders Markdown structure and semantic inline changes without visible line numbers', async () => {
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'context',
          oldLineNumber: 990,
          newLineNumber: 990,
          segments: [{ kind: 'context', text: '# Stable heading' }]
        },
        {
          kind: 'context',
          oldLineNumber: 991,
          newLineNumber: 991,
          segments: [{ kind: 'context', text: '' }]
        },
        {
          kind: 'removed',
          oldLineNumber: 992,
          segments: [
            { kind: 'context', text: 'Sub title ' },
            { kind: 'removed', text: 'two' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 992,
          segments: [
            { kind: 'context', text: 'Sub title ' },
            { kind: 'added', text: 'three' }
          ]
        }
      ]
    }

    await act(async () => {
      root.render(<ManagedVersionDiffContent result={result} format="markdown" name="README.md" />)
    })

    expect(container.querySelector('h1')?.textContent).toBe('Stable heading')
    expect(container.querySelector('p')?.textContent).toContain('Sub title')
    const removed = container.querySelector('del')
    const added = container.querySelector('ins')
    expect(removed?.querySelector('[data-managed-diff-content]')?.textContent).toBe('two')
    expect(added?.querySelector('[data-managed-diff-content]')?.textContent).toBe('three')
    expect(removed?.querySelector('.sr-only')?.textContent).toBe('Removed: ')
    expect(added?.querySelector('.sr-only')?.textContent).toBe('Added: ')
    expect(removed?.closest('[data-diff-kind="mixed"]')?.className.split(/\s+/u)).toEqual(
      expect.arrayContaining([
        '[&_[data-managed-diff=removed]]:bg-diff-removed-highlight',
        '[&_[data-managed-diff=removed]]:line-through',
        '[&_[data-managed-diff=added]]:bg-diff-added-highlight',
        '[&_[data-managed-diff=added]]:no-underline'
      ])
    )
    expect(container.textContent).not.toMatch(/990|991|992/u)
    expect(container.querySelector('[aria-label="Added line"]')).toBeNull()
    expect(container.querySelector('[aria-label="Removed line"]')).toBeNull()
  })

  it('keeps a stable HTML wrapper rendered when only its text content changes', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'render-stable-html-wrapper-diff',
      before: '<h1 align="center">Claude Local Session Sync</h1>\n',
      after: '<h1 align="center">Claude Local Session Sync C</h1>\n'
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

    const heading = container.querySelector('h1')
    expect(heading).not.toBeNull()
    expect(heading?.getAttribute('align')).toBe('center')
    expect(heading?.firstChild?.textContent).toBe('Claude Local Session Sync')
    expect(heading?.querySelector('del[data-managed-diff="removed"]')).toBeNull()

    const additions = heading?.querySelectorAll('ins[data-managed-diff="added"]')
    expect(additions).toHaveLength(1)
    expect(additions?.[0]?.querySelector('[data-managed-diff-content]')?.textContent).toBe(' C')
    expect(container.textContent).not.toContain('<h1')
    expect(container.textContent).not.toContain('</h1>')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('highlights a changed raw segment without coloring its entire row', async () => {
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'added', text: 'new text' }]
        }
      ]
    }

    await act(async () => {
      root.render(<ManagedVersionDiffContent result={result} format="text" name="notes.txt" />)
    })

    const row = container.querySelector('[data-diff-kind="added"]')
    const added = row?.querySelector('[data-diff-segment="added"]')
    expect(row?.className).not.toContain('bg-diff-added-surface')
    expect(added?.className.split(/\s+/u)).toEqual(
      expect.arrayContaining(['bg-diff-added-highlight', 'no-underline'])
    )
    expect(added?.querySelector('[data-managed-diff-content]')?.textContent).toBe('new text')
  })

  it.each([
    { kind: 'added' as const, before: '', after: '# Added heading\n' },
    { kind: 'removed' as const, before: '# Removed heading\n', after: '' }
  ])('renders a standalone Markdown $kind block without a full-width surface', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `standalone-markdown-${fixture.kind}`,
      before: fixture.before,
      after: fixture.after
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

    const block = container.querySelector(`[data-diff-kind="${fixture.kind}"]`)
    expect(block?.querySelector('h1')).not.toBeNull()
    expect(block?.className).not.toContain(`bg-diff-${fixture.kind}-surface`)
    expect(block?.getAttribute('data-managed-diff')).toBe(fixture.kind)
  })

  it('shows exact source characters when a Markdown heading cannot stay rendered', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'raw-atx-heading-fallback',
      before: '# Old heading\n',
      after: '## New heading\n'
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

    const block = container.querySelector('[data-diff-kind="mixed"]')
    expect(block?.querySelector('pre')).not.toBeNull()
    expect(block?.querySelector('h1, h2')).toBeNull()
    expect(
      Array.from(
        block?.querySelectorAll('del [data-managed-diff-content]') ?? [],
        (element) => element.textContent
      )
    ).toEqual(['Old'])
    expect(
      Array.from(
        block?.querySelectorAll('ins [data-managed-diff-content]') ?? [],
        (element) => element.textContent
      )
    ).toEqual(['#', 'New'])
    expect(block?.className).not.toMatch(/bg-diff-(?:added|removed)-surface/u)
  })

  it('does not style unchanged Markdown semantics as version changes', async () => {
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'context',
          oldLineNumber: 1,
          newLineNumber: 1,
          segments: [
            { kind: 'context', text: 'Stable ~~removed wording~~ and <ins>inserted note</ins>.' }
          ]
        }
      ]
    }

    await act(async () => {
      root.render(<ManagedVersionDiffContent result={result} format="markdown" name="README.md" />)
    })

    const context = container.querySelector('[data-diff-kind="context"]')
    expect(context?.className).not.toContain('[&_[data-managed-diff=removed]]')
    expect(context?.className).not.toContain('[&_[data-managed-diff=added]]')
  })

  it('styles only generated changes when native deletion semantics share a mixed block', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'native-delete-in-mixed-block',
      before:
        'Stable ~~archived~~ and <del data-managed-diff="removed" aria-label="Spoofed change">spoofed</del> wording.\n\nSub title two\n',
      after:
        'Stable ~~archived~~ and <del data-managed-diff="removed" aria-label="Spoofed change">spoofed</del> wording.\n\nSub title three\n'
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

    const stableDeletion = Array.from(container.querySelectorAll('del')).find(
      (element) => element.textContent === 'archived'
    )
    expect(stableDeletion).toBeDefined()
    expect(stableDeletion?.hasAttribute('data-managed-diff')).toBe(false)
    const spoofedDeletion = Array.from(container.querySelectorAll('del')).find(
      (element) => element.textContent === 'spoofed'
    )
    expect(spoofedDeletion?.hasAttribute('data-managed-diff')).toBe(false)
    expect(spoofedDeletion?.hasAttribute('aria-label')).toBe(false)

    const removed = container.querySelector('del[data-managed-diff="removed"]')
    const added = container.querySelector('ins[data-managed-diff="added"]')
    expect(removed?.querySelector('.sr-only')?.textContent).toBe('Removed: ')
    expect(added?.querySelector('.sr-only')?.textContent).toBe('Added: ')
    expect(removed?.querySelector('[data-managed-diff-content]')?.textContent).toBe('wo')
    expect(added?.querySelector('[data-managed-diff-content]')?.textContent).toBe('hree')
    expect(removed?.hasAttribute('aria-label')).toBe(false)
    expect(added?.hasAttribute('aria-label')).toBe(false)

    const mixed = container.querySelector('[data-diff-kind="mixed"]')
    expect(mixed?.className).toContain('[&_[data-managed-diff=removed]]:bg-diff-removed-highlight')
    expect(mixed?.className).not.toContain('[&_del]:bg-diff-removed-highlight')
  })

  it('renders changed list items and table rows without highlighting stable structure', async () => {
    const runner = new ManagedTextDiffTaskRunner()
    const listLines = await runner.run({
      requestId: 'render-list-item-diff',
      before: '- old one\n- stable item\n',
      after: '- new one\n- stable item\n'
    })

    await act(async () => {
      root.render(
        <ManagedVersionDiffContent
          result={{ baseVersionId: 'v1', selectedVersionId: 'v2', lines: listLines }}
          format="markdown"
          name="README.md"
        />
      )
    })

    const listItems = container.querySelectorAll('li')
    expect(listItems).toHaveLength(2)
    expect(listItems[0]?.querySelector('del')?.textContent).toContain('old')
    expect(listItems[0]?.querySelector('ins')?.textContent).toContain('new')
    expect(listItems[1]?.textContent).toBe('stable item')
    expect(listItems[1]?.querySelector('del, ins')).toBeNull()

    const tableLines = await runner.run({
      requestId: 'render-table-row-diff',
      before: '| Name | Value |\n| --- | --- |\n| A | old |\n',
      after: '| Name | Value |\n| --- | --- |\n| A | new |\n'
    })
    await act(async () => {
      root.render(
        <ManagedVersionDiffContent
          result={{ baseVersionId: 'v1', selectedVersionId: 'v2', lines: tableLines }}
          format="markdown"
          name="README.md"
        />
      )
    })

    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('th')?.textContent).toBe('Name')
    expect(container.querySelector('th del, th ins')).toBeNull()
    expect(container.querySelector('td del')?.textContent).toContain('old')
    expect(container.querySelector('td ins')?.textContent).toContain('new')
  })

  it('preserves inline Markdown inside a standalone changed list item', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'render-standalone-complex-list-item',
      before: '- parent\n    - stable nested\n',
      after: '- parent\n    - **important** [guide](https://example.com)\n    - stable nested\n'
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

    const items = container.querySelectorAll('li')
    expect(items).toHaveLength(3)
    const marker = container.querySelector('[data-managed-diff-marker="added"]')
    const changedItem = marker?.closest('li')
    const parentItem = changedItem?.parentElement?.closest('li')
    expect(changedItem?.querySelector(':scope > [data-managed-diff-marker="added"]')).toBe(marker)
    expect(parentItem?.querySelector(':scope > [data-managed-diff-marker="added"]')).toBeNull()
    expect(changedItem?.querySelector('[data-streamdown="strong"]')?.textContent).toBe('important')
    expect(changedItem?.querySelector('[data-streamdown="link"]')?.textContent).toBe('guide')
    expect(changedItem?.closest('.managed-version-diff-markdown')).not.toBeNull()
  })

  it('keeps unsafe HTML and remote media disabled in rendered Markdown diffs', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'render-unsafe-markdown-diff',
      before: '',
      after:
        '<script>globalThis.compromised = true</script>\n\n![remote](https://example.com/image.png)\n'
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

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})
