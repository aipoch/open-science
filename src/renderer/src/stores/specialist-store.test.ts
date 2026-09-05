import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpecialistService } from '../../../main/specialist/service'
import { SpecialistRepository } from '../../../main/specialist/repository'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpecialistExportPreview } from '../../../shared/specialist-package'
import { useSpecialistStore } from './specialist-store'

const setSpecialistApi = (api: Partial<Window['api']['specialist']>): void => {
  ;(globalThis as unknown as { window: { api: { specialist: unknown } } }).window = {
    api: { specialist: api }
  } as never
}

beforeEach(() => {
  useSpecialistStore.setState({
    items: [],
    isLoaded: false,
    loadError: undefined,
    integrity: { status: 'ok' },
    packagePreview: undefined,
    exportPreview: undefined
  })
})

describe('specialist store catalog', () => {
  it('reuses the in-memory catalog when the panel loads again', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [{ kind: 'reviewer' as const, id: 'reviewer' }],
      integrity: { status: 'ok' as const }
    })
    setSpecialistApi({ list })

    await useSpecialistStore.getState().load()
    await useSpecialistStore.getState().load()

    expect(list).toHaveBeenCalledOnce()
  })

  it('treats a missing specialist list API as an unavailable catalog', async () => {
    setSpecialistApi({})

    await expect(useSpecialistStore.getState().load()).resolves.toBeUndefined()
    expect(useSpecialistStore.getState()).toMatchObject({ items: [], isLoaded: true })
  })

  it('surfaces an initial load failure and recovers when the catalog is retried', async () => {
    const items = [{ kind: 'reviewer' as const, id: 'reviewer' }]
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('specialist database unavailable'))
      .mockResolvedValueOnce({ items, integrity: { status: 'ok' } })
    setSpecialistApi({ list })

    await expect(useSpecialistStore.getState().load()).rejects.toThrow(
      'specialist database unavailable'
    )
    expect(useSpecialistStore.getState()).toMatchObject({
      items: [],
      isLoaded: false,
      loadError: 'Open Science could not load Specialists. Retry to continue.'
    })

    await expect(useSpecialistStore.getState().load()).resolves.toBeUndefined()
    expect(useSpecialistStore.getState()).toMatchObject({
      items,
      isLoaded: true,
      loadError: undefined
    })
  })

  it('deduplicates overlapping initial catalog loads', async () => {
    type TestCatalog = {
      items: [{ kind: 'reviewer'; id: 'reviewer' }]
      integrity: { status: 'ok' }
    }
    let resolveFirst: ((snapshot: TestCatalog) => void) | undefined
    const list = vi.fn(() => new Promise<TestCatalog>((resolve) => (resolveFirst = resolve)))
    setSpecialistApi({
      list
    })

    const firstLoad = useSpecialistStore.getState().load()
    const secondLoad = useSpecialistStore.getState().load()
    resolveFirst?.({
      items: [{ kind: 'reviewer', id: 'reviewer' }],
      integrity: { status: 'ok' }
    })
    await Promise.all([firstLoad, secondLoad])

    expect(list).toHaveBeenCalledOnce()
    expect(useSpecialistStore.getState().items).toEqual([{ kind: 'reviewer', id: 'reviewer' }])
  })

  it('prevents a pre-mutation load from overwriting the mutation refresh', async () => {
    let resolveInitial:
      | ((snapshot: {
          items: [{ kind: 'reviewer'; id: string }]
          integrity: { status: 'ok' }
        }) => void)
      | undefined
    const refreshedItems = [{ kind: 'reviewer' as const, id: 'after-mutation' }]
    setSpecialistApi({
      list: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<{
              items: [{ kind: 'reviewer'; id: string }]
              integrity: { status: 'ok' }
            }>((resolve) => (resolveInitial = resolve))
        )
        .mockResolvedValueOnce({ items: refreshedItems, integrity: { status: 'ok' } }),
      setEnabled: vi.fn().mockResolvedValue({ id: 'researcher' })
    })

    const initialLoad = useSpecialistStore.getState().load()
    await useSpecialistStore.getState().setEnabled('researcher', true)
    resolveInitial?.({
      items: [{ kind: 'reviewer', id: 'before-mutation' }],
      integrity: { status: 'ok' }
    })
    await initialLoad

    expect(useSpecialistStore.getState().items).toEqual(refreshedItems)
  })

  it('retains healthy rows and blocks mutations for a degraded document', async () => {
    const items = [{ kind: 'reviewer' as const, id: 'reviewer' as const }]
    const setEnabled = vi.fn()
    setSpecialistApi({
      list: vi.fn().mockResolvedValue({
        items,
        integrity: {
          status: 'degraded',
          issues: [{ code: 'record-invalid', recordIndex: 2 }]
        }
      }),
      setEnabled
    })

    await useSpecialistStore.getState().load()

    expect(useSpecialistStore.getState()).toMatchObject({
      items,
      integrity: { status: 'degraded' }
    })
    await expect(useSpecialistStore.getState().setEnabled('researcher', false)).rejects.toThrow(
      /repaired/
    )
    expect(setEnabled).not.toHaveBeenCalled()
  })
})

