// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComposerSpecialistPicker } from '@/pages/workspace/ComposerSpecialistPicker'
const data = vi.hoisted(() => ({
  items: [
    { kind: 'custom', id: 'r', name: 'Researcher', description: 'Research', enabled: true },
    { kind: 'custom', id: 's', name: 'Statistician', description: 'Statistics', enabled: true }
  ],
  isLoaded: true,
  load: vi.fn()
}))
vi.mock('@/stores/specialist-store', () => ({
  useSpecialistStore: (select: (state: typeof data) => unknown) => select(data)
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('composing Enter preserves the specialist and keeps the picker open', async () => {
  window.api = {} as typeof window.api
  const onChange = vi.fn()
  render(<ComposerSpecialistPicker selectedId="r" onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose Specialist: Researcher' }))
  const input = screen.getByRole('combobox')
  fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: 'Stat' } })
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
  })
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByRole('combobox')).toBe(input)
})

it('composition navigation preserves the candidate and ordinary Enter still selects afterward', () => {
  const onChange = vi.fn()
  render(<ComposerSpecialistPicker selectedId="r" onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose Specialist: Researcher' }))
  const input = screen.getByRole('combobox')
  const active = input.getAttribute('aria-activedescendant')
  fireEvent.compositionStart(input)
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape'])
    fireEvent.keyDown(input, { key })
  expect(onChange).not.toHaveBeenCalled()
  expect(input.getAttribute('aria-activedescendant')).toBe(active)
  expect(screen.getByRole('combobox')).toBe(input)
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onChange).toHaveBeenCalledWith('s')
})
