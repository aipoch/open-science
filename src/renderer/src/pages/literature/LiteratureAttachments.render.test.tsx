// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemView } from '../../../../shared/literature'
import { literatureDeletionError } from '../../../../shared/literature-deletion'
import { useAttachmentOperations } from './literature-attachment-operations'
import { LiteratureAttachments } from './LiteratureAttachments'

const version = (
  versionNumber: number,
  missing = false
): LiteratureItemView['attachments'][number]['versions'][number] => ({
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
  useAttachmentOperations.setState({ operations: [] })
  transact.mockReset().mockResolvedValue({ state: 'unlinked' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { transact, get: vi.fn().mockResolvedValue(undefined) } }
  })
})
afterEach(cleanup)

describe('Attachment safety and version access', () => {
  it('refreshes permission failures in the attachment and history views, then recovers on retry', async () => {
    const available = makeItem(2)
    const unavailable = structuredClone(available)
    Object.assign(unavailable.attachments[0].versions[0], {
      availability: 'unavailable',
      verificationFailure: 'permission-denied',
      verificationAttemptAt: 2
    })
    vi.mocked(window.api.literature.get)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(available)
    transact.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValueOnce({ state: 'present' })
    const View = (): React.JSX.Element => {
      const item = useAttachmentOperations(
        (state) => state.operations.find((operation) => operation.itemId === available.id)?.item
      )
      return <LiteratureAttachments item={item ?? available} onPreview={vi.fn()} />
    }
    render(<View />)
    const retry = async (): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: 'Attachment actions for paper-v2.pdf' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Retry file verification' }))
    }
    await retry()
    await screen.findByText('File unavailable')
    const attachmentRow = screen
      .getByRole('button', { name: 'Preview paper-v2.pdf' })
      .closest('[aria-busy]')!
    expect(within(attachmentRow as HTMLElement).getByRole('alert').textContent).toContain(
      'The attachment operation failed. Try again.'
    )
    expect(
      (screen.getByRole('button', { name: 'Preview paper-v2.pdf' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(screen.queryByText('File integrity verified')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Attachment actions for paper-v2.pdf' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Version history' }))
    const dialog = screen.getByRole('dialog')
    expect(
      (within(dialog).getByRole('button', { name: 'Preview paper-v2.pdf' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(
      (within(dialog).getByRole('button', { name: 'Preview paper-v1.pdf' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await retry()
    await screen.findByText('File integrity verified')
    expect(
      (screen.getByRole('button', { name: 'Preview paper-v2.pdf' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it.each(['referenced', 'scan-incomplete'] as const)(
    'retains structured %s diagnostics after confirming deletion',
    async (reason) => {
      transact.mockRejectedValue(
        literatureDeletionError({
          reason,
          references:
            reason === 'referenced'
              ? [
                  {
                    attachmentId: 'attachment',
                    versionId: 'version-1',
                    projectId: 'project',
                    sessionId: 'session',
                    sessionTitle: 'Saved research discussion',
                    location: 'message-history'
                  }
                ]
              : [],
          issues:
            reason === 'scan-incomplete'
              ? [{ kind: 'corrupt', fileName: 'conversation.json', recovered: true }]
              : [],
          truncated: false
        })
      )
      render(<LiteratureAttachments item={makeItem(2)} onPreview={vi.fn()} />)
      await openRemoval()
      fireEvent.click(screen.getByRole('button', { name: 'Permanently delete attachment' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      fireEvent.click(
        screen.getByRole('button', {
          name: reason === 'referenced' ? 'View affected conversations' : 'View recovery details'
        })
      )
      expect(
        screen.getByText(
          reason === 'referenced' ? 'Saved research discussion' : 'conversation.json'
        )
      ).toBeDefined()
      expect(screen.getByRole('button', { name: 'Preview paper-v2.pdf' })).toBeDefined()
    }
  )

  const openRemoval = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: 'Attachment actions for paper-v2.pdf' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove attachment' }))
  }

  it.each(['cancel', 'escape'])(
    'does not delete on %s and returns focus to the attachment menu',
    async (close) => {
      render(<LiteratureAttachments item={makeItem(2)} onPreview={vi.fn()} />)
      const trigger = screen.getByRole('button', { name: 'Attachment actions for paper-v2.pdf' })
      trigger.focus()
      await openRemoval()
      const dialog = screen.getByRole('alertdialog')
      expect(dialog.textContent).toContain('All 2 versions will be deleted.')
      expect(dialog.textContent).toContain('This cannot be undone')
      expect(dialog.textContent).toContain(
        'Original files imported from your computer are not deleted.'
      )
      if (close === 'cancel')
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      else fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(transact).not.toHaveBeenCalled()
      await waitFor(() => expect(document.activeElement).toBe(trigger))
    }
  )

  it('submits the confirmed attachment only once and keeps the committed removal if refresh fails', async () => {
    let finish!: (value: unknown) => void
    transact.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureAttachments item={makeItem(2)} onPreview={vi.fn()} />)
    await openRemoval()
    const confirm = screen.getByRole('button', { name: 'Permanently delete attachment' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(transact).toHaveBeenCalledTimes(1)
    expect(transact).toHaveBeenCalledWith({
      kind: 'delete-attachment',
      itemId: 'paper',
      attachmentId: 'attachment'
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Removing attachment…')
    expect(screen.getByRole('button', { name: 'Preview paper-v2.pdf' })).toHaveProperty(
      'disabled',
      true
    )
    await act(async () => finish({ state: 'unlinked' }))
    expect(useAttachmentOperations.getState().operations[0].item?.attachments).toEqual([])
    expect(screen.getByRole('alert').textContent).toContain('details could not be refreshed')
  })

  it('preserves the attachment and explains saved chat references when deletion is refused', async () => {
    transact.mockRejectedValue(new Error('LITERATURE_ATTACHMENT_IN_USE'))
    render(<LiteratureAttachments item={makeItem(2)} onPreview={vi.fn()} />)
    await openRemoval()
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete attachment' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('alert').textContent).toContain(
      'referenced by a chat or its message history'
    )
    expect(useAttachmentOperations.getState().operations[0].item).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Preview paper-v2.pdf' })).toBeDefined()
  })

  it.each(['reference', 'versions'])(
    'invalidates confirmation when the %s changes',
    async (change) => {
      const props = { onPreview: vi.fn() }
      const view = render(<LiteratureAttachments item={makeItem(2)} {...props} />)
      await openRemoval()
      view.rerender(
        <LiteratureAttachments
          item={change === 'reference' ? { ...makeItem(2), id: 'other' } : makeItem(3)}
          {...props}
        />
      )
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(transact).not.toHaveBeenCalled()
    }
  )

  it('shows version metadata and prevents previewing a missing version', async () => {
    const onPreview = vi.fn()
    render(<LiteratureAttachments item={makeItem(2, true)} onPreview={onPreview} />)
    fireEvent.click(screen.getByRole('button', { name: 'Attachment actions for paper-v2.pdf' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Version history' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Version 2')
    expect(dialog.textContent).toContain('Version 1')
    expect(dialog.querySelectorAll('time')).toHaveLength(2)
    const missing = within(dialog).getByRole('button', {
      name: 'Preview paper-v2.pdf'
    }) as HTMLButtonElement
    expect(missing.disabled).toBe(true)
    expect(missing.textContent).toContain('File missing')
    fireEvent.click(missing)
    expect(onPreview).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(transact).not.toHaveBeenCalled()
  })

  it.each([1, 2])(
    'requires confirmation before deleting an attachment with %i versions',
    async (count) => {
      render(<LiteratureAttachments item={makeItem(count)} onPreview={vi.fn()} />)
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
