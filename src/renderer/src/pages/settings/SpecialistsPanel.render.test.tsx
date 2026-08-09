// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistsPanel } from './SpecialistsPanel'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { SpecialistListItem } from '../../../../shared/specialist'
import type { SpecialistExportPreview } from '../../../../shared/specialist-package'

const navigationMock = vi.hoisted(() => ({
  startCustomizeConversation: vi.fn()
}))

vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: {
    getState: () => ({ startCustomizeConversation: navigationMock.startCustomizeConversation })
  }
}))
vi.mock('@/lib/last-opened-project', () => ({
  resolveCustomizeProjectId: vi.fn((projects: { id: string }[]) => projects[0]?.id),
  recordLastOpenedProject: vi.fn(),
  getLastOpenedProjectId: vi.fn(() => undefined)
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

let container: HTMLDivElement
let root: Root
const initialStore = useSpecialistStore.getState()
const specialistItems: SpecialistListItem[] = [
  {
    kind: 'custom',
    id: 'rna-reviewer',
    name: 'RNA Reviewer',
    description: 'Reviews RNA-seq analyses.',
    systemPrompt: '',
    iconKey: 'microscope',
    colorKey: 'teal',
    enabled: true,
    capabilityMode: 'full',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1
  },
  {
    kind: 'custom',
    id: 'literature-reviewer',
    name: 'Literature Reviewer',
    description: 'Finds relevant papers.',
    systemPrompt: '',
    enabled: true,
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1
  },
  {
    kind: 'builtin',
    readonly: true,
    version: '1.2.0',
    id: 'builtin-curator',
    name: 'BUILTIN_CURATOR',
    displayName: 'Builtin Curator',
    description: 'Curates repository evidence.',
    systemPrompt: 'Do not expose this through catalog broadcasts.',
    iconKey: 'microscope',
    colorKey: 'teal',
    enabled: true,
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: {
      skillIds: ['literature-review'],
      connectorIds: [],
      connectorTools: []
    },
    revision: 0
  },
  { kind: 'reviewer', id: 'reviewer' }
]

beforeEach(() => {
  window.api = {
    specialist: {
      list: vi.fn().mockResolvedValue(specialistItems),
      create: vi.fn(),
      setEnabled: vi.fn(),
      onCatalogChanged: vi.fn(() => vi.fn())
    },
    settings: {
      listConnectors: vi.fn().mockResolvedValue({ connectors: [], customServers: [], ncbi: null }),
      listSkills: vi.fn().mockResolvedValue([])
    }
  } as unknown as Window['api']
  useSpecialistStore.setState({
    ...initialStore,
    isLoaded: true,
    items: specialistItems
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  useSpecialistStore.setState(initialStore, true)
  delete (window as unknown as { api?: unknown }).api
})

describe('SpecialistsPanel', () => {
  it('renders safely when the web surface omits the specialist API', async () => {
    const specialistApi = window.api.specialist
    delete (window.api as { specialist?: Window['api']['specialist'] }).specialist
    useSpecialistStore.setState({ items: [], isLoaded: false })

    try {
      await act(async () => {
        root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
      })

      expect(document.body.textContent).toContain('No specialists yet')
      expect(useSpecialistStore.getState().isLoaded).toBe(true)
    } finally {
      window.api.specialist = specialistApi
    }
  })

  // Shared preview fixture: builtin + owned selected by default, referenced skill unchecked.
  const exportPreviewFixture = (
    overrides: Partial<{
      canExport: boolean
      diagnostics: Array<{
        severity: 'error' | 'warning' | 'info'
        code: string
        message: string
      }>
    }> = {}
  ): {
    specialistId: string
    name: string
    version: string
    fileName: string
    expectedRevision: number
    canExport: boolean
    connectorIds: string[]
    diagnostics: Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string }>
    skills: Array<{
      id: string
      version: string
      kind: 'builtin' | 'owned' | 'referenced'
      selected: boolean
      selectable: boolean
    }>
  } => ({
    specialistId: 'rna-reviewer',
    name: 'RNA Reviewer',
    version: '0.1.0',
    fileName: 'open-science-specialist-rna-reviewer-v0.1.0.zip',
    expectedRevision: 1,
    canExport: true,
    connectorIds: ['reference-library'],
    diagnostics: [],
    skills: [
      {
        id: 'document-reader',
        version: '0.9.2',
        kind: 'builtin',
        selected: true,
        selectable: true
      },
      {
        id: 'analysis-tools',
        version: '1.2.3',
        kind: 'owned',
        selected: true,
        selectable: true
      },
      {
        id: 'citation-manager',
        version: '0.1.0',
        kind: 'referenced',
        selected: false,
        selectable: true
      }
    ],
    ...overrides
  })

  // Mirrors the real store action: previewExport also records the preview for exportSpecialist.
  const makePreviewExportMock = (
    preview: SpecialistExportPreview
  ): ((specialistId: string) => Promise<SpecialistExportPreview>) =>
    vi.fn(async (): Promise<SpecialistExportPreview> => {
      useSpecialistStore.setState({ exportPreview: preview })
      return preview
    })

  const openExportMenuItem = async (): Promise<HTMLElement | undefined> => {
    const actions = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for RNA Reviewer"]'
    )
    openRadixMenu(actions)
    const exportItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Export ZIP'))
    expect(exportItem).toBeDefined()
    await act(async () => clickRadixMenuItem(exportItem))
    return exportItem
  }

  it('exports directly from the custom action menu with approved default selection', async () => {
    const preview = exportPreviewFixture()
    const previewExportMock = makePreviewExportMock(preview)
    const exportSpecialist = vi.fn().mockResolvedValue({ saved: true })
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      previewExport: previewExportMock,
      exportSpecialist
    })
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })
    await openExportMenuItem()

    // No chooser page — the default selection (builtin + owned) goes straight to the save dialog.
    expect(previewExportMock).toHaveBeenCalledWith('rna-reviewer')
    expect(exportSpecialist).toHaveBeenCalledWith(preview, ['document-reader', 'analysis-tools'])
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'export', id: 'rna-reviewer' })
    expect(document.body.querySelector('[aria-label="Actions for Builtin Curator"]')).toBeNull()

    // After navigating, the approved Export complete page replaces the chooser.
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'export', id: 'rna-reviewer' }} onNavigate={onNavigate} />
      )
    })
    expect(document.body.textContent).toContain('Export complete')
    expect(document.body.textContent).toContain(
      'open-science-specialist-rna-reviewer-v0.1.0.zip was saved'
    )
  })

  it('keeps the list untouched when the native save dialog is cancelled', async () => {
    const preview = exportPreviewFixture()
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      previewExport: makePreviewExportMock(preview),
      exportSpecialist: vi.fn().mockResolvedValue({ saved: false })
    })
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })
    await openExportMenuItem()

    expect(onNavigate).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Export complete')
    expect(document.body.querySelector('[aria-label="Actions for RNA Reviewer"]')).not.toBeNull()
    expect(useSpecialistStore.getState().exportPreview).toBeUndefined()
  })

  it('falls back to the skill chooser when the direct export has blocking diagnostics', async () => {
    const preview = exportPreviewFixture({
      canExport: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'package.archive-file-size-exceeded',
          message: 'The archive entry is too large.'
        }
      ]
    })
    const exportSpecialist = vi.fn()
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      previewExport: makePreviewExportMock(preview),
      exportSpecialist
    })
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })
    await openExportMenuItem()

    expect(exportSpecialist).not.toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'export', id: 'rna-reviewer' })

    // The chooser opens with the blocking diagnostics visible so the user can adjust and retry.
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'export', id: 'rna-reviewer' }} onNavigate={onNavigate} />
      )
    })
    expect(document.body.textContent).toContain('Choose Skills to include')
    expect(document.body.textContent).toContain('package.archive-file-size-exceeded')
  })

  it('falls back to the skill chooser with an error when the direct export save fails', async () => {
    const preview = exportPreviewFixture()
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      previewExport: makePreviewExportMock(preview),
      exportSpecialist: vi.fn().mockRejectedValue(new Error('boom'))
    })
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })
    await openExportMenuItem()

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'export', id: 'rna-reviewer' })
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'export', id: 'rna-reviewer' }} onNavigate={onNavigate} />
      )
    })
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save this Specialist export. Preview again and retry.'
    )
  })

  it('disables the action menu while the direct export is in flight, then restores it', async () => {
    let finishExport: ((value: { saved: boolean }) => void) | undefined
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      previewExport: makePreviewExportMock(exportPreviewFixture()),
      exportSpecialist: vi.fn(
        (): Promise<{ saved: boolean }> => new Promise((resolve) => (finishExport = resolve))
      )
    })
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })
    await openExportMenuItem()

    const actions = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for RNA Reviewer"]'
    )
    expect(actions?.disabled).toBe(true)
    expect(document.body.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      'Preparing export'
    )

    await act(async () => finishExport?.({ saved: false }))
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Actions for RNA Reviewer"]')
        ?.disabled
    ).toBe(false)
    expect(document.body.querySelector('[role="status"]')).toBeNull()
  })

  it('matches approved export defaults, portability warning, and native-cancel state', async () => {
    const preview = {
      specialistId: 'rna-reviewer',
      name: 'RNA Reviewer',
      version: '0.1.0',
      fileName: 'open-science-specialist-rna-reviewer-v0.1.0.zip',
      expectedRevision: 1,
      canExport: true,
      connectorIds: ['reference-library'],
      diagnostics: [
        {
          severity: 'warning' as const,
          code: 'specialist.export-version-unchanged',
          message: 'Content changed but the package version remains 0.1.0.'
        }
      ],
      skills: [
        {
          id: 'document-reader',
          version: '0.9.2',
          kind: 'builtin' as const,
          selected: true,
          selectable: true
        },
        {
          id: 'analysis-tools',
          version: '1.2.3',
          kind: 'owned' as const,
          selected: true,
          selectable: true
        },
        {
          id: 'citation-manager',
          version: '0.1.0',
          kind: 'referenced' as const,
          selected: false,
          selectable: true
        }
      ]
    }
    const exportSpecialist = vi.fn().mockResolvedValue({ saved: false })
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      exportPreview: preview,
      previewExport: vi.fn().mockResolvedValue(preview),
      exportSpecialist
    })
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'export', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })
    const checkboxFor = (label: string): HTMLInputElement | undefined =>
      Array.from(document.body.querySelectorAll('label'))
        .find((node) => node.textContent?.includes(label))
        ?.querySelector('input') ?? undefined
    expect(checkboxFor('document-reader')).toMatchObject({ checked: true, disabled: false })
    expect(checkboxFor('analysis-tools')).toMatchObject({ checked: true, disabled: false })
    expect(checkboxFor('citation-manager')).toMatchObject({ checked: false, disabled: false })
    expect(document.body.textContent).toContain('Content changed but the package version remains')
    expect(document.body.textContent).toContain('Only checked Skills are bundled')

    const exportButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Export ZIP'
    )
    await act(async () => exportButton?.click())
    expect(exportSpecialist).toHaveBeenCalledWith(preview, ['document-reader', 'analysis-tools'])
    expect(document.body.textContent).toContain('Choose Skills to include')
    expect(document.body.textContent).not.toContain('Export complete')
  })

  it('matches the Import ZIP entry hierarchy and template action summary', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Import a Specialist package')
    expect(document.body.textContent).toContain('Choose one ZIP containing exactly one Specialist.')
    expect(document.body.textContent).toContain('Select a Specialist ZIP')
    expect(document.body.textContent).toContain(
      'The package will be safely parsed and previewed before it is saved.'
    )
    expect(document.body.textContent).toContain('50 MB compressed')
    expect(document.body.textContent).toContain('200 MB uncompressed')
    expect(document.body.textContent).toContain('2,000 files')
    expect(document.body.textContent).toContain('25 MB per file')
    expect(document.body.textContent).toContain('Download template')
    expect(document.body.textContent).toContain(
      'The ZIP contains app metadata, the specialist.json you fill in, and a README.txt guide.'
    )
    expect(document.body.textContent).toContain('Choose ZIP')
    expect(document.body.textContent).toContain('Back')
  })

  it('starts the template download directly without an intermediate page', async () => {
    const exportContributionTemplate = vi.fn().mockResolvedValue({ saved: false })
    window.api.specialist.exportContributionTemplate = exportContributionTemplate
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const download = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Download template')
    )
    await act(async () => download?.click())

    expect(exportContributionTemplate).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Download the fixed starter ZIP')
  })

  it('quietly restores the Import ZIP entry when the native save dialog is cancelled', async () => {
    const exportContributionTemplate = vi.fn().mockResolvedValue({ saved: false })
    window.api.specialist.exportContributionTemplate = exportContributionTemplate
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const clickButton = async (label: string): Promise<void> => {
      const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes(label)
      )
      await act(async () => button?.click())
    }

    await clickButton('Download template')

    expect(exportContributionTemplate).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Select a Specialist ZIP')
    expect(document.body.textContent).not.toContain('Template saved')
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows loading and the success state around a completed template save', async () => {
    let finishSave: ((value: { saved: boolean }) => void) | undefined
    window.api.specialist.exportContributionTemplate = vi.fn(
      (): Promise<{ saved: boolean }> => new Promise((resolve) => (finishSave = resolve))
    )
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const click = async (label: string): Promise<void> => {
      const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes(label)
      )
      await act(async () => button?.click())
    }

    await click('Download template')
    expect(document.body.textContent).toContain('Saving template…')

    await act(async () => finishSave?.({ saved: true }))
    expect(document.body.textContent).toContain('Template saved')
    expect(document.body.textContent).toContain(
      'openscience-specialist-template.zip is ready for contributor editing.'
    )
  })

  it('shows a path-free error and permits retry when saving fails', async () => {
    window.api.specialist.exportContributionTemplate = vi
      .fn()
      .mockRejectedValue(new Error('EACCES /secret/location/template.zip'))
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const click = async (label: string): Promise<void> => {
      const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes(label)
      )
      await act(async () => button?.click())
    }

    await click('Download template')

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save contribution template. Try again.'
    )
    expect(document.body.textContent).not.toContain('/secret/location')
    expect(document.body.textContent).toContain('Download template')
  })

  it('shows the approved full ZIP preview and opens the installed custom Specialist for editing', async () => {
    const preview = {
      candidateToken: 'candidate-1',
      summary: {
        id: 'research-synth',
        version: '1.3.0',
        name: 'Research Synthesizer',
        description: 'Synthesizes research.',
        source: 'zip' as const,
        bundledSkillIds: ['analysis-tools'],
        requiredSkillIds: ['analysis-tools'],
        builtinSkillIds: [],
        connectorIds: ['lab-notebook'],
        skills: [
          {
            id: 'analysis-tools',
            version: '1.2.3',
            disposition: 'reuse-standalone' as const,
            reason: 'An identical standalone Skill is already installed.',
            files: ['SKILL.md', 'scripts/run.sh']
          }
        ]
      },
      diagnostics: [
        {
          severity: 'warning' as const,
          code: 'specialist.connector-unavailable',
          message: 'The lab-notebook Connector is unavailable.',
          relatedId: 'lab-notebook'
        },
        {
          severity: 'info' as const,
          code: 'package.metadata-noise-ignored',
          message: 'Archive metadata was ignored.'
        }
      ],
      installable: true,
      archive: {
        compressedBytes: 1024 * 1024,
        uncompressedBytes: 2 * 1024 * 1024,
        fileCount: 3,
        limits: {
          compressedBytes: 50 * 1024 * 1024,
          uncompressedBytes: 200 * 1024 * 1024,
          fileCount: 2000,
          fileBytes: 25 * 1024 * 1024,
          compressionRatio: 1000,
          pathDepth: 32
        }
      }
    }
    const selectPackage = vi.fn().mockImplementation(async () => {
      useSpecialistStore.setState({ packagePreview: preview })
      return preview
    })
    const installPackage = vi.fn().mockResolvedValue({
      status: 'installed',
      specialist: { id: 'research-synth' }
    })
    const cancelPackage = vi.fn()
    const savePackageReport = vi.fn().mockResolvedValue({ saved: true })
    window.api.specialist.savePackageReport = savePackageReport
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    useSpecialistStore.setState({ selectPackage, installPackage, cancelPackage })
    const onNavigate = vi.fn()

    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={onNavigate} />)
    })
    expect(document.body.textContent).toContain('Import a Specialist package')
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Choose ZIP')
        ?.click()
    })

    expect(document.body.textContent).toContain('Research Synthesizer')
    expect(document.body.textContent).toContain('research-synth')
    expect(document.body.textContent).toContain('1.3.0')
    expect(document.body.textContent).toContain('analysis-tools')
    expect(document.body.textContent).toContain('1.2.3')
    expect(document.body.textContent).toContain('Reuse standalone')
    expect(document.body.textContent).toContain(
      'An identical standalone Skill is already installed.'
    )
    expect(document.body.textContent).toContain('scripts/run.sh')
    expect(document.body.textContent).not.toContain('No Connector references')
    expect(document.body.textContent).toContain('✓ Installable')
    // Human-readable diagnostics; raw codes stay out of the user-facing copy.
    expect(document.body.textContent).toContain('Connector unavailable')
    expect(document.body.textContent).not.toContain('connector.unavailable')
    expect(document.body.textContent).toContain('Archive metadata ignored')
    expect(document.body.textContent).not.toContain('package.metadata-noise-ignored')
    expect(document.body.textContent).toContain('Warnings (1)')
    expect(document.body.textContent).toContain('Information (1)')
    expect(document.body.textContent).toContain('ID: lab-notebook')
    expect(document.body.textContent).toContain('1 MB / 50 MB')
    expect(document.body.textContent).toContain('2 MB / 200 MB')
    expect(document.body.textContent).toContain('3 / 2000')

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Copy report'))
        ?.click()
    })
    expect(writeText).toHaveBeenCalledOnce()
    expect(String(writeText.mock.calls[0]?.[0])).not.toContain('candidate-1')

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Download JSON'))
        ?.click()
    })
    expect(savePackageReport).toHaveBeenCalledWith({ candidateToken: 'candidate-1' })
    expect(document.body.textContent).toContain('Report saved')

    // After the install, the Skill catalog must be refreshed so a Skill bundled by the package is
    // recognized as available in the editor instead of showing "Missing · unavailable".
    window.api.settings.listSkills = vi.fn().mockResolvedValue([
      {
        id: 'analysis-tools',
        name: 'Analysis Tools',
        description: 'Runs analyses.',
        source: 'personal',
        updatedAt: '2026-08-04T00:00:00.000Z',
        enabled: true
      }
    ])
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Next')
        ?.click()
    })
    expect(installPackage).toHaveBeenCalledOnce()
    expect(window.api.settings.listSkills).toHaveBeenCalled()
    expect(useSettingsStore.getState().skills).toEqual([
      {
        id: 'analysis-tools',
        name: 'Analysis Tools',
        description: 'Runs analyses.',
        source: 'personal',
        updatedAt: '2026-08-04T00:00:00.000Z',
        enabled: true
      }
    ])
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'research-synth' })
  })

  it('requires the approved destructive second confirmation for an overwrite', async () => {
    const preview = {
      candidateToken: 'overwrite-1',
      summary: {
        id: 'research-synth',
        version: '1.3.0',
        name: 'Research Synthesizer',
        description: 'Incoming content.',
        source: 'zip' as const,
        bundledSkillIds: [],
        requiredSkillIds: [],
        builtinSkillIds: [],
        connectorIds: [],
        skills: []
      },
      diagnostics: [
        {
          severity: 'warning' as const,
          code: 'specialist.overwrite-downgrade',
          message: 'The incoming package version is lower than the installed version.'
        }
      ],
      installable: true,
      overwrite: {
        id: 'research-synth',
        target: 'custom' as const,
        currentVersion: '1.4.0',
        incomingVersion: '1.3.0',
        modifiedSinceImport: true,
        hasImportBaseline: true
      }
    }
    const installPackage = vi.fn().mockResolvedValue({
      status: 'installed',
      specialist: { id: 'research-synth' }
    })
    const onNavigate = vi.fn()
    useSpecialistStore.setState({ packagePreview: preview, installPackage })

    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={onNavigate} />)
    })
    expect(document.body.textContent).toContain('Review overwrite')
    expect(installPackage).not.toHaveBeenCalled()
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Review overwrite')
        ?.click()
    })

    expect(document.body.textContent).toContain('Local changes will be permanently replaced')
    expect(document.body.textContent).toContain('Current local edits are not recoverable')
    expect(document.body.textContent).toContain('Current version1.4.0')
    expect(document.body.textContent).toContain('Incoming version1.3.0 · downgrade')
    expect(document.body.textContent).toContain('Local edits will be replaced by this import.')
    expect(document.body.textContent).toContain('Export current version first')

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Overwrite and continue')
        ?.click()
    })
    expect(installPackage).toHaveBeenCalledWith(true)
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'research-synth' })
  })

  it('shows imported version and derived modification provenance in list and detail', async () => {
    const imported: SpecialistListItem = {
      ...(specialistItems[0] as Extract<SpecialistListItem, { kind: 'custom' }>),
      kind: 'custom',
      id: 'research-synth',
      origin: 'imported',
      packageVersion: '1.2.0',
      modifiedSinceImport: true,
      importBaseline: {
        importedAt: '2026-08-03T10:00:00.000Z',
        archiveDigest: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64)
      }
    }
    useSpecialistStore.setState({ items: [imported, { kind: 'reviewer', id: 'reviewer' }] })
    ;(window.api.specialist.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      imported,
      { kind: 'reviewer', id: 'reviewer' }
    ])
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })
    expect(document.body.textContent).toContain(
      'Imported · Original version 1.2.0 · Modified after import'
    )

    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'research-synth' }} onNavigate={vi.fn()} />
      )
    })
    expect(document.body.textContent).toContain('Package provenance')
    expect(document.body.textContent).toContain('Original version')
    expect(document.body.textContent).toContain('Modified after import')
  })

  it('filters specialists by a user-entered search term', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const search = document.body.querySelector<HTMLInputElement>('input[type="search"]')
    expect(search).not.toBeNull()
    await act(async () => {
      fireEvent.change(search!, { target: { value: 'literature' } })
    })

    expect(document.body.textContent).toContain('Literature Reviewer')
    expect(document.body.textContent).not.toContain('RNA Reviewer')
  })

  it('shows item counts in each filter tab', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const tabs = document.body.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Filter specialists by category"] [role="tab"]'
    )
    const labels = Array.from(tabs).map((tab) => tab.textContent ?? '')
    // 2 custom + 1 runnable builtin + Reviewer = 4 total
    expect(labels).toEqual(['All(4)', 'Custom(2)', 'Built-in(2)'])
  })

  it('shows a runnable builtin as a read-only row and opens its approved detail view', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    const builtin = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="View Builtin Curator"]'
    )
    expect(builtin).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Toggle Builtin Curator"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Actions for Builtin Curator"]')).toBeNull()
    await act(async () => builtin!.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'builtin', id: 'builtin-curator' })

    await act(async () => {
      root.render(
        <SpecialistsPanel
          view={{ kind: 'builtin', id: 'builtin-curator' }}
          onNavigate={onNavigate}
        />
      )
    })
    expect(document.body.textContent).toContain('Builtin Curator')
    expect(document.body.textContent).toContain('Built-in · Version 1.2.0')
    expect(document.body.textContent).toContain('Read-only')
    expect(document.body.textContent).toContain('literature-review')
    expect(document.body.querySelector('input')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Duplicate|Export|Delete/)
  })

  it('filters the list to custom specialists when the Custom tab is clicked', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const tabs = document.body.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Filter specialists by category"] [role="tab"]'
    )
    const custom = Array.from(tabs).find((tab) => tab.textContent?.includes('Custom'))
    expect(custom).toBeDefined()
    await act(async () => {
      custom!.click()
    })

    expect(document.body.textContent).toContain('RNA Reviewer')
    expect(document.body.textContent).not.toContain('Used by Auto-review')
  })

  it('shows each custom specialist capability mode in the list summary', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Full access')
    expect(document.body.textContent).toContain('Selected capabilities')
  })

  it('renders the saved icon for a custom specialist', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.querySelector('[data-specialist-icon="microscope"]')).not.toBeNull()
  })

  it('navigates to the edit view when a custom specialist row body is clicked', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    const editButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Edit RNA Reviewer"]'
    )
    expect(editButton).not.toBeNull()
    await act(async () => {
      editButton!.click()
    })

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'rna-reviewer' })
  })

  it('keeps an imported setup draft visible and prevents enabling it before setup completes', async () => {
    const pending = {
      ...(specialistItems[0] as Extract<SpecialistListItem, { kind: 'custom' }>),
      enabled: false,
      setupPending: true,
      origin: 'imported' as const
    }
    ;(window.api.specialist.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      pending,
      { kind: 'reviewer', id: 'reviewer' }
    ])
    useSpecialistStore.setState({ items: [pending, { kind: 'reviewer', id: 'reviewer' }] })
    const onNavigate = vi.fn()

    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    expect(document.body.textContent).toContain('Setup incomplete · Continue setup')
    const toggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Complete setup before enabling RNA Reviewer"]'
    )
    expect(toggle?.disabled).toBe(true)
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Continue setup for RNA Reviewer"]')
        ?.click()
    })
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'rna-reviewer' })
    expect(window.api.specialist.setEnabled).not.toHaveBeenCalled()
  })

  it('renders the editor prefilled with the specialist data in the edit view', async () => {
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    const name = document.body.querySelector<HTMLInputElement>('#sp-name')
    expect(name?.value).toBe('RNA Reviewer')
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).some(
        (button) => button.textContent === 'Save changes'
      )
    ).toBe(true)
  })

  it('falls back to the list when the edited specialist no longer exists', async () => {
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'missing-id' }} onNavigate={vi.fn()} />
      )
    })

    // No editor fields — the list view is rendered instead.
    expect(document.body.querySelector('#sp-name')).toBeNull()
    expect(
      document.body.querySelector('[aria-label="Filter specialists by category"]')
    ).not.toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Concurrency and reload (Findings 1, 2, 3)
  // ---------------------------------------------------------------------------

  it('F1: save payload carries the original revision even after a catalog-changed refreshes props', async () => {
    // rev 1 at mount
    const updateMock = vi.fn().mockResolvedValue(specialistItems[0])
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      update: updateMock,
      load: async () => {
        // Simulate remote write: rev bumped to 2 in the store
        useSpecialistStore.setState({
          items: specialistItems.map((item) =>
            item.kind === 'custom' && item.id === 'rna-reviewer' ? { ...item, revision: 2 } : item
          )
        })
      }
    })

    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    // Dirty the form so the save button becomes active.
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer Edited' }
      })
    })

    // Simulate catalog-changed: trigger load which bumps store to rev 2.
    const onCatalogChangedCb = (window.api.specialist.onCatalogChanged as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as (() => void) | undefined
    if (onCatalogChangedCb) {
      await act(async () => {
        onCatalogChangedCb()
      })
    }

    // Click Save — payload must still carry revision 1 (the pinned base revision).
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }))
  })

  it('F2: Reload actually replaces form content with the latest profile data', async () => {
    // updateMock rejects with a conflict so the banner appears.
    const updateMock = vi
      .fn()
      .mockRejectedValue(new Error('Revision conflict: expected 1, found 2.'))
    // After reload, list returns rev 2 with updated name.
    const updatedItems = specialistItems.map((item) =>
      item.kind === 'custom' && item.id === 'rna-reviewer'
        ? { ...item, revision: 2, name: 'RNA Reviewer Updated', description: 'Updated desc' }
        : item
    ) as SpecialistListItem[]

    let listCallCount = 0
    ;(window.api.specialist as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(
      async () => {
        listCallCount++
        if (listCallCount > 1) return updatedItems
        return specialistItems
      }
    )
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      update: updateMock,
      load: async () => {
        const items = await window.api.specialist.list()
        useSpecialistStore.setState({ items })
      }
    })

    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    // Click Save to trigger conflict.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    expect(document.body.querySelector('[aria-label="Revision conflict"]')).not.toBeNull()

    // Click Reload.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Reload')
        ?.click()
    })

    // Form should now show the updated name from the reloaded profile.
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe(
      'RNA Reviewer Updated'
    )
    // Conflict banner is gone.
    expect(document.body.querySelector('[aria-label="Revision conflict"]')).toBeNull()
  })

  it('matches the approved linked-Skill deletion preview and sends only explicit selections', async () => {
    const previewDelete = vi.fn().mockResolvedValue({
      specialistId: 'rna-reviewer',
      specialistName: 'RNA Reviewer',
      expectedRevision: 1,
      skills: [
        {
          id: 'personal-exclusive',
          displayName: 'Exclusive Skill',
          source: 'personal',
          kind: 'owned-exclusive',
          deletable: true,
          reasons: []
        },
        {
          id: 'builtin-tool',
          displayName: 'Built-in Tool',
          source: 'featured',
          kind: 'builtin',
          deletable: false,
          reasons: [{ code: 'builtin', specialistIds: [] }]
        },
        {
          id: 'standalone-tool',
          displayName: 'Standalone Tool',
          source: 'personal',
          kind: 'standalone',
          deletable: false,
          reasons: [{ code: 'standalone', specialistIds: [] }]
        },
        {
          id: 'shared-tool',
          displayName: 'Shared Tool',
          source: 'imported',
          kind: 'shared-owner',
          deletable: false,
          reasons: [{ code: 'shared-owner', specialistIds: ['literature-reviewer'] }]
        },
        {
          id: 'referenced-tool',
          displayName: 'Referenced Tool',
          source: 'personal',
          kind: 'referenced',
          deletable: false,
          reasons: [{ code: 'referenced', specialistIds: ['builtin-curator'] }]
        }
      ]
    })
    const deleteMock = vi.fn().mockResolvedValue({ status: 'deleted' })
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      previewDelete,
      delete: deleteMock,
      load: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    // Open the actions dropdown for RNA Reviewer.
    const actionsBtn = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for RNA Reviewer"]'
    )
    expect(actionsBtn).not.toBeNull()
    openRadixMenu(actionsBtn)
    await act(async () => {
      // small tick to let Radix open the menu
    })

    // Click Delete in the dropdown.
    const deleteItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Delete'))
    expect(deleteItem).not.toBeNull()
    await act(async () => {
      clickRadixMenuItem(deleteItem)
    })

    expect(previewDelete).toHaveBeenCalledWith('rna-reviewer')
    expect(document.body.textContent).toContain('Skills you can also delete')
    expect(document.body.textContent).toContain('Exclusive Skill')
    expect(document.body.textContent).toContain('Shared Tool')
    expect(document.body.textContent).toContain('Imported')
    expect(document.body.textContent).toContain('Personal')
    expect(document.body.textContent).not.toContain('Built-in Tool')
    expect(document.body.textContent).not.toContain('personal-exclusive')
    expect(document.body.textContent).toContain('Already exists independently and will be kept.')
    expect(document.body.textContent).toContain(
      'Also owned by another Specialist and will be kept.'
    )
    expect(document.body.textContent).toContain('Used by another Specialist and will be kept.')
    const checkboxes = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    )
    expect(checkboxes).toHaveLength(4)
    expect(checkboxes.filter((input) => !input.disabled)).toHaveLength(1)
    expect(checkboxes.every((input) => !input.checked)).toBe(true)
    await act(async () => checkboxes.find((input) => !input.disabled)?.click())

    const confirmBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) =>
        btn.textContent === 'Delete Specialist' && btn.closest('[role="alertdialog"]') !== null
    )
    expect(confirmBtn).not.toBeNull()
    await act(async () => {
      confirmBtn!.click()
    })

    expect(deleteMock).toHaveBeenCalledWith('rna-reviewer', 1, ['personal-exclusive'])
  })
})

