import { describe, expect, it } from 'vitest'

import type { PersistedChatMessage } from './session-persistence'
import { buildSessionHistoryReplay } from './session-history-replay'
import type { PersistedUploadedAttachment } from './uploads'

const upload = (id: string, versionId: string, name: string): PersistedUploadedAttachment => ({
  id,
  versionId,
  versionNumber: 1,
  sessionId: 'session-1',
  name,
  originalName: name,
  mimeType: 'application/pdf',
  size: 100
})

describe('buildSessionHistoryReplay', () => {
  it('does not replay Reading PDFs while preserving ordinary PDF attachments', () => {
    const readingPdf = upload('reading-upload', 'reading-version', 'reading.pdf')
    const ordinaryPdf = upload('ordinary-upload', 'ordinary-version', 'ordinary.pdf')
    const messages: PersistedChatMessage[] = [
      {
        id: 'message-1',
        role: 'user',
        content: 'Compare these files.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        uploads: [readingPdf, ordinaryPdf],
        pdfContext: {
          version: 1,
          bindings: [
            {
              version: 1,
              bindingId: 'binding-1',
              sourceKind: 'upload-version',
              sourceFileId: 'reading-upload',
              sourceVersionId: 'reading-version',
              sourceSessionId: 'session-1',
              name: 'reading.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 100,
              checksum: 'a'.repeat(64),
              linkedAt: 1
            }
          ]
        }
      }
    ]

    const replay = buildSessionHistoryReplay(messages, {
      target: 'codex-response',
      budget: 10_000
    })

    expect(replay?.historyAttachments.map(({ versionId }) => versionId)).toEqual([
      'ordinary-version'
    ])
  })
})
