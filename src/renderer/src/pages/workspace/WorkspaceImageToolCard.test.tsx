// @vitest-environment jsdom
import { ImageToolPreviewContext } from './image-tool-preview-context'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceImageToolCard, WorkspaceImageToolOutput } from './WorkspaceImageToolCard'
import { i18next } from '@/i18n'

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
        collapseSettings
      />
    )
  )
  expect(container.textContent).toContain('Source image: input.png')
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

it.each([
  ['CANCELLED', 'Image request cancelled before submission.'],
  ['OUTCOME_UNKNOWN', 'Image result unconfirmed.'],
  ['QUOTA_EXCEEDED', 'Image quota exhausted.']
] as const)('renders %s with a distinct, actionable notice', async (code, text) => {
  await i18next.changeLanguage('en')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(<WorkspaceImageToolCard operation="edit" input={{}} error={{ code }} />)
  )
  expect(container.textContent).toContain(text)
  expect(container.textContent).not.toContain('Image editing failed.')
  expect(container.textContent).not.toContain('may have charged')
  expect(container.textContent).not.toContain('HTTP ')
})