describe('specialist store package export', () => {
  it('keeps overlapping previews bound to their own Specialist export identity', async () => {
    let resolveFirst: ((value: SpecialistExportPreview) => void) | undefined
    let resolveSecond: ((value: SpecialistExportPreview) => void) | undefined
    const first = {
      specialistId: 'first-specialist',
      name: 'First Specialist',
      version: '1.0.0',
      fileName: 'first.zip',
      expectedRevision: 1,
      skills: [],
      connectorIds: [],
      diagnostics: [],
      canExport: true
    } satisfies SpecialistExportPreview
    const second = {
      ...first,
      specialistId: 'second-specialist',
      name: 'Second Specialist',
      fileName: 'second.zip',
      expectedRevision: 2
    } satisfies SpecialistExportPreview
    const exportSpecialist = vi.fn().mockResolvedValue({ saved: true })
    setSpecialistApi({
      previewExport: vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<SpecialistExportPreview>((resolve) => (resolveFirst = resolve))
        )
        .mockImplementationOnce(
          () => new Promise<SpecialistExportPreview>((resolve) => (resolveSecond = resolve))
        ),
      exportSpecialist
    })

    const firstRequest = useSpecialistStore.getState().previewExport(first.specialistId)
    const secondRequest = useSpecialistStore.getState().previewExport(second.specialistId)
    resolveSecond?.(second)
    await secondRequest
    resolveFirst?.(first)
    await firstRequest

    expect(useSpecialistStore.getState().exportPreview).toEqual(second)
    await useSpecialistStore.getState().exportSpecialist(first, [])
    expect(exportSpecialist).toHaveBeenCalledWith({
      specialistId: first.specialistId,
      expectedRevision: first.expectedRevision,
      includedSkillIds: []
    })
  })

  it('keeps selection renderer-safe and preserves the catalog when native save is cancelled', async () => {
    const preview = {
      specialistId: 'research-synth',
      name: 'Research Synthesizer',
      version: '1.3.0',
      fileName: 'open-science-specialist-research-synthesizer-v1.3.0.zip',
      expectedRevision: 3,
      skills: [
        {
          id: 'analysis-tools',
          version: '1.2.3',
          kind: 'owned' as const,
          selected: true,
          selectable: true
        }
      ],
      connectorIds: [],
      diagnostics: [],
      canExport: true
    }
    const exportSpecialist = vi.fn().mockResolvedValue({ saved: false })
    setSpecialistApi({
      previewExport: vi.fn().mockResolvedValue(preview),
      exportSpecialist
    })
    useSpecialistStore.setState({
      items: [{ kind: 'reviewer', id: 'reviewer' }],
      isLoaded: true
    })

    await expect(useSpecialistStore.getState().previewExport('research-synth')).resolves.toEqual(
      preview
    )
    await expect(
      useSpecialistStore.getState().exportSpecialist(preview, ['analysis-tools'])
    ).resolves.toEqual({ saved: false })
    expect(exportSpecialist).toHaveBeenCalledWith({
      specialistId: 'research-synth',
      expectedRevision: 3,
      includedSkillIds: ['analysis-tools']
    })
    expect(useSpecialistStore.getState().items).toEqual([{ kind: 'reviewer', id: 'reviewer' }])
  })

  it('preserves an export preview while linked deletion is previewed', async () => {
    const exportPreview = {
      specialistId: 'research-synth',
      name: 'Research Synthesizer',
      version: '1.3.0',
      fileName: 'open-science-specialist-research-synthesizer-v1.3.0.zip',
      expectedRevision: 3,
      skills: [],
      connectorIds: [],
      diagnostics: [],
      canExport: true
    }
    const deletePreview = {
      specialistId: 'research-synth',
      specialistName: 'Research Synthesizer',
      expectedRevision: 3,
      skills: []
    }
    setSpecialistApi({
      previewExport: vi.fn().mockResolvedValue(exportPreview),
      previewDelete: vi.fn().mockResolvedValue(deletePreview)
    })

    await useSpecialistStore.getState().previewExport('research-synth')
    await expect(useSpecialistStore.getState().previewDelete('research-synth')).resolves.toEqual(
      deletePreview
    )

    expect(useSpecialistStore.getState().exportPreview).toEqual(exportPreview)
  })
})

