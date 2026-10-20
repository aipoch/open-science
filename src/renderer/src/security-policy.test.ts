import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('renderer content security policy', () => {
  it('permits only self-hosted and Blob workers', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8')

    expect(html).toContain("worker-src 'self' blob:")
    expect(html).toContain("font-src 'self' data: blob:")
  })
  it('allows the shared PDF Blob worker in Remote Web without widening script sources', () => {
    const html = readFileSync(resolve(__dirname, '../web/index.html'), 'utf8')
    const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
    expect(policy).toBeDefined()
    const directives = new Map(
      policy!.split(';').map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/)
        return [name, sources]
      })
    )
    const workerSources =
      directives.get('worker-src') ??
      directives.get('child-src') ??
      directives.get('script-src') ??
      directives.get('default-src')

    expect(workerSources).toContain('blob:')
    expect(directives.get('script-src')).toEqual(["'self'"])
  })
})
