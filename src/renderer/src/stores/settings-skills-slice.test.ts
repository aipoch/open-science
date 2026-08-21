import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentHomeSkillRef,
  AgentHomeSkillView,
  ImportAgentHomeSkillsResult,
  ImportSkillResult,
  ImportSkillZipBatchResult,
  ScanRepoResult,
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  SkillView
} from '../../../shared/settings'
import {
  createInitialSettingsSkillsState,
  createSettingsSkillsSlice,
  type SettingsSkillsActions,
  type SettingsSkillsState
} from './settings-skills-slice'

type TestStore = SettingsSkillsState & SettingsSkillsActions
type SkillCommands = Parameters<
  typeof createSettingsSkillsSlice
>[0]['getCommands'] extends () => infer T
  ? T
  : never

const skill = (id: string, enabled = true): SkillView => ({
  id,
  name: id,
  displayName: id,
  description: `${id} description`,
  source: 'personal',
  updatedAt: '2026-08-06T00:00:00.000Z',
  enabled
})

const preview: SkillImportPreviewContent = {
  name: 'Preview',
  description: 'Preview description',
  sourceLabel: 'owner/repo',
  metadata: {},
  body: '# Preview',
  files: ['SKILL.md']
}

const createCommands = (): SkillCommands => ({
  listSkills: vi.fn(async () => []),
  onSkillCatalogChanged: vi.fn(() => () => undefined),
  setSkillEnabled: vi.fn(async () => []),
  setSkillsEnabled: vi.fn(async () => []),
  createSkill: vi.fn(async () => []),
  updateSkill: vi.fn(async () => []),
  deleteSkill: vi.fn(async () => []),
  importSkill: vi.fn(async (): Promise<ImportSkillResult> => ({
    status: 'imported',
    id: 'imported',
    skills: []
  })),
  importSkillZip: vi.fn(async (): Promise<ImportSkillResult> => ({
    status: 'imported',
    id: 'zipped',
    skills: []
  })),
  importSkillZipBatch: vi.fn(async (): Promise<ImportSkillZipBatchResult> => ({
    results: [],
    skills: []
  })),
  previewSkillZip: vi.fn(async (): Promise<SkillBundlePreviewResult> => ({
    previews: [],
    skipped: []
  })),
  previewGitHubSkill: vi.fn(async () => preview),
  scanRepoSkills: vi.fn(async (): Promise<ScanRepoResult> => ({ skills: [] })),
  listAgentHomeSkills: vi.fn(async (): Promise<AgentHomeSkillView[]> => []),
  previewAgentHomeSkill: vi.fn(async () => preview),
  importAgentHomeSkills: vi.fn(async (): Promise<ImportAgentHomeSkillsResult> => ({
    results: [],
    skills: []
  }))
})

const createHarness = (
  commands: SkillCommands
): { store: StoreApi<TestStore>; commands: SkillCommands } => {
  const store = createStore<TestStore>((set, get) => ({
    ...createInitialSettingsSkillsState(),
    ...createSettingsSkillsSlice({
      getState: get,
      setState: (patch) => set(patch),
      getCommands: () => commands
    })
  }))

  return { store, commands }
}

