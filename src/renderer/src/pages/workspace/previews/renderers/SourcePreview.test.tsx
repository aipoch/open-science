// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'
import { NotebookCodeBlock } from '../../notebook-code'

const PaginatedSource = ({
  maxBytes,
  fileId = 'file-1'
}: {
  maxBytes: number
  fileId?: string
}): React.JSX.Element => {
  const state = usePreviewFileContent({
    projectId: 'project-1',
    managedFileId: fileId,
    path: '/managed/source.txt',
    source: 'artifact',
    maxBytes
  })
  return state.status === 'ready' ? (
    <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  ) : (
    <div>{state.status}</div>
  )
}

const installFile = (content: string): void => {
  const bytes = new TextEncoder().encode(content)
  window.api = {
    previewResources: {
      acquire: vi.fn().mockResolvedValue({
        id: 'resource-1',
        url: 'https://preview.test/resource-1',
        size: bytes.length,
        mimeType: 'text/plain',
        version: 1
      }),
      release: vi.fn().mockResolvedValue(undefined)
    }
  } as unknown as Window['api']
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      const range = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/u)
      if (!range) throw new Error('Expected a byte Range request.')
      const begin = Number(range[1])
      const end = Math.min(Number(range[2]) + 1, bytes.length)
      return new Response(bytes.slice(begin, end), {
        status: 206,
        headers: { 'Content-Range': `bytes ${begin}-${end - 1}/${bytes.length}` }
      })
    })
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Source preview display bounds and locations', () => {
  it('bounds rendered rows for dense newlines and offers continued viewing', () => {
    const html = renderToStaticMarkup(<SourcePreviewContent content={'\n'.repeat(65_536)} />)
    const rows = html.match(/data-testid="source-line-number"/g)?.length ?? 0
    // A generous display ceiling, independent of the eventual page-size tuning.
    expect(rows).toBeLessThanOrEqual(10_000)
    expect(html).toContain('Next preview page')
  })

  it('preserves notebook line numbering and the highlighted error line', () => {
    const { container } = render(<NotebookCodeBlock code={'first\nsecond'} highlightLine={2} />)
    const numbers = [...container.querySelectorAll('[data-testid="source-line-number"]')]
    expect(numbers.map((number) => number.textContent)).toEqual(['1', '2'])
    expect(numbers[0].parentElement?.className).not.toContain('bg-danger-900')
    expect(numbers[1].parentElement?.className).toContain('bg-danger-900')
  })

  it('renders one row for equally sized text without newlines', () => {
    const html = renderToStaticMarkup(<SourcePreviewContent content={'x'.repeat(65_536)} />)
    expect(html.match(/data-testid="source-line-number"/g)).toHaveLength(1)
  })

  it('keeps file line numbers across byte pages without changing the pinned resource', async () => {
    const content = 'alpha\nbeta\ngamma'
    installFile(content)
    const { container } = render(<PaginatedSource maxBytes={8} />)
    const displayed: Array<{ text: string; numbers: number[]; expected: number[] }> = []
    let offset = 0
    for (let page = 0; page < 10; page += 1) {
      await waitFor(() => expect(container.querySelector('code')).not.toBeNull())
      const cells = [...container.querySelectorAll('[data-testid="source-line-number"]')]
      const lines = cells.map((cell) =>
        (cell.nextElementSibling?.textContent ?? '').replace(/\u00a0/g, '')
      )
      const text = lines.join('\n')
      const startingLine = content.slice(0, offset).split('\n').length
      displayed.push({
        text,
        numbers: cells.map((cell) => Number(cell.textContent)),
        expected: lines.map((_line, index) => startingLine + index)
      })
      offset += text.length
      const next = container.querySelector<HTMLButtonElement>('[aria-label="Next preview page"]')
      if (!next || next.disabled) break
      fireEvent.click(next)
    }
    expect(displayed.map((page) => page.text).join('')).toBe(content)
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    expect(displayed.map((page) => page.numbers)).toEqual(displayed.map((page) => page.expected))
  })

  it('discloses a continued line when a long line exceeds the byte budget', async () => {
    installFile('abcdefghijklmnop')
    const { container, getByRole } = render(<PaginatedSource maxBytes={8} />)
    await waitFor(() => expect(container.querySelector('code')).not.toBeNull())
    fireEvent.click(getByRole('button', { name: 'Next preview page' }))
    await waitFor(() => expect(container.querySelector('code')?.textContent).toContain('ijklmnop'))
    expect(container.textContent).toMatch(/continued|continuation|fragment/i)
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
  })

  it('visits every display slice in both directions and resets for replacement content', () => {
    const lines = Array.from({ length: 4001 }, (_, index) => `row-${index + 1}`)
    const { container, getByRole, rerender } = render(
      <SourcePreviewContent content={lines.join('\n')} />
    )
    const visible = (): string[] =>
      [...container.querySelectorAll('[data-testid="source-line-number"]')].map(
        (cell) => cell.nextElementSibling?.textContent ?? ''
      )
    const collected = [...visible()]
    expect(collected).toHaveLength(2000)
    fireEvent.click(getByRole('button', { name: 'Next preview page' }))
    collected.push(...visible())
    expect(container.querySelector('[data-testid="source-line-number"]')?.textContent).toBe('2001')
    fireEvent.click(getByRole('button', { name: 'Next preview page' }))
    collected.push(...visible())
    expect(collected).toEqual(lines)
    expect((getByRole('button', { name: 'Next preview page' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    fireEvent.click(getByRole('button', { name: 'Previous preview page' }))
    expect(visible()[0]).toBe('row-2001')
    fireEvent.click(getByRole('button', { name: 'Previous preview page' }))
    expect(visible()[0]).toBe('row-1')
    fireEvent.click(getByRole('button', { name: 'Next preview page' }))
    rerender(<SourcePreviewContent content="replacement" />)
    expect(visible()).toEqual(['replacement'])
    expect(container.querySelector('button')).toBeNull()
  })

  it('returns to the last display slice of a previous byte page and resets on file switches', async () => {
    installFile('a\n'.repeat(3000) + 'b\n'.repeat(1000))
    const { container, getByRole, rerender } = render(<PaginatedSource maxBytes={6000} />)
    const firstNumber = (): string | null | undefined =>
      container.querySelector('[data-testid="source-line-number"]')?.textContent
    await waitFor(() => expect(firstNumber()).toBe('1'))
    fireEvent.click(getByRole('button', { name: 'Next preview page' }))
    expect(firstNumber()).toBe('2001')
    fireEvent.click(getByRole('button', { name: 'Next preview page' }))
    await waitFor(() => expect(firstNumber()).toBe('3001'))
    fireEvent.click(getByRole('button', { name: 'Previous preview page' }))
    await waitFor(() => expect(firstNumber()).toBe('2001'))
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    rerender(<PaginatedSource maxBytes={6000} fileId="file-2" />)
    await waitFor(() => expect(firstNumber()).toBe('1'))
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
  })

  it.each([1, 2, 5, 8])(
    'preserves UTF-8, CRLF, empty lines and locations with a %i-byte budget',
    async (maxBytes) => {
      const content = 'α\r\n\r\n猫\nlast\n'
      installFile(content)
      const { result } = renderHook(() =>
        usePreviewFileContent({
          projectId: 'project-1',
          managedFileId: 'file-1',
          source: 'artifact',
          path: '/managed/source.txt',
          maxBytes
        })
      )
      let consumed = ''
      for (let page = 0; page < 30; page += 1) {
        await waitFor(() => expect(result.current.status).toBe('ready'))
        const state = result.current
        if (state.status !== 'ready') throw new Error('Expected a ready page')
        expect(state.preview.content).not.toContain('�')
        expect(state.preview.content.endsWith('\r')).toBe(false)
        expect(state.pagination.startingLineNumber).toBe(consumed.split('\n').length)
        expect(state.pagination.startsMidLine).toBe(consumed.length > 0 && !consumed.endsWith('\n'))
        expect(state.pagination.byteStart).toBe(new TextEncoder().encode(consumed).length)
        consumed += state.preview.content
        expect(state.pagination.byteEnd).toBe(new TextEncoder().encode(consumed).length)
        expect(state.pagination.endsMidLine).toBe(
          state.preview.truncated && !consumed.endsWith('\n')
        )
        if (!state.pagination.hasNext) break
        act(() => state.pagination.nextPage())
      }
      expect(consumed).toBe(content)
      expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    }
  )
})
