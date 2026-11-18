// @vitest-environment jsdom
import { ImageToolPreviewContext } from './image-tool-preview-context'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceImageToolCard, WorkspaceImageToolOutput } from './WorkspaceImageToolCard'
import { i18next } from '@/i18n'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'

const preview = vi.hoisted(() => vi.fn(() => ({ status: 'ready', url: 'blob:test-image' })))
vi.mock('./previews/useCachedPreviewImage', () => ({ useCachedPreviewImage: preview }))
vi.mock('./previews/useNearViewport', () => ({ useNearViewport: () => [vi.fn(), true] }))
let root: ReturnType<typeof createRoot> | undefined
let container: HTMLDivElement

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
})
it('keeps a long prompt on one line and lets the user inspect the whole instruction', async () => {
  await i18next.changeLanguage('en')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const prompt = 'Preserve the original arrows and labels. '.repeat(12)
  await act(async () =>
    root!.render(
      <WorkspaceImageToolCard
        operation="generate"
        input={{ prompt, filename: 'diagram.png', options: { aspect_ratio: '16:9' } }}
      />
    )
  )
  expect(container.textContent).toContain('diagram.png')
  expect(container.querySelector('p')?.classList.contains('truncate')).toBe(true)
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(container.querySelector('p')?.textContent).toBe(prompt)
  expect(container.querySelector('p')?.classList.contains('truncate')).toBe(false)
  expect(container.textContent).toContain('Aspect ratio: 16:9')
})
it('conceals protocol parameters and input IDs in provenance while retaining output settings', async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <WorkspaceImageToolCard
        operation="edit"
        input={{
          options: { aspect_ratio: '16:9', n: 1, response_format: 'b64_json' },
          source: { inputFileVersionId: 'opaque-source-version' }
        }}
        inputFilename="input.png"
        result={{ artifactId: 'artifact-1', versionId: 'version-1', filename: 'result.png' }}
        variant="provenance"
      />
    )
  )
  expect(container.textContent).toContain('Source image: input.png')
  expect(container.textContent).not.toContain('result.png')
  expect(container.textContent).not.toContain('16:9')
  const toggle = container.querySelector<HTMLButtonElement>('button')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('Aspect ratio: 16:9')
  expect(container.textContent).not.toMatch(/opaque-source-version|response_format|b64_json|n: 1/)
})

it('shows the exact generated Version outside raw tool details and opens a larger preview', async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const result = { artifactId: 'artifact-1', versionId: 'version-1', filename: 'diagram.jpg' }
  await act(async () =>
    root!.render(
      <ImageToolPreviewContext.Provider value={{ projectId: 'project-1', sessionId: 'session-1' }}>
        <WorkspaceImageToolOutput result={result} />
      </ImageToolPreviewContext.Provider>
    )
  )
  expect(preview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      selectedVersionId: 'version-1',
      managedFileId: 'artifact-1',
      imageGenerationSessionId: 'session-1'
    }),
    true
  )
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-image')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('blob:test-image')
})

it('mentions the image result Version even when a newer head is available', async () => {
  const navigation = useNavigationStore.getState()
  const sessions = useSessionStore.getState()
  const api = window.api
  const version = {
    id: 'result-version',
    checksum: 'a'.repeat(64),
    createdAt: '2026-11-15T00:00:00.000Z',
    contentType: 'image/png',
    sizeBytes: 84
  }
  const head = { ...version, id: 'newer-version', checksum: 'b'.repeat(64) }
  const inspect = vi.fn(async () => ({
    ok: true,
    value: {
      selectedVersion: version,
      headVersionId: head.id,
      headVersion: head,
      versions: [head],
      sessionId: 'session-1',
      displayName: 'diagram.png'
    }
  }))
  window.api = { managedFileVersions: { inspect } } as unknown as Window['api']
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-1',
    artifactMentionAvailability: { projectId: 'project-1', canMention: true },
    pendingArtifactMention: undefined
  })
  useSessionStore.setState({ selectedSessionId: undefined })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  try {
    await act(async () =>
      root!.render(
        <ImageToolPreviewContext.Provider
          value={{ projectId: 'project-1', sessionId: 'session-1' }}
        >
          <WorkspaceImageToolOutput
            result={{ artifactId: 'artifact-1', versionId: version.id, filename: 'diagram.png' }}
          />
        </ImageToolPreviewContext.Provider>
      )
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Mention diagram.png"]')!.click()
    )
    expect(inspect).toHaveBeenCalledWith({
      projectId: 'project-1',
      source: 'artifact',
      fileId: 'artifact-1',
      versionId: version.id
    })
    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({
      sourceVersionId: version.id,
      checksum: version.checksum
    })
  } finally {
    await act(async () => {
      useNavigationStore.setState(navigation, true)
      useSessionStore.setState(sessions, true)
      window.api = api
    })
  }
})

it.each([
  [{ code: 'CANCELLED' }, 'Image request cancelled before submission.'],
  [{ code: 'OUTCOME_UNKNOWN' }, 'Image result unconfirmed.'],
  [{ code: 'QUOTA_EXCEEDED' }, 'Image quota exhausted.'],
  [
    { code: 'QUOTA_EXCEEDED', providerCode: 'QuotaExceeded' },
    'Image usage or request limit reached.'
  ]
] as const)('renders %j with a distinct, actionable notice', async (error, text) => {
  await i18next.changeLanguage('en')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(<WorkspaceImageToolCard operation="edit" input={{}} error={error} />)
  )
  expect(container.textContent).toContain(text)
  expect(container.textContent).not.toContain('Image editing failed.')
  expect(container.textContent).not.toContain('may have charged')
  expect(container.textContent).not.toContain('HTTP ')
})
