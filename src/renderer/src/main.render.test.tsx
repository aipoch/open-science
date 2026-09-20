// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>()
  return {
    ...actual,
    createRoot: (container: Element, options: Parameters<typeof actual.createRoot>[1]) =>
      container.id === 'root' ? root : actual.createRoot(container, options)
  }
})
vi.mock('./App', () => ({
  default: () => {
    throw new Error('Main view render failed')
  }
}))
vi.mock('@/components/streamdown/install-streamdown', () => ({ installStreamdown: vi.fn() }))
vi.mock('@/lib/locale-preference', () => ({
  applyHtmlLang: vi.fn(),
  resolveInitialLocale: () => 'en'
}))
vi.mock('@/lib/theme', () => ({ applyTheme: vi.fn(), resolveInitialTheme: () => 'light' }))
vi.mock('@/stores/network-store', () => ({ startNetworkMonitor: vi.fn() }))
vi.mock('./renderer-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./renderer-diagnostics')>()),
  installRendererFailureDiagnostics: vi.fn()
}))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: { getState: () => ({ view: 'workspace' }) }
}))
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('@/stores/locale-store', () => ({ startLocalePreferenceSync: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('contains a main-view render failure in the real root composition and offers recovery', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  window.api = {} as Window['api']
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await import('./main')
  expect(root.render).toHaveBeenCalledOnce()
  const tree = root.render.mock.calls[0][0] as ReactNode
  // Mount exactly the tree supplied by the production entry point. Only the failing view and
  // unrelated bootstrap side effects are doubled; no boundary is added by this test.
  expect(() => render(tree)).not.toThrow()
  expect(screen.queryAllByRole('button').length).toBeGreaterThan(0)
})
