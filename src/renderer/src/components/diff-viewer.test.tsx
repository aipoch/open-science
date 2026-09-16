// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTwoFilesPatch } from 'diff'
import { DiffViewer } from './diff-viewer'

const harness = vi.hoisted(() => ({
  plugin: undefined as unknown,
  newlineLabel: 'No newline at end of file'
}))
vi.mock('@/components/streamdown/use-code-highlighter', () => ({
  useCodeHighlighter: () => harness.plugin
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === 'No newline at end of file'
        ? harness.newlineLabel
        : key.replace('{{count}}', String(options?.count))
  })
}))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  harness.plugin = undefined
  harness.newlineLabel = 'No newline at end of file'
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const patch = (before: string, after: string): string =>
  createTwoFilesPatch('test.json', 'test.json', before, after)
const render = async (source?: string): Promise<void> => {
  await act(async () =>
    root.render(<DiffViewer name="test.json" patch={source} unavailable="Unavailable" />)
  )
}

describe('DiffViewer', () => {
  it('renders real old/new coordinates and counts without patch headers', async () => {
    await render(patch('one\nold\nlast\n', 'one\nnew\nlast\n'))
    const removed = container.querySelector('[data-diff-kind="removed"]')!
    const added = container.querySelector('[data-diff-kind="added"]')!
    expect(removed.children[0].textContent).toBe('2')
    expect(added.children[0].textContent).toBe('2')
    expect(removed.querySelector('[data-diff-deletion-rail]')?.getAttribute('aria-hidden')).toBe(
      'true'
    )
    expect(added.querySelector('[data-diff-deletion-rail]')).toBeNull()
    expect(added.className).toContain('border-diff-added-foreground')
    expect(container.textContent).not.toContain('@@')
    expect(container.querySelector('summary')?.textContent).toContain('+1')
    expect(container.querySelector('summary')?.textContent).toContain('−1')
    expect(container.textContent).not.toContain('Index:')
    expect(container.querySelector('details')?.open).toBe(false)
  })
  it.each([
    ['', 'new\n', 'added'],
    ['old\n', '', 'removed']
  ])('handles zero ranges: %s to %s', async (before, after, kind) => {
    await render(patch(before, after))
    expect(container.querySelectorAll(`[data-diff-kind="${kind}"]`)).toHaveLength(1)
    expect(container.querySelector('code')?.textContent).toMatch(/new|old/)
  })
  it('keeps separate hunk coordinates and no-final-newline notices', async () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    await render(patch(before, before.replace('line 2\n', 'changed\n').replace('line 30', 'last')))
    expect(container.querySelectorAll('[data-diff-kind="added"]')).toHaveLength(2)
    expect(container.textContent).toContain('No newline at end of file')
    const rows = container.querySelectorAll('[data-diff-kind="added"]')
    expect(rows[1].children[0].textContent).toBe('30')
    expect(
      new Set(
        [...container.querySelectorAll<HTMLElement>('[data-diff-kind]')].map(
          (row) => row.style.gridTemplateColumns
        )
      ).size
    ).toBe(1)
    expect(container.querySelectorAll('[data-diff-omitted]')).toHaveLength(1)
  })
  it('translates missing-final-newline metadata without changing source text', async () => {
    harness.newlineLabel = '文件末尾没有换行'
    await render(patch('old', 'new'))
    const notices = container.querySelectorAll('[data-diff-newline-notice]')
    expect([...notices].map((notice) => notice.textContent)).toEqual([
      harness.newlineLabel,
      harness.newlineLabel
    ])
    expect(container.textContent).not.toContain('No newline at end of file')
    expect(container.querySelector('[data-diff-kind="removed"] code')?.textContent).toContain('old')
    expect(container.querySelector('[data-diff-kind="added"] code')?.textContent).toContain('new')
  })
  it('counts leading and between-hunk omissions without inventing trailing context', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const source = createTwoFilesPatch(
      'a',
      'a',
      before,
      before.replace('line 10\n', 'changed\n').replace('line 30\n', 'updated\n'),
      '',
      '',
      { context: 2 }
    )
    await render(source)
    expect(
      [...container.querySelectorAll('[data-diff-omitted]')].map((node) => node.textContent)
    ).toEqual(['7 unchanged lines omitted', '15 unchanged lines omitted'])
    expect(container.querySelectorAll('[data-diff-kind="added"]')[1].children[0].textContent).toBe(
      '30'
    )
    expect(
      new Set(
        [...container.querySelectorAll<HTMLElement>('[data-diff-kind]')].map(
          (row) => row.style.gridTemplateColumns
        )
      ).size
    ).toBe(1)
    await render(patch('', 'new\n'))
    expect(container.querySelector('[data-diff-omitted]')).toBeNull()
  })
  it('uses parser-normalized boundaries for zero-length insertion hunks', async () => {
    await render('--- a\n+++ b\n@@ -0,0 +1,1 @@\n+first\n')
    expect(container.querySelector('[data-diff-omitted]')).toBeNull()
    expect(container.querySelector('[data-diff-kind="added"]')?.children[0].textContent).toBe('1')

    await render('--- a\n+++ b\n@@ -3,0 +4,1 @@\n+first\n@@ -8,0 +10,1 @@\n+second\n')
    expect(
      [...container.querySelectorAll('[data-diff-omitted]')].map((node) => node.textContent)
    ).toEqual(['3 unchanged lines omitted', '5 unchanged lines omitted'])
    expect(
      [...container.querySelectorAll('[data-diff-kind="added"]')].map(
        (node) => node.children[0].textContent
      )
    ).toEqual(['4', '10'])
  })
  it('escapes content and preserves malformed or multi-file patches without dropping data', async () => {
    await render(patch('', '<img src=x onerror=alert(1)>\n'))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img')
    for (const source of [
      '-old\n+new',
      '--- a\n+++ b\n@@ -1,2 +1,1 @@\n-old\n+new',
      patch('', 'first\n') + patch('', 'second\n')
    ]) {
      await render(source)
      expect(container.querySelector('pre')?.textContent).toBe(source)
    }
    await render()
    expect(container.textContent).toContain('Unavailable')
  })
  it('highlights each side separately and retains dark theme tokens', async () => {
    const highlight = vi.fn(({ code }: { code: string }) => ({
      tokens: code
        .split('\n')
        .map((content) => [{ content, color: '#123456', htmlStyle: { '--shiki-dark': '#abcdef' } }])
    }))
    harness.plugin = { supportsLanguage: () => true, getThemes: () => [], highlight }
    await render(patch('old\ncontext\n', 'new\ncontext\n'))
    expect(highlight.mock.calls.map(([input]) => input.code)).toEqual([
      'old\ncontext',
      'new\ncontext'
    ])
    const token = container.querySelector(
      '[data-diff-kind="added"] code span:last-child'
    ) as HTMLElement
    expect(token.textContent).toBe('new')
    expect(token.style.getPropertyValue('--shiki-dark')).toBe('#abcdef')
    expect(token.className).toContain('--shiki-dark')
  })
  it('preserves oversized patches and provides room for large line numbers', async () => {
    const oversized = 'x'.repeat(128 * 1024 + 1)
    await render(oversized)
    expect(container.querySelector('pre')?.textContent).toBe(oversized)
    await render('--- a\n+++ b\n@@ -10000,1 +10000,1 @@\n-old\n+new\n')
    const row = container.querySelector('[data-diff-kind="added"]') as HTMLElement
    expect(row.children[0].textContent).toBe('10000')
    expect(row.style.gridTemplateColumns).toBe('7ch minmax(0, 1fr)')
  })
  it('survives highlighting failure and rejects stale asynchronous tokens', async () => {
    const callbacks: ((result: unknown) => void)[] = []
    harness.plugin = {
      supportsLanguage: () => true,
      getThemes: () => [],
      highlight: vi.fn((_input, callback) => {
        callbacks.push(callback)
        return undefined
      })
    }
    await render(patch('', 'old\n'))
    await render(patch('', 'new\n'))
    await act(async () =>
      callbacks.forEach((callback) => callback({ tokens: [[{ content: 'WRONG', color: 'red' }]] }))
    )
    expect(container.textContent).not.toContain('WRONG')
    expect(container.textContent).toContain('new')
    harness.plugin = {
      supportsLanguage: () => true,
      getThemes: () => [],
      highlight: () => {
        throw new Error('offline')
      }
    }
    await render(patch('', 'still readable\n'))
    expect(container.textContent).toContain('still readable')
  })
})
