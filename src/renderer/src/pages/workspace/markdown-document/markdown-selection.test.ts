import { describe, expect, it } from 'vitest'

import { sanitizeAnnotations } from '../../../../../shared/annotations'
import { createMarkdownDocumentDraftAnnotation } from './markdown-selection'

describe('Markdown document selection bridge', () => {
  const input = {
    projectId: 'project-1',
    fileSource: 'artifact' as const,
    sourceFileId: 'artifact-1',
    baseVersionId: 'version-1',
    path: 'artifact-version:project-1/session-1/artifact-1/version-1',
    name: 'report.md',
    sessionId: 'session-1',
    draftRevision: 3,
    markdown: '# Result\n\nThe confidence interval is 95%.\n',
    selection: {
      quote: 'confidence interval',
      prefix: 'The ',
      suffix: ' is'
    }
  }

  it('creates a bounded immutable draft snapshot annotation', async () => {
    const annotation = await createMarkdownDocumentDraftAnnotation(input)

    expect(annotation).toMatchObject({
      kind: 'text',
      quote: 'confidence interval',
      anchor: {
        position: { start: 14, end: 33 },
        prefix: 'The ',
        suffix: ' is'
      },
      source: {
        kind: 'document-draft',
        projectId: 'project-1',
        baseVersionId: 'version-1',
        draftRevision: 3,
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    })
    expect(annotation ? sanitizeAnnotations([annotation]) : []).toEqual([annotation])
  })

  it('keeps ambiguous quotes without inventing offsets and rejects oversized selections', async () => {
    const ambiguous = await createMarkdownDocumentDraftAnnotation({
      ...input,
      markdown: 'same same',
      selection: { quote: 'same' }
    })
    expect(ambiguous?.quote).toBe('same')
    expect(ambiguous).not.toHaveProperty('anchor')
    expect(sanitizeAnnotations([ambiguous])).toEqual([ambiguous])

    await expect(
      createMarkdownDocumentDraftAnnotation({
        ...input,
        selection: { quote: 'x'.repeat(4_001) }
      })
    ).resolves.toBeUndefined()
  })
})
