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
    // The reader is lossless: a folded block scalar keeps its single trailing newline (YAML clip).
    expect(fields.description).toBe(
      'Predict protein structure for monomers and multimers with AlphaFold2 via the ColabFold runner.\n'
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
    // Literal block scalar keeps its trailing newline (clip); the reader no longer trims.
    expect(fields.description).toBe('line one\nline two\n')
    expect(fields.name).toBe('demo')
  })

  it('parses a bundle authored with CRLF line endings', () => {
    const raw = [
      '---',
      'name: demo',
      'description: Does a thing.',
      'license: MIT',
      '---',
      '',
      '# Demo'
    ].join('\r\n')
    const { fields, body } = parseFrontmatter(raw)
    expect(fields).toMatchObject({
      name: 'demo',
      description: 'Does a thing.',
      license: 'MIT'
    })
    expect(body.startsWith('# Demo')).toBe(true)
  })

  it('joins a CRLF folded block scalar (>) into a single spaced line', () => {
    const raw = [
      '---',
      'name: demo',
      'description: >',
      '  first line',
      '  second line',
      '---',
      '',
      '# Demo'
    ].join('\r\n')
    const { fields } = parseFrontmatter(raw)
    expect(fields.description).toBe('first line second line')
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
    expect(fields.description).toBe('folded text\n')
    expect(fields['display-name']).toBeUndefined()
  })

  it('coerces bare date/number/boolean scalars to strings (no Date, no drop)', () => {
    const raw = [
      '---',
      'name: demo',
      'updated: 2026-07-17',
      'version: 2',
      'beta: true',
      '---',
      'body'
    ].join('\n')
    const { fields } = parseFrontmatter(raw)
    // The FAILSAFE schema keeps these as verbatim strings; a Date would be dropped as a non-scalar.
    expect(fields.updated).toBe('2026-07-17')
    expect(fields.version).toBe('2')
    expect(fields.beta).toBe('true')
  })

  it('flattens a YAML list to a comma-separated string and drops nested maps', () => {
    const raw = [
      '---',
      'name: demo',
      'requirements: [gpu, compute]', // flow sequence
      'tags:', // block sequence
      '  - alpha',
      '  - beta',
      'meta:', // nested map is dropped by the flat reader
      '  key: value',
      '---',
      'body'
    ].join('\n')
    const { fields } = parseFrontmatter(raw)
    expect(fields.requirements).toBe('gpu, compute')
    expect(fields.tags).toBe('alpha, beta')
    expect(fields.meta).toBeUndefined()
  })

  it('tolerates malformed frontmatter, returning empty fields and the body', () => {
    // Unbalanced flow map is invalid YAML; the reader must not throw.
    const raw = ['---', 'name: [oops', 'description: broken', '---', '# Body'].join('\n')
    const { fields, body } = parseFrontmatter(raw)
    expect(fields).toEqual({})
    expect(body.startsWith('# Body')).toBe(true)
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
