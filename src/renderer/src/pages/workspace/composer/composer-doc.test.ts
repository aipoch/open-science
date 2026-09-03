// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ArtifactReference } from '../../../../../shared/artifacts'

import {
  appendArtifactMention,
  applyDocToDom,
  createPastedTextAnchor,
  docArtifactCount,
  docFromMessageParts,
  docFromText,
  docIsEmpty,
  docSessionCount,
  docToArtifactRefs,
  docToMessageParts,
  docToPdfContextSources,
  docToSkillIds,
  docToText,
  domToDoc,
  emptyDoc,
  insertPastedTextNodeAtLogicalOffset,
  LONG_PASTE_CHARACTER_THRESHOLD,
  LONG_PASTE_LINE_THRESHOLD,
  pastedTextLogicalOffset,
  restorePastedTextNode,
  shouldAttachPastedText,
  type ComposerDoc
} from './composer-doc'

describe('docToText', () => {
  it('concatenates text nodes and renders skill nodes as /<name>', () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'run ' },
        { type: 'skill', id: 'tdd', name: 'TDD' },
        { type: 'text', text: ' now' }
      ]
    }
    expect(docToText(doc)).toBe('run /TDD now')
  })

  it('renders artifact nodes as @<name>', () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'compare ' },
        {
          type: 'artifact',
          id: 'a1',
          name: 'fig1.png',
          path: '/p/fig1.png',
          source: 'artifact',
          mimeType: 'image/png'
        },
        { type: 'text', text: ' and ' },
        {
          type: 'artifact',
          id: 'u1',
          name: 'clinical trial03.pdf',
          path: '/u/clinical trial03.pdf',
          source: 'upload'
        }
      ]
    }
    expect(docToText(doc)).toBe('compare @fig1.png and @clinical trial03.pdf')
  })

  it('renders linked-folder artifact nodes as @<relativePath>', () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'analyze ' },
        {
          type: 'artifact',
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/study.csv'
        }
      ]
    }
    expect(docToText(doc)).toBe('analyze @data/study.csv')
  })

  it('renders Session nodes as #<snapshot title>', () => {
    expect(
      docToText({ nodes: [{ type: 'session', sessionId: 'session-2', title: 'Earlier result' }] })
    ).toBe('#Earlier result')
  })

  it('returns an empty string for the empty doc', () => {
    expect(docToText(emptyDoc)).toBe('')
  })

  it('omits live pasted-text anchors from message text and durable parts', () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'before' },
        { type: 'pasted-text', id: 'paste-1', text: 'large payload', attachmentId: 'upload-1' },
        { type: 'text', text: 'after' }
      ]
    }

    expect(docToText(doc)).toBe('beforeafter')
    expect(docToMessageParts(doc)).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' }
    ])
  })
})

