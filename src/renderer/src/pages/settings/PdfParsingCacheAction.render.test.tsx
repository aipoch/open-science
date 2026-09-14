// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { useStorageInfoStore } from '@/stores/storage-info-store'
import { PdfParsingCacheAction } from './PdfParsingCacheAction'

it('requires confirmation, clears PDF caches and refreshes displayed storage usage', async () => {
  await i18next.changeLanguage('en')
  const clearCache = vi.fn().mockResolvedValue({ removedBytes: 120, retainedEntries: 0 })
  const refresh = vi.spyOn(useStorageInfoStore.getState(), 'refresh').mockResolvedValue({} as never)
  const previous = window.api
  window.api = { pdfStructure: { clearCache } } as unknown as Window['api']
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<PdfParsingCacheAction />))
    await act(async () => container.querySelector('button')!.click())
    expect(clearCache).not.toHaveBeenCalled()
    const confirm = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Clear'
    )!
    expect(confirm).toBeDefined()
    await act(async () => confirm.click())
    expect(clearCache).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(clearCache.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0])
    expect(container.textContent).toContain('PDF parsing results cleared.')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    window.api = previous
    refresh.mockRestore()
  }
})
