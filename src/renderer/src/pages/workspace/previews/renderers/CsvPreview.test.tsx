// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { parse } from 'papaparse'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'

import { createManagedPreviewTestTransport } from '../managed-preview-test-support'
import { PREVIEW_TEXT_MAX_BYTES } from '../usePreviewFileContent'
import { CsvPreviewRenderer } from './CsvPreview'

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await i18next.changeLanguage('en')
})

const renderCsv = (
  content: string,
  extension = 'csv',
  truncated = false,
  bytes?: Uint8Array
): ReturnType<typeof render> => {
  const transport = createManagedPreviewTestTransport({
    read: async (_source, request) => {
      if (!bytes) return { content, encoding: 'utf8', size: content.length, truncated }
      const offset = request.offset ?? 0
      const end = Math.min(bytes.length, offset + (request.maxBytes ?? PREVIEW_TEXT_MAX_BYTES) + 3)
      return {
        content: Buffer.from(bytes.subarray(offset, end)).toString('base64'),
        encoding: 'base64',
        size: bytes.length,
        truncated: end < bytes.length
      }
    }
  })
  vi.stubGlobal('api', { previewResources: transport })
  vi.stubGlobal('fetch', transport.fetch)

  return render(
    <CsvPreviewRenderer
      item={{
        id: 'file-data',
        type: 'file',
        title: `data.${extension}`,
        name: `data.${extension}`,
        path: `artifact://data.${extension}`,
        format: 'csv',
        source: 'artifact',
        projectId: 'project-1',
        sessionId: 'session-1',
        managedFileId: 'file-data',
        selectedVersionId: 'version-1'
      }}
    />
  )
}

describe('CSV preview row count', () => {
  it.each([
    ['csv', ','],
    ['tsv', '\t']
  ])(
    'does not report the first 100 rows as the complete %s file count',
    async (extension, delimiter) => {
      const content = [
        `a${delimiter}b`,
        ...Array.from({ length: 1_000 }, (_, index) => `${index}${delimiter}x`)
      ].join('\n')
      const size = new TextEncoder().encode(content).byteLength
      expect(size).toBe(5_893)
      expect(size).toBeLessThan(PREVIEW_TEXT_MAX_BYTES)
      expect(parse(content, { delimiter, skipEmptyLines: true }).data).toHaveLength(1_001)
      expect(parse(content, { delimiter, skipEmptyLines: true, preview: 101 }).meta.truncated).toBe(
        true
      )

      const { container } = renderCsv(content, extension)

      await screen.findByRole('table')
      expect(container.querySelectorAll('tbody tr')).toHaveLength(100)
      expect(screen.getByText('Showing 100 rows · 2 columns')).toBeTruthy()
      expect(screen.queryByText('100 rows · 2 columns', { exact: true })).toBeNull()
    }
  )

  it.each([0, 1, 100])(
    'reports an exact count for a complete file with %i data rows',
    async (count) => {
      renderCsv(['a,b', ...Array.from({ length: count }, (_, i) => `${i},x`)].join('\n'))
      await screen.findByRole('table')
      expect(screen.getByText(`${count} rows · 2 columns`, { exact: true })).toBeTruthy()
    }
  )

  it('omits the total when bytes are truncated before the parser row limit', async () => {
    renderCsv('a,b\n1,x\n2,y', 'csv', true)
    await screen.findByRole('table')
    expect(screen.getByText('Showing 1 rows · 2 columns')).toBeTruthy()
    expect(screen.queryByText('2 rows · 2 columns', { exact: true })).toBeNull()
    expect(screen.queryByText('2+ rows · 2 columns', { exact: true })).toBeNull()
  })

  it('discloses the first-row header convention for headerless data', async () => {
    const { container } = renderCsv('1,2\n3,4')
    await screen.findByRole('table')
    expect(screen.getByRole('columnheader', { name: '1' })).toBeTruthy()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(screen.getByText('First row is used as column headers')).toBeTruthy()
  })

  it('counts CSV records rather than physical lines and ignores empty lines', async () => {
    renderCsv('a,b\n"first\nsecond",x\n\nthird,y\n')
    await screen.findByRole('table')
    expect(screen.getByText('2 rows · 2 columns', { exact: true })).toBeTruthy()
  })

  it('handles empty files without claiming a header exists', async () => {
    renderCsv('')
    await screen.findByRole('table')
    expect(screen.getByText('0 rows · 0 columns', { exact: true })).toBeTruthy()
    expect(screen.queryByText('First row is used as column headers')).toBeNull()
  })

  it('uses fallback labels for blank headers and leaves missing cells empty', async () => {
    const { container } = renderCsv(',b\n1')
    await screen.findByRole('table')
    expect(screen.getByRole('columnheader', { name: 'Column 1' })).toBeTruthy()
    expect(container.querySelector('tbody tr')?.lastElementChild?.textContent).toBe('')
  })
})

