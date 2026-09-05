import { describe, expect, it, vi } from 'vitest'

import { resolveActionMenuEntries } from '@/components/action-menu'
import type { PreviewFileItem, PreviewToolItem } from '@/stores/preview-workbench-store'

import {
  createPreviewTabActionBindings,
  getPreviewTabActionRecipe,
  getPreviewTabActionGroups,
  PREVIEW_TAB_ACTION_CATALOG,
  runPreviewTabAction,
  type PreviewTabActionDeps
} from './preview-tab-actions'

const createFileItem = (overrides: Partial<PreviewFileItem>): PreviewFileItem => ({
  id: 'file-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'figure.png',
  type: 'file',
  path: '/workspace/figure.png',
  name: 'figure.png',
  format: 'image',
  managedFileId: 'artifact-1',
  ...overrides
})

const createToolItem = (overrides: Partial<PreviewToolItem> = {}): PreviewToolItem => ({
  id: 'tool-1',
  sessionId: 'session-1',
  title: 'Notebook',
  type: 'tool',
  toolKind: 'notebook',
  ...overrides
})

const commandsOf = (groups: ReturnType<typeof getPreviewTabActionGroups>): string[] => [
  ...groups.pdfContext,
  ...groups.shared,
  ...groups.specific
]

const specificCommandsOf = (groups: ReturnType<typeof getPreviewTabActionGroups>): string[] =>
  groups.specific

const pdfContextCommandsOf = (groups: ReturnType<typeof getPreviewTabActionGroups>): string[] =>
  groups.pdfContext

describe('Preview tab Action Menu spec', () => {
  it('resolves the established PDF, shared, and local action order from catalog and bindings', () => {
    const item = createFileItem({ source: 'local', format: 'pdf' })
    const deps: PreviewTabActionDeps = {
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      saveManagedFile: vi.fn(),
      copyText: vi.fn(),
      stageLocalPath: vi.fn(),
      togglePdfContext: vi.fn(),
      activeProjectId: 'project-1'
    }

    const entries = resolveActionMenuEntries(
      {
        identityKey: 'file-1',
        catalog: PREVIEW_TAB_ACTION_CATALOG,
        recipe: getPreviewTabActionRecipe(item, { tabCount: 2, pdfContext: 'link' }),
        bindings: createPreviewTabActionBindings({ tabCount: 2, pdfContext: 'link' }, deps)
      },
      item
    )

    expect(entries.map((entry) => (entry.kind === 'action' ? entry.action : 'separator'))).toEqual([
      'toggle-pdf-context',
      'separator',
      'close',
      'close-others',
      'separator',
      'copy-path',
      'download',
      'save-as-artifact'
    ])
    expect(entries[0]).toMatchObject({
      kind: 'action',
      action: 'toggle-pdf-context',
      labelKey: 'Read with agent',
      danger: false,
      disabled: false
    })
  })

  it('resolves dynamic labels and state from catalog and bindings', () => {
    const item = createFileItem({ format: 'pdf' })
    const context = { tabCount: 1, pdfContext: 'remove' as const }
    const entries = resolveActionMenuEntries(
      {
        identityKey: 'file-1',
        catalog: PREVIEW_TAB_ACTION_CATALOG,
        recipe: getPreviewTabActionRecipe(item, context),
        bindings: createPreviewTabActionBindings(context, {
          closeTab: vi.fn(),
          closeOtherTabs: vi.fn(),
          saveManagedFile: vi.fn(),
          copyText: vi.fn(),
          stageLocalPath: vi.fn(),
          togglePdfContext: vi.fn(),
          activeProjectId: 'project-1'
        })
      },
      item
    )

    expect(
      entries.find((entry) => entry.kind === 'action' && entry.action === 'toggle-pdf-context')
    ).toMatchObject({ labelKey: 'Remove PDF from context', danger: false })
    expect(
      entries.find((entry) => entry.kind === 'action' && entry.action === 'close-others')
    ).toMatchObject({ disabled: true, danger: true })
  })
})

describe('getPreviewTabActionGroups', () => {
  it('offers close actions on every tab type', () => {
    for (const item of [
      createFileItem({}),
      createToolItem({ toolKind: 'files', title: 'Files' }),
      createToolItem({ toolKind: 'plan', title: 'Session Plan' }),
      createToolItem({ toolKind: 'reviewer', title: 'Session Reviewer' }),
      createToolItem({ toolKind: 'subagents', title: 'Subagents' })
    ]) {
      const commands = commandsOf(getPreviewTabActionGroups(item, { tabCount: 3 }))
      expect(commands).toEqual(expect.arrayContaining(['close', 'close-others']))
    }
  })

  it('adds download to managed and upload file tabs', () => {
    expect(
      specificCommandsOf(getPreviewTabActionGroups(createFileItem({}), { tabCount: 2 }))
    ).toEqual(['download'])
    expect(
      specificCommandsOf(
        getPreviewTabActionGroups(createFileItem({ source: 'upload' }), { tabCount: 2 })
      )
    ).toEqual(['download'])
    expect(
      specificCommandsOf(
        getPreviewTabActionGroups(createFileItem({ source: 'notebook-input' }), { tabCount: 2 })
      )
    ).toEqual(['download'])
  })

  it('adds local-file actions to a local file tab', () => {
    const groups = getPreviewTabActionGroups(createFileItem({ source: 'local' }), { tabCount: 2 })

    expect(specificCommandsOf(groups)).toEqual(['copy-path', 'download', 'save-as-artifact'])
  })

  it('offers no tab-level actions for tool tabs', () => {
    for (const toolKind of ['files', 'plan', 'reviewer', 'subagents'] as const) {
      const groups = getPreviewTabActionGroups(createToolItem({ toolKind }), { tabCount: 2 })
      expect(specificCommandsOf(groups)).toEqual([])
    }
  })

  it('leads with the reading-context command for a linkable PDF tab', () => {
    const groups = getPreviewTabActionGroups(createFileItem({ format: 'pdf' }), {
      tabCount: 2,
      pdfContext: 'link'
    })

    expect(pdfContextCommandsOf(groups)).toEqual(['toggle-pdf-context'])
    expect(commandsOf(groups)[0]).toBe('toggle-pdf-context')
  })

  it('omits the reading-context command for non-linkable tabs', () => {
    expect(
      pdfContextCommandsOf(
        getPreviewTabActionGroups(createFileItem({ format: 'pdf' }), { tabCount: 2 })
      )
    ).toEqual([])
    expect(
      pdfContextCommandsOf(
        getPreviewTabActionGroups(createToolItem({ toolKind: 'files' }), {
          tabCount: 2,
          pdfContext: 'link'
        })
      )
    ).toEqual([])
  })
})

