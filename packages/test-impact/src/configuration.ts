import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertPortablePaths } from './paths.js'
import type { AnalysisConfiguration } from './types.js'
import type { SourceSnapshot } from './snapshot.js'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

export function parseConfiguration(value: unknown): AnalysisConfiguration {
  const input = object(value)
  if (Object.keys(input).some((key) => !['packageRegistry', 'sourcePaths'].includes(key)))
    throw new Error('Unknown analysis configuration field')
  const configuration: AnalysisConfiguration = {}
  if (input.packageRegistry !== undefined) {
    if (typeof input.packageRegistry !== 'string') throw new Error('Invalid package registry path')
    assertPortablePaths([input.packageRegistry])
    configuration.packageRegistry = input.packageRegistry
  }
  if (input.sourcePaths !== undefined) {
    const paths = object(input.sourcePaths)
    const validated: Record<string, string[]> = Object.create(null)
    for (const [key, targets] of Object.entries(paths)) {
      if (
        !key ||
        key.startsWith('.') ||
        key.includes('\\') ||
        key.split('*').length > 2 ||
        !Array.isArray(targets) ||
        !targets.length ||
        targets.some((target) => typeof target !== 'string' || target.split('*').length > 2)
      )
        throw new Error(`Invalid source alias: ${key}`)
      for (const target of targets) assertPortablePaths([target.replaceAll('*', 'wildcard')])
      validated[key] = [...targets]
    }
    configuration.sourcePaths = validated
  }
  return configuration
}

export function snapshotSourcePaths(
  snapshot: SourceSnapshot,
  configuration: AnalysisConfiguration
): Record<string, string[]> {
  const readJson = (file: string): Record<string, unknown> => {
    assertPortablePaths([file])
    if (!snapshot.files.has(file)) throw new Error(`Missing snapshot configuration: ${file}`)
    return object(JSON.parse(readFileSync(join(snapshot.root, file), 'utf8')))
  }
  const paths: Record<string, string[]> = Object.create(null)
  if (configuration.packageRegistry) {
    const registry = readJson(configuration.packageRegistry)
    if (!Array.isArray(registry.packages)) throw new Error('Invalid package registry')
    for (const raw of registry.packages) {
      const entry = object(raw)
      if (typeof entry.root !== 'string') throw new Error('Invalid package root')
      assertPortablePaths([entry.root])
      const manifest = readJson(`${entry.root}/package.json`)
      if (
        typeof manifest.name !== 'string' ||
        !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)
      )
        throw new Error('Invalid package name')
      for (const [key, target] of Object.entries(object(manifest.exports))) {
        if (key !== '.') {
          if (!key.startsWith('./')) throw new Error(`Unsupported public export: ${key}`)
          assertPortablePaths([key.slice(2)])
        }
        const runtime = typeof target === 'string' ? target : object(target).default
        if (typeof runtime !== 'string' || !runtime.startsWith('./'))
          throw new Error(`Unsupported export target: ${manifest.name}${key}`)
        assertPortablePaths([runtime.slice(2)])
        const source = runtime.startsWith('./dist/')
          ? runtime.replace('./dist/', 'src/').replace(/\.js$/, '.ts')
          : runtime.slice(2)
        const found = [source, source.replace(/\.ts$/, '.tsx')].find((file) =>
          snapshot.files.has(`${entry.root}/${file}`)
        )
        if (!found) throw new Error(`Missing public package source: ${manifest.name}${key}`)
        const specifier = manifest.name + (key === '.' ? '' : key.slice(1))
        if (Object.hasOwn(paths, specifier))
          throw new Error(`Duplicate public package source: ${specifier}`)
        paths[specifier] = [`${entry.root}/${found}`]
      }
    }
  }
  return { ...paths, ...configuration.sourcePaths }
}
