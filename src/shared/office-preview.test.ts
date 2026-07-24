import { describe, expect, it } from 'vitest'

import * as officePreview from './office-preview'

describe('Office preview frame messages', () => {
  it('accepts versioned runtime messages and rejects malformed state', () => {
    const isRuntimeMessage = (
      officePreview as typeof officePreview & {
        isOfficePreviewRuntimeMessage?: (value: unknown) => boolean
      }
    ).isOfficePreviewRuntimeMessage
    expect(isRuntimeMessage).toBeTypeOf('function')
    if (!isRuntimeMessage) return

    expect(
      isRuntimeMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'ready',
        sessionId: 'session-1'
      })
    ).toBe(true)
    expect(
      isRuntimeMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'state',
        sessionId: 'session-1',
        state: { sessionId: 'session-1', phase: 'ready' }
      })
    ).toBe(true)
    expect(
      isRuntimeMessage({
        channel: 'open-science-office-preview',
        version: 2,
        type: 'ready',
        sessionId: 'session-1'
      })
    ).toBe(false)
    expect(
      isRuntimeMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'state',
        sessionId: 'session-1',
        state: { sessionId: 'different-session', phase: 'ready' }
      })
    ).toBe(false)
  })

  it('accepts only complete host start messages for the same session', () => {
    const isHostMessage = (
      officePreview as typeof officePreview & {
        isOfficePreviewHostMessage?: (value: unknown) => boolean
      }
    ).isOfficePreviewHostMessage
    expect(isHostMessage).toBeTypeOf('function')
    if (!isHostMessage) return

    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.docx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'docx',
      name: 'report.docx',
      attempt: 0
    }
    expect(
      isHostMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'start',
        sessionId: 'session-1',
        start
      })
    ).toBe(true)
    expect(
      isHostMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'start',
        sessionId: 'different-session',
        start
      })
    ).toBe(false)
  })
})

describe('Office preview timeout policy', () => {
  it('doubles only the default timeout for retries', () => {
    expect(officePreview.getOfficePreviewTimeoutMs(1024, 0)).toBe(30_000)
    expect(officePreview.getOfficePreviewTimeoutMs(1024, 1)).toBe(60_000)
    expect(officePreview.getOfficePreviewTimeoutMs(1024, 5)).toBe(60_000)
  })

  it('uses the large-file timeout without exceeding the retry ceiling', () => {
    const largeFile = 20 * 1024 * 1024 + 1
    expect(officePreview.getOfficePreviewTimeoutMs(largeFile, 0)).toBe(120_000)
    expect(officePreview.getOfficePreviewTimeoutMs(largeFile, 1)).toBe(240_000)
    expect(officePreview.getOfficePreviewTimeoutMs(largeFile, 5)).toBe(240_000)
  })
})
