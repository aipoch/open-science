import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseEntries,
  partitionFiles,
  prepareExtraction: prepare
} = require('../build/prepare-windows-extraction.cjs')
let sevenZip: string
beforeAll(async () => {
  sevenZip = await require('app-builder-lib/out/toolsets/7zip').getPath7za()
})
function prepareExtraction(archive: string, destination: string): unknown {
  return prepare(archive, destination, sevenZip)
}
const helper = resolve('build/windows-extract-payload.ps1')
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe'
)

function fixture(): string {
  const parent = resolve('tmp/extraction-partition-tests')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, 'case-'))
}

function payload(): { root: string; archive: string; lists: string; output: string } {
  const root = fixture(),
    input = join(root, 'input'),
    archive = join(root, 'payload.7z')
  for (const [name, text] of [
    ['app.exe', 'shell'],
    ['resources/backend/node_modules/a/index.js', 'first'],
    ['resources/backend/node_modules/@scope/b/中文 文件.txt', 'second']
  ]) {
    mkdirSync(join(input, name, '..'), { recursive: true })
    writeFileSync(join(input, name), text)
  }
  mkdirSync(join(input, 'empty directory'), { recursive: true })
  execFileSync(sevenZip, ['a', '-t7z', '-ms=off', archive, '.'], {
    cwd: input,
    windowsHide: true,
    stdio: 'pipe'
  })
  const lists = join(root, 'lists')
  prepareExtraction(archive, lists)
  return { root, archive, lists, output: join(root, 'installed 中文 with spaces') }
}

function extract(
  f: ReturnType<typeof payload>,
  extractor = sevenZip
): ReturnType<typeof spawnSync> {
  return spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helper,
      '-Extractor',
      extractor,
      '-Archive',
      f.archive,
      '-Target',
      f.output,
      '-ListDirectory',
      f.lists
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 30_000 }
  )
}

describe('Windows extraction partition generation', () => {
  it.each([
    '../escape',
    '/absolute',
    'C:/drive',
    'dir//file',
    'dir/./file',
    'dir/file.',
    'dir/file ',
    'dir/*.js'
  ])('rejects unsafe archive path %s', (name) => {
    expect(() => parseEntries(`Path = ${name}\nSize = 1\nAttributes = A\n`)).toThrow(
      'Unsupported archive path'
    )
  })
  it('rejects case collisions, links and malformed listing records', () => {
    expect(() => parseEntries('Path = hidden\nPath = visible\nSize = 1\nAttributes = A')).toThrow(
      'Duplicate archive listing field'
    )
    expect(() =>
      parseEntries('Path = A\nSize = 1\nAttributes = A\n\nPath = a\nSize = 2\nAttributes = A')
    ).toThrow('Duplicate archive path')
    expect(() =>
      parseEntries('Path = link\nSize = 0\nAttributes = A\nSymbolic Link = target')
    ).toThrow('Unsupported archive path')
    expect(() => parseEntries('Path = good\ninjected-name\nSize = 0\nAttributes = A')).toThrow(
      'Invalid archive listing line'
    )
  })
  it('keeps packages together and is independent of input enumeration order', () => {
    const files = [
      'app.exe',
      'resources/backend/index.cjs',
      'resources/backend/node_modules/a/a.js',
      'resources/backend/node_modules/a/b.js',
      'resources/backend/node_modules/@scope/b/a.js'
    ].map((path) => ({ path, bytes: 42 }))
    const bins: string[][] = partitionFiles(files)
    expect(partitionFiles([...files].reverse())).toEqual(bins)
    expect(bins.flat().sort()).toEqual(files.map((file) => file.path).sort())
    expect(bins.some((bin) => bin.includes(files[2].path) && bin.includes(files[3].path))).toBe(
      true
    )
  })
  it('derives full coverage, Unicode paths and empty directories from the final archive', () => {
    const f = payload()
    const lists = [0, 1].flatMap((i) =>
      readFileSync(join(f.lists, `files-2-${i}.txt`), 'utf8')
        .trim()
        .split('\n')
    )
    expect(new Set(lists).size).toBe(3)
    expect(lists).toContain('resources/backend/node_modules/@scope/b/中文 文件.txt')
    expect(readFileSync(join(f.lists, 'all-directories.txt'), 'utf8').split('\n')).toContain(
      'empty directory'
    )
    const before = readFileSync(join(f.lists, 'files-2-0.txt'))
    prepareExtraction(f.archive, f.lists)
    expect(readFileSync(join(f.lists, 'files-2-0.txt'))).toEqual(before)
    writeFileSync(f.archive, 'invalid')
    expect(() => prepareExtraction(f.archive, f.lists)).toThrow()
  })
})