describe('runPreviewTabAction', () => {
  const createDeps = (overrides: Partial<PreviewTabActionDeps> = {}): PreviewTabActionDeps => ({
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
    copyText: vi.fn().mockResolvedValue(undefined),
    stageLocalPath: vi.fn().mockResolvedValue({ id: 'attachment-1' }),
    activeProjectId: 'project-1',
    ...overrides
  })

  it('closes the tab and its siblings', () => {
    const deps = createDeps()
    const item = createFileItem({})

    runPreviewTabAction('close', item, deps)
    runPreviewTabAction('close-others', item, deps)

    expect(deps.closeTab).toHaveBeenCalledWith(item.id)
    expect(deps.closeOtherTabs).toHaveBeenCalledWith(item.id)
  })

  it('downloads a managed file with the artifact default source', async () => {
    const deps = createDeps()

    runPreviewTabAction('download', createFileItem({}), deps)
    await vi.waitFor(() => expect(deps.saveManagedFile).toHaveBeenCalled())

    expect(deps.saveManagedFile).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      suggestedName: 'figure.png'
    })
  })

  it('downloads a local file through the same save pipeline', async () => {
    const deps = createDeps()

    runPreviewTabAction('download', createFileItem({ source: 'local' }), deps)
    await vi.waitFor(() => expect(deps.saveManagedFile).toHaveBeenCalled())

    expect(deps.saveManagedFile).toHaveBeenCalledWith({
      source: 'local',
      path: '/workspace/figure.png',
      suggestedName: 'figure.png'
    })
  })

  it('logs instead of throwing when a download fails', async () => {
    const deps = createDeps({ saveManagedFile: vi.fn().mockRejectedValue(new Error('disk full')) })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    runPreviewTabAction('download', createFileItem({}), deps)
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled())

    consoleError.mockRestore()
  })

  it('copies a local file path to the clipboard', async () => {
    const deps = createDeps()

    runPreviewTabAction('copy-path', createFileItem({ source: 'local' }), deps)
    await vi.waitFor(() => expect(deps.copyText).toHaveBeenCalled())

    expect(deps.copyText).toHaveBeenCalledWith('/workspace/figure.png')
  })

  it('stages a local file as an artifact with a fresh transfer id', async () => {
    const deps = createDeps()

    runPreviewTabAction('save-as-artifact', createFileItem({ source: 'local' }), deps)
    await vi.waitFor(() => expect(deps.stageLocalPath).toHaveBeenCalled())

    const request = vi.mocked(deps.stageLocalPath)!.mock.calls[0][0]
    expect(request).toMatchObject({
      name: 'figure.png',
      sourcePath: '/workspace/figure.png',
      projectId: 'project-1'
    })
    expect(request.transferId).toMatch(/[0-9a-f-]{36}/)
  })

  it('omits the project id when no project is active', async () => {
    const deps = createDeps({ activeProjectId: undefined })

    runPreviewTabAction('save-as-artifact', createFileItem({ source: 'local' }), deps)
    await vi.waitFor(() => expect(deps.stageLocalPath).toHaveBeenCalled())

    expect(vi.mocked(deps.stageLocalPath)!.mock.calls[0][0]).not.toHaveProperty('projectId')
  })

  it('is a no-op when the staging pipeline is unavailable', () => {
    const deps = createDeps({ stageLocalPath: undefined })

    runPreviewTabAction('save-as-artifact', createFileItem({ source: 'local' }), deps)

    expect(deps.closeTab).not.toHaveBeenCalled()
  })

  it('ignores file commands on tool tabs', () => {
    const deps = createDeps()

    runPreviewTabAction('download', createToolItem(), deps)

    expect(deps.saveManagedFile).not.toHaveBeenCalled()
  })

  it('routes the reading-context command to the injected toggle', () => {
    const togglePdfContext = vi.fn()
    const deps = createDeps({ togglePdfContext })
    const item = createFileItem({ format: 'pdf' })

    runPreviewTabAction('toggle-pdf-context', item, deps)

    expect(togglePdfContext).toHaveBeenCalledWith(item)
  })

  it('ignores the reading-context command on tool tabs and without a toggle', () => {
    const togglePdfContext = vi.fn()
    const deps = createDeps({ togglePdfContext })

    runPreviewTabAction('toggle-pdf-context', createToolItem(), deps)
    runPreviewTabAction('toggle-pdf-context', createFileItem({ format: 'pdf' }), createDeps())

    expect(togglePdfContext).not.toHaveBeenCalled()
  })
})
