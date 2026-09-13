// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectPackageDropZone } from './ProjectPackageDropZone'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { createPortal } from 'react-dom'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (text: string, values?: { project: string }) =>
      text.replace('{{project}}', values?.project ?? '')
  })
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
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
})
const drop = (target: Element, names: string[]): void => {
  fireEvent.drop(target, {
    dataTransfer: {
      types: ['Files'],
      files: names.map((name) => new File(['fixture'], name))
    }
  })
}
const mount = (canImport = true): ReturnType<typeof vi.fn> => {
  const attach = vi.fn()
  render(
    <ProjectPackageDropZone projectId="target" projectName="Research" canImport={canImport}>
      <div data-testid="composer" onDrop={attach} />
    </ProjectPackageDropZone>
  )
  return attach
}
it('routes a package dropped on the composer to the current Project, without attaching it', async () => {
  const attach = mount()
  drop(screen.getByTestId('composer'), ['research.SCIENCE'])
  expect(importPackage).toHaveBeenCalledWith({ projectId: 'target' }, expect.any(File))
  expect(attach).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(importPackage).toHaveBeenCalledTimes(1))
})
it('leaves ordinary file drops to their attachment target', () => {
  const attach = mount()
  drop(screen.getByTestId('composer'), ['data.csv'])
  expect(attach).toHaveBeenCalledOnce()
  expect(importPackage).not.toHaveBeenCalled()
})
it.each([
  ['first.science', 'second.science'],
  ['first.science', 'data.csv']
])('rejects the entire mixed or multiple package drop: %s, %s', (...names) => {
  const attach = mount()
  drop(screen.getByTestId('composer'), names)
  expect(importPackage).not.toHaveBeenCalled()
  expect(attach).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toContain('Drop one .science file')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('status')).toBeNull()
})
it('rejects package drops into an unavailable Project', () => {
  const attach = mount(false)
  drop(screen.getByTestId('composer'), ['study.science'])
  expect(attach).not.toHaveBeenCalled()
  expect(importPackage).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toContain('unavailable')
})
it('opens existing progress instead of starting another operation', () => {
  usePackageOperationStore.setState({
    operation: {
      id: 'busy',
      kind: 'export',
      state: 'running',
      progress: { phase: 'copying' }
    }
  })
  mount()
  drop(screen.getByTestId('composer'), ['study.science'])
  expect(importPackage).not.toHaveBeenCalled()
  expect(usePackageOperationStore.getState().open).toBe(true)
})
it('ignores portal drops outside the Project DOM', () => {
  render(
    <ProjectPackageDropZone projectId="target" projectName="Research" canImport>
      {createPortal(<div data-testid="modal" />, document.body)}
    </ProjectPackageDropZone>
  )
  drop(screen.getByTestId('modal'), ['study.science'])
  expect(importPackage).not.toHaveBeenCalled()
})
it('does not advertise desktop import in Web', () => {
  document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
  mount()
  fireEvent.dragEnter(screen.getByTestId('composer'), { dataTransfer: { types: ['Files'] } })
  expect(screen.queryByRole('status')).toBeNull()
  drop(screen.getByTestId('composer'), ['study.science'])
  expect(importPackage).not.toHaveBeenCalled()
})
it('shows the destination only during a file drag and clears on drop', () => {
  mount()
  const target = screen.getByTestId('composer')
  fireEvent.dragEnter(target, { dataTransfer: { types: ['text/plain'] } })
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.dragEnter(target, { dataTransfer: { types: ['Files'] } })
  expect(screen.getByRole('status').textContent).toContain('“Research”')
  drop(target, ['data.csv'])
  expect(screen.queryByRole('status')).toBeNull()
})

it('clears a nested attachment overlay when the Project captures its drop', async () => {
  const attach = vi.fn()
  const Composer = (): React.JSX.Element => {
    const { isDragging, dropZoneProps } = useFileDropZone({ enabled: true, onFiles: attach })
    return <div {...dropZoneProps} data-testid="nested-composer" data-dragging={isDragging} />
  }
  render(
    <ProjectPackageDropZone projectId="target" projectName="Research" canImport>
      <Composer />
    </ProjectPackageDropZone>
  )
  const composer = screen.getByTestId('nested-composer')
  fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } })
  expect(composer.getAttribute('data-dragging')).toBe('true')
  drop(composer, ['research.science'])
  expect(composer.getAttribute('data-dragging')).toBe('false')
  expect(attach).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(importPackage).toHaveBeenCalledOnce())
})