describe('long pasted text', () => {
  it('uses the confirmed character and line thresholds', () => {
    expect(shouldAttachPastedText('x'.repeat(LONG_PASTE_CHARACTER_THRESHOLD))).toBe(false)
    expect(shouldAttachPastedText('x'.repeat(LONG_PASTE_CHARACTER_THRESHOLD + 1))).toBe(true)
    expect(shouldAttachPastedText('x\n'.repeat(LONG_PASTE_LINE_THRESHOLD - 1) + 'x')).toBe(false)
    expect(shouldAttachPastedText('x\n'.repeat(LONG_PASTE_LINE_THRESHOLD) + 'x')).toBe(true)
  })

  it('restores the text between surrounding runs and returns the exact caret offset', () => {
    const restored = restorePastedTextNode(
      {
        nodes: [
          { type: 'text', text: 'before ' },
          { type: 'pasted-text', id: 'paste-1', text: 'payload' },
          { type: 'text', text: ' after' }
        ]
      },
      'paste-1'
    )

    expect(restored).toEqual({
      doc: { nodes: [{ type: 'text', text: 'before payload after' }] },
      caret: { nodeIndex: 0, offset: 'before payload'.length }
    })
  })

  it('reinserts only the removed anchor after another paste has become inline text', () => {
    const removed = { type: 'pasted-text' as const, id: 'paste-a', text: 'alpha' }
    const original: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'before ' },
        removed,
        { type: 'text', text: ' middle ' },
        { type: 'pasted-text', id: 'paste-b', text: 'bravo' },
        { type: 'text', text: ' after' }
      ]
    }
    const offset = pastedTextLogicalOffset(original, removed.id)

    expect(
      insertPastedTextNodeAtLogicalOffset(
        { nodes: [{ type: 'text', text: 'before  middle bravo after' }] },
        removed,
        offset ?? 0
      )
    ).toEqual({
      nodes: [
        { type: 'text', text: 'before ' },
        removed,
        { type: 'text', text: ' middle bravo after' }
      ]
    })
  })

  it('round-trips a compact visible marker without putting the payload in the DOM', () => {
    const root = document.createElement('div')
    const node = { type: 'pasted-text' as const, id: 'paste-1', text: 'private payload' }
    const anchor = createPastedTextAnchor(node)
    root.append(anchor)

    expect(anchor.textContent).not.toContain(node.text)
    expect(Array.from(anchor.attributes).map((attribute) => attribute.value)).not.toContain(
      node.text
    )
    expect(anchor.textContent).toBe('…')
    expect(anchor.getAttribute('role')).toBe('button')
    expect(anchor.getAttribute('aria-controls')).toBe('composer-pasted-text-attachment-paste-1')
    expect(anchor.className).toContain('h-5')
    expect(anchor.className).not.toContain('h-0')
    expect(domToDoc(root)).toEqual({ nodes: [node] })
  })
})

describe('docToSkillIds', () => {
  it('collects skill ids in order and de-duplicates them', () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: 'skill', id: 'a', name: 'A' },
        { type: 'text', text: ' and ' },
        { type: 'skill', id: 'b', name: 'B' },
        { type: 'skill', id: 'a', name: 'A' }
      ]
    }
    expect(docToSkillIds(doc)).toEqual(['a', 'b'])
  })

  it('returns an empty array when there are no skill nodes', () => {
    expect(docToSkillIds(docFromText('plain text'))).toEqual([])
  })
})

describe('docToArtifactRefs', () => {
  it('collects artifact refs in order and de-duplicates by path', () => {
    const doc: ComposerDoc = {
      nodes: [
        {
          type: 'artifact',
          id: 'a1',
          sourceFileId: 'artifact-file-1',
          name: 'fig1.png',
          path: '/p/fig1.png',
          source: 'artifact',
          mimeType: 'image/png'
        },
        { type: 'text', text: ' and ' },
        { type: 'artifact', id: 'u1', name: 'notes.md', path: '/u/notes.md', source: 'upload' },
        // Same path as the first, mentioned again with a different chip id — collapsed.
        { type: 'artifact', id: 'a1b', name: 'fig1.png', path: '/p/fig1.png', source: 'artifact' }
      ]
    }
    expect(docToArtifactRefs(doc)).toEqual([
      {
        id: 'a1',
        sourceFileId: 'artifact-file-1',
        name: 'fig1.png',
        path: '/p/fig1.png',
        source: 'artifact',
        mimeType: 'image/png',
        versionId: undefined
      },
      {
        id: 'u1',
        name: 'notes.md',
        path: '/u/notes.md',
        source: 'upload',
        mimeType: undefined,
        versionId: undefined
      }
    ])
  })

  it('returns an empty array when there are no artifact nodes', () => {
    expect(docToArtifactRefs(docFromText('plain text'))).toEqual([])
  })

  it('preserves and de-duplicates linked-folder references by granted root and relative path', () => {
    const linked = {
      type: 'artifact' as const,
      id: 'linked-1',
      name: 'study.csv',
      source: 'linked-folder' as const,
      rootId: 'root-1',
      relativePath: 'data/study.csv',
      mimeType: 'text/csv'
    }

    expect(docToArtifactRefs({ nodes: [linked, { ...linked, id: 'linked-2' }] })).toEqual([
      {
        id: 'linked-1',
        name: 'study.csv',
        source: 'linked-folder',
        rootId: 'root-1',
        relativePath: 'data/study.csv',
        mimeType: 'text/csv'
      }
    ])
  })
})

