// @vitest-environment jsdom
import type { ComposerDraft } from './pages/workspace/composer-contract'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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
vi.mock('@/lib/theme', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/theme')>()),
  applyTheme: vi.fn(),
  resolveInitialTheme: () => 'light'
}))
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

beforeEach(() => {
  vi.resetModules()
  root.render.mockClear()
  document.documentElement.removeAttribute('data-open-science-web-events')
  document.body.innerHTML = '<div id="root"></div>'
  window.api = {} as Window['api']
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-open-science-web-events')
  localStorage.clear()
  sessionStorage.clear()
})

const draft = (text: string): ComposerDraft => ({
  doc: { nodes: [{ type: 'text', text }] },
  annotations: [],
  attachments: [],
  attachmentTransfers: [],
  automaticReadingEnabled: true
})

it('keeps the Web bootstrap authorization scope and tab storage when loading the shared entry', async () => {
  document.documentElement.setAttribute('data-open-science-web-events', '')
  const storage = await import('./pages/workspace/composer-draft-storage')
  storage.configureComposerDraftStorage('paired-host/principal')
  storage.writeComposerDraft('project', 'session', draft('Web draft'))

  await import('./main')
  await vi.waitFor(() => expect(root.render).toHaveBeenCalledOnce())
  expect(storage.readComposerDraft('project', 'session', 'retry')?.doc.nodes).toEqual(
    draft('Web draft').doc.nodes
  )
  storage.writeComposerDraft('project', 'session', draft('edited Web draft'))
  const saved = JSON.parse(sessionStorage.getItem('open-science-composer-drafts-v1')!)
  expect(saved.scope).toBe('paired-host/principal')
  expect(saved.drafts[0].text).toBe('edited Web draft')
  expect(localStorage.getItem('open-science-composer-drafts-v1')).toBeNull()
  storage.revokeComposerDraftStorage()
  expect(sessionStorage.getItem('open-science-composer-drafts-v1')).toBeNull()
})

it('initializes desktop profile storage through the shared entry before rendering', async () => {
  const storage = await import('./pages/workspace/composer-draft-storage')
  storage.configureComposerDraftStorage('desktop-profile', 'profile')
  storage.writeComposerDraft('project', 'session', draft('desktop draft'))
  // Simulate a fresh renderer module lifetime with only the profile storage remaining.
  vi.resetModules()
  await import('./main')
  await vi.waitFor(() => expect(root.render).toHaveBeenCalledOnce())
  const restarted = await import('./pages/workspace/composer-draft-storage')
  expect(restarted.readComposerDraft('project', 'session', 'retry')?.doc.nodes).toEqual(
    draft('desktop draft').doc.nodes
  )
  restarted.writeComposerDraft('project', 'session', draft('edited desktop draft'))
  expect(localStorage.getItem('open-science-composer-drafts-v1')).toContain('edited desktop draft')
  expect(sessionStorage.getItem('open-science-composer-drafts-v1')).toBeNull()
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
