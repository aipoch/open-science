import type { ImageModelSettingsSnapshot } from '../../../../../shared/image-model-settings'
import { useImageModelSettingsStore } from '@/stores/image-model-settings-store'
import { useSettingsStore } from '@/stores/settings-store'
// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImageEditingProvider } from './ImageEditingProvider'
import { useImageEditing } from './image-edit-context'
import { ImageEditorBoundary } from './ImageEditor'
import { ImageEditComparison } from './ImageEditComparison'
import {
  switchImageEditorSource,
  imageEditorCandidates,
  imageEditorSource,
  type ImageEditorDraft
} from './image-editor-state'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import type { ImageEditSnapshot } from '../../../../../shared/image-edit-contract'
import type { ImageTask, ImageTaskStart } from '../../../../../shared/image-task'
import { createLinearConversationGraph } from '../../../../../shared/conversation-graph'

const { readImage } = vi.hoisted(() => ({ readImage: vi.fn() }))
vi.mock('../previews/useCachedPreviewImage', () => ({ useCachedPreviewImage: readImage }))
const serviceId = '11111111-1111-4111-8111-111111111111'
const settings = {
  availableProviders: [],
  imageModel: { serviceId, modelId: 'h3' },
  services: [
    {
      id: serviceId,
      name: 'MiniMax',
      vendorId: 'minimax',
      adapter: 'minimax',
      configured: true,
      models: [{ id: 'h3', wireModelId: 'MiniMax-H3-Image', presetId: 'minimax-h3/official' }]
    }
  ]
} satisfies ImageModelSettingsSnapshot
const item: PreviewFileItem = {
  id: 'source',
  type: 'file',
  format: 'image',
  source: 'artifact',
  projectId: 'p',
  sessionId: 's',
  managedFileId: 'source',
  artifactId: 'source',
  selectedVersionId: 'v1',
  path: 'source.png',
  name: 'source.png',
  title: 'source.png',
  mimeType: 'image/png'
}
const base = (): ChatSession => ({
  id: 's',
  projectId: 'p',
  cwd: '/workspace',
  title: 'Image',
  status: 'idle',
  agentFrameworkId: 'codex',
  messages: [],
  conversationGraph: createLinearConversationGraph({
    sessionId: 's',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }),
  createdAt: 1,
  updatedAt: 1
})
let root: Root, container: HTMLDivElement
const startTask = vi.fn(async (input: ImageTaskStart): Promise<ImageTask> => ({
  ...input,
  state: 'running',
  createdAt: 1,
  updatedAt: 1
}))
const cancelTask = vi.fn(async () => undefined)
let owner: ReturnType<typeof useImageEditing>
function Capture(): null {
  const value = useImageEditing()
  useEffect(() => {
    owner = value
  }, [value])
  return null
}
async function render(expanded = false, preview: PreviewFileItem | null = item): Promise<void> {
  await act(async () =>
    root.render(
      <ImageEditingProvider>
        <Capture />
        <div key={expanded ? 'modal' : 'panel'}>
          {preview ? (
            <ImageEditorBoundary item={preview}>
              <img alt="source" />
            </ImageEditorBoundary>
          ) : null}
        </div>
      </ImageEditingProvider>
    )
  )
}
const button = (name: string): HTMLButtonElement => {
  const result = [...document.querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === name || node.textContent === name
  )
  if (!result) throw new Error(`Missing button: ${name}`)
  return result
}
function historyImage(versionId: string): HTMLButtonElement {
  const item = container.querySelector<HTMLButtonElement>(
    `[data-image-history-version="${versionId}"]`
  )
  if (!item) throw new Error(`Missing image history node: ${versionId}`)
  return item
}
async function selectHistoryImage(versionId: string): Promise<void> {
  await act(async () => historyImage(versionId).click())
}
async function click(name: string): Promise<void> {
  await act(async () => button(name).click())
}
async function fill(label: string, value: string): Promise<void> {
  const node = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(() => {
  useImageModelSettingsStore.setState({ snapshot: undefined, loadFailed: false })
  vi.clearAllMocks()
  readImage.mockImplementation((source: PreviewFileItem) => ({
    status: 'ready',
    url: `blob:${source.selectedVersionId}`,
    width: 1200,
    height: 800
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* No browser layout in jsdom. */
      }
      disconnect(): void {
        /* No browser layout in jsdom. */
      }
      unobserve(): void {
        /* No browser layout in jsdom. */
      }
    }
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {
        /* No browser layout in jsdom. */
      }
      disconnect(): void {
        /* No browser layout in jsdom. */
      }
    }
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useSessionStore.setState({
    ...createInitialSessionState(),
    selectedSessionId: 's',
    sessions: [base()]
  })
  window.api = {
    imageTasks: { start: startTask, cancel: cancelTask, list: vi.fn(async () => []), get: vi.fn() },
    settings: { getImageModels: vi.fn(async () => settings) },
    artifacts: {
      getLineage: vi.fn(async () => undefined),
      getVersionProvenance: vi.fn(async () => ({
        contentStatus: { state: 'available' },
        evidence: {
          producer: {
            state: 'available',
            kind: 'connector',
            connector_id: 'image-model',
            tool_id: 'edit_image'
          },
          connector_execution: {
            normalized_arguments: {
              imageTaskId: 'edit1',
              presetId: 'minimax-h3/official',
              model: 'executed-h3',
              parameters: { size: '1536x1024', n: 1, response_format: 'b64_json' }
            }
          }
        }
      }))
    }
  } as unknown as Window['api']
})
afterEach(async () => {
  await act(async () => root.unmount())
  useSettingsStore.getState().closeSettings()
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('keeps region instructions across panel/modal replacement and sends one bounded snapshot', async () => {
  await render()
  await click('Edit image')
  expect(button('Pan image').getAttribute('aria-pressed')).toBe('true')
  const canvas = document.querySelector('[aria-label="Image editing canvas"]')!
  await act(async () =>
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  expect(document.querySelector('[aria-label="Region instruction"]')).toBeNull()
  await click('Mark a point')
  await act(async () =>
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  expect(
    document
      .querySelector('[aria-label="Region instruction"]')
      ?.closest('[role="dialog"]')
      ?.getAttribute('aria-label')
  ).toBe('Edit region 1')
  await fill('Region instruction', 'Warm sand')
  expect(
    document.querySelector('[aria-label="Image editing instruction"]')?.parentElement?.textContent
  ).toContain('Warm sand')
  await fill('Image editing instruction', 'Keep the coast')
  await render(true)
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Region instruction"]')?.value
  ).toBe('Warm sand')
  expect(button('Send image edit').disabled).toBe(true)
  await click('Done')
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Image editing instruction"]')?.value
  ).toBe('Keep the coast')
  await click('Send image edit')
  expect(startTask).toHaveBeenCalledTimes(1)
  expect(startTask.mock.calls[0][0].edit).toMatchObject({
    source: { sourceVersionId: 'v1' },
    naturalSize: { width: 1200, height: 800 },
    regions: [
      {
        number: 1,
        instruction: 'Warm sand',
        geometry: { kind: 'point', point: { x: 0.5, y: 0.5 } }
      }
    ]
  })
})

it('preserves a long lasso tail and the arrow release position in the same submitted snapshot', async () => {
  await render()
  await click('Edit image')
  const canvas = document.querySelector<HTMLElement>('[aria-label="Image editing canvas"]')!
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 800)
  canvas.setPointerCapture = vi.fn()
  canvas.hasPointerCapture = () => true
  canvas.releasePointerCapture = vi.fn()
  const pointer = (type: string, x: number, y: number): void => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
    Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 1 } })
    canvas.dispatchEvent(event)
  }
  await click('Lasso selection')
  await act(async () => {
    pointer('pointerdown', 725, 400)
    for (let index = 1; index <= 280; index++) {
      const angle = (index / 280) * Math.PI * 2
      pointer('pointermove', 425 + 300 * Math.cos(angle), 400 + 300 * Math.sin(angle))
    }
    pointer('pointerup', 900, 625)
  })
  await fill('Region instruction', 'Refine the selected region')
  await click('Done')
  await click('Draw an arrow')
  await act(async () => {
    pointer('pointerdown', 120, 100)
    pointer('pointermove', 450, 200)
    pointer('pointerup', 960, 480)
  })
  await fill('Region instruction', 'Change its target to teal')
  await click('Done')
  await click('Send image edit')
  const [lasso, arrow] = startTask.mock.calls[0][0].edit.regions
  expect(lasso.geometry.kind).toBe('polygon')
  if (lasso.geometry.kind !== 'polygon') throw new Error('Expected a lasso')
  expect(lasso.geometry.points).toHaveLength(256)
  expect(lasso.geometry.points[0]).toEqual({ x: 725 / 1200, y: 0.5 })
  expect(lasso.geometry.points.at(-1)).toEqual({ x: 0.75, y: 625 / 800 })
  expect(arrow.geometry).toEqual({
    kind: 'arrow',
    start: { x: 0.1, y: 0.125 },
    end: { x: 0.8, y: 0.6 }
  })
})

