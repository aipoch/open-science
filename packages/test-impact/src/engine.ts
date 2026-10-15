import { readFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { cruise } from 'dependency-cruiser'
import type { StaticFileEvidence } from './types.js'

// Only the trusted parent launches this private worker with a generated request/configuration.
const request: { root: string; files: string[]; config: string } = JSON.parse(
  readFileSync(process.argv[2], 'utf8')
)
const { root, files, config } = request
const combined = new Map(
  files.map((path) => [
    path,
    { path, dependencies: new Set<string>(), unresolved: new Set<string>() }
  ])
)
const normalize = (path: string): string =>
  (isAbsolute(path) ? relative(root, path) : path).replaceAll('\\', '/')
for (const declarationFirst of [false, true]) {
  const { output, exitCode } = await cruise(
    files,
    {
      baseDir: root,
      outputType: 'json',
      tsPreCompilationDeps: true,
      skipAnalysisNotInRules: true,
      tsConfig: { fileName: config },
      exoticRequireStrings: [
        'vi.mock',
        'vi.doMock',
        'vi.importActual',
        'jest.mock',
        'require.resolve'
      ],
      doNotFollow: { path: '(^|/)node_modules/|^\\.\\./' },
      enhancedResolveOptions: {
        exportsFields: ['exports'],
        conditionNames: [
          ...(declarationFirst ? ['types'] : []),
          'import',
          'require',
          'node',
          'default'
        ]
      }
    },
    {
      bustTheCache: true,
      modules: [],
      restrictions: [root],
      ...(declarationFirst
        ? {
            extensions: [
              '.ts',
              '.tsx',
              '.d.ts',
              '.mts',
              '.d.mts',
              '.cts',
              '.d.cts',
              '.js',
              '.mjs',
              '.cjs',
              '.json'
            ]
          }
        : {}),
      extensionAlias: {
        '.js': declarationFirst ? ['.ts', '.tsx', '.d.ts', '.js'] : ['.ts', '.tsx', '.js'],
        '.mjs': declarationFirst ? ['.mts', '.d.mts', '.mjs'] : ['.mts', '.mjs'],
        '.cjs': declarationFirst ? ['.cts', '.d.cts', '.cjs'] : ['.cts', '.cjs']
      }
    }
  )
  if (exitCode !== 0) throw new Error(`Dependency analysis failed: ${exitCode}`)
  const result =
    typeof output === 'string' ? (JSON.parse(output) as Exclude<typeof output, string>) : output
  const modules = new Map(result.modules.map((module) => [normalize(module.source), module]))
  for (const [file, evidence] of combined) {
    const module = modules.get(file)
    if (!module) throw new Error(`Analyzer omitted snapshot input: ${file}`)
    for (const dependency of module.dependencies) {
      if (dependency.couldNotResolve) evidence.unresolved.add(dependency.module)
      else if (!dependency.coreModule) evidence.dependencies.add(normalize(dependency.resolved))
    }
  }
}
const result: StaticFileEvidence[] = [...combined.values()].map((row) => ({
  path: row.path,
  dependencies: [...row.dependencies].sort(),
  unresolved: [...row.unresolved].sort()
}))
process.stdout.write(JSON.stringify(result))
