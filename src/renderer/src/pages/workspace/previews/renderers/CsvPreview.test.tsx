// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { createManagedPreviewTestTransport } from '../managed-preview-test-support'
import { CsvPreviewRenderer } from './CsvPreview'

const item = {
  id: 'csv-file',
  type: 'file' as const,
  title: 'data.csv',
  name: 'data.csv',
  path: 'artifact://data.csv',
  format: 'csv' as const,
  source: 'artifact' as const,
  projectId: 'project-1',
  sessionId: 'session-1',
  managedFileId: 'csv-file'
}
const read = vi.fn()

beforeEach(async () => {
  await i18next.changeLanguage('zh-Hans')
  read.mockReset()
  const transport = createManagedPreviewTestTransport({ read })
  vi.stubGlobal('api', {
    previewResources: { acquire: transport.acquire, release: transport.release }
  })
  vi.stubGlobal('fetch', transport.fetch)
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await i18next.changeLanguage('en')
})

const mockCsv = (content: string, truncated = false): void => {
  read.mockResolvedValue({ content, encoding: 'utf8', size: content.length, truncated })
}

describe('CSV preview localization', () => {
  it.each([false, true])('localizes row and column counts (truncated: %s)', async (truncated) => {
    mockCsv('sample,value\nA,1\nB,2', truncated)
    render(<CsvPreviewRenderer item={item} />)
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('sample')
    expect(screen.getByText(truncated ? '2+ 行 · 2 列' : '2 行 · 2 列')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/rows|columns/)
    expect(document.body.textContent).not.toContain('CSV 解析出现问题')
  })

  it('uses stable translated warning copy for malformed CSV while retaining parsed data', async () => {
    // Real Papa Parse input: the quoted field has no closing quote.
    mockCsv('sample,value\nA,"unterminated')
    render(<CsvPreviewRenderer item={item} />)
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('unterminated')
    expect(document.body.textContent).not.toContain('Quoted field unterminated')
    expect(screen.getByText(/CSV 解析出现问题，预览可能不完整。/)).toBeTruthy()
  })
})
