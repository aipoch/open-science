import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'
import citations from '../../packages/literature-citations/vitest.config'
import discovery from '../../packages/literature-discovery/vitest.config'
import library from '../../packages/literature-library/vitest.config'
// @ts-expect-error Native JavaScript experiment definitions are checked by the runner tests.
import { substitutions, testFiles } from '../../scripts/collector-ablation.mjs'

const variant = process.env.COLLECTOR_ABLATION ?? 'baseline'
if (variant !== 'baseline' && !substitutions[variant])
  throw new Error(`Unknown collector ablation: ${variant}`)

// Experiments instrument the source behind public package exports. This is not an
// installed-package verification claim; ordinary independent package configs stay unchanged.
const packageConfigs = [
  ['packages/literature-citations', citations],
  ['packages/literature-discovery', discovery],
  ['packages/literature-library', library]
] as const
const aliases = packageConfigs.flatMap(([root]) => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports).map(([entry, raw]) => {
    const target = (raw as { default: string }).default
    if (!target.startsWith('./dist/') || !target.endsWith('.js'))
      throw new Error(`Unsupported experiment package entry: ${root}: ${entry}`)
    const name = manifest.name + (entry === '.' ? '' : entry.slice(1))
    const source = resolve(root, target.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
    readFileSync(source)
    return {
      find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      replacement: source
    }
  })
})
const mutationPlugin = {
  name: 'collector-ablation',
  enforce: 'pre' as const,
  transform(code: string, id: string): string | undefined {
    const edits =
      substitutions[variant]?.filter(({ file }: { file: string }) =>
        id.split('?')[0].endsWith('/' + file)
      ) ?? []
    if (!edits.length) return undefined
    for (const { from, to } of edits) {
      if (code.split(from).length !== 2) throw new Error(`Ablation anchor drift: ${variant}: ${id}`)
      code = code.replace(from, to)
    }
    return code
  }
}
const hostTest = { ...base.test }
delete hostTest.projects
export default defineConfig({
  test: {
    maxWorkers: 1,
    projects: [
      ...packageConfigs.map(([root, config]) => ({
        ...config,
        plugins: [mutationPlugin],
        resolve: { alias: aliases },
        test: {
          ...config.test,
          include: testFiles
            .filter((file: string) => file.startsWith(root + '/'))
            .map((file: string) => file.slice(root.length + 1)),
          maxWorkers: 1
        }
      })),
      {
        ...base,
        plugins: [mutationPlugin],
        resolve: {
          ...base.resolve,
          alias: [
            ...aliases,
            ...Object.entries(base.resolve?.alias ?? {}).map(([find, replacement]) => ({
              find,
              replacement
            }))
          ]
        },
        test: {
          ...hostTest,
          name: 'collector-host',
          include: testFiles.filter((file: string) => !file.startsWith('packages/')),
          maxWorkers: 1
        }
      }
    ]
  }
})
