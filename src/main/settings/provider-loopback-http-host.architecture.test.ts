import { readFileSync, readdirSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(__dirname, '../../..')
const hostPath = resolve(__dirname, 'provider-loopback-http-host.ts')
const adapterPaths = [
  resolve(__dirname, 'anthropic-provider-bridge.ts'),
  resolve(__dirname, 'native-responses-compatibility.ts'),
  resolve(__dirname, 'openai-provider-bridge.ts'),
  resolve(__dirname, 'responses-bridge.ts'),
  resolve(__dirname, 'xai-oauth-provider-bridge.ts')
]
const readSource = (path: string): string => readFileSync(path, 'utf8')
const portablePath = (path: string): string => relative(projectRoot, path).replaceAll('\\', '/')

const productionSources = (): string[] => {
  const sources: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        ['.ts', '.tsx'].includes(extname(path)) &&
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
      ) {
        sources.push(path)
      }
    }
  }
  visit(resolve(projectRoot, 'src'))
  visit(resolve(projectRoot, 'packages'))
  return sources
}

describe('Provider loopback HTTP ownership', () => {
  it('keeps the fixed lifecycle and security envelope in one bounded module', () => {
    const host = readSource(hostPath)
    expect(host.split(/\r?\n/).length - Number(host.endsWith('\n'))).toBeLessThanOrEqual(300)
    expect(host).toContain('64 * 1024 * 1024')
    expect(host).toContain("randomBytes(24).toString('hex')")
    expect(host).toContain("server.listen(0, '127.0.0.1'")
    expect(host).toContain('server.closeAllConnections()')

    for (const path of adapterPaths) {
      const adapter = readSource(path)
      expect(adapter).not.toContain('createServer(')
      expect(adapter).not.toContain('closeAllConnections()')
      expect(adapter).not.toContain("randomBytes(24).toString('hex')")
      expect(adapter).toContain('new ProviderLoopbackHttpHost')
    }
  })

  it('keeps the internal host seam limited to the declared Provider adapters', () => {
    expect(
      productionSources()
        .filter((path) => path !== hostPath)
        .filter((path) => readSource(path).includes('provider-loopback-http-host'))
        .map(portablePath)
        .sort()
    ).toEqual(adapterPaths.map(portablePath).sort())
  })
})
