import { describe, expect, it } from 'vitest'

import {
  pdfBookmarkSelectorMatchesPage,
  sanitizePdfBookmarkSource,
  sanitizePdfBookmarkTarget
} from './pdf-bookmarks'

const source = {
  kind: 'artifact-version',
  projectId: 'project-1',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  sessionId: 'session-1',
  checksum: 'a'.repeat(64),
  name: 'paper.pdf',
  path: '/project/paper.pdf'
} as const

describe('sanitizePdfBookmarkTarget', () => {
  it('sanitizes the exact source returned by the read-only resolver', () => {
    expect(sanitizePdfBookmarkSource(source)).toEqual(source)
    expect(
      sanitizePdfBookmarkSource({ ...source, sourceVersionId: source.versionId })
    ).toBeUndefined()
  })

  it('accepts a fixed-version text locator with intrinsic page rotation', () => {
    expect(
      sanitizePdfBookmarkTarget({
        kind: 'pdf',
        source,
        selector: {
          kind: 'text',
          pageNumber: 3,
          exact: 'Evidence',
          prefix: 'Some ',
          suffix: ' here',
          position: { start: 5, end: 13 },
          quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
          extractorVersion: 'pdfjs-5.4.149',
          pageRotation: 90,
          coordinateVersion: 1
        }
      })
    ).toEqual({
      kind: 'pdf',
      source,
      selector: {
        kind: 'text',
        pageNumber: 3,
        exact: 'Evidence',
        prefix: 'Some ',
        suffix: ' here',
        position: { start: 5, end: 13 },
        quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
        extractorVersion: 'pdfjs-5.4.149',
        pageRotation: 90,
        coordinateVersion: 1
      }
    })
  })

  it('accepts a region locator without an annotation image payload', () => {
    expect(
      sanitizePdfBookmarkTarget({
        kind: 'pdf',
        source: { ...source, kind: 'upload-version' },
        selector: {
          kind: 'region',
          pageNumber: 8,
          rect: { x: 0.15, y: 0.25, width: 0.35, height: 0.45 },
          pageRotation: 270,
          coordinateVersion: 1,
          text: 'Figure caption'
        }
      })
    ).toEqual({
      kind: 'pdf',
      source: { ...source, kind: 'upload-version' },
      selector: {
        kind: 'region',
        pageNumber: 8,
        rect: { x: 0.15, y: 0.25, width: 0.35, height: 0.45 },
        pageRotation: 270,
        coordinateVersion: 1,
        text: 'Figure caption'
      }
    })
  })

  it('rejects region locators carrying send-only image fields', () => {
    expect(
      sanitizePdfBookmarkTarget({
        kind: 'pdf',
        source,
        selector: {
          kind: 'region',
          pageNumber: 1,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          pageRotation: 0,
          coordinateVersion: 1,
          image: { mimeType: 'image/png', data: 'base64-crop' }
        }
      })
    ).toBeUndefined()
    expect(
      sanitizePdfBookmarkTarget({
        kind: 'pdf',
        source,
        selector: {
          kind: 'region',
          pageNumber: 1,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          pageRotation: 0,
          coordinateVersion: 1,
          imageOmissionReason: 'session-budget'
        }
      })
    ).toBeUndefined()
  })

  it('rejects unknown persisted fields instead of silently discarding them', () => {
    const selector = {
      kind: 'text',
      pageNumber: 3,
      exact: 'Evidence',
      position: { start: 0, end: 8 },
      quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
      extractorVersion: 'pdfjs-5.4.149',
      pageRotation: 90,
      coordinateVersion: 1
    }
    expect(
      sanitizePdfBookmarkTarget({ kind: 'pdf', source: { ...source, token: 'secret' }, selector })
    ).toBeUndefined()
    expect(
      sanitizePdfBookmarkTarget({ kind: 'pdf', source, selector: { ...selector, image: 'crop' } })
    ).toBeUndefined()
    expect(
      sanitizePdfBookmarkTarget({ kind: 'pdf', source, selector, target: 'agent' })
    ).toBeUndefined()
  })

  it('refuses to render normalized coordinates against a differently rotated page', () => {
    const selector = {
      kind: 'region',
      pageNumber: 2,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      pageRotation: 270,
      coordinateVersion: 1
    } as const
    expect(pdfBookmarkSelectorMatchesPage(selector, 2, 270)).toBe(true)
    expect(pdfBookmarkSelectorMatchesPage(selector, 2, 90)).toBe(false)
    expect(pdfBookmarkSelectorMatchesPage(selector, 1, 270)).toBe(false)
  })
})