describe('specialist store package import', () => {
  it('keeps only the renderer-safe preview and reloads the catalog after a durable install', async () => {
    const preview = {
      candidateToken: 'candidate-1',
      summary: {
        id: 'research-synth',
        version: '1.3.0',
        name: 'Research Synthesizer',
        description: 'Synthesizes research.',
        source: 'zip' as const,
        bundledSkillIds: [],
        requiredSkillIds: [],
        builtinSkillIds: [],
        connectorIds: ['missing-lab']
      },
      diagnostics: [
        {
          severity: 'warning' as const,
          code: 'connector.unavailable',
          message: 'Connector is unavailable.',
          relatedId: 'missing-lab'
        }
      ],
      installable: true
    }
    const installed = {
      kind: 'custom' as const,
      id: 'research-synth',
      name: 'Research Synthesizer',
      description: 'Synthesizes research.',
      systemPrompt: 'private',
      enabled: false,
      setupPending: true,
      capabilityMode: 'selected' as const,
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: ['missing-lab'], connectorTools: [] },
      revision: 1,
      packageVersion: '1.3.0',
      origin: 'imported' as const,
      ownedSkillIds: []
    }
    const list = vi.fn().mockResolvedValue({
      items: [installed, { kind: 'reviewer', id: 'reviewer' }],
      integrity: { status: 'ok' }
    })
    setSpecialistApi({
      selectPackage: vi.fn().mockResolvedValue(preview),
      installPackage: vi.fn().mockResolvedValue({ status: 'installed', specialist: installed }),
      list
    })

    await expect(useSpecialistStore.getState().selectPackage()).resolves.toEqual(preview)
    expect(useSpecialistStore.getState().packagePreview).toEqual(preview)
    await expect(useSpecialistStore.getState().installPackage()).resolves.toMatchObject({
      status: 'installed'
    })
    expect(list).toHaveBeenCalledOnce()
    expect(useSpecialistStore.getState().items[0]).toMatchObject({
      id: 'research-synth',
      origin: 'imported',
      enabled: false,
      setupPending: true
    })

    // Closing or cancelling the import surface after the durable install only clears a transient
    // candidate. It must not remove the saved setup draft from the catalog.
    await useSpecialistStore.getState().cancelPackage()
    expect(useSpecialistStore.getState().items[0]).toMatchObject({
      id: 'research-synth',
      setupPending: true
    })
  })
})

