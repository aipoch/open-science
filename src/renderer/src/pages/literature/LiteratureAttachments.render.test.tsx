// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemView } from '../../../../shared/literature'
import { LiteratureAttachments } from './LiteratureAttachments'

const version = (versionNumber: number, missing = false) => ({
  id: `version-${versionNumber}`,
  versionNumber,
  filename: `paper-v${versionNumber}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 1024,
  checksum: String(versionNumber).repeat(64),
  pageCount: 1,
  availability: missing ? ('unavailable' as const) : ('available' as const),
  ...(missing ? { verificationFailure: 'missing' } : {}),
  createdAt: 1700000000000 + versionNumber
})

const makeItem = (count: number, missing = false): LiteratureItemView => ({
  id: 'paper',
  metadataRevision: 1,
  item: literatureItemInputSchema.parse({ title: 'Paper', itemType: 'journalArticle' }),
  projectIds: [],
  collectionIds: [],
  createdAt: 1,
  updatedAt: 1,
  attachments: [
    {
      id: 'attachment',
      kind: 'fullText',
      title: 'Paper',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      versions: Array.from({ length: count }, (_, index) =>
        version(count - index, index === 0 && missing)
      )
    }
  ]
})

const transact = vi.fn()
beforeEach(() => {
  transact.mockReset().mockResolvedValue({ state: 'unlinked' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { transact, get: vi.fn().mockResolvedValue(undefined) } }
  })
})
afterEach(cleanup)

describe('Attachment safety and version access', () => {
  it.each([1, 2])(
    'requires confirmation before deleting an attachment with %i versions',
    async (count) => {
      render(
        <LiteratureAttachments item={makeItem(count)} onChanged={vi.fn()} onPreview={vi.fn()} />
      )
      fireEvent.click(
        screen.getByRole('button', { name: `Attachment actions for paper-v${count}.pdf` })
      )
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove attachment' }))
      expect(
        transact,
        'Opening removal must not submit an irreversible deletion'
      ).not.toHaveBeenCalled()
      expect(screen.getByRole('alertdialog').textContent).toContain(`paper-v${count}.pdf`)
    }
  )

  it.each([false, true])(
    'offers access to older versions when the latest is missing: %s',
    async (missing) => {
      const onPreview = vi.fn()
      render(
        <LiteratureAttachments
          item={makeItem(2, missing)}
          onChanged={vi.fn()}
          onPreview={onPreview}
        />
      )
      const latest = screen.getByRole('button', {
        name: 'Preview paper-v2.pdf'
      }) as HTMLButtonElement
      expect(latest.disabled).toBe(missing)
      if (!missing) {
        fireEvent.click(latest)
        expect(onPreview).toHaveBeenCalledWith(version(2))
      }
      fireEvent.click(screen.getByRole('button', { name: 'Attachment actions for paper-v2.pdf' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Version history' }))
      fireEvent.click(screen.getByRole('button', { name: 'Preview paper-v1.pdf' }))
      expect(onPreview).toHaveBeenLastCalledWith(version(1))
      expect(transact).not.toHaveBeenCalled()
    }
  )
})