it('confirms one region at a time, cancels drafts and deletes with undo', async () => {
  await render()
  await click('Edit image')
  const drawKey = async (key: string): Promise<void> => {
    await act(async () => {
      document
        .querySelector('[aria-label="Image editing canvas"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }
  const current = (): ImageEditorDraft => [...owner!.drafts.values()][0]
  await click('Lasso selection')
  await drawKey(' ')
  await drawKey('ArrowRight')
  await drawKey(' ')
  await click('Draw an arrow')
  await drawKey('Enter')
  expect(current().regionDraft).toBeUndefined()
  await click('Mark a point')
  const mark = (): Promise<void> => drawKey('Enter')
  await mark()
  await mark()
  expect(current().regions).toEqual([])
  expect(current().regionDraft?.number).toBe(1)
  expect(button('Done').disabled).toBe(true)
  await click('Cancel')
  expect(current().regionDraft).toBeUndefined()
  await mark()
  await fill('Region instruction', 'Make this blue')
  await click('Done')
  expect(current().regions).toHaveLength(1)
  await mark()
  await fill('Region instruction', 'Remove this label')
  await click('Done')
  expect(current().regions).toHaveLength(2)
  await click('Delete region 1')
  expect(current().regions.map(({ number }) => number)).toEqual([2])
  await click('Undo')
  expect(current().regions.map(({ number }) => number)).toEqual([1, 2])
  await click('Edit region 1')
  await fill('Region instruction', 'An unconfirmed revision')
  await click('Cancel')
  expect(current().regions[0].instruction).toBe('Make this blue')
})

it('keeps the instructions when the assembled image edit prompt is too long', async () => {
  await render()
  await click('Edit image')
  await act(async () => {
    const id = [...owner!.drafts.keys()][0]
    owner!.update(
      id,
      (draft) =>
        draft && {
          ...draft,
          prompt: 'a'.repeat(16000),
          regions: Array.from({ length: 4 }, (_, index) => ({
            id: `region-${index + 1}`,
            number: index + 1,
            instruction: 'b'.repeat(4000),
            geometry: { kind: 'point', point: { x: 0.5, y: 0.5 } }
          }))
        }
    )
  })
  await click('Send image edit')
  expect(container.textContent).toContain('Shorten the image editing instructions.')
  expect([...owner!.drafts.values()][0].regions).toHaveLength(4)
  expect(startTask).not.toHaveBeenCalled()
})

it('edits the displayed candidate directly while retaining the original identity', async () => {
  const edit: ImageEditSnapshot = {
    version: 1,
    source: imageEditorSource(item)!,
    model: settings.imageModel,
    options: {},
    naturalSize: { width: 1200, height: 800 },
    regions: []
  }
  vi.mocked(window.api.imageTasks.list).mockResolvedValue([
    {
      id: 'edit1',
      projectId: 'p',
      sessionId: 's',
      frameId: 'root-frame-s',
      branchId: 'message-branch-s',
      prompt: 'Warm sand',
      edit,
      state: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      result: {
        artifactId: 'output-file',
        versionId: 'v2',
        versionNumber: 2,
        name: 'output.png',
        mimeType: 'image/png',
        size: 1,
        checksum: 'a'.repeat(64)
      }
    }
  ])
  await render()
  await click('Edit image')
  await click('Mark a point')
  await click('Image history')
  await selectHistoryImage('v2')
  await click('Edit image')
  expect([...owner!.drafts.values()][0].source.selectedVersionId).toBe('v2')
  expect(button('Pan image').getAttribute('aria-pressed')).toBe('true')
  expect(button('Mark a point').disabled).toBe(false)
  expect(document.body.textContent).not.toContain('Edit this image')
  await fill('Image editing instruction', 'Keep this draft')
  await click('Compare with input image')
  expect(document.querySelector('img[alt="Before edit"]')?.getAttribute('src')).toBe('blob:v1')
  expect(document.querySelector('img[alt="After edit"]')?.getAttribute('src')).toBe('blob:v2')
  expect(button('Mark a point').disabled).toBe(true)
  const slider = document.querySelector('[role="slider"]')!
  await act(async () =>
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  )
  expect(slider.getAttribute('aria-valuenow')).toBe('100')
  await act(async () =>
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(document.querySelector('img[alt="After edit"]')).toBeNull()
  expect(document.activeElement).toBe(button('Compare with input image'))
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Image editing instruction"]')?.value
  ).toBe('Keep this draft')
  await click('Image history')
  expect(historyImage('v2').getAttribute('aria-pressed')).toBe('true')
  await selectHistoryImage('v1')
  await click('Edit image')
  expect([...owner!.drafts.values()][0].source.selectedVersionId).toBe('v1')
  await click('Image history')
  await selectHistoryImage('v2')
  await click('Edit image')
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Image editing instruction"]')?.value
  ).toBe('Keep this draft')
  await fill('Image editing instruction', '')
  await click('Mark a point')
  await act(async () =>
    document
      .querySelector('[aria-label="Image editing canvas"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  await fill('Region instruction', 'Another edit')
  await click('Done')
  await click('Compare with input image')
  await act(async () =>
    document
      .querySelector('[aria-label="Image editing instruction"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  )
  expect(startTask).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[aria-label="Image comparison"]')).toBeNull()
  expect(startTask.mock.calls[0][0]).toMatchObject({
    prompt: '',
    edit: { source: { sourceVersionId: 'v2' }, regions: [{ instruction: 'Another edit' }] }
  })
  expect(window.api.artifacts.getVersionProvenance).not.toHaveBeenCalled()
  await click('Image generation details')
  expect(document.body.textContent).toContain('executed-h3')
  const parameters = button('Output settings')
  expect(parameters.getAttribute('aria-expanded')).toBe('false')
  expect(document.body.textContent).not.toContain('1536x1024')
  await click('Output settings')
  expect(parameters.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(parameters.getAttribute('aria-controls')!)).not.toBeNull()
  expect(document.body.textContent).toContain('Model')
  expect(document.body.textContent).toContain('1536x1024')
  expect(document.body.textContent).not.toContain('response_format')
  expect(document.body.textContent).not.toContain('b64_json')
  expect(document.body.textContent).toContain('Output size')
})

it('releases deleted Session drafts but preserves ordinary navigation and content unloading', async () => {
  await render()
  await click('Edit image')
  expect(owner?.drafts.size).toBe(1)
  await act(async () =>
    useSessionStore.setState({
      selectedSessionId: undefined,
      sessions: [{ ...base(), contentLoaded: false }]
    })
  )
  expect(owner?.drafts.size).toBe(1)
  await act(async () => useSessionStore.getState().deleteSession('s'))
  expect(owner?.drafts.size).toBe(0)
})

it('keeps Notebook data links out and only shows completed task candidates from the source chain', () => {
  expect(imageEditorSource({ ...item, fromNotebookDataLink: true })).toBeUndefined()
  const task: ImageTask = {
    id: crypto.randomUUID(),
    projectId: 'p',
    sessionId: 's',
    frameId: 'f',
    branchId: 'b',
    prompt: 'Edit',
    state: 'running',
    createdAt: 1,
    updatedAt: 1,
    edit: {
      version: 1,
      source: imageEditorSource(item)!,
      model: settings.imageModel,
      options: {},
      naturalSize: { width: 1200, height: 800 },
      regions: []
    }
  }
  expect(imageEditorCandidates([task], item)).toEqual([])
  task.state = 'succeeded'
  task.result = {
    artifactId: 'output-file',
    versionId: 'v2',
    versionNumber: 2,
    name: 'output.png',
    size: 1,
    checksum: 'a'.repeat(64),
    mimeType: 'image/png'
  }
  expect(imageEditorCandidates([task], item)[0].item).toMatchObject({
    managedFileId: 'output-file',
    selectedVersionId: 'v2'
  })
})

it('deduplicates the opening version and repeated candidate results', () => {
  const task = {
    state: 'succeeded',
    createdAt: 1,
    edit: { source: imageEditorSource(item)! },
    result: { artifactId: item.artifactId, versionId: 'v1' }
  } as ImageTask
  expect(imageEditorCandidates([task, task], item)).toEqual([])
  task.result = { ...task.result!, versionId: 'v2' }
  expect(imageEditorCandidates([task, task], item)).toHaveLength(1)
})

it('preserves all meaningful version drafts at capacity and permits switching to a cached draft', () => {
  let draft: ImageEditorDraft = {
    owner: { sessionId: 's' },
    source: item,
    prompt: 'keep 0',
    regions: [],
    options: {},
    undo: [],
    redo: [],
    tool: 'pan'
  }
  for (let i = 2; i <= 9; i++) {
    draft = switchImageEditorSource(draft, { ...item, selectedVersionId: `v${i}` })
    draft = { ...draft, prompt: `keep ${i}` }
  }
  const blocked = switchImageEditorSource(draft, { ...item, selectedVersionId: 'v10' })
  expect(blocked.source.selectedVersionId).toBe('v9')
  expect(blocked.sourceSwitchBlocked).toBe(true)
  expect(blocked.versionDrafts).toEqual(draft.versionDrafts)
  const restored = switchImageEditorSource(blocked, item)
  expect(restored.prompt).toBe('keep 0')
  expect(restored.sourceSwitchBlocked).toBe(false)
  expect(
    switchImageEditorSource({ ...blocked, prompt: '' }, { ...item, selectedVersionId: 'v10' })
      .source.selectedVersionId
  ).toBe('v10')
})

it.each(['codex', 'open-science-agent'] as const)(
  'sends confirmed regions independently while %s chat is running',
  async (agentFrameworkId) => {
    useSessionStore.setState({ sessions: [{ ...base(), agentFrameworkId, status: 'running' }] })
    await render()
    await click('Edit image')
    expect(button('Send image edit').disabled).toBe(true)
    await click('Select a rectangle')
    expect(button('Select a rectangle').getAttribute('aria-pressed')).toBe('true')
    await click('Mark a point')
    await act(async () =>
      document
        .querySelector('[aria-label="Image editing canvas"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    await fill('Region instruction', 'Change this color')
    expect(button('Send image edit').disabled).toBe(true)
    await click('Done')
    expect(button('Send image edit').disabled).toBe(false)
    await click('Send image edit')
    expect(startTask).toHaveBeenCalledTimes(1)
    expect(startTask.mock.calls[0][0]).toMatchObject({
      prompt: '',
      edit: { regions: [{ instruction: 'Change this color' }] }
    })
  }
)

it('allows local tools and links to image services when no model can edit', async () => {
  vi.mocked(window.api.settings.getImageModels).mockResolvedValue({
    ...settings,
    imageModel: undefined,
    services: []
  } as never)
  await render()
  await click('Edit image')
  await click('Select a rectangle')
  expect(button('Select a rectangle').getAttribute('aria-pressed')).toBe('true')
  await fill('Image editing instruction', 'Keep this until a model is configured')
  expect(button('Send image edit').disabled).toBe(true)
  await act(async () =>
    button('Image model').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    )
  )
  expect(document.body.textContent).toContain('No model available')
  const configure = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === 'Image services'
  )!
  await act(async () => configure.click())
  expect(useSettingsStore.getState().pendingSettingsIntent?.route).toEqual({
    panel: 'model',
    view: { kind: 'image-services' }
  })
  expect([...owner!.drafts.values()][0].prompt).toBe('Keep this until a model is configured')
})

it('edits parameters in the model submenu without menu typeahead consuming the input', async () => {
  await render()
  await click('Edit image')
  await act(async () =>
    button('Image model').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    )
  )
  const settingsItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent === 'Output settings'
  )!
  await act(async () => settingsItem.click())
  const input = document.querySelector<HTMLInputElement>('input[placeholder="16:9"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true }))
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '4:3')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect([...owner!.drafts.values()][0].options).toMatchObject({ aspect_ratio: '4:3' })
  expect(document.activeElement).toBe(input)
  expect(input.isConnected).toBe(true)
})

const taskInput = (): ImageTaskStart => ({
  id: 'task-1',
  projectId: 'p',
  sessionId: 's',
  frameId: 'root-frame-s',
  branchId: 'message-branch-s',
  prompt: 'Make it yellow',
  edit: {
    version: 1,
    source: imageEditorSource(item)!,
    model: settings.imageModel,
    options: {},
    naturalSize: { width: 1200, height: 800 },
    regions: []
  }
})

it('merges late lists without dropping submitted tasks or regressing completed results', async () => {
  await render()
  let release!: (tasks: ImageTask[]) => void
  vi.mocked(window.api.imageTasks.list).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const listing = owner!.reloadTasks({ projectId: 'p', sessionId: 's' })
  await act(async () => {
    await owner!.startTask(taskInput())
  })
  await act(async () => {
    release([])
    await listing
  })
  expect(owner!.tasks).toHaveLength(1)
  const running = owner!.tasks[0]
  vi.mocked(window.api.imageTasks.list).mockResolvedValue([
    { ...running, state: 'failed', updatedAt: 2 }
  ])
  await act(async () => owner!.reloadTasks({ projectId: 'p', sessionId: 's' }))
  vi.mocked(window.api.imageTasks.list).mockResolvedValue([running])
  await act(async () => owner!.reloadTasks({ projectId: 'p', sessionId: 's' }))
  expect(owner!.tasks[0].state).toBe('failed')
})

it('releases deleted owners and ignores their late task responses', async () => {
  await render()
  await act(async () => {
    await owner!.startTask(taskInput())
  })
  const task = owner!.tasks[0]
  let release!: (tasks: ImageTask[]) => void
  vi.mocked(window.api.imageTasks.list).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const listing = owner!.reloadTasks({ projectId: 'p', sessionId: 's' })
  await act(async () => useSessionStore.getState().deleteSession('s'))
  expect(owner!.tasks).toEqual([])
  await act(async () => {
    release([task])
    await listing
  })
  expect(owner!.tasks).toEqual([])
})

it('polls every active task without resetting the interval on each status response', async () => {
  vi.useFakeTimers()
  await render()
  await act(async () => {
    await owner!.startTask(taskInput())
    await owner!.startTask({ ...taskInput(), id: 'task-2' })
  })
  const tasks = [...owner!.tasks]
  vi.mocked(window.api.imageTasks.get).mockImplementation(async ({ id }) => {
    const task = tasks.find((entry) => entry.id === id)!
    return { ...task, updatedAt: task.updatedAt + 1 }
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100)
  })
  expect(window.api.imageTasks.get).toHaveBeenCalledTimes(4)
  vi.mocked(window.api.imageTasks.get).mockResolvedValue(undefined)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(owner!.tasks).toEqual([])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(window.api.imageTasks.get).toHaveBeenCalledTimes(6)
})

it('restores each candidate draft, annotations and undo stack without persisting pixels', () => {
  const initial: ImageEditorDraft = {
    owner: { sessionId: 's' },
    source: item,
    prompt: 'first draft',
    options: {},
    regions: [],
    undo: [[]],
    redo: [],
    tool: 'point',
    zoom: { scale: 2, positionX: 4, positionY: 5 }
  }
  const second = { ...item, selectedVersionId: 'v2' }
  let draft = switchImageEditorSource(initial, second)
  expect(draft).toMatchObject({ prompt: '', tool: 'pan' })
  draft = { ...draft, prompt: 'second draft' }
  draft = switchImageEditorSource(draft, item)
  expect(draft).toMatchObject({
    prompt: 'first draft',
    undo: [[]],
    zoom: initial.zoom,
    tool: 'point'
  })
  expect(switchImageEditorSource(draft, second).prompt).toBe('second draft')
  for (let i = 3; i < 20; i++)
    draft = switchImageEditorSource(draft, { ...item, selectedVersionId: `v${i}` })
  expect(draft.versionDrafts?.size).toBe(8)
})

it('keeps cancellation in the canvas until the task settles and restores the draft', async () => {
  vi.useFakeTimers()
  await render()
  await click('Edit image')
  await fill('Image editing instruction', 'Make it yellow')
  await click('Send image edit')
  const [request] = startTask.mock.calls[0]
  const get = vi.mocked(window.api.imageTasks.get)
  const running = { ...request, state: 'running', createdAt: 1, updatedAt: 1 } as const
  get.mockResolvedValue(running)
  const instruction = '[aria-label="Image editing instruction"]'
  expect(container.querySelector(instruction)).toBeNull()
  expect(button('Stop image editing').textContent).toBe('Cancel')
  cancelTask.mockRejectedValueOnce(new Error('Cancellation connection lost'))
  await click('Stop image editing')
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Processing')
  expect(container.textContent).toContain('Could not cancel. Try again.')
  expect(container.textContent).not.toContain('Image editing failed.')
  expect(button('Stop image editing').disabled).toBe(false)
  get.mockRejectedValueOnce(new Error('Status could not be loaded'))
  await click('Stop image editing')
  expect(container.textContent).not.toContain('Could not cancel. Try again.')
  expect(cancelTask).toHaveBeenLastCalledWith({
    projectId: 'p',
    sessionId: 's',
    id: request.id
  })
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Cancelling…')
  expect(button('Stop image editing').disabled).toBe(true)
  get.mockResolvedValue({ ...running, state: 'cancelled', updatedAt: 2 })
  expect(container.textContent).toContain('Image results could not be verified.')
  await click('Refresh')
  expect(container.querySelector('[aria-label="Stop image editing"]')).toBeNull()
  expect(container.querySelector<HTMLTextAreaElement>(instruction)?.value).toBe('Make it yellow')
  expect(button('Send image edit').disabled).toBe(false)
})

it('recovers a lost admission reply using the same ID and shows reconnecting without resending', async () => {
  vi.useFakeTimers()
  await render()
  await click('Edit image')
  await fill('Image editing instruction', 'Make it yellow')
  startTask.mockRejectedValueOnce(new Error('Connection lost'))
  const get = vi.mocked(window.api.imageTasks.get)
  get.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await click('Send image edit')
  expect(container.textContent).toContain('Reconnecting to image task…')
  expect(document.querySelector('[aria-label="Image editing instruction"]')).toBeNull()
  const input = startTask.mock.calls[0][0]
  get.mockResolvedValue({ ...input, state: 'running', createdAt: 1, updatedAt: 1 })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(owner!.tasks[0].id).toBe(input.id)
  expect(get).toHaveBeenCalledWith({ projectId: 'p', sessionId: 's', id: input.id })
  expect(startTask).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain('Reconnecting to image task…')
  get.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(container.textContent).toContain('Reconnecting to image task…')
  get.mockResolvedValue({ ...input, state: 'succeeded', createdAt: 1, updatedAt: 2 })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(container.textContent).not.toContain('Reconnecting to image task…')
  expect(startTask).toHaveBeenCalledTimes(1)
})

it.each([new Error('Image task Session is unavailable.'), new TypeError('Failed to fetch')])(
  'stops automatic status checks after permanent or repeated transport errors: %s',
  async (error) => {
    vi.useFakeTimers()
    await render()
    await click('Edit image')
    await fill('Image editing instruction', 'Make it yellow')
    await click('Send image edit')
    const get = vi.mocked(window.api.imageTasks.get)
    get.mockRejectedValue(error)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(get).toHaveBeenCalledTimes(error instanceof TypeError ? 5 : 1)
    expect(container.textContent).toContain('Image results could not be verified.')
    expect(container.textContent).not.toContain('Reconnecting to image task…')
    expect(startTask).toHaveBeenCalledTimes(1)
    const task = owner!.tasks[0]
    get.mockResolvedValue({ ...task, state: 'cancelled', updatedAt: 2 })
    await click('Refresh')
    expect(owner!.tasks[0].state).toBe('cancelled')
    expect(container.textContent).not.toContain('Image results could not be verified.')
    expect([...owner!.drafts.values()][0].prompt).toBe('Make it yellow')
    expect(startTask).toHaveBeenCalledTimes(1)
  }
)

it('keeps other image tasks updating while one status request retries', async () => {
  vi.useFakeTimers()
  await render()
  const first = taskInput()
  const second = { ...taskInput(), id: 'task-2' }
  await act(async () => {
    await owner!.startTask(first)
    await owner!.startTask(second)
  })
  let secondReads = 0
  vi.mocked(window.api.imageTasks.get).mockImplementation(async ({ id }) => {
    if (id === first.id) throw new TypeError('offline')
    secondReads++
    return {
      ...second,
      state: secondReads > 1 ? 'failed' : 'running',
      createdAt: 1,
      updatedAt: secondReads + 1,
      ...(secondReads > 1 ? { error: { code: 'PROVIDER_ERROR' as const } } : {})
    }
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100)
  })
  expect(secondReads).toBe(2)
  expect(owner!.tasks.find(({ id }) => id === second.id)?.state).toBe('failed')
  expect(owner!.observationErrors?.has(first.id)).toBe(true)
  expect(startTask).toHaveBeenCalledTimes(2)
})

it('keeps all eight drafts and admits another only after an editor closes', async () => {
  await render()
  await click('Edit image')
  const [originalKey, originalDraft] = [...owner!.drafts.entries()][0]
  await act(async () => {
    owner!.update(originalKey, (draft) => ({ ...(draft ?? originalDraft), prompt: 'first draft' }))
    for (let index = 1; index <= 8; index++)
      owner!.update(`editor-${index}`, () => ({ ...originalDraft, prompt: `draft-${index}` }))
  })
  expect(owner!.drafts.size).toBe(8)
  expect(owner!.drafts.get(originalKey)?.prompt).toBe('first draft')
  expect(owner!.drafts.has('editor-8')).toBe(false)
  await act(async () => {
    owner!.update('editor-1', () => undefined)
    owner!.update('editor-8', () => ({ ...originalDraft, prompt: 'new draft' }))
  })
  expect(owner!.drafts.size).toBe(8)
  expect(owner!.drafts.get('editor-8')?.prompt).toBe('new draft')
})

it('opens a ninth image after closing empty previews and keeps written instructions', async () => {
  await render()
  await click('Edit image')
  await fill('Image editing instruction', 'Keep this draft')
  await render(false, null)

  const preview = (index: number): PreviewFileItem => ({
    ...item,
    id: `preview-${index}`,
    artifactId: `artifact-${index}`,
    managedFileId: `artifact-${index}`
  })
  for (let index = 1; index < 8; index++) {
    await render(false, preview(index))
    await click('Edit image')
    await render(false, null)
  }
  await render(false, preview(8))
  expect(button('Edit image').disabled).toBe(false)
  await click('Edit image')
  expect(button('Back to image preview')).toBeDefined()
  await render()
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Image editing instruction"]')?.value
  ).toBe('Keep this draft')
})

it('updates an open editor immediately when image settings are saved', async () => {
  await render()
  await click('Edit image')
  const updated = structuredClone(settings)
  updated.services[0].models[0].wireModelId = 'updated-model'
  window.api.settings.updateImageModels = vi.fn(async () => updated)
  await act(async () => {
    await useImageModelSettingsStore
      .getState()
      .mutate({ kind: 'bind', binding: settings.imageModel })
  })
  expect(button('Image model').textContent).toContain('updated-model')
})

it('browses older image history without replacing live tasks and selects the historical source', async () => {
  const make = (number: number): ImageTask => ({
    id: `task-${number}`,
    projectId: 'p',
    sessionId: 's',
    frameId: 'root-frame-s',
    branchId: 'message-branch-s',
    prompt: `edit ${number}`,
    state: 'succeeded',
    createdAt: number,
    updatedAt: number,
    edit: {
      version: 1,
      source: { ...imageEditorSource(item)!, sourceVersionId: number === 2 ? 'v77' : 'v1' },
      model: settings.imageModel,
      options: {},
      naturalSize: { width: 1200, height: 800 },
      regions: []
    },
    result: {
      artifactId: item.artifactId!,
      versionId: `v${number}`,
      versionNumber: number,
      name: 'history.png',
      size: 1,
      checksum: 'a'.repeat(64),
      mimeType: 'image/png'
    }
  })
  vi.mocked(window.api.artifacts.getLineage).mockResolvedValue({
    artifactId: 'source',
    filename: 'source.png',
    originSession: { sessionId: 's', state: 'active' },
    versions: [
      {
        id: 'v2',
        versionId: 'v2',
        artifactId: 'source',
        projectId: 'p',
        sessionId: 's',
        name: 'history.png',
        mimeType: 'image/png',
        size: 1,
        mtimeMs: 2,
        checksum: 'b'.repeat(64),
        versionNumber: 2,
        createdAt: '2026-11-15T00:00:00Z',
        state: 'finalized',
        basedOnVersionId: 'v1'
      }
    ]
  })
  vi.mocked(window.api.imageTasks.list).mockImplementation(async (request) =>
    !request.history
      ? [make(100)]
      : request.history.before
        ? [make(2)]
        : Array.from({ length: 32 }, (_, i) => make(100 - i))
  )
  await render()
  await click('Edit image')
  await click('Image history')
  expect(historyImage('v2').getAttribute('aria-label')).toBe('Result')
  expect(container.querySelector('section[aria-label="Image history"]')?.textContent).not.toContain(
    'results'
  )
  await click('Load more')
  expect(window.api.imageTasks.list).toHaveBeenLastCalledWith(
    expect.objectContaining({
      history: expect.objectContaining({ before: { id: 'task-69', createdAt: 69 } })
    })
  )
  expect(historyImage('v1').textContent).toContain('32 results')
  expect(historyImage('v77').closest('li')?.contains(historyImage('v2'))).toBe(true)
  expect(historyImage('v77').getAttribute('aria-label')).toMatch(/^Result \d+$/)
  expect(historyImage('v2').getAttribute('aria-label')).toBe('Result')
  expect(
    container.querySelector('[data-lineage-source="v77"][data-lineage-target="v2"] path')
  ).not.toBeNull()
  await selectHistoryImage('v2')
  await click('Edit image')
  expect([...owner!.drafts.values()][0].source.selectedVersionId).toBe('v2')
  expect(owner!.tasks.map((task) => task.result?.versionId)).toEqual(['v100'])
  expect(document.querySelector('section[aria-label="Image history"]')).toBeNull()
  await click('Compare with input image')
  expect(document.querySelector('img[alt="Before edit"]')?.getAttribute('src')).toBe('blob:v77')
  expect(document.querySelector('img[alt="After edit"]')?.getAttribute('src')).toBe('blob:v2')
  await render(true)
  await click('Compare with input image')
  expect(document.querySelector('img[alt="Before edit"]')?.getAttribute('src')).toBe('blob:v77')
})

it('opens and compares an edit from another Artifact using its persisted input edge', async () => {
  const linkage = {
    artifactId: 'source',
    filename: 'source.png',
    originSession: { sessionId: 's', state: 'active' },
    versions: [],
    imageDependencies: [
      {
        input: { ...imageEditorSource(item)!, mimeType: 'image/png', versionNumber: 1 },
        output: {
          id: 'v-foreign',
          versionId: 'v-foreign',
          artifactId: 'other-file',
          versionNumber: 1,
          projectId: 'p',
          sessionId: 's',
          name: 'other.png',
          mimeType: 'image/png',
          size: 4,
          mtimeMs: 2,
          checksum: 'b'.repeat(64),
          createdAt: '2026-11-15T00:00:00Z',
          state: 'finalized'
        }
      }
    ]
  } satisfies NonNullable<Awaited<ReturnType<typeof window.api.artifacts.getLineage>>>
  const [edge] = linkage.imageDependencies
  const anchorVersion = {
    ...edge.output,
    id: 'v-same-artifact',
    versionId: 'v-same-artifact',
    artifactId: 'source',
    basedOnVersionId: 'v1'
  }
  const related = {
    ...linkage,
    artifactId: 'other-file',
    imageDependencies: [
      edge,
      {
        input: {
          ...edge.input,
          sourceFileId: edge.output.artifactId,
          sourceVersionId: edge.output.versionId
        },
        output: {
          ...edge.output,
          id: 'v-another',
          versionId: 'v-another',
          artifactId: 'third-file'
        }
      }
    ]
  }
  const firstRelatedPage =
    Promise.withResolvers<Awaited<ReturnType<typeof window.api.artifacts.getLineage>>>()
  vi.mocked(window.api.artifacts.getLineage).mockImplementation(async (request) => {
    const { artifactId, cursor, imageCursor, imageInputOnly } = request
    if (imageInputOnly)
      return { ...linkage, imageDependencies: artifactId === 'other-file' ? [edge] : [] }
    if (artifactId !== 'other-file') return { ...linkage, versions: [anchorVersion] }
    if (!cursor && !imageCursor) return firstRelatedPage.promise
    if (imageCursor) return { ...related, imageDependencies: [], nextCursor: 'older-related' }
    return {
      ...related,
      imageDependencies: [
        {
          ...related.imageDependencies[1],
          output: {
            ...edge.output,
            versionId: 'v-older-related',
            artifactId: 'third-file'
          }
        }
      ]
    }
  })
  await render()
  await click('Edit image')
  await click('Image history')
  expect(
    container.querySelector('[data-lineage-source="v1"][data-lineage-target="v-foreign"]')
  ).not.toBeNull()
  await selectHistoryImage('v-same-artifact')
  expect(container.textContent).not.toContain('Load related images')
  await selectHistoryImage('v-foreign')
  const relatedButton = button('Load related images')
  const resultLabel = historyImage('v-foreign').getAttribute('aria-label')
  await click('Load related images')
  const history = container.querySelector('section[aria-label="Image history"]')
  expect(history?.getAttribute('aria-busy')).toBe('true')
  expect(history?.querySelector('[role="status"]')).toBeNull()
  expect(button('Load related images')).toBe(relatedButton)
  expect(relatedButton.disabled).toBe(true)
  expect(historyImage('v-foreign').getAttribute('aria-pressed')).toBe('true')
  expect(historyImage('v-foreign').getAttribute('aria-label')).toBe(resultLabel)
  await act(async () => {
    firstRelatedPage.resolve({ ...related, nextImageCursor: 'more-edges' })
  })
  expect(history?.getAttribute('aria-busy')).toBe('false')
  expect(
    container.querySelector('[data-lineage-source="v-foreign"][data-lineage-target="v-another"]')
  ).not.toBeNull()
  await click('Load related images')
  expect(window.api.artifacts.getLineage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      artifactId: 'other-file',
      cursor: undefined,
      imageCursor: 'more-edges'
    })
  )
  await click('Load related images')
  expect(window.api.artifacts.getLineage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      artifactId: 'other-file',
      cursor: 'older-related',
      imageCursor: undefined
    })
  )
  expect(
    container.querySelector(
      '[data-lineage-source="v-foreign"][data-lineage-target="v-older-related"]'
    )
  ).not.toBeNull()
  await click('Edit image')
  await click('Compare with input image')
  expect(document.querySelector('img[alt="Before edit"]')?.getAttribute('src')).toBe('blob:v1')
  expect(document.querySelector('img[alt="After edit"]')?.getAttribute('src')).toBe(
    'blob:v-foreign'
  )
  await render(true, {
    ...item,
    artifactId: 'other-file',
    managedFileId: 'other-file',
    selectedVersionId: 'v-foreign'
  })
  await click('Edit image')
  expect(window.api.artifacts.getLineage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      artifactId: 'other-file',
      versionId: 'v-foreign',
      imageInputOnly: true
    })
  )
  await click('Compare with input image')
  expect(document.querySelector('img[alt="Before edit"]')?.getAttribute('src')).toBe('blob:v1')
})

it('uses the immutable upload input for comparison and surfaces unavailable input without a fallback image', async () => {
  const source: ImageEditSnapshot['source'] = {
    ...imageEditorSource(item)!,
    sourceKind: 'upload-version',
    sourceSessionId: 'upload-session',
    sourceFileId: 'upload-file',
    sourceVersionId: 'upload-v3'
  }
  readImage.mockReturnValue({ status: 'error', error: new Error('Missing source') })
  await act(async () =>
    root.render(<ImageEditComparison source={source} resultUrl="blob:result" />)
  )
  expect(readImage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      source: 'upload',
      projectId: 'p',
      sessionId: 'upload-session',
      managedFileId: 'upload-file',
      selectedVersionId: 'upload-v3'
    })
  )
  expect(container.textContent).toContain('Image could not be loaded.')
  expect(container.querySelector('img')).toBeNull()
})