describe('docToPdfContextSources', () => {
  it('collects only immutable PDF mentions, de-duplicated and capped at three', () => {
    const pdf = (
      id: string,
      source: 'artifact' | 'upload' = 'artifact'
    ): ArtifactReference & { type: 'artifact' } => ({
      type: 'artifact' as const,
      id,
      name: `${id}.pdf`,
      path: `/${id}.pdf`,
      source,
      sourceFileId: `file-${id}`,
      mimeType: 'application/pdf; charset=binary',
      versionId: `version-${id}`
    })
    expect(
      docToPdfContextSources({
        nodes: [
          pdf('one'),
          pdf('two', 'upload'),
          { ...pdf('one'), id: 'duplicate', path: '/duplicate.pdf' },
          {
            type: 'artifact',
            id: 'notes',
            name: 'notes.txt',
            path: '/notes.txt',
            source: 'upload',
            mimeType: 'text/plain',
            versionId: 'version-notes'
          },
          pdf('three'),
          pdf('four')
        ]
      })
    ).toEqual([
      {
        sourceKind: 'artifact-version',
        sourceFileId: 'file-one',
        sourceVersionId: 'version-one'
      },
      {
        sourceKind: 'upload-version',
        sourceFileId: 'file-two',
        sourceVersionId: 'version-two'
      },
      {
        sourceKind: 'artifact-version',
        sourceFileId: 'file-three',
        sourceVersionId: 'version-three'
      }
    ])
  })
})

describe('docArtifactCount', () => {
  it('counts artifact chips including path duplicates', () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: 'artifact', id: 'a1', name: 'fig1.png', path: '/p/fig1.png', source: 'artifact' },
        { type: 'skill', id: 's', name: 'S' },
        { type: 'artifact', id: 'a1b', name: 'fig1.png', path: '/p/fig1.png', source: 'artifact' }
      ]
    }
    expect(docArtifactCount(doc)).toBe(2)
  })
})

describe('docSessionCount', () => {
  it('counts Session chips', () => {
    expect(
      docSessionCount({
        nodes: [
          { type: 'session', sessionId: 'session-1', title: 'One' },
          { type: 'text', text: ' ' },
          { type: 'session', sessionId: 'session-2', title: 'Two' }
        ]
      })
    ).toBe(2)
  })
})

describe('appendArtifactMention', () => {
  it('appends one separating space only when the preceding node is not whitespace', () => {
    const reference = {
      id: 'artifact-1',
      name: 'sin.png',
      path: 'artifact-version:project-a/session-a/artifact-1/version-1',
      source: 'artifact' as const,
      versionId: 'version-1'
    }

    expect(appendArtifactMention(docFromText('plot'), reference)).toEqual({
      nodes: [
        { type: 'text', text: 'plot' },
        { type: 'text', text: ' ' },
        { type: 'artifact', ...reference }
      ]
    })
    expect(appendArtifactMention(docFromText('plot '), reference).nodes).toEqual([
      { type: 'text', text: 'plot ' },
      { type: 'artifact', ...reference }
    ])
  })

  it('does not exceed the Artifact mention cap', () => {
    const fullDoc: ComposerDoc = {
      nodes: Array.from({ length: 10 }, (_, index) => ({
        type: 'artifact' as const,
        id: `artifact-${index}`,
        name: `${index}.png`,
        path: `/artifact-${index}`,
        source: 'artifact' as const
      }))
    }

    expect(
      appendArtifactMention(fullDoc, {
        id: 'extra',
        name: 'extra.png',
        path: '/extra',
        source: 'artifact'
      })
    ).toBe(fullDoc)
  })
})

describe('docFromText', () => {
  it('wraps plain text in a single text node', () => {
    expect(docFromText('hello world')).toEqual({
      nodes: [{ type: 'text', text: 'hello world' }]
    })
  })

  it('maps an empty string to the empty doc', () => {
    expect(docFromText('')).toEqual(emptyDoc)
  })

  it('round-trips through docToText', () => {
    expect(docToText(docFromText('some draft'))).toBe('some draft')
  })
})

