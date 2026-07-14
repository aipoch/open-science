import { describe, expect, it } from 'vitest'

import { parseFrontmatter, splitFrontmatter } from './frontmatter'

describe('parseFrontmatter', () => {
  it('parses every scalar field into a lowercased map and strips the block', () => {
    const raw = [
      '---',
      'name: demo',
      'description: Does a thing.',
      'License: MIT',
      'author: AIPOCH',
      '---',
      '',
      '# Demo'
    ].join('\n')
    const { fields, body } = parseFrontmatter(raw)
    expect(fields).toMatchObject({
      name: 'demo',
      description: 'Does a thing.',
      license: 'MIT',
      author: 'AIPOCH'
    })
    expect(body.startsWith('# Demo')).toBe(true)
  })

  it('returns empty fields and full text when no frontmatter is present', () => {
    const { fields, body } = parseFrontmatter('# Just a body')
    expect(fields).toEqual({})
    expect(body).toBe('# Just a body')
  })

  it('joins a folded block scalar (>) into a single spaced line', () => {
    const raw = [
      '---',
      'name: alphafold2',
      'description: >',
      '  Predict protein structure for monomers and multimers',
      '  with AlphaFold2 via the ColabFold runner.',
      'license: Apache-2.0',
      '---',
      '',
      '# AlphaFold2'
    ].join('\n')
    const { fields, body } = parseFrontmatter(raw)
    expect(fields.description).toBe(
      'Predict protein structure for monomers and multimers with AlphaFold2 via the ColabFold runner.'
    )
    expect(fields.license).toBe('Apache-2.0')
    expect(body.startsWith('# AlphaFold2')).toBe(true)
  })

  it('preserves newlines for a literal block scalar (|) and stops at the next top-level key', () => {
    const raw = [
      '---',
      'description: |',
      '  line one',
      '  line two',
      'name: demo',
      '---',
      'body'
    ].join('\n')
    const { fields } = parseFrontmatter(raw)
    expect(fields.description).toBe('line one\nline two')
    expect(fields.name).toBe('demo')
  })

  it('ignores nested (indented) keys after a block scalar, as a flat reader', () => {
    const raw = [
      '---',
      'name: demo',
      'description: >',
      '  folded text',
      'metadata:',
      '  display-name: Demo',
      '---',
      'body'
    ].join('\n')
    const { fields } = parseFrontmatter(raw)
    expect(fields.description).toBe('folded text')
    expect(fields['display-name']).toBeUndefined()
  })
})

describe('splitFrontmatter', () => {
  it('extracts description and strips the frontmatter block from the body', () => {
    const raw = [
      '---',
      'name: demo',
      'description: Does a thing.',
      'license: MIT',
      '---',
      '',
      '# Demo',
      'Body text.'
    ].join('\n')
    const result = splitFrontmatter(raw)
    expect(result.description).toBe('Does a thing.')
    expect(result.body.startsWith('# Demo')).toBe(true)
    expect(result.body).not.toContain('name: demo')
  })

  it('returns empty description and full text when no frontmatter is present', () => {
    const result = splitFrontmatter('# Just a body')
    expect(result.description).toBe('')
    expect(result.body).toBe('# Just a body')
  })
})
