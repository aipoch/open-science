// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectPicker } from './ProjectPicker'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
afterEach(cleanup)
const projects = [
  { id: 'a', name: 'Cancer research' },
  { id: 'b', name: 'Biomaterials' }
]

it('filters by name, reports no match and retains an explicit selection while searching', () => {
  const select = vi.fn()
  const Picker = (): React.JSX.Element => {
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState('')
    return (
      <ProjectPicker
        projects={projects}
        query={query}
        onQueryChange={setQuery}
        selectedId={selected}
        onSelect={(id) => {
          setSelected(id)
          select(id)
        }}
        alwaysShowSearch
      />
    )
  }
  render(<Picker />)
  expect((screen.getByRole('radio', { name: 'Cancer research' }) as HTMLInputElement).checked).toBe(
    false
  )
  fireEvent.click(screen.getByRole('radio', { name: 'Cancer research' }))
  expect(select).toHaveBeenCalledWith('a')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  BIO  ' } })
  expect(screen.queryByRole('radio', { name: 'Cancer research' })).toBeNull()
  expect(screen.getByRole('radio', { name: 'Biomaterials' })).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(screen.getByRole('status').textContent).toBe('No matching projects')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  expect((screen.getByRole('radio', { name: 'Cancer research' }) as HTMLInputElement).checked).toBe(
    true
  )
  expect(select).toHaveBeenCalledOnce()
})

it('does not make loading or disabled destinations actionable and distinguishes an empty catalog', () => {
  const onSelect = vi.fn()
  const props = { projects, query: '', onQueryChange: vi.fn(), onSelect }
  const { rerender } = render(<ProjectPicker {...props} loaded={false} />)
  expect(screen.getByRole('status').textContent).toBe('Loading…')
  expect(screen.queryByRole('button')).toBeNull()
  rerender(<ProjectPicker {...props} disabled />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancer research' }))
  expect(onSelect).not.toHaveBeenCalled()
  rerender(<ProjectPicker {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancer research' }))
  expect(onSelect).toHaveBeenCalledWith('a')
  rerender(<ProjectPicker {...props} projects={[]} />)
  expect(screen.getByText('No active projects')).toBeTruthy()
  expect(screen.queryByRole('searchbox')).toBeNull()
})

it('keeps two selection groups independent', () => {
  const props = { projects, query: '', onQueryChange: vi.fn(), onSelect: vi.fn(), selectedId: '' }
  render(
    <>
      <ProjectPicker {...props} />
      <ProjectPicker {...props} />
    </>
  )
  const radios = screen.getAllByRole('radio') as HTMLInputElement[]
  expect(radios[0].name).toBe(radios[1].name)
  expect(radios[0].name).not.toBe(radios[2].name)
})
