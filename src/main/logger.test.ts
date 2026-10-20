import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger, initLogger, flushLogs } from '@aipoch/diagnostics/node'
import {
  ApplicationModuleDisposalTimeoutError,
  shutdownApplicationSurfaces
} from './application-runtime'

let logDir: string | undefined
afterEach(async () => {
  await flushLogs()
  if (logDir) await rm(logDir, { recursive: true, force: true })
  logDir = undefined
})

const productionTypeScriptFiles = (directory: string, includeTests = false): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return productionTypeScriptFiles(path, includeTests)
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return []
    if (!includeTests && /\.(?:test|integration|certification)\.tsx?$/.test(entry.name)) return []
    return [path]
  })

const hasConsoleAccess = (source: string): boolean => {
  if (!source.includes('console')) return false
  const root = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, false)
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = node.expression
      if (
        (ts.isIdentifier(receiver) && receiver.text === 'console') ||
        (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'console')
      )
        found = true
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

describe('host logging boundary', () => {
  it('keeps all host production and test imports on public diagnostic entries', () => {
    const packageRoot = resolve(__dirname, '../../packages/diagnostics')
    const publicEntries = ['@aipoch/diagnostics', '@aipoch/diagnostics/node']
    const violations: string[] = []
    for (const file of productionTypeScriptFiles(resolve(__dirname, '..'), true)) {
      for (const { fileName: spec } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
        .importedFiles) {
        const target = resolve(dirname(file), spec)
        if (
          (spec.startsWith('@aipoch/diagnostics/') && !publicEntries.includes(spec)) ||
          target === packageRoot ||
          target.startsWith(packageRoot + sep)
        )
          violations.push(`${file}: ${spec}`)
      }
    }
    expect(violations).toEqual([])
  })

  it.each([
    ['console.log("message")', true],
    ['console["error"]("message")', true],
    ['console /* comment */ .warn("message")', true],
    ['globalThis.console.log("message")', true],
    ['const method = "console.log"', false],
    ['// console.log("message")', false],
    ['const message = `console.log`', false],
    ['const message = `${console.log("message")}`', true]
  ])('distinguishes console access from source data: %s', (source, expected) => {
    expect(hasConsoleAccess(source)).toBe(expected)
  })

  it('keeps the central logger as the only production console adapter', () => {
    const directConsoleCalls = productionTypeScriptFiles(__dirname).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return hasConsoleAccess(source) ? [path.slice(__dirname.length + 1)] : []
    })

    expect(directConsoleCalls).toEqual([])
  })
})

describe('logger: application shutdown diagnostics', () => {
  it('persists fixed surface outcomes without aggregate error details', async () => {
    logDir = await mkdtemp(join(tmpdir(), 'os-logger-shutdown-'))
    initLogger({ logDir, fileName: 'main.log', mirrorToConsole: false })
    const log = createLogger('shutdown')

    await shutdownApplicationSurfaces({
      disposeApplicationRuntime: () =>
        Promise.reject(
          new AggregateError([
            new ApplicationModuleDisposalTimeoutError('mcp-client-manager', 1000),
            new Error('compute poller stop failed at /private/project')
          ])
        ),
      shutdownRemoteAccess: () => undefined,
      disposeWebController: () => undefined,
      disposeIpcHandlers: () => undefined,
      log
    })
    await flushLogs()

    const records = (await readFile(join(logDir, 'main.log'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            msg: string
            data: { surface: string; result: string; errorCategory: string }
          }
      )

    expect(records).toEqual([
      expect.objectContaining({
        msg: 'application surface shutdown failed',
        data: {
          surface: 'application-runtime',
          result: 'timeout',
          errorCategory: 'object'
        }
      }),
      expect.objectContaining({
        msg: 'application surface shutdown failed',
        data: {
          surface: 'application-runtime',
          result: 'failed',
          errorCategory: 'error'
        }
      })
    ])
    const json = JSON.stringify(records)
    expect(json).not.toContain('mcp-client-manager')
    expect(json).not.toContain('1000ms')
    expect(json).not.toContain('compute poller stop failed')
    expect(json).not.toContain('/private/project')
  })
})