describe('docIsEmpty', () => {
  it('is true for the empty doc', () => {
    expect(docIsEmpty(emptyDoc)).toBe(true)
  })

  it('is true for whitespace-only text and no skill nodes', () => {
    expect(docIsEmpty({ nodes: [{ type: 'text', text: '   \n\t' }] })).toBe(true)
  })

  it('is false when a skill node exists even with only whitespace text', () => {
    expect(
      docIsEmpty({
        nodes: [
          { type: 'text', text: '  ' },
          { type: 'skill', id: 'a', name: 'A' }
        ]
      })
    ).toBe(false)
  })

  it('is false when text has non-whitespace content', () => {
    expect(docIsEmpty(docFromText('x'))).toBe(false)
  })

  it('is false when a pasted-text attachment anchor exists', () => {
    expect(docIsEmpty({ nodes: [{ type: 'pasted-text', id: 'paste-1', text: 'payload' }] })).toBe(
      false
    )
  })
})

describe('domToDoc', () => {
  it('reads a text node followed by a skill chip', () => {
    const root = document.createElement('div')
    root.appendChild(document.createTextNode('do '))
    const chip = document.createElement('span')
    chip.setAttribute('contenteditable', 'false')
    chip.setAttribute('data-mention-type', 'skill')
    chip.setAttribute('data-skill-id', 'tdd')
    chip.textContent = '/TDD'
    root.appendChild(chip)

    expect(domToDoc(root)).toEqual({
      nodes: [
        { type: 'text', text: 'do ' },
        { type: 'skill', id: 'tdd', name: 'TDD' }
      ]
    })
  })

  it('collapses adjacent text nodes', () => {
    const root = document.createElement('div')
    root.appendChild(document.createTextNode('a'))
    root.appendChild(document.createTextNode('b'))
    expect(domToDoc(root)).toEqual({ nodes: [{ type: 'text', text: 'ab' }] })
  })

  it('preserves user-entered word-joiner characters', () => {
    const root = document.createElement('div')
    root.appendChild(document.createTextNode('a\u2060b'))
    expect(domToDoc(root)).toEqual({ nodes: [{ type: 'text', text: 'a\u2060b' }] })
  })

  it('returns the empty doc for an empty root', () => {
    const root = document.createElement('div')
    expect(domToDoc(root)).toEqual(emptyDoc)
  })
})

