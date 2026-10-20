import * as browserApi from './index'
import * as nodeApi from './node'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import ts from 'typescript'
import { expect, it } from 'vitest'

const source = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(source, '../package.json'), 'utf8'))
const productionFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory()
      ? productionFiles(path)
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [path]
        : []
  })

it('keeps common diagnostics independent of business storage and third-party runtime dependencies', () => {
  expect(manifest.dependencies ?? {}).toEqual({})
  expect(readdirSync(source)).not.toContain('session')
  for (const file of productionFiles(source)) {
    const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles
    for (const { fileName: spec } of imports) {
      expect(spec, file).not.toMatch(
        /(?:sqlite|prisma|session-diagnostics|notebook|session-persistence)/
      )
      if (spec.startsWith('.')) {
        const target = relative(source, resolve(dirname(file), spec))
        expect(isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`), file).toBe(
          false
        )
      } else if (!builtinModules.includes(spec) && !spec.startsWith('node:')) {
        expect(Object.keys(manifest.dependencies ?? {}), `${file}: ${spec}`).toContain(spec)
      }
    }
  }
})

it('keeps the browser entry free of Node imports and the common Node entry free of Session code', () => {
  const walk = (entry: string, browser: boolean, seen = new Set<string>()): void => {
    if (seen.has(entry)) return
    seen.add(entry)
    for (const { fileName: spec } of ts.preProcessFile(readFileSync(entry, 'utf8'), true, true)
      .importedFiles) {
      expect(spec, entry).not.toContain('session/')
      if (browser) expect(spec.startsWith('.'), `${entry}: ${spec}`).toBe(true)
      if (spec.startsWith('.')) walk(resolve(dirname(entry), `${spec}.ts`), browser, seen)
    }
  }
  walk(resolve(source, 'index.ts'), true)
  walk(resolve(source, 'node.ts'), false)
  expect(Object.keys(manifest.exports)).toEqual(['.', './node'])
})

it('exposes only supported consumer operations, not private collectors or formatters', () => {
  expect(Object.keys(browserApi).sort()).toEqual(
    [
      'REDACTED_MARKER',
      'isSensitiveDiagnosticKey',
      'isSensitiveUrlQueryKey',
      'redactSensitiveText'
    ].sort()
  )
  expect(Object.keys(nodeApi).sort()).toEqual(
    [
      'createLogger',
      'diagnosticErrorFields',
      'errorLogFields',
      'flushLogs',
      'getLogFilePath',
      'getLogFileStatus',
      'initLogger',
      'runWithDiagnosticCorrelation',
      'writeFatalLogSync',
      'startDiagnosticOperation',
      'flushDiagnosticsWithTimeout',
      'timedStartupStorageProbe',
      'boundedRuntimeDiagnostic',
      'redactRuntimeDiagnosticText',
      'redactRuntimeDiagnosticValue',
      'runtimeChildProcessErrorFields',
      'buildStartupDiagnostics'
    ].sort()
  )
})
