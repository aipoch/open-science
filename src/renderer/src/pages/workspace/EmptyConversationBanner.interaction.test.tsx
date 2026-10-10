// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { EmptyConversationBanner } from './EmptyConversationBanner'
import { ProjectPackageDropZone } from '@/components/ProjectPackageDropZone'
import { usePackageOperationStore } from '@/stores/package-operation-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (text: string) => text })
}))

const importPackage = vi.fn(async () => null)

beforeEach(() => {
  importPackage.mockClear()
  vi.stubGlobal('api', { sessions: { importPackage } })
  usePackageOperationStore.setState({ operation: null, open: false })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const mount = (): HTMLElement => {
  render(<EmptyConversationBanner sessionImport={{ projectId: 'target', canImport: true }} />)
  return screen.getByTestId('session-package-entry')
}

it('starts source-aware questions from the discussion welcome', () => {
  const onStartResearch = vi.fn()
  render(
    <EmptyConversationBanner researchTitle="Tuanzi research" onStartResearch={onStartResearch} />
  )

  for (const [label, prompt] of [
    ['Summarize research', 'Summarize this research and its main findings.'],
    ['Examine the evidence', 'What evidence supports the conclusions?'],
    ['Identify limitations', 'What has not been verified yet?']
  ]) {
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(onStartResearch).toHaveBeenLastCalledWith(prompt)
  }
  expect(onStartResearch).toHaveBeenCalledTimes(3)
})

it('opens a file picker on click and imports the picked package into the current Project', async () => {
  const pickerClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  mount()
  const browse = screen.getByRole('button', { name: 'Choose a .science file' })

  fireEvent.click(browse)
  expect(pickerClick).toHaveBeenCalledOnce()

  const picker = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(picker.accept).toBe('.science')
  const file = new File(['fixture'], 'research.science')
  fireEvent.change(picker, { target: { files: [file] } })
  await vi.waitFor(() => expect(importPackage).toHaveBeenCalledWith({ projectId: 'target' }, file))
  pickerClick.mockRestore()
})

it('exposes the file picker as a keyboard-accessible button', () => {
  const pickerClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  mount()
  const browse = screen.getByRole('button', { name: 'Choose a .science file' })

  expect(browse.tagName).toBe('BUTTON')
  fireEvent.click(browse)
  expect(pickerClick).toHaveBeenCalledOnce()
  pickerClick.mockRestore()
})

it('keeps the package guide neutral while ordinary files are dragged', () => {
  const row = mount()
  expect(row.className).not.toContain('border-primary')

  fireEvent.dragEnter(row, { dataTransfer: { types: ['Files'] } })
  expect(row.className).not.toContain('border-primary')
  expect(row.className).not.toContain('bg-primary/5')

  fireEvent.dragLeave(row, { dataTransfer: { types: ['Files'] } })
  expect(row.className).not.toContain('border-primary')
})

it('does not highlight for non-file drags', () => {
  const row = mount()
  fireEvent.dragEnter(row, { dataTransfer: { types: ['text/plain'] } })
  expect(row.className).not.toContain('border-primary')
})

it('does not intercept drops itself — the conversation drop zone owns package drops', () => {
  const row = mount()
  fireEvent.drop(row, {
    dataTransfer: { types: ['Files'], files: [new File(['fixture'], 'research.science')] }
  })
  expect(importPackage).not.toHaveBeenCalled()
  expect(row.className).not.toContain('border-primary')
})

it('clears the entry highlight when the conversation capture handler consumes a package drop', async () => {
  render(
    <ProjectPackageDropZone projectId="target" projectName="Research" canImport>
      <EmptyConversationBanner sessionImport={{ projectId: 'target', canImport: true }} />
    </ProjectPackageDropZone>
  )
  const row = screen.getByTestId('session-package-entry')
  fireEvent.dragEnter(row, { dataTransfer: { types: ['Files'] } })
  expect(row.className).not.toContain('border-primary')

  fireEvent.drop(row, {
    dataTransfer: { types: ['Files'], files: [new File(['fixture'], 'research.science')] }
  })
  expect(row.className).not.toContain('border-primary')
  await vi.waitFor(() =>
    expect(importPackage).toHaveBeenCalledWith({ projectId: 'target' }, expect.any(File))
  )
})

it('shows the guide on info-button focus without triggering the row browse', () => {
  const pickerClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  mount()
  const info = screen.getByRole('button', { name: 'What is a .science research package?' })

  fireEvent.focus(info)
  expect(
    screen.getByText(/A \.science research package contains the exported research history/)
  ).toBeTruthy()
  expect(screen.getByText('read-only history')).toBeTruthy()
  expect(screen.getByText('continue research')).toBeTruthy()

  fireEvent.click(info)
  expect(pickerClick).not.toHaveBeenCalled()
  pickerClick.mockRestore()
})

it('keeps the guide open while the pointer crosses to content, then closes after leaving', () => {
  vi.useFakeTimers()
  try {
    mount()
    const info = screen.getByRole('button', { name: 'What is a .science research package?' })
    fireEvent.mouseEnter(info)
    const content = screen.getByText(
      /A \.science research package contains the exported research history/
    )
    fireEvent.mouseLeave(info)
    fireEvent.mouseEnter(content)
    act(() => vi.advanceTimersByTime(200))
    expect(content).toBeTruthy()

    fireEvent.blur(content)
    fireEvent.mouseLeave(content)
    act(() => vi.advanceTimersByTime(200))
    expect(
      screen.queryByText(/A \.science research package contains the exported research history/)
    ).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
