import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error The repository's JavaScript evidence reader has no declaration file.
import { createConsumerDependencyReader } from '../../../scripts/ci/consumer-retirement.mjs'
// @ts-expect-error The repository's JavaScript layer classifier has no declaration file.
import { dependencyLayer } from '../../../scripts/ci/module-relationships.mjs'

it('keeps annotation storage and native parsing behind the supported entries', () => {
  const root = resolve(import.meta.dirname, '../../..')
  const files = new Set<string>(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8'
    })
      .split('\0')
      .filter((path) => path && existsSync(resolve(root, path)))
  )
  const contents = new Map<string, string>()
  const read = (path: string): string | undefined => {
    if (!files.has(path)) return undefined
    if (!contents.has(path)) contents.set(path, readFileSync(resolve(root, path), 'utf8'))
    return contents.get(path)
  }
  const reader = createConsumerDependencyReader({ files, read }, [])
  const privateFiles = new Set([
    'src/main/pdf-annotations/document-store.ts',
    'src/main/pdf-annotations/sharing.ts'
  ])
  const nativeParserCore = 'src/main/pdf-annotations/native-import-core.ts'
  const nativeParserConsumers = new Set([
    'src/main/pdf-annotations/native-import.ts',
    'src/main/pdf-annotations/native-import-worker-entry.ts'
  ])
  const violations: string[] = []
  for (const source of files) {
    if (!/^(src|packages)\/.*\.[cm]?[jt]sx?$/.test(source) || dependencyLayer(source) === 'test')
      continue
    for (const target of reader.dependencies(source).paths) {
      if (
        (privateFiles.has(target) && !source.startsWith('src/main/pdf-annotations/')) ||
        (target === nativeParserCore && !nativeParserConsumers.has(source))
      )
        violations.push(`${source} -> ${target}`)
    }
  }
  expect(violations.sort()).toEqual([])
  // Whole-repository TypeScript resolution needs the same CI budget as consumer coverage scans.
}, 120_000)