describe('applyDocToDom + domToDoc round-trip', () => {
  it('renders a doc into the root and reads it back unchanged', () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'run ' },
        { type: 'skill', id: 'tdd', name: 'TDD' },
        { type: 'text', text: ' then ' },
        { type: 'skill', id: 'review', name: 'Review' }
      ]
    }
    const root = document.createElement('div')
    applyDocToDom(root, doc)
    expect(domToDoc(root)).toEqual(doc)
  })

  it('renders a drawable caret host after a trailing pasted-text anchor without serializing it', () => {
    const doc: ComposerDoc = {
      nodes: [{ type: 'pasted-text', id: 'paste-1', text: 'private payload' }]
    }
    const root = document.createElement('div')

    applyDocToDom(root, doc)

    expect(root.lastChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(root.lastChild?.textContent).toBe('\u2060')
    expect(domToDoc(root)).toEqual(doc)

    root.lastChild!.textContent = 'after\u2060'
    expect(domToDoc(root)).toEqual({ nodes: [...doc.nodes, { type: 'text', text: 'after' }] })
  })

  it('clears prior content before rendering', () => {
    const root = document.createElement('div')
    root.textContent = 'stale'
    applyDocToDom(root, emptyDoc)
    expect(root.childNodes.length).toBe(0)
  })

  it('renders the chip with the expected attributes and label', () => {
    const root = document.createElement('div')
    applyDocToDom(root, { nodes: [{ type: 'skill', id: 'tdd', name: 'TDD' }] })
    const chip = root.querySelector('span[data-mention-type="skill"]')
    expect(chip?.getAttribute('data-skill-id')).toBe('tdd')
    expect(chip?.getAttribute('contenteditable')).toBe('false')
    expect(chip?.textContent).toBe('/TDD')
  })

  it('round-trips artifact chips, preserving path/source and filenames with spaces', () => {
    const doc: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'use ' },
        {
          type: 'artifact',
          id: 'u1',
          name: 'clinical trial03.pdf',
          path: '/u/clinical trial03.pdf',
          source: 'upload'
        },
        { type: 'text', text: ' plus ' },
        {
          type: 'artifact',
          id: 'a1',
          name: 'fig2_cooccurrence.png',
          path: '/p/fig2_cooccurrence.png',
          source: 'artifact',
          versionId: 'v9'
        }
      ]
    }
    const root = document.createElement('div')
    applyDocToDom(root, doc)
    expect(domToDoc(root)).toEqual(doc)
  })

  it('round-trips the stable managed-file identity of an artifact chip', () => {
    const doc: ComposerDoc = {
      nodes: [
        {
          type: 'artifact',
          id: 'artifact-row-1',
          sourceFileId: 'artifact-file-1',
          name: 'study.csv',
          path: 'artifact-version:project-1/session-1/artifact-file-1/version-2',
          source: 'artifact',
          mimeType: 'text/csv',
          versionId: 'version-2'
        }
      ]
    }
    const root = document.createElement('div')

    applyDocToDom(root, doc)

    expect(root.firstElementChild?.getAttribute('data-mention-source-file-id')).toBe(
      'artifact-file-1'
    )
    expect(domToDoc(root)).toEqual(doc)
  })

  it('round-trips a Session chip without Project or Frame identity', () => {
    const title = 'A very long prior Session title that stays available to the tooltip'
    const doc: ComposerDoc = {
      nodes: [
        {
          type: 'session',
          sessionId: 'session-2',
          title
        }
      ]
    }
    const root = document.createElement('div')

    applyDocToDom(root, doc)

    const chip = root.querySelector('[data-mention-type="session"]')
    expect(chip?.getAttribute('data-session-id')).toBe('session-2')
    expect(chip?.getAttribute('data-project-id')).toBeNull()
    expect(chip?.getAttribute('data-frame-id')).toBeNull()
    expect(chip?.getAttribute('title')).toBe(title)
    expect(chip?.className).toContain('truncate')
    expect(chip?.className).toContain('bg-accent')
    expect(chip?.className).toContain('text-accent-foreground')
    expect(domToDoc(root)).toEqual(doc)
  })

  it('round-trips a future linked-folder chip without an absolute path', () => {
    const doc: ComposerDoc = {
      nodes: [
        {
          type: 'artifact',
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/study.csv',
          mimeType: 'text/csv'
        }
      ]
    }
    const root = document.createElement('div')

    applyDocToDom(root, doc)

    const chip = root.querySelector('span[data-mention-source="linked-folder"]')
    expect(chip?.getAttribute('data-mention-path')).toBeNull()
    expect(chip?.getAttribute('data-mention-root-id')).toBe('root-1')
    expect(chip?.getAttribute('data-mention-relative-path')).toBe('data/study.csv')
    expect(domToDoc(root)).toEqual(doc)
  })

  it('renders a linked-folder chip as a dark-gray @ pill and still round-trips the plain name', () => {
    const doc: ComposerDoc = {
      nodes: [
        {
          type: 'artifact',
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/study.csv'
        }
      ]
    }
    const root = document.createElement('div')

    applyDocToDom(root, doc)

    const chip = root.querySelector('span[data-mention-source="linked-folder"]')
    expect(chip?.className).toContain('bg-path-chip')
    expect(chip?.className).toContain('text-path-chip-foreground')
    expect(chip?.className).not.toContain('bg-mention-chip')
    expect(chip?.textContent).toBe('@data/study.csv')
    expect(chip?.getAttribute('title')).toBe('@data/study.csv')
    // The `@` label must not leak into the doc: domToDoc recovers the name from the stored
    // filename attribute, not from the visible label.
    expect(chip?.getAttribute('data-mention-filename')).toBe('study.csv')
    expect(domToDoc(root)).toEqual(doc)
  })

  it('keeps the tail and extension visible in a long artifact chip without changing its stored name', () => {
    const name = 'very_long_experiment_analysis_result_2025.csv'
    const root = document.createElement('div')
    const doc: ComposerDoc = {
      nodes: [{ type: 'artifact', id: 'a1', name, path: `/p/${name}`, source: 'artifact' }]
    }

    applyDocToDom(root, doc)

    const chip = root.querySelector('span[data-mention-type="artifact"]')
    expect(chip?.getAttribute('data-mention-filename')).toBe(name)
    expect(chip?.querySelector('.truncate')?.textContent).toBe(
      '@very_long_experiment_analysis_result'
    )
    expect(chip?.textContent).toBe(`@very_long_experiment_analysis_result_2025.csv`)
    expect(domToDoc(root)).toEqual(doc)
  })

  it('renders an artifact chip with the green mention attributes and @ label', () => {
    const root = document.createElement('div')
    applyDocToDom(root, {
      nodes: [
        { type: 'artifact', id: 'a1', name: 'fig.png', path: '/p/fig.png', source: 'artifact' }
      ]
    })
    const chip = root.querySelector('span[data-mention-type="artifact"]')
    expect(chip?.getAttribute('data-mention-path')).toBe('/p/fig.png')
    expect(chip?.getAttribute('data-mention-source')).toBe('artifact')
    expect(chip?.getAttribute('data-mention-filename')).toBe('fig.png')
    expect(chip?.getAttribute('contenteditable')).toBe('false')
    expect(chip?.textContent).toBe('@fig.png')
  })
})

