// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureComposerDraftStorage,
  readComposerDraft,
  writeComposerDraft,
  revokeComposerDraftStorage,
  removeComposerDrafts,
  flushComposerDrafts,
  preserveComposerDraftsForRecovery
} from './composer-draft-storage'
import type { ComposerDraft } from './workspace-composer-upload-controller'
const draft = (text: string): ComposerDraft => ({
  doc: { nodes: [{ type: 'text', text }] },
  annotations: [],
  attachments: [],
  attachmentTransfers: [],
  automaticReadingEnabled: true
})
afterEach(() => {
  vi.restoreAllMocks()
  revokeComposerDraftStorage()
  sessionStorage.clear()
})
describe('composer refresh storage', () => {
  it('restores long paste text, pending states and receipts without trusting saved attachment paths', () => {
    configureComposerDraftStorage('host/principal')
    const value = draft('before ')
    value.doc.nodes.push({ type: 'pasted-text', id: 'paste', text: 'long text'.repeat(1000) })
    value.attachments.push({
      id: 'file',
      name: 'data.csv',
      originalName: 'data.csv',
      sessionId: '.pending',
      path: '/untrusted',
      size: 4,
      draftReceipt: 'signed-receipt'
    })
    value.attachmentTransfers.push({
      transferId: 'job',
      name: 'pending.csv',
      totalBytes: 8,
      receivedBytes: 2,
      status: 'uploading'
    })
    writeComposerDraft('project', 'session', value)
    expect(sessionStorage.getItem('open-science-composer-drafts-v1')).not.toContain('/untrusted')
    configureComposerDraftStorage('host/principal')
    const restored = readComposerDraft('project', 'session', 'retry')!
    expect(restored.doc.nodes).toEqual([
      { type: 'text', text: 'before ' + 'long text'.repeat(1000) }
    ])
    expect(restored.attachments).toEqual([])
    expect(restored.attachmentTransfers).toEqual([
      expect.objectContaining({
        name: 'data.csv',
        recoveryReceipt: 'signed-receipt',
        status: 'error'
      }),
      expect.objectContaining({ name: 'pending.csv', status: 'error', error: 'retry' })
    ])
  })
  it('isolates project, host and pairing identity and clears revoked access', () => {
    configureComposerDraftStorage('host/principal-a')
    writeComposerDraft('project-a', 'same-session', draft('secret'))
    expect(readComposerDraft('project-b', 'same-session', 'retry')).toBeUndefined()
    configureComposerDraftStorage('host/principal-b')
    expect(flushComposerDrafts().count).toBe(0)
    configureComposerDraftStorage('host/principal-a')
    expect(flushComposerDrafts().count).toBe(0)
    writeComposerDraft('project-a', 'same-session', draft('secret'))
    revokeComposerDraftStorage()
    writeComposerDraft('project-a', 'same-session', draft('late write'))
    expect(sessionStorage.getItem('open-science-composer-drafts-v1')).toBeNull()
  })
  it('preserves drafts only for the same authorization scope during recovery', () => {
    configureComposerDraftStorage('host/principal-a')
    writeComposerDraft('project', 'session', draft('keep me'))
    preserveComposerDraftsForRecovery()

    configureComposerDraftStorage('host/principal-a')
    expect(readComposerDraft('project', 'session', 'retry')?.doc.nodes).toEqual([
      { type: 'text', text: 'keep me' }
    ])
    expect(sessionStorage.getItem('open-science-composer-drafts-recovery-v1')).toBeNull()

    configureComposerDraftStorage('host/principal-a')
    writeComposerDraft('project', 'session', draft('discard me'))
    preserveComposerDraftsForRecovery()
    configureComposerDraftStorage('host/principal-b')
    expect(readComposerDraft('project', 'session', 'retry')).toBeUndefined()
  })
  it('does not revive deleted sessions or projects from late writes', () => {
    configureComposerDraftStorage('scope')
    writeComposerDraft('p', 's', draft('old'))
    removeComposerDrafts('p', 's')
    writeComposerDraft('p', 's', draft('late'))
    expect(flushComposerDrafts().count).toBe(0)
    writeComposerDraft('p', 'new:p', draft('new'))
    removeComposerDrafts('p')
    writeComposerDraft('p', 'new:p', draft('late'))
    expect(flushComposerDrafts().count).toBe(0)
  })
  it('retains exportable text when storage refuses writes', () => {
    configureComposerDraftStorage('scope')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    writeComposerDraft('p', 's', draft('copy me'))
    expect(flushComposerDrafts()).toMatchObject({ failed: true, count: 1, text: 'p\ns\ncopy me' })
  })
  it('removes stale saved text when a cleared draft cannot be persisted', () => {
    configureComposerDraftStorage('scope')
    writeComposerDraft('p', 's', draft('already sent'))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    writeComposerDraft('p', 's', draft(''))
    expect(sessionStorage.getItem('open-science-composer-drafts-v1')).toBeNull()
    expect(flushComposerDrafts()).toMatchObject({ failed: true, count: 0 })
  })

  it('ignores corrupt and unsupported formats', () => {
    sessionStorage.setItem('open-science-composer-drafts-v1', '{bad')
    expect(() => configureComposerDraftStorage('scope')).not.toThrow()
    expect(readComposerDraft('p', 's', 'retry')).toBeUndefined()
  })
})
