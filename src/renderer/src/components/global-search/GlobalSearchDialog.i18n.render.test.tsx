// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import {
  setupSearch,
  teardownSearch,
  renderSearch,
  input,
  clickRow,
  detail
} from './global-search.test-support'

vi.mock('@/pages/workspace/previews/PreviewFileContent', () => ({
  PreviewFileContent: () => <div />
}))
vi.mock('@/pages/workspace/artifact-preview', () => ({ ArtifactPreview: () => <div /> }))
beforeEach(setupSearch)
afterEach(teardownSearch)

it.each([
  [
    'en',
    'Global search',
    'Search messages, projects, files and Library…',
    'File information',
    '15 messages'
  ],
  ['zh-Hans', '全局搜索', '搜索消息、项目、文件和 Library…', '文件信息', '15 条消息'],
  ['zh-Hant', '全域搜尋', '搜尋訊息、專案、檔案和 Library…', '檔案資訊', '15 則訊息']
])(
  'renders search chrome, tabs and plural counts in %s',
  async (locale, title, placeholder, fileInfo, messages) => {
    await renderSearch()
    await act(async () => {
      await i18next.changeLanguage(locale)
    })
    expect(input().getAttribute('aria-label')).toBe(title)
    expect(input().placeholder).toBe(placeholder)
    clickRow('generated')
    expect(detail().textContent).toContain(fileInfo)
    clickRow('sessions')
    expect(detail().textContent).toContain(messages)
  }
)

it('translates partial failures without exposing the main-process error', async () => {
  vi.mocked(window.api.sessions.searchMessages).mockRejectedValue(
    new Error('Untranslated IPC failure')
  )
  await renderSearch()
  await act(async () => {
    await i18next.changeLanguage('zh-Hans')
  })
  expect(document.body.textContent).toContain('无法加载搜索结果。')
  expect(document.body.textContent).not.toContain('Untranslated IPC failure')
})
