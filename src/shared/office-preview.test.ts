import { describe, expect, it } from 'vitest'

import {
  getOfficePreviewTimeoutMs,
  isOfficePreviewHostMessage,
  isOfficePreviewRuntimeMessage
} from './office-preview'

describe('Office preview frame messages', () => {
  it('accepts versioned runtime state messages and rejects malformed state', () => {
    expect(
      isOfficePreviewRuntimeMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'state',
        state: { sessionId: 'session-1', phase: 'ready' }
      })
    ).toBe(true)
    expect(
      isOfficePreviewRuntimeMessage({
        channel: 'open-science-office-preview',
        version: 2,
        type: 'state',
        state: { sessionId: 'session-1', phase: 'ready' }
      })
    ).toBe(false)
    expect(
      isOfficePreviewRuntimeMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'state',
        state: { sessionId: '', phase: 'ready' }
      })
    ).toBe(false)
  })

  it('accepts only complete host start messages', () => {
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
      isOfficePreviewHostMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'start',
        start
      })
    ).toBe(true)
    expect(
      isOfficePreviewHostMessage({
        channel: 'open-science-office-preview',
        version: 1,
        type: 'start',
        start: { ...start, sessionId: '' }
      })
    ).toBe(false)
  })
})

describe('Office preview timeout policy', () => {
  it('doubles only the default timeout for retries', () => {
    expect(getOfficePreviewTimeoutMs(1024, 0)).toBe(30_000)
    expect(getOfficePreviewTimeoutMs(1024, 1)).toBe(60_000)
    expect(getOfficePreviewTimeoutMs(1024, 5)).toBe(60_000)
  })

  it('uses the large-file timeout without exceeding the retry ceiling', () => {
    const largeFile = 20 * 1024 * 1024 + 1
    expect(getOfficePreviewTimeoutMs(largeFile, 0)).toBe(120_000)
    expect(getOfficePreviewTimeoutMs(largeFile, 1)).toBe(240_000)
    expect(getOfficePreviewTimeoutMs(largeFile, 5)).toBe(240_000)
  })
})
