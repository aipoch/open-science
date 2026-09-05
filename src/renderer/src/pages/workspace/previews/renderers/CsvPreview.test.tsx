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
  truncated = false
): ReturnType<typeof render> => {
  const transport = createManagedPreviewTestTransport({
    read: async () => ({ content, encoding: 'utf8', size: content.length, truncated })
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
    expect(screen.getByText('Showing 2 rows · 2 columns')).toBeTruthy()
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
    expect(screen.getByText('显示 2 行 · 2 列')).toBeTruthy()
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
