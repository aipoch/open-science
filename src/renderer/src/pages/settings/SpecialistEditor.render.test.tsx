// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistEditor } from './SpecialistEditor'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'
import { useSettingsStore } from '@/stores/settings-store'
import { SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH } from '../../../../shared/specialist'

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
  it('edits Skill scopes independently, shows Main-disabled and missing IDs, and preserves the other mode', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      skills: [
        {
          id: 'main-disabled',
          name: 'Main disabled',
          description: '',
          source: 'featured',
          enabled: false,
          updatedAt: ''
        },
        {
          id: 'included',
          name: 'Included',
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
          id: 'broken-server',
          name: 'Broken Server',
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
              connectorIds: ['Broken Server'],
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

    // Remove the broken server, then add Chemistry from the add menu.
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
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })
    expect(onSaveEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityMode: 'selected',
        fullAccess: expect.objectContaining({ excludedConnectorIds: ['pubmed'] }),
        selectedCapabilities: expect.objectContaining({ connectorIds: ['chemistry'] })
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
        name: 'RNA Reviewer'
      })
    )
    // Create path is not used in edit mode.
    expect(document.body.querySelector('#sp-name-err')).toBeNull()
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
    expect(document.body.querySelector<HTMLInputElement>('#sp-description')!.maxLength).toBe(200)
    expect(document.body.querySelector<HTMLTextAreaElement>('#sp-system-prompt')!.maxLength).toBe(
      SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH
    )
    expect(document.body.textContent).toContain('/ 80')
    expect(document.body.textContent).toContain('/ 200')
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
