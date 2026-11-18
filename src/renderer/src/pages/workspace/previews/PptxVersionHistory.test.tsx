// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ManagedFileVersionDescriptor,
  ManagedFileVersionInspectResult
} from '../../../../../shared/managed-file-versions'
import { PptxVersionHistory } from './PptxVersionHistory'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))

afterEach(cleanup)

const version = (
  versionNumber: number,
  extra: Partial<ManagedFileVersionDescriptor> = {}
): ManagedFileVersionDescriptor =>
  ({
    id: `v${versionNumber}`,
    versionNumber,
    createdAt: '2026-11-13T08:00:00.000Z',
    ...extra
  }) as ManagedFileVersionDescriptor

const versions = [
  version(1, { author: 'user' }),
  version(2, { author: 'agent', summary: 'setText x2' }),
  version(3, { author: 'user', summary: 'restore' })
]

const inspectFor = (selectedVersionId: string): ManagedFileVersionInspectResult =>
  ({
    selectedVersionId,
    headVersionId: 'v3',
    versions,
    selectedVersion: versions.find((candidate) => candidate.id === selectedVersionId)
  }) as ManagedFileVersionInspectResult

describe('PptxVersionHistory', () => {
  it('shows who made the selected version and what changed', () => {
    render(
      <PptxVersionHistory
        inspect={inspectFor('v2')}
        comparing={false}
        onSelect={vi.fn()}
        onCompare={vi.fn()}
      />
    )
    expect(screen.getByTestId('pptx-version-history').textContent).toContain('Agent · Text')
  })

  it('lists versions newest first and selects one', () => {
    const onSelect = vi.fn()
    render(
      <PptxVersionHistory
        inspect={inspectFor('v3')}
        comparing={false}
        onSelect={onSelect}
        onCompare={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Version history' }))
    const rows = within(screen.getByRole('list', { name: 'Version history' })).getAllByRole(
      'button'
    )
    expect(rows.map((row) => row.textContent?.slice(0, 2))).toEqual(['v3', 'v2', 'v1'])
    expect(rows[0]?.textContent).toContain('You · Restored an earlier version')
    expect(rows[0]?.getAttribute('aria-current')).toBe('true')
    fireEvent.click(rows[2]!)
    expect(onSelect).toHaveBeenCalledWith('v1')
  })

  it('compares the selected version with the one before it', () => {
    const onCompare = vi.fn()
    const { rerender } = render(
      <PptxVersionHistory
        inspect={inspectFor('v2')}
        comparing={false}
        onSelect={vi.fn()}
        onCompare={onCompare}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compare with previous version' }))
    expect(onCompare).toHaveBeenCalledWith(versions[0], versions[1])
    rerender(
      <PptxVersionHistory
        inspect={inspectFor('v1')}
        comparing={false}
        onSelect={vi.fn()}
        onCompare={onCompare}
      />
    )
    expect(screen.getByRole('button', { name: 'Compare with previous version' })).toHaveProperty(
      'disabled',
      true
    )
  })
})