describe('CSV preview localization', () => {
  beforeEach(async () => {
    await i18next.changeLanguage('zh-Hans')
  })

  it.each([false, true])('localizes row and column counts (truncated: %s)', async (truncated) => {
    renderCsv('sample,value\nA,1\nB,2', 'csv', truncated)
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('sample')
    if (truncated) {
      expect(screen.queryByText('2 行 · 2 列', { exact: true })).toBeNull()
      expect(screen.queryByText('2+ 行 · 2 列', { exact: true })).toBeNull()
    } else {
      expect(screen.getByText('2 行 · 2 列', { exact: true })).toBeTruthy()
    }
    expect(screen.getByText(`显示 ${truncated ? 1 : 2} 行 · 2 列`)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/rows|columns/)
    expect(document.body.textContent).not.toContain('CSV 解析出现问题')
  })

  it('uses stable translated warning copy for malformed CSV while retaining parsed data', async () => {
    // Real Papa Parse input: the quoted field has no closing quote.
    renderCsv('sample,value\nA,"unterminated')
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('unterminated')
    expect(document.body.textContent).not.toContain('Quoted field unterminated')
    expect(screen.getByText(/CSV 解析出现问题，预览可能不完整。/)).toBeTruthy()
  })
})

describe('CSV preview data integrity', () => {
  it.each([
    ['csv', ','],
    ['tsv', '\t']
  ])('shows fields beyond the first record in %s files', async (extension, delimiter) => {
    const { container } = renderCsv(
      ['a,b', '1,2', '3,4,EXTRA_DATA'].join('\n').replaceAll(',', delimiter),
      extension
    )
    await screen.findByRole('table')
    expect(container.querySelector('tbody')?.textContent).toContain('EXTRA_DATA')
    expect(screen.getByRole('columnheader', { name: 'Column 3' })).toBeTruthy()
    expect(screen.getByText('2 rows · 3 columns', { exact: true })).toBeTruthy()
  })

  it('counts extra fields beyond the visible column limit', async () => {
    renderCsv('a,b\n' + Array.from({ length: 26 }, (_, i) => `value${i}`).join(','))
    await screen.findByRole('table')
    expect(screen.getByText('1 rows · 26 columns', { exact: true })).toBeTruthy()
    expect(screen.getByText('2 more columns hidden in this preview')).toBeTruthy()
    expect(screen.getAllByRole('columnheader')).toHaveLength(25)
  })

  it('does not present a byte-truncated number as a complete cell', async () => {
    const prefix = 'text,value\n'
    const content = prefix + 'x'.repeat(PREVIEW_TEXT_MAX_BYTES - prefix.length - 4) + ',123456\n'
    const bytes = new TextEncoder().encode(content)
    expect(
      new TextDecoder().decode(bytes.subarray(0, PREVIEW_TEXT_MAX_BYTES)).endsWith(',123')
    ).toBe(true)
    const { container } = renderCsv('', 'csv', false, bytes)
    await screen.findByRole('table')
    expect(container.querySelector('tbody [title="123"]')).toBeNull()
  })

  it.each(['LE', 'BE'])('does not silently display UTF-16%s BOM data as UTF-8', async (order) => {
    const content = 'sample\tvalue\nA\t12\n'
    const bytes = new Uint8Array(2 + content.length * 2)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 0xfeff, order === 'LE')
    for (let i = 0; i < content.length; i += 1)
      view.setUint16(2 + i * 2, content.charCodeAt(i), order === 'LE')
    renderCsv('', 'tsv', false, bytes)
    await screen.findByText(
      'UTF-16 CSV preview is not supported. Save a copy as UTF-8 to preview it.'
    )
    expect(screen.queryByRole('table')).toBeNull()
    // Either decode correctly or replace the garbled table with an encoding notice.
    expect(document.querySelector('table')?.textContent ?? '').not.toContain('\u0000')
    expect(document.querySelector('table')?.textContent ?? '').not.toContain('\ufffd')
  })

  it('does not warn about corruption for a complete single-column CSV', async () => {
    const { container } = renderCsv('value\n1\n2')
    await screen.findByRole('table')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(screen.queryByText(/CSV parsing encountered a problem/)).toBeNull()
  })
})

