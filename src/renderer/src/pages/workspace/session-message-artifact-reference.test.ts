import { describe, expect, it } from 'vitest'

import {
  normalizeSessionArtifactImages,
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
})