describe.skipIf(process.platform !== 'win32')('real Windows partition extraction', () => {
  it('handles a file-only archive with an empty second partition', () => {
    const root = fixture(),
      input = join(root, 'input'),
      archive = join(root, 'payload.7z'),
      lists = join(root, 'lists')
    mkdirSync(input)
    writeFileSync(join(input, 'app.exe'), 'shell')
    execFileSync(sevenZip, ['a', '-t7z', archive, '.'], {
      cwd: input,
      windowsHide: true,
      stdio: 'pipe'
    })
    prepareExtraction(archive, lists)
    expect(readFileSync(join(lists, 'all-directories.txt'), 'utf8')).toBe('')
    expect(readFileSync(join(lists, 'files-2-1.txt'), 'utf8')).toBe('')
    const output = join(root, 'output'),
      result = extract({ root, archive, lists, output })
    expect(result.error).toBeUndefined()
    expect(result.status, String(result.stderr)).toBe(0)
    expect(readFileSync(join(output, 'app.exe'), 'utf8')).toBe('shell')
  }, 30_000)
  it('extracts every payload file and preserves an empty directory with Unicode paths', () => {
    const f = payload(),
      result = extract(f)
    expect(result.error).toBeUndefined()
    expect(result.status, String(result.stderr)).toBe(0)
    expect(readFileSync(join(f.output, 'app.exe'), 'utf8')).toBe('shell')
    expect(readFileSync(join(f.output, 'resources/backend/node_modules/a/index.js'), 'utf8')).toBe(
      'first'
    )
    expect(
      readFileSync(join(f.output, 'resources/backend/node_modules/@scope/b/中文 文件.txt'), 'utf8')
    ).toBe('second')
    expect(existsSync(join(f.output, 'empty directory'))).toBe(true)
  }, 30_000)
  it.each([
    'corrupt',
    'truncated',
    'missing-list',
    'missing-directories',
    'blocked-path',
    'missing-extractor'
  ])(
    'rejects %s without reporting success',
    (mode) => {
      const f = payload()
      if (mode === 'corrupt') writeFileSync(f.archive, 'not an archive')
      if (mode === 'truncated') writeFileSync(f.archive, readFileSync(f.archive).subarray(0, 40))
      if (mode === 'missing-list' || mode === 'missing-directories')
        require('node:fs').unlinkSync(
          join(f.lists, mode === 'missing-list' ? 'files-2-1.txt' : 'all-directories.txt')
        )
      if (mode === 'blocked-path') {
        mkdirSync(join(f.output, 'app.exe'), { recursive: true })
        writeFileSync(join(f.output, 'app.exe/occupied'), 'keep')
      }
      const result = extract(
        f,
        mode === 'missing-extractor' ? join(f.root, 'absent.exe') : sevenZip
      )
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
    },
    30_000
  )
  it.each(['nonzero-child', 'missing-second-list'])(
    'waits for all started children after %s',
    (mode) => {
      const f = payload(),
        source = join(f.root, 'extractor.cs'),
        exe = join(f.root, 'extractor.exe')
      writeFileSync(
        source,
        `using System; using System.IO; using System.Threading;
class Extractor { static int Main(string[] args) {
  foreach (string arg in args) if (arg.StartsWith("-x@")) return 0;
  foreach (string arg in args) if (arg.StartsWith("-i@")) {
    string list = arg.Substring(3); Thread.Sleep(list.EndsWith("files-2-0.txt") ? 300 : 1200);
    File.WriteAllText(list + ".finished", "exited");
    return list.EndsWith("files-2-0.txt") ? 1 : 0;
  } return 2;
}}`
      )
      const compiler = join(
        process.env.SystemRoot || 'C:\\Windows',
        'Microsoft.NET/Framework/v4.0.30319/csc.exe'
      )
      execFileSync(compiler, ['/nologo', '/target:exe', `/out:${exe}`, source], {
        windowsHide: true,
        stdio: 'pipe'
      })
      if (mode === 'missing-second-list')
        require('node:fs').unlinkSync(join(f.lists, 'files-2-1.txt'))
      const result = extract(f, exe)
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(readFileSync(join(f.lists, 'files-2-0.txt.finished'), 'utf8')).toBe('exited')
      if (mode === 'nonzero-child')
        expect(readFileSync(join(f.lists, 'files-2-1.txt.finished'), 'utf8')).toBe('exited')
    },
    30_000
  )
})
