// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SavedSkillRepositories } from './SavedSkillRepositories'

let container: HTMLDivElement
let root: Root
const source = { id: 'one', repository: 'aipoch/medical-research-skills', ref: 'published' }
const list = vi.fn()
const add = vi.fn()
const remove = vi.fn()
beforeEach(() => {
  list.mockReset().mockResolvedValue([source])
  add.mockReset().mockResolvedValue([source])
  remove.mockReset().mockResolvedValue([])
  window.api = {
    settings: { listSkillSources: list, addSkillSource: add, removeSkillSource: remove }
  } as unknown as typeof window.api
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const button = (text: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text))!
const render = async (
  repository: string | null = null,
  busy = false,
  onScan = vi.fn()
): Promise<void> => {
  await act(async () =>
    root.render(
      <SavedSkillRepositories scannedRepository={repository} busy={busy} onScan={onScan} />
    )
  )
}
it('loads bookmarks and scans the exact saved ref without an add form', async () => {
  const scan = vi.fn()
  await render(null, false, scan)
  expect(container.querySelector('input')).toBeNull()
  expect(button('Save repository')).toBeUndefined()
  act(() => button(source.repository).click())
  expect(scan).toHaveBeenCalledWith('aipoch/medical-research-skills@published')
})
it('removes only the selected bookmark and keeps focus in the saved repositories section', async () => {
  await render()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Remove saved"]')!.click()
  )
  expect(remove).toHaveBeenCalledWith({ id: source.id })
  expect(document.activeElement).toBe(container.querySelector('section'))
  expect(container.textContent).toContain('Scan a repository, then save it here for next time.')
})
it('saves the scanned repository once and reflects the returned document', async () => {
  let resolve!: (value: (typeof source)[]) => void
  add.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  await render('owner/repo@main')
  const save = button('Save repository')
  await act(async () => {
    save.click()
    save.click()
  })
  expect(add).toHaveBeenCalledTimes(1)
  expect(add).toHaveBeenCalledWith({ repository: 'owner/repo@main' })
  await act(async () => resolve([{ id: 'two', repository: 'owner/repo', ref: 'main' }]))
  expect(button('Saved').disabled).toBe(true)
})
it.each([
  'Aipoch/medical-research-skills@published',
  'https://github.com/Aipoch/medical-research-skills.git/tree/published'
])('recognizes an already saved repository using %s', async (value) => {
  await render(value)
  expect(button('Saved').disabled).toBe(true)
  expect(button('Save repository')).toBeUndefined()
})
it('distinguishes refs and blocks bookmark actions during a scan or import', async () => {
  await render('aipoch/medical-research-skills@Published', true)
  expect(button('Save repository').disabled).toBe(true)
  expect(button(source.repository).disabled).toBe(true)
  await render('aipoch/medical-research-skills@Published')
  expect(button('Save repository').disabled).toBe(false)
})
it('does not offer to bookmark a subtree URL as if it were the whole repository', async () => {
  await render('https://github.com/owner/repo/tree/main/subdirectory')
  expect(button('Save repository')).toBeUndefined()
})
it('keeps bookmarks visible when deletion fails', async () => {
  remove.mockRejectedValue(new Error('disk failure'))
  await render()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Remove saved"]')!.click()
  )
  expect(container.textContent).toContain(source.repository)
  expect(container.textContent).toContain('Could not remove this bookmark')
})
it('allows retrying a failed save without losing the scanned repository', async () => {
  add.mockRejectedValueOnce(new Error('disk failure'))
  await render('owner/repo')
  await act(async () => button('Save repository').click())
  expect(container.textContent).toContain('Could not save this repository')
  expect(button('Save repository').disabled).toBe(false)
})
it('shows a recoverable load error instead of an empty catalog', async () => {
  list.mockRejectedValueOnce(new Error('corrupt'))
  await render()
  expect(container.textContent).toContain('Could not load saved repositories')
  expect(container.textContent).not.toContain('Scan a repository, then save it here for next time.')
  await act(async () => button('Retry').click())
  expect(container.textContent).toContain(source.repository)
})