// ---------------------------------------------------------------------------
// Add specialist › Chat with agent (issue 07 — Settings-to-composer journey)
// ---------------------------------------------------------------------------
describe('SpecialistsPanel Chat with agent', () => {
  const initialProjectStore = useProjectStore.getState()
  let closeSettingsSpy: ReturnType<typeof vi.spyOn>

  const project = (
    id: string,
    updatedAt: number
  ): {
    id: string
    name: string
    description: string
    isExample: boolean
    createdAt: number
    updatedAt: number
  } => ({
    id,
    name: id,
    description: '',
    isExample: false,
    createdAt: 1,
    updatedAt
  })

  beforeEach(() => {
    useSpecialistStore.setState({ ...initialStore, isLoaded: true, items: specialistItems })
    useProjectStore.setState({ ...initialProjectStore, projects: [], isLoaded: true })
    navigationMock.startCustomizeConversation.mockReset()
    closeSettingsSpy = vi
      .spyOn(useSettingsStore.getState(), 'closeSettings')
      .mockImplementation(() => undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    useProjectStore.setState(initialProjectStore, true)
    closeSettingsSpy.mockRestore()
  })

  const openAddSpecialistMenu = (): HTMLElement | undefined =>
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('Add specialist')
    )

  const renderList = async (): Promise<void> => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })
  }

  it('keeps Write from scratch and adds a Chat with agent entry', async () => {
    useProjectStore.setState({ projects: [project('climate-models', 1)] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const labels = items.map((item) => item.textContent ?? '')

    expect(labels.some((label) => label.includes('Write from scratch'))).toBe(true)
    expect(labels.some((label) => label.includes('Chat with agent'))).toBe(true)
  })

  it('opens the approved Import ZIP entry from the existing Add specialist menu', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    openRadixMenu(openAddSpecialistMenu())
    const importItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Import ZIP'))
    await act(async () => clickRadixMenuItem(importItem))

    expect(importItem?.textContent).toContain(
      'Preview a package, then finish setup in the existing editor'
    )
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'import' })
  })

  it('uses the approved Chat with agent subtitle copy', async () => {
    useProjectStore.setState({ projects: [project('climate-models', 1)] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    expect(document.body.textContent).toContain(
      'Start a normal conversation; the agent guides you step by step'
    )
  })

  it('disables Chat with agent and shows the zero-project help text with no projects', async () => {
    useProjectStore.setState({ projects: [] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))

    expect(chatItem).toBeDefined()
    expect(chatItem?.getAttribute('aria-disabled')).toBe('true')
    expect(chatItem?.hasAttribute('data-disabled')).toBe(true)
    expect(document.body.textContent).toContain('Open a project to chat with the agent')
  })

  it('does not start a conversation when Chat with agent is clicked with zero projects', async () => {
    useProjectStore.setState({ projects: [] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))
    // Radix disabled items drop click handling; simulate a click anyway to prove it is inert.
    await act(async () => {
      chatItem?.click()
    })

    expect(navigationMock.startCustomizeConversation).not.toHaveBeenCalled()
    expect(closeSettingsSpy).not.toHaveBeenCalled()
  })

  it('disables Chat with agent when every project is archived', async () => {
    useProjectStore.setState({
      projects: [{ ...project('archived-project', 5), archivedAt: 2 }]
    })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))

    expect(chatItem?.getAttribute('aria-disabled')).toBe('true')
    expect(navigationMock.startCustomizeConversation).not.toHaveBeenCalled()
  })

  it('resolves Chat with agent from active projects only', async () => {
    useProjectStore.setState({
      projects: [
        { ...project('archived-project', 10), archivedAt: 2 },
        project('active-project', 5)
      ]
    })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))
    await act(async () => clickRadixMenuItem(chatItem))

    expect(navigationMock.startCustomizeConversation).toHaveBeenCalledWith(
      'active-project',
      'specialist'
    )
  })

  it('closes Settings and starts a customize conversation for the resolved project', async () => {
    useProjectStore.setState({ projects: [project('climate-models', 5)] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))
    await act(async () => {
      clickRadixMenuItem(chatItem)
    })

    expect(navigationMock.startCustomizeConversation).toHaveBeenCalledWith(
      'climate-models',
      'specialist'
    )
    expect(closeSettingsSpy).toHaveBeenCalled()
  })

  it('stays within navigation/prefill intent: no Specialist binding or create-form navigation', async () => {
    const onNavigate = vi.fn()
    useProjectStore.setState({ projects: [project('climate-models', 5)] })
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))
    await act(async () => {
      clickRadixMenuItem(chatItem)
    })

    // No create-form navigation, no specialist create — pure navigation/prefill intent.
    expect(onNavigate).not.toHaveBeenCalled()
  })
})
