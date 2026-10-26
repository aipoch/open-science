// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillSources } from './SkillSources'

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
it('loads saved sources and browses the exact saved ref', async () => {
  const browse = vi.fn()
  await act(async () => root.render(<SkillSources onBrowse={browse} />))
  expect(container.textContent).toContain(source.repository)
  act(() => button('Browse').click())
  expect(browse).toHaveBeenCalledWith('aipoch/medical-research-skills@published')
})
it('removes only the selected bookmark and shows the empty state', async () => {
  await act(async () => root.render(<SkillSources onBrowse={vi.fn()} />))
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Remove source"]')!.click()
  )
  expect(remove).toHaveBeenCalledWith({ id: source.id })
  expect(document.activeElement).toBe(container.querySelector('input'))
  expect(container.textContent).toContain('No saved sources yet')
  expect(container.textContent).toContain('keeps its installed Skills')
})
it('saves explicit input, blocks duplicate submits, and reflects the returned document', async () => {
  let resolve!: (value: (typeof source)[]) => void
  add.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  await act(async () => root.render(<SkillSources onBrowse={vi.fn()} />))
  const input = container.querySelector('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'owner/repo'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(add).toHaveBeenCalledTimes(1)
  expect(add).toHaveBeenCalledWith({ repository: 'owner/repo' })
  await act(async () => resolve([{ id: 'two', repository: 'owner/repo', ref: 'main' }]))
  expect(container.textContent).toContain('owner/repo')
  expect(input.value).toBe('')
})
it('keeps saved sources visible when deletion fails', async () => {
  remove.mockRejectedValue(new Error('disk failure'))
  await act(async () => root.render(<SkillSources onBrowse={vi.fn()} />))
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Remove source"]')!.click()
  )
  expect(container.textContent).toContain(source.repository)
  expect(container.textContent).toContain('Could not remove this source')
})
it('shows a recoverable load error instead of an empty catalog', async () => {
  list.mockRejectedValueOnce(new Error('corrupt'))
  await act(async () => root.render(<SkillSources onBrowse={vi.fn()} />))
  expect(container.textContent).toContain('Could not load Skill sources')
  expect(container.textContent).not.toContain('No saved sources yet')
  await act(async () => button('Retry').click())
  expect(container.textContent).toContain(source.repository)
})