describe('settings Skills slice', () => {
  let store: StoreApi<TestStore>
  let commands: SkillCommands

  beforeEach(() => {
    ;({ store, commands } = createHarness(createCommands()))
  })

  it('loads the authoritative catalog', async () => {
    vi.mocked(commands.listSkills).mockResolvedValue([skill('loaded')])

    await store.getState().loadSkills()

    expect(store.getState().skills).toEqual([skill('loaded')])
  })

  it('deduplicates overlapping initial catalog loads', async () => {
    let settle!: (skills: SkillView[]) => void
    vi.mocked(commands.listSkills).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )

    const first = store.getState().loadSkills()
    const second = store.getState().loadSkills()
    settle([skill('loaded')])
    await Promise.all([first, second])

    expect(commands.listSkills).toHaveBeenCalledOnce()
  })

  it('subscribes once and reconciles a catalog change published by main', async () => {
    let onCatalogChanged: ((payload: undefined) => void) | undefined
    vi.mocked(commands.onSkillCatalogChanged).mockImplementation((listener) => {
      onCatalogChanged = listener
      return () => undefined
    })
    vi.mocked(commands.listSkills)
      .mockResolvedValueOnce([skill('initial')])
      .mockResolvedValueOnce([skill('direct')])

    await store.getState().loadSkills()
    await store.getState().loadSkills()
    onCatalogChanged?.(undefined)
    await vi.waitFor(() => expect(store.getState().skills).toEqual([skill('direct')]))

    expect(commands.onSkillCatalogChanged).toHaveBeenCalledOnce()
    expect(commands.listSkills).toHaveBeenCalledTimes(2)
  })

  it('rejects a missing Settings command surface as a promise', async () => {
    const { store } = createHarness({
      ...createCommands(),
      onSkillCatalogChanged: () => {
        throw new Error('settings unavailable')
      }
    })

    const result = store.getState().loadSkills()
    expect(result).toBeInstanceOf(Promise)
    await expect(result).rejects.toThrow('settings unavailable')
  })

  it('optimistically toggles a Skill before reconciling the authoritative catalog', async () => {
    let settle!: (skills: SkillView[]) => void
    vi.mocked(commands.setSkillEnabled).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    store.setState({ skills: [skill('target')] })

    const pending = store.getState().setSkillEnabled('target', false)

    expect(store.getState().skills).toEqual([skill('target', false)])
    expect(commands.setSkillEnabled).toHaveBeenCalledWith({ id: 'target', enabled: false })

    settle([skill('authoritative', false)])
    await pending
    expect(store.getState().skills).toEqual([skill('authoritative', false)])
  })

  it('rolls back an optimistic toggle when main rejects it', async () => {
    vi.mocked(commands.setSkillEnabled).mockRejectedValue(new Error('toggle failed'))
    store.setState({ skills: [skill('target')] })

    await expect(store.getState().setSkillEnabled('target', false)).rejects.toThrow('toggle failed')

    expect(store.getState().skills).toEqual([skill('target')])
  })

  it('does not let an older rejected Skill toggle overwrite a newer success', async () => {
    let rejectOlder!: (error: Error) => void
    let settleNewer!: (skills: SkillView[]) => void
    vi.mocked(commands.setSkillEnabled)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectOlder = reject
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settleNewer = resolve
        })
      )
    store.setState({ skills: [skill('target')] })

    const older = store.getState().setSkillEnabled('target', false)
    const newer = store.getState().setSkillEnabled('target', true)

    settleNewer([skill('target')])
    await newer
    rejectOlder(new Error('older toggle failed'))
    await expect(older).rejects.toThrow('older toggle failed')

    expect(store.getState().skills).toEqual([skill('target')])
  })

  it('does not let an older Skill toggle overwrite a newer bulk snapshot', async () => {
    let settleOlder!: (skills: SkillView[]) => void
    vi.mocked(commands.setSkillEnabled).mockReturnValue(
      new Promise((resolve) => {
        settleOlder = resolve
      })
    )
    vi.mocked(commands.setSkillsEnabled).mockResolvedValue([skill('target')])
    store.setState({ skills: [skill('target')] })

    const older = store.getState().setSkillEnabled('target', false)
    await store.getState().setSkillsEnabled(['target'], true)

    settleOlder([skill('target', false)])
    await older

    expect(store.getState().skills).toEqual([skill('target')])
  })

  it('reconciles the authoritative catalog after changing Skill enablement in bulk', async () => {
    vi.mocked(commands.setSkillsEnabled).mockResolvedValue([skill('authoritative', false)])
    store.setState({ skills: [skill('target')] })

    await store.getState().setSkillsEnabled(['target'], false)

    expect(commands.setSkillsEnabled).toHaveBeenCalledWith({ ids: ['target'], enabled: false })
    expect(store.getState().skills).toEqual([skill('authoritative', false)])
  })

  it.each([
    ['createSkill', 'createSkill', { name: 'New', description: '', body: '' }],
    ['updateSkill', 'updateSkill', { id: 'target', name: 'Updated', description: '', body: '' }],
    ['deleteSkill', 'deleteSkill', 'target']
  ] as const)('reconciles the catalog after %s', async (_label, actionName, input) => {
    const commandName = actionName as 'createSkill' | 'updateSkill' | 'deleteSkill'
    vi.mocked(commands[commandName]).mockResolvedValue([skill('authoritative')])

    if (actionName === 'createSkill') await store.getState().createSkill(input)
    if (actionName === 'updateSkill') await store.getState().updateSkill(input)
    if (actionName === 'deleteSkill') await store.getState().deleteSkill(input)

    const expectedInput = actionName === 'deleteSkill' ? { id: input } : input
    expect(commands[commandName]).toHaveBeenCalledWith(expectedInput)
    expect(store.getState().skills).toEqual([skill('authoritative')])
  })

  it('returns import results and reconciles their catalogs', async () => {
    const githubResult: ImportSkillResult = {
      status: 'imported',
      id: 'github',
      skills: [skill('github')]
    }
    const zipResult: ImportSkillResult = {
      status: 'updated',
      id: 'zip',
      skills: [skill('zip')]
    }
    vi.mocked(commands.importSkill).mockResolvedValue(githubResult)
    vi.mocked(commands.importSkillZip).mockResolvedValue(zipResult)

    await expect(store.getState().importSkill('https://github.com/owner/repo')).resolves.toBe(
      githubResult
    )
    await expect(
      store.getState().importSkillZip('base64', { subPath: 'skills/one', replaceId: 'old' })
    ).resolves.toBe(zipResult)

    expect(commands.importSkill).toHaveBeenCalledWith({ url: 'https://github.com/owner/repo' })
    expect(commands.importSkillZip).toHaveBeenCalledWith({
      dataBase64: 'base64',
      subPath: 'skills/one',
      replaceId: 'old'
    })
    expect(store.getState().skills).toEqual(zipResult.skills)
  })

  it('returns batch import results and reconciles their catalogs', async () => {
    const result: ImportSkillZipBatchResult = {
      results: [{ subPath: 'skills/one', status: 'imported', id: 'one' }],
      skills: [skill('one')]
    }
    const items = [{ subPath: 'skills/one', replaceId: 'old' }]
    vi.mocked(commands.importSkillZipBatch).mockResolvedValue(result)

    await expect(store.getState().importSkillZipBatch('base64', items)).resolves.toBe(result)

    expect(commands.importSkillZipBatch).toHaveBeenCalledWith({ dataBase64: 'base64', items })
    expect(store.getState().skills).toEqual(result.skills)
  })

  it('passes preview and discovery results through without mutating the catalog', async () => {
    const zipPreview: SkillBundlePreviewResult = { previews: [], skipped: [] }
    const scan: ScanRepoResult = { skills: [] }
    const installed: AgentHomeSkillView[] = [
      {
        source: 'agents',
        slug: 'installed',
        name: 'Installed',
        description: '',
        alreadyImported: false
      }
    ]
    const ref: AgentHomeSkillRef = { source: 'agents', slug: 'installed' }
    vi.mocked(commands.previewSkillZip).mockResolvedValue(zipPreview)
    vi.mocked(commands.previewGitHubSkill).mockResolvedValue(preview)
    vi.mocked(commands.scanRepoSkills).mockResolvedValue(scan)
    vi.mocked(commands.listAgentHomeSkills).mockResolvedValue(installed)
    vi.mocked(commands.previewAgentHomeSkill).mockResolvedValue(preview)
    store.setState({ skills: [skill('existing')] })

    await expect(store.getState().previewSkillZip('base64')).resolves.toBe(zipPreview)
    await expect(store.getState().previewGitHubSkill('owner/repo')).resolves.toBe(preview)
    await expect(store.getState().scanRepoSkills('owner/repo')).resolves.toBe(scan)
    await expect(store.getState().listAgentHomeSkills()).resolves.toBe(installed)
    await expect(store.getState().previewAgentHomeSkill(ref)).resolves.toBe(preview)

    expect(commands.previewSkillZip).toHaveBeenCalledWith({ dataBase64: 'base64' })
    expect(commands.previewGitHubSkill).toHaveBeenCalledWith({ url: 'owner/repo' })
    expect(commands.scanRepoSkills).toHaveBeenCalledWith({ repo: 'owner/repo' })
    expect(commands.previewAgentHomeSkill).toHaveBeenCalledWith(ref)
    expect(store.getState().skills).toEqual([skill('existing')])
  })

  it('keeps synchronous preview command failures on the asynchronous rejection boundary', async () => {
    vi.mocked(commands.previewGitHubSkill).mockImplementation(() => {
      throw new Error('preview failed')
    })

    await expect(store.getState().previewGitHubSkill('owner/repo')).rejects.toThrow(
      'preview failed'
    )
  })

  it('imports Agent-home Skills and reconciles the returned catalog', async () => {
    const refs: AgentHomeSkillRef[] = [{ source: 'codex', slug: 'installed' }]
    const result: ImportAgentHomeSkillsResult = {
      results: [{ ...refs[0], status: 'imported', id: 'installed' }],
      skills: [skill('installed')]
    }
    vi.mocked(commands.importAgentHomeSkills).mockResolvedValue(result)

    await expect(store.getState().importAgentHomeSkills(refs)).resolves.toBe(result)

    expect(commands.importAgentHomeSkills).toHaveBeenCalledWith({ skills: refs })
    expect(store.getState().skills).toEqual(result.skills)
  })
})
