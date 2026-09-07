import { describe, expect, it } from 'vitest'

import {
  PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL,
  isAllowedPreviewContextMenuFrameUrl,
  isPreviewContextMenuRequest
} from './preview-context-menu'

describe('preview context menu contract', () => {
  const request = {
    x: 12,
    y: 24,
    frameUrl: 'open-science-preview://resource-1/report.html'
  }

  it('pins the Electron-only event channel and accepts the narrow safe payload', () => {
    expect(PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL).toBe('preview-context-menu:requested')
    expect(isPreviewContextMenuRequest(request)).toBe(true)
  })

  it('accepts only managed HTML and Office runtime frame protocols', () => {
    expect(isAllowedPreviewContextMenuFrameUrl(request.frameUrl)).toBe(true)
    expect(
      isAllowedPreviewContextMenuFrameUrl(
        'open-science-office-preview://runtime/office-preview.html?sessionId=session-1'
      )
    ).toBe(true)
    expect(isAllowedPreviewContextMenuFrameUrl('https://example.com/report.html')).toBe(false)
    expect(isAllowedPreviewContextMenuFrameUrl('open-science-other://runtime/report.html')).toBe(
      false
    )
    expect(isAllowedPreviewContextMenuFrameUrl('not a url')).toBe(false)
  })

  it('rejects invalid coordinates, URLs, and incomplete objects', () => {
    expect(isPreviewContextMenuRequest({ ...request, x: Number.NaN })).toBe(false)
    expect(isPreviewContextMenuRequest({ ...request, y: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isPreviewContextMenuRequest({ ...request, frameUrl: 'https://example.com' })).toBe(false)
    expect(isPreviewContextMenuRequest({ x: request.x, y: request.y })).toBe(false)
    expect(isPreviewContextMenuRequest(null)).toBe(false)
  })
})
