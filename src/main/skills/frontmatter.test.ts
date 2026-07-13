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
