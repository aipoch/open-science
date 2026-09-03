// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistEditor } from './SpecialistEditor'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import {
  SPECIALIST_DESCRIPTION_MAX_LENGTH,
  SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH,
  type SpecialistView
} from '../../../../shared/specialist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({
    skills: [],
    loadSkills: vi.fn().mockResolvedValue(undefined),
    loadConnectors: vi.fn().mockResolvedValue(undefined)
  })
  useSpecialistStore.setState({ editorDrafts: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('SpecialistEditor', () => {
  it('keeps unavailable Skill references removable without offering them', async () => {
    useSettingsStore.setState({
      skills: [
        {
          id: 'selected-conflict',
          name: 'Selected conflict package',
          displayName: 'Selected conflict package',
          description: '',
          source: 'personal',
          enabled: true,
          updatedAt: '',
          available: false,
          availability: 'identity-conflict'
        },
        {
          id: 'add-conflict',
          name: 'Add conflict package',
          displayName: 'Add conflict package',
          description: '',
          source: 'imported',
          enabled: true,
          updatedAt: '',
          available: false,
          availability: 'identity-conflict'
        },
        {
          id: 'usable',
          name: 'Usable Skill',
          displayName: 'Usable Skill',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ]
    })

    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'conflict-bot',
            name: 'Conflict Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: {
              excludedSkillIds: [],
              excludedConnectorIds: [],
              connectorTools: []
            },
            selectedCapabilities: {
              skillIds: ['selected-conflict'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn()}
        />
      )
    })

    expect(document.body.textContent).toContain('selected-conflict')
    expect(document.body.textContent).toContain('Missing · unavailable')
    expect(document.body.textContent).not.toContain('Selected conflict package')

    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === '＋ Add a skill'
        )!
      )
    })

    expect(document.body.textContent).toContain('Usable Skill')
    expect(document.body.textContent).not.toContain('Add conflict package')
  })

  it('edits Skill scopes independently, shows Main-disabled and missing IDs, and preserves the other mode', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      skills: [
        {
          id: 'main-disabled',
          name: 'Main disabled',
          displayName: 'Main disabled',
          description: '',
          source: 'featured',
          enabled: false,
          updatedAt: ''
        },
        {
          id: 'included',
          name: 'Included',
          displayName: 'Included',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ],
      loadSkills: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'skills-bot',
            name: 'Skills Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: {
              excludedSkillIds: ['included'],
              excludedConnectorIds: [],
              connectorTools: []
            },
            selectedCapabilities: {
              skillIds: ['main-disabled', 'missing-stable-id'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })
    // Full access is on by default.
    expect(
      document.body.querySelector('[aria-label="Full access"]')?.getAttribute('aria-checked')
    ).toBe('true')

    // Turn Full access off to edit the Skills whitelist.
    await act(async () => {
      fireEvent.click(document.body.querySelector<HTMLButtonElement>('[aria-label="Full access"]')!)
    })
    expect(
      document.body.querySelector('[aria-label="Full access"]')?.getAttribute('aria-checked')
    ).toBe('false')

    // Skills tab is active by default. Both persisted selections render, including the
    // Main-disabled (still usable here) and a stale missing ID.
    expect(document.body.textContent).toContain('Main disabled · available here')
    expect(document.body.textContent).toContain('missing-stable-id')
    expect(document.body.textContent).toContain('Missing · unavailable')
    expect(document.body.textContent).not.toContain('Hard enforced')
    expect(document.body.textContent).not.toContain('Guidance only')

    // Remove "Main disabled" from the whitelist, leaving only the missing reference.
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLButtonElement>('[aria-label="Remove Main disabled"]')!
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === 'Save changes'
        )!
      )
    })
    expect(onSaveEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityMode: 'selected',
        fullAccess: expect.objectContaining({ excludedSkillIds: ['included'] }),
        selectedCapabilities: expect.objectContaining({ skillIds: ['missing-stable-id'] })
      })
    )
  })

  it('persists Full exclusions and Selected inclusions without losing either mode', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      connectors: [
        {
          id: 'chemistry',
          name: 'chemistry',
          displayName: 'Chemistry',
          description: '',
          sources: [],
          requiresNcbi: false,
          enabled: true,
          autoAllow: false,
          group: 'featured'
        },
        {
          id: 'pubmed',
          name: 'pubmed',
          displayName: 'PubMed',
          description: '',
          sources: [],
          requiresNcbi: true,
          enabled: false,
          autoAllow: false,
          group: 'directory'
        }
      ],
      customServers: [
        {
          id: 'broken-server-uuid',
          name: 'broken-server',
          displayName: 'Broken Server',
          transport: 'stdio',
          enabled: true,
          availability: 'unavailable'
        },
        {
          id: 'custom-server-uuid',
          name: 'public-route',
          displayName: 'Public Route',
          transport: 'stdio',
          enabled: true
        }
      ],
      loadConnectors: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'connector-bot',
            name: 'Connector Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: {
              excludedSkillIds: [],
              excludedConnectorIds: ['pubmed'],
              connectorTools: []
            },
            selectedCapabilities: {
              skillIds: [],
              connectorIds: ['broken-server'],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })

    // Turn Full access off, then open the Connectors tab.
    await act(async () => {
      fireEvent.click(document.body.querySelector<HTMLButtonElement>('[aria-label="Full access"]')!)
    })
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) =>
          tab.textContent?.includes('Connectors')
        )!
      )
    })

    // The persisted unavailable custom server stays visible (and removable) instead of silently
    // broadening the profile. Main-disabled connectors (PubMed) are not in the list yet.
    expect(document.body.textContent).toContain('Broken Server')
    expect(document.body.textContent).toContain('Unavailable — unavailable')
    expect(document.body.textContent).not.toContain('broken-server-uuid')

    // Remove the legacy-name reference, then add a bundled Connector and a custom Connector.
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLButtonElement>('[aria-label="Remove Broken Server"]')!
      )
    })
    // Open the native add-connector popover and pick Chemistry (the dropdown was reworked from
    // Radix DropdownMenu to a native positioned popover, so drive the trigger + item directly).
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === '＋ Add a connector'
        )!
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === 'Chemistry'
        )!
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === '＋ Add a connector'
        )!
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === 'Public Route'
        )!
      )
    })

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })
    expect(onSaveEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityMode: 'selected',
        fullAccess: expect.objectContaining({ excludedConnectorIds: ['pubmed'] }),
        selectedCapabilities: expect.objectContaining({
          connectorIds: ['chemistry', 'custom-server-uuid']
        })
      })
    )
  })

  it('saves the icon and color selected for a new specialist', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={onSave} />)
    })

    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer' }
      })
    })

    const icon = document.body.querySelector<HTMLButtonElement>('[aria-label="Specialist icon"]')
    expect(icon).not.toBeNull()
    openRadixMenu(icon)
    await act(async () => {
      clickRadixMenuItem(
        Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
          (option) => option.textContent === 'Microscope'
        )
      )
    })

    const color = document.body.querySelector<HTMLButtonElement>('[aria-label="Specialist color"]')
    expect(color).not.toBeNull()
    openRadixMenu(color)
    await act(async () => {
      clickRadixMenuItem(
        Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
          (option) => option.textContent === 'Teal'
        )
      )
    })

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create specialist')
        ?.click()
    })

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'RNA Reviewer',
        iconKey: 'microscope',
        colorKey: 'teal'
      })
    )
  })

  it('previews an ID from the name and saves a valid user override', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={onSave} />)
    })

    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA-seq Reviewer' }
      })
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === 'Advanced settings'
        )!
      )
    })

    const idInput = document.body.querySelector<HTMLInputElement>('#sp-specialist-id')!
    expect(idInput.value).toBe('rna-seq-reviewer')

    await act(async () => {
      fireEvent.change(idInput, { target: { value: 'transcriptomics-reviewer' } })
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create specialist')
        ?.click()
    })

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'transcriptomics-reviewer', name: 'RNA-seq Reviewer' })
    )
  })

  it('leaves an untouched inferred ID for the main process to generate authoritatively', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={onSave} />)
    })

    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA-seq Reviewer' }
      })
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === 'Advanced settings'
        )!
      )
    })

    expect(document.body.querySelector<HTMLInputElement>('#sp-specialist-id')!.value).toBe(
      'rna-seq-reviewer'
    )

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create specialist')
        ?.click()
    })

    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('id')
  })

  it('previews and saves a UUID when the name cannot produce a valid ID', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={onSave} />)
    })

    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'MCP Research' }
      })
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === 'Advanced settings'
        )!
      )
    })

    const generatedId = document.body.querySelector<HTMLInputElement>('#sp-specialist-id')!.value
    expect(generatedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create specialist')
        ?.click()
    })

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: generatedId, name: 'MCP Research' })
    )
  })

  it('validates a user-provided ID while typing and blocks invalid creation', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={onSave} />)
    })

    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer' }
      })
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === 'Advanced settings'
        )!
      )
    })
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-specialist-id')!, {
        target: { value: 'hello ee' }
      })
    })

    const idInput = document.body.querySelector<HTMLInputElement>('#sp-specialist-id')!
    expect(idInput.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain(
      'ID may only contain lowercase letters, numbers, and hyphens.'
    )

    await act(async () => {
      fireEvent.change(idInput, { target: { value: 'hello-ee' } })
    })

    expect(idInput.getAttribute('aria-invalid')).toBeNull()
    expect(document.body.textContent).not.toContain(
      'ID may only contain lowercase letters, numbers, and hyphens.'
    )

    await act(async () => {
      fireEvent.change(idInput, { target: { value: 'hello ee' } })
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create specialist')
        ?.click()
    })

    expect(onSave).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      'ID may only contain lowercase letters, numbers, and hyphens.'
    )
  })

  it('focuses the open capability search with Cmd/Ctrl+K', async () => {
    useSettingsStore.setState({
      skills: [
        {
          id: 'literature-review',
          name: 'Literature Review',
          displayName: 'Literature Review',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ],
      loadSkills: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={vi.fn()} />)
    })
    await act(async () => {
      fireEvent.click(document.body.querySelector<HTMLElement>('[aria-label="Full access"]')!)
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent === '＋ Add a skill'
        )!
      )
    })

    const search = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Search skills to add"]'
    )
    expect(search).not.toBeNull()
    search?.blur()
    const shortcutEvent = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      cancelable: true
    })
    await act(async () => window.dispatchEvent(shortcutEvent))

    expect(shortcutEvent.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(search)
    expect(search?.getAttribute('aria-keyshortcuts')).toBe('Control+K')
  })

  it('shows a field-level error instead of submitting a duplicate name', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SpecialistEditor existingNames={['RNA Reviewer']} onCancel={vi.fn()} onSave={onSave} />
      )
    })

    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer' }
      })
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create specialist')
        ?.click()
    })

    expect(document.body.querySelector('#sp-name-err')?.textContent).toContain('already in use')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('prefills the form and calls onSaveEdit with id and revision in edit mode', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'rna-reviewer',
            name: 'RNA Reviewer',
            description: 'Reviews RNA-seq.',
            systemPrompt: 'Be rigorous.',
            iconKey: 'microscope',
            colorKey: 'teal',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 3
          }}
          existingNames={['Other Name']}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })

    // Prefilled identity.
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe('RNA Reviewer')

    // Edit mode uses the "Save changes" button and routes through onSaveEdit.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })

    expect(onSaveEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'rna-reviewer',
        revision: 3,
        displayName: 'RNA Reviewer'
      })
    )
    // Create path is not used in edit mode.
    expect(document.body.querySelector('#sp-name-err')).toBeNull()
  })

  it('completes pending import setup only when Save changes succeeds', async () => {
    const onCancel = vi.fn()
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'imported-draft',
            name: 'Imported Draft',
            description: '',
            systemPrompt: '',
            enabled: false,
            setupPending: true,
            origin: 'imported',
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['bundled-analysis'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={onCancel}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })

    expect(document.body.textContent).toContain('Setup incomplete')
    expect(document.body.textContent).toContain('saved but disabled')
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Cancel')
        ?.click()
    })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSaveEdit).not.toHaveBeenCalled()

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })
    expect(onSaveEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'imported-draft',
        revision: 1,
        completeSetup: true,
        capabilityMode: 'selected',
        selectedCapabilities: expect.objectContaining({ skillIds: ['bundled-analysis'] })
      })
    )
  })

  it('lets a custom specialist explicitly bump its package version', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'versioned-bot',
            name: 'Versioned Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 4,
            packageVersion: '1.2.0',
            origin: 'local'
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })

    const version = document.body.querySelector<HTMLInputElement>('#sp-package-version')
    expect(version?.value).toBe('1.2.0')
    await act(async () => {
      fireEvent.change(version!, { target: { value: '2.0.0' } })
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })

    expect(onSaveEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'versioned-bot', revision: 4, packageVersion: '2.0.0' })
    )
  })

  it('renders a live preview avatar reflecting the selected icon', async () => {
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'rna-reviewer',
            name: 'RNA Reviewer',
            description: '',
            systemPrompt: '',
            iconKey: 'microscope',
            colorKey: 'teal',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 1
          }}
          existingNames={[]}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn()}
        />
      )
    })

    // The live preview renders the selected icon glyph.
    expect(document.body.querySelector('[data-specialist-icon="microscope"]')).not.toBeNull()
  })

  it('caps identity inputs and shows live character counters', async () => {
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={vi.fn()} />)
    })
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')!.maxLength).toBe(80)
    expect(document.body.querySelector<HTMLInputElement>('#sp-description')!.maxLength).toBe(
      SPECIALIST_DESCRIPTION_MAX_LENGTH
    )
    expect(document.body.querySelector<HTMLTextAreaElement>('#sp-system-prompt')!.maxLength).toBe(
      SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH
    )
    expect(document.body.textContent).toContain('/ 80')
    expect(document.body.textContent).toContain(`/ ${SPECIALIST_DESCRIPTION_MAX_LENGTH}`)
    expect(document.body.textContent).toContain(
      `/ ${SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH.toLocaleString()}`
    )
  })

  it('shows the saved identity bar only in edit mode', async () => {
    const findSavedTag = (): HTMLElement | undefined =>
      Array.from(document.body.querySelectorAll<HTMLElement>('span')).find(
        (el) => el.textContent?.trim() === 'Saved'
      )

    // Create mode: nothing is saved yet, so no identity bar.
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={vi.fn()} />)
    })
    expect(findSavedTag()).toBeUndefined()

    // Edit mode: the saved identity bar renders the persisted name + description.
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'rna-reviewer',
            name: 'RNA Reviewer',
            description: 'Reviews RNA-seq.',
            systemPrompt: '',
            iconKey: 'microscope',
            colorKey: 'teal',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 1
          }}
          existingNames={[]}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn()}
        />
      )
    })
    expect(findSavedTag()).toBeTruthy()
  })

  it('shows conflict banner and preserves local edits when onSaveEdit throws a revision conflict', async () => {
    const revisionConflictError = new Error('Revision conflict: expected 1, found 2.')
    const onSaveEdit = vi.fn().mockRejectedValue(revisionConflictError)

    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'conflict-bot',
            name: 'Conflict Bot',
            description: 'Original description',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 1
          }}
          existingNames={[]}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })

    // Edit the description to simulate unsaved local changes.
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-description')!, {
        target: { value: 'My unsaved edit' }
      })
    })

    // Click Save — triggers the revision conflict.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    // Conflict banner must appear.
    expect(document.body.querySelector('[aria-label="Revision conflict"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Someone else saved a newer version')

    // Local edits must be preserved — description field retains the unsaved text.
    expect(document.body.querySelector<HTMLInputElement>('#sp-description')?.value).toBe(
      'My unsaved edit'
    )

    // Save button is disabled while conflict is active (prevents a write that
    // would still lose the newer server version).
    const saveButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'Save changes'
    )
    expect(saveButton?.disabled).toBe(true)
  })

  it('calls onReload when the user clicks Reload in the conflict banner', async () => {
    const revisionConflictError = new Error('Revision conflict: expected 1, found 2.')
    const onSaveEdit = vi.fn().mockRejectedValue(revisionConflictError)
    const onReload = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'reload-bot',
            name: 'Reload Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 1
          }}
          existingNames={[]}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
          onReload={onReload}
        />
      )
    })

    // Trigger conflict.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    // Conflict banner appears with a Reload button.
    const reloadBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'Reload'
    )
    expect(reloadBtn).not.toBeNull()

    // Click Reload — must call onReload once.
    await act(async () => {
      reloadBtn?.click()
    })

    expect(onReload).toHaveBeenCalledOnce()
  })

  it('opens the skill detail when a selected skill row is clicked', async () => {
    const onOpenSkillDetail = vi.fn()
    useSettingsStore.setState({
      skills: [
        {
          id: 'literature-review',
          name: 'Literature Review',
          displayName: 'Literature Review',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ],
      loadSkills: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'skills-bot',
            name: 'Skills Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['literature-review'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
          onOpenSkillDetail={onOpenSkillDetail}
        />
      )
    })

    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>('[aria-label="View Literature Review details"]')!
      )
    })

    expect(onOpenSkillDetail).toHaveBeenCalledOnce()
    expect(onOpenSkillDetail).toHaveBeenCalledWith('literature-review')
  })

  it('opens connector details on row click, mapping a legacy server name to its canonical id', async () => {
    const onOpenConnectorDetail = vi.fn()
    useSettingsStore.setState({
      connectors: [
        {
          id: 'chemistry',
          name: 'chemistry',
          displayName: 'Chemistry',
          description: '',
          sources: [],
          requiresNcbi: false,
          enabled: true,
          autoAllow: false,
          group: 'featured'
        }
      ],
      customServers: [
        {
          id: 'public-route-uuid',
          name: 'public-route',
          displayName: 'Public Route',
          transport: 'stdio',
          enabled: true
        }
      ],
      loadConnectors: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'connector-bot',
            name: 'Connector Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: [],
              // 'public-route' is a legacy reference stored by server name.
              connectorIds: ['chemistry', 'public-route'],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
          onOpenConnectorDetail={onOpenConnectorDetail}
        />
      )
    })

    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) =>
          tab.textContent?.includes('Connectors')
        )!
      )
    })
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>('[aria-label="View Chemistry details"]')!
      )
    })
    expect(onOpenConnectorDetail).toHaveBeenCalledWith('chemistry')

    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>('[aria-label="View Public Route details"]')!
      )
    })
    expect(onOpenConnectorDetail).toHaveBeenLastCalledWith('public-route-uuid')
  })

  it('keeps missing skills and unavailable connectors non-clickable', async () => {
    const onOpenSkillDetail = vi.fn()
    const onOpenConnectorDetail = vi.fn()
    useSettingsStore.setState({
      customServers: [
        {
          id: 'broken-server-uuid',
          name: 'broken-server',
          displayName: 'Broken Server',
          transport: 'stdio',
          enabled: true,
          availability: 'unavailable'
        }
      ],
      loadConnectors: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'stale-bot',
            name: 'Stale Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['legacy-pipeline'],
              connectorIds: ['broken-server'],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
          onOpenSkillDetail={onOpenSkillDetail}
          onOpenConnectorDetail={onOpenConnectorDetail}
        />
      )
    })

    // Neither row exposes a click target or navigation semantics.
    expect(document.body.querySelector('[aria-label="View legacy-pipeline details"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="View Broken Server details"]')).toBeNull()

    // Clicking the row container (around the remove action) still never navigates.
    const missingRow = document.body
      .querySelector('[aria-label="Remove legacy-pipeline"]')!
      .closest('div.border-b')!
    await act(async () => {
      fireEvent.click(missingRow)
    })
    expect(onOpenSkillDetail).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) =>
          tab.textContent?.includes('Connectors')
        )!
      )
    })
    const unavailableRow = document.body
      .querySelector('[aria-label="Remove Broken Server"]')!
      .closest('div.border-b')!
    await act(async () => {
      fireEvent.click(unavailableRow)
    })
    expect(onOpenConnectorDetail).not.toHaveBeenCalled()
  })

  it('removes a skill from the remove action without triggering navigation', async () => {
    const onOpenSkillDetail = vi.fn()
    useSettingsStore.setState({
      skills: [
        {
          id: 'literature-review',
          name: 'Literature Review',
          displayName: 'Literature Review',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ],
      loadSkills: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'skills-bot',
            name: 'Skills Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['literature-review'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
          onOpenSkillDetail={onOpenSkillDetail}
        />
      )
    })

    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLButtonElement>('[aria-label="Remove Literature Review"]')!
      )
    })

    expect(onOpenSkillDetail).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Literature Review')
  })

  it('renders plain non-clickable rows when no detail callbacks are provided', async () => {
    useSettingsStore.setState({
      skills: [
        {
          id: 'literature-review',
          name: 'Literature Review',
          displayName: 'Literature Review',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ],
      loadSkills: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'skills-bot',
            name: 'Skills Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['literature-review'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
        />
      )
    })

    expect(document.body.textContent).toContain('Literature Review')
    expect(document.body.querySelector('[aria-label="View Literature Review details"]')).toBeNull()
  })

  it('activates a clickable skill row from the keyboard', async () => {
    const onOpenSkillDetail = vi.fn()
    useSettingsStore.setState({
      skills: [
        {
          id: 'literature-review',
          name: 'Literature Review',
          displayName: 'Literature Review',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ],
      loadSkills: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'skills-bot',
            name: 'Skills Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['literature-review'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
          onOpenSkillDetail={onOpenSkillDetail}
        />
      )
    })

    const row = document.body.querySelector<HTMLElement>(
      '[aria-label="View Literature Review details"]'
    )!
    await act(async () => {
      fireEvent.keyDown(row, { key: 'Enter' })
    })
    expect(onOpenSkillDetail).toHaveBeenCalledWith('literature-review')

    await act(async () => {
      fireEvent.keyDown(row, { key: ' ' })
    })
    expect(onOpenSkillDetail).toHaveBeenCalledTimes(2)
  })

  it('restores an unsaved edit after navigating to a detail page and back', async () => {
    const profile: SpecialistView = {
      id: 'skills-bot',
      name: 'Skills Bot',
      description: 'Original description',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: ['literature-review'],
        connectorIds: ['chemistry'],
        connectorTools: []
      },
      revision: 1
    }
    useSettingsStore.setState({
      skills: [
        {
          id: 'literature-review',
          name: 'Literature Review',
          displayName: 'Literature Review',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ],
      connectors: [
        {
          id: 'chemistry',
          name: 'chemistry',
          displayName: 'Chemistry',
          description: '',
          sources: [],
          requiresNcbi: false,
          enabled: true,
          autoAllow: false,
          group: 'featured'
        }
      ],
      loadSkills: vi.fn().mockResolvedValue(undefined),
      loadConnectors: vi.fn().mockResolvedValue(undefined)
    })
    const renderEditor = (onOpenConnectorDetail = vi.fn()): void => {
      act(() => {
        root.render(
          <SpecialistEditor
            editSpecialist={{ ...profile }}
            onCancel={vi.fn()}
            onSave={vi.fn()}
            onSaveEdit={vi.fn().mockResolvedValue(undefined)}
            onOpenConnectorDetail={onOpenConnectorDetail}
          />
        )
      })
    }
    renderEditor()

    // Make an unsaved edit and switch to the Connectors capability tab.
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-description')!, {
        target: { value: 'My unsaved edit' }
      })
    })
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) =>
          tab.textContent?.includes('Connectors')
        )!
      )
    })

    // Navigate away (row click) — the editor unmounts when Settings switches panels.
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>('[aria-label="View Chemistry details"]')!
      )
    })
    await act(() => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    // Back returns to the editor: the unsaved edit and the active tab survive.
    renderEditor()
    expect(document.body.querySelector<HTMLInputElement>('#sp-description')?.value).toBe(
      'My unsaved edit'
    )
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((tab) => tab.textContent?.includes('Connectors'))
        ?.getAttribute('aria-selected')
    ).toBe('true')
  })

  it('drops the editor draft after a successful save or an explicit cancel', async () => {
    const profile: SpecialistView = {
      id: 'draft-bot',
      name: 'Draft Bot',
      description: 'Original description',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1
    }
    const remount = (): void => {
      act(() => {
        root.unmount()
      })
      container.remove()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      act(() => {
        root.render(
          <SpecialistEditor
            editSpecialist={{ ...profile }}
            onCancel={vi.fn()}
            onSave={vi.fn()}
            onSaveEdit={vi.fn().mockResolvedValue(undefined)}
          />
        )
      })
    }
    remount()

    // Save succeeds: the draft must not resurrect the pre-save edit later.
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-description')!, {
        target: { value: 'Saved soon' }
      })
    })
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })
    remount()
    expect(document.body.querySelector<HTMLInputElement>('#sp-description')?.value).toBe(
      'Original description'
    )

    // Cancel discards explicitly: the draft is cleared too.
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-description')!, {
        target: { value: 'Cancelled edit' }
      })
    })
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Cancel')
        ?.click()
    })
    remount()
    expect(document.body.querySelector<HTMLInputElement>('#sp-description')?.value).toBe(
      'Original description'
    )
  })

  it('ignores a stale draft when the specialist revision advanced meanwhile', async () => {
    const profile: SpecialistView = {
      id: 'stale-bot',
      name: 'Stale Bot',
      description: 'Original description',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1
    }
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{ ...profile }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
        />
      )
    })
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-description')!, {
        target: { value: 'Edit on revision 1' }
      })
    })
    await act(() => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    // The profile was saved elsewhere (revision 2): the draft taken at revision 1 is stale.
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{ ...profile, description: 'Newer saved description', revision: 2 }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
        />
      )
    })
    expect(document.body.querySelector<HTMLInputElement>('#sp-description')?.value).toBe(
      'Newer saved description'
    )
  })

  it('restores a create-form draft across mounts', async () => {
    const renderCreate = (): void => {
      act(() => {
        root.render(<SpecialistEditor onCancel={vi.fn()} onSave={vi.fn()} />)
      })
    }
    renderCreate()
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer' }
      })
    })
    await act(() => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    renderCreate()

    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe('RNA Reviewer')
  })

  it('does not navigate when the remove action is activated from the keyboard', async () => {
    const onOpenSkillDetail = vi.fn()
    useSettingsStore.setState({
      skills: [
        {
          id: 'literature-review',
          name: 'Literature Review',
          displayName: 'Literature Review',
          description: '',
          source: 'featured',
          enabled: true,
          updatedAt: ''
        }
      ],
      loadSkills: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'skills-bot',
            name: 'Skills Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['literature-review'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
          onOpenSkillDetail={onOpenSkillDetail}
        />
      )
    })

    // Focus lands on the remove button; pressing Enter must remove the row via the button's
    // own activation, never the row's keyboard navigation.
    await act(async () => {
      fireEvent.keyDown(
        document.body.querySelector<HTMLButtonElement>('[aria-label="Remove Literature Review"]')!,
        { key: 'Enter' }
      )
    })
    expect(onOpenSkillDetail).not.toHaveBeenCalled()
  })

  it('clears the editor draft from the store after a successful save', async () => {
    const profile: SpecialistView = {
      id: 'save-clears-draft',
      name: 'Save Clears Draft',
      description: 'Original',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1
    }
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={profile}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn().mockResolvedValue(undefined)}
        />
      )
    })
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-description')!, {
        target: { value: 'Edited then saved' }
      })
    })
    expect(useSpecialistStore.getState().editorDrafts[profile.id]).toBeDefined()

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })

    // The save advances the form revision; that re-render must not re-create the draft.
    expect(useSpecialistStore.getState().editorDrafts[profile.id]).toBeUndefined()
  })

  it('prefers a provided initial input over a stale create draft', async () => {
    useSpecialistStore.setState({
      editorDrafts: {
        __create__: {
          form: {
            id: '',
            name: 'Abandoned Half Done',
            packageVersion: '0.1.0',
            description: '',
            systemPrompt: '',
            iconKey: 'brain',
            colorKey: 'purple',
            capabilityMode: 'full',
            excludedSkillIds: [],
            selectedSkillIds: [],
            excludedConnectorIds: [],
            connectorIds: [],
            baseRevision: 0
          },
          idTouched: false,
          activeCapTab: 'skills'
        }
      }
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          onCancel={vi.fn()}
          onSave={vi.fn()}
          initialInput={{
            name: 'Marketplace Imported',
            description: 'Prefilled by an import',
            capabilityMode: 'selected',
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
          }}
        />
      )
    })

    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe(
      'Marketplace Imported'
    )
  })

  it('does not show a conflict banner for non-conflict errors', async () => {
    const onSaveEdit = vi.fn().mockRejectedValue(new Error('Network error'))

    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'net-err-bot',
            name: 'Net Err Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 1
          }}
          existingNames={[]}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    // Must show the generic error, not the conflict banner.
    expect(document.body.querySelector('[aria-label="Revision conflict"]')).toBeNull()
    expect(document.body.textContent).toContain('Network error')
  })
})