describe('CSV preview record boundaries', () => {
  it.each(['\n', '\r\n', '\r'])(
    'keeps complete quoted records with %j terminators and omits the partial tail',
    async (newline) => {
      const complete = ['a,b', `"first${newline}second ""quoted""",123456`].join(newline) + newline
      const { container } = renderCsv(complete + '"partial' + newline, 'csv', true)
      await screen.findByRole('table')
      expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
      expect(container.querySelector('tbody [title="123456"]')).toBeTruthy()
      expect(container.querySelector('tbody')?.textContent).toContain('quoted')
      expect(container.querySelector('tbody')?.textContent).not.toContain('partial')
      expect(
        screen.getByText('The file exceeds the preview limit. Only complete records are shown.')
      ).toBeTruthy()
      expect(screen.queryByText(/CSV parsing encountered a problem/)).toBeNull()
    }
  )

  it('keeps a complete record whose terminator coincides with the read boundary', async () => {
    const { container } = renderCsv('a,b\n1,123456\n', 'csv', true)
    await screen.findByRole('table')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.querySelector('tbody [title="123456"]')).toBeTruthy()
  })

  it.each(['a,b', '"header\n'])('does not display a partial header %j', async (content) => {
    renderCsv(content, 'csv', true)
    await screen.findByText('The preview limit was reached before a complete header could be read.')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('preserves an intact final number without a record terminator at EOF', async () => {
    const { container } = renderCsv('a,b\n1,123456')
    await screen.findByRole('table')
    expect(container.querySelector('tbody [title="123456"]')).toBeTruthy()
    expect(
      screen.queryByText('The file exceeds the preview limit. Only complete records are shown.')
    ).toBeNull()
  })

  it('decodes a UTF-8 BOM and non-ASCII cell values', async () => {
    renderCsv('', 'tsv', false, new TextEncoder().encode('\ufeffsample\tvalue\n样本\t12'))
    await screen.findByRole('table')
    expect(screen.getByRole('columnheader', { name: 'sample' })).toBeTruthy()
    expect(screen.getByText('样本')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
  })

  it('withholds a partial UTF-8 character without leaking replacement text', async () => {
    const prefix = 'a,b\n'
    const content = prefix + 'x'.repeat(PREVIEW_TEXT_MAX_BYTES - prefix.length - 1) + '样,2'
    const { container } = renderCsv('', 'csv', false, new TextEncoder().encode(content))
    await screen.findByRole('table')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0)
    expect(container.textContent).not.toContain('\ufffd')
  })

  it('explains delimiter uncertainty separately from malformed quoting', async () => {
    renderCsv('a,b\n1\n2')
    await screen.findByRole('table')
    expect(
      screen.getByText(
        'The delimiter could not be detected reliably. Commas are used in this preview.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/CSV parsing encountered a problem/)).toBeNull()
  })
})
