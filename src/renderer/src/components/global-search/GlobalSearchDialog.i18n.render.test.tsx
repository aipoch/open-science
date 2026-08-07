// @vitest-environment jsdom
// Proves the command palette reads its chrome, row metadata, and shortcut footer from the catalog:
// it renders in English, then re-renders in both Chinese locales after a language change. Catalog
// parity tests can't catch a component that never calls t() at all.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import type { ChatSession } from '@/stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'

import { GlobalSearchDialog } from './GlobalSearchDialog'

let container: HTMLDivElement
let root: Root

const day = 24 * 60 * 60 * 1_000

const artifact = {
  id: 'artifact-1',
  source: 'artifact' as const,
  sourceFileId: 'artifact-1',
  sourceVersionId: 'version-1',
  projectId: 'project-a',
  sessionId: 'session-a',
  name: 'sin.png',
  path: 'artifact-version:project-a/session-a/artifact-1/version-1',
  size: 12,
  sortAtMs: Date.now() - 3 * day,
  originSession: { state: 'active' as const }
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

const bodyText = (): string => document.body.textContent ?? ''

const ariaLabels = (): (string | null)[] =>
  [...document.body.querySelectorAll('[role="group"]')].map((group) =>
    group.getAttribute('aria-label')
  )

const shortcutFooterText = (): string =>
  document.body.querySelector('[data-testid="global-search-footer"]')?.textContent ?? ''

// Artifact rows carry a thumbnail and repeat their origin Session's title, so match on the absence
// of the thumbnail rather than on the title text.
const sessionRowText = (): string =>
  [...document.body.querySelectorAll('[role="option"]')].find(
    (option) => option.querySelector('[data-testid="global-search-artifact-thumbnail"]') === null
  )?.textContent ?? ''

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
  useProjectStore.setState({
    ...createInitialProjectState(),
    isLoaded: true,
    projects: [
      {
        id: 'project-a',
        name: 'Alpha',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 2
      }
    ]
  })
  useSessionStore.setState({
    ...createInitialSessionState(),
    selectedSessionId: 'session-a',
    sessions: [
      {
        id: 'session-a',
        projectId: 'project-a',
        title: 'Python 绘制 sin 函数图',
        cwd: '/workspace',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now() - 3 * day,
        messages: [],
        artifacts: []
      }
    ] as ChatSession[]
  })
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-a',
    userNavigationRevision: 0,
    explicitNavigationRevision: 0,
    pendingCustomizePrefill: undefined,
    pendingArtifactMention: undefined,
    artifactMentionAvailability: { projectId: 'project-a', canMention: true }
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectFiles: {
        searchArtifacts: vi.fn().mockResolvedValue({
          primary: { items: [artifact], totalCount: 1 },
          other: [],
          isIndexComplete: true
        })
      },
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'preview-resource-1',
          url: 'open-science-preview://preview-resource-1',
          mimeType: 'image/png'
        }),
        release: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  switchTo('en')
})

const openPalette = async (): Promise<void> => {
  await act(async () => {
    root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
}

// React tracks the input's value on the node, so a plain assignment is invisible to it.
const search = async (value: string): Promise<void> => {
  const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  await act(async () => {
    valueSetter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 180))
  })
}

describe('GlobalSearchDialog i18n', () => {
  it('translates the section headings and their group labels', async () => {
    await openPalette()
    expect(ariaLabels()).toEqual(['Recent artifacts', 'Recent sessions', 'Commands'])
    expect(bodyText()).toContain('New session')

    switchTo('zh-Hans')
    expect(ariaLabels()).toEqual(['最近的产物', '最近会话', '命令'])
    expect(bodyText()).toContain('新建会话')

    switchTo('zh-Hant')
    expect(ariaLabels()).toEqual(['最近的產物', '最近會話', '命令'])
    expect(bodyText()).toContain('新增會話')
  })

  it('translates the search placeholder and the accessible dialog title', async () => {
    await openPalette()
    const placeholder = (): string | null =>
      document.body
        .querySelector<HTMLInputElement>('input[role="combobox"]')
        ?.getAttribute('placeholder') ?? null

    expect(placeholder()).toBe('Search this project…')
    expect(bodyText()).toContain('Command palette')

    switchTo('zh-Hans')
    expect(placeholder()).toBe('在此项目中搜索…')
    expect(bodyText()).toContain('命令面板')

    switchTo('zh-Hant')
    expect(placeholder()).toBe('在這個專案中搜尋…')
  })

  it('translates the shortcut footer', async () => {
    await openPalette()
    expect(shortcutFooterText()).toBe('↑↓navigate↵open⇧↵mentionescclose')

    switchTo('zh-Hans')
    expect(shortcutFooterText()).toBe('↑↓切换↵打开⇧↵提及esc关闭')

    switchTo('zh-Hant')
    expect(shortcutFooterText()).toBe('↑↓切換↵開啟⇧↵提及esc關閉')
  })

  it('renders the row metadata — artifact count and elapsed time — through the catalog', async () => {
    await openPalette()
    expect(sessionRowText()).toContain('0 artifacts · 3 days ago')

    switchTo('zh-Hans')
    expect(sessionRowText()).toContain('0 个产物 · 3 天前')

    switchTo('zh-Hant')
    expect(sessionRowText()).toContain('0 個產物 · 3 天前')
  })

  it('pluralizes the English artifact count and elapsed unit, and keeps Chinese uninflected', async () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      sessions: [
        {
          ...useSessionStore.getState().sessions[0],
          artifacts: [{ id: 'a-1' }],
          updatedAt: Date.now() - day
        }
      ] as ChatSession[]
    })
    await openPalette()
    expect(sessionRowText()).toContain('1 artifact · 1 day ago')

    switchTo('zh-Hans')
    expect(sessionRowText()).toContain('1 个产物 · 1 天前')
  })

  it('translates the no-match empty state and interpolates the query', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        projectFiles: {
          searchArtifacts: vi.fn().mockResolvedValue({
            primary: { items: [], totalCount: 0 },
            other: [],
            isIndexComplete: true
          })
        }
      }
    })
    await openPalette()
    await search('cosine')

    expect(bodyText()).toContain('No sessions or artifacts match “cosine”.')

    switchTo('zh-Hans')
    expect(bodyText()).toContain('没有会话或产物匹配“cosine”。')

    switchTo('zh-Hant')
    expect(bodyText()).toContain('沒有會話或產物符合「cosine」。')
  })

  it('translates the artifact load failure into a retry row', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        projectFiles: { searchArtifacts: vi.fn().mockRejectedValue('not an Error') }
      }
    })
    await openPalette()
    await search('sin')

    expect(bodyText()).toContain('Could not load artifacts — retry')

    switchTo('zh-Hans')
    expect(bodyText()).toContain('无法加载产物 —— 重试')

    switchTo('zh-Hant')
    expect(bodyText()).toContain('無法載入產物 —— 重試')
  })
})
