import { describe, expect, it } from 'vitest'

import {
  createSessionArtifactReferenceNormalizer,
  normalizeSessionArtifactImages,
  normalizeSessionArtifactLinks,
  normalizeSessionArtifactReferences,
  resolveRelativeReplyPath,
  resolveMessageArtifactReference,
  resolveSessionDataFileReference,
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
  it('uses the Notebook data directory or conversation working directory for qualified relative paths', () => {
    expect(resolveRelativeReplyPath('data/plot.csv', '/work', '/frame/data')).toBe(
      '/frame/data/plot.csv'
    )
    expect(resolveRelativeReplyPath('a/report.csv', '/work')).toBe('/work/a/report.csv')
    expect(resolveRelativeReplyPath('report.csv', '/work')).toBeUndefined()
  })

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

  it('counts two records for the same file as one filename match', () => {
    const artifact = createArtifact()
    const working = { ...artifact, id: 'working', kind: 'workspace-file' as const }
    expect(resolveMessageArtifactReference('sin_curve.png', [working, artifact])).toBe(artifact)
  })

  it('resolves Windows absolute artifact paths before checking URL schemes', () => {
    const artifact = createArtifact({
      path: 'C:/managed/session/sin_curve.png',
      fileUrl: 'file:///C:/managed/session/sin_curve.png'
    })

    expect(resolveMessageArtifactReference('C:/managed/session/sin_curve.png', [artifact])).toBe(
      artifact
    )
    expect(resolveMessageArtifactReference('C:/other/sin_curve.png', [artifact])).toBeUndefined()
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

  it('preserves unresolved filenames for display while streaming', () => {
    const incremental = createSessionArtifactReferenceNormalizer()
    const content = '![Curve](sin_curve.png)\n\n[Download](sin_curve.png)'

    const normalized =
      '![Curve](sin_curve.png)\n\n[Download](/.open-science/unresolved-file/sin_curve.png)'
    expect(incremental(content, [])).toBe(normalized)
    expect(incremental(`${content}\n\n![More](sin_curve.png)`, [])).toBe(
      `${normalized}\n\n![More](sin_curve.png)`
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

describe('Notebook data file URL normalization', () => {
  const dataRoot = '/Users/example/sessions/session-1/data'
  const path = `${dataRoot}/测试报告.md`
  const content = `[打开报告](file://${path})`
  const internalReference = (value: string): string =>
    `/.open-science/notebook-data/${encodeURIComponent(value).replace(/\(/gu, '%28').replace(/\)/gu, '%29')}`

  it.each([`file://${path}`, `file://${encodeURI(path)}`, `file://localhost${path}`])(
    'normalizes the DEV #1179 hostless file URL before sanitization: %s',
    (href) => {
      expect(normalizeSessionArtifactReferences(`[打开报告](${href})`, [], dataRoot)).toBe(
        `[打开报告](${internalReference(path)})`
      )
    }
  )

  it('preserves formatting, titles and Markdown-sensitive path characters', () => {
    const href = `file://${dataRoot}/测试%20报告_(1)%23%3F%25.md`
    expect(normalizeSessionArtifactReferences(`[**打开报告**](${href} "报告")`, [], dataRoot)).toBe(
      `[**打开报告**](${internalReference(`${dataRoot}/测试 报告_(1)#?%.md`)} "报告")`
    )
  })

  it('decodes file URL paths once, preserving encoded characters in real filenames', () => {
    const href = `file://${dataRoot}/%252e%252e%252ftest.md`
    expect(normalizeSessionArtifactReferences(`[Report](${href})`, [], dataRoot)).toBe(
      `[Report](${internalReference(`${dataRoot}/%2e%2e%2ftest.md`)})`
    )
  })

  it.each([
    `file:///${path}`,
    `file://${dataRoot}/../private/测试报告.md`,
    `file://${dataRoot}/%2e%2e/private/测试报告.md`,
    `file://${dataRoot}/%5cprivate/测试报告.md`,
    `file://${dataRoot}/%00测试报告.md`,
    `file://${dataRoot}/%E0%A4%A.md`,
    `file://${path}?download=1`,
    `file://${path}#heading`,
    `file://${dataRoot}/`
  ])('leaves unsafe or unsupported URLs to the sanitizer: %s', (href) => {
    const markdown = `[打开报告](${href})`
    expect(normalizeSessionArtifactReferences(markdown, [], dataRoot)).toBe(markdown)
  })

  it('routes files outside the current Notebook to the system', () => {
    expect(normalizeSessionArtifactReferences(content, [])).toContain('/.open-science/local-file/')
    expect(normalizeSessionArtifactReferences(content, [], '/other/data')).toContain(
      '/.open-science/local-file/'
    )
  })

  it('keeps code and unresolved images intact', () => {
    const markdown = [
      `\`${content}\``,
      '```md',
      content,
      '```',
      `    ${content}`,
      `![报告](file://${path})`
    ].join('\n')
    expect(normalizeSessionArtifactReferences(markdown, [], dataRoot)).toBe(markdown)
  })

  it('prioritizes a registered managed artifact over Notebook data import', () => {
    const artifact = createArtifact({ path, fileUrl: `file://${path}` })
    expect(normalizeSessionArtifactReferences(content, [artifact], dataRoot)).toBe(
      '[打开报告](/.open-science/artifact/version-1)'
    )
  })

  it('keeps a normalized file URL separate from an unrelated same-name artifact', () => {
    const artifact = createArtifact({ path: '/other/测试报告.md', name: '测试报告.md' })
    const reference = internalReference(path)
    expect(normalizeSessionArtifactReferences(content, [artifact], dataRoot)).toBe(
      `[打开报告](${reference})`
    )
    expect(resolveMessageArtifactReference(reference, [artifact])).toBeUndefined()
    expect(resolveSessionDataFileReference(reference, dataRoot)).toBe(path)
    expect(resolveSessionDataFileReference(reference, '/other/data')).toBeUndefined()
    expect(resolveMessageArtifactReference(path, [artifact])).toBeUndefined()
  })

  it('preserves exact managed-path matches without fileUrl metadata', () => {
    const artifact = createArtifact({ path, fileUrl: undefined, name: '测试报告.md' })
    expect(normalizeSessionArtifactReferences(content, [artifact], dataRoot)).toBe(
      '[打开报告](/.open-science/artifact/version-1)'
    )
  })

  it.each([
    [
      'C:\\Users\\example\\data',
      'file:///c:/users/example/data/report.md',
      'C:\\Users\\example\\data\\report.md'
    ],
    [
      'C:\\Users\\example\\data',
      'c:/users/example/data/report.md',
      'C:\\Users\\example\\data\\report.md'
    ],
    [
      '\\\\server\\share\\data',
      'file://SERVER/share/data/report.md',
      '\\\\server\\share\\data\\report.md'
    ]
  ])(
    'matches registered Windows paths across slash style and drive case: %s',
    (root, href, artifactPath) => {
      const artifact = createArtifact({ path: artifactPath, fileUrl: undefined, name: 'report.md' })
      expect(normalizeSessionArtifactReferences(`[Report](${href})`, [artifact], root)).toBe(
        '[Report](/.open-science/artifact/version-1)'
      )
    }
  )

  it('does not reinterpret a drive-shaped segment under a POSIX root', () => {
    expect(
      normalizeSessionArtifactReferences('[Report](file:///C:/data/report.md)', [], '/C:/data')
    ).toBe(`[Report](${internalReference('/C:/data/report.md')})`)
  })

  it('keeps streaming normalization consistent and invalidates cached roots', () => {
    const normalize = createSessionArtifactReferenceNormalizer()
    const artifacts: MessageArtifact[] = []
    let streamed = ''
    for (const chunk of ['Start.\n\n[打开', `报告](file://${path})`, '\n\nDone.']) {
      streamed += chunk
      expect(normalize(streamed, artifacts, dataRoot)).toBe(
        normalizeSessionArtifactReferences(streamed, artifacts, dataRoot)
      )
    }
    expect(normalize(streamed, artifacts, '/other/data')).toContain('/.open-science/local-file/')
    expect(normalize(streamed, artifacts, dataRoot)).toBe(
      normalizeSessionArtifactReferences(streamed, artifacts, dataRoot)
    )
  })
})
