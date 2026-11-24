// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VersionCleanupDialog } from './VersionCleanupDialog'
import type { ManagedFileVersionInspectResult } from '../../../../shared/managed-file-versions'
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_, name: string) => String(vars?.[name] ?? name))
  })
}))
afterEach(cleanup)
it('loads earlier versions, protects the latest, and deletes only checked versions after confirmation', async () => {
  const version = (
    id: string,
    number: number
  ): Pick<
    ManagedFileVersionInspectResult['versions'][number],
    'id' | 'versionNumber' | 'createdAt' | 'sizeBytes'
  > => ({
    id,
    versionNumber: number,
    createdAt: '2026-01-01T00:00:00Z',
    sizeBytes: 1024
  })
  const inspect = {
    source: 'artifact',
    projectId: 'project',
    fileId: 'file',
    displayName: 'draft.md',
    headVersionId: 'v3',
    selectedVersionId: 'v3',
    versions: [version('v3', 3), version('v2', 2)]
  } as ManagedFileVersionInspectResult
  const inspectApi = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: { ...inspect, nextCursor: 'earlier' } })
    .mockResolvedValueOnce({ ok: true, value: { ...inspect, versions: [version('v1', 1)] } })
  const deleteVersions = vi.fn(async () => ({ ok: true, value: undefined }))
  window.api = {
    managedFileVersions: { inspect: inspectApi, deleteVersions }
  } as unknown as Window['api']
  const onDeleted = vi.fn()
  render(<VersionCleanupDialog inspect={inspect} onPreview={vi.fn()} onDeleted={onDeleted} />)
  const trigger = screen.getByRole('button', { name: 'Select versions to delete' })
  expect(trigger.textContent).toBe('')
  expect(trigger.getAttribute('data-size')).toBe('icon-xs')
  fireEvent.click(trigger)
  await screen.findByRole('checkbox', { name: 'Version 1' })
  expect(screen.queryByRole('checkbox', { name: 'Version 3' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Version 1' }))
  fireEvent.click(screen.getByText('Delete selected versions'))
  expect(deleteVersions).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Delete selected versions'))
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
  expect(deleteVersions).toHaveBeenCalledWith({
    source: 'artifact',
    projectId: 'project',
    fileId: 'file',
    versionIds: ['v1']
  })
})
