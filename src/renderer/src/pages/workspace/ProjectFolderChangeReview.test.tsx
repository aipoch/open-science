// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '../../../../shared/projects'
import type { ProjectFolderChange } from '../../../../shared/project-folder-changes'
import { PermissionApprovalControls } from './PermissionApprovalControls'
import { ProjectFolderChangeReview } from './ProjectFolderChangeReview'
import { ProjectFolderChangeHistory } from './ProjectFolderChangeHistory'

const change: ProjectFolderChange = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'project',
  sessionId: 'session',
  runId: 'run',
  relativePath: 'data/raw.csv',
  operation: 'replace',
  requiresConfirmation: true,
  state: 'prepared'
}
const preview = vi.fn()
const inspect = vi.fn()
const revert = vi.fn()
const list = vi.fn()
let changed: ((scope: { projectId: string; sessionId: string }) => void) | undefined
beforeEach(() => {
  preview.mockReset().mockResolvedValue({
    change,
    original: { text: 'ORIGINAL', binary: false, truncated: false, sizeBytes: 8 },
    candidate: { text: 'PREPARED', binary: false, truncated: true, sizeBytes: 8 }
  })
  inspect.mockReset().mockResolvedValue({ ...change, state: 'applied' })
  revert.mockReset().mockResolvedValue({ ...change, state: 'reverted' })
  list.mockReset().mockResolvedValue({ changes: [] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      notebook: {
        previewProjectFolderChange: preview,
        inspectProjectFolderChange: inspect,
        revertProjectFolderChange: revert,
        listProjectFolderChanges: list,
        onProjectFolderChangesChanged: vi.fn((listener) => {
          changed = listener
          return () => {
            changed = undefined
          }
        })
      }
    }
  })
  useProjectStore.setState({
    projects: [
      { id: 'project', rootPath: '/Research' } as Project,
      { id: 'second', rootPath: '/Second' } as Project
    ]
  })
})
afterEach(cleanup)

it.each(['replace', 'delete'] as const)(
  'offers exact backup consent for %s with no remembered scope',
  (operation) => {
    render(
      <PermissionApprovalControls
        requests={[
          {
            requestId: 'request',
            sessionId: 'session',
            toolCallId: 'tool',
            title: 'Review project folder changes',
            appOwned: true,
            rawInput: { projectFolderChange: { ...change, operation } },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once', scope: 'once' },
              { optionId: 'deny', name: 'Reject', kind: 'reject_once' }
            ]
          }
        ]}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByText('Review file changes')).toBeTruthy()
    expect(screen.getByText('data/raw.csv')).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: operation === 'delete' ? 'Back up and delete' : 'Back up and replace'
      })
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(screen.queryByLabelText('Choose authorization scope')).toBeNull()
  }
)

it('loads bounded original and candidate previews only on demand', async () => {
  render(<ProjectFolderChangeReview change={change} />)
  expect(preview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'View changes' }))
  await screen.findByText('ORIGINAL')
  expect(screen.getByText('PREPARED')).toBeTruthy()
  expect(screen.getByText('Preview truncated')).toBeTruthy()
  expect(preview).toHaveBeenCalledWith({
    projectId: 'project',
    sessionId: 'session',
    id: change.id
  })
})

it('restores saved bytes by scoped change ID and keeps an accessible receipt', async () => {
  render(<ProjectFolderChangeReview change={{ ...change, state: 'applied' }} receipt />)
  const undo = await screen.findByRole('button', { name: 'Undo' })
  fireEvent.click(undo)
  await screen.findByText('The original file has been restored from its backup.')
  expect(revert).toHaveBeenCalledWith({ projectId: 'project', sessionId: 'session', id: change.id })
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('Original file restored')
})

it('leaves Undo available if Main refuses to overwrite a subsequently edited file', async () => {
  revert.mockRejectedValue(new Error('File changed since publication'))
  render(<ProjectFolderChangeReview change={{ ...change, state: 'applied' }} receipt />)
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
  await screen.findByText('Could not complete the file change action')
  expect(screen.getByRole('button', { name: 'Undo' }).hasAttribute('disabled')).toBe(false)
})

it('ignores preview responses after the reviewed file changes and clears loading when closed', async () => {
  let resolve!: (value: unknown) => void
  preview.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const view = render(<ProjectFolderChangeReview change={change} />)
  fireEvent.click(screen.getByRole('button', { name: 'View changes' }))
  expect(screen.getByRole('status').textContent).toBe('Loading…')
  fireEvent.click(screen.getByRole('button', { name: 'View changes' }))
  expect(screen.queryByRole('status')).toBeNull()
  view.rerender(
    <ProjectFolderChangeReview
      change={{ ...change, id: '22222222-2222-4222-8222-222222222222', relativePath: 'other.csv' }}
    />
  )
  await act(async () => resolve({ original: { text: 'STALE' }, candidate: { text: 'STALE' } }))
  expect(screen.queryByText('STALE')).toBeNull()
})

it('does not query saved history for an unbound project', () => {
  render(
    <ProjectFolderChangeHistory
      scope={{ projectId: 'managed', sessionId: 'session' }}
      revision="idle"
    />
  )
  expect(list).not.toHaveBeenCalled()
})

it('ignores an old next page after changing Sessions and refreshes matching durable events', async () => {
  let resolve!: (value: unknown) => void
  list
    .mockResolvedValueOnce({ changes: [{ ...change, state: 'applied' }], nextId: change.id })
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    .mockResolvedValue({
      changes: [
        {
          ...change,
          id: 'second-change',
          projectId: 'second',
          sessionId: 'second-session',
          relativePath: 'second.csv',
          state: 'rejected'
        }
      ]
    })
  const view = render(
    <ProjectFolderChangeHistory
      scope={{ projectId: 'project', sessionId: 'session' }}
      revision="idle"
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
  view.rerender(
    <ProjectFolderChangeHistory
      scope={{ projectId: 'second', sessionId: 'second-session' }}
      revision="idle"
    />
  )
  await screen.findByText('second.csv')
  await act(async () =>
    resolve({ changes: [{ ...change, relativePath: 'STALE.csv', state: 'rejected' }] })
  )
  expect(screen.queryByText('STALE.csv')).toBeNull()
  const before = list.mock.calls.length
  act(() => changed?.({ projectId: 'project', sessionId: 'session' }))
  expect(list).toHaveBeenCalledTimes(before)
  act(() => changed?.({ projectId: 'second', sessionId: 'second-session' }))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(before + 1))
})