describe('S04 and S05 catalog recovery regressions', () => {
  const profile = {
    id: 'confirmed',
    name: 'Confirmed',
    description: '',
    systemPrompt: '',
    enabled: true,
    capabilityMode: 'full' as const,
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1
  }

  it('S04 Retry reads again after an already-loaded catalog refresh fails', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ items: [], integrity: { status: 'ok' } })
      .mockRejectedValueOnce(new Error('catalog enrichment unavailable'))
      .mockResolvedValue({ items: [{ kind: 'custom', ...profile }], integrity: { status: 'ok' } })
    setSpecialistApi({ list, update: vi.fn().mockResolvedValue(profile) })
    await useSpecialistStore.getState().load()
    await useSpecialistStore
      .getState()
      .update({ id: profile.id, revision: 1, description: 'Updated' })
    await vi.waitFor(() => expect(useSpecialistStore.getState().loadError).toBeDefined())
    // The explicit action wired to Retry bypasses the cached mount load.
    await useSpecialistStore.getState().load({ force: true })
    expect(list).toHaveBeenCalledTimes(3)
    expect(useSpecialistStore.getState().loadError).toBeUndefined()
    expect(useSpecialistStore.getState().items).toEqual([{ kind: 'custom', ...profile }])
  })

  it.each(['create', 'setEnabled', 'delete', 'installPackage'] as const)(
    'S05 %s retains its successful write receipt when the subsequent list fails',
    async (operation) => {
      const list = vi.fn().mockRejectedValue(new Error('catalog enrichment unavailable'))
      const create = vi.fn().mockResolvedValue(profile)
      const setEnabled = vi.fn().mockResolvedValue(profile)
      const remove = vi.fn().mockResolvedValue({ status: 'deleted' })
      const installPackage = vi.fn().mockResolvedValue({ status: 'installed', specialist: profile })
      setSpecialistApi({ list, create, setEnabled, delete: remove, installPackage })
      useSpecialistStore.setState({
        packagePreview: {
          candidateToken: 'candidate',
          summary: {
            id: profile.id,
            name: profile.name,
            version: '0.1.0',
            description: '',
            source: 'zip',
            skills: [],
            bundledSkillIds: [],
            requiredSkillIds: [],
            builtinSkillIds: [],
            connectorIds: []
          },
          diagnostics: [],
          installable: true
        }
      })
      useSpecialistStore.setState({
        items: [
          { ...profile, enabled: false, kind: 'custom' },
          { kind: 'reviewer', id: 'reviewer' }
        ]
      })
      const store = useSpecialistStore.getState()
      const result =
        operation === 'create'
          ? store.create({ name: profile.name })
          : operation === 'setEnabled'
            ? store.setEnabled(profile.id, true)
            : operation === 'delete'
              ? store.delete(profile.id, 1, [])
              : store.installPackage()
      await expect(result).resolves.toEqual(
        operation === 'create'
          ? profile
          : operation === 'setEnabled'
            ? undefined
            : operation === 'delete'
              ? { status: 'deleted' }
              : { status: 'installed', specialist: profile }
      )
      await vi.waitFor(() => expect(useSpecialistStore.getState().loadError).toBeDefined())
      expect(list).toHaveBeenCalledOnce()
      expect(
        { create, setEnabled, delete: remove, installPackage }[operation]
      ).toHaveBeenCalledOnce()
      expect(useSpecialistStore.getState().items).toEqual(
        operation === 'delete'
          ? [{ kind: 'reviewer', id: 'reviewer' }]
          : [
              { ...profile, kind: 'custom' },
              { kind: 'reviewer', id: 'reviewer' }
            ]
      )
      if (operation === 'installPackage')
        expect(useSpecialistStore.getState().packagePreview).toBeUndefined()
    }
  )
})

it('S05 a committed create remains successful even when catalog enrichment fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'specialist-create-receipt-'))
  try {
    const service = new SpecialistService(new SpecialistRepository(directory))
    setSpecialistApi({
      create: (input) => service.create(input),
      list: vi.fn().mockRejectedValue(new Error('catalog enrichment unavailable'))
    })
    const result = await useSpecialistStore
      .getState()
      .create({ name: 'Durable example' })
      .then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error })
      )
    const document = JSON.parse(await readFile(join(directory, 'specialists.json'), 'utf8'))
    expect(document.specialists).toHaveLength(1)
    expect(document.specialists[0].name).toBe('Durable example')
    await expect(service.create({ name: 'Durable example' })).rejects.toThrow(
      'Name is already in use'
    )
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ id: document.specialists[0].id })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps the forced snapshot when an older initial load finishes last', async () => {
  let finishInitial!: (value: unknown) => void
  const fresh = { items: [{ kind: 'reviewer', id: 'reviewer' }], integrity: { status: 'ok' } }
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInitial = resolve
        })
    )
    .mockResolvedValueOnce(fresh)
  setSpecialistApi({ list })
  const initial = useSpecialistStore.getState().load()
  await useSpecialistStore.getState().load({ force: true })
  finishInitial({ items: [], integrity: { status: 'ok' } })
  await initial
  expect(list).toHaveBeenCalledTimes(2)
  expect(useSpecialistStore.getState().items).toEqual(fresh.items)
  await useSpecialistStore.getState().load()
  expect(list).toHaveBeenCalledTimes(2)
})
