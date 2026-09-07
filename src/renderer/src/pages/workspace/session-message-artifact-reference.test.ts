import { describe, expect, it } from 'vitest'

import {
  createSessionArtifactReferenceNormalizer,
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

  it('resolves Windows absolute artifact paths before checking URL schemes', () => {
    const artifact = createArtifact({
      path: 'C:/managed/session/sin_curve.png',
      fileUrl: 'file:///C:/managed/session/sin_curve.png'
    })

    expect(resolveMessageArtifactReference('C:/managed/session/sin_curve.png', [artifact])).toBe(
      artifact
    )
    expect(resolveMessageArtifactReference('C:/other/sin_curve.png', [artifact])).toBe(artifact)
    expect(
      normalizeSessionArtifactReferences(
        '![Curve](C:/managed/session/sin_curve.png)\n[Curve](C:/managed/session/sin_curve.png)',
        [artifact]
      )
    ).toBe(
      '<session-artifact-image artifact_ref="version-1" alt_text="Curve"></session-artifact-image>\n[Curve](/.open-science/artifact/version-1)'
    )
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

  it('converts TIFF Markdown images to the managed preview component', () => {
    const artifact = createArtifact({
      path: '/managed/session/scan.tiff',
      name: 'scan.tiff',
      mimeType: 'image/tiff'
    })

    expect(normalizeSessionArtifactImages('![Scan](scan.tiff)', [artifact])).toBe(
      '<session-artifact-image artifact_ref="version-1" alt_text="Scan"></session-artifact-image>'
    )
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
      '> ```',
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
        '> ```',
        '[Fenced link](sin_curve.png)',
        '```',
        '    ![Indented](sin_curve.png)',
        '[Rendered link](/.open-science/artifact/version-1)'
      ].join('\n')
    )
  })

  it('preserves artifact syntax inside blockquoted and list-nested fences', () => {
    const content = [
      '> ```md',
      '> ![Quoted code](sin_curve.png)',
      '> ```',
      '> ![Quoted preview](sin_curve.png)',
      '',
      '- ```md',
      '  [List code](sin_curve.png)',
      '  ```',
      '- [List preview](sin_curve.png)'
    ].join('\n')

    expect(normalizeSessionArtifactReferences(content, [createArtifact()])).toBe(
      [
        '> ```md',
        '> ![Quoted code](sin_curve.png)',
        '> ```',
        '> <session-artifact-image artifact_ref="version-1" alt_text="Quoted preview"></session-artifact-image>',
        '',
        '- ```md',
        '  [List code](sin_curve.png)',
        '  ```',
        '- [List preview](/.open-science/artifact/version-1)'
      ].join('\n')
    )
  })
})

describe('createSessionArtifactReferenceNormalizer', () => {
  // Feeds every append-only prefix of `chunks` through the incremental normalizer and pins each
  // step to the full one-shot normalization of the same text.
  const expectAppendStreamMatchesFull = (
    chunks: string[],
    artifacts: MessageArtifact[] = [createArtifact()]
  ): void => {
    const incremental = createSessionArtifactReferenceNormalizer()
    let streamed = ''
    for (const chunk of chunks) {
      streamed += chunk
      expect(incremental(streamed, artifacts)).toBe(
        normalizeSessionArtifactReferences(streamed, artifacts)
      )
    }
  }

  it('returns the input unchanged when there are no artifacts to rewrite', () => {
    const incremental = createSessionArtifactReferenceNormalizer()
    const content = '![Curve](sin_curve.png)\n\n[Download](sin_curve.png)'

    expect(incremental(content, [])).toBe(content)
    expect(incremental(`${content}\n\n![More](sin_curve.png)`, [])).toBe(
      `${content}\n\n![More](sin_curve.png)`
    )
  })

  it('matches full normalization for append-only growth with artifact images and links', () => {
    expectAppendStreamMatchesFull([
      'Here is the chart.\n\n![Cur',
      've](sin_curve.png)\n\n[Down',
      'load](sin_curve.png)',
      '\n\n[Remote](https://example.com/sin_curve.png)'
    ])
  })

  it('matches full normalization when an append splits a code fence marker', () => {
    expectAppendStreamMatchesFull([
      'Rendered below.\n\n``',
      '`md\n![Fenced](sin_curve.png)\n```',
      '\n\n![Rendered](sin_curve.png)'
    ])
  })

  it('matches full normalization for an unclosed fence that later closes', () => {
    expectAppendStreamMatchesFull([
      '```md\n![Fenced](sin_curve.png)',
      '\n[Also fenced](sin_curve.png)',
      '\n```\n\n[Rendered link](sin_curve.png)'
    ])
  })

  it('matches full normalization for blockquoted and list-nested fences', () => {
    expectAppendStreamMatchesFull([
      '> ```md\n> ![Quoted code](sin_curve.png)\n> ```',
      '\n> ![Quoted preview](sin_curve.png)\n\n- ```md',
      '\n  [List code](sin_curve.png)\n  ```',
      '\n- [List preview](sin_curve.png)'
    ])
  })

  it('matches full normalization when the stream ends inside a partial image reference', () => {
    expectAppendStreamMatchesFull([
      '![Curve](sin_',
      'curve.png)',
      '\n\nNext paragraph with [a link](sin_curve.png).'
    ])
  })

  it('falls back to full normalization for non-append changes', () => {
    const artifacts = [createArtifact()]
    const incremental = createSessionArtifactReferenceNormalizer()
    incremental('![Curve](sin_curve.png)\n\nOriginal tail.', artifacts)

    const edited = '![Curve](sin_curve.png)\n\nEdited tail.'
    expect(incremental(edited, artifacts)).toBe(
      normalizeSessionArtifactReferences(edited, artifacts)
    )

    // The stream can keep growing incrementally after an edit.
    const grown = `${edited}\n\n[Download](sin_curve.png)`
    expect(incremental(grown, artifacts)).toBe(normalizeSessionArtifactReferences(grown, artifacts))
  })

  it('recomputes when the artifacts array identity changes', () => {
    const incremental = createSessionArtifactReferenceNormalizer()
    const first = [createArtifact()]
    const second = [createArtifact({ id: 'version-2', versionId: 'version-2' })]
    const content = '![Curve](sin_curve.png)'

    expect(incremental(content, first)).toBe(
      '<session-artifact-image artifact_ref="version-1" alt_text="Curve"></session-artifact-image>'
    )
    expect(incremental(content, second)).toBe(
      '<session-artifact-image artifact_ref="version-2" alt_text="Curve"></session-artifact-image>'
    )
    expect(incremental(`${content}\n\n![Again](sin_curve.png)`, second)).toBe(
      normalizeSessionArtifactReferences(`${content}\n\n![Again](sin_curve.png)`, second)
    )
  })

  it('returns the cached output for repeated identical input', () => {
    const artifacts = [createArtifact()]
    const incremental = createSessionArtifactReferenceNormalizer()
    const content = '![Curve](sin_curve.png)'

    expect(incremental(content, artifacts)).toBe(
      normalizeSessionArtifactReferences(content, artifacts)
    )
    expect(incremental(content, artifacts)).toBe(
      normalizeSessionArtifactReferences(content, artifacts)
    )
  })

  it('handles empty input', () => {
    const incremental = createSessionArtifactReferenceNormalizer()
    expect(incremental('', [createArtifact()])).toBe('')
    expectAppendStreamMatchesFull(['![Curve](sin_curve.png)', '\n\nDone.'])
  })
})