describe('docFromMessageParts', () => {
  it('restores text, skill, artifact, and Session chips from sent message parts', () => {
    const doc = docFromMessageParts([
      { type: 'text', text: 'Run ' },
      { type: 'skill', id: 'skill-forecast', name: 'forecast' },
      { type: 'text', text: ' on ' },
      {
        type: 'artifact',
        id: 'artifact-1',
        name: 'clinical trial03.pdf',
        path: '/p/clinical trial03.pdf',
        source: 'artifact',
        versionId: 'v2'
      },
      { type: 'text', text: ' using ' },
      { type: 'session', sessionId: 'session-2', title: 'Prior analysis' }
    ])

    expect(doc).toEqual({
      nodes: [
        { type: 'text', text: 'Run ' },
        { type: 'skill', id: 'skill-forecast', name: 'forecast' },
        { type: 'text', text: ' on ' },
        {
          type: 'artifact',
          id: 'artifact-1',
          name: 'clinical trial03.pdf',
          path: '/p/clinical trial03.pdf',
          source: 'artifact',
          versionId: 'v2'
        },
        { type: 'text', text: ' using ' },
        { type: 'session', sessionId: 'session-2', title: 'Prior analysis' }
      ]
    })
  })

  it('restores the stable managed-file identity for re-edit and send', () => {
    const doc = docFromMessageParts([
      {
        type: 'artifact',
        id: 'artifact-row-1',
        sourceFileId: 'artifact-file-1',
        name: 'study.csv',
        path: 'artifact-version:project-1/session-1/artifact-file-1/version-2',
        source: 'artifact',
        mimeType: 'text/csv',
        versionId: 'version-2'
      }
    ])

    expect(docToArtifactRefs(doc)).toEqual([
      {
        id: 'artifact-row-1',
        sourceFileId: 'artifact-file-1',
        name: 'study.csv',
        path: 'artifact-version:project-1/session-1/artifact-file-1/version-2',
        source: 'artifact',
        mimeType: 'text/csv',
        versionId: 'version-2'
      }
    ])
  })

  it('reproduces the sent message text when rendered back to plain text', () => {
    const doc = docFromMessageParts([
      { type: 'text', text: 'Run ' },
      { type: 'skill', id: 'skill-forecast', name: 'forecast' },
      { type: 'text', text: ' on ' },
      {
        type: 'artifact',
        id: 'artifact-1',
        name: 'clinical trial03.pdf',
        path: '/p/clinical trial03.pdf',
        source: 'artifact'
      }
    ])

    expect(docToText(doc)).toBe('Run /forecast on @clinical trial03.pdf')
  })

  it('returns the empty doc for an empty parts list', () => {
    expect(docFromMessageParts([])).toEqual(emptyDoc)
  })

  it('restores a linked-folder message part without introducing an absolute path', () => {
    expect(
      docFromMessageParts([
        {
          type: 'artifact',
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/study.csv'
        }
      ])
    ).toEqual({
      nodes: [
        {
          type: 'artifact',
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/study.csv',
          mimeType: undefined
        }
      ]
    })
  })
})
