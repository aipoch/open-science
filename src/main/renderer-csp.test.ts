import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(__dirname, '../..')

const readRendererCspDirectives = (): Map<string, string[]> => {
  const html = readFileSync(resolve(projectRoot, 'src/renderer/index.html'), 'utf8')
  const content = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
  if (!content) throw new Error('Renderer Content-Security-Policy meta tag is missing')

  return new Map(
    content.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/)
      return [name, values]
    })
  )
}

describe('renderer content security policy', () => {
  it('allows the renderer to fetch managed preview resources', () => {
    const directives = readRendererCspDirectives()

    expect(directives.get('connect-src')).toContain('open-science-preview:')
  })

  it('allows HTTPS only as a remote iframe source without widening renderer fetch access', () => {
    const directives = readRendererCspDirectives()

    expect(directives.get('frame-src')).toContain('https:')
    expect(directives.get('frame-src')).not.toContain('http:')
    expect(directives.get('connect-src')).not.toContain('https:')
  })
})
