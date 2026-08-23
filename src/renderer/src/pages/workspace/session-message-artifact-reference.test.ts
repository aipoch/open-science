import { describe, expect, it } from 'vitest'

import {
  normalizeSessionArtifactImages,
  normalizeSessionArtifactLinks,
  normalizeSessionArtifactReferences,
  resolveMessageArtifactReference,
  type MessageArtifact
} from './session-message-artifact-reference'

const createArtifact = (overrides: Partial<MessageArtifact> = {}): MessageArtifact => ({
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  kind: 'managed-file',
  path: '/managed/session/sin_curve.png',
  fileUrl: 'file:///managed/session/sin_curve.png',
  name: 'sin_curve.png',
  mimeType: 'image/png',
  size: 1024,
  mtimeMs: 1710000000000,
  ...overrides
})

describe('session message artifact references', () => {
  it('resolves explicit artifact ids and unique relative filenames', () => {
    const artifact = createArtifact()

    expect(resolveMessageArtifactReference('{{artifact:version-1}}', [artifact])).toBe(artifact)
    expect(resolveMessageArtifactReference('sin_curve.png', [artifact])).toBe(artifact)
    expect(resolveMessageArtifactReference('./sin_curve.png', [artifact])).toBe(artifact)
    expect(resolveMessageArtifactReference('/managed/session/sin_curve.png', [artifact])).toBe(
      artifact
    )
    expect(
      resolveMessageArtifactReference('file:///managed/session/sin_curve.png', [artifact])
    ).toBe(artifact)
  })

  it('leaves external and ambiguous filename links unresolved', () => {
    const artifacts = [
      createArtifact(),
      createArtifact({ id: 'version-2', versionId: 'version-2', path: '/other/sin_curve.png' })
    ]

    expect(resolveMessageArtifactReference('https://example.com/sin_curve.png', artifacts)).toBe(
      undefined
    )
    expect(resolveMessageArtifactReference('sin_curve.png', artifacts)).toBe(undefined)
  })

  it('converts only explicit artifact image Markdown and escapes its alt text', () => {
    const content =
      '![Curve <one> & "two"]({{artifact:version-1}})\n\n![Remote](https://example.com/a.png)'

    expect(normalizeSessionArtifactImages(content, [createArtifact()])).toBe(
      '<session-artifact-image artifact_ref="version-1" alt_text="Curve &lt;one&gt; &amp; &quot;two&quot;"></session-artifact-image>\n\n![Remote](https://example.com/a.png)'
    )
  })

  it('converts relative, absolute, and file URL images that resolve to the message artifact', () => {
    const artifact = createArtifact()

    for (const reference of [
      'sin_curve.png',
      './sin_curve.png',
      '/managed/session/sin_curve.png',
      'file:///managed/session/sin_curve.png'
    ]) {
      expect(normalizeSessionArtifactImages(`![Curve](${reference})`, [artifact])).toBe(
        '<session-artifact-image artifact_ref="version-1" alt_text="Curve"></session-artifact-image>'
      )
    }
  })

  it('rewrites supported artifact links to an inert internal target', () => {
    const artifact = createArtifact()

    for (const reference of [
      'sin_curve.png',
      './sin_curve.png',
      '/managed/session/sin_curve.png',
      'file:///managed/session/sin_curve.png',
      '{{artifact:version-1}}'
    ]) {
      expect(normalizeSessionArtifactLinks(`[Curve](${reference})`, [artifact])).toBe(
        '[Curve](/.open-science/artifact/version-1)'
      )
    }
  })

  it('normalizes artifact images and links without rewriting remote content', () => {
    const content = [
      '![Curve](sin_curve.png)',
      '[Download](sin_curve.png)',
      '[Remote](https://example.com/sin_curve.png)'
    ].join('\n\n')

    expect(normalizeSessionArtifactReferences(content, [createArtifact()])).toBe(
      [
        '<session-artifact-image artifact_ref="version-1" alt_text="Curve"></session-artifact-image>',
        '[Download](/.open-science/artifact/version-1)',
        '[Remote](https://example.com/sin_curve.png)'
      ].join('\n\n')
    )
  })

  it('supports balanced parentheses and collapses linked images to one preview control', () => {
    const artifact = createArtifact({
      path: '/managed/session/plot_(1).png',
      fileUrl: 'file:///managed/session/plot_(1).png',
      name: 'plot_(1).png'
    })
    const imageMarkup =
      '<session-artifact-image artifact_ref="version-1" alt_text="Plot"></session-artifact-image>'

    expect(normalizeSessionArtifactImages('![Plot](plot_(1).png)', [artifact])).toBe(imageMarkup)
    expect(normalizeSessionArtifactLinks('[Plot](plot_(1).png "Latest")', [artifact])).toBe(
      '[Plot](/.open-science/artifact/version-1 "Latest")'
    )
    expect(
      normalizeSessionArtifactReferences('[![Plot](plot_(1).png)](plot_(1).png)', [artifact])
    ).toBe(imageMarkup)
    expect(
      normalizeSessionArtifactReferences('[Label ![Plot](plot_(1).png)](plot_(1).png)', [artifact])
    ).toBe('[Label ![Plot](plot_(1).png)](plot_(1).png)')
  })

  it('leaves artifact-like Markdown inside code unchanged', () => {
    const content = [
      '![Rendered](sin_curve.png)',
      '`![Inline](sin_curve.png)` and ``[Inline link](sin_curve.png)``',
      '```md',
      '![Fenced](sin_curve.png)',
      '[Fenced link](sin_curve.png)',
      '```',
      '    ![Indented](sin_curve.png)',
      '[Rendered link](sin_curve.png)'
    ].join('\n')

    expect(normalizeSessionArtifactReferences(content, [createArtifact()])).toBe(
      [
        '<session-artifact-image artifact_ref="version-1" alt_text="Rendered"></session-artifact-image>',
        '`![Inline](sin_curve.png)` and ``[Inline link](sin_curve.png)``',
        '```md',
        '![Fenced](sin_curve.png)',
        '[Fenced link](sin_curve.png)',
        '```',
        '    ![Indented](sin_curve.png)',
        '[Rendered link](/.open-science/artifact/version-1)'
      ].join('\n')
    )
  })
})
