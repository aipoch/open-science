// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpecialistCapabilitiesSection } from '@/pages/settings/SpecialistCapabilitiesSection'
const data = vi.hoisted(() => ({
  skills: [{ id: 's1', name: 'Audit skill', enabled: true, available: true }],
  connectors: [{ id: 'c1', name: 'catalog', displayName: 'Catalog connector', enabled: true }],
  customServers: [],
  loadConnectors: vi.fn(),
  loadSkills: vi.fn()
}))
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: (select: (state: typeof data) => unknown) => select(data)
}))
vi.mock('@/stores/tag-store', () => ({
  useTagStore: (select: (state: { assignments: never[] }) => unknown) => select({ assignments: [] })
}))
vi.mock('@/pages/settings/ResourceTagControls', () => ({ TagFilter: () => null }))
let props: ComponentProps<typeof SpecialistCapabilitiesSection>
beforeEach(() => {
  props = {
    capabilityMode: 'selected',
    onCapabilityModeChange: vi.fn(),
    selectedSkillIds: [],
    excludedSkillIds: [],
    selectedConnectorIds: [],
    excludedConnectorIds: [],
    updateSkillIds: vi.fn(),
    updateConnectorIds: vi.fn(),
    activeTab: 'skills',
    onActiveTabChange: vi.fn()
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it('full access prevents changes to inactive selected capabilities', () => {
  render(
    <SpecialistCapabilitiesSection {...props} capabilityMode="full" selectedSkillIds={['s1']} />
  )
  const remove = screen.getByRole('button', { name: 'Remove Audit skill' }) as HTMLButtonElement
  fireEvent.click(remove)
  expect(props.updateSkillIds).not.toHaveBeenCalled()
  expect(props.onCapabilityModeChange).not.toHaveBeenCalled()
})
it('capability tabs move focus to the next tab with ArrowRight', async () => {
  render(<SpecialistCapabilitiesSection {...props} />)
  const tabs = screen.getAllByRole('tab')
  act(() => tabs[0].focus())
  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
  await waitFor(() => expect(document.activeElement).toBe(tabs[1]))
})
it('choosing a capability restores focus to its add trigger', async () => {
  render(<SpecialistCapabilitiesSection {...props} />)
  const trigger = screen.getByRole('button', { name: '＋ Add a skill' })
  fireEvent.click(trigger)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox')))
  const choice = screen.getByRole('button', { name: 'Audit skill' })
  act(() => choice.focus())
  expect(document.activeElement).toBe(choice)
  fireEvent.click(choice)
  expect(props.updateSkillIds).toHaveBeenCalledOnce()
  expect(screen.queryByRole('searchbox')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})
it('Escape closes the capability popup before reaching its parent', async () => {
  const parent = vi.fn()
  render(
    <div onKeyDown={parent}>
      <SpecialistCapabilitiesSection {...props} />
    </div>
  )
  const trigger = screen.getByRole('button', { name: '＋ Add a skill' })
  fireEvent.click(trigger)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox')))
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(parent).not.toHaveBeenCalled()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it('connector selection returns focus and preserves the selected identifiers', async () => {
  render(<SpecialistCapabilitiesSection {...props} activeTab="connectors" />)
  const trigger = screen.getByRole('button', { name: '＋ Add a connector' })
  fireEvent.click(trigger)
  const choice = screen.getByRole('button', { name: 'Catalog connector' })
  act(() => choice.focus())
  fireEvent.click(choice)
  expect(props.updateConnectorIds).toHaveBeenCalledOnce()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('full access disables removal of a selected connector', () => {
  render(
    <SpecialistCapabilitiesSection
      {...props}
      activeTab="connectors"
      capabilityMode="full"
      selectedConnectorIds={['c1']}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove Catalog connector' }))
  expect(props.updateConnectorIds).not.toHaveBeenCalled()
})

it('composition Escape leaves the capability search open', async () => {
  render(<SpecialistCapabilitiesSection {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '＋ Add a skill' }))
  const input = screen.getByRole('searchbox')
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true, keyCode: 229 })
  expect(screen.getByRole('searchbox')).toBe(input)
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('searchbox')).toBeNull()
})

it('closes an open capability popup when full access replaces selected mode', async () => {
  const { rerender } = render(<SpecialistCapabilitiesSection {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '＋ Add a skill' }))
  expect(screen.getByRole('searchbox')).toBe(document.activeElement)
  rerender(<SpecialistCapabilitiesSection {...props} capabilityMode="full" />)
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Full access' }))
  )
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(props.updateSkillIds).not.toHaveBeenCalled()
  rerender(<SpecialistCapabilitiesSection {...props} />)
  expect(screen.queryByRole('searchbox')).toBeNull()
})
