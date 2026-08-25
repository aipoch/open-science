import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

export const PRODUCTION_SOURCE_ROOTS = ['src', 'packages'] as const

type ProductionSourceIndex = {
  paths: readonly string[]
  contents: ReadonlyMap<string, string>
}

const indexByRoot = new Map<string, ProductionSourceIndex>()

const isProductionSource = (name: string): boolean =>
  ['.ts', '.tsx'].includes(extname(name)) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(name)

const walkProductionSources = (directory: string, paths: string[]): void => {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) walkProductionSources(path, paths)
    else if (isProductionSource(entry.name)) paths.push(path)
  }
}

export const resetProductionSourceIndexForTests = (): void => {
  indexByRoot.clear()
}

export const productionSourceIndex = (
  projectRoot: string,
  roots: readonly string[] = PRODUCTION_SOURCE_ROOTS
): ProductionSourceIndex => {
  const key = `${projectRoot}\0${roots.join('\0')}`
  const cached = indexByRoot.get(key)
  if (cached) return cached

  const paths: string[] = []
  for (const root of roots) walkProductionSources(resolve(projectRoot, root), paths)
  paths.sort()
  const contents = new Map(paths.map((path) => [path, readFileSync(path, 'utf8')]))
  const index = { paths: Object.freeze(paths), contents }
  indexByRoot.set(key, index)
  return index
}

export const listProductionSources = (
  projectRoot: string,
  roots: readonly string[] = PRODUCTION_SOURCE_ROOTS
): readonly string[] => productionSourceIndex(projectRoot, roots).paths

export const readProductionSource = (path: string, projectRoot: string): string => {
  const cached = productionSourceIndex(projectRoot).contents.get(path)
  return cached ?? readFileSync(path, 'utf8')
}
