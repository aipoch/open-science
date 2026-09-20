// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { APP_ICON_VARIANT_INFOS } from '../../../../shared/settings'
import { AppIconSection } from './AppIconSection'

// Actual built-in metadata, matching buildAppIconPreviews' output; only the PNG is a fixture.
const previews = APP_ICON_VARIANT_INFOS.map((info) => ({
  ...info,
  previewDataUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
}))
let listAppIcons: ReturnType<typeof vi.fn>

beforeEach(() => {
  useSettingsStore.setState({ appIconVariant: 'light' })
  listAppIcons = vi.fn().mockResolvedValue(previews)
  vi.stubGlobal('api', { settings: { listAppIcons } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  void i18next.changeLanguage('en')
})

const mount = async (): Promise<ReturnType<typeof render>> => {
  const view = render(<AppIconSection />)
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

describe('G03 built-in app icon translations', () => {
  it('updates option text, accessible names, and tooltips when switching Chinese scripts', async () => {
    const view = await mount()
    expect(view.getAllByRole('radio')).toHaveLength(2)
    for (const [language, light, dark, description] of [
      ['zh-Hans', '浅色', '深色', '浅色 Open-Science 标志。'],
      ['zh-Hant', '淺色', '深色', '淺色 Open-Science 標誌。']
    ]) {
      await act(async () => {
        await i18next.changeLanguage(language)
      })
      const options = view.getAllByRole('radio')
      expect.soft(options.map((option) => option.textContent)).toEqual([light, dark])
      expect.soft(options.map((option) => option.getAttribute('aria-label'))).toEqual([light, dark])
      expect.soft(options[0].getAttribute('title')).toBe(description)
    }
  })
})

describe('G04 app icon preview recovery', () => {
  it('shows an actionable error and retries without remounting after a rejected request', async () => {
    listAppIcons.mockRejectedValueOnce(new Error('preview IPC rejected'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = await mount()
    expect.soft(view.queryByRole('alert')).not.toBeNull()
    const retry = view.queryByRole('button', { name: /retry/i })
    expect(retry).not.toBeNull()
    await act(async () => {
      fireEvent.click(retry!)
    })
    expect(listAppIcons).toHaveBeenCalledTimes(2)
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getAllByRole('radio')).toHaveLength(2)
  })

  it('shows loading while the preview request is pending', async () => {
    listAppIcons.mockReturnValue(new Promise(() => undefined))
    const view = await mount()
    expect(view.queryByRole('status')).not.toBeNull()
  })

  it('shows an empty result explanation instead of an empty selector', async () => {
    listAppIcons.mockResolvedValue([])
    const view = await mount()
    expect.soft(view.queryByRole('radiogroup')).toBeNull()
    expect.soft(view.queryByRole('status')).not.toBeNull()
  })

  it('does not offer a selector when the backend lacks the capability', async () => {
    vi.stubGlobal('api', { settings: {} })
    const view = await mount()
    expect(view.queryByRole('radiogroup')).toBeNull()
  })

  it('keeps the current choice identifiable when its preview is missing', async () => {
    useSettingsStore.setState({ appIconVariant: 'dark' })
    listAppIcons.mockResolvedValue([previews[0]])
    const view = await mount()
    // A selected fallback tile or an explicit status must identify the current Dark choice.
    const current =
      view.container.querySelector('[role="radio"][aria-checked="true"]') ??
      view.queryByRole('status')
    expect(current).not.toBeNull()
    expect(current?.textContent).toContain('Dark')
    expect(useSettingsStore.getState().appIconVariant).toBe('dark')
  })
})
