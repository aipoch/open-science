import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import { i18next } from '@/i18n'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSearchMessageFocusStore } from '@/stores/search-message-focus-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import type { LiteratureItemView } from '../../../../shared/literature'
import { GlobalSearchDialog } from './GlobalSearchDialog'

export const artifact = {
  id: 'artifact-1',
  source: 'artifact' as const,
  sourceFileId: 'artifact-1',
  sourceVersionId: 'version-1',
  projectId: 'project-a',
  sessionId: 'session-a',
  name: 'sin.png',
  path: 'artifact-version:project-a/session-a/artifact-1/version-1',
  size: 12,
  sortAtMs: 123,
  originSession: { state: 'active' as const }
}
export const upload = {
  ...artifact,
  id: 'upload-1',
  source: 'upload' as const,
  sourceFileId: 'upload-1',
  name: 'input.csv'
}
export const message = {
  projectId: 'project-a',
  sessionId: 'session-a',
  sessionNumber: 12,
  sessionTitle: 'Alpha session',
  messageId: 'hit-message',
  role: 'agent' as const,
  content: 'Line one\nLine two\nLine three\nsin matched\nLine five\nLine six\nLine seven',
  createdAt: 3
}
export const literature: LiteratureItemView = {
  id: 'paper',
  item: {
    itemType: 'journalArticle',
    title: 'Sine literature',
    abstract: 'A wave abstract',
    issuedText: '2024',
    issuedYear: 2024,
    containerTitle: 'Journal',
    shortTitle: '',
    language: '',
    rights: '',
    url: '',
    extra: '',
    typeFields: {},
    creators: [],
    identifiers: []
  },
  attachments: [],
  projectIds: [],
  collectionIds: [],
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 2
}
export const collection = {
  id: 'collection',
  name: 'Wave collection',
  description: 'Wave references',
  itemCount: 12,
  createdAt: 1,
  updatedAt: 2
}
export const makeSession = (index: number): ChatSession => ({
  id: index ? `session-${index}` : 'session-a',
  projectId: 'project-a',
  title: `Alpha session ${index}`,
  number: index + 12,
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: 100 - index,
  messages: [],
  activeMessageCount: 15,
  contentLoaded: false,
  artifacts: []
})
let container: HTMLDivElement
let root: Root
export const onClose = vi.fn()
export const setupSearch = (): void => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  previewLeaveGuards.clear()
  onClose.mockReset()
  window.localStorage.clear()
  useProjectStore.setState({
    ...createInitialProjectState(),
    isLoaded: true,
    projects: [
      {
        id: 'project-a',
        name: 'Alpha',
        description: 'Wave research',
        isExample: false,
        createdAt: 1,
        updatedAt: 2
      },
      {
        id: 'project-b',
        name: 'Beta',
        description: 'Second research',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  useSessionStore.setState({
    ...createInitialSessionState(),
    selectedSessionId: 'session-a',
    sessions: [
      makeSession(0),
      { ...makeSession(1), id: 'session-b', projectId: 'project-b', title: 'Beta session' }
    ]
  })
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-a',
    userNavigationRevision: 0,
    explicitNavigationRevision: 0,
    pendingArtifactMention: undefined,
    pendingLiteratureItemId: undefined,
    pendingProjectCreation: false,
    artifactMentionAvailability: { projectId: 'project-a', canMention: true }
  })
  useSearchMessageFocusStore.setState({ pending: undefined })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      sessions: {
        searchMessages: vi
          .fn()
          .mockResolvedValue({ items: [message], totalCount: 1, isComplete: true })
      },
      projectFiles: {
        getOverview: vi.fn().mockResolvedValue({
          totalCount: 7,
          uploadCount: 3,
          artifactCount: 4,
          artifactGroupCount: 4,
          isIndexComplete: true
        }),
        searchArtifacts: vi.fn(async (request) => ({
          primary: { items: request.source === 'upload' ? [upload] : [artifact], totalCount: 1 },
          other: [],
          isIndexComplete: true
        }))
      },
      literature: {
        search: vi.fn().mockResolvedValue({ entries: [literature, collection], totalCount: 2 })
      },
      managedFileVersions: {
        inspect: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            sessionId: 'session-a',
            displayName: 'current.png',
            headVersionId: 'version-2',
            versions: [
              {
                id: 'version-2',
                checksum: 'head-checksum',
                contentType: 'image/png',
                sizeBytes: 24,
                createdAt: '2026-01-01T00:00:00.000Z'
              }
            ]
          }
        })
      },
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'preview',
          url: 'data:image/png;base64,',
          mimeType: 'image/png'
        }),
        release: vi.fn()
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
}
export const teardownSearch = (): void => {
  act(() => root.unmount())
  container.remove()
  previewLeaveGuards.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  void i18next.changeLanguage('en')
}
export const renderSearch = async (open = true): Promise<void> => {
  await act(async () => {
    root.render(<GlobalSearchDialog open={open} onOpenChange={onClose} isSessionPersistenceReady />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
export const input = (): HTMLInputElement => document.body.querySelector('input[role="combobox"]')!
export const search = async (query: string): Promise<void> => {
  act(() => fireEvent.change(input(), { target: { value: query } }))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180))
  })
}
export const rows = (category?: string): HTMLElement[] => [
  ...document.body.querySelectorAll<HTMLElement>(
    `${category ? `[data-search-group="${category}"] ` : ''}[role="option"]`
  )
]
export const clickRow = (category: string, index = 0): void => {
  act(() => rows(category)[index]!.click())
}
export const button = (text: string): HTMLButtonElement =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === text
  )!
export const detail = (): HTMLElement =>
  document.body.querySelector('[data-testid="global-search-detail"]')!
