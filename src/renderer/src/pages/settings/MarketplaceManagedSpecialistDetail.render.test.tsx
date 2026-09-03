// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, getByRole, getByText } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MarketplaceManagedSpecialistDetail } from './MarketplaceManagedSpecialistDetail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MarketplaceManagedSpecialistDetail', () => {
  it('renders package content as readable data and exposes only managed actions', async () => {
    const onToggle = vi.fn()
    const onDuplicate = vi.fn()
    const onUpdate = vi.fn()
    const onUninstall = vi.fn()
    await act(async () => {
      root.render(
        <MarketplaceManagedSpecialistDetail
          specialist={{
            kind: 'custom',
            id: 'managed-specialist',
            name: 'MANAGED_SPECIALIST',
            displayName: 'Managed Specialist',
            description: 'Publisher-owned description',
            systemPrompt: 'Publisher-owned instructions',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: {
              excludedSkillIds: ['literature-review'],
              excludedConnectorIds: ['pubmed'],
              connectorTools: []
            },
            selectedCapabilities: {
              skillIds: [],
              connectorIds: [],
              connectorTools: []
            },
            revision: 3,
            packageVersion: '1.0.0',
            origin: 'marketplace',
            marketplaceProvenance: {
              sourceId: 'official',
              publisher: 'Open Science',
              version: '1.0.0'
            }
          }}
          update={{
            sourceId: 'official',
            sourceName: 'Open Science Marketplace',
            sourceTrust: 'official',
            id: 'managed-specialist',
            displayName: 'Managed Specialist',
            summary: 'Publisher-owned description',
            publisher: { id: 'open-science', name: 'Open Science' },
            version: '1.1.0',
            installedVersion: '1.0.0',
            updateAvailable: true
          }}
          sourceMissing={false}
          onBack={vi.fn()}
          onAppearanceChange={vi.fn().mockResolvedValue(undefined)}
          onToggle={onToggle}
          onDuplicate={onDuplicate}
          onUpdate={onUpdate}
          onManageSources={vi.fn()}
          onUninstall={onUninstall}
        />
      )
    })

    expect(getByText(container, 'Publisher-owned instructions')).toBeTruthy()
    expect(getByText(container, 'Excluded Skills')).toBeTruthy()
    expect(getByText(container, 'Excluded Connectors')).toBeTruthy()
    expect(getByText(container, 'literature-review')).toBeTruthy()
    expect(getByText(container, 'pubmed')).toBeTruthy()
    expect(container.querySelector('input, textarea')).toBeNull()

    fireEvent.click(getByRole(container, 'button', { name: 'Update Specialist' }))
    fireEvent.click(getByRole(container, 'button', { name: 'Create editable copy' }))
    fireEvent.click(getByRole(container, 'button', { name: 'Uninstall' }))
    fireEvent.click(getByRole(container, 'switch'))

    expect(onUpdate).toHaveBeenCalledOnce()
    expect(onDuplicate).toHaveBeenCalledOnce()
    expect(onUninstall).toHaveBeenCalledOnce()
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
