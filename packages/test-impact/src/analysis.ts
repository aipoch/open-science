import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfiguration, snapshotSourcePaths } from './configuration.js'
import { withSourceSnapshot } from './snapshot.js'
import type { AnalyzeRevisionOptions, StaticFileEvidence, StaticImpactReport } from './types.js'

function dependencyDirectory(specifier: string): string {
  let directory = dirname(realpathSync(fileURLToPath(import.meta.resolve(specifier))))
  while (basename(directory) !== 'node_modules') {
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error(`Cannot locate installed tool dependency: ${specifier}`)
    directory = parent
  }
  return directory
}

export async function analyzeRevision(
  options: AnalyzeRevisionOptions
): Promise<StaticImpactReport> {
  const configuration = parseConfiguration(options.configuration ?? {})
  return withSourceSnapshot(options.repository, options.revision, async (snapshot) => {
    const files = [...snapshot.files].filter((file) => /\.[cm]?[jt]sx?$/.test(file)).sort()
    const config = join(snapshot.parent, 'tsconfig.json')
    const request = join(snapshot.parent, 'request.json')
    const sourcePaths = snapshotSourcePaths(snapshot, configuration)
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          baseUrl: snapshot.root,
          paths: sourcePaths
        }
      })
    )
    writeFileSync(request, JSON.stringify({ root: snapshot.root, files, config }))
    const engine = fileURLToPath(new URL('./engine.js', import.meta.url))
    const permissions = [
      ...new Set([
        snapshot.parent,
        dirname(dirname(engine)),
        dependencyDirectory('dependency-cruiser'),
        dependencyDirectory('typescript')
      ])
    ]
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    // Preserve Windows executable lookup while excluding NODE_OPTIONS, NODE_PATH and caller loaders.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    const result: unknown = files.length
      ? JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--permission',
              ...permissions.map((directory) => `--allow-fs-read=${directory}`),
              engine,
              request
            ],
            {
              cwd: snapshot.root,
              env,
              encoding: 'utf8',
              timeout: 180000,
              maxBuffer: 64 * 1024 * 1024
            }
          )
        )
      : []
    if (!Array.isArray(result) || result.length !== files.length)
      throw new Error('Invalid analyzer result')
    const evidence: StaticFileEvidence[] = result.map((row, index) => {
      if (
        !row ||
        row.path !== files[index] ||
        !Array.isArray(row.dependencies) ||
        !Array.isArray(row.unresolved) ||
        row.dependencies.some(
          (path: unknown) => typeof path !== 'string' || !snapshot.files.has(path)
        ) ||
        row.unresolved.some((value: unknown) => typeof value !== 'string')
      )
        throw new Error('Analyzer returned incomplete or out-of-snapshot evidence')
      return { path: row.path, dependencies: row.dependencies, unresolved: row.unresolved }
    })
    const engineManifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    )
    return {
      schemaVersion: 1,
      purpose: 'diagnostic',
      canPruneTests: false,
      revision: snapshot.revision,
      engine: {
        name: 'dependency-cruiser',
        version: engineManifest.dependencies['dependency-cruiser']
      },
      sourcePaths,
      limitations: [
        'Computed and escaped loaders are not completely enumerated; absence of an edge is not proof of independence.',
        'Installed external dependencies are not resolved; unresolved references are retained.',
        'Module ownership, manual consumers and runtime contracts are not applied by this static diagnostic.'
      ],
      files: evidence
    }
  })
}
