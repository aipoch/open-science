// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  applyDocToDom,
  docArtifactCount,
  docFromText,
  docIsEmpty,
  docToArtifactRefs,
  docToSkillIds,
  docToText,
  domToDoc,
  emptyDoc,
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
        { type: 'artifact', id: 'a1', name: 'fig1.png', path: '/p/fig1.png', source: 'artifact' },
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

  it('returns an empty string for the empty doc', () => {
    expect(docToText(emptyDoc)).toBe('')
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
        { type: 'artifact', id: 'a1', name: 'fig1.png', path: '/p/fig1.png', source: 'artifact' },
        { type: 'text', text: ' and ' },
        { type: 'artifact', id: 'u1', name: 'notes.md', path: '/u/notes.md', source: 'upload' },
        // Same path as the first, mentioned again with a different chip id — collapsed.
        { type: 'artifact', id: 'a1b', name: 'fig1.png', path: '/p/fig1.png', source: 'artifact' }
      ]
    }
    expect(docToArtifactRefs(doc)).toEqual([
      { id: 'a1', name: 'fig1.png', path: '/p/fig1.png', source: 'artifact', versionId: undefined },
      { id: 'u1', name: 'notes.md', path: '/u/notes.md', source: 'upload', versionId: undefined }
    ])
  })

  it('returns an empty array when there are no artifact nodes', () => {
    expect(docToArtifactRefs(docFromText('plain text'))).toEqual([])
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

  it('renders an artifact chip with the green mention attributes and @ label', () => {
    const root = document.createElement('div')
    applyDocToDom(root, {
      nodes: [{ type: 'artifact', id: 'a1', name: 'fig.png', path: '/p/fig.png', source: 'artifact' }]
    })
    const chip = root.querySelector('span[data-mention-type="artifact"]')
    expect(chip?.getAttribute('data-mention-path')).toBe('/p/fig.png')
    expect(chip?.getAttribute('data-mention-source')).toBe('artifact')
    expect(chip?.getAttribute('data-mention-filename')).toBe('fig.png')
    expect(chip?.getAttribute('contenteditable')).toBe('false')
    expect(chip?.textContent).toBe('@fig.png')
  })
})
