/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Analysis follows public exports into this checkout's source, never installed dist files.
// This is not a compiler alias: production consumers still resolve the npm package.
export function localPackageSourcePaths(root = process.cwd(), io = { existsSync, readFileSync }) {
  const registry = JSON.parse(
    io.readFileSync(resolve(root, 'scripts/ci/package-test-boundaries.json'), 'utf8')
  )
  const paths = {}
  for (const entry of registry.packages) {
    const manifest = JSON.parse(io.readFileSync(resolve(root, entry.root, 'package.json'), 'utf8'))
    for (const [key, target] of Object.entries(manifest.exports)) {
      const runtime = typeof target === 'string' ? target : target.default
      const source = runtime.startsWith('./dist/')
        ? runtime.replace('./dist/', 'src/').replace(/\.js$/, '.ts')
        : runtime.replace(/^\.\//, '')
      const candidates = [source, source.replace(/\.ts$/, '.tsx')]
      const found = candidates.find((file) => io.existsSync(resolve(root, entry.root, file)))
      if (!found) throw new Error(`Missing public package source: ${manifest.name}${key}`)
      paths[manifest.name + (key === '.' ? '' : key.slice(1))] = [`${entry.root}/${found}`]
    }
  }
  return paths
}
