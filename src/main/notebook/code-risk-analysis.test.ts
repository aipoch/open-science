import { describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as parser from './dependency-analysis-parser'
import * as powerShellParser from './powershell-search-parser'
import { analyzeNotebookCodeRisk, analyzePowerShellCodeRisk } from './code-risk-analysis'
import type { NotebookSourceFileAccessContext } from './dependency-analysis-types'

vi.mock('node:child_process', { spy: true })

describe('Notebook execution code risk', () => {
  describe('existing file writes', () => {
    const context = (workingDirectory: string): NotebookSourceFileAccessContext => ({
      workingDirectory,
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: []
    })
    it.each([
      ['python', 'open("target.txt", "w").write("new")'],
      ['python', 'open(file="target.txt", mode="wb").write(b"new")'],
      ['python', 'from builtins import open as output; output("target.txt", "w+")'],
      ['python', 'import io; io.open("target.txt", "wt")'],
      ['python', 'from pathlib import Path; Path("target.txt").write_text("new")'],
      ['python', 'from pathlib import Path; Path("target.txt").write_bytes(b"new")'],
      ['python', 'from pathlib import Path; Path("target.txt").open("w")'],
      ['python', 'import shutil; shutil.copyfile("source.txt", "target.txt")'],
      ['repl', 'require("fs").writeFileSync("target.txt", "new")'],
      ['repl', 'require("node:fs/promises").writeFile("target.txt", "new")'],
      ['repl', 'const {writeFileSync: output} = require("fs"); output("target.txt", "new")'],
      ['repl', 'require("fs").writeFileSync("target.txt", "new", {flag:"r+"})'],
      ['repl', 'require("fs").appendFileSync("target.txt", "new", {flag:"w"})'],
      ['repl', 'require("fs").createWriteStream("target.txt")'],
      ['repl', 'require("fs").openSync("target.txt", "w")'],
      ['repl', 'require("fs").copyFileSync("source.txt", "target.txt")'],
      ['r', 'writeLines("new", "target.txt")'],
      ['r', 'base::writeLines(con="target.txt", text="new")'],
      ['r', 'writeBin(as.raw(1), "target.txt")'],
      ['r', 'cat("new", file="target.txt")'],
      ['r', 'file("target.txt", open="w")']
    ] as const)('checks current filesystem for %s: %s', async (language, source) => {
      const root = await mkdtemp(join(tmpdir(), 'risk-writes-'))
      try {
        expect(await analyzeNotebookCodeRisk(language, source, context(root))).toEqual([])
        await writeFile(join(root, 'target.txt'), 'keep')
        const risks = await analyzeNotebookCodeRisk(language, source, context(root))
        expect(risks).toEqual([
          expect.objectContaining({ operation: expect.stringContaining('existing-file overwrite') })
        ])
        expect(Object.keys(risks[0]).sort()).toEqual(['line', 'operation', 'source'])
        expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('keep')
        await rm(join(root, 'target.txt'))
        expect(await analyzeNotebookCodeRisk(language, source, context(root))).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    it.each([
      ['python', 'open("target.txt").read()'],
      ['python', 'open("target.txt", "a").write("new")'],
      ['python', 'open("target.txt", "a+").write("new")'],
      ['python', 'open("target.txt", "x").write("new")'],
      ['python', 'open("target.txt", "r+").read()'],
      ['python', 'from pathlib import Path; Path("target.txt").open("a")'],
      ['python', 'def output():\n    open("target.txt", "w").write("new")'],
      ['python', 'def open(*args):\n    return None\nopen("target.txt", "w")'],
      ['repl', 'require("fs").readFileSync("target.txt")'],
      ['repl', 'require("fs").writeFileSync("target.txt", "new", {flag:"a"})'],
      ['repl', 'require("fs").writeFileSync("target.txt", "new", {flag:"wx"})'],
      ['repl', 'require("fs").appendFileSync("target.txt", "new")'],
      ['repl', 'require("fs").createWriteStream("target.txt", {flags:"a"})'],
      ['repl', 'require("fs").openSync("target.txt", "r+")'],
      ['repl', 'require("fs").copyFileSync("source.txt", "target.txt", 1)'],
      [
        'repl',
        'const fs = require("fs"); fs.copyFileSync("source.txt", "target.txt", fs.constants.COPYFILE_EXCL)'
      ],
      ['r', 'cat("new", file="target.txt", append=TRUE)'],
      ['r', 'file("target.txt", open="a")'],
      ['r', 'readLines("target.txt")'],
      ['r', 'cat("data", "target.txt")'],
      ['r', 'file.copy("source.txt", "target.txt")']
    ] as const)('keeps non-overwriting %s operations prompt-free: %s', async (language, source) => {
      const root = await mkdtemp(join(tmpdir(), 'risk-writes-'))
      try {
        await writeFile(join(root, 'target.txt'), 'keep')
        expect(await analyzeNotebookCodeRisk(language, source, context(root))).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    it.each([
      ['python', 'import os; os.chdir("data"); open("target.txt", "w").write("new")'],
      ['python', 'from os import chdir as cd; cd(path="data"); open("target.txt", "w")'],
      [
        'python',
        'import os\ndef output():\n    os.chdir("data")\n    open("target.txt", "w")\noutput()'
      ],
      ['python', 'import os\ndef enter():\n    os.chdir("data")\nenter()\nopen("target.txt", "w")'],
      ['python', 'import os\nif condition:\n    os.chdir("data")\nopen("target.txt", "w")'],
      [
        'python',
        'import os; os.chdir("data"); os.chdir(".."); os.chdir("data"); open("target.txt", "w")'
      ],
      ['repl', 'process.chdir("data"); require("fs").writeFileSync("target.txt", "new")'],
      [
        'repl',
        'function output() {process.chdir("data"); require("fs").writeFileSync("target.txt", "new")} output()'
      ],
      [
        'repl',
        'if (condition) process.chdir("data"); require("fs").writeFileSync("target.txt", "new")'
      ],
      ['r', 'setwd("data"); writeLines("new", "target.txt")'],
      ['r', 'cd <- base::setwd; cd(dir="data"); writeLines("new", "target.txt")'],
      ['r', 'output <- function() {setwd("data"); writeLines("new", "target.txt")}; output()'],
      ['r', 'if (condition) setwd("data"); writeLines("new", "target.txt")']
    ] as const)('tracks same-cell cwd for %s: %s', async (language, source) => {
      const root = await mkdtemp(join(tmpdir(), 'risk-cwd-'))
      try {
        await mkdir(join(root, 'data'))
        expect(await analyzeNotebookCodeRisk(language, source, context(root))).toEqual([])
        await writeFile(join(root, 'data', 'target.txt'), 'keep')
        const risks = await analyzeNotebookCodeRisk(language, source, context(root))
        expect(risks.some((risk) => risk.operation.includes('existing-file overwrite'))).toBe(true)
        expect(JSON.stringify(risks)).not.toMatch(/overwriteCwd|overwritePath|copyBasename/)
        expect(await readFile(join(root, 'data', 'target.txt'), 'utf8')).toBe('keep')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    it.each([
      ['python', 'import os; os.chdir("data"); open("target.txt", "w")'],
      ['repl', 'process.chdir("data"); require("fs").writeFileSync("target.txt", "new")'],
      ['r', 'setwd("data"); writeLines("new", "target.txt")']
    ] as const)(
      'does not mistake the old cwd target for a new %s output',
      async (language, source) => {
        const root = await mkdtemp(join(tmpdir(), 'risk-cwd-new-'))
        try {
          await mkdir(join(root, 'data'))
          await writeFile(join(root, 'target.txt'), 'keep')
          expect(await analyzeNotebookCodeRisk(language, source, context(root))).toEqual([])
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    )
    it('resets cwd after history replay and composes deferred function cwd at invocation', async () => {
      const root = await mkdtemp(join(tmpdir(), 'risk-cwd-replay-'))
      try {
        await mkdir(join(root, 'data'))
        const definition =
          'import os\ndef output():\n    os.chdir("data")\n    open("target.txt", "w")'
        for (let repeat = 0; repeat < 2; repeat++) {
          expect(
            await analyzeNotebookCodeRisk('python', 'output()', context(root), [definition])
          ).toEqual([])
          await writeFile(join(root, 'data', 'target.txt'), 'keep')
          expect(
            await analyzeNotebookCodeRisk('python', 'output()', context(root), [definition])
          ).not.toEqual([])
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              'open("target.txt", "w")',
              context(join(root, 'data')),
              ['import os; os.chdir("data")']
            )
          ).not.toEqual([])
          await rm(join(root, 'data', 'target.txt'))
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    it.each(['copy', 'copy2'])(
      'checks the actual shutil.%s destination inside a directory',
      async (method) => {
        const root = await mkdtemp(join(tmpdir(), 'risk-copy-'))
        try {
          await mkdir(join(root, 'data'))
          await writeFile(join(root, 'source.txt'), 'source')
          const source = `import shutil; shutil.${method}(src="source.txt", dst="data")`
          expect(await analyzeNotebookCodeRisk('python', source, context(root))).toEqual([])
          await writeFile(join(root, 'data', 'source.txt'), 'keep')
          const risks = await analyzeNotebookCodeRisk('python', source, context(root))
          expect(risks).toHaveLength(1)
          expect(JSON.stringify(risks)).not.toMatch(/overwriteCwd|overwritePath|copyBasename/)
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    )
    it.each([
      'open("target.txt", "r+").write("new")',
      'open("target.txt", "r+b").writelines([b"new"])',
      'with open("target.txt", "r+") as f:\n    f.truncate(0)',
      'import io; f=io.open("target.txt", "r+"); saved=f.write; saved("new")',
      'from pathlib import Path; f=Path("target.txt").open("r+"); f.truncate(0)',
      'with open("target.txt", "a+") as f:\n    f.truncate(0)',
      'import os; f=open("target.txt", "r+"); os.chdir("data"); f.write("new")'
    ])('reviews native file-handle mutation: %s', async (source) => {
      const risks = await analyzeNotebookCodeRisk('python', source)
      expect(risks.some((risk) => risk.operation.startsWith('file.'))).toBe(true)
    })
    it.each([
      'with open("target.txt", "r+") as f:\n    print(f.read())',
      'with open("target.txt", "a+") as f:\n    f.write("new")',
      'with open("target.txt", "x") as f:\n    f.write("new")',
      'frame.truncate(before=1, after=3)',
      'f = frame; f.truncate(before=1)',
      'with open("target.txt", "r+") as f:\n    f = frame\n    f.truncate(before=1)',
      'open("target.txt").truncate(0)',
      'with open("new.txt", "x") as f:\n    f.write("new")\n    f.truncate(0)',
      'import io\nwith open("target.txt", "r+") as handle:\n    print(handle.read())\nwith io.StringIO() as handle:\n    handle.write("new")',
      'with open("target.txt", "r+") as f:\n    pass\nwith some_context() as f:\n    f.truncate(before=1)'
    ])('keeps native reads, append and scientific members prompt-free: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
    })
    it.each(['w', 'x'])(
      'retains deferred mutations of captured %s handles across replay',
      async (mode) => {
        const definition = `handle=open("target.txt", "${mode}")\nhandle.write("keep")\ndef erase():\n    handle.truncate(0)`
        expect(await analyzeNotebookCodeRisk('python', `${definition}\nerase()`)).toEqual([])
        for (let repeat = 0; repeat < 2; repeat++) {
          expect(
            await analyzeNotebookCodeRisk('python', 'erase()', undefined, [definition])
          ).toHaveLength(1)
          expect(
            await analyzeNotebookCodeRisk('python', 'wrapper()', undefined, [
              definition,
              'def wrapper():\n    erase()'
            ])
          ).toHaveLength(1)
        }
        const local = `def create():\n    handle=open("target.txt", "${mode}")\n    handle.write("new")\n    handle.truncate(0)`
        expect(await analyzeNotebookCodeRisk('python', 'create()', undefined, [local])).toEqual([])
      }
    )
    it.each(['r+', 'w', 'x'])(
      'reviews retained %s handles while keeping append handles inert',
      async (mode) => {
        for (let repeat = 0; repeat < 2; repeat++) {
          expect(
            await analyzeNotebookCodeRisk('python', 'saved("new")', undefined, [
              `f=open("target.txt", "${mode}"); saved=f.write`
            ])
          ).toHaveLength(1)
          expect(
            await analyzeNotebookCodeRisk('python', 'f.write("new")', undefined, [
              'f=open("target.txt", "a+")'
            ])
          ).toEqual([])
        }
      }
    )
    it.each(['link/..', 'link", "..'])(
      'resolves physical cwd before symlink parents: %s',
      async (route) => {
        const root = await mkdtemp(join(tmpdir(), 'risk-cwd-symlink-'))
        try {
          const workspace = join(root, 'workspace')
          const outside = join(root, 'outside')
          await mkdir(workspace)
          await mkdir(join(outside, 'inside'), { recursive: true })
          await symlink(
            join(outside, 'inside'),
            join(workspace, 'link'),
            process.platform === 'win32' ? 'junction' : 'dir'
          )
          await writeFile(join(outside, 'target.txt'), 'keep')
          const changes =
            route === 'link/..' ? 'os.chdir("link/..")' : 'os.chdir("link"); os.chdir("..")'
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              `import os; ${changes}; open("target.txt", "w")`,
              context(workspace)
            )
          ).toHaveLength(1)
          expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('keep')
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    )
    it('resets uncertain cwd at an absolute change and keeps new output prompt-free', async () => {
      const root = await mkdtemp(join(tmpdir(), 'risk-cwd-absolute-'))
      try {
        const source = `import os; os.chdir(dynamic_directory); os.chdir(${JSON.stringify(root)}); open("target.txt", "w")`
        expect(await analyzeNotebookCodeRisk('python', source, context(root))).toEqual([])
        await writeFile(join(root, 'target.txt'), 'keep')
        expect(await analyzeNotebookCodeRisk('python', source, context(root))).toHaveLength(1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    it('retains native handle mode across cached history without using the new cwd', async () => {
      const history = ['f = open("target.txt", "r+")']
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await analyzeNotebookCodeRisk('python', 'f.read()', undefined, history)).toEqual([])
        expect(
          await analyzeNotebookCodeRisk('python', 'f.write("new")', undefined, history)
        ).toHaveLength(1)
      }
    })
    it('rechecks deferred function effects after cached history and cwd changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'risk-writes-'))
      try {
        const definition = 'def output():\n    open("target.txt", "w").write("new")'
        expect(
          await analyzeNotebookCodeRisk('python', 'output()', context(root), [definition])
        ).toEqual([])
        await writeFile(join(root, 'target.txt'), 'keep')
        const risks = await analyzeNotebookCodeRisk('python', 'output()', context(root), [
          definition
        ])
        expect(risks).toEqual([
          { operation: 'output: open existing-file overwrite', source: 'output()', line: 1 }
        ])
        expect(
          await analyzeNotebookCodeRisk('python', 'output()', context(join(root, 'absent')), [
            definition
          ])
        ).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    it.each([
      ['python', 'import os; os.truncate("target.txt", 0)'],
      ['python', 'import os; os.rename("source.txt", "target.txt")'],
      ['python', 'import shutil; shutil.move("source.txt", "target.txt")'],
      ['repl', 'require("fs").truncateSync("target.txt", 0)'],
      ['repl', 'require("fs").renameSync("source.txt", "target.txt")'],
      ['r', 'file.rename("source.txt", "target.txt")']
    ] as const)('reviews explicit %s mutations: %s', async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
    })
  })
  describe('PowerShell existing file writes', () => {
    it.each([
      ['Set-Content', ['-Path', 'target.txt', '-Value', 'new'], true],
      ['sc', ['target.txt', 'new'], true],
      ['Out-File', ['-FilePath', 'target.txt'], true],
      ['of', ['target.txt'], true],
      ['Out-File', ['target.txt', '-Append'], false],
      ['Out-File', ['target.txt', '-NoClobber'], false],
      ['Out-File', ['target.txt', '-Append', 'False'], true],
      ['Out-File', ['target.txt', '-NoClobber', 'False'], true],
      ['Add-Content', ['target.txt', 'new'], false],
      ['Set-Content', ['-Path', null, '-Value', 'target.txt'], false],
      ['@file:WriteAllText', ['target.txt', 'new'], true],
      ['@file:WriteAllBytes', ['target.txt', null], true],
      ['@file:CreateText', ['target.txt'], true],
      ['@file:AppendAllText', ['target.txt', 'new'], false],
      ['@file:Copy', ['source.txt', 'target.txt', 'True'], true],
      ['@file:Copy', ['source.txt', 'target.txt'], false],
      ['@member:WriteAllText', ['custom.WriteAllText()'], false]
    ] as const)('distinguishes %s %j writes', async (name, args, overwrite) => {
      const root = await mkdtemp(join(tmpdir(), 'risk-ps-writes-'))
      const spy = vi
        .spyOn(powerShellParser, 'parsePowerShellSearchCommands')
        .mockResolvedValue([{ name, arguments: [...args], source: 'literal write', line: 3 }])
      try {
        expect(await analyzePowerShellCodeRisk('literal write', undefined, '5.1', root)).toEqual([])
        await writeFile(join(root, 'target.txt'), 'keep')
        const risks = await analyzePowerShellCodeRisk('literal write', undefined, '5.1', root)
        expect(risks.length).toBe(overwrite ? 1 : 0)
        if (overwrite) expect(risks[0]).toMatchObject({ source: 'literal write', line: 3 })
        expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('keep')
      } finally {
        spy.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    })
    it.skipIf(process.platform !== 'win32')(
      'parses native write modes without executing them',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'risk-ps-writes-'))
        try {
          await writeFile(join(root, 'target.txt'), 'keep')
          for (const source of [
            'Set-Content -LiteralPath "target.txt" -Value "new"',
            '"new" | Out-File "target.txt"',
            '"new" | Out-File "target.txt" -Append:$false',
            '[System.IO.File]::WriteAllText("target.txt", "new")',
            '[IO.File]::WriteAllBytes("target.txt", [byte[]](1,2))'
          ])
            expect(await analyzePowerShellCodeRisk(source, undefined, '5.1', root)).not.toEqual([])
          for (const source of [
            'Set-Content "fresh.txt" "new"',
            'Add-Content "target.txt" "new"',
            '"new" | Out-File "target.txt" -Append',
            '"new" | Out-File "target.txt" -NoClobber',
            '[IO.File]::AppendAllText("target.txt", "new")'
          ])
            expect(await analyzePowerShellCodeRisk(source, undefined, '5.1', root)).toEqual([])
          expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('keep')
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    )
  })
  describe('copy and move commands', () => {
    it.each([
      'cp --help',
      'mv --version',
      'cp -n source target',
      'cp -Rn source target',
      'cp --no-clobber --recursive source target',
      'cp -n -- "$source" "$target"',
      'env LC_ALL=C cp -n source target',
      'command cp -n source target'
    ])('keeps protected copies and queries prompt-free: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
    })
    it.each([
      'cp source target',
      'cp -f source target',
      'cp -r source target',
      'cp -n -f source target',
      'cp -n --remove-destination source target',
      'cp source target -n',
      'cp -n "$options" source target',
      'cp -n $source target',
      'cp --no-clobber -p source target',
      'cp -n -- source "$(rm target)"',
      'env LC_ALL=C cp -f source target',
      'mv source target',
      'mv -f source target',
      'mv -n source target',
      'mv -- "$source" "$target"',
      'command mv source target'
    ])('reviews overwrite, source removal and unresolved options: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('bash', source)).not.toEqual([])
    })
    it.each(['python', 'r', 'repl'] as const)(
      'reviews %s process copies and moves',
      async (language) => {
        for (const command of ['cp', 'mv']) {
          const source =
            language === 'python'
              ? `import subprocess; subprocess.run(["${command}", "-f", "source", "target"])`
              : language === 'r'
                ? `system2("${command}", c("-f", "source", "target"))`
                : `require("node:child_process").execFileSync("${command}", ["-f", "source", "target"])`
          expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
        }
      }
    )
    it.each(['Copy-Item', 'cp', 'Move-Item', 'mv'])(
      'reviews PowerShell %s without POSIX option assumptions',
      async (name) => {
        const spy = vi.spyOn(powerShellParser, 'parsePowerShellSearchCommands').mockResolvedValue([
          {
            name,
            arguments: ['-n', 'source', 'target'],
            source: `${name} -n source target`,
            line: 1
          }
        ])
        try {
          expect(await analyzePowerShellCodeRisk(`${name} -n source target`)).not.toEqual([])
        } finally {
          spy.mockRestore()
        }
      }
    )
  })
  describe('bounded history replay evidence', () => {
    it.each([
      ['python', '#', 'print("hello")', 'import os\nerase=os.unlink', 'erase("target.txt")'],
      ['r', '#', 'print("hello")', 'erase <- unlink', 'erase("target.txt")'],
      [
        'repl',
        '//',
        'console.log("hello")',
        'const fs=require("node:fs");const erase=fs.unlinkSync',
        'erase("target.txt")'
      ],
      ['bash', '#', 'printf hello', 'erase(){ rm -- "$1"; }', 'erase target.txt']
    ] as const)(
      'keeps long %s history prompt-free without dropping deletion',
      async (language, comment, query, setup, erase) => {
        const history = Array.from(
          { length: 40 },
          (_, index) => comment + 'x'.repeat(9_000) + index + '\n'
        )
        history.push(setup)
        expect(await analyzeNotebookCodeRisk(language, query, undefined, history)).toEqual([])
        expect(await analyzeNotebookCodeRisk(language, query, undefined, history)).toEqual([])
        expect(await analyzeNotebookCodeRisk(language, erase, undefined, history)).not.toEqual([])
      }
    )
    it('accepts one large data cell and budgets each cell independently', async () => {
      const history = [
        'data=' + JSON.stringify('x'.repeat(300_000)),
        ...Array(100).fill('value=1\n'.repeat(100))
      ]
      expect(await analyzeNotebookCodeRisk('python', 'print("hello")', undefined, history)).toEqual(
        []
      )
    })
    it('reuses exact prefix evidence while reviewing the current code again', async () => {
      const history = ['import os\n# replay prefix\nerase=os.unlink', 'reader=os.listdir']
      await analyzeNotebookCodeRisk('python', 'print(1)', undefined, history)
      const spy = vi.spyOn(parser, 'withParsedNotebookSource')
      try {
        expect(
          await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, history)
        ).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'os.unlink' })]))
        expect(spy.mock.calls.some(([, source]) => history.includes(source))).toBe(false)
        expect(spy.mock.calls.some(([, source]) => source === 'erase("target.txt")')).toBe(true)
        expect(
          await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, history)
        ).not.toEqual([])
      } finally {
        spy.mockRestore()
      }
    })
    it('keeps changed and reordered branches separate', async () => {
      const first = ['import os\n# branch replay\nerase=os.unlink', 'erase=os.listdir']
      expect(
        await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, first)
      ).toEqual([])
      for (const history of [[first[0]], [first[1], first[0]], [first[0], 'erase=os.unlink']])
        expect(
          await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, history)
        ).not.toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, first)
      ).toEqual([])
    })
    it('does not turn completed evidence into a failed-cell conclusion', async () => {
      const first = 'import os\n# partial replay\nerase=os.unlink'
      const script = 'erase=None'
      expect(
        await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [
          first,
          { script, incomplete: false }
        ])
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [
          first,
          { script, incomplete: true }
        ])
      ).not.toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [first, script])
      ).toEqual([])
    })
    it('keys initial bindings and platform as part of the source evidence', async () => {
      const context = (qualifiedName: string): NotebookSourceFileAccessContext => ({
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonBindings: [{ name: 'erase', qualifiedName, kind: 'import' as const }]
      })
      const history = ['# contextual replay']
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'erase("target.txt")',
          context('os.listdir'),
          history
        )
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'erase("target.txt")',
          context('os.unlink'),
          history
        )
      ).not.toEqual([])
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      await analyzeNotebookCodeRisk('python', 'print(1)', undefined, history)
      const spy = vi.spyOn(parser, 'withParsedNotebookSource')
      try {
        Object.defineProperty(process, 'platform', {
          value: process.platform === 'win32' ? 'darwin' : 'win32'
        })
        await analyzeNotebookCodeRisk('python', 'print(1)', undefined, history)
        expect(spy.mock.calls.some(([, source]) => source === history[0])).toBe(true)
      } finally {
        Object.defineProperty(process, 'platform', platform)
        spy.mockRestore()
      }
    })
    it('isolates concurrent analyses and caller mutations of returned findings', async () => {
      const history = ['import os\n# parallel replay\ndef erase(path):\n os.unlink(path)']
      const [safe, danger] = await Promise.all([
        analyzeNotebookCodeRisk('python', 'print(1)', undefined, history),
        analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, history)
      ])
      expect(safe).toEqual([])
      expect(danger).not.toEqual([])
      ;(danger[0] as { operation: string }).operation = 'changed by caller'
      expect(
        (await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, history))[0]
          .operation
      ).not.toBe('changed by caller')
      expect(
        await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [
          history[0],
          'erase=None'
        ])
      ).toEqual([])
    })
    it('evicts old summaries without losing deletion evidence', async () => {
      const history = ['import os\n# evict replay\nerase=os.unlink']
      await analyzeNotebookCodeRisk('python', 'print(1)', undefined, history)
      for (let i = 0; i < 12; i++)
        await analyzeNotebookCodeRisk('python', `# unrelated replay ${i}\nprint(1)`)
      const spy = vi.spyOn(parser, 'withParsedNotebookSource')
      try {
        expect(
          await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, history)
        ).not.toEqual([])
        expect(spy.mock.calls.some(([, source]) => source === history[0])).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })
    it('retains distinct object identities when a later cell creates another object', async () => {
      const history = ['const fs=require("node:fs");const first={run:fs.unlinkSync}']
      await analyzeNotebookCodeRisk('repl', 'console.log(1)', undefined, history)
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          'const second={run:()=>{}};first.run("target.txt")',
          undefined,
          history
        )
      ).not.toEqual([])
    })
    it('retains function member effects behind a cached prefix', async () => {
      const history = ['import os\ndef replace():\n os.listdir=os.unlink']
      await analyzeNotebookCodeRisk('python', 'print(1)', undefined, history)
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'replace()\nos.listdir("target.txt")',
          undefined,
          history
        )
      ).not.toEqual([])
    })
    it('keys exact source code units without normalizing malformed Unicode', async () => {
      await analyzeNotebookCodeRisk('python', 'print(1)', undefined, ['# unicode replay \ud800'])
      const spy = vi.spyOn(parser, 'withParsedNotebookSource')
      try {
        await analyzeNotebookCodeRisk('python', 'print(1)', undefined, ['# unicode replay \ufffd'])
        expect(spy.mock.calls.some(([, source]) => source === '# unicode replay \ufffd')).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })
    it('honors cancellation even when all historical evidence is cached', async () => {
      const history = ['import os\n# cancel cached replay\nerase=os.unlink']
      await analyzeNotebookCodeRisk('python', 'print(1)', undefined, history)
      const controller = new AbortController()
      const pending = analyzeNotebookCodeRisk(
        'python',
        'erase("target.txt")',
        undefined,
        history,
        controller.signal
      )
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })
    it('retains state and current-cell bounds after caching a valid prefix', async () => {
      const history = ['# bounded replay\nvalue=1']
      await analyzeNotebookCodeRisk('python', 'print(1)', undefined, history)
      expect(
        await analyzeNotebookCodeRisk('python', '#' + 'x'.repeat(1024 * 1024), undefined, history)
      ).toEqual([expect.objectContaining({ operation: 'code source exceeds analysis limit' })])
      expect(
        await analyzeNotebookCodeRisk('python', 'print(1)', undefined, [
          Array.from({ length: 4097 }, (_, i) => `value${i}=0`).join('\n')
        ])
      ).toEqual([expect.objectContaining({ operation: 'code analysis unavailable' })])
    })
  })
  describe('PowerShell risk source locations', () => {
    it('retains native command, member and redirection source positions', async () => {
      const observations = [
        {
          name: 'Remove-Item',
          arguments: ['target.txt'],
          source: 'Remove-Item target.txt',
          line: 3
        },
        {
          name: '@member:Delete',
          arguments: ['[System.IO.File]::Delete("target.txt")'],
          source: '[System.IO.File]::Delete("target.txt")',
          line: 5
        },
        { name: '@overwrite', arguments: ['> target.txt'], source: '> target.txt', line: 7 }
      ]
      const spy = vi
        .spyOn(powerShellParser, 'parsePowerShellSearchCommands')
        .mockResolvedValue(observations)
      try {
        expect(
          await analyzePowerShellCodeRisk('Write-Output hello\n\nRemove-Item target.txt')
        ).toEqual(observations.map(({ name, source, line }) => ({ operation: name, source, line })))
      } finally {
        spy.mockRestore()
      }
    })
    it.each([
      { name: 'Remove-Item', arguments: ['x'], source: 'Remove-Item x' },
      { name: 'Remove-Item', arguments: ['x'], source: 'Remove-Item x', line: 0 },
      { name: 'Remove-Item', arguments: ['x'], source: 'Remove-Item x', line: 1.5 },
      { name: 'Remove-Item', arguments: ['x'], line: 2 },
      { name: 'Remove-Item', arguments: ['x'], source: 42, line: 2 }
    ])('rejects missing or malformed native locations: %j', async (entry) => {
      const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
        const callback = args.at(-1) as (
          error: Error | null,
          stdout: string,
          stderr: string
        ) => void
        queueMicrotask(() => callback(null, JSON.stringify([entry]), ''))
        return {} as childProcess.ChildProcess
      }) as typeof childProcess.execFile)
      try {
        await expect(
          powerShellParser.parsePowerShellSearchCommands('Remove-Item x', undefined, '5.1', true)
        ).rejects.toThrow('invalid PowerShell syntax inspection result')
      } finally {
        spy.mockRestore()
      }
    })
    it('keeps default search payloads compatible and enables Extent evidence only for reviews', async () => {
      const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
        const callback = args.at(-1) as (
          error: Error | null,
          stdout: string,
          stderr: string
        ) => void
        queueMicrotask(() =>
          callback(null, JSON.stringify([{ name: 'Get-ChildItem', arguments: ['.'] }]), '')
        )
        return {} as childProcess.ChildProcess
      }) as typeof childProcess.execFile)
      try {
        expect(await powerShellParser.parsePowerShellSearchCommands('Get-ChildItem .')).toEqual([
          { name: 'Get-ChildItem', arguments: ['.'] }
        ])
        const command = spy.mock.calls[0][1] as string[]
        const script = Buffer.from(command.at(-1)!, 'base64').toString('utf16le')
        expect(script).toContain('$entry.line = $_.Extent.StartLineNumber')
        expect(script).toContain('$entry.source = $_.Extent.Text')
      } finally {
        spy.mockRestore()
      }
    })
  })
  describe('Python native process returned vectors', () => {
    const prelude =
      'import os,pathlib,subprocess,builtins,operator\npick=operator.getitem\ngetter=operator.itemgetter("args")\nmulti=operator.itemgetter(0,1)\n'
    const forms = [
      '[ARGV][0]',
      '("unused",ARGV)[-1]',
      'tuple(list((ARGV,)))[0]',
      '{"args":ARGV}["args"]',
      'dict(args=ARGV)["args"]',
      'dict({"args":ARGV})["args"]',
      '({"args":["rm","target.txt"]}|{"args":ARGV})["args"]',
      '{**{"args":["rm","target.txt"]},**dict(args=ARGV)}["args"]',
      '{"args":["rm","target.txt"],"args":ARGV}["args"]',
      '{"args":ARGV}.get("args",["rm","target.txt"])',
      '{"args":ARGV}.pop("args",["rm","target.txt"])',
      '{"args":ARGV}.setdefault("args",["rm","target.txt"])',
      '{}.get("args",ARGV)',
      '{}.pop("args",ARGV)',
      '{}.setdefault("args",ARGV)',
      'dict.get(dict(args=ARGV),"args")',
      'builtins.dict.get({"args":ARGV},"args")',
      'operator.getitem([ARGV],0)',
      'operator.__getitem__(dict(args=ARGV),"args")',
      'operator.itemgetter("args")(dict(args=ARGV))',
      'operator.itemgetter(0)([ARGV])',
      'pick([ARGV],0)',
      'getter({"args":ARGV})',
      'operator.call(operator.getitem,[ARGV],0)',
      'operator.call(operator.itemgetter(0),[ARGV])',
      '{"args":tuple(list(ARGV))}["args"]',
      '{"args":operator.itemgetter(KEYS)(ARGV)}["args"]',
      'operator.itemgetter(KEYS)(ARGV)',
      'operator.itemgetter(KEYS)(tuple(list(ARGV)))',
      'operator.call(operator.itemgetter(KEYS),ARGV)',
      'multi(ARGV)',
      'operator.itemgetter(REV_KEYS)(ARGV[::-1])',
      'operator.itemgetter(KEYS,KEYS)(ARGV)',
      'operator.itemgetter(MAP_KEYS)(MAP)'
    ]
    for (const form of forms)
      for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen'])
        for (const route of [
          'subprocess.METHOD(VECTOR)',
          'subprocess.METHOD(list(tuple(VECTOR)))',
          'subprocess.METHOD([*VECTOR])',
          'subprocess.METHOD(VECTOR[:])',
          'subprocess.METHOD(**dict(args=VECTOR))',
          'operator.call(subprocess.METHOD,VECTOR)'
        ])
          for (const risky of [false, true])
            it(`classifies returned ${form} ${method} ${route} ${risky ? 'erase' : 'query'}`, async () => {
              const command = risky ? 'rm' : 'echo'
              const argument = risky ? 'target.txt' : 'hello'
              const vector = form
                .replaceAll('ARGV', JSON.stringify([command, argument]))
                .replaceAll('REV_KEYS', '1,0')
                .replaceAll('MAP_KEYS', '"command","arg0"')
                .replaceAll('KEYS', '0,1')
                .replaceAll('MAP', JSON.stringify({ command, arg0: argument }))
              const code = prelude + route.replace('METHOD', method).replace('VECTOR', vector)
              const risks = await analyzeNotebookCodeRisk('python', code)
              if (risky)
                expect(risks.map((risk) => risk.operation)).toEqual([
                  `subprocess.${method} nested execution`
                ])
              else expect(risks).toEqual([])
            })
    const pathForms = [
      '[ARGV][0]',
      'dict(args=ARGV)["args"]',
      'dict(args=ARGV).get("args")',
      '{}.get("args",ARGV)',
      'operator.getitem([ARGV],0)',
      'operator.itemgetter(0)([ARGV])',
      'operator.itemgetter(KEYS)(ARGV)'
    ]
    for (const form of pathForms)
      for (const kind of [
        'Path',
        'PurePath',
        'PosixPath',
        'PurePosixPath',
        'WindowsPath',
        'PureWindowsPath'
      ])
        for (const conversion of ['VALUE', 'str(VALUE)', 'os.fspath(VALUE)'])
          for (const risky of [false, true])
            it(`retains returned path ${form} ${kind} ${conversion} ${risky ? 'script' : 'query'}`, async () => {
              const value = conversion.replace('VALUE', `pathlib.${kind}("python")`)
              const args = risky
                ? '"-c",' + JSON.stringify("import os;os.unlink('target.txt')")
                : '"--version"'
              const vector = form
                .replaceAll('ARGV', `[${value},${args}]`)
                .replace('KEYS', risky ? '0,1,2' : '0,1')
              const risks = await analyzeNotebookCodeRisk(
                'python',
                prelude + `subprocess.run(${vector})`
              )
              if (risky) expect(risks.length).toBeGreaterThan(0)
              else expect(risks).toEqual([])
            })
    it.each([
      'subprocess.run(["echo hello".split()][0])',
      'subprocess.run([*(operator.itemgetter(0,1)(["echo","hello"]))])',
      'subprocess.run([*(dict(args=["echo","hello"])["args"])])',
      'subprocess.run([*dict(args=["echo","hello"])["args"]])',
      'subprocess.run((*operator.itemgetter(0,1)(["echo","hello"]),))',
      'subprocess.run([*operator.getitem([["echo","hello"]],0)])',
      'subprocess.run(["unused",*operator.itemgetter(0,1)(["echo","hello"])][1:])',
      'subprocess.run([*operator.itemgetter(0,1)(["echo","hello"])][0])',
      'subprocess.run([*"echo hello".split()])',
      'subprocess.run(tuple(dict(args=()).get("args")) or ["echo","hello"])',
      'subprocess.run(operator.itemgetter(0)([[]]) or ["echo","hello"])',
      'subprocess.run({"args":tuple(["echo","hello"])}["args"]+tuple(("again",)))',
      'subprocess.run({"args":"echo hello".split()}["args"])',
      'subprocess.run(dict(args="echo hello".split()).get("args"))',
      'subprocess.run({"args":operator.itemgetter(0,1)(["echo","hello"])}["args"])',
      'subprocess.run(dict(args=dict(args=["echo","hello"]).get("args"))["args"])',
      'subprocess.run(operator.itemgetter(0)([["echo","hello"]])[0])',
      'subprocess.run(dict(args=["echo","hello"])["args"][0])',
      'subprocess.run({"args":[]}.get("args") or ["echo","hello"])',
      'subprocess.run(["echo","hello"] if {"args":["unused"]}.get("args") else ["rm","target.txt"])',
      'subprocess.run(operator.itemgetter(False,True)(["echo","hello"]))',
      'subprocess.run(operator.itemgetter(-2,-1)(["echo","hello"]))',
      'subprocess.run(operator.itemgetter(0,1)([b"echo",b"hello"]))',
      'subprocess.run([[b"echo",b"hello"]][0])',
      'subprocess.run([(["echo","hello"],)[0],][0])',
      'subprocess.run([(["echo","hello"] if True else ["rm","target.txt"])][0])',
      'flag=1\nsubprocess.run(operator.itemgetter(0,1)(["echo","hello"] if flag else ["echo","goodbye"]))',
      'subprocess.run(multi(["echo","hello"]),text=(multi:=os.unlink))',
      'saved=list\nbuiltins.list=os.unlink\nsubprocess.run([saved(("echo","hello"))][0])'
    ])('preserves chains, order, tuple semantics and completed values: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    it.each([
      'subprocess.run(operator.itemgetter(1,0)(["target.txt","rm"]))',
      'subprocess.run(operator.itemgetter(-1,-2)(["target.txt","rm"]))',
      'subprocess.run({"args":"rm target.txt".split()}["args"])',
      'subprocess.run([ ["echo","hello"],os.unlink("target.txt") ][0])',
      'subprocess.run({"args":["echo","hello"]}.get("args",os.unlink("target.txt")))',
      'subprocess.run({"args":["echo","hello"],os.unlink("target.txt"):0}["args"])',
      'subprocess.run(operator.itemgetter(0,1)(["echo",os.unlink("target.txt")]))',
      'subprocess.run(operator.itemgetter(0,1)(["echo","hello",os.unlink("target.txt")]))',
      'subprocess.run(operator.getitem([["echo","hello"]],os.unlink("target.txt")))',
      'subprocess.run([args][0])',
      'subprocess.run([*commands.values,["echo","hello"]][1])',
      'subprocess.run([*(commands.values),["echo","hello"]][1])',
      'subprocess.run([*factory(),["echo","hello"]][1])',
      'subprocess.run([*operator.itemgetter(0)(args),["echo","hello"]][1])',
      'subprocess.run([*operator.itemgetter(0,1)(["echo",object()])])',
      'subprocess.run([*operator.itemgetter(0,9)(["echo","hello"])])',
      'def factory():\n os.unlink("target.txt")\n return ["echo","hello"]\nsubprocess.run([*factory()])',
      'operator.getitem=lambda args,key:(os.unlink("target.txt") or args[key])\nsubprocess.run([*operator.getitem([["echo","hello"]],0)])',
      'for index in (0,1):\n subprocess.run([*operator.itemgetter(0,1)(["echo","hello"])])\n operator.itemgetter=lambda *keys:(lambda args:["rm","target.txt"])',
      'subprocess.run(mapping.get("args",["echo","hello"]))',
      'subprocess.run(operator.itemgetter(0,1)(args))',
      'subprocess.run(operator.itemgetter(0,index)(["echo","hello"]))',
      'subprocess.run(operator.itemgetter(0,2)(["echo","hello"]))',
      'subprocess.run(operator.itemgetter(0,1)(["echo",None]))',
      'subprocess.run(operator.itemgetter(0,1)(["echo",object()]))',
      'subprocess.run(operator.itemgetter(0,1)(factory()))',
      'subprocess.run(operator.itemgetter("command","missing")({"command":"echo"}))',
      'subprocess.run(operator.itemgetter(0,1)(["echo","hello"]),shell=True)',
      'subprocess.run({}.get("args"))',
      'subprocess.run({}.pop("args"))',
      'subprocess.run([["echo","hello"]][1])',
      'subprocess.run({"args":["echo","hello"]}.get(key))',
      'subprocess.run(dict(args=["echo","hello"],**mapping).get("args"))',
      'for index in (0,1):\n subprocess.run([list(("echo","hello"))][0])\n builtins.list=lambda args:["rm","target.txt"]',
      'for index in (0,1):\n subprocess.run(getter(dict(args=["echo","hello"])))\n getter=lambda args:["rm","target.txt"]',
      'for index in (0,1):\n subprocess.run(multi(["echo","hello"]))\n multi=lambda args:os.unlink("target.txt")',
      'subprocess.run(["echo","hello"] if {"args":object()}.get("args") else ["echo","hello"])'
    ])(
      'retains eager effects, missing slots, opaque protocols and stale-loop risks: %s',
      async (code) => {
        expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
      }
    )
    for (const form of pathForms)
      for (const conversion of ['VALUE', 'str(VALUE)', 'os.fspath(VALUE)'])
        it(`retains late protocol dependencies ${form} ${conversion}`, async () => {
          const value = conversion.replace('VALUE', 'pathlib.Path("python")')
          const vector = form.replaceAll('ARGV', `[${value},"--version"]`).replace('KEYS', '0,1')
          const code =
            prelude +
            'def hook(self):\n os.unlink("target.txt")\n return "python"\ndef change():\n pathlib.PurePath.__fspath__=hook\n return True\n' +
            `subprocess.run(${vector},text=change())`
          const risks = await analyzeNotebookCodeRisk('python', code)
          if (conversion === 'VALUE') expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        })
    it('clears vector receipts across cells and replays partial native factory replacement', async () => {
      const setup = prelude
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'subprocess.run(multi(["echo","hello"]))',
          undefined,
          [setup]
        )
      ).toEqual([])
      for (const incomplete of [false, true])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'subprocess.run(multi(["echo","hello"]))',
              undefined,
              [setup, { script: 'multi=lambda args:["rm","target.txt"]', incomplete }]
            )
          ).length
        ).toBeGreaterThan(0)
      expect(
        (
          await analyzeNotebookCodeRisk('python', 'subprocess.run(args)', undefined, [
            setup + 'args=operator.itemgetter(0,1)(["echo","hello"])'
          ])
        ).length
      ).toBeGreaterThan(0)
    })
    it('bounds both source lookups and resulting vectors', async () => {
      for (const vector of [
        `[["echo","hello"],${Array(1024).fill('0').join(',')}][0]`,
        `[["echo","hello"],${JSON.stringify('x'.repeat(64_001))}][0]`,
        `operator.itemgetter(0,1)(["echo",${JSON.stringify('x'.repeat(64_001))}])`,
        `[["echo",${Array(1024).fill('"hello"').join(',')}]][0]`,
        `operator.itemgetter(${Array(65).fill('0').join(',')})(["echo"])`
      ])
        expect(
          (await analyzeNotebookCodeRisk('python', prelude + `subprocess.run(${vector})`)).length
        ).toBeGreaterThan(0)
    })
  })

  describe('Python native process selected values', () => {
    const prelude =
      'import os,pathlib,subprocess,builtins,operator\npick=operator.getitem\ngetter=operator.itemgetter("command")\n'
    const selectors = [
      '[VALUE,"rm"][0]',
      '("rm",VALUE)[-1]',
      '[VALUE][False]',
      '("rm",VALUE)[True]',
      '([VALUE]+["rm"])[0]',
      '[*("rm",),VALUE][-1]',
      'tuple(list((VALUE,"rm")))[0]',
      'list((VALUE,"rm"))[0]',
      '["rm",VALUE][::-1][0]',
      'VALUE.split()[0]',
      'VALUE.rsplit()[0]',
      'str.split(VALUE)[-1]',
      'VALUE.strip().split("|")[0]',
      '{"command":VALUE}["command"]',
      'dict(command=VALUE)["command"]',
      'dict({"command":VALUE})["command"]',
      '{"command":"rm","command":VALUE}["command"]',
      '({"command":"rm"}|{"command":VALUE})["command"]',
      '{**{"command":"rm"},**dict(command=VALUE)}["command"]',
      '{False:VALUE,True:"rm"}[0]',
      '{"command":VALUE}.get("command","rm")',
      '{"command":VALUE}.pop("command","rm")',
      '{"command":VALUE}.setdefault("command","rm")',
      '{}.get("command",VALUE)',
      '{}.pop("command",VALUE)',
      '{}.setdefault("command",VALUE)',
      'dict.get(dict(command=VALUE),"command")',
      'builtins.dict.get({"command":VALUE},"command")',
      'operator.getitem((VALUE,"rm"),0)',
      'operator.__getitem__(dict(command=VALUE),"command")',
      'operator.itemgetter(0)((VALUE,"rm"))',
      'operator.itemgetter("command")(dict(command=VALUE))',
      'operator.call(operator.getitem,[VALUE],0)',
      'operator.call(operator.itemgetter(0),VALUE.split())',
      'pick([VALUE],0)',
      'getter(dict(command=VALUE))',
      '[VALUE][0].strip()',
      'dict(command=[VALUE][0])["command"]',
      'str([pathlib.Path(VALUE)][0])',
      'os.fspath(dict(command=pathlib.Path(VALUE))["command"])',
      'dict(command=VALUE)["command"].split("|")[0]',
      'operator.getitem(VALUE.split("|"),0)'
    ]
    for (const selector of selectors)
      for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen'])
        for (const route of [
          'subprocess.METHOD([VALUE,ARGS])',
          'subprocess.METHOD(tuple(list((VALUE,ARGS))))',
          'subprocess.METHOD(**dict(args=[VALUE,ARGS]))',
          'subprocess.METHOD(["argv0",ARGS],executable=VALUE)',
          'operator.call(subprocess.METHOD,[VALUE,ARGS])'
        ])
          for (const risky of [false, true])
            it(`classifies selected ${selector} ${method} ${route} ${risky ? 'erase' : 'query'}`, async () => {
              const code =
                prelude +
                route
                  .replace('METHOD', method)
                  .replace('VALUE', selector.replaceAll('VALUE', risky ? '"rm"' : '"python"'))
                  .replace('ARGS', risky ? '"target.txt"' : '"--version"')
              const risks = await analyzeNotebookCodeRisk('python', code)
              if (risky)
                expect(risks.map((risk) => risk.operation)).toEqual([
                  `subprocess.${method} nested execution`
                ])
              else expect(risks).toEqual([])
            })
    const pathSelectors = [
      '[VALUE][0]',
      'tuple(list((VALUE,)))[-1]',
      'dict(command=VALUE)["command"]',
      'dict(command=VALUE).get("command")',
      '{}.get("command",VALUE)',
      'operator.getitem([VALUE],0)',
      'operator.itemgetter("command")(dict(command=VALUE))'
    ]
    for (const selector of pathSelectors)
      for (const kind of [
        'Path',
        'PurePath',
        'PosixPath',
        'PurePosixPath',
        'WindowsPath',
        'PureWindowsPath'
      ])
        for (const conversion of ['VALUE', 'str(VALUE)', 'os.fspath(VALUE)'])
          for (const risky of [false, true])
            it(`preserves selected ${selector} ${kind} ${conversion} ${risky ? 'script' : 'query'}`, async () => {
              const value = selector.replaceAll(
                'VALUE',
                conversion.replace('VALUE', `pathlib.${kind}("python")`)
              )
              const risks = await analyzeNotebookCodeRisk(
                'python',
                prelude +
                  `subprocess.run([${value},${risky ? `"-c",${JSON.stringify("import os;os.unlink('target.txt')")}` : '"--version"'}])`
              )
              if (risky) expect(risks.length).toBeGreaterThan(0)
              else expect(risks).toEqual([])
            })
    it.each([
      'subprocess.run([dict(command=["echo"][0])["command"],"hello"])',
      'subprocess.run([[{"command":"echo"}["command"]][0],"hello"])',
      'subprocess.run([operator.getitem("echo hello".split(),0),"hello"])',
      'subprocess.run([dict(command=" echo ")["command"].strip(),"hello"])',
      'subprocess.run([["echo"][0].upper().lower(),"hello"])',
      'subprocess.run(["echo|rm".split("|")[0],"hello"])',
      'subprocess.run(["rm|echo".rsplit("|")[-1],"hello"])',
      'subprocess.run([["echo".strip()][0],"hello"])',
      'subprocess.run([str([pathlib.Path("echo")][0]),"hello"])',
      'subprocess.run([os.fspath(dict(command=pathlib.Path("echo"))["command"]),"hello"])',
      'subprocess.run([[b"echo"][0],"hello"])',
      'subprocess.run([tuple(list((b"echo",)))[0],"hello"])',
      'subprocess.run([[b"echo"][0:][0],"hello"])',
      'subprocess.run([dict(command=b"echo")["command"],"hello"])',
      'subprocess.run([operator.getitem([b"echo"],0),"hello"])',
      'subprocess.run([operator.itemgetter(0)([b"echo"]),"hello"])',
      'subprocess.run([operator.itemgetter(0)(["echo"]),"hello"],text=(getter:=os.unlink))',
      'subprocess.run([pick(["echo"],0),"hello"],text=(pick:=os.unlink))',
      'saved=list\nbuiltins.list=os.unlink\nsubprocess.run([saved(("echo",))[0],"hello"])'
    ])('retains completed selections, chains and frozen native targets: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    it.each([
      'subprocess.run([["echo",os.unlink("target.txt")][0],"hello"])',
      'subprocess.run([{"command":"echo"}.get("command",os.unlink("target.txt")),"hello"])',
      'subprocess.run([{"command":"echo",os.unlink("target.txt"):"rm"}["command"],"hello"])',
      'subprocess.run([operator.getitem(["echo"],os.unlink("target.txt")),"hello"])',
      'subprocess.run([operator.itemgetter(os.unlink("target.txt"))(["echo"]),"hello"])',
      'subprocess.run([["echo"][index],"hello"])',
      'subprocess.run([{"command":"echo"}[key],"hello"])',
      'subprocess.run([commands[0],"hello"])',
      'commands=["echo"]\ncommands[0]="rm"\nsubprocess.run([commands[0],"target.txt"])',
      'subprocess.run([operator.itemgetter(0,1)(["echo","rm"]),"hello"])',
      'subprocess.run([["echo"][1],"hello"])',
      'subprocess.run([["echo"][-2],"hello"])',
      'subprocess.run([["echo"][1.0],"hello"])',
      'subprocess.run([[b" echo "][0].strip(),"hello"])',
      'subprocess.run(str.split([b"echo hello"][0]))',
      'subprocess.run(["".join([[b"echo"][0]]),"hello"])',
      'subprocess.run([str([b"echo"][0]),"hello"])',
      'subprocess.run([pathlib.Path([b"echo"][0]),"hello"])',
      'subprocess.run([os.fspath([b"echo"][0]),"hello"])',
      'subprocess.run([[b"rm"][0],"target.txt"])',
      'subprocess.run([["echo"][slice(0)],"hello"])',
      'subprocess.run([{}.get("command"),"hello"])',
      'subprocess.run([{}.pop("command"),"hello"])',
      'subprocess.run([{}["command"],"hello"])',
      'subprocess.run([mapping.get("command","echo"),"hello"])',
      'subprocess.run([dict(**mapping).get("command","echo"),"hello"])',
      'subprocess.run([dict(command="echo").get(key,"echo"),"hello"])',
      'subprocess.run([operator.getitem(factory(),0),"hello"])',
      'subprocess.run([operator.getitem(["echo"],**options),"hello"])',
      'subprocess.run([operator.getitem(*values),"hello"])',
      'subprocess.run([operator.itemgetter(0)(values),"hello"])',
      'subprocess.run([({"command":"echo"}|mapping)["command"],"hello"])',
      'subprocess.run([pick(["echo"],0),"hello"])\npick=os.unlink\nsubprocess.run([pick("target.txt"),"hello"])',
      'make=list\nfor item in (0,1):\n subprocess.run([make(("echo",))[0],"hello"])\n make=lambda values:["rm"]',
      'for item in (0,1):\n subprocess.run([getter(dict(command="echo")),"hello"])\n getter=lambda values:os.unlink("target.txt")'
    ])(
      'keeps opaque selections, eager effects and reevaluated syntax reviewable: %s',
      async (code) => {
        expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
      }
    )
    for (const selector of pathSelectors)
      for (const conversion of ['VALUE', 'str(VALUE)', 'os.fspath(VALUE)'])
        it(`preserves late path protocol dependencies ${selector} ${conversion}`, async () => {
          const value = selector.replaceAll(
            'VALUE',
            conversion.replace('VALUE', 'pathlib.Path("python")')
          )
          const code =
            prelude +
            'def hook(self):\n os.unlink("target.txt")\n return "python"\n' +
            'def change():\n pathlib.PurePath.__fspath__=hook\n return True\n' +
            `subprocess.run([${value},"--version"],text=change())`
          const risks = await analyzeNotebookCodeRisk('python', code)
          if (conversion === 'VALUE') expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        })
    it('does not persist selected scalar receipts or discharge replayed factory replacements', async () => {
      const setup = prelude + 'make=list\n'
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'subprocess.run([make(("echo",))[0],"hello"])',
          undefined,
          [setup]
        )
      ).toEqual([])
      for (const incomplete of [false, true])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'subprocess.run([make(("echo",))[0],"hello"])',
              undefined,
              [setup, { script: 'make=lambda values:["rm"]', incomplete }]
            )
          ).length
        ).toBeGreaterThan(0)
      expect(
        (
          await analyzeNotebookCodeRisk('python', 'subprocess.run([command,"hello"])', undefined, [
            setup + 'command=["echo"][0]'
          ])
        ).length
      ).toBeGreaterThan(0)
    })
    it('preserves vector limits when selecting a single slot', async () => {
      for (const value of [
        `[${Array(1025).fill('"echo"').join(',')}][0]`,
        `"${Array(1025).fill('echo').join('|')}".split("|")[0]`,
        `["${'x'.repeat(64_001)}"][0]`
      ])
        expect(
          (await analyzeNotebookCodeRisk('python', prelude + `subprocess.run([${value},"hello"])`))
            .length
        ).toBeGreaterThan(0)
    })
  })

  describe('Python native process text methods', () => {
    const prelude = 'import os,pathlib,subprocess,builtins,operator\n'
    const forms = [
      ['strip', '" COMMAND "', '', ''],
      ['lstrip', '" COMMAND"', '', ''],
      ['rstrip', '"COMMAND "', '', ''],
      ['lower', '"COMMAND"', '', ''],
      ['upper', '"COMMAND"', '', '.lower()'],
      ['casefold', '"COMMAND"', '', ''],
      ['removeprefix', '"prefix-COMMAND"', '"prefix-"', ''],
      ['removesuffix', '"COMMAND-suffix"', '"-suffix"', ''],
      ['replace', '"COMMAND-copy"', '"-copy",""', ''],
      ['join', '""', '["COMMAND"]', '']
    ]
    for (const [method, text, args, suffix] of forms)
      for (const [name, expression] of [
        ['bound', `TEXT.${method}(ARGS)`],
        ['static', `str.${method}(TEXT,ARGS)`],
        ['builtins', `builtins.str.${method}(TEXT,ARGS)`],
        ['alias', 'transform(TEXT,ARGS)'],
        ['forwarded bound', `operator.call(TEXT.${method},ARGS)`],
        ['forwarded static', `operator.call(str.${method},TEXT,ARGS)`]
      ])
        for (const processMethod of ['run', 'call', 'check_call', 'check_output', 'Popen'])
          for (const route of [
            'subprocess.METHOD([VALUE,ARGS])',
            'subprocess.METHOD(tuple(list((VALUE,ARGS))))',
            'subprocess.METHOD(**dict(args=[VALUE,ARGS]))'
          ])
            for (const risky of [false, true])
              it(`classifies ${method} ${name} ${processMethod} ${route} ${risky ? 'erase' : 'query'}`, async () => {
                const command = risky ? 'rm' : 'python'
                const value =
                  expression
                    .replace('TEXT', text)
                    .replace('ARGS', args)
                    .replaceAll('COMMAND', method === 'lower' ? command.toUpperCase() : command) +
                  suffix
                const code =
                  prelude +
                  `transform=str.${method}\n` +
                  route
                    .replace('METHOD', processMethod)
                    .replace('VALUE', value)
                    .replace('ARGS', risky ? '"target.txt"' : '"--version"')
                const risks = await analyzeNotebookCodeRisk('python', code)
                if (risky)
                  expect(risks.map((risk) => risk.operation)).toEqual([
                    `subprocess.${processMethod} nested execution`
                  ])
                else expect(risks).toEqual([])
              })
    it.each([
      'subprocess.run(" echo hello ".strip().split())',
      'subprocess.run(str.split("echo|hello".replace("|"," ")))',
      'subprocess.run("echo|hello".strip().split("|"))',
      'subprocess.run(str.rsplit(" echo hello ".strip()))',
      'subprocess.run([str(pathlib.Path("echo")).strip(),"hello"])',
      'subprocess.run([os.fspath(pathlib.Path("echo")).replace("x",""),"hello"])',
      'subprocess.run(["".join(tuple(list(("e","c","h","o")))),"hello"])',
      'subprocess.run(["".join([*("e","cho")]),"hello"])',
      'subprocess.run(["".join(("e",)+("cho",)),"hello"])',
      'subprocess.run(["".join("echo"),"hello"])',
      'subprocess.run(["".join([str("e"),"cho".strip()]),"hello"])',
      'subprocess.run([" echo ".strip(None),"hello"])',
      'subprocess.run(["xxechoxx".strip("x"),"hello"])',
      'subprocess.run(["echo".strip(""),"hello"])',
      'subprocess.run(["echo".removesuffix(""),"hello"])',
      'subprocess.run(["echo".removeprefix(""),"hello"])',
      'subprocess.run(["echo".replace("e","r",0),"hello"])',
      'subprocess.run(["echo".replace("e","r",False),"hello"])',
      'subprocess.run(["echoecho".replace("echo","",True),"hello"])',
      'subprocess.run(["aaaecho".replace("a","",-99),"hello"])',
      'subprocess.run(["echo".replace("","",2),"hello"])',
      'subprocess.run(["".replace("","echo"),"hello"])',
      'subprocess.run(["xecho".replace("x","",0x1),"hello"])',
      'subprocess.run(["echo","hello"],shell=" ".strip())',
      'subprocess.run("echo".strip() or ["rm","target.txt"])',
      'saved=str.strip\nbuiltins.str=os.unlink\nsubprocess.run([saved(" echo "),"hello"])',
      'subprocess.run([" echo ".strip(),"hello"],text=(transform:=os.unlink))',
      'subprocess.run([transform(" echo "),"hello"],text=(transform:=os.unlink))'
    ])('preserves exact text semantics, chains and completed values: %s', async (code) => {
      expect(
        await analyzeNotebookCodeRisk('python', prelude + 'transform=str.strip\n' + code)
      ).toEqual([])
    })
    it.each([
      'subprocess.run(" rm target.txt ".strip().split())',
      'subprocess.run(["xxrmxx".strip("x"),"target.txt"])',
      'subprocess.run(["rm-safe".replace("-safe",""),"target.txt"])',
      'subprocess.run(["rm".replace("","x").replace("x",""),"target.txt"])',
      'subprocess.run(["".join(["r","m"]),"target.txt"])',
      'subprocess.run(["".join([os.unlink("target.txt"),"echo"]),"hello"])',
      'subprocess.run(["echo".replace("x",os.unlink("target.txt")),"hello"])',
      'subprocess.run(["echo".replace("x","",os.unlink("target.txt")),"hello"])',
      'subprocess.run(["echo".strip(os.unlink("target.txt")),"hello"])',
      'subprocess.run(["echo".strip(chars),"hello"])',
      'subprocess.run(["echo".replace("e","r",count),"hello"])',
      'subprocess.run(["echo".replace("e","r",1.0),"hello"])',
      'subprocess.run(["rm-safe".replace("-safe","",True),"hello"])',
      'subprocess.run(["echo".replace("e","r",999999999999999999999999),"hello"])',
      'subprocess.run(["echo".strip(chars="x"),"hello"])',
      'subprocess.run(["echo".replace("e","r",**mapping),"hello"])',
      'subprocess.run(["echo".strip(*values),"hello"])',
      'subprocess.run(["".join(values),"hello"])',
      'subprocess.run(["".join([b"echo"]),"hello"])',
      'subprocess.run(["".join([pathlib.Path("echo")]),"hello"])',
      'subprocess.run(["".join(list(factory())),"hello"])',
      'subprocess.run([b" echo ".strip(),"hello"])',
      'subprocess.run(["écho".lower(),"hello"])',
      'builtins.str=lambda value:os.unlink("target.txt")\nsubprocess.run([str.strip(" echo "),"hello"])',
      'transform=os.unlink\nsubprocess.run([transform("target.txt"),"hello"])',
      'def change():\n builtins.str=os.unlink\nchange()\nsubprocess.run([str.strip(" echo "),"hello"])'
    ])(
      'keeps changed targets, eager effects and unproven protocols reviewable: %s',
      async (code) => {
        expect(
          (await analyzeNotebookCodeRisk('python', prelude + 'transform=str.strip\n' + code)).length
        ).toBeGreaterThan(0)
      }
    )
    it('replays native method aliases and possible replacements without retaining node text', async () => {
      const setup = prelude + 'transform=str.strip\n'
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'subprocess.run([transform(" echo "),"hello"])',
          undefined,
          [setup]
        )
      ).toEqual([])
      for (const incomplete of [false, true])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'subprocess.run([transform("target.txt"),"hello"])',
              undefined,
              [setup, { script: 'transform=os.unlink', incomplete }]
            )
          ).length
        ).toBeGreaterThan(0)
      expect(
        (
          await analyzeNotebookCodeRisk('python', 'subprocess.run([command,"hello"])', undefined, [
            setup + 'command=" echo ".strip()'
          ])
        ).length
      ).toBeGreaterThan(0)
    })
    it('bounds each native input/output and iterable without executing user protocols', async () => {
      for (const value of [
        `${JSON.stringify('x'.repeat(4097))}.strip()`,
        `"x".replace("x",${JSON.stringify('x'.repeat(4097))})`,
        `"x".replace("",${JSON.stringify('x'.repeat(2048))})`,
        `"".join([${Array(1025).fill('""').join(',')}])`,
        `"".join(list([${Array(129).fill('""').join(',')}]))`
      ])
        expect(
          (await analyzeNotebookCodeRisk('python', prelude + `subprocess.run([${value},"hello"])`))
            .length
        ).toBeGreaterThan(0)
    })
  })

  describe('Python native process path values', () => {
    const prelude = 'import os,pathlib,subprocess,builtins,operator\n'
    const kinds = [
      'Path',
      'PurePath',
      'PosixPath',
      'PurePosixPath',
      'WindowsPath',
      'PureWindowsPath'
    ]
    const conversions = ['VALUE', 'str(VALUE)', 'os.fspath(VALUE)']
    const routes = [
      'subprocess.METHOD([VALUE,ARGS])',
      'subprocess.METHOD(tuple(list((VALUE,ARGS))))',
      'subprocess.METHOD([*(VALUE,ARGS)])',
      'subprocess.METHOD(["ignored",VALUE,ARGS][1:])',
      'subprocess.METHOD(**dict(args=[VALUE,ARGS]))',
      'subprocess.METHOD(["argv0",ARGS],executable=VALUE)',
      'operator.call(subprocess.METHOD,[VALUE,ARGS])'
    ]
    for (const kind of kinds)
      for (const conversion of conversions)
        for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen'])
          for (const route of routes)
            for (const risky of [false, true])
              it(`classifies path ${kind} ${conversion} ${method} ${route} ${risky ? 'script' : 'query'}`, async () => {
                const value = conversion.replace('VALUE', `pathlib.${kind}("python")`)
                const code =
                  prelude +
                  route
                    .replaceAll('METHOD', method)
                    .replaceAll('VALUE', value)
                    .replace(
                      'ARGS',
                      risky ? '"-c","import os;os.unlink(\'target.txt\')"' : '"--version"'
                    )
                const risks = await analyzeNotebookCodeRisk('python', code)
                if (risky) expect(risks.length).toBeGreaterThan(0)
                else expect(risks).toEqual([])
              })
    it.each([
      'subprocess.run([str("echo"),"hello"])',
      'subprocess.run([os.fspath("echo"),"hello"])',
      'subprocess.run(str("echo") or ["echo"])',
      'subprocess.run(["echo","hello"],shell=str(""))',
      'subprocess.run([builtins.str(pathlib.Path("echo")),"hello"])',
      'subprocess.run([operator.call(str,pathlib.Path("echo")),"hello"])',
      'subprocess.run([operator.call(os.fspath,pathlib.PurePath("echo")),"hello"])',
      'subprocess.run([pathlib.Path(pathlib.PurePath("echo")),"hello"])',
      'subprocess.run([pathlib.PurePosixPath("./bin//echo/."),"hello"])',
      'subprocess.run([pathlib.PurePosixPath("../bin/echo/"),"hello"])',
      'subprocess.run([pathlib.PurePosixPath("//bin/echo"),"hello"])',
      'subprocess.run([pathlib.PurePosixPath("///bin/echo"),"hello"])',
      'subprocess.run([pathlib.PurePosixPath("echo/../python"),"--version"])',
      'subprocess.run(["env",pathlib.Path("python"),"--version"])',
      'saved=str\nbuiltins.str=lambda value:"rm"\nsubprocess.run([saved(pathlib.Path("echo")),"hello"])',
      'saved=os.fspath\nos.fspath=lambda value:"rm"\nsubprocess.run([saved(pathlib.Path("echo")),"hello"])'
    ])('preserves native query, normalization and frozen converters: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    const hook = 'def hook(self):\n os.unlink("target.txt")\n return "echo"\n'
    for (const conversion of ['str', 'os.fspath'])
      for (const wrapper of [
        '[VALUE,"hello"]',
        'list((VALUE,"hello"))',
        'tuple((VALUE,"hello"))[0:]'
      ])
        it(`freezes already converted ${conversion} through ${wrapper}`, async () => {
          const code =
            prelude +
            hook +
            'subprocess.run(' +
            wrapper.replace('VALUE', `${conversion}(pathlib.Path("echo"))`) +
            ',cwd=(setattr(pathlib.PurePath,"__str__",hook),None)[1])'
          expect(await analyzeNotebookCodeRisk('python', code)).toEqual([])
        })
    it.each([
      'pathlib.PurePath.__fspath__=hook\nsubprocess.run([pathlib.Path("echo"),"hello"])',
      'pathlib.PurePath.__str__=hook\nsubprocess.run([str(pathlib.Path("echo")),"hello"])',
      'pathlib.Path.__init__=hook\nsubprocess.run([pathlib.Path("echo"),"hello"])',
      'pathlib.PurePath.__fspath__=hook\nsubprocess.run(["echo",pathlib.Path("hello")])',
      'subprocess.run([pathlib.Path("echo"),"hello"],cwd=(setattr(pathlib.PurePath,"__fspath__",hook),None)[1])',
      'subprocess.run(list((pathlib.Path("echo"),"hello")),cwd=(setattr(pathlib.PurePath,"__fspath__",hook),None)[1])',
      'subprocess.run(tuple((pathlib.Path("echo"),"hello"))[0:],cwd=(setattr(pathlib.PurePath,"__fspath__",hook),None)[1])',
      'def change():pathlib.PurePath.__fspath__=hook\nchange()\nsubprocess.run([pathlib.Path("echo"),"hello"])',
      'name=lookup()\nsetattr(pathlib.PurePath,name,hook)\nsubprocess.run([pathlib.Path("echo"),"hello"])',
      'delattr(pathlib.PurePath,"__fspath__")\nsubprocess.run([pathlib.Path("echo"),"hello"])',
      'subprocess.run([pathlib.Path("echo"),"hello"],cwd=os.unlink("target.txt"))',
      'pathlib.Path=lambda value:os.unlink("target.txt")\nsubprocess.run([pathlib.Path("echo"),"hello"])',
      'os.fspath=lambda value:os.unlink("target.txt")\nsubprocess.run([os.fspath("echo"),"hello"])',
      'builtins.str=lambda value:os.unlink("target.txt")\nsubprocess.run([str("echo"),"hello"])',
      'subprocess.run([pathlib.Path("rm/"),"target.txt"])',
      'subprocess.run([str(pathlib.Path("rm/.")),"target.txt"])',
      'subprocess.run([pathlib.Path("cleanup.py"),"--help"])',
      'subprocess.run([pathlib.Path("echo"),"hello"],shell=True)',
      'subprocess.run([str(b"echo"),"hello"])',
      'subprocess.run([pathlib.Path(value),"hello"])',
      'subprocess.run([pathlib.Path("echo",unknown),"hello"])',
      'subprocess.run(**dict(args=["echo",factory()]))'
    ])(
      'keeps protocol mutation, source effects and unknown construction reviewable: %s',
      async (code) => {
        expect(
          (await analyzeNotebookCodeRisk('python', prelude + hook + code)).length
        ).toBeGreaterThan(0)
      }
    )
    for (const kind of ['PurePosixPath', 'PureWindowsPath'])
      for (const root of [
        './tools//python.exe/.',
        'C:/tools/python.exe',
        '//server/share/python.exe',
        '///bin/python.exe'
      ])
        it(`respects path flavor ${kind} ${root}`, async () => {
          const risky =
            kind === 'PureWindowsPath' && (process.platform !== 'win32' || root.startsWith('///'))
          const risks = await analyzeNotebookCodeRisk(
            'python',
            prelude + `subprocess.run([pathlib.${kind}(${JSON.stringify(root)}),"--version"])`
          )
          if (risky) expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        })
    it('keeps original constructor aliases without granting replaced constructors', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          prelude +
            'saved=pathlib.PurePosixPath\npathlib.PurePosixPath=lambda value:os.unlink("target.txt")\nsubprocess.run([saved("echo"),"hello"])'
        )
      ).toEqual([])
    })
    it('replays completed and incomplete protocol writes before new path construction', async () => {
      const current = 'subprocess.run([pathlib.Path("echo"),"hello"])'
      for (const incomplete of [false, true])
        expect(
          (
            await analyzeNotebookCodeRisk('python', current, undefined, [
              prelude + hook,
              { script: 'pathlib.PurePath.__fspath__=hook', incomplete }
            ])
          ).length
        ).toBeGreaterThan(0)
      expect(await analyzeNotebookCodeRisk('python', current, undefined, [prelude])).toEqual([])
    })
    it('bounds proven conversion text and keeps unpacked protocols opaque', async () => {
      for (const source of [
        `subprocess.run([str(${JSON.stringify('x'.repeat(4097))}),"--version"])`,
        'subprocess.run([pathlib.Path(*values),"--version"])',
        'subprocess.run([os.fspath(**mapping),"--version"])'
      ])
        expect((await analyzeNotebookCodeRisk('python', prelude + source)).length).toBeGreaterThan(
          0
        )
    })
  })

  describe('Python native callable container construction', () => {
    const prelude =
      'import os,operator,builtins,pathlib,functools\nmake_seq=list\nmake_map=dict\ndef read(*args): return "test"\ndef erase(*args): os.unlink("target.txt")\n'
    const forms = [
      'list((FUNC,))[0]',
      'tuple([FUNC])[0]',
      'list(tuple([FUNC]))[0]',
      'tuple(list((FUNC,)))[0]',
      'builtins.list([FUNC])[False]',
      'builtins.tuple((str,FUNC))[-1]',
      'make_seq([FUNC])[0]',
      'list([*(FUNC,)])[0]',
      'tuple(([FUNC]+[]))[0]',
      'operator.call(list,(FUNC,))[0]',
      'operator.__call__(tuple,[FUNC])[0]',
      'operator.getitem(list((FUNC,)),0)',
      'operator.itemgetter(0)(tuple([FUNC]))',
      'operator.call(operator.getitem,tuple([FUNC]),0)',
      'dict(read=FUNC)["read"]',
      'dict({"read":FUNC})["read"]',
      'dict([("read",FUNC)])["read"]',
      'dict((("read",FUNC),))["read"]',
      'dict(dict(read=FUNC))["read"]',
      'builtins.dict(read=FUNC)["read"]',
      'make_map(read=FUNC)["read"]',
      'dict(**{"read":FUNC})["read"]',
      'dict({"read":str},read=FUNC)["read"]',
      'dict({"read":str}|{"read":FUNC})["read"]',
      'dict(read=FUNC).get("read")',
      'dict(read=FUNC).pop("read")',
      'dict(read=FUNC).setdefault("read",str)',
      'dict.get(dict(read=FUNC),"read")',
      'operator.getitem(dict(read=FUNC),"read")',
      'operator.itemgetter("read")(dict(read=FUNC))',
      'operator.call(dict,read=FUNC)["read"]',
      'dict().get("read",FUNC)'
    ]
    for (const form of forms)
      for (const [reader, erase] of [
        ['str', 'os.unlink'],
        ['open("target.txt").read', 'pathlib.Path("target.txt").unlink'],
        ['pathlib.Path("target.txt").read_text', 'functools.partial(os.unlink,"target.txt")'],
        ['read', 'erase']
      ])
        for (const route of ['selected("target.txt")', 'operator.call(selected,"target.txt")'])
          for (const risky of [false, true])
            it(`classifies ${risky ? 'deletion' : 'reader'} ${reader} in ${form} via ${route}`, async () => {
              const code =
                prelude +
                'selected=' +
                form.replaceAll('FUNC', risky ? erase : reader) +
                '\n' +
                route
              const risks = await analyzeNotebookCodeRisk('python', code)
              if (risky) expect(risks.some((risk) => risk.operation.includes('unlink'))).toBe(true)
              else expect(risks).toEqual([])
            })
    it.each([
      'list([str,lambda:os.unlink("target.txt")])[0]("test")',
      'tuple((lambda:os.unlink("target.txt"),str))[-1]("test")',
      'dict(read=str,erase=lambda:os.unlink("target.txt"))["read"]("test")',
      'dict({"read":lambda:os.unlink("target.txt")},read=str)["read"]("test")',
      'dict([("read",lambda:os.unlink("target.txt")),("read",str)])["read"]("test")',
      'dict(read=str).get("read",lambda:os.unlink("target.txt"))("test")',
      'dict(read=str).pop("read",lambda:os.unlink("target.txt"))("test")',
      'dict(read=str).setdefault("read",lambda:os.unlink("target.txt"))("test")',
      'dict(read="test".upper)["read"]()',
      'list((str.strip,))[0](" test ")',
      'dict(read=str).get("missing",str)("test")',
      'dict(read=str).pop("missing",str)("test")',
      'dict(read=str).setdefault("missing",str)("test")'
    ])('preserves non-invoked native members: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    it.each([
      'list([lambda:os.unlink("target.txt")])[0]()',
      'dict(read=lambda:os.unlink("target.txt"))["read"]()',
      'dict([("read",str),("read",lambda:os.unlink("target.txt"))])["read"]()',
      'dict(read=str).get("missing",lambda:os.unlink("target.txt"))()',
      'dict(read=str).pop("missing",lambda:os.unlink("target.txt"))()',
      'dict(read=str).setdefault("missing",lambda:os.unlink("target.txt"))()',
      'list([str,lambda default=os.unlink("target.txt"):0])[0]("test")',
      'dict({"read":lambda default=os.unlink("target.txt"):0},read=str)["read"]("test")',
      'dict(read=str,other=os.unlink("target.txt"))["read"]("test")',
      'operator.getitem(list((str,)),(os.unlink("target.txt"),0)[1])("test")',
      'dict(read=str).get("read",os.unlink("target.txt"))("test")',
      'list([str,(str:=os.unlink)])[0]("target.txt")',
      'dict(read=str,other=(str:=os.unlink))["read"]("target.txt")',
      'class Values:\n def __iter__(self):\n  os.unlink("target.txt")\n  return iter((str,))\nlist(Values())[0]("test")',
      'class Values:\n def keys(self):\n  os.unlink("target.txt")\n  return ("read",)\n def __getitem__(self,key):return str\ndict(Values())["read"]("test")',
      'saved=list\nlist=lambda values:[os.unlink]\nlist((str,))[0]("target.txt")',
      'saved=dict\ndict=lambda **kwargs:{"read":os.unlink}\ndict(read=str)["read"]("target.txt")',
      'builtins.list=lambda values:[os.unlink]\nbuiltins.list((str,))[0]("target.txt")',
      'setattr(builtins,"dict",lambda **kwargs:{"read":os.unlink})\nbuiltins.dict(read=str)["read"]("target.txt")',
      'values=list((str,))\nvalues[0]=os.unlink\nvalues[0]("target.txt")',
      'values=dict(read=str)\nvalues["read"]=os.unlink\nvalues["read"]("target.txt")',
      'for make_seq in [list,erase]:\n make_seq((str,))[0]("target.txt")'
    ])('retains construction, defaults, unknown hooks and replaced targets: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    for (const definition of [
      'selected=list((str,))[0]',
      'selected=dict(read=str)["read"]',
      'saved=list\nbuiltins.list=erase\nselected=saved((str,))[0]',
      'saved=dict\nbuiltins.dict=erase\nselected=saved(read=str)["read"]'
    ])
      it(`freezes reader function across later writes and history: ${definition}`, async () => {
        const setup = prelude + definition + '\nbuiltins.str=os.unlink\n'
        expect(
          await analyzeNotebookCodeRisk('python', 'selected("test")', undefined, [setup])
        ).toEqual([])
        expect(await analyzeNotebookCodeRisk('python', setup + 'selected("test")')).toEqual([])
      })
    it('keeps destructive bindings across incomplete constructor replacement', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk('python', 'selected("target.txt")', undefined, [
            prelude + 'selected=dict(read=os.unlink)["read"]',
            { script: 'selected=list((str,))[0]', incomplete: true }
          ])
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      ['sorted(INPUT,**dict(key=os.unlink))', '[]', '["target.txt"]'],
      ['list(itertools.groupby(INPUT,**dict(key=os.unlink)))', '[]', '["target.txt"]'],
      ['heapq.nlargest(1,INPUT,**dict(key=os.unlink))', '[]', '["target.txt"]'],
      ['list(map(dict(fn=os.unlink)["fn"],INPUT))', '[]', '["target.txt"]']
    ])('consumes known callbacks from native dictionaries: %s', async (code, empty, active) => {
      const imports = prelude + 'import itertools,heapq\n'
      expect(
        await analyzeNotebookCodeRisk('python', imports + code.replace('INPUT', empty))
      ).toEqual([])
      expect(
        (await analyzeNotebookCodeRisk('python', imports + code.replace('INPUT', active))).length
      ).toBeGreaterThan(0)
    })
    it('applies member side effects only when a selected named callback executes', async () => {
      const setup = prelude + 'def callback(value):\n os.path.exists=os.unlink\n return value\n'
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          setup + 'list(map(dict(fn=callback)["fn"],[]))\nos.path.exists("target.txt")'
        )
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            setup +
              'list(map(dict(fn=callback)["fn"],["target.txt"]))\nos.path.exists("target.txt")'
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it('bounds copied callable members and nesting without accepting unknown targets', async () => {
      for (const source of [
        `list([str,${Array(128).fill('str').join(',')}])[0]("test")`,
        'list('.repeat(65) + '(str,)' + ')'.repeat(65) + '[0]("test")',
        'dict(read=unknown)["read"]("test")'
      ])
        expect((await analyzeNotebookCodeRisk('python', prelude + source)).length).toBeGreaterThan(
          0
        )
    })
  })

  describe('Python native empty callback inputs', () => {
    const prelude =
      'import os,shutil,subprocess,operator,functools,itertools,heapq,bisect,builtins,io\ndef erase(*args):\n    os.unlink("target.txt")\n    return 0\n'
    const consumers = [
      ['map', 'CALLBACK,VALUES', 'list'],
      ['builtins.map', 'CALLBACK,[1],VALUES', 'list'],
      ['filter', 'CALLBACK,VALUES', 'list'],
      ['builtins.filter', 'CALLBACK,VALUES', 'list'],
      ...['starmap', 'dropwhile', 'takewhile', 'filterfalse'].map((method) => [
        `itertools.${method}`,
        'CALLBACK,VALUES',
        'list'
      ]),
      ['functools.reduce', 'CALLBACK,VALUES,0', ''],
      ['itertools.accumulate', 'VALUES,CALLBACK,initial=0', 'list'],
      ['itertools.accumulate', 'VALUES,**{"func":CALLBACK,"initial":0}', 'list'],
      ['itertools.groupby', 'VALUES,CALLBACK', 'list'],
      ['itertools.groupby', 'VALUES,key=CALLBACK', 'list'],
      ['sorted', 'VALUES,key=CALLBACK', ''],
      ['builtins.sorted', 'VALUES,**{"key":CALLBACK,"reverse":False}', ''],
      ['min', 'VALUES,key=CALLBACK,default=0', ''],
      ['builtins.max', 'VALUES,key=CALLBACK,default=0', ''],
      ['heapq.nlargest', '1,VALUES,key=CALLBACK', ''],
      ['heapq.nsmallest', '1,VALUES,**{"key":CALLBACK}', ''],
      ['bisect.bisect', 'VALUES,1,key=CALLBACK', ''],
      ['bisect.bisect_left', 'VALUES,1,key=CALLBACK', ''],
      ['bisect.bisect_right', 'VALUES,1,key=CALLBACK', '']
    ]
    const callbacks = [
      'lambda *args:os.unlink("target.txt")',
      'lambda *args:os.remove("target.txt")',
      'lambda *args:shutil.rmtree("target-dir")',
      'erase'
    ]
    for (const [target, template, wrapper] of consumers)
      for (const empty of ['[]', '()', '[*[]]+[]'])
        for (const callback of callbacks)
          for (const route of ['direct', 'forwarded'])
            it(`does not invoke empty callback target=${target} input=${empty} callback=${callback} route=${route}`, async () => {
              const code = (active: boolean): string => {
                const values = active ? (target.endsWith('starmap') ? '[(1,)]' : '[1]') : empty
                const args = template.replaceAll('CALLBACK', callback).replaceAll('VALUES', values)
                const call =
                  route === 'direct' ? `${target}(${args})` : `operator.call(${target},${args})`
                return prelude + (wrapper ? `${wrapper}(${call})` : call)
              }
              expect(await analyzeNotebookCodeRisk('python', code(false))).toEqual([])
              expect((await analyzeNotebookCodeRisk('python', code(true))).length).toBeGreaterThan(
                0
              )
            })
    it.each(consumers)(
      'recognizes saved native consumer %s %s',
      async (target, template, wrapper) => {
        const args = template.replaceAll('CALLBACK', 'erase').replaceAll('VALUES', '[]')
        const call = `consume(${args})`
        const invoke = wrapper ? `${wrapper}(${call})` : call
        expect(
          await analyzeNotebookCodeRisk('python', prelude + `consume=${target}\n${invoke}`)
        ).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              prelude +
                `consume=${target}\n${invoke.replaceAll('[]', target.endsWith('starmap') ? '[(1,)]' : '[1]')}`
            )
          ).length
        ).toBeGreaterThan(0)
      }
    )
    for (const target of [
      '[].sort',
      '[*[]].sort',
      '([]+[]).sort',
      'list.sort',
      'builtins.list.sort'
    ])
      for (const callback of callbacks)
        it(`keeps fresh empty list sorting callback inert ${target} ${callback}`, async () => {
          const args = `${target.endsWith('list.sort') ? '[],' : ''}key=${callback}`
          const code = `${target}(${args})`
          expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
          expect(
            (await analyzeNotebookCodeRisk('python', prelude + code.replaceAll('[]', '[1]'))).length
          ).toBeGreaterThan(0)
        })
    for (const target of ['heapq.nlargest', 'heapq.nsmallest'])
      for (const callback of callbacks)
        it(`keeps a zero native heap result inert ${target} ${callback}`, async () => {
          const code = `${target}(0,[1],key=${callback})`
          expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
          expect(
            (await analyzeNotebookCodeRisk('python', prelude + code.replace('(0,', '(1,'))).length
          ).toBeGreaterThan(0)
        })
    for (const target of ['open', 'builtins.open', 'io.open'])
      for (const args of [
        '9,opener=CALLBACK',
        'file=9,**{"opener":CALLBACK}',
        '9,**dict(opener=CALLBACK)'
      ])
        for (const callback of callbacks)
          it(`ignores literal descriptor opener ${target} ${args} ${callback}`, async () => {
            const code = `${target}(${args.replaceAll('CALLBACK', callback)}).read()`
            expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
            expect(
              (
                await analyzeNotebookCodeRisk(
                  'python',
                  prelude + code.replaceAll('9', '"target.txt"')
                )
              ).length
            ).toBeGreaterThan(0)
          })
    it.each([
      'list(map(lambda x,tag=os.unlink("target.txt"):x,[]))',
      'sorted([],key=lambda x,tag=os.unlink("target.txt"):x)',
      'sorted([],key=erase,reverse=os.unlink("target.txt"))',
      'min([],key=erase,default=os.unlink("target.txt"))',
      'functools.reduce(erase,[],os.unlink("target.txt"))',
      'list(itertools.accumulate([],func=erase,initial=os.unlink("target.txt")))',
      'list(map(erase,[os.unlink("target.txt")],[]))',
      'heapq.nlargest(0,[os.unlink("target.txt")],key=erase)',
      'bisect.bisect([],os.unlink("target.txt"),key=erase)',
      'list(map((saved:=lambda *args:os.unlink("target.txt")),[]));saved()',
      'list(map(erase,unknown,[]))',
      'items=[];items.append(1);list(map(erase,items))',
      'items=[];alias=items;alias.append(1);items.sort(key=erase)',
      'list(map(erase,[*unknown],[]))',
      'list(map(erase,[],factory()))',
      'sorted([],**options)',
      'list(itertools.groupby([],**dict(key=unknown)))',
      'bisect.insort([],1,key=erase)',
      'bisect.insort_left([],1,key=erase)',
      'bisect.insort_right([],1,key=erase)',
      'functools.partial(map,erase,[1])()',
      'functools.partial(sorted,[1],key=erase)()',
      'map=custom;list(map(lambda *args:os.unlink("target.txt"),[]))',
      'builtins.map=custom;list(map(lambda *args:os.unlink("target.txt"),[]))',
      'itertools.starmap=custom;list(itertools.starmap(lambda *args:os.unlink("target.txt"),[]))',
      'heapq.nlargest=custom;heapq.nlargest(0,[1],key=lambda *args:os.unlink("target.txt"))',
      'for values in ([],[1]):\n    list(map(erase,values))',
      'open(9,opener=lambda p,f,tag=os.unlink("target.txt"):0)',
      'open(file=path,opener=erase)',
      'list(map(lambda:os.unlink("target.txt"),[],[value]*(129)))'
    ])('preserves eager effects, mutable inputs and active callbacks: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    it.each([
      `list(map(lambda *args:os.unlink("target.txt"),[],[${Array(129).fill('1').join(',')}]))`,
      `list(map(lambda *args:os.unlink("target.txt"),${Array(129).fill('[]').join(',')}))`,
      'class Values:\n    def __iter__(self):\n        os.unlink("target.txt")\n        return iter(())\nlist(map(lambda *args:0,[*Values()],[]))',
      'class Values:\n    def __iter__(self):\n        os.unlink("target.txt")\n        return iter(())\nobj=Values()\nlist(map(lambda *args:0,[*obj.__iter__()],[]))'
    ])('keeps callback bounds and prefix spread iteration conservative: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    it.each([
      'list(map(lambda *args:0,unknown,[]))',
      'list(map(lambda *args:0,[],unknown))',
      'list(map(lambda *args:0,[*unknown],[]))',
      'list(map(lambda *args:0,[],[*unknown]))'
    ])('does not hide opaque iterator creation behind an empty input: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([
        expect.objectContaining({ operation: 'dynamic iterable target' })
      ])
    })
    it.each([
      ['itertools.starmap', 'lambda *args:0,[]', 'list'],
      ['heapq.nlargest', '0,[1],key=lambda *args:0', ''],
      ['bisect.bisect', '[],1,key=lambda *args:0', '']
    ])(
      'captures native aliases and tracks member replacement for %s',
      async (target, args, wrapper) => {
        const setup =
          prelude +
          'def custom(*args,**kwargs):\n    os.unlink("target.txt")\n    return []\n' +
          `saved=${target}\n${target}=custom\n`
        const call = (fn: string): string =>
          wrapper ? `${wrapper}(${fn}(${args}))` : `${fn}(${args})`
        expect(await analyzeNotebookCodeRisk('python', setup + call('saved'))).toEqual([])
        expect(
          (await analyzeNotebookCodeRisk('python', setup + call(target))).length
        ).toBeGreaterThan(0)
      }
    )
    for (const target of ['itertools.filterfalse', 'heapq.nsmallest', 'bisect.bisect_left'])
      for (const replace of [
        `${target}=custom`,
        `setattr(${target.split('.')[0]},"${target.split('.')[1]}",custom)`,
        `delattr(${target.split('.')[0]},"${target.split('.')[1]}")`
      ])
        it(`does not certify a replaced callback consumer ${replace}`, async () => {
          const args = target.startsWith('itertools')
            ? 'lambda *args:os.unlink("target.txt"),[]'
            : target.startsWith('heapq')
              ? '0,[1],key=lambda *args:os.unlink("target.txt")'
              : '[],1,key=lambda *args:os.unlink("target.txt")'
          expect(
            (await analyzeNotebookCodeRisk('python', prelude + replace + `\n${target}(${args})`))
              .length
          ).toBeGreaterThan(0)
        })
    for (const incomplete of [false, true])
      it(`retains replay provenance for empty callback consumers incomplete=${incomplete}`, async () => {
        const prior =
          prelude +
          'def custom(*args):\n    os.unlink("target.txt")\n    return []\nconsume=custom\n'
        const ordinary = await analyzeNotebookCodeRisk(
          'python',
          'list(consume(erase,[]))',
          undefined,
          [
            { script: prior, incomplete: false },
            { script: 'consume=map', incomplete }
          ]
        )
        if (incomplete) expect(ordinary.length).toBeGreaterThan(0)
        else expect(ordinary).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk('python', 'list(consume(erase,[1]))', undefined, [
              { script: prior, incomplete: false },
              { script: 'consume=map', incomplete }
            ])
          ).length
        ).toBeGreaterThan(0)
      })
    it('does not apply unexecuted callback member writes', async () => {
      const setup =
        'import os\nos.remove=str\ndef change(*args):\n    os.remove=os.unlink\n    return 0\n'
      expect(
        await analyzeNotebookCodeRisk('python', setup + 'list(map(change,[]));os.remove("test")')
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            setup + 'list(map(change,[1]));os.remove("target.txt")'
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it('does not retain an empty input proof for a later active callback', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude + 'list(map(erase,[]));list(map(erase,[1]))'
          )
        ).length
      ).toBeGreaterThan(0)
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude +
              'def custom(callback,items):\n    return [callback()]\nconsume=map\nfor flag in (False,True):\n    list(consume(lambda *args:os.unlink("target.txt"),[]))\n    consume=custom'
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })
  describe('Python discarded anonymous callback evidence', () => {
    const prelude =
      'import os,io,builtins,operator,shutil,subprocess,functools\nfrom builtins import dict as D\npick=operator.itemgetter(0)\n'
    const mappings = [
      '{"cleanup":EARLY,"cleanup":FINAL}',
      '{**{"cleanup":EARLY},"cleanup":FINAL}',
      '{"cleanup":EARLY,**{"cleanup":FINAL}}',
      '({"cleanup":EARLY}|{"cleanup":FINAL})',
      '{**({"cleanup":EARLY}|{"cleanup":FINAL})}',
      'dict({"cleanup":EARLY},cleanup=FINAL)',
      'builtins.dict({"cleanup":EARLY},cleanup=FINAL)',
      'D([("cleanup",EARLY)],cleanup=FINAL)',
      'dict((("cleanup",EARLY),),cleanup=FINAL)',
      'dict(dict({"cleanup":EARLY}),cleanup=FINAL)',
      'operator.call(dict,{"cleanup":EARLY},cleanup=FINAL)',
      'dict(**{"cleanup":EARLY,"cleanup":FINAL})',
      '{"cleanup":EARLY,**dict(cleanup=FINAL)}',
      '{"cleanup":EARLY,**dict(dict(cleanup=FINAL))}',
      '{"cleanup":EARLY,**operator.call(D,cleanup=FINAL)}',
      '({**{"cleanup":EARLY}}|dict(cleanup=FINAL))'
    ]
    const bodies = [
      'lambda:os.unlink("target.txt")',
      'lambda:os.remove("target.txt")',
      'lambda:shutil.rmtree("target-dir")',
      'lambda:subprocess.run(["rm","target.txt"],check=True)'
    ]
    for (const form of mappings)
      for (const body of bodies)
        it(`discards overwritten callback form=${form} body=${body}`, async () => {
          const code = (active: boolean): string =>
            prelude +
            `metadata=${form.replaceAll('EARLY', active ? 'None' : body).replaceAll('FINAL', active ? body : 'None')}\n` +
            (active ? 'metadata["cleanup"]()' : 'assert metadata["cleanup"] is None')
          expect(await analyzeNotebookCodeRisk('python', code(false))).toEqual([])
          expect((await analyzeNotebookCodeRisk('python', code(true))).length).toBeGreaterThan(0)
        })
    const selections = [
      ['operator.itemgetter(0)((str,LAMBDA))', 'operator.itemgetter(1)((str,LAMBDA))'],
      ['pick((str,LAMBDA))', 'operator.itemgetter(1)((str,LAMBDA))'],
      ['operator.getitem([str,LAMBDA],0)', 'operator.getitem([str,LAMBDA],1)'],
      ['operator.__getitem__((str,LAMBDA),0)', 'operator.__getitem__((str,LAMBDA),1)'],
      [
        'operator.call(operator.getitem,[str,LAMBDA],0)',
        'operator.call(operator.getitem,[str,LAMBDA],1)'
      ],
      ['(str,LAMBDA)[0]', '(str,LAMBDA)[1]'],
      [
        'operator.itemgetter("read")({"read":str,"cleanup":LAMBDA})',
        'operator.itemgetter("cleanup")({"read":str,"cleanup":LAMBDA})'
      ],
      ['{"read":str,"cleanup":LAMBDA}["read"]', '{"read":str,"cleanup":LAMBDA}["cleanup"]'],
      ...['get', 'pop', 'setdefault'].flatMap((method) => [
        [
          `dict.${method}({"read":str,"cleanup":LAMBDA},"read")`,
          `dict.${method}({"read":str,"cleanup":LAMBDA},"cleanup")`
        ],
        [
          `{"read":str,"cleanup":LAMBDA}.${method}("read")`,
          `{"read":str,"cleanup":LAMBDA}.${method}("cleanup")`
        ],
        [
          `operator.call(dict.${method},{"read":str,"cleanup":LAMBDA},"read")`,
          `operator.call(dict.${method},{"read":str,"cleanup":LAMBDA},"cleanup")`
        ]
      ]),
      [
        'operator.itemgetter(1)((LAMBDA,open("target.txt",**dict(mode="r")).read))',
        'operator.itemgetter(0)((LAMBDA,open("target.txt",**dict(mode="r")).read))'
      ],
      [
        'operator.itemgetter(0)((str,LAMBDA,dict(tag="data")))',
        'operator.itemgetter(1)((str,LAMBDA,dict(tag="data")))'
      ]
    ]
    for (const [reader, erase] of selections)
      for (const body of bodies)
        it(`selects only reachable callback reader=${reader} body=${body}`, async () => {
          const args = reader.includes('.read') ? '' : '"test"'
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              prelude + `${reader.replaceAll('LAMBDA', body)}(${args})`
            )
          ).toEqual([])
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              prelude + `saved=${reader.replaceAll('LAMBDA', body)};pick=str;saved(${args})`
            )
          ).toEqual([])
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude + `${erase.replaceAll('LAMBDA', body)}()`
              )
            ).length
          ).toBeGreaterThan(0)
        })
    for (const form of mappings)
      for (const target of ['open', 'builtins.open', 'io.open'])
        it(`uses final native file opener target=${target} form=${form}`, async () => {
          const options = form.replaceAll('cleanup', 'opener')
          const safe = options
            .replaceAll('EARLY', 'lambda p,f:os.unlink(p)')
            .replaceAll('FINAL', 'None')
          const danger = options
            .replaceAll('EARLY', 'None')
            .replaceAll('FINAL', 'lambda p,f:os.unlink(p)')
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              prelude + `getattr(${target}("target.txt",**${safe}),"read",os.unlink)()`
            )
          ).toEqual([])
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude + `${target}("target.txt",**${danger}).read()`
              )
            ).length
          ).toBeGreaterThan(0)
        })
    for (const form of mappings)
      for (const route of [
        'sorted([2,1],**OPTIONS)',
        '[2,1].sort(**OPTIONS)',
        'operator.methodcaller("sort",**OPTIONS)([2,1])'
      ])
        it(`uses final native sorting callback route=${route} form=${form}`, async () => {
          const options = form.replaceAll('cleanup', 'key')
          const safe = options
            .replaceAll('EARLY', 'lambda v:os.unlink("target.txt")')
            .replaceAll('FINAL', 'None')
          const danger = options
            .replaceAll('EARLY', 'None')
            .replaceAll('FINAL', 'lambda v:os.unlink("target.txt")')
          expect(
            await analyzeNotebookCodeRisk('python', prelude + route.replaceAll('OPTIONS', safe))
          ).toEqual([])
          expect(
            (await analyzeNotebookCodeRisk('python', prelude + route.replaceAll('OPTIONS', danger)))
              .length
          ).toBeGreaterThan(0)
        })
    it.each([
      'metadata={"cleanup":lambda:os.unlink("target.txt"),"cleanup":None,"other":os.unlink("target.txt")}',
      'metadata={"cleanup":lambda tag=os.unlink("target.txt"):None,"cleanup":None}',
      'metadata={"cleanup":(saved:=lambda:os.unlink("target.txt")),"cleanup":None};saved()',
      'metadata={"cleanup":lambda:os.unlink("target.txt"),**mapping};metadata["cleanup"]()',
      'metadata={"cleanup":lambda:os.unlink("target.txt"),**dict(cleanup=factory())}',
      'metadata={"cleanup":lambda:os.unlink("target.txt"),**D(cleanup=(D:=custom))}',
      'dict=custom;metadata=dict({"cleanup":lambda:os.unlink("target.txt")},cleanup=None)',
      'D=custom;metadata={"cleanup":lambda:os.unlink("target.txt"),**D(cleanup=None)}',
      'builtins.dict=custom;metadata={"cleanup":lambda:os.unlink("target.txt"),**dict(cleanup=None)}',
      'metadata={"cleanup":lambda:os.unlink("target.txt"),key:None};metadata["cleanup"]()',
      'metadata={"cleanup":lambda:os.unlink("target.txt"),**dict(cleanup=None,key=factory())}',
      'metadata={"cleanup":lambda:os.unlink("target.txt"),**dict(cleanup=None,unused=(fn:=str))}',
      'operator.itemgetter(0)((str,lambda tag=os.unlink("target.txt"):None))("test")',
      'operator.itemgetter(0)((str,lambda:os.unlink("target.txt"),os.unlink("target.txt")))("test")',
      'operator.itemgetter(index)((str,lambda:os.unlink("target.txt")))()',
      'operator.itemgetter(0,1)((str,lambda:os.unlink("target.txt")))[1]()',
      'operator.itemgetter(0)(((lambda:os.unlink("target.txt"),),str))[0]()',
      'dict.get({"nested":[lambda:os.unlink("target.txt")]},"nested")[0]()',
      'items=(str,lambda:os.unlink("target.txt"));operator.itemgetter(1)(items)()',
      'pick=custom;pick((str,lambda:os.unlink("target.txt")))()',
      'operator.itemgetter=custom;operator.itemgetter(0)((str,lambda:os.unlink("target.txt")))()',
      'operator.getitem=custom;operator.getitem([str,lambda:os.unlink("target.txt")],0)()',
      'fn=os.unlink;operator.itemgetter(0)((fn,dict(tag=(fn:=str)),lambda:os.unlink("target.txt")))("target.txt")',
      'fn=str;operator.itemgetter(1)((factory(),fn,lambda:os.unlink("target.txt")))("target.txt")',
      'functools.partial(operator.getitem,[str,lambda:os.unlink("target.txt")],1)()',
      'create=dict\nfor flag in (False,True):\n    metadata={"cleanup":lambda:os.unlink("target.txt"),**create(cleanup=None)}\n    create=custom\nmetadata["cleanup"]()',
      'class dict:\n    def __new__(cls,**kwargs):\n        os.unlink("target.txt")\n        return kwargs\nmetadata={"cleanup":lambda:os.unlink("target.txt"),**dict(cleanup=None)}'
    ])('retains escaped callbacks and original eager effects: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    for (const incomplete of [false, true])
      it(`keeps constructor and getter history conservative incomplete=${incomplete}`, async () => {
        const source = 'operator.call(pick,(str,lambda:os.unlink("target.txt")))("test")'
        const risks = await analyzeNotebookCodeRisk('python', source, undefined, [
          { script: prelude, incomplete }
        ])
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'operator.itemgetter(1)((str,lambda:os.unlink("target.txt")))()',
              undefined,
              [{ script: prelude, incomplete }]
            )
          ).length
        ).toBeGreaterThan(0)
      })
  })
  describe('Python native file construction and reader selection', () => {
    const prelude =
      'import os,io,builtins,operator,pathlib\nfrom builtins import dict as D\nopener=io.open\n'
    const options = [
      'dict()',
      'dict(mode="r")',
      'dict(mode="r",opener=None)',
      'builtins.dict(encoding="utf-8",errors="strict")',
      'D(mode="r",buffering=-1)',
      'dict({"mode":"r"},encoding="utf-8")',
      'dict([("mode","r"),("encoding","utf-8")])',
      'dict(( ("mode","r"), ))',
      'dict(**dict(mode="r",opener=None))',
      'dict({"mode":"rb"},mode="r")',
      '{**dict(mode="r")}',
      'dict({**dict(encoding="utf-8")},mode="r")',
      'dict({"encoding":None},encoding="utf-8")',
      'operator.call(dict,mode="r")'
    ]
    const selectors = [
      'operator.itemgetter(0)((READER,dict()))',
      'operator.getitem([READER,dict(tag="data")],0)',
      'dict.get({"read":READER,"metadata":dict()},"read")',
      'operator.itemgetter("read")({"read":READER,"metadata":dict(tag="data")})',
      '(READER,dict())[0]',
      '{"read":READER,"metadata":dict()}["read"]'
    ]
    for (const form of options)
      for (const target of ['open', 'builtins.open', 'io.open', 'opener']) {
        const receiver = `${target}("target.txt",**${form})`
        for (const method of ['read', 'readline', 'readlines'])
          for (const route of [
            'getattr(RECEIVER,"METHOD",os.unlink)',
            'operator.call(getattr,RECEIVER,"METHOD",lambda:os.unlink("target.txt"))'
          ])
            it(`reads a closed native file target=${target} method=${method} route=${route} form=${form}`, async () => {
              const code = route.replaceAll('RECEIVER', receiver).replaceAll('METHOD', method)
              expect(await analyzeNotebookCodeRisk('python', prelude + `${code}()`)).toEqual([])
              expect(
                await analyzeNotebookCodeRisk(
                  'python',
                  prelude + `saved=${code};opener=str;D=str;saved()`
                )
              ).toEqual([])
              const erase = route.replaceAll('RECEIVER', receiver).replaceAll('METHOD', 'missing')
              const eraseArgs = route.includes('lambda:') ? '' : '"target.txt"'
              expect(
                (await analyzeNotebookCodeRisk('python', prelude + `${erase}(${eraseArgs})`)).length
              ).toBeGreaterThan(0)
            })
        for (const route of selectors)
          it(`selects a native file reader target=${target} route=${route} form=${form}`, async () => {
            const code = route.replaceAll('READER', `${receiver}.read`)
            expect(await analyzeNotebookCodeRisk('python', prelude + `${code}()`)).toEqual([])
            expect(
              await analyzeNotebookCodeRisk('python', prelude + `saved=${code};D=str;saved()`)
            ).toEqual([])
            const erase = route.replaceAll('READER', 'os.unlink')
            expect(
              (await analyzeNotebookCodeRisk('python', prelude + `${erase}("target.txt")`)).map(
                (risk) => risk.operation
              )
            ).toContain('os.unlink')
          })
      }
    it.each([
      'getattr(open("target.txt",**options),"read",os.unlink)()',
      'getattr(open("target.txt",**dict(mode=mode)),"read",os.unlink)()',
      'getattr(open(path,**dict(mode="r")),"read",os.unlink)()',
      'getattr(open("target.txt",**dict(buffering=obj)),"read",os.unlink)()',
      'getattr(open("target.txt",**dict(opener=custom)),"read",os.unlink)()',
      'getattr(open("target.txt",**dict(opener=lambda p,f:os.unlink(p))),"read",os.unlink)()',
      'getattr(open("target.txt",**dict(mode=os.unlink("target.txt"))),"read",os.unlink)()',
      'getattr(open("target.txt",**dict({"mode":os.unlink("target.txt")},mode="r")),"read",os.unlink)()',
      'getattr(open("target.txt",**dict(mode="r")),"read",lambda p=os.unlink("target.txt"):None)()',
      'dict=factory;getattr(open("target.txt",**dict(mode="r")),"read",os.unlink)()',
      'builtins.dict=factory;getattr(open("target.txt",**dict(mode="r")),"read",os.unlink)()',
      'D=factory;getattr(open("target.txt",**D(mode="r")),"read",os.unlink)()',
      'io.open=factory;getattr(io.open("target.txt",**dict(mode="r")),"read",os.unlink)()',
      'class dict:\n    def __new__(cls,**kwargs):\n        os.unlink("target.txt")\n        return kwargs\ngetattr(open("target.txt",**dict(mode="r")),"read",os.unlink)()',
      'operator.itemgetter(0)((open("target.txt",**dict(mode="r")).read,dict(tag=os.unlink("target.txt"))))()',
      'fn=os.unlink\noperator.itemgetter(0)((fn,operator.call((fn:=dict))))("target.txt")',
      'fn=os.unlink\noperator.getitem([fn,dict(tag=(fn:=str))],0)("target.txt")',
      'fn=os.unlink\ndict.get({"fn":fn,"meta":dict(tag=(fn:=str))},"fn")("target.txt")',
      'fn=os.unlink\noperator.itemgetter(0)((fn,dict(**{"tag":(fn:=str)})))("target.txt")',
      'fn=os.unlink\noperator.itemgetter(0)((fn,dict(tag=lambda default=(fn:=str):None)))("target.txt")',
      'fn=str\noperator.itemgetter(1)((open("target.txt",**dict(buffering=obj)),fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((pathlib.Path(obj,**dict()),fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((dict({obj:"data"}),fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((dict(generator),fn))("target.txt")'
    ])('retains effects and unknown construction protocols: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    for (const incomplete of [false, true])
      it(`replays native constructors without carrying parser nodes incomplete=${incomplete}`, async () => {
        const previous = { script: prelude, incomplete }
        const receiver = 'opener("target.txt",**D(mode="r"))'
        const reader = `saved=getattr(${receiver},"read",os.unlink);saved()`
        const risks = await analyzeNotebookCodeRisk('python', reader, undefined, [previous])
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `getattr(${receiver},"missing",os.unlink)("target.txt")`,
              undefined,
              [previous]
            )
          ).length
        ).toBeGreaterThan(0)
      })
  })
  describe('Python closed mapping consumers', () => {
    const prelude = 'import os,io,subprocess,builtins,operator\nfrom builtins import dict as D\n'
    const environments = [
      'dict()',
      'dict(NO_COLOR="1")',
      'dict({"NO_COLOR":"1"})',
      'dict([("NO_COLOR","1")])',
      'dict({"NO_COLOR":"old"},NO_COLOR="1")',
      'dict(dict(NO_COLOR="1"),PYTHONUTF8="1")',
      'dict(**dict(NO_COLOR="1"))',
      '{**dict(NO_COLOR="1")}',
      '{**dict(NO_COLOR="1"),"PYTHONUTF8":"1"}',
      'dict({"PYTHONUTF8":"invalid"},PYTHONUTF8="1")',
      '{**dict(PYTHONUTF8="invalid"),**dict(PYTHONUTF8="1")}',
      'operator.call(dict,NO_COLOR="1")',
      'builtins.dict(NO_COLOR="1")',
      'D(NO_COLOR="1")'
    ]
    for (const env of environments)
      for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen'])
        for (const shell of [false, true])
          for (const packed of [false, true])
            it(`reads environment method=${method} shell=${shell} packed=${packed} env=${env}`, async () => {
              const code = (danger: boolean): string => {
                const argv = JSON.stringify(
                  shell
                    ? `${danger ? 'rm' : 'echo'} target.txt`
                    : [danger ? 'rm' : 'echo', 'target.txt']
                )
                const options = packed
                  ? `**dict(shell=${shell ? 'True' : 'False'},env=${env})`
                  : `shell=${shell ? 'True' : 'False'},env=${env}`
                return prelude + `subprocess.${method}(${argv},${options})`
              }
              expect((await analyzeNotebookCodeRisk('python', code(false))).length > 0).toBe(
                shell && process.platform === 'win32'
              )
              expect((await analyzeNotebookCodeRisk('python', code(true))).length).toBeGreaterThan(
                0
              )
            })
    for (const key of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH', 'PYTHONPATH', 'NODE_OPTIONS'])
      for (const wrap of [
        (pair: string): string => `dict(${pair})`,
        (pair: string): string => `{**dict(${pair})}`,
        (pair: string): string => `dict(dict(${pair}))`
      ])
        it(`retains startup environment key=${key} wrap=${wrap(key)}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude + `subprocess.run(["echo","hello"],env=${wrap(`${key}="module"`)})`
              )
            ).length
          ).toBeGreaterThan(0)
        })
    const options = [
      'dict()',
      'dict(mode="r")',
      'dict(mode="r",opener=None)',
      'dict(encoding="utf-8",errors="strict")',
      'dict({"mode":"r"})',
      'dict([("mode","r")])',
      'dict(dict(mode="r"),encoding="utf-8")',
      '{**dict(mode="r")}',
      'D(mode="r")',
      'operator.call(dict,mode="r")'
    ]
    for (const form of options)
      for (const target of ['open', 'builtins.open', 'io.open'])
        for (const forward of [false, true])
          it(`reads native file target=${target} forward=${forward} form=${form}`, async () => {
            const code = (danger: boolean): string => {
              const kwargs = danger
                ? `dict(${form},opener=lambda p,f:os.unlink("target.txt"))`
                : form
              return (
                prelude +
                (forward
                  ? `operator.call(${target},"data.txt",**${kwargs}).read()`
                  : `${target}("data.txt",**${kwargs}).read()`)
              )
            }
            expect(await analyzeNotebookCodeRisk('python', code(false))).toEqual([])
            expect((await analyzeNotebookCodeRisk('python', code(true))).length).toBeGreaterThan(0)
          })
    for (const form of [
      'dict()',
      'dict(reverse=True)',
      'dict(key=None)',
      'dict(dict(reverse=True),key=None)',
      '{**dict(reverse=True)}',
      'D(reverse=True)',
      'operator.call(dict,reverse=True)'
    ])
      for (const route of [
        'sorted([3,1,2],**OPTIONS)',
        '[3,1,2].sort(**OPTIONS)',
        'operator.methodcaller("sort",**OPTIONS)([3,1,2])'
      ])
        it(`checks sort callback form=${form} route=${route}`, async () => {
          expect(
            await analyzeNotebookCodeRisk('python', prelude + route.replace('OPTIONS', form))
          ).toEqual([])
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude +
                  route.replace('OPTIONS', `dict(${form},key=lambda value:os.unlink("target.txt"))`)
              )
            ).length
          ).toBeGreaterThan(0)
        })
    const splits = [
      'dict()',
      'dict(maxsplit=1)',
      'dict(sep=None)',
      'dict(sep=" ",maxsplit=1)',
      'dict({"maxsplit":-1})',
      'dict(dict(sep=None),maxsplit=1)',
      'D(maxsplit=1)',
      '{**dict(maxsplit=1)}',
      '{"maxsplit":0,"maxsplit":1}',
      'dict([("maxsplit",1)])',
      '{"sep":" ","maxsplit":1}'
    ]
    for (const form of splits)
      for (const method of ['split', 'rsplit'])
        for (const unbound of [false, true])
          for (const api of ['run', 'call', 'check_call', 'check_output', 'Popen'])
            it(`reads split vector method=${method} unbound=${unbound} api=${api} form=${form}`, async () => {
              const code = (danger: boolean): string => {
                const text = JSON.stringify(`${danger ? 'rm' : 'echo'} target.txt`)
                const vector = unbound
                  ? `str.${method}(${text},**${form})`
                  : `${text}.${method}(**${form})`
                return prelude + `subprocess.${api}(${vector})`
              }
              expect(await analyzeNotebookCodeRisk('python', code(false))).toEqual([])
              expect((await analyzeNotebookCodeRisk('python', code(true))).length).toBeGreaterThan(
                0
              )
            })
    for (const form of [
      'dict()',
      'dict([])',
      'dict(**dict())',
      'operator.call(dict)',
      'dict(dict())'
    ])
      for (const flag of [form, `bool(${form})`, `len(${form})`])
        it(`uses empty native mapping truth ${flag}`, async () => {
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              prelude + `subprocess.run(["echo","hello"],shell=${flag})`
            )
          ).toEqual([])
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude + `subprocess.run(["rm","target.txt"],shell=${flag})`
              )
            ).length
          ).toBeGreaterThan(0)
        })
    for (const form of [
      'dict(key=0)',
      'dict({"key":False})',
      'dict([("key",None)])',
      'operator.call(dict,key=0)'
    ])
      for (const flag of [form, `bool(${form})`, `len(${form})`])
        it(`uses nonempty native mapping truth ${flag}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude + `subprocess.run("echo hello",shell=${flag})`
              )
            ).length > 0
          ).toBe(process.platform === 'win32')
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude + `subprocess.run("rm target.txt",shell=${flag})`
              )
            ).length
          ).toBeGreaterThan(0)
        })
    it.each([
      'subprocess.run("echo hello".split(**dict(maxsplit=0)))',
      'subprocess.run("rm target.txt".split(**dict(maxsplit=0)))',
      'subprocess.run("echo hello".split(**dict(sep=",")))',
      'subprocess.run("rm target.txt".split(**dict(sep=",")))',
      'subprocess.run(" rm".rsplit(**dict(sep=None,maxsplit=0)))'
    ])('keeps one split argv slot as a filename rather than shell source: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    it('retains executable override after a split returns one argv slot', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude + 'subprocess.run("echo hello".split(**dict(maxsplit=0)),executable="rm")'
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      'open("data.txt",**options).read()',
      'sorted([3,1,2],**options)',
      'subprocess.run(["echo","hello"],env=options)',
      'subprocess.run(["echo","hello"],env=dict(Factory()))',
      'subprocess.run(["echo","hello"],env={**dict(NO_COLOR="1"),**unknown})',
      'subprocess.run("echo hello".split(**options))',
      'subprocess.run("echo hello".split(**dict(unknown=1)))',
      'subprocess.run("echo hello".split(**dict(maxsplit=1),maxsplit=2))',
      'subprocess.run("echo hello".split(**dict(maxsplit=1),**dict(maxsplit=2)))',
      'subprocess.run("echo hello".split(**dict(sep=Flag(),maxsplit=1)))',
      'subprocess.run("echo hello".split(**{"sep":Flag(),"sep":" "}))',
      'subprocess.run("echo hello".split(**dict({"sep":Flag(),"sep":" "})))',
      'subprocess.run("echo hello".split(**dict(maxsplit=Index())))',
      'subprocess.run("echo hello".split(**dict(sep="")))',
      'subprocess.run(["echo","hello"],env=dict(NO_COLOR="1",PYTHONUTF8="invalid"))',
      'subprocess.run(["echo","hello"],env=dict({"NO_COLOR":Flag(),"NO_COLOR":"1"}))',
      'subprocess.run(["echo","hello"],env=dict([("NO_COLOR",Flag()),("NO_COLOR","1")]))',
      'subprocess.run(["echo","hello"],shell=bool(dict(key=Flag())))',
      'class dict: pass\nopen("data.txt",**dict(mode="r")).read()',
      'class dict: pass\nsubprocess.run(["echo","hello"],env=dict(NO_COLOR="1"))'
    ])('retains uncertain mapping consumer: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    it.each([
      'open("data.txt",**dict(mode="r",encoding=os.unlink("target.txt"))).read()',
      'sorted([3,1,2],**dict(reverse=os.unlink("target.txt")))',
      'subprocess.run(["echo","hello"],env=dict(NO_COLOR=os.unlink("target.txt") or "1"))',
      'subprocess.run(["echo","hello"],env=dict({"NO_COLOR":os.unlink("target.txt"),"NO_COLOR":"1"}))',
      'subprocess.run("echo hello".split(**dict(maxsplit=os.unlink("target.txt"))))',
      'subprocess.run("echo hello".split(**{"sep":os.unlink("target.txt"),"sep":" "}))',
      'subprocess.run(["echo","hello"],shell=bool(dict({"key":os.unlink("target.txt"),"key":0})))'
    ])('retains eager mapping consumer deletion: %s', async (code) => {
      expect(
        (await analyzeNotebookCodeRisk('python', prelude + code)).map((value) => value.operation)
      ).toContain('os.unlink')
    })
    it.each([
      'subprocess.run(["echo","hello"],env=D(NO_COLOR="1"),text=(D:=os.unlink))',
      'open("data.txt",**D(mode="r"),errors=(D:=os.unlink)).read()',
      'subprocess.run("echo hello".split(**D(maxsplit=1)),text=(D:=os.unlink))'
    ])('retains construction captured before later keyword rebinding: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    for (const incomplete of [false, true])
      it(`replays mapping consumer aliases incomplete=${incomplete}`, async () => {
        const risks = await analyzeNotebookCodeRisk(
          'python',
          'open("data.txt",**D(mode="r")).read()',
          undefined,
          [{ script: prelude, incomplete }]
        )
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
  })
  describe('Python constructed process keywords', () => {
    const prelude =
      'import subprocess,builtins,operator,functools,os\nfrom builtins import dict as D\nselector=True\n'
    const falseForms = [
      'dict()',
      'dict(shell=False)',
      'dict(text=True,shell=False)',
      'dict(check=True)',
      'dict({"shell":False})',
      'dict({"shell":True},shell=False)',
      'dict({"shell":False},text=True)',
      'dict({"shell":False}|{"text":True})',
      'dict(**{"shell":False})',
      'dict(**dict(shell=False))',
      'dict(dict(shell=False),text=True)',
      'dict([("shell",False),("text",True)])',
      'dict((("shell",True),("shell",False)))',
      'dict([*( [("shell",False)] )])',
      'dict(*({"shell":False},))',
      'dict(shell=bool(False))',
      'dict(shell=int("0"))',
      'dict(shell=len([*list([])]))',
      'dict(shell=False if selector else 0)',
      'dict(executable=None,preexec_fn=None,env=None,shell=False)',
      'dict(stdout=subprocess.PIPE,shell=False)',
      'builtins.dict(shell=False)',
      'D(shell=False)',
      'dict.__call__(shell=False)',
      'getattr(dict,"__call__")(shell=False)',
      'operator.call(dict,shell=False)',
      'operator.call(operator.call,dict,shell=False)',
      '(dict if selector else builtins.dict)(shell=False)',
      '{**dict(shell=False),"text":True}',
      '{"text":True,**dict(shell=False)}',
      '{**dict(shell=True),**dict(shell=False)}'
    ]
    const trueForms = [
      'dict(shell=True)',
      'dict({"shell":False},shell=True)',
      'dict([("shell",False),("shell",True)])',
      'dict(shell=bool(True))',
      'dict(shell="False")',
      'dict(dict(shell=False),shell=True)',
      'operator.call(dict,{"shell":False},shell=True)',
      '{**dict(shell=False),**dict(shell=True)}'
    ]
    for (const [forms, shell] of [
      [falseForms, false],
      [trueForms, true]
    ] as const)
      for (const form of forms)
        for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen'])
          for (const route of [
            'subprocess.METHOD(ARGV,**OPTIONS)',
            'subprocess.METHOD(args=ARGV,**OPTIONS)',
            'operator.call(subprocess.METHOD,ARGV,**OPTIONS)',
            'getattr(subprocess,"METHOD")(*(ARGV,),**OPTIONS)'
          ])
            it(`checks closed mapping method=${method} shell=${shell} form=${form} route=${route}`, async () => {
              const code = (danger: boolean): string =>
                prelude +
                route
                  .replaceAll('METHOD', method)
                  .replaceAll('OPTIONS', form)
                  .replaceAll(
                    'ARGV',
                    JSON.stringify(
                      shell
                        ? danger
                          ? 'rm target.txt'
                          : 'echo hello'
                        : [danger ? 'rm' : 'echo', 'target.txt']
                    )
                  )
              expect((await analyzeNotebookCodeRisk('python', code(false))).length > 0).toBe(
                shell && process.platform === 'win32'
              )
              expect((await analyzeNotebookCodeRisk('python', code(true))).length).toBeGreaterThan(
                0
              )
            })
    it.each([
      'dict(args=["echo","hello"],shell=False)',
      'dict(args=["echo","临时目录你好"],shell=False)',
      'dict({"args":["echo","hello"]},shell=False)',
      'dict([("args",["echo","hello"]),("shell",False)])',
      'operator.call(dict,args=["echo","hello"],shell=False)'
    ])('reads command arguments from the same constructed mapping: %s', async (form) => {
      expect(
        await analyzeNotebookCodeRisk('python', prelude + `subprocess.run(**${form})`)
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude + `subprocess.run(**${form.replaceAll('"echo"', '"rm"')})`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      'dict(options)',
      'dict(Factory())',
      'dict({unknown:False})',
      'dict(**options)',
      'dict(*args)',
      'dict({"shell":False}, {})',
      'dict([("shell",False,True)])',
      'dict([pair])',
      'dict([(unknown,False)])',
      'dict(shell=False,**{"shell":True})',
      'dict(**{"shell":False},**{"shell":True})',
      'functools.partial(dict,shell=False)()',
      'dict.fromkeys(["shell"],False)',
      '{"shell":False}.copy()',
      'dict(shell=Flag())',
      'dict(text=Flag())',
      'dict({"check":Flag(),"check":True})',
      'dict([("check",Flag()),("check",True)])',
      'dict({Flag():True},shell=False)',
      'dict(preexec_fn=os.unlink)',
      'dict(executable="rm")',
      'dict(env={"LD_PRELOAD":"module"})',
      'dict(env={"PATH":unknown})'
    ])('retains uncertain mapping construction and process overrides: %s', async (form) => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude + `subprocess.run(["echo","hello"],**${form})`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      'subprocess.run(["echo","hello"],**D(shell=False),text=(D:=os.unlink))',
      'subprocess.run(["echo","hello"],**operator.call(D,shell=False),text=(D:=os.unlink))',
      'subprocess.run(["echo","hello"],**dict(shell=bool(False)),text=(bool:=os.unlink))'
    ])('uses mapping construction captured before later rebinding: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    it.each([
      'D=os.unlink\nsubprocess.run(["echo","hello"],**D("target.txt"))',
      'def D(**kwargs):\n    os.unlink("target.txt")\n    return kwargs\nsubprocess.run(["echo","hello"],**D(shell=False),text=(D:=dict))',
      'builtins.dict=lambda **kwargs: os.unlink("target.txt") or kwargs\nsubprocess.run(["echo","hello"],**dict(shell=False))',
      'for D in (dict,os.unlink):\n    subprocess.run(["echo","hello"],**D(shell=False))',
      'subprocess.run(["echo","hello"],**dict(check=os.unlink("target.txt")))',
      'subprocess.run(["echo","hello"],**dict({"check":os.unlink("target.txt"),"check":True}))',
      'subprocess.run(["echo","hello"],**dict([("check",os.unlink("target.txt")),("check",True)]))'
    ])('retains eager deletion and mutated constructors: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    for (const incomplete of [false, true])
      it(`replays constructor aliases without retaining mapping nodes incomplete=${incomplete}`, async () => {
        const risks = await analyzeNotebookCodeRisk(
          'python',
          'subprocess.run(["echo","hello"],**D(shell=False))',
          undefined,
          [{ script: prelude, incomplete }]
        )
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'subprocess.run(["rm","target.txt"],**D(shell=False))',
              undefined,
              [{ script: prelude, incomplete }]
            )
          ).length
        ).toBeGreaterThan(0)
      })
    for (const name of ['dict', 'bool', 'int', 'len', 'list', 'tuple'])
      it(`does not certify a user class with builtin spelling ${name}`, async () => {
        const invocation = name === 'dict' ? '**dict(shell=False)' : `shell=${name}()`
        const code =
          prelude +
          `class ${name}:
    def __init__(self,**kwargs):
        os.unlink("target.txt")
    def __bool__(self):
        return False
    def keys(self):
        return ["shell"]
    def __getitem__(self,key):
        return False
subprocess.run(["echo","hello"],${invocation})`
        expect((await analyzeNotebookCodeRisk('python', code)).length).toBeGreaterThan(0)
      })
    it('preserves aliases captured before a class shadows the builtin', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          prelude + 'class dict: pass\nsubprocess.run(["echo","hello"],**D(shell=False))'
        )
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          prelude +
            'def prepare():\n    class dict: pass\nprepare()\nsubprocess.run(["echo","hello"],**dict(shell=False))'
        )
      ).toEqual([])
    })
    it.each(['global dict', 'if True:\n        global dict'])(
      'retains class rebinding a builtin through a function: %s',
      async (declaration) => {
        const code =
          prelude +
          `def prepare():
    ${declaration}
    class dict:
        def __init__(self,**kwargs):
            os.unlink("target.txt")
        def keys(self):
            return ["shell"]
        def __getitem__(self,key):
            return False
prepare()
subprocess.run(["echo","hello"],**dict(shell=False))`
        expect((await analyzeNotebookCodeRisk('python', code)).length).toBeGreaterThan(0)
      }
    )
    it('bounds inline mapping entries', async () => {
      const entries = Array.from({ length: 129 }, (_, i) => `"option${i}":False`).join(',')
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude + `subprocess.run(["echo","hello"],**dict({${entries}}))`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })
  describe('Python native process flag conversions', () => {
    const prelude =
      'import subprocess,builtins,operator,os\nfrom builtins import bool as B,int as I,len as L\nselector=True\nconvert=bool if selector else len\n'
    const flags: [string, boolean][] = [
      ['bool()', false],
      ['bool(False)', false],
      ['bool(0)', false],
      ['bool(None)', false],
      ['bool("")', false],
      ['bool([])', false],
      ['bool(())', false],
      ['bool({})', false],
      ['builtins.bool(False)', false],
      ['B(False)', false],
      ['bool.__call__(False)', false],
      ['getattr(bool,"__call__")(False)', false],
      ['operator.call(bool,False)', false],
      ['bool(*[False])', false],
      ['bool(*())', false],
      ['not bool(True)', false],
      ['not not bool(False)', false],
      ['int()', false],
      ['int(False)', false],
      ['int(-0)', false],
      ['int(+0x0)', false],
      ['int("0")', false],
      ['int("-0_0")', false],
      ['int(" +00 ")', false],
      ['int(b"0")', false],
      ['I(False)', false],
      ['builtins.int(False)', false],
      ['operator.call(int,False)', false],
      ['int(bool(False))', false],
      ['int(len([]))', false],
      ['len(())', false],
      ['len([])', false],
      ['len({})', false],
      ['len("")', false],
      ['L(())', false],
      ['builtins.len(())', false],
      ['operator.call(len,())', false],
      ['len(tuple())', false],
      ['len(list([]))', false],
      ['len("".split())', false],
      ['len([*list([])])', false],
      ['bool(len(tuple()))', false],
      ['not len([0])', false],
      ['list()', false],
      ['tuple([])', false],
      ['"".split()', false],
      ['bool(list())', false],
      ['bool(tuple([]))', false],
      ['convert(())', false],
      ['bool(True)', true],
      ['bool("False")', true],
      ['bool([False])', true],
      ['bool((None,))', true],
      ['bool({"key":False})', true],
      ['not bool(False)', true],
      ['int(True)', true],
      ['int(-1)', true],
      ['int("-00_1")', true],
      ['I("12")', true],
      ['len([0])', true],
      ['len((None,))', true],
      ['len("False")', true],
      ['len({"key":0})', true],
      ['len([*tuple([0])])', true],
      ['bool(len([0]))', true],
      ['convert([0])', true],
      ['int(not False)', true]
    ]
    for (const [flag, shell] of flags)
      for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
        for (const route of [
          'subprocess.METHOD(ARGV,shell=FLAG)',
          'subprocess.METHOD(args=ARGV,**{"shell":FLAG})',
          'operator.call(subprocess.METHOD,ARGV,shell=FLAG)',
          'getattr(subprocess,"METHOD")(*(ARGV,),**{**{"shell":FLAG}})'
        ])
          it(`checks ${method} native flag=${flag} route=${route}`, async () => {
            const code = (danger: boolean): string =>
              prelude +
              route
                .replaceAll('METHOD', method)
                .replaceAll('FLAG', flag)
                .replaceAll(
                  'ARGV',
                  JSON.stringify(
                    shell
                      ? danger
                        ? 'rm target.txt'
                        : 'echo hello'
                      : [danger ? 'rm' : 'echo', 'target.txt']
                  )
                )
            expect((await analyzeNotebookCodeRisk('python', code(false))).length > 0).toBe(
              shell && process.platform === 'win32'
            )
            expect((await analyzeNotebookCodeRisk('python', code(true))).length).toBeGreaterThan(0)
          })
      }
    it.each([
      'subprocess.run(["echo","hello"] if bool(False) else ["echo","world"])',
      'subprocess.run(["echo",os.unlink("target.txt")] if bool(False) else ["echo","world"])',
      'subprocess.run(["echo","world"] if bool(True) else ["echo",os.unlink("target.txt")])',
      'subprocess.run(bool(False) or ["echo","hello"])',
      'subprocess.run(bool(True) and ["echo","hello"])',
      'subprocess.run(["echo","hello"],shell=B(False),text=(B:=os.unlink))',
      'subprocess.run(["echo","hello"],**{"shell":B(False),"text":(B:=os.unlink)})',
      'subprocess.run(["echo","hello"] if bool(False) else ["echo","world"],text=(bool:=os.unlink))',
      'subprocess.run(["echo","hello"],shell=bool((False if selector else 0)))',
      'subprocess.run(["echo","hello"],shell=int(bool(len(tuple()))))'
    ])('uses captured native truth without recomputing later bindings: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    it.each([
      'bool(unknown)',
      'int(unknown)',
      'len(unknown)',
      'bool(Choice())',
      'int(Choice())',
      'len(Choice())',
      'bool(x=False)',
      'len()',
      'len(None)',
      'len(False)',
      'len(0)',
      'int(None)',
      'int([])',
      'int(0.5)',
      'int("invalid")',
      'int("0",base=10)',
      'bool(False,True)',
      'bool(**options)',
      'len(*args)',
      'int(*args)',
      'bool(False if selector else True)',
      'int(bool(False if selector else True))',
      'len([Flag()]) if unknown else len(())',
      'bool(len(generator))',
      'functools.partial(bool,False)()',
      '(bool if selector else int)("0")',
      'len({Flag():0})',
      'bool(f"{Flag()}")',
      'bool([*generator])',
      'bool([Flag()])',
      'len([Flag()])',
      'bool(tuple([Flag()]))',
      'len(list([Flag()]))',
      'not bool([*tuple([Flag()])])',
      'bool([Flag()] + [])',
      'int(list())',
      'int(tuple([]))',
      'int("".split())'
    ])('retains unknown hooks, signatures or inconsistent results: %s', async (flag) => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude + `import functools\nsubprocess.run(["echo","hello"],shell=${flag})`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      'B=os.unlink\nsubprocess.run(["echo","hello"],shell=B("target.txt"))',
      'def B(value):\n    os.unlink("target.txt")\n    return False\nsubprocess.run(["echo","hello"],shell=B(False),text=(B:=bool))',
      'def poison():\n    builtins.bool=lambda value: os.unlink("target.txt") or False\npoison()\nsubprocess.run(["echo","hello"],shell=bool(False))',
      'subprocess.run(["echo","hello"],shell=bool(os.unlink("target.txt")))',
      'subprocess.run(["echo","hello"],shell=len([os.unlink("target.txt")]))',
      'subprocess.run(["echo","hello"],shell=bool(False),preexec_fn=os.unlink)',
      'subprocess.run(["echo","hello"],shell=bool(False),executable="rm")',
      'subprocess.run(["echo","hello"],shell=bool(False),env={"LD_PRELOAD":"module"})',
      'class Choice:\n    def __bool__(self):\n        os.unlink("target.txt")\n        return False\nsubprocess.run(["echo","hello"] if bool(Choice()) else ["echo","world"],text=(bool:=bool))',
      'for B in (bool,os.unlink):\n    subprocess.run(["echo","hello"],shell=B(False))'
    ])('retains destructive construction, mutations and process overrides: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    it.each([
      'not bool([Flag()])',
      'not len([Flag()])',
      'not bool(tuple([Flag()]))',
      'not len(list([Flag()]))',
      'not bool([*tuple([Flag()])])',
      'bool([Flag()][:0])',
      'len(list([Flag()])[:0])',
      'bool([Flag()]) and False'
    ])('retains object construction inside a native container: %s', async (flag) => {
      const code =
        prelude +
        `class Flag:
    def __init__(self):
        os.unlink("target.txt")
subprocess.run(["echo","hello"],shell=${flag})`
      expect((await analyzeNotebookCodeRisk('python', code)).length).toBeGreaterThan(0)
    })
    for (const incomplete of [false, true])
      it(`replays converter aliases incomplete=${incomplete}`, async () => {
        const risks = await analyzeNotebookCodeRisk(
          'python',
          'subprocess.run(["echo","hello"],shell=B(False))',
          undefined,
          [{ script: prelude, incomplete }]
        )
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'subprocess.run(["rm","target.txt"],shell=B(False))',
              undefined,
              [{ script: prelude, incomplete }]
            )
          ).length
        ).toBeGreaterThan(0)
      })
    it('reuses bounded call results and limits decimal text evidence', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          prelude +
            `subprocess.run(["echo","hello"],shell=${'bool('.repeat(70)}False${')'.repeat(70)})`
        )
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude + `subprocess.run(["echo","hello"],shell=int("${'0'.repeat(4097)}"))`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })
  describe('Python bounded process argument choices', () => {
    const prelude =
      'import subprocess,builtins,operator,os\nflag=True\nconvert=list if flag else tuple\n'
    const factories = [
      '["COMMAND","hello"] if flag else ["COMMAND","world"]',
      '("COMMAND","hello") if flag else ["COMMAND","world"]',
      '"COMMAND hello".split() if flag else ["COMMAND","world"]',
      'tuple(["COMMAND","hello"]) if flag else "COMMAND world".rsplit()',
      'list(["COMMAND","hello"] if flag else ("COMMAND","world"))',
      'tuple(["COMMAND","hello"] if flag else ("COMMAND","world"))',
      'convert(("COMMAND","hello"))',
      '(list if flag else tuple)(("COMMAND","hello"))',
      'operator.call((list if flag else tuple),("COMMAND","hello"))',
      'getattr((list if flag else tuple),"__call__")(("COMMAND","hello"))',
      'convert(("COMMAND","hello"))[:]',
      'list(convert(("COMMAND",))) + ["hello"]',
      'tuple(convert(("COMMAND",))) + ("hello",)',
      '(["COMMAND","hello"] if flag else ["COMMAND","world"])[:]',
      '(["COMMAND"] if flag else ["COMMAND","world"]) + ["hello"]',
      '[*(["COMMAND","hello"] if flag else ("COMMAND","world"))]',
      '(*(["COMMAND","hello"] if flag else ("COMMAND","world")),)',
      '[] or ["COMMAND","hello"]',
      '["unused"] and ["COMMAND","hello"]',
      '["COMMAND","hello"] or ["rm","target.txt"]',
      '"COMMAND hello".split() or ["rm","target.txt"]',
      '["COMMAND","hello"] if True else ["rm","target.txt"]',
      '["rm","target.txt"] if False else ["COMMAND","hello"]',
      '("COMMAND" if flag else "echo")',
      '(["COMMAND","hello"] if flag else (["COMMAND","world"] if flag else ["echo","data"]))'
    ]
    for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
      for (const [factoryIndex, factory] of factories.entries()) {
        for (const [routeIndex, route] of [
          'subprocess.METHOD(VECTOR)',
          'subprocess.METHOD(args=VECTOR)',
          'operator.call(subprocess.METHOD,VECTOR)',
          'getattr(subprocess,"METHOD")(VECTOR)'
        ].entries()) {
          it(`checks every native choice method=${method} factory=${factoryIndex} route=${routeIndex}`, async () => {
            const code = (command: string): string =>
              prelude +
              route
                .replaceAll('METHOD', method)
                .replaceAll('VECTOR', factory.replaceAll('COMMAND', command))
            expect(await analyzeNotebookCodeRisk('python', code('echo'))).toEqual([])
            expect(
              (await analyzeNotebookCodeRisk('python', code('rm'))).map((risk) => risk.operation)
            ).toEqual([`subprocess.${method} nested execution`])
          })
        }
      }
    }
    for (const factory of [
      'SOURCE if flag else OTHER',
      'list(SOURCE if flag else OTHER)',
      'tuple(SOURCE if flag else OTHER)',
      '(SOURCE if flag else OTHER)[:]',
      '[*(SOURCE if flag else OTHER)]'
    ]) {
      it.each([
        [
          ['cat', 'target.txt'],
          ['head', '-n', '1', 'target.txt'],
          ['rm', 'target.txt']
        ],
        [
          ['wc', '-l', 'target.txt'],
          ['echo', 'hello'],
          ['find', '.', '-delete']
        ],
        [
          ['find', '.', '-print'],
          ['ls', '.'],
          ['find', '.', '-exec', 'rm', 'target.txt', ';']
        ],
        [
          ['git', 'status', '--short'],
          ['git', 'diff', '--stat'],
          ['git', 'clean', '-fd']
        ],
        [
          ['python', '--version'],
          ['echo', 'rm', 'target.txt'],
          ['python', '-c', 'import os;os.unlink(path)']
        ],
        [
          ['gzip', '-ck', 'target.txt'],
          ['wc', '-c', 'target.txt'],
          ['gzip', '-f', 'target.txt']
        ]
      ])(
        `checks mixed command alternatives through ${factory}: %j`,
        async (reader, other, erase) => {
          const code = (choice: string[]): string =>
            prelude +
            `subprocess.run(${factory.replaceAll('SOURCE', JSON.stringify(reader)).replaceAll('OTHER', JSON.stringify(choice))})`
          expect(await analyzeNotebookCodeRisk('python', code(other))).toEqual([])
          expect((await analyzeNotebookCodeRisk('python', code(erase))).length).toBeGreaterThan(0)
        }
      )
    }
    it.each([
      'subprocess.run(["echo",value] if flag else ("echo",other))',
      'subprocess.run(convert(("echo","hello")),text=(convert:=os.unlink))',
      'subprocess.run((["echo","hello"] if True else ["echo",os.unlink("target.txt")]))',
      'subprocess.run((["echo",os.unlink("target.txt")] if False else ["echo","hello"]))',
      'subprocess.run(["echo","hello"] if 1 else ["echo",os.unlink("target.txt")])',
      'subprocess.run(["echo",os.unlink("target.txt")] if 0 else ["echo","hello"])',
      'subprocess.run("echo hello".split() or ["echo",os.unlink("target.txt")])',
      'subprocess.run([] or "echo hello".split())',
      'subprocess.run(["echo","hello"] if "text" else ["rm","target.txt"])',
      'subprocess.run(["rm","target.txt"] if () else ["echo","hello"])'
    ])('preserves native data and proved unreachable effects: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    for (const vector of [
      '["echo","hello"] if flag else ["echo","world"]',
      '"echo" if flag else "pwd"',
      '"".split() or "echo"',
      '"echo" if "echo hello".split() else "rm"'
    ]) {
      it.each(['os.unlink', 'None', 'False'])(
        `captures the original benign truth proof ${vector} before later flag=%s`,
        async (replacement) => {
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              prelude + `subprocess.run(${vector},text=(flag:=${replacement}))`
            )
          ).toEqual([])
        }
      )
    }
    for (const vector of [
      '["echo","hello"] if unknown else ["echo","world"]',
      '"echo" if unknown else "pwd"',
      'unknown or "echo"',
      '[*( ["echo","hello"] if unknown else ["echo","world"] )]'
    ]) {
      it.each(['True', 'False'])(
        `retains the original unknown truth hook ${vector} before later unknown=%s`,
        async (replacement) => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude + `subprocess.run(${vector},text=(unknown:=${replacement}))`
              )
            ).length
          ).toBeGreaterThan(0)
        }
      )
    }
    it.each([
      'subprocess.run(["echo","hello"] if unknown else ["echo","world"])',
      'subprocess.run(["echo","hello"] if unknown else (flag:=True))',
      'subprocess.run(["echo","hello"] if flag else opaque)',
      'subprocess.run(["echo","hello"] if flag else factory())',
      'subprocess.run((list if flag else factory)(("echo","hello")))',
      'subprocess.run((list if flag else os.unlink)(("echo","hello")))',
      'subprocess.run(list(("echo","hello") if flag else generator))',
      'subprocess.run(["echo",os.unlink("target.txt")] if flag else ["echo","hello"])',
      'subprocess.run(["echo","hello"] if flag else ["echo",os.unlink("target.txt")])',
      'subprocess.run(convert(("echo","hello")),preexec_fn=os.unlink)',
      'subprocess.run(convert(("echo","hello")),shell=True)',
      'subprocess.run(convert(("echo","hello")),executable="rm")',
      'subprocess.run(convert(("echo","hello")),env={"LD_PRELOAD":"module"})',
      'subprocess.run((convert(("echo",)) + ["hello"]))',
      'subprocess.run(convert(("echo",)) + convert(("hello",)))',
      'convert=factory;subprocess.run(convert(("echo","hello")))',
      'def poison():\n    builtins.list=lambda value:["rm","target.txt"]\npoison()\nsubprocess.run((list if flag else tuple)(("echo","hello")))',
      'subprocess.run(["echo","hello"] if os.unlink("target.txt") else ["echo","world"])'
    ])('retains unknown truth hooks and destructive candidates: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    for (const incomplete of [false, true]) {
      it(`replays scalar and constructor choices without node caches incomplete=${incomplete}`, async () => {
        const previous = { script: prelude, incomplete }
        const risks = await analyzeNotebookCodeRisk(
          'python',
          'subprocess.run(convert(("echo","hello")))',
          undefined,
          [previous]
        )
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'subprocess.run(convert(("rm","target.txt")))',
              undefined,
              [previous]
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
    it('retains review when candidate or aggregate slot limits are exceeded', async () => {
      const choices = (count: number): string =>
        Array.from({ length: count }, (_, index) => `["echo","data${index}"]`).reduceRight(
          (tail, vector, index) =>
            index === count - 1 ? vector : `${vector} if flag else (${tail})`,
          ''
        )
      expect(
        await analyzeNotebookCodeRisk('python', prelude + `subprocess.run(${choices(16)})`)
      ).toEqual([])
      expect(
        (await analyzeNotebookCodeRisk('python', prelude + `subprocess.run(${choices(17)})`)).length
      ).toBeGreaterThan(0)
      const large = JSON.stringify([
        'echo',
        ...Array.from({ length: 512 }, (_, index) => 'data' + index)
      ])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            prelude +
              `subprocess.run(list(${large} if flag else ${large.replace('data0', 'other')}))`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })
  describe('Python native process sequence operations', () => {
    const prelude = 'import subprocess,builtins,operator,os\nconvert=list\n'
    const factories = [
      '["unused","COMMAND","hello"][1:]',
      '("unused","COMMAND","hello")[1:3]',
      '["COMMAND","hello","unused"][:2]',
      '["unused","COMMAND","hello"][-2:]',
      '["hello","COMMAND"][::-1]',
      '("hello","COMMAND")[-1::-1]',
      '["COMMAND","unused","hello"][::2]',
      '["COMMAND","hello"][None:None:None]',
      '["COMMAND","hello"][False:True]',
      '["COMMAND","hello"][-99:99:1]',
      '["COMMAND","hello"][0x0:0x2]',
      '["COMMAND","hello"][:][:2]',
      'list(("COMMAND","hello"))[0:2]',
      'tuple(["COMMAND","hello"])[::1]',
      'builtins.list(("COMMAND","hello"))[0:2]',
      'convert(("COMMAND","hello"))[1::-1][::-1]',
      '"COMMAND hello".split()[::1]',
      'str.split("COMMAND hello")[0:2]',
      'tuple("COMMAND hello".rsplit())[:]',
      'list(("COMMAND",)) + ["hello"]',
      '["COMMAND"] + list(("hello",))',
      'tuple(["COMMAND"]) + ("hello",)',
      '("COMMAND",) + tuple(["hello"])',
      '["COMMAND"] + "hello world".split()',
      '(["unused"] + list(("COMMAND",)) + ["hello"])[1:]',
      '[*(list(("COMMAND",)) + ["hello"])][::1]',
      '(*tuple(["COMMAND","hello"])[::1],)',
      'list(("COMMAND","hello")[::1])'
    ]
    for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
      for (const [index, factory] of factories.entries()) {
        for (const [routeIndex, route] of [
          'subprocess.METHOD(VECTOR)',
          'subprocess.METHOD(args=VECTOR)',
          'operator.call(subprocess.METHOD,VECTOR)',
          'getattr(subprocess,"METHOD")(VECTOR)'
        ].entries()) {
          it(`classifies sequence method=${method} factory=${index} route=${routeIndex}`, async () => {
            const code = (command: string): string =>
              prelude +
              route
                .replaceAll('METHOD', method)
                .replaceAll('VECTOR', factory.replaceAll('COMMAND', command))
            expect(await analyzeNotebookCodeRisk('python', code('echo'))).toEqual([])
            expect(
              (await analyzeNotebookCodeRisk('python', code('rm'))).map((risk) => risk.operation)
            ).toEqual([`subprocess.${method} nested execution`])
          })
        }
      }
    }
    it.each([
      'subprocess.run(["echo",value][:])',
      'subprocess.run(["unused","echo",value][1:])',
      'subprocess.run(list(("echo",)) + [value])',
      'subprocess.run(["unused","echo","rm","-rf","target.txt"][1:])',
      'subprocess.run(convert(("echo","hello"))[:],text=(convert:=os.unlink))',
      'subprocess.run((list(("echo",)) + ["hello"])[::1],text=(builtins:=None))',
      'for command in (1,2):\n    subprocess.run(["echo","hello"][:])'
    ])('preserves normal data and captured constructors: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    it.each([
      'subprocess.run(["echo","rm","target.txt"][1:])',
      'subprocess.run(["target.txt","rm"][::-1])',
      'subprocess.run(["echo",os.unlink("target.txt")][:1])',
      'subprocess.run([os.unlink("target.txt"),"echo","hello"][1:])',
      'subprocess.run(list(("echo",)) + [os.unlink("target.txt")])',
      'subprocess.run(["echo","hello"][start:])',
      'subprocess.run(["echo","hello"][:stop])',
      'subprocess.run(["echo","hello"][::step])',
      'subprocess.run(["echo","hello"][::0])',
      'subprocess.run(["echo","hello"][::False])',
      'subprocess.run(["echo","hello"][0.0:])',
      'subprocess.run(["echo","hello"][0,1])',
      'subprocess.run(["echo","hello"][slice(None,2)])',
      'subprocess.run(["echo","hello"][1000000000000000000000000:])',
      'subprocess.run(sequence[:])',
      'subprocess.run(factory()[1:])',
      'subprocess.run(["echo"] + factory())',
      'subprocess.run(list(("echo",)) + ("hello",))',
      'subprocess.run(tuple(["echo"]) + ["hello"])',
      'convert=factory;subprocess.run(convert(("echo","hello"))[:])',
      'def poison():\n    builtins.list=lambda value:["rm","target.txt"]\npoison()\nsubprocess.run(list(("echo","hello"))[:])',
      'subprocess.run(["echo","hello"][:],shell=True)',
      'subprocess.run(["echo","hello"][:],preexec_fn=os.unlink)',
      'subprocess.run(["echo","hello"][:],executable="rm")',
      'for command in (1,2):\n    subprocess.run(["rm","target.txt"][:])'
    ])('retains effects and unproved sequence operations: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    for (const incomplete of [false, true]) {
      it(`replays constructor aliases for sliced argv incomplete=${incomplete}`, async () => {
        const risks = await analyzeNotebookCodeRisk(
          'python',
          'subprocess.run(convert(("echo","hello"))[:])',
          undefined,
          [{ script: prelude, incomplete }]
        )
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'subprocess.run(convert(("rm","target.txt"))[:])',
              undefined,
              [{ script: prelude, incomplete }]
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
  })
  describe('Python closed process vector construction', () => {
    const prelude =
      'import subprocess,builtins,operator,os,functools\nconvert=list\nsplitter=str.split\n'
    const factories = [
      'list(("COMMAND","hello"))',
      'tuple(["COMMAND","hello"])',
      'builtins.list(("COMMAND","hello"))',
      'builtins.tuple(["COMMAND","hello"])',
      'convert(("COMMAND","hello"))',
      'operator.call(list,("COMMAND","hello"))',
      'list.__call__(("COMMAND","hello"))',
      'getattr(list,"__call__")(("COMMAND","hello"))',
      'tuple(list(("COMMAND","hello")))',
      'list(tuple(["COMMAND","hello"]))',
      '"COMMAND hello".split()',
      '"COMMAND hello".rsplit()',
      '"COMMAND hello".split.__call__()',
      'str.split("COMMAND hello")',
      'builtins.str.rsplit("COMMAND hello")',
      'splitter("COMMAND hello")',
      'operator.call("COMMAND hello".split)',
      'operator.call(operator.call,str.split,"COMMAND hello")',
      'getattr(str,"split")("COMMAND hello")',
      '"  COMMAND   hello  ".split(None,-1)',
      '"COMMAND hello".rsplit(maxsplit=1)',
      '"COMMAND hello".split(sep=None,maxsplit=0x1)',
      '"COMMAND hello".split(None,True)',
      '"COMMAND|hello".split("|")',
      '"COMMAND::hello".rsplit(sep="::",maxsplit=1)',
      'str.split("COMMAND|hello",sep="|")',
      '"COMMAND".split(None,False)',
      'list("COMMAND hello".split())',
      'tuple(str.split("COMMAND hello"))',
      '[*("COMMAND hello".split())]',
      '[*"COMMAND hello".split()]',
      '(*"COMMAND hello".rsplit(),)',
      '[*list(("COMMAND","hello"))]',
      '["COMMAND",*"hello world".split()]'
    ]
    for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
      for (const [factoryIndex, factory] of factories.entries()) {
        for (const [routeIndex, route] of [
          'subprocess.METHOD(VECTOR,check=True)',
          'subprocess.METHOD(args=VECTOR)',
          'operator.call(subprocess.METHOD,VECTOR)',
          'getattr(subprocess,"METHOD",None)(VECTOR)'
        ].entries()) {
          it(`classifies constructed argv method=${method} factory=${factoryIndex} route=${routeIndex}`, async () => {
            const code = (command: string): string =>
              prelude +
              route
                .replaceAll('METHOD', method)
                .replaceAll('VECTOR', factory.replaceAll('COMMAND', command))
            expect(await analyzeNotebookCodeRisk('python', code('echo'))).toEqual([])
            expect(
              (await analyzeNotebookCodeRisk('python', code('rm'))).map((r) => r.operation)
            ).toEqual([`subprocess.${method} nested execution`])
          })
        }
      }
    }
    for (const factory of [
      'list(SOURCE)',
      'tuple(SOURCE)',
      'TEXT.split()',
      'TEXT.rsplit()',
      'str.split(TEXT)',
      '[*TEXT.split()]',
      'tuple(list(TEXT.split()))',
      'SOURCE[:]',
      'list(SOURCE)[::1]',
      'tuple(SOURCE)[-99:99]',
      '(list(["unused"]) + SOURCE)[1:]',
      '(tuple(["unused"]) + tuple(SOURCE))[1:]',
      '(TEXT.split() + ["unused"])[:-1]',
      'SOURCE[::-1][::-1]'
    ]) {
      it.each([
        [
          ['cat', 'target.txt'],
          ['rm', 'target.txt']
        ],
        [
          ['head', '-n', '1', 'target.txt'],
          ['find', '.', '-delete']
        ],
        [
          ['wc', '-l', 'target.txt'],
          ['find', '.', '-exec', 'rm', 'target.txt', ';']
        ],
        [
          ['find', '.', '-maxdepth', '1', '-print'],
          ['bash', '-c', 'rm target.txt']
        ],
        [
          ['python', '--version'],
          ['python', '-c', 'import os;os.unlink(path)']
        ],
        [
          ['git', 'status', '--short'],
          ['git', 'clean', '-fd']
        ],
        [
          ['gzip', '-ck', 'target.txt'],
          ['gzip', '-f', 'target.txt']
        ],
        [
          ['echo', 'rm', '-rf', 'data'],
          ['rm', '-rf', 'data']
        ]
      ])(`preserves command semantics through ${factory}: %j`, async (reader, erase) => {
        const code = (args: string[]): string =>
          prelude +
          `subprocess.run(${factory
            .replaceAll('SOURCE', JSON.stringify(args))
            .replaceAll('TEXT', JSON.stringify(args.join(' ')))})`
        expect(await analyzeNotebookCodeRisk('python', code(reader))).toEqual([])
        expect((await analyzeNotebookCodeRisk('python', code(erase))).length).toBeGreaterThan(0)
      })
    }
    it.each([
      'subprocess.run("echo rm -rf target.txt".split())',
      'subprocess.run("echo|hello|rm target.txt".split("|",1))',
      'subprocess.run("echo|hello|rm target.txt".rsplit("|",2))',
      'subprocess.run("echo hello world  ".split(None,1))',
      'subprocess.run(list(("echo",value)))',
      'subprocess.run(["echo",value])',
      'subprocess.run(list(("echo","hello")),text=(convert:=os.unlink))',
      'subprocess.run(convert(("echo","hello")),text=(convert:=os.unlink))',
      'subprocess.run("echo:::hello".split("::",1))',
      'subprocess.run("rm:::target.txt".rsplit("::",1))',
      'subprocess.run("rm:::target.txt".rsplit("::"))',
      'subprocess.run("rm ".split(None,0))',
      'subprocess.run(" rm".rsplit(None,0))'
    ])('preserves ordinary argv data: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    it.each([
      'subprocess.run("rm target.txt".split(),text=(builtins:=None))',
      'subprocess.run(list(("python","-c","import os;os.unlink(path)")))',
      'subprocess.run(str.split("find . -delete"))',
      'subprocess.run(tuple(["find",".","-exec","rm","target.txt",";"]))',
      'subprocess.run("echo hello".split(),executable="rm")',
      'subprocess.run("echo hello".split(),preexec_fn=os.unlink)',
      'subprocess.run("echo hello".split(),shell=True)',
      'subprocess.run("echo hello".split(),env={"LD_PRELOAD":"module"})',
      'convert=factory;subprocess.run(convert(("echo","hello")))',
      'builtins.list=factory;subprocess.run(list(("echo","hello")))',
      'def poison():\n    builtins.list=lambda argv:["rm","target.txt"]\npoison()\nsubprocess.run(list(("echo","hello")))',
      'subprocess.run("echo hello".split(maxsplit=count))',
      'subprocess.run("echo hello".split(sep=delimiter))',
      'subprocess.run("echo hello".split(**options))',
      'subprocess.run(text.split())',
      'subprocess.run(b"echo hello".split())',
      'subprocess.run("echo hello".split())',
      'subprocess.run(list(generator))',
      'subprocess.run(list(("echo",os.unlink("target.txt"))))',
      'subprocess.run([*factory(("echo","hello"))])',
      'convert=factory;subprocess.run(convert(("echo","hello")),text=(convert:=list))',
      'convert=factory;subprocess.run([*convert(("echo","hello"))],text=(convert:=list))',
      'subprocess.run(functools.partial(list,("echo","hello"))())',
      'subprocess.run("rm:::target.txt".split("::",1))',
      'subprocess.run("rm target.txt ".split(None,1))',
      'subprocess.run("rm ".split())',
      'subprocess.run(" rm".rsplit())'
    ])('retains destructive or uncertain construction: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    for (const incomplete of [false, true]) {
      it(`replays factory aliases without keeping node vectors incomplete=${incomplete}`, async () => {
        const previous = { script: prelude + 'convert=list', incomplete }
        const risks = await analyzeNotebookCodeRisk(
          'python',
          'subprocess.run(convert(("echo","hello")))',
          undefined,
          [previous]
        )
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'subprocess.run(convert(("rm","target.txt")))',
              undefined,
              [previous]
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
  })
  describe('Python attribute fallback and module mutation evidence', () => {
    const prelude =
      'import os,io,builtins,operator,shutil,subprocess,functools\nlookup=builtins.getattr\nopener=io.open\nfallback=os.unlink\n'
    const lookups = [
      'getattr(RECEIVER,"METHOD",DEFAULT)',
      'builtins.getattr(RECEIVER,"METHOD",DEFAULT)',
      'lookup(RECEIVER,"METHOD",DEFAULT)',
      'operator.call(getattr,RECEIVER,"METHOD",DEFAULT)',
      'operator.call(operator.call,getattr,RECEIVER,"METHOD",DEFAULT)',
      'getattr(*(RECEIVER,"METHOD",DEFAULT))'
    ]
    for (const receiver of [
      'open("target.txt")',
      'builtins.open("target.txt")',
      'io.open("target.txt")',
      'opener("target.txt")'
    ]) {
      for (const method of ['read', 'readline', 'readlines', 'readable', 'seekable', 'isatty']) {
        for (const [route, lookup] of lookups.entries()) {
          for (const fallback of [
            'os.unlink',
            'shutil.rmtree',
            'subprocess.run',
            'fallback',
            'lambda:os.unlink("target.txt")'
          ]) {
            const returned = lookup
              .replaceAll('RECEIVER', receiver)
              .replaceAll('METHOD', method)
              .replaceAll('DEFAULT', fallback)
            it(`ignores an unused file fallback receiver=${receiver} method=${method} route=${route} default=${fallback}`, async () => {
              expect(await analyzeNotebookCodeRisk('python', prelude + `${returned}()`)).toEqual([])
              expect(
                await analyzeNotebookCodeRisk(
                  'python',
                  prelude + `saved=${returned};opener=str;lookup=print;saved()`
                )
              ).toEqual([])
            })
          }
        }
      }
    }
    for (const receiver of ['"test"', 'str', 'builtins.str']) {
      for (const method of ['upper', 'lower', 'strip', 'split', 'startswith', 'replace', 'join']) {
        it(`ignores unused native string fallback receiver=${receiver} method=${method}`, async () => {
          const args = receiver === '"test"' ? '' : '"test"'
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              prelude + `getattr(${receiver},"${method}",os.unlink)(${args})`
            )
          ).toEqual([])
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              prelude + `getattr(${receiver},"${method}",lambda:os.unlink("target.txt"))(${args})`
            )
          ).toEqual([])
        })
      }
    }
    it.each([
      'str',
      'bytes',
      'int',
      'float',
      'bool',
      'tuple',
      'list',
      'dict',
      'set',
      'frozenset',
      'object',
      'type'
    ])('ignores an unused native callable fallback %s', async (type) => {
      expect(
        await analyzeNotebookCodeRisk('python', prelude + `getattr(${type},"__call__",os.unlink)()`)
      ).toEqual([])
    })
    it.each([
      'getattr(open("target.txt"),"read",os.unlink("target.txt"))()',
      'getattr("test","upper",os.unlink("target.txt"))()',
      'getattr(str,"upper",lambda tag=os.unlink("target.txt"):os.unlink("other.txt"))("test")',
      'getattr(open("target.txt"),"read",lambda tag=os.unlink("target.txt"):None)()',
      'getattr(open("target.txt"),"missing",os.unlink)("target.txt")',
      'getattr("test","missing",os.unlink)("target.txt")',
      'getattr(str,"missing",os.unlink)("target.txt")',
      'getattr(os,"listdir",os.unlink)("target.txt")',
      'f=open("target.txt");getattr(f,"read",os.unlink)()',
      'getattr(open("target.txt",opener=custom),"read",os.unlink)()',
      'getattr(open("target.txt"),name,os.unlink)()',
      'getattr(open("target.txt"),"read",factory())()',
      'getattr(open("target.txt"),"read",**options)()',
      'open=factory;getattr(open("target.txt"),"read",os.unlink)()',
      'io.open=factory;getattr(io.open("target.txt"),"read",os.unlink)()',
      'builtins.str=factory;getattr(str,"upper",os.unlink)("target.txt")',
      'str=factory;getattr(str,"upper",os.unlink)("target.txt")',
      'getattr(os,"reader",lambda:os.unlink("target.txt"))()',
      'functools.partial(getattr,os,"unlink")()("target.txt")'
    ])('retains real eager effects or uncertain fallback: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', prelude + code)).length).toBeGreaterThan(0)
    })
    const writes = [
      'os.reader=VALUE',
      'alias=os;alias.reader=VALUE',
      'setattr(os,"reader",VALUE)',
      'builtins.setattr(os,"reader",VALUE)',
      'operator.call(setattr,os,"reader",VALUE)',
      'setattr(*(os,"reader",VALUE))',
      'os.reader,unused=(VALUE,42)',
      'unused,os.reader=(42,VALUE)'
    ]
    const calls = [
      'os.reader(ARGS)',
      'getattr(os,"reader")(ARGS)',
      'getattr(os,"reader",None)(ARGS)',
      'saved=getattr(os,"reader");os.reader=str;saved(ARGS)',
      'from os import reader;reader(ARGS)',
      'operator.attrgetter("reader")(os)(ARGS)'
    ]
    for (const [writeIndex, write] of writes.entries()) {
      for (const [callIndex, call] of calls.entries()) {
        for (const [value, args, operation] of [
          ['open("target.txt").read', '', undefined],
          ['os.unlink', '"target.txt"', 'os.unlink'],
          ['subprocess.run', '["echo","hello"],check=True', undefined],
          ['subprocess.run', '["rm","target.txt"],check=True', 'subprocess.run nested execution']
        ] as const) {
          it(`follows rewritten module members write=${writeIndex} call=${callIndex} value=${value} args=${args}`, async () => {
            const risks = await analyzeNotebookCodeRisk(
              'python',
              prelude + write.replaceAll('VALUE', value) + '\n' + call.replaceAll('ARGS', args)
            )
            expect(risks.map((risk) => risk.operation)).toEqual(operation ? [operation] : [])
          })
        }
      }
    }
    it.each([
      'os.listdir=lambda path:os.unlink(path);getattr(os,"listdir",None)("target.txt")',
      'alias=os;alias.listdir=lambda path:os.unlink(path);os.listdir("target.txt")',
      'os.reader=str\nif flag:\n    os.reader=os.unlink\nos.reader("target.txt")',
      'os.unlink=str if False else os.unlink;os.unlink("target.txt")',
      'receiver=os if flag else io;receiver.unlink=str;os.unlink("target.txt")',
      'receiver=os if flag else io;setattr(receiver,"unlink",str);os.unlink("target.txt")',
      'receiver=os if flag else io;receiver.unlink=lambda path:print(path);os.unlink("target.txt")',
      'os.reader=os.unlink;del os.reader;getattr(os,"reader",os.unlink)("target.txt")',
      'os.reader=os.unlink;delattr(os,"reader");getattr(os,"reader",os.unlink)("target.txt")',
      'os.reader=os.unlink;builtins.delattr(os,"reader");getattr(os,"reader",os.unlink)("target.txt")',
      'os.reader=os.unlink;getattr(os,"reader")((setattr(os,"reader",str),"target.txt")[1])',
      'os.reader=os.unlink;getattr(os,"reader",(os:=io) and None)("target.txt")',
      'saved=getattr(os,"missing",fallback);fallback=str;saved("target.txt")',
      'os.reader=str;getattr(os,"reader",setattr(os,"reader",os.unlink))("target.txt")',
      'builtins.str=os.unlink;getattr(str,"__call__",print)("target.txt")',
      'builtins.getattr=os.unlink;getattr("target.txt")',
      'builtins.open=os.unlink;getattr(open("target.txt"),"read",print)()',
      'os.reader=os.unlink;operator.methodcaller("reader","target.txt")(os)',
      'getattr(operator,"__call__")(os.unlink,"target.txt")'
    ])('preserves deletion after member changes: %s', async (code) => {
      expect(
        (await analyzeNotebookCodeRisk('python', prelude + code)).some((risk) =>
          risk.operation.includes('os.unlink')
        )
      ).toBe(true)
    })
    it.each([
      'os.reader=str;getattr(os,"reader")((setattr(os,"reader",os.unlink),"test")[1])',
      'os.reader=str;saved=getattr(os,"reader");os.reader=os.unlink;saved("test")',
      'os.reader=str;getattr(os,"reader",(os:=None))("test")',
      'saved=getattr(str,"upper",os.unlink);builtins.str=os.unlink;saved("test")',
      'os.reader=lambda:print("test");getattr(os,"reader")()',
      'alias=os;alias.reader=lambda:print("test");os.reader()',
      'os.reader=open("target.txt").read;operator.methodcaller("reader")(os)',
      'getattr(operator,"__call__")(open("target.txt").read)'
    ])('keeps captured or summarized readers ordinary: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + code)).toEqual([])
    })
    for (const incomplete of [false, true]) {
      it(`replays rewritten module evidence incomplete=${incomplete}`, async () => {
        const previous = { script: prelude + 'os.reader=os.unlink', incomplete }
        const risks = await analyzeNotebookCodeRisk(
          'python',
          'getattr(os,"reader",None)("target.txt")',
          undefined,
          [previous]
        )
        expect(risks.some((risk) => risk.operation === 'os.unlink')).toBe(true)
      })
      it(`replays saved file getter evidence incomplete=${incomplete}`, async () => {
        const previous = {
          script: prelude + 'saved=getattr(open("target.txt"),"read",os.unlink)',
          incomplete
        }
        const risks = await analyzeNotebookCodeRisk('python', 'saved()', undefined, [
          prelude + 'saved=os.unlink',
          previous
        ])
        if (incomplete) expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
    }
    for (const write of [
      'os.reader=VALUE',
      'setattr(os,"reader",VALUE)',
      'alias=os;alias.reader=VALUE'
    ]) {
      for (const call of [
        'install()',
        'alias_install=install;alias_install()',
        'operator.call(install)',
        'list(map(install,[None]))'
      ]) {
        it(`follows visible helper member writes write=${write} call=${call}`, async () => {
          const helper = (value: string): string =>
            `def install(unused=None):\n    ${write.replaceAll('VALUE', value)}\n${call}\n`
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              prelude + helper('open("target.txt").read') + 'os.reader()'
            )
          ).toEqual([])
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                prelude + helper('os.unlink') + 'getattr(os,"reader",None)("target.txt")'
              )
            ).some((risk) => risk.operation === 'os.unlink')
          ).toBe(true)
        })
      }
    }
    it.each([
      'os.reader=os.unlink\ndef install():\n    os.reader=os.unlink\nos.reader=str\ninstall()\nos.reader("target.txt")',
      'def install():\n    builtins.open=lambda path:object()\ninstall()\ngetattr(open("target.txt"),"read",os.unlink)("target.txt")',
      'def install():\n    io.open=lambda path:object()\ninstall()\ngetattr(io.open("target.txt"),"read",os.unlink)("target.txt")',
      'def install():\n    builtins.str=lambda value:object()\ninstall()\ngetattr(str,"upper",os.unlink)("target.txt")',
      'def outer():\n    def inner():\n        os.reader=os.unlink\n    inner()\nouter()\nos.reader("target.txt")',
      'fn=setattr if flag else print;fn(os,"unlink",str);os.unlink("target.txt")',
      'fn=functools.partial(setattr,io)\ntry: fn(os,"unlink",str)\nexcept TypeError: pass\nos.unlink("target.txt")'
    ])('retains deletion across helper and conditional mutation: %s', async (code) => {
      expect(
        (await analyzeNotebookCodeRisk('python', prelude + code)).some((risk) =>
          risk.operation.includes('os.unlink')
        )
      ).toBe(true)
    })
    it('does not execute an uncalled helper member rewrite', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          prelude +
            'def install():\n    os.reader=os.unlink\ngetattr(open("target.txt"),"read",os.unlink)()'
        )
      ).toEqual([])
    })
  })
  describe('Python literal dictionary method return provenance', () => {
    const methods = ['get', 'pop', 'setdefault']
    const lookups = [
      '(CONTAINER).METHOD(KEY)',
      'dict.METHOD(CONTAINER,KEY)',
      'builtins.dict.METHOD(CONTAINER,KEY)',
      'lookup(CONTAINER,KEY)',
      'operator.call(dict.METHOD,CONTAINER,KEY)',
      'operator.call((CONTAINER).METHOD,KEY)',
      'operator.call(operator.call,(CONTAINER).METHOD,KEY)',
      '(CONTAINER).METHOD.__call__(KEY)',
      '(CONTAINER).METHOD(*(KEY,))',
      'getattr(dict,"METHOD")(CONTAINER,KEY)'
    ]
    const routes = ['LOOKUP(ARGS)', 'saved=LOOKUP;lookup=str;saved(ARGS)']
    const containers = ['{"fn":VALUE}', '{"fn":str,**{"fn":VALUE}}', '({"fn":str}|{"fn":VALUE})']
    for (const method of methods) {
      const prelude = `import builtins,operator,os,pathlib,functools,subprocess\nlookup=dict.${method}\n`
      for (const [lookupIndex, lookup] of lookups.entries()) {
        for (const [routeIndex, route] of routes.entries()) {
          for (const [containerIndex, container] of containers.entries()) {
            for (const [value, args, operation] of [
              ['open("target.txt").read', '', undefined],
              ['pathlib.Path("target.txt").read_text', '', undefined],
              ['functools.partial(str).func', '"test"', undefined],
              ['os.unlink', '"target.txt"', 'os.unlink'],
              ['subprocess.run', '["echo","hello"],check=True', undefined],
              ['subprocess.run', '["echo","rm -rf"],check=True', undefined],
              [
                'subprocess.run',
                '["rm","target.txt"],check=True',
                'subprocess.run nested execution'
              ]
            ] as const) {
              it(`classifies method=${method} lookup=${lookupIndex} route=${routeIndex} container=${containerIndex} value=${value} args=${args}`, async () => {
                const code =
                  prelude +
                  route
                    .replaceAll(
                      'LOOKUP',
                      lookup
                        .replaceAll('CONTAINER', container.replaceAll('VALUE', value))
                        .replaceAll('METHOD', method)
                        .replaceAll('KEY', '"fn"')
                    )
                    .replaceAll('ARGS', args)
                const risks = await analyzeNotebookCodeRisk('python', code)
                expect(risks.map((risk) => risk.operation)).toEqual(operation ? [operation] : [])
              })
            }
          }
        }
      }
      it.each([
        '{"fn":str}.METHOD("fn",os.unlink)("test")',
        '{}.METHOD("fn",str)("test")',
        '{"other":os.unlink}.METHOD("fn",str)("test")',
        '{"fn":os.unlink,"fn":str}.METHOD("fn")("test")',
        '{**{"fn":os.unlink},"fn":str}.METHOD("fn")("test")',
        '{"fn":str,**{"other":os.unlink}}.METHOD("fn")("test")',
        '{0:os.unlink,False:str}.METHOD(0)("test")',
        '{-1:str}.METHOD(-1)("test")',
        '{"fn":str}.METHOD("f"+"n")("test")',
        'dict.METHOD(*({},"fn",str))("test")',
        'list(map({"fn":str}.METHOD("fn"),["test"]))',
        'functools.partial(dict.METHOD).func({"fn":str},"fn")("test")',
        'saved={"fn":str}.METHOD("fn");str=os.unlink;saved("test")',
        'fn=str;{"fn":fn}.METHOD("fn")((fn:=os.unlink))',
        'saved={"fn":os.unlink}.METHOD("fn")',
        'functools.partial(dict.METHOD,{"fn":str},"fn")()',
        'functools.partial(dict.METHOD)({"fn":str},"fn")',
        'operator.call(functools.partial(dict.METHOD,{"fn":os.unlink},"fn"))',
        'operator.call(operator.call,functools.partial(dict.METHOD),{"fn":os.unlink},"fn")',
        '{"fn":str}.METHOD("fn",None)("test")',
        '{"fn":str}.METHOD("fn",lambda:print("fallback"))("test")',
        '{"fn":str}.METHOD("fn",lambda:os.unlink("target.txt"))("test")',
        '{"fn":str}.METHOD("fn",lambda tag="unused":os.unlink("target.txt"))("test")',
        'dict.METHOD({"fn":str},"fn",lambda:os.unlink("target.txt"))("test")',
        'operator.call({"fn":str}.METHOD,"fn",lambda:os.unlink("target.txt"))("test")',
        '{"fn":str}.METHOD(*("fn",lambda:os.unlink("target.txt")))("test")'
      ])('keeps exact dictionary returns ordinary method=' + method + ': %s', async (code) => {
        expect(
          await analyzeNotebookCodeRisk('python', prelude + code.replaceAll('METHOD', method))
        ).toEqual([])
      })
      it.each([
        '{}.METHOD("fn",os.unlink)("target.txt")',
        '{"other":str}.METHOD("fn",os.unlink)("target.txt")',
        '{"fn":os.unlink}.METHOD("fn",str)("target.txt")',
        '{"fn":str,"fn":os.unlink}.METHOD("fn")("target.txt")',
        '{0:str,False:os.unlink}.METHOD(0)("target.txt")',
        'list(map({"fn":os.unlink}.METHOD("fn"),["target.txt"]))',
        '{"fn":str}.METHOD("fn",os.unlink("target.txt"))("test")',
        'fn=os.unlink;{"fn":fn}.METHOD("fn")((fn:=str) and "target.txt")',
        'fn=os.unlink;{"fn":fn}.METHOD("fn",(fn:=str))("target.txt")',
        'dict.METHOD({"fn":os.unlink},"fn",(fn:=str))("target.txt")',
        '{"fn":str}.METHOD("fn",lambda tag=os.unlink("target.txt"):"unused")("test")',
        '{"fn":os.unlink}.METHOD("fn",lambda:print("unused"))("target.txt")',
        '{}.METHOD("fn",lambda:os.unlink("target.txt"))()'
      ])('retains deletion method=' + method + ': %s', async (code) => {
        expect(
          (await analyzeNotebookCodeRisk('python', prelude + code.replaceAll('METHOD', method)))
            .length
        ).toBeGreaterThan(0)
      })
      it.each([
        '{"fn":str}.METHOD(key)("test")',
        '{"fn":str,**unknown}.METHOD("fn")("test")',
        '{key:str}.METHOD("fn",str)("test")',
        '{0.0:os.unlink}.METHOD(0,str)("target.txt")',
        'container.METHOD("fn")()',
        'dict.METHOD(container,"fn",str)("test")',
        '(str,).METHOD(0,str)("test")',
        '{"fn":str}.METHOD(*packed)("test")',
        '{"fn":str}.METHOD("fn",**options)("test")',
        '{"fn":str}.METHOD(key="fn")("test")',
        '{"fn":str}.METHOD("fn",str,str)("test")',
        '{"fn":lambda:os.unlink("target.txt")}.METHOD("fn")()',
        '{"fn":str}.METHOD("fn",factory())("test")',
        '{"fn":str}.METHOD("fn",obj.value)("test")',
        '{"fn":str}.METHOD("fn",f"{obj}")("test")',
        '{"fn":str}.METHOD("fn",obj+1)("test")',
        'saved={"fn":os.unlink}.METHOD;saved("fn")("target.txt")',
        'dict=custom;dict.METHOD({"fn":str},"fn")()',
        'get=functools.partial(dict.METHOD,{"fn":os.unlink},"fn");get()("target.txt")',
        'get=functools.partial(dict.METHOD);get({"fn":os.unlink},"fn")("target.txt")',
        'operator.call(functools.partial(dict.METHOD,{"fn":os.unlink},"fn"))("target.txt")',
        'operator.call(operator.call,functools.partial(dict.METHOD),{"fn":os.unlink},"fn")("target.txt")'
      ])('keeps unresolved construction method=' + method + ': %s', async (code) => {
        expect(
          (await analyzeNotebookCodeRisk('python', prelude + code.replaceAll('METHOD', method)))
            .length
        ).toBeGreaterThan(0)
      })
      for (const danger of [false, true]) {
        for (const incomplete of [false, true]) {
          it(`keeps captured dictionary result history method=${method} danger=${danger} incomplete=${incomplete}`, async () => {
            const previous =
              prelude + `saved={"fn":${danger ? 'os.unlink' : 'str'}}.${method}("fn")\nlookup=str`
            expect(
              (
                await analyzeNotebookCodeRisk('python', 'saved("target.txt")', undefined, [
                  { script: previous, incomplete }
                ])
              ).length > 0
            ).toBe(danger)
          })
        }
      }
      it('keeps eager unused default deletion once method=' + method, async () => {
        const risks = await analyzeNotebookCodeRisk(
          'python',
          prelude + `{"fn":str}.${method}("fn",os.unlink("target.txt"))("test")`
        )
        expect(risks.filter((risk) => risk.operation === 'os.unlink')).toHaveLength(1)
      })
    }
    it.each(['get', 'setdefault'])('keeps absent implicit None noncallable: %s', async (method) => {
      expect(await analyzeNotebookCodeRisk('python', `{}.${method}("fn")()`)).toEqual([])
    })
    it('keeps absent pop without default unresolved', async () => {
      expect((await analyzeNotebookCodeRisk('python', '{}.pop("fn")()')).length).toBeGreaterThan(0)
    })
    it('bounds dictionary expansion', async () => {
      const nested = '{**'.repeat(65) + '{"fn":str}' + '}'.repeat(65)
      expect(
        (await analyzeNotebookCodeRisk('python', `(${nested}).get("fn")("test")`)).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python closed literal item lookup provenance', () => {
    const lookups = [
      '(CONTAINER)[KEY]',
      'operator.getitem(CONTAINER,KEY)',
      'operator.__getitem__(CONTAINER,KEY)',
      'get(CONTAINER,KEY)',
      'operator.call(operator.getitem,CONTAINER,KEY)',
      'operator.call(operator.call,operator.getitem,CONTAINER,KEY)',
      'operator.itemgetter(KEY)(CONTAINER)',
      'select(KEY)(CONTAINER)',
      'operator.call(operator.itemgetter,KEY)(CONTAINER)',
      'operator.itemgetter(*(KEY,))(CONTAINER)',
      'operator.itemgetter(KEY).__call__(CONTAINER)',
      'operator.itemgetter(KEY)(*(CONTAINER,))'
    ]
    const routes = [
      'LOOKUP(ARGS)',
      'saved=LOOKUP;saved(ARGS)',
      'list(map(lambda _:LOOKUP(ARGS),[0]))'
    ]
    const containers = [
      ['(VALUE,)', '0'],
      ['[str,VALUE]', '-1'],
      ['[*[],VALUE]', '0'],
      ['{"fn":VALUE}', '"fn"'],
      ['{"fn":str,**{"fn":VALUE}}', '"fn"'],
      ['({"fn":str}|{"fn":VALUE})', '"fn"']
    ]
    const source = (
      lookup: string,
      route: string,
      container: string,
      key: string,
      value: string,
      args = ''
    ): string =>
      'import operator,os,pathlib,functools,subprocess\nfrom operator import getitem as get,itemgetter as select\n' +
      route
        .replaceAll(
          'LOOKUP',
          lookup
            .replaceAll('CONTAINER', container.replaceAll('VALUE', value))
            .replaceAll('KEY', key)
        )
        .replaceAll('ARGS', args)
    for (const [lookupIndex, lookup] of lookups.entries()) {
      for (const [routeIndex, route] of routes.entries()) {
        for (const [containerIndex, [container, key]] of containers.entries()) {
          for (const value of [
            'open("target.txt").read',
            'pathlib.Path("target.txt").read_text',
            'functools.partial(str)'
          ]) {
            it(`admits returned reader lookup=${lookupIndex} route=${routeIndex} container=${containerIndex} value=${value}`, async () => {
              expect(
                await analyzeNotebookCodeRisk(
                  'python',
                  source(lookup, route, container, key, value)
                )
              ).toEqual([])
            })
          }
          it(`retains returned deletion lookup=${lookupIndex} route=${routeIndex} container=${containerIndex}`, async () => {
            expect(
              (
                await analyzeNotebookCodeRisk(
                  'python',
                  source(lookup, route, container, key, 'os.unlink', '"target.txt"')
                )
              ).some((risk) => risk.operation.includes('unlink'))
            ).toBe(true)
          })
          for (const [args, danger] of [
            ['["echo","hello"]', false],
            ['["echo","rm -rf"]', false],
            ['["rm","target.txt"]', true],
            ['[program,"hello"]', true]
          ] as const) {
            it(`classifies returned process lookup=${lookupIndex} route=${routeIndex} container=${containerIndex} args=${args}`, async () => {
              expect(
                (
                  await analyzeNotebookCodeRisk(
                    'python',
                    source(lookup, route, container, key, 'subprocess.run', args)
                  )
                ).length > 0
              ).toBe(danger)
            })
          }
        }
      }
    }
    it.each([
      '(str,)[False]("test")',
      '[str,str][True]("test")',
      '[str,str][0x1]("test")',
      '(str,str)[-0b1]("test")',
      '([str]+[str])[+0o1]("test")',
      'operator.itemgetter(-1)((*(),str))("test")',
      'operator.itemgetter(1)((1+2,str))("test")',
      'operator.itemgetter(0)((open("target.txt",opener=None).read,))()',
      'operator.itemgetter(0)((open("target.txt",mode="r",encoding="utf-8").read,))()',
      'operator.itemgetter("f"+"n")({"fn":str})("test")',
      'operator.itemgetter("fn")({"fn":os.unlink,"fn":str})("test")',
      'operator.itemgetter("fn")({"fn":os.unlink,**{"fn":str}})("test")',
      'operator.itemgetter("fn")({**{"fn":os.unlink},"fn":str})("test")',
      'operator.itemgetter(0)({False:os.unlink,0:str})("test")',
      'operator.itemgetter("fn")({"fn":str,**{"other":os.unlink}})("test")',
      'operator.itemgetter(0,1)((str,os.unlink))',
      'operator.itemgetter("read","erase")({"read":str,"erase":os.unlink})',
      'list(map(operator.itemgetter(0),[(os.unlink,)]))',
      'saved=operator.getitem((os.unlink,),0)',
      'operator.methodcaller("sort",key=operator.itemgetter(0))([(1,),(0,)])'
    ])('keeps closed lookup and non-executed function values ordinary: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', `import operator,os\n${code}`)).toEqual([])
    })
    it.each([
      'operator.itemgetter("fn")({"fn":str,"fn":os.unlink})("target.txt")',
      'operator.itemgetter("fn")({"fn":str,**{"fn":os.unlink}})("target.txt")',
      'operator.itemgetter("fn")({**{"fn":str},"fn":os.unlink})("target.txt")',
      'operator.itemgetter(0)({0:str,False:os.unlink})("target.txt")',
      'operator.itemgetter("fn")({"fn":os.unlink,**{"other":str}})("target.txt")',
      'operator.itemgetter(0)((functools.partial(os.unlink),))("target.txt")',
      'operator.itemgetter(0)((functools.partial(os.unlink).func,))("target.txt")',
      'list(map(operator.itemgetter(0)((os.unlink,)),["target.txt"]))',
      'operator.itemgetter("run")({"run":subprocess.run})(["echo","hello"],preexec_fn=os.unlink)',
      '(str,factory())[0]("test")',
      'def change():\n    global fn\n    fn=os.unlink\nfn=str\noperator.itemgetter(1)((change(),fn))("target.txt")',
      'fn=os.unlink\noperator.itemgetter(0)((fn,(fn:=str)))("target.txt")',
      'fn=str\noperator.itemgetter(0)((fn,(fn:=os.unlink)))("test")',
      'operator.itemgetter(0)((open("target.txt",opener=callback).read,))()',
      'operator.itemgetter(0)((open("target.txt",**options).read,))()',
      'operator.itemgetter(0)((lambda: os.unlink("target.txt"),))()',
      'operator.itemgetter(0)((factory(),))()',
      'fn=str\noperator.itemgetter(1)((f"{obj}",fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((obj+0,fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((-obj,fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((obj==0,fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((obj and "tag",fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)(((*obj,),fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)(({**obj},fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)(({obj},fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)(({obj:"data"},fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((open(obj).read,fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((pathlib.Path(obj).read_text,fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((open("target.txt",buffering=obj).read,fn))("target.txt")',
      'fn=str\noperator.itemgetter(1)((obj.value,fn))("target.txt")',
      'operator.itemgetter(0)(container)()',
      'operator.itemgetter("fn")({"fn":str,**unknown})("test")',
      'operator.itemgetter("fn")({"fn":str,other:os.unlink})("test")',
      'operator.itemgetter(0)((*unknown,str))()',
      'operator.itemgetter(*unknown)((str,))()',
      'operator.itemgetter(index)((str,))()',
      'operator.itemgetter(0)(*(container,))()',
      'operator.getitem(container,0)()',
      'operator.getitem((str,),index)()',
      '(str,)[index]()',
      '(str,)[0,0]()',
      'operator.itemgetter(0,1)(container)()',
      'operator.itemgetter(9007199254740993)((str,))()',
      'operator.itemgetter("fn")({"fn":str,0.0:os.unlink})("test")'
    ])('retains returned effects or uncertain construction: %s', async (code) => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import operator,os,pathlib,functools,subprocess\n${code}`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    for (const danger of [false, true]) {
      for (const incomplete of [false, true]) {
        it(`preserves saved literal lookup history danger=${danger} incomplete=${incomplete}`, async () => {
          const previous = `import operator,os\nget=operator.itemgetter("fn")\nsaved=get({"fn":${danger ? 'os.unlink' : 'str'}})\nget=str`
          expect(
            (
              await analyzeNotebookCodeRisk('python', 'saved("target.txt")', undefined, [
                { script: previous, incomplete }
              ])
            ).length > 0
          ).toBe(danger)
        })
      }
    }
    it('keeps eager non-selected deletion exactly once', async () => {
      const risks = await analyzeNotebookCodeRisk(
        'python',
        'import operator,os;operator.itemgetter(0)((str,os.unlink("target.txt")))("test")'
      )
      expect(risks.filter((risk) => risk.operation === 'os.unlink')).toHaveLength(1)
    })
    it('bounds the number of frozen item selectors', async () => {
      const selectors = Array.from({ length: 65 }, () => 0).join(',')
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import operator;operator.itemgetter(${selectors})((str,))()`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python returned attribute getter provenance', () => {
    const factories = [
      'operator.attrgetter(NAME)',
      'pick(NAME)',
      'operator.call(operator.attrgetter,NAME)',
      'operator.__call__(operator.attrgetter,NAME)',
      'operator.attrgetter(*(NAME,))',
      'getattr(operator,"attrgetter")(NAME)'
    ]
    const routes = [
      'GETTER(RECEIVER)(ARGS)',
      'get=GETTER;get(RECEIVER)(ARGS)',
      'method=GETTER(RECEIVER);method(ARGS)',
      'operator.call(GETTER,RECEIVER)(ARGS)',
      'operator.call(operator.call,GETTER,RECEIVER)(ARGS)',
      'GETTER.__call__(RECEIVER)(ARGS)',
      'GETTER(*(RECEIVER,))(ARGS)',
      'list(map(lambda _:GETTER(RECEIVER)(ARGS),[0]))'
    ]
    const source = (
      factory: string,
      route: string,
      name: string,
      receiver: string,
      args = ''
    ): string =>
      'import operator,pathlib,subprocess,os;from operator import attrgetter as pick;' +
      route
        .replaceAll('GETTER', factory.replaceAll('NAME', JSON.stringify(name)))
        .replaceAll('RECEIVER', receiver)
        .replaceAll('ARGS', args)
    for (const [factoryIndex, factory] of factories.entries()) {
      for (const [routeIndex, route] of routes.entries()) {
        for (const [name, receiver] of [
          ['read_text', 'pathlib.Path("target.txt")'],
          ['read_bytes', 'pathlib.Path("target.txt")'],
          ['read', 'open("target.txt")'],
          ['readline', 'open("target.txt")'],
          ['upper', '"test"']
        ]) {
          it(`admits returned reader factory=${factoryIndex} route=${routeIndex} name=${name}`, async () => {
            expect(
              await analyzeNotebookCodeRisk('python', source(factory, route, name, receiver))
            ).toEqual([])
          })
        }
        it(`retains returned deletion factory=${factoryIndex} route=${routeIndex}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                source(factory, route, 'unlink', 'pathlib.Path("target.txt")')
              )
            ).some((r) => r.operation.includes('unlink'))
          ).toBe(true)
        })
        for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
          for (const [args, danger] of [
            ['["echo","hello"]', false],
            ['["echo","rm -rf"]', false],
            ['["rm","target.txt"]', true],
            ['[program,"hello"]', true]
          ] as const) {
            it(`classifies returned process factory=${factoryIndex} route=${routeIndex} method=${method} args=${args}`, async () => {
              expect(
                (
                  await analyzeNotebookCodeRisk(
                    'python',
                    source(factory, route, method, 'subprocess', args)
                  )
                ).length > 0
              ).toBe(danger)
            })
          }
        }
      }
    }
    it.each([
      'print(operator.attrgetter("__call__")(str)("test"))',
      'print(operator.attrgetter("func")(functools.partial(str))("test"))',
      'print(operator.attrgetter("__call__")(functools.partial(str))("test"))',
      'print(operator.attrgetter("nested.read_text")(record)())',
      'print(operator.attrgetter("read"+"_text")(pathlib.Path("target.txt"))())',
      'operator.attrgetter("read_text","unlink")(pathlib.Path("target.txt"))',
      'list(map(operator.attrgetter("unlink"),[pathlib.Path("target.txt")]))',
      'operator.methodcaller("sort",key=operator.attrgetter("name"))(records)',
      'saved=operator.attrgetter("unlink")(pathlib.Path("target.txt"))'
    ])('keeps attribute lookup and data access ordinary: %s', async (code) => {
      expect(
        await analyzeNotebookCodeRisk('python', `import operator,functools,pathlib;${code}`)
      ).toEqual([])
    })
    it.each([
      'operator.attrgetter("__call__")(os.unlink)("target.txt")',
      'operator.attrgetter("func")(functools.partial(os.unlink))("target.txt")',
      'operator.attrgetter("__call__")(functools.partial(os.unlink))("target.txt")',
      'operator.attrgetter("nested.unlink")(record)()',
      'operator.attrgetter("__call__")(factory())()',
      'operator.attrgetter(name)(record)()',
      'operator.attrgetter("read_text")(*unknown)()',
      'operator.attrgetter(*unknown)(record)()',
      'operator.call(operator.attrgetter,"read",*((),)[0])(open("target.txt"))()',
      'operator.attrgetter("read_text")(record,unknown)()',
      'operator.attrgetter("read_text")(record=record)()',
      'operator.attrgetter("run")(subprocess)(["echo","hello"],preexec_fn=os.unlink)',
      'list(map(operator.attrgetter("unlink")(pathlib.Path("target.txt")),[False]))'
    ])('retains returned execution and uncertainty: %s', async (code) => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import operator,functools,pathlib,os,subprocess;${code}`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    for (const danger of [false, true]) {
      for (const incomplete of [false, true]) {
        it(`preserves getter history danger=${danger} incomplete=${incomplete}`, async () => {
          const previous = `import operator,pathlib\nget=operator.attrgetter("${danger ? 'unlink' : 'read_text'}")\nsaved=get(pathlib.Path("target.txt"))\nget=str`
          const risks = await analyzeNotebookCodeRisk('python', 'saved()', undefined, [
            { script: previous, incomplete }
          ])
          expect(risks.length > 0).toBe(danger)
        })
      }
    }
    it('retains eager receiver deletion exactly once', async () => {
      const risks = await analyzeNotebookCodeRisk(
        'python',
        'import operator,os;operator.attrgetter("read")(open(os.unlink("target.txt")))()'
      )
      expect(risks.filter((r) => r.operation === 'os.unlink')).toHaveLength(1)
    })
    it('captures a getter before later factory mutation', async () => {
      const previous =
        'import operator\npick=operator.attrgetter\nget=operator.call(pick,"read",*())\npick=str'
      expect(
        await analyzeNotebookCodeRisk('python', 'get(open("target.txt"))()', undefined, [previous])
      ).toEqual([])
    })
    it('bounds dotted returned attributes', async () => {
      const names = Array.from({ length: 70 }, () => 'nested')
        .concat('unlink')
        .join('.')
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import operator;operator.attrgetter(${JSON.stringify(names)})(record)()`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python closed process option truth', () => {
    const falseFlags = [
      '""',
      "''",
      'r""',
      'b""',
      'f""',
      '"" ""',
      '""+""',
      '[]',
      '()',
      '{}',
      '[*[]]',
      '(*(),)',
      '[*([]+[])]',
      '[]+[]',
      '()+()',
      '{**{}}',
      '{}|{}',
      '{**({}|{})}',
      'not "False"',
      'not b"False"',
      'not [False]',
      'not (False,)',
      'not {0}',
      'not {"flag":False}',
      'not [None,0,""]',
      '"x" and ""',
      '[] or ()',
      'None or ""',
      '"" if [1] else "x"',
      'not not []'
    ]
    const trueFlags = [
      '"False"',
      'b"0"',
      '[False]',
      '(None,)',
      '{0}',
      '{"flag":False}',
      '[*(),1]',
      '{**{},"x":0}',
      'not []',
      '"" or "x"',
      '[0] and [False]',
      '"x" if [1] else ""'
    ]
    for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
      for (const flag of falseFlags) {
        for (const packed of [false, true]) {
          for (const danger of [false, true]) {
            it(`matches false process flag method=${method} flag=${flag} packed=${packed} danger=${danger}`, async () => {
              const option = packed ? `**{"shell":(${flag})}` : `shell=(${flag})`
              const args = danger ? '["rm","target.txt"]' : '["echo","hello"]'
              const code = `import subprocess;subprocess.${method}(${args},${option})`
              expect((await analyzeNotebookCodeRisk('python', code)).length > 0).toBe(danger)
            })
          }
        }
      }
      for (const flag of trueFlags) {
        for (const danger of [false, true]) {
          it(`matches true process flag method=${method} flag=${flag} danger=${danger}`, async () => {
            const command = danger ? 'rm target.txt' : 'printf test'
            const code = `import subprocess;subprocess.${method}(${JSON.stringify(command)},shell=(${flag}))`
            expect((await analyzeNotebookCodeRisk('python', code)).length > 0).toBe(
              danger || process.platform === 'win32'
            )
          })
        }
      }
    }
    it.each([
      'flag',
      '[] or flag',
      'flag and []',
      '[] if flag else []',
      '[*unknown]',
      '(*unknown,)',
      '{**unknown}',
      '{**{"x":0},**unknown}',
      '{unknown:0}',
      '{0:unknown}',
      '{unknown}',
      '[unknown]',
      '[f"{unknown}"]',
      'f"{flag}"',
      'set()',
      'not unknown',
      'not [*unknown]'
    ])('retains unknown process truth or hooks: %s', async (flag) => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import subprocess;subprocess.run(["echo","hello"],shell=(${flag}))`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      '[os.unlink("target.txt")]',
      'not [os.unlink("target.txt")]',
      '{"x":os.unlink("target.txt")}',
      '[*(os.unlink("target.txt"),)]',
      'os.unlink("target.txt") or []',
      '"" if os.unlink("target.txt") else ""'
    ])('retains eager effects while reading process truth: %s', async (flag) => {
      const risks = await analyzeNotebookCodeRisk(
        'python',
        `import os,subprocess;subprocess.run(["echo","hello"],shell=(${flag}))`
      )
      expect(risks.filter((r) => r.operation === 'os.unlink')).toHaveLength(1)
    })
    it.each(falseFlags.slice(0, 10))(
      'uses last literal option value without losing eager effects: %s',
      async (flag) => {
        expect(
          await analyzeNotebookCodeRisk(
            'python',
            `import subprocess;subprocess.run(["echo","hello"],**{"shell":unknown,"shell":(${flag})})`
          )
        ).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import os,subprocess;subprocess.run(["echo","hello"],**{"shell":os.unlink("target.txt"),"shell":(${flag})})`
            )
          ).some((r) => r.operation === 'os.unlink')
        ).toBe(true)
      }
    )
    it('keeps unknown inherited flags reviewable across history', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'subprocess.run(["echo","hello"],shell=flag)',
            undefined,
            ['import subprocess\nflag=unknown']
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python partial callable provenance', () => {
    const forms = [
      ['direct', 'functools.partial(TARGET)(ARG)'],
      ['frozen positional', 'functools.partial(TARGET,ARG)()'],
      ['saved', 'saved=functools.partial(TARGET);saved(ARG)'],
      ['saved frozen', 'saved=functools.partial(TARGET,ARG);saved()'],
      ['nested', 'functools.partial(functools.partial(TARGET),ARG)()'],
      ['explicit call', 'functools.partial(TARGET).__call__(ARG)'],
      ['func accessor', 'functools.partial(TARGET,ARG).func(ARG)'],
      ['getattr func', 'getattr(functools.partial(TARGET,ARG),"func")(ARG)'],
      ['saved func', 'saved=functools.partial(TARGET,ARG).func;saved(ARG)'],
      ['mapped callback', 'list(map(functools.partial(TARGET),[ARG]))'],
      ['sorted callback', 'sorted([ARG],key=functools.partial(TARGET))'],
      ['nested callback', 'list(map(functools.partial(functools.partial(TARGET)),[ARG]))'],
      ['forwarded factory', 'operator.call(functools.partial,TARGET,ARG)()'],
      ['forwarded invoke', 'operator.call(functools.partial(TARGET),ARG)'],
      ['packed factory', 'functools.partial(*(TARGET,ARG))()']
    ] as const
    for (const [name, form] of forms) {
      for (const [target, argument] of [
        ['str', '"target.txt"'],
        ['len', '[1,2]'],
        ['int', '"12"'],
        ['float', '"1.5"'],
        ['pathlib.Path.read_text', 'pathlib.Path("target.txt")']
      ]) {
        it(`admits partial reader ${name} ${target}`, async () => {
          const code = form.replaceAll('TARGET', target).replaceAll('ARG', argument)
          expect(
            await analyzeNotebookCodeRisk('python', `import functools,operator,pathlib;${code}`)
          ).toEqual([])
        })
      }
      it(`retains partial deletion ${name}`, async () => {
        const code = form.replaceAll('TARGET', 'os.unlink').replaceAll('ARG', '"target.txt"')
        expect(
          (await analyzeNotebookCodeRisk('python', `import functools,operator,os;${code}`)).some(
            (r) => r.operation.includes('os.unlink')
          )
        ).toBe(true)
      })
    }
    it.each([
      'from functools import partial as bind; print(bind(int,base=10)("12"))',
      'import functools; print(functools.partial(str.replace,"hello","h","j")())',
      'import functools; print(functools.partial(str.encode,"hello",encoding="utf-8")())',
      'import functools,pathlib; read=functools.partial(pathlib.Path("target.txt").read_text,encoding="utf-8");print(read())',
      'import functools; print(functools.partial(len).__call__([1,2]))',
      'import functools,os; fn=str; read=functools.partial(fn,(fn:=os.unlink));read("target.txt")',
      'import functools,os; fn=str; read=functools.partial(*(fn,(fn:=os.unlink)));read("target.txt")',
      'import functools,os; fn=str; read=functools.partial(fn,value=(fn:=os.unlink));read("target.txt")',
      'import functools,subprocess; run=functools.partial(subprocess.run,["rm","target.txt"]);run.func(["echo","hello"])',
      'import functools; functools.partial(len,[1,2]).keywords.update(extra=1)',
      'import functools,os; saved=functools.partial(os.unlink,"target.txt")'
    ])('keeps partial construction and scalar work ordinary: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', code)).toEqual([])
    })
    it.each([
      'import functools,os; fn=os.unlink; saved=functools.partial(fn,(fn:=str));saved("target.txt")',
      'import functools,os; fn=os.unlink; saved=functools.partial(*(fn,(fn:=str)));saved("target.txt")',
      'import functools,os; fn=os.unlink; saved=functools.partial(fn,value=(fn:=str));saved("target.txt")',
      'import functools,os; saved=functools.partial(os.unlink,os.unlink("target.txt"))',
      'import functools,os; defn=functools.partial(str,value=os.unlink("target.txt"))',
      'import functools; functools.partial(factory())()',
      'import functools; functools.partial(factory()).func()',
      'import functools; list(map(functools.partial(factory()),values))',
      'import functools; functools.partial(lambda x:x)(1)',
      'import functools; functools.partial(*unknown)()',
      'import functools; functools.partial(unknown)(1)',
      'import functools,os\ndef invoke(fn,path):\n    return fn(path)\nfunctools.partial(invoke,os.unlink,"target.txt")()',
      'import functools,os\ndef invoke(fn,path):\n    return fn(path)\nlist(map(functools.partial(invoke,os.unlink),["target.txt"]))',
      'import functools; saved=functools.partial(sorted,key=cleanup);saved(values)',
      'import functools,os; saved=functools.partial(sorted,key=len);saved.keywords["key"]=os.unlink;saved(["target.txt"])',
      'import functools,os; saved=functools.partial(open,"target.txt");saved.keywords["opener"]=os.unlink;saved()',
      'import functools,subprocess; run=functools.partial(subprocess.run);run(["echo","hello"])',
      'import functools,subprocess; run=functools.partial(subprocess.run,"rm target.txt");run.keywords["shell"]=True;run()',
      'import functools,subprocess; run=functools.partial(subprocess.run,["echo","hello"]);run.func(["rm","target.txt"])'
    ])('retains partial effects and signature uncertainty: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('python', code)).length).toBeGreaterThan(0)
    })
    for (const danger of [false, true]) {
      for (const incomplete of [false, true]) {
        it(`freezes partial history danger=${danger} incomplete=${incomplete}`, async () => {
          const previous = `import functools,os\nfn=${danger ? 'os.unlink' : 'str'}\nsaved=functools.partial(fn)\nfn=${danger ? 'str' : 'os.unlink'}`
          const result = await analyzeNotebookCodeRisk('python', 'saved("target.txt")', undefined, [
            { script: previous, incomplete }
          ])
          expect(result.length > 0).toBe(danger)
        })
      }
    }
    for (const danger of [false, true]) {
      it(`keeps summarized partial function effects danger=${danger}`, async () => {
        const previous = `import functools,os\ndef action(path):\n    ${danger ? 'os.unlink(path)' : 'return str(path)'}\nsaved=functools.partial(action,"target.txt")`
        expect(
          (await analyzeNotebookCodeRisk('python', 'saved()', undefined, [previous])).length
        ).toBeGreaterThan(0)
      })
    }
    it('bounds deeply nested partial callbacks', async () => {
      let target = 'str'
      for (let i = 0; i < 70; i++) target = `functools.partial(${target})`
      expect(
        (await analyzeNotebookCodeRisk('python', `import functools;list(map(${target},[1]))`))
          .length
      ).toBeGreaterThan(0)
    })
  })

  describe('Effective literal process environment values', () => {
    const fields = [
      ['PYTHONIOENCODING', 'custom-codec', 'utf-8'],
      ['PYTHONUTF8', 'custom', '1'],
      ['OMP_NUM_THREADS', 'unknown', '2'],
      ['LANG', 'custom; rm target.txt', 'C']
    ]
    const forms = [
      ['python', (a: string, b: string) => `{${a},${b}}`],
      ['python', (a: string, b: string) => `{**{${a}},**{${b}}}`],
      ['python', (a: string, b: string) => `{${a}}|{${b}}`],
      ['python', (a: string, b: string) => `{**({${a}}|{}),**({}|{${b}})}`],
      ['repl', (a: string, b: string) => `{${a},${b}}`],
      ['repl', (a: string, b: string) => `{...{${a}},...{${b}}}`],
      ['repl', (a: string, b: string) => `{...({...{${a}}}),...{...{${b}}}}`]
    ] as const
    forms.forEach(([language, wrap], form) => {
      const apis =
        language === 'python'
          ? ['run', 'call', 'check_call', 'check_output', 'Popen']
          : ['execFile', 'execFileSync', 'spawn', 'spawnSync']
      for (const [key, bad, good] of fields) {
        for (const api of apis) {
          for (const danger of [false, true]) {
            it(`uses final environment form=${form} api=${api} key=${key} danger=${danger}`, async () => {
              const pair = (value: string): string =>
                `${JSON.stringify(key)}:${JSON.stringify(value)}`
              const env = wrap(pair(danger ? good : bad), pair(danger ? bad : good))
              const code =
                language === 'python'
                  ? `import subprocess
subprocess.${api}(["echo","hello"],env=${env})`
                  : `require("child_process").${api}("echo",["hello"],{env:${env}})`
              expect((await analyzeNotebookCodeRisk(language, code)).length > 0).toBe(danger)
            })
          }
        }
      }
      for (const api of language === 'python' ? apis : ['exec', 'execSync']) {
        for (const [key, bad, good] of fields.slice(0, 2)) {
          for (const danger of [false, true]) {
            it(`uses final shell environment form=${form} api=${api} key=${key} danger=${danger}`, async () => {
              const pair = (value: string): string =>
                `${JSON.stringify(key)}:${JSON.stringify(value)}`
              const env = wrap(pair(danger ? good : bad), pair(danger ? bad : good))
              const code =
                language === 'python'
                  ? `import subprocess\nsubprocess.${api}("echo hello",shell=True,env=${env})`
                  : `require("child_process").${api}("echo hello",{env:${env}})`
              expect((await analyzeNotebookCodeRisk(language, code)).length > 0).toBe(
                danger || process.platform === 'win32'
              )
            })
          }
        }
      }
      it(`retains command deletion form=${form}`, async () => {
        const env = wrap('"PYTHONUTF8":"invalid"', '"PYTHONUTF8":"1"')
        const code =
          language === 'python'
            ? `import subprocess
subprocess.run(["rm","target.txt"],env=${env})`
            : `require("child_process").spawnSync("rm",["target.txt"],{env:${env}})`
        expect((await analyzeNotebookCodeRisk(language, code)).length).toBeGreaterThan(0)
      })
      it(`retains eager discarded value deletion form=${form}`, async () => {
        const call =
          language === 'python'
            ? 'os.unlink("target.txt")'
            : 'require("fs").unlinkSync("target.txt")'
        const env = wrap(`"PYTHONUTF8":${call}`, '"PYTHONUTF8":"1"')
        const code =
          language === 'python'
            ? `import os,subprocess
subprocess.run(["echo","hello"],env=${env})`
            : `require("child_process").spawnSync("echo",["hello"],{env:${env}})`
        expect((await analyzeNotebookCodeRisk(language, code)).length).toBeGreaterThan(0)
      })
    })
    it.each([
      ['python', '{"PYTHONIOENCODING":"custom"+"-codec","PYTHONIOENCODING":"utf-8"}'],
      ['python', '{"PYTHONIOENCODING":"custom" "-codec","PYTHONIOENCODING":"utf-8"}'],
      ['python', '{"NO_COLOR":"line\\ntext","NO_COLOR":"1"}'],
      ['repl', '{PYTHONIOENCODING:"custom"+"-codec",PYTHONIOENCODING:"utf-8"}'],
      ['repl', '{PYTHONIOENCODING:`custom`+`-codec`,PYTHONIOENCODING:"utf-8"}'],
      ['repl', '{NO_COLOR:"line\\ntext",NO_COLOR:"1"}']
    ] as const)('keeps closed discarded %s text %s', async (language, env) => {
      const code =
        language === 'python'
          ? `import subprocess\nsubprocess.run(["echo","hello"],env=${env})`
          : `require("child_process").spawnSync("echo",["hello"],{env:${env}})`
      expect(await analyzeNotebookCodeRisk(language, code)).toEqual([])
    })
    for (const language of ['python', 'repl'] as const) {
      it(`bounds nested effective environment ${language}`, async () => {
        let env = language === 'python' ? '{"PYTHONUTF8":"1"}' : '{PYTHONUTF8:"1"}'
        for (let i = 0; i < 70; i++) env = language === 'python' ? `{**${env}}` : `{...${env}}`
        const code =
          language === 'python'
            ? `import subprocess\nsubprocess.run(["echo","hello"],env=${env})`
            : `require("child_process").spawnSync("echo",["hello"],{env:${env}})`
        expect((await analyzeNotebookCodeRisk(language, code)).length).toBeGreaterThan(0)
      })
    }
    it.each([
      [
        'python',
        'import os,subprocess\nclass Value:\n    def __str__(self):\n        os.unlink("target.txt")\n        return "utf-8"\nsubprocess.run(["echo","hello"],env={"PYTHONIOENCODING":str(Value()),"PYTHONIOENCODING":"utf-8"})'
      ],
      [
        'repl',
        'const value={toString(){require("fs").unlinkSync("target.txt");return "utf-8"}};require("child_process").spawnSync("echo",["hello"],{env:{PYTHONIOENCODING:String(value),PYTHONIOENCODING:"utf-8"}})'
      ],
      [
        'repl',
        'const value={toString(){require("fs").unlinkSync("target.txt");return "0"}};require("child_process").spawnSync("echo",["hello"],{shell:String(value),shell:false})'
      ],
      [
        'repl',
        'const value={toString(){require("fs").unlinkSync("target.txt");return "0"}};require("child_process").spawnSync("echo",["hello"],{env:String(value),env:{NO_COLOR:"1"}})'
      ]
    ] as const)('retains discarded coercion effects in %s: %s', async (language, code) => {
      expect((await analyzeNotebookCodeRisk(language, code)).length).toBeGreaterThan(0)
    })
    it.each([
      ['python', '{"PYTHONUTF8":"1",**unknown}'],
      ['python', '{**unknown,"PYTHONUTF8":"1"}'],
      ['python', '{key:"invalid","PYTHONUTF8":"1"}'],
      ['python', '{"PYTHONUTF8":"1","LD_PRELOAD":"module"}'],
      ['repl', '{...unknown,PYTHONUTF8:"1"}'],
      ['repl', '{[key]:"invalid",PYTHONUTF8:"1"}'],
      [
        'repl',
        '{get PYTHONUTF8(){require("fs").unlinkSync("target.txt");return "0"},PYTHONUTF8:"1"}'
      ],
      [
        'repl',
        '{...{get PYTHONUTF8(){require("fs").unlinkSync("target.txt");return "0"}},PYTHONUTF8:"1"}'
      ],
      ['repl', '{__proto__:{LD_PRELOAD:"module"},PYTHONUTF8:"1"}'],
      ['repl', '{["__"+"proto__"]:{LD_PRELOAD:"module"},PYTHONUTF8:"1"}'],
      ['repl', '{PYTHONUTF8:"1",LD_PRELOAD:"module"}']
    ] as const)('retains unknown/effectful %s environment %s', async (language, env) => {
      const code =
        language === 'python'
          ? `import subprocess
subprocess.run(["echo","hello"],env=${env})`
          : `require("child_process").spawnSync("echo",["hello"],{env:${env}})`
      expect((await analyzeNotebookCodeRisk(language, code)).length).toBeGreaterThan(0)
    })
  })

  describe('JavaScript visible process option spreads', () => {
    const wraps = [
      (options: string): string => `{...{${options}}}`,
      (options: string): string => `{...({${options}})}`,
      (options: string): string => `{...{},...{...{${options}}},encoding:"utf8"}`,
      (options: string): string => `{cwd:".",...{...({${options}})},...{encoding:"utf8"}}`,
      (options: string): string => `{...{${options}}, /* options */ ...{}}`
    ]
    wraps.forEach((wrap, form) => {
      for (const api of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
        for (const options of [
          '',
          'shell:false',
          '[("sh"+"ell")]:false',
          'windowsVerbatimArguments:false',
          'env:{...{NO_COLOR:"1"},...{PYTHONUTF8:"1"}}'
        ]) {
          it(`accepts visible argv options form=${form} api=${api} options=${options}`, async () => {
            expect(
              await analyzeNotebookCodeRisk(
                'repl',
                `require("child_process").${api}("echo",["hello"],${wrap(options)})`
              )
            ).toEqual([])
          })
        }
        for (const options of [
          'shell:true',
          'windowsVerbatimArguments:true',
          'env:{LD_PRELOAD:"module"}',
          '__proto__:null'
        ]) {
          it(`retains dangerous options form=${form} api=${api} options=${options}`, async () => {
            expect(
              (
                await analyzeNotebookCodeRisk(
                  'repl',
                  `require("child_process").${api}("echo",["hello"],${wrap(options)})`
                )
              ).length
            ).toBeGreaterThan(0)
          })
        }
        it(`retains deletion command form=${form} api=${api}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'repl',
                `require("child_process").${api}("rm",["target.txt"],${wrap('shell:false')})`
              )
            ).length
          ).toBeGreaterThan(0)
        })
      }
      for (const api of ['exec', 'execSync']) {
        for (const danger of [false, true]) {
          it(`checks complete shell source form=${form} api=${api} danger=${danger}`, async () => {
            const code = `require("child_process").${api}(${JSON.stringify(danger ? 'rm target.txt' : 'echo hello')},${wrap('encoding:"utf8"')})`
            expect((await analyzeNotebookCodeRisk('repl', code)).length > 0).toBe(
              danger || process.platform === 'win32'
            )
          })
        }
      }
      it(`retains eager construction effect form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'repl',
              `require("child_process").spawnSync("echo",["hello"],${wrap('cwd:require("fs").unlinkSync("target.txt")')})`
            )
          ).length
        ).toBeGreaterThan(0)
      })
      it(`retains deferred callback form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'repl',
              `require("child_process").execFile("echo",["hello"],${wrap('shell:false')},()=>require("fs").unlinkSync("target.txt"))`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    })
    it.each([
      '{...options}',
      '{...factory()}',
      '{...[{shell:false}]}',
      '{...null}',
      '{...{get shell(){require("fs").unlinkSync("target.txt");return false}}}',
      '{...{get shell(){require("fs").unlinkSync("target.txt");return true}},shell:false}',
      '{shell:false,...{shell:true}}',
      '{...{[key]:false}}',
      '{...{["sh"+unknown]:false}}',
      '{...{env:{...process.env}}}',
      '{...{["__"+"proto__"]:null}}',
      '{...{toString(){require("fs").unlinkSync("target.txt")}}}',
      '{...{...{get env(){return {NO_COLOR:"1"}}}}}',
      '{...{shell:false},env:{LD_PRELOAD:"module"}}'
    ])('retains unresolved/effectful spread %s', async (options) => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'repl',
            `require("child_process").spawnSync("echo",["hello"],${options})`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      '{...{shell:true},shell:false}',
      '{shell:true,...{shell:false}}',
      '{...{windowsVerbatimArguments:true},windowsVerbatimArguments:false}',
      '{...{env:{LD_PRELOAD:"module"}},env:{NO_COLOR:"1"}}',
      '{...{env:unknown},env:{NO_COLOR:"1"}}',
      '{shell:true,shell:false}'
    ])('keeps fixed final option values %s', async (options) => {
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          `require("child_process").spawnSync("echo",["hello"],${options})`
        )
      ).toEqual([])
    })
    it('retains deletion constructing an overwritten option value', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'repl',
            'require("child_process").spawnSync("echo",["hello"],{...{env:require("fs").unlinkSync("target.txt")},env:{NO_COLOR:"1"}})'
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it('keeps prior option aliases unresolved after mutation', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'repl',
            'cp.spawnSync("echo",["hello"],{...options})',
            undefined,
            ['const cp=require("child_process");const options={shell:false};options.shell=true']
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it('bounds nested process option spreads', async () => {
      let options = '{shell:false}'
      for (let i = 0; i < 70; i++) options = `{...${options}}`
      expect(
        (
          await analyzeNotebookCodeRisk(
            'repl',
            `require("child_process").spawnSync("echo",["hello"],${options})`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('JavaScript fixed text concatenation', () => {
    const forms = [
      (a: string, b: string): string => `${JSON.stringify(a)}+${JSON.stringify(b)}`,
      (a: string, b: string): string => `(${JSON.stringify(a)})+(${JSON.stringify(b)})`,
      (a: string, b: string): string => `(""+${JSON.stringify(a)})+(${JSON.stringify(b)}+"")`,
      (a: string, b: string): string => `\`${a}\`+\`${b}\``,
      (a: string, b: string): string => `${JSON.stringify(a)}+\`${b}\``,
      (a: string, b: string): string => `(${JSON.stringify(a)} /* fixed */ + ${JSON.stringify(b)})`
    ]
    forms.forEach((join, form) => {
      for (const danger of [false, true]) {
        it(`resolves computed file method form=${form} danger=${danger}`, async () => {
          const code = `const fs=require("fs");fs[${join(danger ? 'un' : 'read', danger ? 'linkSync' : 'FileSync')}]("target.txt")`
          expect((await analyzeNotebookCodeRisk('repl', code)).length > 0).toBe(danger)
        })
        it(`resolves fixed require name form=${form} danger=${danger}`, async () => {
          const code = `require(${join('node:', 'fs')})[${JSON.stringify(danger ? 'unlinkSync' : 'readFileSync')}]("target.txt")`
          expect((await analyzeNotebookCodeRisk('repl', code)).length > 0).toBe(danger)
        })
        for (const api of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
          it(`resolves argv form=${form} api=${api} danger=${danger}`, async () => {
            const code = `require("child_process").${api}(${join(danger ? 'r' : 'ec', danger ? 'm' : 'ho')},[${join('target', '.txt')}])`
            expect((await analyzeNotebookCodeRisk('repl', code)).length > 0).toBe(danger)
          })
          it(`resolves process metadata form=${form} api=${api} danger=${danger}`, async () => {
            const code = `require("child_process").${api}("echo",["hello"],{env:{[${join(danger ? 'LD_' : 'NO_', danger ? 'PRELOAD' : 'COLOR')}]:${join('1', '')}}})`
            expect((await analyzeNotebookCodeRisk('repl', code)).length > 0).toBe(danger)
          })
          it(`resolves process option key form=${form} api=${api} danger=${danger}`, async () => {
            const code = `require("child_process").${api}("echo",["hello"],{[${join('sh', 'ell')}]:${danger}})`
            expect((await analyzeNotebookCodeRisk('repl', code)).length > 0).toBe(danger)
          })
        }
        for (const api of ['exec', 'execSync']) {
          it(`resolves shell source form=${form} api=${api} danger=${danger}`, async () => {
            const code = `require("child_process").${api}(${join(danger ? 'r' : 'ec', danger ? 'm target.txt' : 'ho hello')})`
            expect((await analyzeNotebookCodeRisk('repl', code)).length > 0).toBe(
              danger || process.platform === 'win32'
            )
          })
          it(`resolves complete injected source form=${form} api=${api} danger=${danger}`, async () => {
            const code = `require("child_process").${api}(${join('echo ', danger ? '$(rm target.txt)' : 'hello')})`
            expect((await analyzeNotebookCodeRisk('repl', code)).length > 0).toBe(
              danger || process.platform === 'win32'
            )
          })
        }
      }
      it(`retains eager method argument deletion form=${form}`, async () => {
        const code = `const fs=require("fs");fs[${join('read', 'FileSync')}](fs.unlinkSync("target.txt"))`
        expect((await analyzeNotebookCodeRisk('repl', code)).length).toBeGreaterThan(0)
      })
      it(`retains dangerous callback form=${form}`, async () => {
        const code = `const fs=require("fs");require("child_process").execFile(${join('ec', 'ho')},["hello"],()=>fs.unlinkSync("target.txt"))`
        expect((await analyzeNotebookCodeRisk('repl', code)).length).toBeGreaterThan(0)
      })
      it(`keeps historical fixed reader form=${form}`, async () => {
        expect(
          await analyzeNotebookCodeRisk('repl', 'read("target.txt")', undefined, [
            `const fs=require("fs");const read=fs[${join('read', 'FileSync')}]`
          ])
        ).toEqual([])
      })
      it(`retains historical fixed deletion form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk('repl', 'erase("target.txt")', undefined, [
              `const fs=require("fs");const erase=fs[${join('un', 'linkSync')}]`
            ])
          ).length
        ).toBeGreaterThan(0)
      })
    })
    it.each([
      '"ec"+command',
      'factory()+"ho"',
      '"echo "+{}',
      '"echo "+1',
      '"echo "+String(value)',
      '"echo "+`hello ${value}`',
      '"echo "+tag`hello`',
      '"echo "+"hel\\u006co"',
      '"echo "-"hello"',
      '"echo "|"hello"',
      '"echo "+({toString(){require("fs").unlinkSync("target.txt");return "hello"}})',
      '"echo "+({[Symbol.toPrimitive](){require("fs").unlinkSync("target.txt");return "hello"}})'
    ])('retains unknown/coercing text %s', async (value) => {
      expect(
        (await analyzeNotebookCodeRisk('repl', `require("child_process").execSync(${value})`))
          .length
      ).toBeGreaterThan(0)
    })
    it.each([
      '["__"+"proto__"]:null',
      '["windows"+"VerbatimArguments"]:true',
      'env:{["DYLD_"+"INSERT_LIBRARIES"]:"module"}',
      'env:{["NO_"+"COLOR"]:unknown}',
      '["sh"+key]:false',
      '["sh"+`ell${value}`]:false',
      '["sh"+String(value)]:false',
      '["sh"+{toString(){require("fs").unlinkSync("target.txt");return "ell"}}]:false'
    ])('retains uncertain/effectful process options %s', async (options) => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'repl',
            `require("child_process").spawnSync("echo",["hello"],{${options}})`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each(['execFile', 'execFileSync', 'spawn', 'spawnSync'])(
      'normalizes a parenthesized fixed %s option key without addition',
      async (api) => {
        expect(
          await analyzeNotebookCodeRisk(
            'repl',
            `require("child_process").${api}("echo",["hello"],{[("shell")]:false})`
          )
        ).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'repl',
              `require("child_process").${api}("echo",["hello"],{[("shell")]:true})`
            )
          ).length
        ).toBeGreaterThan(0)
      }
    )
    it('bounds fixed JavaScript addition depth', async () => {
      const value = Array(70).fill('""').join('+') + '+"echo"'
      expect(
        (
          await analyzeNotebookCodeRisk(
            'repl',
            `require("child_process").spawnSync(${value},["hello"])`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('R quoted literal process arguments', () => {
    const quoted = [
      (value: string): string => `shQuote(${value})`,
      (value: string): string => `base::shQuote(${value})`,
      (value: string): string => `quote_arg(${value})`,
      (value: string): string => `shQuote(string=${value})`,
      (value: string): string => `shQuote(str=${value},type="sh")`,
      (value: string): string => `base::shQuote(${value},type="s")`
    ]
    const literal = (value: string): string => (value.includes('"') ? `'${value}'` : `"${value}"`)
    const prelude = 'quote_arg <- base::shQuote\n'
    quoted.forEach((quote, form) => {
      for (const value of [
        'hello',
        'a b.txt',
        'a;b',
        '$HOME',
        '`uname`',
        "a'b",
        'a"b',
        "don't $HOME",
        "don't `uname`"
      ]) {
        for (const wrapped of [false, true]) {
          it(`keeps R literal quoted output form=${form} wrapped=${wrapped} value=${value}`, async () => {
            const args = quote(literal(value))
            const source = `system2("echo",${wrapped ? `c(NULL,c(${args}),character(0))` : args},stdout=TRUE)`
            expect((await analyzeNotebookCodeRisk('r', prelude + source)).length > 0).toBe(
              process.platform === 'win32'
            )
          })
        }
      }
      it(`keeps quoted character vector form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'r',
              prelude + `system2("echo",${quote('c("a b","$HOME")')},stdout=TRUE)`
            )
          ).length > 0
        ).toBe(process.platform === 'win32')
      })
      it(`keeps empty quoted vector form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'r',
              prelude + `system2("echo",${quote('character(0)')},stdout=TRUE)`
            )
          ).length > 0
        ).toBe(process.platform === 'win32')
      })
      it(`keeps historical quote alias form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'r',
              `system2("echo",${quote('"hello world"')},stdout=TRUE)`,
              undefined,
              [prelude]
            )
          ).length > 0
        ).toBe(process.platform === 'win32')
      })
      for (const [command, args] of [
        ['rm', quote('"target.txt"')],
        ['git', `c("branch",${quote('"-D"')},"target")`],
        ['find', `c(".",${quote('"-delete"')})`],
        ['tee', quote('"target.txt"')],
        ['gzip', quote('"target.txt"')],
        ['sh', `c("-c",${quote('"rm target.txt"')})`]
      ]) {
        it(`retains actual command effects form=${form} command=${command}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'r',
                prelude + `system2("${command}",${args},stdout=TRUE)`
              )
            ).length
          ).toBeGreaterThan(0)
        })
      }
      it(`retains unquoted injection beside quoted data form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'r',
              prelude + `system2("echo",c(${quote('"hello"')},"; rm target.txt"),stdout=TRUE)`
            )
          ).length
        ).toBeGreaterThan(0)
      })
      it(`retains output replacement form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'r',
              prelude + `system2("echo",${quote('"hello"')},stdout="target.txt")`
            )
          ).length
        ).toBeGreaterThan(0)
      })
      it(`retains env quoting form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'r',
              prelude + `system2("echo","hello",env=${quote('"NO_COLOR=1"')})`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    })
    it.each([
      'shQuote(value)',
      'shQuote(paste("hello","world"))',
      'shQuote("hello",type=type)',
      'shQuote("hello",type="cmd")',
      'shQuote("hello",type="cmd2")',
      'shQuote("hello",type="csh")',
      'shQuote("hello",unknown=TRUE)',
      'shQuote(c("hello",value))',
      'shQuote(shQuote("hello"))',
      'shQuote("hello",type="sh",type="sh")'
    ])('retains uncertain quote arguments %s', async (args) => {
      expect(
        (await analyzeNotebookCodeRisk('r', `system2("echo",${args},stdout=TRUE)`)).length
      ).toBeGreaterThan(0)
    })
    it.each([
      'shQuote <- function(string) { unlink("target.txt");base::shQuote(string) };system2("echo",shQuote("hello"),stdout=TRUE)',
      'quote_arg <- base::shQuote;quote_arg <- factory();system2("echo",quote_arg("hello"),stdout=TRUE)',
      'quote_arg <- base::shQuote;system2("echo",input=mutate(),args=quote_arg("hello"),stdout=TRUE)',
      'quote_arg <- base::shQuote;system2("echo",args=quote_arg("hello"),input=mutate(),stdout=TRUE)',
      'quote_arg <- base::shQuote;system2("echo",args=quote_arg("hello"),wait=mutate(),stdout=TRUE)',
      'quote_arg <- base::shQuote;system2("echo",args=quote_arg("hello"),receive.console.signals=mutate(),stdout=TRUE)',
      'system2("echo",shQuote(unlink("target.txt")),stdout=TRUE)',
      'system2("echo",shQuote(c("hello",unlink("target.txt"))),stdout=TRUE)'
    ])('retains quote construction and argument effects %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('r', source)).length).toBeGreaterThan(0)
    })
    it('bounds quoted vector depth', async () => {
      const value = 'c('.repeat(70) + '"hello"' + ')'.repeat(70)
      expect(
        (await analyzeNotebookCodeRisk('r', `system2("echo",shQuote(${value}),stdout=TRUE)`)).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python visible dictionary unions', () => {
    const unions = [
      (a: string, b: string): string => `{${a}}|{${b}}`,
      (a: string, b: string): string => `({}|{${a}})|({${b}}|{})`,
      (a: string, b: string): string => `({${a}}|{})|({}|{${b}})`,
      (a: string, b: string): string => `{**({${a}}|{})}|{**({}|{${b}})}`,
      (a: string, b: string): string => `({${a}} # prefix\n | {${b}})`
    ]
    unions.forEach((union, form) => {
      for (const danger of [false, true]) {
        it(`keeps opener union form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import os\nopen("target.txt",**(${union('"mode":"r"', danger ? '"opener":os.unlink' : '"encoding":"utf-8"')})).read()`
              )
            ).length > 0
          ).toBe(danger)
        })
        for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
          for (const shell of [false, true]) {
            const argv = shell
              ? JSON.stringify(danger ? 'rm target.txt' : 'echo hello')
              : JSON.stringify([danger ? 'rm' : 'echo', 'target.txt'])
            it(`keeps ${method} union form=${form} shell=${shell} danger=${danger}`, async () => {
              expect(
                (
                  await analyzeNotebookCodeRisk(
                    'python',
                    `import subprocess\nsubprocess.${method}(**(${union('"args":' + argv, '"shell":' + (shell ? 'True' : 'False'))}))`
                  )
                ).length > 0
              ).toBe(danger)
            })
          }
        }
        it(`keeps env union form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess\nsubprocess.run(["echo","hello"],env=(${union('"NO_COLOR":"1"', danger ? '"LD_PRELOAD":"module"' : '"PYTHONUNBUFFERED":"1"')}))`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps right-wins callback form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import os\nopen("target.txt",**(${union('"opener":' + (danger ? 'None' : 'os.unlink'), '"opener":' + (danger ? 'os.unlink' : 'None'))})).read()`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps right-wins command form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess\nsubprocess.run(**(${union('"args":' + JSON.stringify([danger ? 'echo' : 'rm', 'target.txt']), '"args":' + JSON.stringify([danger ? 'rm' : 'echo', 'target.txt']))}))`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps literal union preexec form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import os,subprocess\nsubprocess.run(["echo","hello"],**(${union('"shell":False', '"preexec_fn":' + (danger ? 'os.unlink' : 'None'))}))`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps historical runner form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `runner(**(${union('"args":' + JSON.stringify([danger ? 'rm' : 'echo', 'target.txt']), '"shell":False')}))`,
                undefined,
                ['import subprocess\nrunner=subprocess.run']
              )
            ).length > 0
          ).toBe(danger)
        })
      }
      it(`keeps eager effects form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import os\nopen("target.txt",**(${union('"opener":os.unlink("target.txt")', '"opener":None')})).read()`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    })
    for (const value of [
      'unknown|{}',
      '{}|unknown',
      '{**unknown}|{}',
      '{**{**unknown}}|{}',
      '{}|{**{unknown:None}}',
      '{**{**unknown}}|{"mode":"r"}',
      '{**{unknown:None}}|{"opener":None}',
      '{}|{unknown:None}',
      '{}|make_options()',
      '{}&{}',
      '{}+{}'
    ]) {
      it(`retains uncertain reader union ${value}`, async () => {
        expect(
          (await analyzeNotebookCodeRisk('python', `open("target.txt",**(${value})).read()`)).length
        ).toBeGreaterThan(0)
      })
      it(`retains uncertain env union ${value}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import subprocess\nsubprocess.run(["echo","hello"],env=(${value}))`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
    it('recognizes a native constructor union while retaining opener effects', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'open("target.txt",**({"opener":None}|dict(mode="r"))).read()'
        )
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'import os\nopen("target.txt",**({"opener":lambda p,f:os.unlink(p)}|dict(mode="r"))).read()'
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it('retains unsupported environment fields in a native constructor union', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'import subprocess\nsubprocess.run(["echo","hello"],env=({"opener":None}|dict(mode="r")))'
          )
        ).length
      ).toBeGreaterThan(0)
    })
    for (const [method, expression] of [
      ['__or__', 'Options()|{}'],
      ['__ror__', '{}|Options()']
    ] as const) {
      it(`retains actual union hook ${method}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import os
class Options:
    def ${method}(self,other):
        os.unlink("target.txt")
        return {"mode":"r"}
open("target.txt",**(${expression})).read()`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
    it('bounds union depth', async () => {
      const value = '('.repeat(70) + '{}' + '|{})'.repeat(70)
      expect(
        (await analyzeNotebookCodeRisk('python', `open("target.txt",**(${value})).read()`)).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python fixed text concatenation', () => {
    const text = [
      (a: string, b: string): string => `${JSON.stringify(a)}+${JSON.stringify(b)}`,
      (a: string, b: string): string => `(${JSON.stringify(a)}+"")+(${JSON.stringify(b)}+"")`,
      (a: string, b: string): string => `""+(${JSON.stringify(a)}+${JSON.stringify(b)})+""`,
      (a: string, b: string): string => `f${JSON.stringify(a)}+f${JSON.stringify(b)}`,
      (a: string, b: string): string => `r${JSON.stringify(a)}+r${JSON.stringify(b)}`,
      (a: string, b: string): string => `(${JSON.stringify(a)} "")+(${JSON.stringify(b)} "")`,
      (a: string, b: string): string =>
        `(${JSON.stringify(a)} # fixed prefix\n + ${JSON.stringify(b)})`,
      (a: string, b: string): string => `u${JSON.stringify(a)}+(""+u${JSON.stringify(b)})`
    ]
    text.forEach((join, form) => {
      for (const danger of [false, true]) {
        const name = danger ? join('un', 'link') : join('r', 'ead')
        const receiver = danger ? 'os' : 'open("target.txt")'
        it(`keeps member target form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import os\ngetattr(${receiver},${name})(${danger ? '"target.txt"' : ''})`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps saved member target form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import os\naction=getattr(${receiver},${name},None)\nalias=action\nalias(${danger ? '"target.txt"' : ''})`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps historical member target form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `action(${danger ? '"target.txt"' : ''})`,
                undefined,
                [`import os\naction=getattr(${receiver},${name})`]
              )
            ).length > 0
          ).toBe(danger)
        })
        for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
          for (const shell of [false, true]) {
            const command = shell
              ? join(danger ? 'r' : 'ec', danger ? 'm target.txt' : 'ho hello')
              : `[${join(danger ? 'r' : 'ec', danger ? 'm' : 'ho')},${join('target', '.txt')}]`
            it(`keeps ${method} command form=${form} shell=${shell} danger=${danger}`, async () => {
              expect(
                (
                  await analyzeNotebookCodeRisk(
                    'python',
                    `import subprocess\nsubprocess.${method}(${command},shell=${shell ? 'True' : 'False'})`
                  )
                ).length > 0
              ).toBe(danger)
            })
          }
        }
        it(`keeps packed process keys form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess\nsubprocess.run(**{${join('ar', 'gs')}: [${join(danger ? 'r' : 'ec', danger ? 'm' : 'ho')},"target.txt"],${join('sh', 'ell')}:False})`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps environment options form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess\nsubprocess.run(["echo","hello"],env={${join(danger ? 'LD_' : 'NO_', danger ? 'PRELOAD' : 'COLOR')}:${join('1', '')}})`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps shell payload form=${form} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess\nsubprocess.run(${join('echo ', danger ? '$(rm target.txt)' : 'hello')},shell=True)`
              )
            ).length > 0
          ).toBe(danger)
        })
      }
      it(`retains eager effect form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import os\ngetattr(open("target.txt"),${join('r', 'ead')},os.unlink("target.txt"))()`
            )
          ).length
        ).toBeGreaterThan(0)
      })
      it(`retains packed opener form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import os\nopen("target.txt",**{${join('op', 'ener')}:os.unlink})`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    })
    for (const value of [
      '"ec"+unknown',
      'unknown+"ho"',
      '"ec"+str(unknown)',
      '"ec"+f"{unknown}"',
      '"ec"+b"ho"',
      'b"ec"+b"ho"',
      '"ec"*2',
      '"ec" % unknown'
    ]) {
      it(`retains uncertain text ${value}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import subprocess\nsubprocess.run([${value},"hello"])`
            )
          ).length
        ).toBeGreaterThan(0)
      })
      it(`retains uncertain member ${value}`, async () => {
        expect(
          (await analyzeNotebookCodeRisk('python', `getattr(open("target.txt"),${value})()`)).length
        ).toBeGreaterThan(0)
      })
    }
    for (const [key, value, danger] of [
      ['NO_COLOR', '1', false],
      ['PYTHONUNBUFFERED', '1', false],
      ['LC_ALL', 'C', false],
      ['OMP_NUM_THREADS', '1', false],
      ['LD_PRELOAD', 'module', true],
      ['PYTHONPATH', 'module', true]
    ] as const) {
      for (const spelling of [
        `(${JSON.stringify(key)})`,
        `(( ${JSON.stringify(key)} ))`,
        `(${JSON.stringify(key.slice(0, 2))}+${JSON.stringify(key.slice(2))})`
      ]) {
        it(`keeps normalized environment key ${spelling} danger=${danger}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess\nsubprocess.run(["echo","hello"],env={${spelling}:${JSON.stringify(value)}})`
              )
            ).length > 0
          ).toBe(danger)
        })
      }
    }
    for (const key of ['NO_COLOR', '("NO_"+unknown)', '(unknown+"COLOR")']) {
      it(`retains computed environment key ${key}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import subprocess\nsubprocess.run(["echo","hello"],env={${key}:"1"})`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
    for (const [language, script] of [
      ['repl', 'const cp=require("child_process");cp.spawnSync("ec"+"ho",["hello"])'],
      ['r', 'system2("ec"+"ho","hello")']
    ] as const) {
      it(`keeps language-specific fixed text evidence ${language}`, async () => {
        expect((await analyzeNotebookCodeRisk(language, script)).length > 0).toBe(language === 'r')
      })
    }
    it('bounds fixed text concatenation depth', async () => {
      const value = '('.repeat(70) + '"echo"' + '+"")'.repeat(70)
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import subprocess\nsubprocess.run([${value},"hello"])`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python subprocess literal shell flags', () => {
    const flags: [string, boolean][] = [
      ['0', false],
      ['0x0', false],
      ['0x_0', false],
      ['0o0', false],
      ['0b0', false],
      ['0_0', false],
      ['0.0', false],
      ['0e5', false],
      ['0j', false],
      ['-0', false],
      ['+0.0', false],
      ['not True', false],
      ['not not False', false],
      ['not 1', false],
      ['1', true],
      ['-1', true],
      ['0x10', true],
      ['1e-5', true],
      ['1j', true],
      ['not False', true],
      ['not None', true],
      ['not 0', true],
      ['not -0', true],
      ['not not True', true],
      ['1e-999', false],
      ['1e999', true],
      ['0X00', false],
      ['0b_0', false],
      ['0o_0', false],
      ['0_0_0', false],
      ['0.0_0', false],
      ['0J', false],
      ['0.0j', false],
      ['0.0J', false],
      ['1_0', true],
      ['0x100000000000000000000000000000000', true],
      ['100000000000000000000000000000000000001', true]
    ]
    for (const [flag, shell] of flags) {
      for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
        for (const pack of [
          (argv: string): string => `${argv},shell=(${flag})`,
          (argv: string): string => `args=${argv},**{"shell":(${flag})}`,
          (argv: string): string => `*(${argv},),**{**{"shell":(${flag})}}`
        ]) {
          for (const danger of [false, true]) {
            const argv = shell
              ? JSON.stringify(danger ? 'rm target.txt' : 'echo hello')
              : JSON.stringify([danger ? 'rm' : 'echo', 'target.txt'])
            it(`classifies ${method} shell=${flag} packed=${pack(argv)} danger=${danger}`, async () => {
              expect(
                (
                  await analyzeNotebookCodeRisk(
                    'python',
                    `import subprocess\nsubprocess.${method}(${pack(argv)})`
                  )
                ).length > 0
              ).toBe(danger)
            })
          }
        }
      }
      for (const danger of [false, true]) {
        it(`keeps explicit forwarding shell=${flag} danger=${danger}`, async () => {
          const argv = shell
            ? JSON.stringify(danger ? 'rm target.txt' : 'echo hello')
            : JSON.stringify([danger ? 'rm' : 'echo', 'target.txt'])
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess,operator\noperator.call(subprocess.run,${argv},shell=(${flag}))`
              )
            ).length > 0
          ).toBe(danger)
        })
        it(`keeps preexec callback shell=${flag} danger=${danger}`, async () => {
          const argv = shell ? '"echo hello"' : '["echo","hello"]'
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import os,subprocess\nsubprocess.run(${argv},shell=(${flag}),preexec_fn=${danger ? 'os.unlink' : 'None'})`
              )
            ).length > 0
          ).toBe(danger)
        })
      }
    }
    for (const flag of [
      'unknown',
      'not unknown',
      '-unknown',
      'unknown+0',
      '0+unknown',
      '~0',
      '0 if unknown else 0'
    ]) {
      it(`retains uncertain flag ${flag}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import subprocess\nsubprocess.run(["echo","hello"],shell=(${flag}))`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
    for (const method of ['__bool__', '__len__']) {
      for (const flag of ['Flag()', 'not Flag()']) {
        it(`retains truth hook ${method} shell=${flag}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import os,subprocess
class Flag:
    def ${method}(self):
        os.unlink("target.txt")
        return ${method === '__bool__' ? 'False' : '0'}
subprocess.run(["echo","hello"],shell=${flag})`
              )
            ).length
          ).toBeGreaterThan(0)
        })
      }
    }
    for (const [flag, shell] of flags.filter((_, i) => [0, 6, 11, 14, 19, 24].includes(i))) {
      for (const override of [
        'env={"LD_PRELOAD":"module"}',
        'env={"PATH":"custom"}',
        'executable="rm"',
        '**unknown_options'
      ]) {
        it(`retains process overrides shell=${flag} option=${override}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess\nsubprocess.run(${shell ? '"echo hello"' : '["echo","hello"]'},shell=(${flag}),${override})`
              )
            ).length
          ).toBeGreaterThan(0)
        })
      }
      for (const danger of [false, true]) {
        it(`keeps historical process alias shell=${flag} danger=${danger}`, async () => {
          const argv = shell
            ? JSON.stringify(danger ? 'rm target.txt' : 'echo hello')
            : JSON.stringify([danger ? 'rm' : 'echo', 'target.txt'])
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `runner(${argv},shell=(${flag}))`,
                undefined,
                ['import subprocess\nrunner=subprocess.run']
              )
            ).length > 0
          ).toBe(danger)
        })
      }
    }
    it('bounds nested literal not flags', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import subprocess\nsubprocess.run(["echo","hello"],shell=${'not '.repeat(70)}False)`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python visible sequence concatenation', () => {
    const packs = [
      (left: string, right: string): string => `[${left}]+[${right}]`,
      (left: string, right: string): string => `(${left},)+(${right},)`,
      (left: string, right: string): string => `([]+[${left}])+([${right}]+[])`,
      (left: string, right: string): string => `(()+(${left},))+((${right},)+())`,
      (left: string, right: string): string => `([${left}]+[])+([${right}]+[])`,
      (left: string, right: string): string => `[*((${left},)+())]+[*(()+(${right},))]`,
      (left: string, right: string): string => `(*([${left}]+[]),)+(*([]+[${right}]),)`,
      (left: string, right: string): string => `([${left}, # command\n]+[${right}])`
    ]
    packs.forEach((pack, form) => {
      for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
        for (const shell of [false, true]) {
          const command = shell ? '"echo hello"' : '"echo"'
          it(`accepts output argv form=${form} method=${method} shell=${shell}`, async () => {
            expect(
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess\nsubprocess.${method}(${pack(command, '"hello"')}, shell=${shell ? 'True' : 'False'})`
              )
            ).toEqual([])
          })
          it(`retains deletion argv form=${form} method=${method} shell=${shell}`, async () => {
            expect(
              (
                await analyzeNotebookCodeRisk(
                  'python',
                  `import subprocess\nsubprocess.${method}(${pack(shell ? '"rm target.txt"' : '"rm"', '"target.txt"')}, shell=${shell ? 'True' : 'False'})`
                )
              ).length
            ).toBeGreaterThan(0)
          })
        }
      }
      for (const callback of ['len', 'os.unlink']) {
        it(`keeps map callback form=${form} target=${callback}`, async () => {
          const risks = await analyzeNotebookCodeRisk(
            'python',
            `import os\nlist(map(*(${pack(callback, '["target.txt"]')})))`
          )
          expect(risks.length > 0).toBe(callback === 'os.unlink')
        })
        it(`keeps forwarded callback form=${form} target=${callback}`, async () => {
          const risks = await analyzeNotebookCodeRisk(
            'python',
            `import os,operator\nlist(operator.call(*([map]+[*( ${pack(callback, '["target.txt"]')} )])))`
          )
          expect(risks.length > 0).toBe(callback === 'os.unlink')
        })
      }
      for (const member of ['listdir', 'unlink']) {
        it(`keeps getattr target form=${form} member=${member}`, async () => {
          const risks = await analyzeNotebookCodeRisk(
            'python',
            `import os\ngetattr(*(${pack('os', JSON.stringify(member))}))("target.txt")`
          )
          expect(risks.length > 0).toBe(member === 'unlink')
        })
      }
      for (const danger of [false, true]) {
        it(`keeps callback after seven slots form=${form} danger=${danger}`, async () => {
          const code = `import os\nopen(*(${pack('"target.txt", "r", -1, None, None, None, True', danger ? 'os.unlink' : 'None')})).read()`
          expect((await analyzeNotebookCodeRisk('python', code)).length > 0).toBe(danger)
        })
        it(`keeps process override form=${form} danger=${danger}`, async () => {
          const code = `import os,subprocess\nsubprocess.run(${pack('"echo"', '"hello"')}, preexec_fn=${danger ? 'os.unlink' : 'None'})`
          expect((await analyzeNotebookCodeRisk('python', code)).length > 0).toBe(danger)
        })
      }
      it(`retains eager construction effects form=${form}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import os,subprocess\nsubprocess.run(${pack('"echo"', 'os.unlink("target.txt")')})`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    })
    for (const value of [
      'unknown+["hello"]',
      '["echo"]+unknown',
      'make()+["hello"]',
      '["echo"]*count',
      '["echo"]+("hello",)',
      '("echo",)+["hello"]',
      '["echo",*unknown]+["hello"]'
    ]) {
      it(`retains uncertain argv ${value}`, async () => {
        expect(
          (await analyzeNotebookCodeRisk('python', `import subprocess\nsubprocess.run(${value})`))
            .length
        ).toBeGreaterThan(0)
      })
      it(`retains uncertain forwarding ${value}`, async () => {
        expect(
          (await analyzeNotebookCodeRisk('python', `list(map(*(${value})))`)).length
        ).toBeGreaterThan(0)
      })
    }
    for (const method of ['__add__', '__radd__']) {
      for (const use of ['subprocess.run(VALUE)', 'list(map(*(VALUE)))']) {
        it(`retains operator hooks ${method} use=${use}`, async () => {
          const value = method === '__add__' ? 'Arguments()+[]' : '[]+Arguments()'
          const script = `import os,subprocess
class Arguments:
    def ${method}(self, other):
        os.unlink("target.txt")
        return [len,["hello"]]
${use.replace('VALUE', value)}`
          expect((await analyzeNotebookCodeRisk('python', script)).length).toBeGreaterThan(0)
        })
      }
    }
    it('bounds concatenation depth without granting command trust', async () => {
      const value = '('.repeat(70) + '["echo"]' + '+[])'.repeat(70)
      expect(
        (await analyzeNotebookCodeRisk('python', `import subprocess\nsubprocess.run(${value})`))
          .length
      ).toBeGreaterThan(0)
    })
  })

  describe('incomplete historical execution provenance', () => {
    for (const failure of [
      'erase=1/0',
      '1/0\nerase=False',
      'erase=f"{1:invalid}"',
      'raise RuntimeError("failed")\nerase=False',
      'missing()\nerase=False',
      'erase=None+1',
      'erase=1<<-1',
      'erase=0**-1',
      'erase="%s%s" % "one"'
    ]) {
      it(`retains old deletion through incomplete cell: ${failure}`, async () => {
        expect(
          await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [
            'import os\nerase=os.unlink',
            { script: failure, incomplete: true }
          ])
        ).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'os.unlink' })]))
      })
    }
    for (const script of [
      'erase=None',
      'erase=not False',
      'erase=-1',
      'erase=1+2',
      'erase="value"',
      'erase=1>0',
      'erase=f"{1+2}"'
    ]) {
      it(`keeps completed clearing exact: ${script}`, async () => {
        expect(
          await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [
            'import os\nerase=os.unlink',
            { script, incomplete: false }
          ])
        ).toEqual([])
      })
    }
    it('retains deletion assigned before a later failure', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [
            'import os\nerase=os.listdir',
            { script: 'erase=os.unlink\n1/0\nerase=None', incomplete: true }
          ])
        ).length
      ).toBeGreaterThan(0)
    })
    it('keeps a completed later cell able to replace incomplete provenance', async () => {
      expect(
        await analyzeNotebookCodeRisk('python', 'erase(".")', undefined, [
          'import os\nerase=os.unlink',
          { script: '1/0\nerase=None', incomplete: true },
          { script: 'erase=os.listdir', incomplete: false }
        ])
      ).toEqual([])
    })
    it('keeps legacy completed source strings compatible', async () => {
      expect(
        await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [
          'import os\nerase=os.unlink',
          'erase=1+2'
        ])
      ).toEqual([])
    })
    for (const [language, setup, failed, completed, call] of [
      [
        'r',
        'erase <- unlink',
        'stop("failed");erase <- readLines',
        'erase <- readLines',
        'erase("target.txt")'
      ],
      [
        'repl',
        'const fs=require("node:fs");let erase=fs.unlinkSync',
        'throw new Error("failed");erase=fs.readFileSync',
        'erase=fs.readFileSync',
        'erase("target.txt")'
      ]
    ] as const) {
      it(`retains ${language} deletion from an incomplete prefix`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(language, call, undefined, [
              setup,
              { script: failed, incomplete: true }
            ])
          ).length
        ).toBeGreaterThan(0)
      })
      it(`keeps ${language} completed reader rebinding exact`, async () => {
        expect(
          await analyzeNotebookCodeRisk(language, call, undefined, [
            setup,
            { script: completed, incomplete: false }
          ])
        ).toEqual([])
      })
    }
    it('bounds prefix merging work for incomplete historical cells', async () => {
      const script = Array.from({ length: 500 }, (_, index) => `value${index}=0`).join('\n')
      expect(
        await analyzeNotebookCodeRisk('python', 'print("ok")', undefined, [
          { script, incomplete: true }
        ])
      ).toEqual([expect.objectContaining({ operation: 'code analysis unavailable' })])
    })
    it('retains deletion through a bounded incomplete statement sequence', async () => {
      const script =
        Array.from({ length: 25 }, (_, index) => `value${index}=0`).join('\n') + '\nerase=1/0'
      expect(
        await analyzeNotebookCodeRisk('python', 'erase("target.txt")', undefined, [
          'import os\nerase=os.unlink',
          { script, incomplete: true }
        ])
      ).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'os.unlink' })]))
    })
    it('bounds structured historical source size', async () => {
      expect(
        await analyzeNotebookCodeRisk('python', 'print("ok")', undefined, [
          { script: '#' + 'x'.repeat(1024 * 1024), incomplete: true }
        ])
      ).toEqual([
        expect.objectContaining({ operation: 'kernel source history exceeds analysis limit' })
      ])
    })
  })

  describe('Python closed scalar expression provenance', () => {
    const expressions = [
      '-1',
      '+1',
      '~1',
      'not False',
      'not (1 > 0)',
      '1+2',
      '1.5-2',
      '3*4',
      '6/2',
      '7//2',
      '7%2',
      '2**3',
      '1<<2',
      '8>>1',
      '1|2',
      '3&1',
      '1^2',
      '3+4j',
      '"a"+"b"',
      '"test"*2',
      '"%s" % "data"',
      'b"a"+b"b"',
      '1>0',
      '1<2<3',
      'None is None',
      '"a" in "data"',
      '1==1.0',
      'f"{-1}"',
      'f"{1+2}"',
      'f"{1 < 2}"',
      'f"{-1:>{2+3}}"',
      'f"{f\'{1+2}\'}"'
    ]
    for (const expression of expressions) {
      it.each([
        `getattr(os,"listdir",${expression})(".")`,
        `fallback=${expression};alias=fallback;getattr(open("target.txt"),"read",alias)()`,
        `fallback=alias=${expression};getattr(os,"listdir",alias)(".")`,
        `fallback,unused=(${expression},42);getattr(os,"listdir",fallback)(".")`,
        `getattr(os,"listdir",(fallback:=${expression}))(".")`,
        `list(map(getattr(os,"listdir",${expression}),["."]))`,
        `operator.call(getattr(os,"listdir",${expression}),".")`,
        `for fallback in [${expression}]:\n    getattr(os,"listdir",fallback)(".")`,
        `flag=${expression};reader=os.listdir if flag else os.scandir;reader(".")`
      ])(`keeps closed scalar data=${expression}: %s`, async (source) => {
        expect(await analyzeNotebookCodeRisk('python', 'import os,operator\n' + source)).toEqual([])
      })
      it(`keeps scalar data=${expression} through source replay`, async () => {
        expect(
          await analyzeNotebookCodeRisk(
            'python',
            'getattr(open("target.txt"),"read",alias)()',
            undefined,
            [`fallback=${expression};alias=fallback`]
          )
        ).toEqual([])
      })
      it.each([
        `getattr(os,"unlink",${expression})("target.txt")`,
        `fallback=${expression};fallback=os.unlink;getattr(os,"missing",fallback)("target.txt")`,
        `flag=${expression};erase=os.unlink if flag else os.listdir;erase("target.txt")`,
        `list(map(getattr(os,"unlink",${expression}),["target.txt"]))`
      ])(`retains deletion with scalar data=${expression}: %s`, async (source) => {
        expect(await analyzeNotebookCodeRisk('python', 'import os\n' + source)).toEqual(
          expect.arrayContaining([expect.objectContaining({ operation: 'os.unlink' })])
        )
      })
      it(`retains a previously selected deletion despite scalar rebinding=${expression}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk('python', 'saved("target.txt")', undefined, [
              'import os\nfallback=os.unlink\nsaved=getattr(os,"missing",fallback)',
              `fallback=${expression}`
            ])
          ).length
        ).toBeGreaterThan(0)
      })
    }
    it.each([
      '-value',
      '+value',
      '~value',
      'not value',
      'value+1',
      '1+value',
      'value==0',
      '0==value',
      'value<1',
      'value in "test"',
      '"%s" % value',
      'f"{value+1}"',
      'f"{-value}"',
      'f"{value==0}"',
      'f"{1:>{value}}"',
      'f"{[value]}"',
      '[value]==[value]',
      '{value:1}|{value:2}',
      'f"{factory()}"',
      '(factory()+1)',
      'a+1',
      'not factory()',
      '(os.unlink("target.txt") or 0)+1'
    ])(
      'keeps unknown operands, implicit hooks and eager effects reviewable: %s',
      async (expression) => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import os\na=1\nfallback=${expression}\ngetattr(os,"listdir",fallback)(".")`
            )
          ).length
        ).toBeGreaterThan(0)
      }
    )
    for (const [method, expression] of [
      ['__neg__', '-Value()'],
      ['__pos__', '+Value()'],
      ['__invert__', '~Value()'],
      ['__add__', 'Value()+1'],
      ['__radd__', '1+Value()'],
      ['__eq__', 'Value()==1'],
      ['__lt__', 'Value()<1'],
      ['__bool__', 'not Value()'],
      ['__format__', 'f"{Value()}"'],
      ['__repr__', '"%s" % [Value()]']
    ]) {
      it(`retains custom ${method} construction effects`, async () => {
        const source = `import os\nclass Value:\n    def ${method}(self,*args):\n        os.unlink("target.txt")\n        return True\nfallback=${expression}\ngetattr(os,"listdir",fallback)(".")`
        expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
      })
    }
    it('keeps deeply nested scalar proof bounded', async () => {
      const expression = '-('.repeat(70) + '1' + ')'.repeat(70)
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import os\nfallback=${expression}\ngetattr(os,"listdir",fallback)(".")`
          )
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('Python operand selection provenance', () => {
    const selections = [
      'os.listdir if flag else os.scandir',
      '(os.listdir if flag else os.scandir) if other else os.listdir',
      'None or os.listdir',
      'False or os.listdir',
      'flag and os.listdir',
      'None or (os.listdir if flag else os.scandir)',
      'os.listdir if True else os.unlink',
      'os.unlink if False else os.listdir',
      'True and os.listdir',
      '[] or os.listdir'
    ]
    for (const choice of selections) {
      const setup = 'import os,operator\nflag=True;other=False\n'
      it.each([
        `(${choice})(".")`,
        `reader=${choice};reader(".")`,
        `reader=${choice};alias=reader;alias(".")`,
        `list(map(${choice},["."]))`,
        `operator.call(${choice},".")`,
        `reader=${choice};list(map(reader,["."]))`,
        `reader=${choice};flag=None;other=[];reader(".")`
      ])(`keeps visible reader selection=${choice}: %s`, async (source) => {
        expect(await analyzeNotebookCodeRisk('python', setup + source)).toEqual([])
      })
      it(`keeps reader selection=${choice} across cells`, async () => {
        expect(
          await analyzeNotebookCodeRisk('python', 'reader(".")', undefined, [
            setup + `reader=${choice}`,
            'flag=None;other=False'
          ])
        ).toEqual([])
      })
    }
    for (const choice of [
      'None if flag else False',
      '[] if flag else {}',
      'None or False',
      'False and os.unlink',
      'True or os.unlink',
      'None if True else os.unlink',
      'os.unlink if False else None'
    ]) {
      it.each([
        `getattr(os,"listdir",${choice})(".")`,
        `fallback=${choice};getattr(os,"listdir",fallback)(".")`,
        `fallback=${choice};getattr(open("target.txt"),"read",fallback)()`,
        `fallback=${choice};list(map(getattr(os,"listdir",fallback),["."]))`
      ])(`keeps inert selection default=${choice}: %s`, async (source) => {
        expect(await analyzeNotebookCodeRisk('python', 'import os\nflag=True\n' + source)).toEqual(
          []
        )
      })
    }
    for (const choice of [
      'os.unlink if flag else os.listdir',
      'os.listdir if flag else os.unlink',
      'None or os.unlink',
      'True and os.unlink',
      'False or os.unlink',
      'os.unlink if True else os.listdir',
      'os.listdir if False else os.unlink'
    ]) {
      it.each([
        `(${choice})("target.txt")`,
        `erase=${choice};erase("target.txt")`,
        `list(map(${choice},["target.txt"]))`,
        `operator.call(${choice},"target.txt")`,
        `fallback=${choice};getattr(os,"missing",fallback)("target.txt")`
      ])(`retains deletion selection=${choice}: %s`, async (source) => {
        expect(
          await analyzeNotebookCodeRisk('python', 'import os,operator\nflag=True\n' + source)
        ).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'os.unlink' })]))
      })
      it(`keeps selected deletion=${choice} across cells and rebinding`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk('python', 'saved("target.txt")', undefined, [
              'import os\nflag=True\nsaved=' + choice,
              'flag=False;os.unlink=os.listdir'
            ])
          ).length
        ).toBeGreaterThan(0)
      })
    }
    it.each([
      '(os.listdir if unknown else os.scandir)(".")',
      '(factory() if flag else os.listdir)(".")',
      '(handlers[name] if flag else os.listdir)(".")',
      '(os.listdir if factory() else os.scandir)(".")',
      'list(map(os.listdir if unknown else os.scandir,["."]))',
      'flag=factory();reader=(flag:=True) if flag else (flag:=False);reader(".")',
      'reader=os.listdir if flag else os.unlink;flag=False;reader("target.txt")'
    ])('retains uncertain selections and callable alternatives: %s', async (source) => {
      expect(
        (await analyzeNotebookCodeRisk('python', 'import os\nflag=True\n' + source)).length
      ).toBeGreaterThan(0)
    })
    it.each([
      'reader=os.listdir if os.unlink("target.txt") else os.listdir',
      'reader=os.unlink("target.txt") if True else os.listdir',
      'reader=True and os.unlink("target.txt")',
      'reader=False or os.unlink("target.txt")',
      'erase=os.unlink\n(reader:=os.listdir) if flag else (reader:=erase)\nreader("target.txt")',
      'erase=os.unlink\n(reader:=erase) if flag else (reader:=os.listdir)\nreader("target.txt")',
      'erase=os.unlink\nflag and (erase:=os.listdir)\nerase("target.txt")',
      'erase=os.unlink\nflag or (erase:=os.listdir)\nerase("target.txt")',
      'import subprocess\nrunner=subprocess.run if flag else subprocess.call\nrunner(["rm","target.txt"])',
      'reader=open if flag else open\nreader("target.txt",opener=os.unlink)'
    ])(
      'retains reachable effects, joined walrus updates and process arguments: %s',
      async (source) => {
        expect(
          (await analyzeNotebookCodeRisk('python', 'import os\nflag=True\n' + source)).length
        ).toBeGreaterThan(0)
      }
    )
    it.each([
      'reader=os.listdir if True else os.unlink("target.txt")\nreader(".")',
      'reader=os.unlink("target.txt") if False else os.listdir\nreader(".")',
      'False and os.unlink("target.txt")',
      'True or os.unlink("target.txt")',
      'reader=os.listdir\n(reader:=os.unlink) if False else None\nreader(".")',
      'reader=os.listdir\nFalse and (reader:=os.unlink)\nreader(".")',
      'reader=os.listdir\nTrue or (reader:=os.unlink)\nreader(".")',
      'flag=factory();reader=(flag:=False) or os.listdir;reader(".")',
      'import subprocess\nrunner=subprocess.run if flag else subprocess.call\nrunner(["echo","hello"],env={"NO_COLOR":"1"})'
    ])(
      'skips syntactically unreachable effects and preserves ordinary subprocesses: %s',
      async (source) => {
        expect(await analyzeNotebookCodeRisk('python', 'import os\nflag=True\n' + source)).toEqual(
          []
        )
      }
    )
    it('retains custom truth testing even when branches replace its former binding', async () => {
      const source =
        'import os\nclass Flag:\n    def __bool__(self):\n        os.unlink("target.txt")\n        return True\nflag=Flag()\nreader=((flag:=True) and os.listdir) if flag else ((flag:=False) or os.listdir)\nreader(".")'
      expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
    })
  })

  describe('Python inert defaults through source bindings', () => {
    const defaults = [
      'False',
      'True',
      '0',
      '1.5',
      '2j',
      '""',
      'b""',
      '[]',
      '()',
      '{}',
      '{1}',
      'f"fallback"',
      'f"{1}"',
      'f"{True}"',
      '[os.unlink]',
      '{"erase":os.unlink}'
    ]
    for (const fallback of defaults) {
      it.each([
        `fallback=${fallback};alias=fallback;getattr(os,"listdir",alias)(".")`,
        `fallback=alias=${fallback};reader=getattr(os,"listdir",alias);reader(".")`,
        `fallback,unused=(${fallback},42);getattr(os,"listdir",fallback)(".")`,
        `fallback=${fallback}\nif flag:\n    fallback=None\ngetattr(os,"listdir",fallback)(".")`,
        `for fallback in [${fallback}]:\n    getattr(os,"listdir",fallback)(".")`,
        `getattr(os,"listdir",(fallback:=${fallback}))(".")`,
        `fallback=${fallback};list(map(getattr(os,"listdir",fallback),["."]))`,
        `fallback=${fallback};operator.call(getattr(os,"listdir",fallback),".")`,
        `fallback=${fallback};getattr(open("target.txt"),"read",fallback)()`,
        `fallback=${fallback};getattr(frame,"dropna",fallback)().mean()`
      ])(`keeps inert default=${fallback} through binding: %s`, async (source) => {
        expect(await analyzeNotebookCodeRisk('python', 'import os,operator\n' + source)).toEqual([])
      })
      it(`keeps inert default=${fallback} across cells`, async () => {
        expect(
          await analyzeNotebookCodeRisk('python', 'getattr(os,"listdir",alias)(".")', undefined, [
            `import os\nfallback=${fallback}\nalias=fallback`
          ])
        ).toEqual([])
      })
      it.each([
        `fallback=${fallback};getattr(os,"unlink",fallback)("target.txt")`,
        `fallback=${fallback}\nif flag:\n    fallback=os.unlink\ngetattr(os,"listdir",fallback)("target.txt")`,
        `fallback=${fallback};fallback=os.unlink;getattr(os,"missing",fallback)("target.txt")`,
        `fallback=${fallback};list(map(getattr(os,"unlink",fallback),["target.txt"]))`
      ])(
        `retains deletion/branch alternatives with inert default=${fallback}: %s`,
        async (source) => {
          expect(await analyzeNotebookCodeRisk('python', 'import os\n' + source)).toEqual(
            expect.arrayContaining([expect.objectContaining({ operation: 'os.unlink' })])
          )
        }
      )
    }
    it.each([
      'fallback=[os.unlink("target.txt")];getattr(os,"listdir",fallback)(".")',
      'fallback={os.unlink("target.txt"):1};getattr(os,"listdir",fallback)(".")',
      'fallback=(os.unlink("target.txt"),);getattr(os,"listdir",fallback)(".")',
      `fallback=f"{os.unlink('target.txt')}";getattr(os,"listdir",fallback)(".")`,
      'fallback=[os.unlink];erase=fallback[0];erase("target.txt")',
      'fallback={"erase":os.unlink};erase=fallback["erase"];erase("target.txt")',
      'fallback=[];fallback.append(os.unlink);fallback[0]("target.txt")',
      'fallback=[];fallback=factory();getattr(os,"listdir",fallback)(".")',
      'fallback={};fallback=handlers[name];getattr(os,"listdir",fallback)(".")',
      'fallback,erase=(False,os.unlink);erase("target.txt")',
      'fallback=alias=False;alias=os.unlink;getattr(os,"missing",alias)("target.txt")',
      'class Handler:\n    def __call__(self,path):\n        os.unlink(path)\nfallback=Handler();getattr(os,"missing",fallback)("target.txt")'
    ])(
      'retains construction effects, extracted members and rebound callables: %s',
      async (source) => {
        expect(
          (await analyzeNotebookCodeRisk('python', 'import os\n' + source)).length
        ).toBeGreaterThan(0)
      }
    )
    it.each([
      'fallback=[];saved=getattr(os,"listdir",fallback);fallback=os.unlink;saved(".")',
      'fallback={};saved=getattr(os,"listdir",fallback);fallback["erase"]=os.unlink;saved(".")',
      'fallback,alias=(False,False);saved=getattr(os,"listdir",alias);alias=os.unlink;saved(".")'
    ])('keeps selected reader fixed after changing its former default: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('python', 'import os\n' + source)).toEqual([])
    })
    it.each([
      'fallback=f"{Text()}"',
      'fallback=[f"{Text()}"]',
      'fallback={"value":f"{Text()}"}',
      'fallback=f"{1:{Text()}}"',
      'fallback=f"{Text()!r}"'
    ])(
      'retains implicit formatting side effects while constructing a default: %s',
      async (construction) => {
        const source =
          'import os\nclass Text:\n    def __format__(self,spec):\n        os.unlink("target.txt")\n        return "value"\n    def __repr__(self):\n        os.unlink("target.txt")\n        return "value"\n' +
          construction +
          '\ngetattr(os,"listdir",fallback)(".")'
        expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
      }
    )
    it('retains destructive defaults selected in an earlier cell after rebinding', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk('python', 'saved("target.txt")', undefined, [
            'import os\nfallback=os.unlink\nsaved=getattr(os,"missing",fallback)',
            'fallback=False'
          ])
        ).length
      ).toBeGreaterThan(0)
    })
  })

  describe('literal defaults and explicit function selection', () => {
    for (const fallback of [
      'False',
      'True',
      '0',
      '1.5',
      '2j',
      '""',
      'b""',
      '[]',
      '()',
      '{}',
      '{1}',
      '(False)'
    ]) {
      for (const lookup of ['getattr', 'builtins.getattr', 'lookup']) {
        const prefix = 'import os,builtins,operator\nlookup=builtins.getattr\n'
        it.each([
          `${lookup}(os,"listdir",${fallback})(".")`,
          `reader=${lookup}(os,"listdir",${fallback});reader(".")`,
          `list(map(${lookup}(os,"listdir",${fallback}),["."]))`,
          `operator.call(${lookup}(os,"listdir",${fallback}),".")`,
          `${lookup}(open("target.txt"),"read",${fallback})()`,
          `reader=${lookup}(frame,"to_numpy",${fallback});reader()`,
          `${lookup}(frame,"dropna",${fallback})().mean()`
        ])(
          `keeps Python inert default lookup=${lookup} default=${fallback}: %s`,
          async (source) => {
            expect(await analyzeNotebookCodeRisk('python', prefix + source)).toEqual([])
          }
        )
        it.each([
          `${lookup}(os,"unlink",${fallback})("target.txt")`,
          `erase=${lookup}(os,"unlink",${fallback});erase("target.txt")`,
          `list(map(${lookup}(os,"unlink",${fallback}),["target.txt"]))`,
          `operator.call(${lookup}(os,"unlink",${fallback}),"target.txt")`
        ])(
          `retains Python deletion with inert default lookup=${lookup} default=${fallback}: %s`,
          async (source) => {
            expect(await analyzeNotebookCodeRisk('python', prefix + source)).toEqual(
              expect.arrayContaining([expect.objectContaining({ operation: 'os.unlink' })])
            )
          }
        )
      }
    }
    it.each([
      'getattr(os,"listdir",[os.unlink("target.txt")])(".")',
      'getattr(os,"listdir",{os.unlink("target.txt"):1})(".")',
      'getattr(os,"listdir",(os.unlink("target.txt"),))(".")',
      `getattr(os,"listdir",f"{os.unlink('target.txt')}")(".")`,
      'getattr(os,"listdir",factory())(".")',
      'getattr(os,"listdir",handlers[name])(".")',
      'getattr(os,name,False)(".")'
    ])('retains Python default construction effects and uncertainty: %s', async (source) => {
      expect(
        (await analyzeNotebookCodeRisk('python', 'import os\n' + source)).length
      ).toBeGreaterThan(0)
    })
    for (const lookup of ['match.fun', 'base::match.fun', 'lookup']) {
      const prefix = 'lookup <- base::match.fun\n'
      for (const target of [
        'base::readLines',
        'readLines',
        '"readLines"',
        'base::sum',
        'sum',
        '"sum"'
      ]) {
        const arg = target.includes('readLines') ? '"target.txt"' : '1:3'
        it.each([
          `${lookup}(${target})(${arg})`,
          `reader <- ${lookup}(${target});reader(${arg})`,
          `lapply(list(${arg}),${lookup}(${target}))`,
          `${lookup}(FUN=${target},descend=FALSE)(${arg})`,
          `${lookup}(des=TRUE,F=${target})(${arg})`
        ])(`keeps R explicit function lookup=${lookup} target=${target}: %s`, async (source) => {
          expect(await analyzeNotebookCodeRisk('r', prefix + source)).toEqual([])
        })
      }
      it.each(
        [
          `${lookup}(unlink)("target.txt")`,
          `${lookup}("unlink")("target.txt")`,
          `${lookup}(base::file.remove)("target.txt")`,
          `erase <- ${lookup}(base::unlink);erase("target.txt")`,
          `lapply("target.txt",${lookup}(unlink))`,
          `readLines <- unlink;${lookup}("readLines")("target.txt")`,
          `${lookup}(factory())("target.txt")`,
          `${lookup}(name)("target.txt")`,
          `${lookup}("readLines",descend=setting)("target.txt")`,
          `readLines <- NULL;${lookup}("readLines")("target.txt")`,
          `${lookup}(base::readLines,descend=unlink("target.txt"))("target.txt")`,
          `${lookup}(base::readLines)(unlink("target.txt"))`,
          `${lookup} <- unlink;${lookup}("target.txt")`
        ].filter(
          (source) =>
            lookup !== 'base::match.fun' || !source.startsWith('base::match.fun <- unlink;')
        )
      )(
        `retains R function selection mutation/uncertainty lookup=${lookup}: %s`,
        async (source) => {
          expect((await analyzeNotebookCodeRisk('r', prefix + source)).length).toBeGreaterThan(0)
        }
      )
      it(`keeps R selected reader frozen lookup=${lookup}`, async () => {
        expect(
          await analyzeNotebookCodeRisk(
            'r',
            prefix + `reader <- ${lookup}(base::readLines);readLines <- unlink;reader("target.txt")`
          )
        ).toEqual([])
      })
      it(`retains R selected deletion frozen lookup=${lookup}`, async () => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'r',
              prefix + `erase <- ${lookup}(base::unlink);unlink <- readLines;erase("target.txt")`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
    for (const lookup of ['match.fun', 'base::match.fun', 'lookup']) {
      for (const invoke of [
        (target: string, args: string) => `${lookup}(${target})(${args})`,
        (target: string, args: string) => `selected <- ${lookup}(${target});selected(${args})`,
        (target: string, args: string) => `base::match.fun(${lookup}(${target}))(${args})`
      ]) {
        it(`keeps R selected process reader lookup=${lookup} route=${invoke('target', 'args')}`, async () => {
          expect(
            await analyzeNotebookCodeRisk(
              'r',
              'lookup <- base::match.fun\n' +
                invoke('base::system2', '"echo",args="hello",stdout=TRUE')
            )
          ).toEqual([])
        })
        it(`retains R selected process deletion lookup=${lookup} route=${invoke('target', 'args')}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'r',
                'lookup <- base::match.fun\n' + invoke('base::system2', '"rm",args="target.txt"')
              )
            ).length
          ).toBeGreaterThan(0)
        })
      }
    }
    it.each([
      'reader <- function(x) length(x);base::match.fun(reader)(1:3)',
      'reader <- function(x) length(x);base::match.fun("reader")(1:3)',
      'reader <- function(x) length(x);lapply(list(1:3),base::match.fun(reader))',
      'base::match.fun(base::match.fun(base::sum))(1:3)'
    ])('keeps R declared and nested function selection: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('r', source)).toEqual([])
    })
    it.each([
      'erase <- function(x) unlink(x);base::match.fun(erase)("target.txt")',
      'erase <- function(x) unlink(x);base::match.fun("erase")("target.txt")',
      'erase <- function(x) unlink(x);lapply("target.txt",base::match.fun(erase))',
      'base::match.fun(function(x) unlink(x))("target.txt")',
      'base::match.fun(base::match.fun(base::unlink))("target.txt")',
      'name <- "unlink";base::match.fun(name)("target.txt")',
      'base::match.fun("unknown")("target.txt")',
      'base::match.fun(quote(unlink))("target.txt")',
      'base::match.fun(FUN=base::readLines,descend=setting)("target.txt")',
      'base::match.fun(base::readLines,unknown=TRUE)("target.txt")'
    ])('retains R callback bodies and uncertain function lookup: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('r', source)).length).toBeGreaterThan(0)
    })
    it('keeps selected readers across cells and retains subsequent destructive rebinding', async () => {
      expect(
        await analyzeNotebookCodeRisk('python', 'reader(".")', undefined, [
          'import os\nreader=getattr(os,"listdir",False)'
        ])
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('r', 'reader("target.txt")', undefined, [
          'reader <- base::match.fun(base::readLines)'
        ])
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk('r', 'reader("target.txt")', undefined, [
            'reader <- base::match.fun(base::unlink)'
          ])
        ).length
      ).toBeGreaterThan(0)
    })
  })
  describe('guarded readers and visible function arguments', () => {
    for (const lookup of ['getattr', 'builtins.getattr', 'lookup']) {
      const prefix = 'import os,builtins,operator\nlookup=builtins.getattr\n'
      for (const fallback of ['None', 'os.listdir', 'len']) {
        it.each([
          `${lookup}(os,"listdir",${fallback})(".")`,
          `read=${lookup}(os,"listdir",${fallback}); read(".")`,
          `list(map(${lookup}(os,"listdir",${fallback}),["."]))`,
          `operator.call(${lookup}(os,"listdir",${fallback}),".")`,
          `${lookup}(open("target.txt"),"read",${fallback})()`,
          `${lookup}(frame,"to_numpy",${fallback})()`,
          `${lookup}(frame,"dropna",${fallback})().mean()`
        ])(
          `keeps Python guarded reader lookup=${lookup} fallback=${fallback}: %s`,
          async (call) => {
            expect(await analyzeNotebookCodeRisk('python', prefix + call)).toEqual([])
          }
        )
      }
      it.each([
        `${lookup}(os,"unlink",None)("target.txt")`,
        `erase=${lookup}(os,"unlink",os.listdir); erase("target.txt")`,
        `${lookup}(os,"listdir",os.unlink)("target.txt")`,
        `list(map(${lookup}(os,"listdir",os.unlink),["target.txt"]))`,
        `operator.call(${lookup}(os,"listdir",os.unlink),"target.txt")`,
        `${lookup}(os,"listdir",os.unlink("target.txt"))(".")`,
        `${lookup}(os,"listdir",factory())(".")`,
        `${lookup}(os,name,None)(".")`
      ])(`retains Python lookup mutation/uncertainty lookup=${lookup}: %s`, async (call) => {
        expect((await analyzeNotebookCodeRisk('python', prefix + call)).length).toBeGreaterThan(0)
      })
    }
    for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
      for (const invoke of [
        (target: string, args: string) => `${target}(${args})`,
        (target: string, args: string) => `saved=${target};saved(${args})`,
        (target: string, args: string) => `operator.call(${target},${args})`
      ]) {
        it(`keeps Python guarded subprocess ${method} reader arguments: ${invoke('target', 'args')}`, async () => {
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              'import subprocess,operator\n' +
                invoke(
                  `getattr(subprocess,"${method}",None)`,
                  '["echo","hello"]' + (method === 'run' ? ',check=True' : '')
                )
            )
          ).toEqual([])
        })
        it(`retains Python guarded subprocess ${method} deletion arguments: ${invoke('target', 'args')}`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                'import subprocess,operator\n' +
                  invoke(`getattr(subprocess,"${method}",None)`, '["rm","target.txt"]')
              )
            ).length
          ).toBeGreaterThan(0)
        })
      }
    }
    for (const call of ['do.call', 'base::do.call', 'invoke']) {
      const prefix = 'invoke <- base::do.call\n'
      it.each([
        `${call}(sum,list(1,2,na.rm=TRUE))`,
        ...[
          '1:3',
          '(1:3)',
          '-1',
          '+2',
          '1+2i',
          '2*3',
          '2^3',
          '5%%2',
          '5%/%2',
          'NA',
          'NA_real_',
          'Inf',
          'NaN'
        ].map((value) => `${call}(sum,list(${value},na.rm=TRUE))`),
        `${call}("mean",list(c(1,NA,3),na.rm=TRUE))`,
        `${call}(base::mean,list((1:3)))`,
        `${call}(base::readLines,list("target.txt",warn=FALSE))`,
        `${call}("mean",list(c(1,2,3),na.rm=TRUE))`,
        `${call}(base::rbind,list(data.frame(x=1),data.frame(x=2)))`,
        `${call}(paste,list("a","b",sep="-"))`,
        `${call}(what=base::sum,args=base::list(1,2))`,
        `${call}(args=list(1,2),what=sum)`,
        `${call}(wh=sum,arg=list(1,2),quo=FALSE)`,
        `${call}("lapply",list(c(1,2),FUN=abs))`,
        `${call}(base::system2,list("echo",args="hello",stdout=TRUE))`,
        `${call}("do.call",list(sum,list(1,2)))`,
        `${call}(base::do.call,list(what=sum,args=list(1,2)))`,
        `reader <- function(x) length(x); ${call}(reader,list(c(1,2)))`,
        `reader <- function(x) length(x); ${call}("reader",list(c(1,2)))`,
        `saved <- sum; sum <- unlink; ${call}(saved,list(1,2))`
      ])(`keeps R visible argument forwarding entry=${call}: %s`, async (source) => {
        expect(await analyzeNotebookCodeRisk('r', prefix + source)).toEqual([])
      })
      it.each([
        `${call}(unlink,list("target.txt"))`,
        `${call}("file.remove",list("target.txt"))`,
        `${call}(base::unlink,list("target.txt"))`,
        `${call}(sum,list(unlink("target.txt")))`,
        `${call}(sum,list(1:unlink("target.txt")))`,
        `${call}(sum,list(-unlink("target.txt")))`,
        `${call}(sum,list(c(1,expression(unlink("target.txt")))))`,
        `${call}(sum,list(value))`,
        `${call}("lapply",list("target.txt",FUN=unlink))`,
        `${call}(base::system2,list("rm",args="target.txt"))`,
        `${call}(sum,values)`,
        `name <- choose(); ${call}(name,list(1,2))`,
        `${call}(sum,list(1,2),envir=environment)`,
        `${call}(sum,list(1,2),quote=TRUE)`,
        `${call}(identity,list(quote(unlink("target.txt"))))`,
        `${call}(identity,list(expression(unlink("target.txt"))))`,
        `${call}(identity,list(call("unlink","target.txt")))`,
        `${call}(identity,list(as.name("target")))`,
        `${call}(identity,list(parse(text="unlink('target.txt')")))`,
        `${call}(what=sum,what=unlink,args=list("target.txt"))`,
        `list <- function(...) unlink("target.txt"); ${call}(sum,list(1,2))`,
        `sum <- unlink; ${call}("sum",list("target.txt"))`,
        `reader <- function(x) unlink(x); ${call}(reader,list("target.txt"))`,
        `${call}("do.call",list(unlink,list("target.txt")))`,
        `base::lapply(list(1),${call})`
      ])(`retains R forwarding mutation/uncertainty entry=${call}: %s`, async (source) => {
        expect((await analyzeNotebookCodeRisk('r', prefix + source)).length).toBeGreaterThan(0)
      })
    }
  })

  it.each([
    ['python', 'import os; saved=getattr(os,"listdir",None)', 'saved(".")'],
    [
      'python',
      'import os; fallback=os.listdir; saved=getattr(os,"listdir",fallback); fallback=os.unlink',
      'saved(".")'
    ],
    [
      'python',
      'import os; fallback=os.unlink; saved=getattr(os,"listdir",fallback); fallback=os.listdir',
      'saved("target.txt")'
    ],
    ['python', 'import os; saved=getattr(os,"unlink",None)', 'saved("target.txt")'],
    ['r', 'saved <- base::do.call', 'saved(mean,list(c(1,2,3)))'],
    ['r', 'saved <- base::do.call; reader <- sum; sum <- unlink', 'saved(reader,list(1,2))'],
    [
      'r',
      'saved <- base::do.call; reader <- unlink; unlink <- identity',
      'saved(reader,list("target.txt"))'
    ],
    ['r', 'expr <- quote(unlink("target.txt"))', 'do.call(identity,list(expr))'],
    ['r', 'reader <- function(x) length(x)', 'do.call(reader,list(c(1,2)))'],
    ['r', 'reader <- function(x) unlink(x)', 'do.call(reader,list("target.txt"))']
  ] as const)(
    'preserves %s guarded/forwarded function identity across cells: %s',
    async (language, definition, call) => {
      const risks = await analyzeNotebookCodeRisk(language, call, undefined, [definition])
      if (call.includes('target.txt') || call.includes('list(expr)'))
        expect(risks.length).toBeGreaterThan(0)
      else expect(risks).toEqual([])
    }
  )
  it.each([
    'expr <- quote(unlink("target.txt")); do.call(identity,list(expr))',
    'q <- base::quote; do.call(identity,list(q(unlink("target.txt"))))',
    'x <- expression(unlink("target.txt")); do.call(sum,list(c(x)))',
    'do.call(lapply,list(list("target.txt"),FUN=base::unlink))',
    'callback <- unlink; do.call(lapply,list(list("target.txt"),FUN=callback))',
    'do.call("do.call",list("identity",list(quote(unlink("target.txt")))))',
    'do.call("do.call",list("sum",list(1),envir=custom))',
    'do.call("do.call",list("identity",list(expr)))',
    'do.call(sum,list(1),quote=mode)',
    'do.call(sum,list(1),unknown=TRUE)',
    'do.call(sum,list(...))'
  ])('retains R language values and forwarding option boundaries: %s', async (source) => {
    expect((await analyzeNotebookCodeRisk('r', source)).length).toBeGreaterThan(0)
  })

  describe('archive and sync command roles', () => {
    const routes = [
      ['bash', (argv: string[]) => argv.map((value) => `'${value}'`).join(' ')],
      ['python', (argv: string[]) => `import subprocess;subprocess.run(${JSON.stringify(argv)})`],
      [
        'python',
        (argv: string[]) =>
          `import subprocess;subprocess.run(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))},shell=True)`
      ],
      [
        'repl',
        (argv: string[]) =>
          `require("node:child_process").execFileSync(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))})`
      ],
      [
        'repl',
        (argv: string[]) =>
          `require("node:child_process").execSync(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))})`
      ],
      [
        'r',
        (argv: string[]) => `system(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))})`
      ],
      [
        'r',
        (argv: string[]) =>
          `system2(${JSON.stringify(argv[0])},args=${
            argv.length > 1
              ? `c(${argv
                  .slice(1)
                  .map((value) => JSON.stringify(value))
                  .join(',')})`
              : 'character()'
          },stdout=TRUE)`
      ]
    ] as const
    for (const [route, [language, source]] of routes.entries()) {
      it.each([
        ...['bzip2', 'bunzip2', 'bzcat'].flatMap((name) =>
          ['-c', '-k', '-t', '-dc', '-dk', '--stdout', '--keep', '--test'].map((flag) => [
            name,
            'input',
            flag
          ])
        ),
        ['bzip2', 'first', '-k', 'second'],
        ['bunzip2', 'first.bz2', '-dc', 'second.bz2'],
        ['bzip2', 'input.bz2', '-dt'],
        ['bzip2', 'input', '--compress', '--keep'],
        ['bzip2', 'input', '--test', '--decompress', '--stdout'],
        ['bzip2', 'input', '-cf'],
        ['bzip2', 'input', '-c', '--', '-f'],
        ...[
          ['--size-only'],
          ['--ignore-times'],
          ['-I'],
          ['--modify-window=2'],
          ['--modify-window', '2'],
          ['--checksum-seed=7'],
          ['--checksum-seed', '7']
        ].flatMap((flags) => [
          ['rsync', '-r', ...flags, 'src/', 'dst/'],
          ['rsync', '-rn', '--delete', ...flags, 'src/', 'dst/'],
          ['rsync', '-r', ...flags, '--delete', '--dry-run', 'src/', 'dst/']
        ]),
        ['rsync', '--modify-window', '--delete', 'src/', 'dst/'],
        ['rsync', '--checksum-seed', '--delete', 'src/', 'dst/'],
        ...['tar', 'gtar', 'bsdtar'].flatMap((name) =>
          ['echo', 'echo=exec=rm', 'dot', '.', 'totals', 'sleep=0', 'wait=USR1'].flatMap(
            (action) => [
              [name, '--checkpoint=1', `--checkpoint-action=${action}`, '-tf', 'input.tar'],
              [name, '-cf', 'output.tar', '--checkpoint-action', action, 'input'],
              [name, '--checkpoint', `--checkpoint-action=${action}`, '-xOf', 'input.tar']
            ]
          )
        ),
        ['tar', '--checkpoint=.10', '-tf', 'input.tar'],
        ['tar', '--checkpoint-action=echo=--remove-files', '-cf', 'output.tar', 'input'],
        ['tar', '-cf', 'output.tar', '--', '--checkpoint-action=exec=rm'],
        ['bzip2', 'input', '-k', '--', '-f']
      ])(`keeps operand order and progress metadata route=${route}: %j`, async (...argv) => {
        const risks = await analyzeNotebookCodeRisk(language, source(argv))
        if (process.platform === 'win32' && [2, 4, 5].includes(route))
          expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
      it.each([
        ['bzip2', 'input', '--', '-c'],
        ['bzip2', 'input', '-kf'],
        ['bzip2', 'input.bz2', '-td'],
        ['bunzip2', 'input.bz2', '--test', '--decompress'],
        ['bzip2', 'input', '--keep', '--force'],
        ['bzip2', 'input', '--unknown', '-c'],
        ...['gzip', 'gunzip', 'xz', 'unxz'].flatMap((name) =>
          ['-c', '-k', '-t', '--stdout', '--keep', '--test'].map((flag) => [name, 'input', flag])
        ),
        ...[
          ['--size-only'],
          ['--ignore-times'],
          ['-I'],
          ['--modify-window=2'],
          ['--modify-window', '2'],
          ['--checksum-seed=7'],
          ['--checksum-seed', '7']
        ].flatMap((flags) => [
          ['rsync', '-r', ...flags, '--delete', 'src/', 'dst/'],
          ['rsync', '-rn', ...flags, '--rsh=custom', 'src/', 'dst/'],
          ['rsync', '-rn', ...flags, '--log-file=target', 'src/', 'dst/']
        ]),
        ['rsync', '--delete', '--modify-window', '--dry-run', 'src/', 'dst/'],
        ['rsync', '--delete', '--checksum-seed', '--dry-run', 'src/', 'dst/'],
        ['rsync', '--modify-window'],
        ['rsync', '--checksum-seed'],
        ...['exec=rm', 'unknown', 'echo;exec=rm'].map((action) => [
          'tar',
          '-tf',
          'input.tar',
          `--checkpoint-action=${action}`
        ]),
        ['tar', '--checkpoint-action'],
        ['tar', '--checkpoint-action=echo', '--checkpoint-action=exec=rm', '-tf', 'input.tar'],
        ['tar', '--checkpoint-action=echo', '-xf', 'input.tar'],
        ['tar', '--checkpoint-action=dot', '--remove-files', '-cf', 'output.tar', 'input'],
        ['tar', '--checkpoint-action=totals', '--use-compress-program=custom', '-tf', 'input.tar'],
        ['tar', '--checkpoint', '--checkpoint-action=exec=rm', '-tf', 'input.tar']
      ])(
        `retains mutation and command actions with metadata route=${route}: %j`,
        async (...argv) => {
          expect((await analyzeNotebookCodeRisk(language, source(argv))).length).toBeGreaterThan(0)
        }
      )
      it.each([
        ['gzip'],
        ['gzip', '-c', 'input'],
        ['gzip', '-dc', 'input'],
        ['gzip', '-k', 'input'],
        ['gzip', '-dk', 'input'],
        ['gzip', '-t', 'input'],
        ['gzip', '--stdout', 'input'],
        ['gzip', '--keep', 'input'],
        ['gzip', '--test', 'input'],
        ['gzip', '-ctf', 'input'],
        ['gzip', '-ckf', 'input'],
        ['gunzip'],
        ['gunzip', '-c', 'input'],
        ['gunzip', '-dc', 'input'],
        ['gunzip', '-k', 'input'],
        ['gunzip', '-dk', 'input'],
        ['gunzip', '-t', 'input'],
        ['gunzip', '--stdout', 'input'],
        ['gunzip', '--keep', 'input'],
        ['gunzip', '--test', 'input'],
        ['gunzip', '-ctf', 'input'],
        ['gunzip', '-ckf', 'input'],
        ['bzip2'],
        ['bzip2', '-c', 'input'],
        ['bzip2', '-dc', 'input'],
        ['bzip2', '-k', 'input'],
        ['bzip2', '-dk', 'input'],
        ['bzip2', '-t', 'input'],
        ['bzip2', '--stdout', 'input'],
        ['bzip2', '--keep', 'input'],
        ['bzip2', '--test', 'input'],
        ['bzip2', '-ctf', 'input'],
        ['bzip2', '-ckf', 'input'],
        ['bunzip2'],
        ['bunzip2', '-c', 'input'],
        ['bunzip2', '-dc', 'input'],
        ['bunzip2', '-k', 'input'],
        ['bunzip2', '-dk', 'input'],
        ['bunzip2', '-t', 'input'],
        ['bunzip2', '--stdout', 'input'],
        ['bunzip2', '--keep', 'input'],
        ['bunzip2', '--test', 'input'],
        ['bunzip2', '-ctf', 'input'],
        ['bunzip2', '-ckf', 'input'],
        ['xz'],
        ['xz', '-c', 'input'],
        ['xz', '-dc', 'input'],
        ['xz', '-k', 'input'],
        ['xz', '-dk', 'input'],
        ['xz', '-t', 'input'],
        ['xz', '--stdout', 'input'],
        ['xz', '--keep', 'input'],
        ['xz', '--test', 'input'],
        ['xz', '-ctf', 'input'],
        ['xz', '-ckf', 'input'],
        ['unxz'],
        ['unxz', '-c', 'input'],
        ['unxz', '-dc', 'input'],
        ['unxz', '-k', 'input'],
        ['unxz', '-dk', 'input'],
        ['unxz', '-t', 'input'],
        ['unxz', '--stdout', 'input'],
        ['unxz', '--keep', 'input'],
        ['unxz', '--test', 'input'],
        ['unxz', '-ctf', 'input'],
        ['unxz', '-ckf', 'input'],
        ['zcat', 'input'],
        ['zcat', '-f', 'input'],
        ['bzcat', 'input'],
        ['bzcat', '-f', 'input'],
        ['xzcat', 'input'],
        ['xzcat', '-f', 'input'],
        ['gzip', '-l', 'input.gz'],
        ['gzip', '-tl', 'input.gz'],
        ['gzip', '-kS', '-f', 'input'],
        ['gzip', '--keep', '--suffix=-f', 'input'],
        ['gzip', '-c', '--', '-f'],
        ['xz', '-l', 'input.xz'],
        ['xz', '-dt', 'input.xz'],
        ['xz', '-kT2', 'input'],
        ['xz', '-k', '--threads', '2', 'input'],
        ['xz', '-c', '--files=list.txt'],
        ['xz', '-c', '--files'],
        ['xz', '-t', '--files0=list.txt'],
        ['xz', '--list', '--files=list.txt'],
        ['xz', '-k', '--format=xz', '--check=crc64', 'input'],
        ['xz', '-k', '--lzma2', 'input'],
        ['xz', '-c', '--delta', 'input'],
        ['bzip2', '-sck', 'input'],
        ['rsync', '-av', 'src/', 'dst/'],
        ['rsync', '-an', '--delete', 'src/', 'dst/'],
        ['rsync', '--delete', '--dry-run', 'src/', 'dst/'],
        ['rsync', '--dry-run', '--remove-source-files', 'src/', 'dst/'],
        ['rsync', '--delete-excluded', '-rn', 'src/', 'dst/'],
        ['rsync', '-av', '--filter', '--delete', 'src/', 'dst/'],
        ['rsync', '--exclude=--delete', '-r', 'src/', 'dst/'],
        ['rsync', '--exclude', '--delete', 'src/', 'dst/'],
        ['rsync', '--suffix', '--dry-run', 'src/', 'dst/'],
        ['rsync', '--', '--delete', 'dst/'],
        ['rsync', '--delete', '--list-only', 'src/', 'dst/'],
        ['rsync', '--no-dry-run', '--dry-run', '--delete', 'src/', 'dst/'],
        ['rsync', '--dry-run', '--read-batch=batch'],
        ['tar', '-tf', 'input.tar'],
        ['tar', 'tf', 'input.tar'],
        ['tar', '-tvf', 'input.tar'],
        ['tar', '-cf', 'out.tar', 'input'],
        ['tar', 'cf', 'out.tar', 'input'],
        ['tar', '-c', '-f', 'out.tar', 'input'],
        ['tar', '--create', '--file=out.tar', 'input'],
        ['tar', '-xOf', 'input.tar'],
        ['tar', 'xOf', 'input.tar'],
        ['tar', '--extract', '--to-stdout', '-f', 'input.tar'],
        ['tar', '-tf', '--remove-files'],
        ['tar', '-cf', 'out.tar', '--exclude', '--remove-files', 'input'],
        ['tar', '-cf', 'out.tar', '--exclude=--checkpoint-action', 'input'],
        ['tar', '-c', '-f', 'out.tar', '--', '--remove-files'],
        ['tar', '-cC', '--remove-files', '-f', 'out.tar', 'input'],
        ['tar', 'cCf', '--remove-files', 'out.tar', 'input'],
        ['tar', '-df', 'input.tar'],
        ['gtar', '-tf', 'input.tar'],
        ['bsdtar', '-tf', 'input.tar']
      ])(
        `keeps archive/sync readers, source retention and preview route=${route}: %j`,
        async (...argv) => {
          const risks = await analyzeNotebookCodeRisk(language, source(argv))
          if (process.platform === 'win32' && [2, 4, 5].includes(route))
            expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        }
      )
      it.each([
        ['gzip', 'input'],
        ['gzip', '-d', 'input'],
        ['gzip', '-f', 'input'],
        ['gzip', '-kf', 'input'],
        ['gzip', '--force', '--keep', 'input'],
        ['gzip', '--decompress', 'input'],
        ['gzip', '-r', 'input'],
        ['gzip', '--', '-c'],
        ['gzip', '-S', '-c', 'input'],
        ['gzip', '-k', 'input', '-f'],
        ['gzip', 'input', '-c'],
        ['gzip', '-k', '--unknown', 'input'],
        ['gzip', '--suffix=-c', 'input'],
        ['gunzip', 'input'],
        ['gunzip', '-d', 'input'],
        ['gunzip', '-f', 'input'],
        ['gunzip', '-kf', 'input'],
        ['gunzip', '--force', '--keep', 'input'],
        ['gunzip', '--decompress', 'input'],
        ['gunzip', '-r', 'input'],
        ['gunzip', '--', '-c'],
        ['gunzip', '-S', '-c', 'input'],
        ['gunzip', '-k', 'input', '-f'],
        ['gunzip', 'input', '-c'],
        ['gunzip', '-k', '--unknown', 'input'],
        ['gunzip', '--suffix=-c', 'input'],
        ['bzip2', 'input'],
        ['bzip2', '-d', 'input'],
        ['bzip2', '-f', 'input'],
        ['bzip2', '-kf', 'input'],
        ['bzip2', '--force', '--keep', 'input'],
        ['bzip2', '--decompress', 'input'],
        ['bzip2', '-r', 'input'],
        ['bzip2', '--', '-c'],
        ['bzip2', '-S', '-c', 'input'],
        ['bzip2', '-k', 'input', '-f'],
        ['bzip2', '-k', '--unknown', 'input'],
        ['bzip2', '--suffix=-c', 'input'],
        ['bunzip2', 'input'],
        ['bunzip2', '-d', 'input'],
        ['bunzip2', '-f', 'input'],
        ['bunzip2', '-kf', 'input'],
        ['bunzip2', '--force', '--keep', 'input'],
        ['bunzip2', '--decompress', 'input'],
        ['bunzip2', '-r', 'input'],
        ['bunzip2', '--', '-c'],
        ['bunzip2', '-S', '-c', 'input'],
        ['bunzip2', '-k', 'input', '-f'],
        ['bunzip2', '-k', '--unknown', 'input'],
        ['bunzip2', '--suffix=-c', 'input'],
        ['xz', 'input'],
        ['xz', '-d', 'input'],
        ['xz', '-f', 'input'],
        ['xz', '-kf', 'input'],
        ['xz', '--force', '--keep', 'input'],
        ['xz', '--decompress', 'input'],
        ['xz', '-r', 'input'],
        ['xz', '--', '-c'],
        ['xz', '-S', '-c', 'input'],
        ['xz', '-k', 'input', '-f'],
        ['xz', 'input', '-c'],
        ['xz', '-k', '--unknown', 'input'],
        ['xz', '--suffix=-c', 'input'],
        ['unxz', 'input'],
        ['unxz', '-d', 'input'],
        ['unxz', '-f', 'input'],
        ['unxz', '-kf', 'input'],
        ['unxz', '--force', '--keep', 'input'],
        ['unxz', '--decompress', 'input'],
        ['unxz', '-r', 'input'],
        ['unxz', '--', '-c'],
        ['unxz', '-S', '-c', 'input'],
        ['unxz', '-k', 'input', '-f'],
        ['unxz', 'input', '-c'],
        ['unxz', '-k', '--unknown', 'input'],
        ['unxz', '--suffix=-c', 'input'],
        ['xz', '-td', 'input.xz'],
        ['xz', '-tz', 'input'],
        ['xz', '--list', '--decompress', 'input.xz'],
        ['xz', '--files=list.txt'],
        ['xz', '--lzma2', 'input'],
        ['xz', '--delta', 'input'],
        ['xz', '--x86', 'input'],
        ['xz', '--files'],
        ['xz', '-k', '-f', '--files0=list.txt'],
        ['bzip2', '-td', 'input.bz2'],
        ['gzip', '-k', '--suffix', '-f', '--force', 'input'],
        ['gzip', '-S', '--keep', 'input'],
        ['xz', '-S', '-c', 'input'],
        ['rsync', '-r', '--delete', 'src/', 'dst/'],
        ['rsync', '--del', 'src/', 'dst/'],
        ['rsync', '--delete-after', 'src/', 'dst/'],
        ['rsync', '--delete-during', 'src/', 'dst/'],
        ['rsync', '--delete-delay', 'src/', 'dst/'],
        ['rsync', '--delete-before', 'src/', 'dst/'],
        ['rsync', '--delete-excluded', 'src/', 'dst/'],
        ['rsync', '--delete-missing-args', 'src/', 'dst/'],
        ['rsync', '--remove-source-files', 'src/', 'dst/'],
        ['rsync', '--remove-sent-files', 'src/', 'dst/'],
        ['rsync', '--inplace', 'src/', 'dst/'],
        ['rsync', '--append', 'src/', 'dst/'],
        ['rsync', '--append-verify', 'src/', 'dst/'],
        ['rsync', '--force', 'src/', 'dst/'],
        ['rsync', '--delete', '--dry-run', '--no-dry-run', 'src/', 'dst/'],
        ['rsync', '-rn', '--no-n', '--delete', 'src/', 'dst/'],
        ['rsync', '--delete', '--list-only', '--no-list-only', 'src/', 'dst/'],
        ['rsync', '--delete', '--exclude', '--dry-run', 'src/', 'dst/'],
        ['rsync', '--delete', '--', '--dry-run', 'dst/'],
        ['rsync', '--dry-run', '-e', 'custom-shell', 'src/', 'dst/'],
        ['rsync', '--dry-run', '--rsync-path=custom', 'src/', 'dst/'],
        ['rsync', '--dry-run', '--log-file=log', 'src/', 'dst/'],
        ['rsync', '--dry-run', '--write-batch=batch', 'src/', 'dst/'],
        ['rsync', '--dry-run', '--only-write-batch=batch', 'src/', 'dst/'],
        ['rsync', '--dry-run', '-M--delete', 'src/', 'dst/'],
        ['rsync', '--dry-run', '--unknown', 'src/', 'dst/'],
        ['rsync', '--read-batch=batch'],
        ['tar', '--remove-files', '-cf', 'out.tar', 'input'],
        ['tar', '-cf', 'out.tar', 'input', '--remove-files'],
        ['tar', '-rf', 'out.tar', 'input'],
        ['tar', 'rf', 'out.tar', 'input'],
        ['tar', '-uf', 'out.tar', 'input'],
        ['tar', '--delete', '-f', 'out.tar', 'input'],
        ['tar', '--concatenate', '-f', 'out.tar', 'input'],
        ['tar', '-xf', 'input.tar'],
        ['tar', 'xf', 'input.tar'],
        ['tar', '--extract', '--file=input.tar'],
        ['tar', '--recursive-unlink', '-xf', 'input.tar'],
        ['tar', '--unlink-first', '-xf', 'input.tar'],
        ['tar', '--checkpoint-action=exec=custom', '-tf', 'input.tar'],
        ['tar', '-Icustom', '-tf', 'input.tar'],
        ['tar', '-I', 'custom', '-tf', 'input.tar'],
        ['tar', '-F', 'custom', '-tf', 'input.tar'],
        ['tar', '--to-command=custom', '-xOf', 'input.tar'],
        ['tar', '--use-compress-program=custom', '-tf', 'input.tar'],
        ['tar', '--listed-incremental=state', '-cf', 'out.tar', 'input'],
        ['tar', '-gstate', '-cf', 'out.tar', 'input'],
        ['tar', '-txf', 'input.tar'],
        ['tar', '--unknown', '-tf', 'input.tar'],
        ['gtar', '--remove-files', '-cf', 'out.tar', 'input']
      ])(
        `reviews archive/sync deletion, overwrite or execution route=${route}: %j`,
        async (...argv) => {
          expect((await analyzeNotebookCodeRisk(language, source(argv))).length).toBeGreaterThan(0)
        }
      )
    }
    it.each([
      'gzip -c input | wc -c',
      'env POSIXLY_CORRECT=1 bzip2 input -c',
      'POSIXLY_CORRECT=1 bzip2 input -k',
      'command bzip2 input.bz2 -t',
      'env TAR_OPTIONS=--checkpoint-action=echo tar -tf input.tar',
      'TAR_OPTIONS=--checkpoint-action=totals tar -cf out input',
      'tar --checkpoint-action="echo=$(printf progress)" -tf input.tar',
      'tar --checkpoint-action="echo=$progress" -tf input.tar',
      'tar "--checkpoint-action=echo=$progress" -tf input.tar',
      'tar --checkpoint-action "echo=$progress" -cf output.tar input',
      'gtar --checkpoint-action="echo=$progress" -tf input.tar',
      'bsdtar --checkpoint-action="echo=$progress" -tf input.tar',
      'env XZ_OPT=-T2 xz -k input',
      'env GZIP=-9 gzip -k input',
      'env TAR_OPTIONS=--verbose tar -tf input.tar',
      'env TAR_OPTIONS=--exclude=--remove-files tar -cf out input',
      'XZ_OPT=-T2 xz -k input',
      'export XZ_OPT=-T2; xz -k input',
      'GZIP=-9 gzip -k input',
      'export TAR_OPTIONS=--verbose; tar -tf input.tar',
      'XZ_OPT= xz -k input',
      'gzip -c $options input',
      'gzip -c "$filename"',
      'gzip -k -- "$filename"',
      'xz -k -- "$filename"',
      'gzip -k input',
      'command gzip -dc input.gz',
      'env -i xz -k input',
      'nice -n 5 bzip2 -dc input.bz2',
      'find . -exec gzip -dc {} \\;'
    ])('keeps archive/sync fixed reader wrappers: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
    })
    it.each([
      'gzip -k $options input',
      'env POSIXLY_CORRECT=1 gzip input -c',
      'env POSIXLY_CORRECT=1 xz input -k',
      'bzip2 input $flags -c',
      'bzip2 input -- "$flag"',
      'bzip2 input -c > target',
      'bzip2 "$(rm target)" -k',
      'tar --checkpoint-action="$action" -tf input.tar',
      'tar --checkpoint-action=echo=$action -tf input.tar',
      'tar --checkpoint-action="echo=$@" -tf input.tar',
      'tar --checkpoint-action="echo=${actions[@]}" -tf input.tar',
      'tar --checkpoint-action="${prefix}echo=$progress" -tf input.tar',
      'tar --checkpoint-action="exec=$command" -tf input.tar',
      'tar --checkpoint-action="echo=$progress" --checkpoint-action=exec=rm -tf input.tar',
      'tar --checkpoint-action="echo=$progress" -xf input.tar',
      'tar --checkpoint-action="echo=$progress" --remove-files -cf output.tar input',
      'tar --checkpoint-action="echo=$(rm target)" -tf input.tar',
      'rsync --modify-window="$window" --delete src/ dst/',
      'rsync --checksum-seed="$(rm target)" -rn --delete src/ dst/',
      'TAR_OPTIONS=--checkpoint-action=exec=rm tar -tf input.tar',
      'gzip -k input*',
      'rsync -n --delete $paths',
      'tar -tf $archive',
      'tar -tf input.tar > target',
      'gzip -c input > target',
      'gzip -k "$(rm target)"',
      'rsync -n --delete "$(rm target)" dst/',
      'tar -tf "$(rm target)"',
      'find . -exec gzip {} \\;',
      'env XZ_OPT=-f xz -k input',
      'env TAR_OPTIONS=--remove-files tar -cf out input',
      'XZ_OPT=-f xz -k input',
      'TAR_OPTIONS=--remove-files tar -cf out input',
      'export XZ_OPT=-f; xz -k input',
      'export TAR_OPTIONS=--remove-files; tar -cf out input',
      'RSYNC_RSH=custom rsync -n src/ remote:dst/'
    ])('retains archive/sync expansion, writes and default overrides: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('bash', source)).length).toBeGreaterThan(0)
    })
  })

  describe('DD input-only command risk', () => {
    const routes = [
      ['bash', (argv: string[]) => argv.map((value) => `'${value}'`).join(' ')],
      ['python', (argv: string[]) => `import subprocess;subprocess.run(${JSON.stringify(argv)})`],
      [
        'python',
        (argv: string[]) =>
          `import subprocess;subprocess.run(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))},shell=True)`
      ],
      [
        'repl',
        (argv: string[]) =>
          `require("node:child_process").execFileSync(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))})`
      ],
      [
        'repl',
        (argv: string[]) =>
          `require("node:child_process").execSync(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))})`
      ],
      [
        'r',
        (argv: string[]) => `system(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))})`
      ],
      [
        'r',
        (argv: string[]) =>
          `system2(${JSON.stringify(argv[0])},args=${
            argv.length > 1
              ? `c(${argv
                  .slice(1)
                  .map((value) => JSON.stringify(value))
                  .join(',')})`
              : 'character()'
          },stdout=TRUE)`
      ]
    ] as const
    for (const [route, [language, source]] of routes.entries()) {
      it.each([
        [],
        ['if=input.txt'],
        ['if=rm'],
        ['if=input.txt', 'bs=1', 'count=4'],
        ['if=input.txt', 'ibs=1', 'obs=2', 'skip=1', 'count=1'],
        ['if=input.txt', 'iseek=1'],
        ['if=input.txt', 'conv=ucase'],
        ['if=input.txt', 'conv=noerror,sync'],
        ['if=input.txt', 'conv=swab'],
        ['if=input.txt', 'conv=notrunc'],
        ['if=input.txt', 'conv=block', 'cbs=4'],
        ['if=input.txt', 'conv=unblock', 'cbs=4'],
        ['if=input.txt', 'of=/dev/null'],
        ['of=/dev/null', 'if=input.txt', 'count=0'],
        ['if=input.txt', 'status=none'],
        ['if=input.txt', 'status=noxfer'],
        ['if=input.txt', 'status=progress'],
        ['if=input.txt', 'iflag=fullblock'],
        ['if=input.txt', 'iflag=count_bytes,skip_bytes'],
        ['if=input.txt', 'iflag=direct,nocache'],
        ['if=input.txt', 'iflag=noatime,nofollow'],
        ['if=input.txt', 'bs=1M', 'count=1'],
        ['if=input.txt', 'bs=2x512', 'count=0']
      ])(`keeps input-only dd route=${route} args=%j`, async (...args) => {
        const risks = await analyzeNotebookCodeRisk(language, source(['dd', ...args]))
        if (process.platform === 'win32' && [2, 4, 5].includes(route))
          expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
      it.each([
        ['of=target.txt'],
        ['if=input.txt', 'of=target.txt', 'count=0'],
        ['if=input.txt', 'of=target.txt', 'conv=notrunc'],
        ['of=/dev/disk99'],
        ['of=target.txt', 'of=/dev/null'],
        ['of=/dev/null', 'of=target.txt'],
        ['if=input.txt', 'seek=1'],
        ['if=input.txt', 'oseek=1'],
        ['if=input.txt', 'oflag=append'],
        ['of=/dev/null', 'oflag=append'],
        ['if=input.txt', 'iflag=unknown'],
        ['if=input.txt', 'conv=unknown'],
        ['if=input.txt', 'status=unknown'],
        ['if=input.txt', 'unknown=1'],
        ['if=input.txt', 'of'],
        ['if=input.txt', '--unknown'],
        ['if=input.txt', 'conv=excl'],
        ['if=input.txt', 'conv=nocreat'],
        ['if=input.txt', 'conv=sparse'],
        ['if=input.txt', 'iflag=truncate']
      ])(`reviews writes or unresolved dd route=${route} args=%j`, async (...args) => {
        expect(
          (await analyzeNotebookCodeRisk(language, source(['dd', ...args]))).length
        ).toBeGreaterThan(0)
      })
    }
    it.each([
      'dd if="input with spaces.txt" bs=1 count=4',
      'dd if="of=target.txt" count=1',
      'printf test | dd bs=1 count=4',
      'dd if=input.txt bs=1 count=4 | wc -c',
      'env -i dd if=input.txt count=1',
      'command dd if=input.txt count=1',
      'nice -n 5 dd if=input.txt count=1',
      'find . -exec dd if=input.txt count=1 \\;',
      'gdd if=input.txt count=1',
      'dd if="$path" count="$count"',
      'dd "if=$path"',
      'dd if=prefix"$path"',
      'dd \'if=\'"$path"',
      'dd if="$(printf input.txt)" count=0',
      'dd if="$*" count=0'
    ])('keeps fixed data and reader wrappers: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('bash', code)).toEqual([])
    })
    it.each([
      'dd $operands',
      'dd if=$path',
      'dd if=input*',
      'dd of="$output"',
      'dd if=input.txt count=0 > target.txt',
      'dd if=input.txt 2> target.txt',
      'dd if="$(rm target)" count=0',
      'printf "$(rm target)" | dd count=1',
      'find . -exec dd of={} count=0 \\;',
      'xargs dd if=input.txt count=0',
      'gdd of=target.txt count=0',
      'dd "${key}=$path"',
      'dd "if=$@"',
      'dd if="$@"',
      'dd if="${paths[@]}"',
      'dd if="${paths[@]:1}"',
      'dd count="$@"',
      'dd if="$path" count=0 > target.txt',
      'dd if="$path" of="$output" count=0'
    ])('retains expansion, independent writes and nested output uncertainty: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('bash', code)).length).toBeGreaterThan(0)
    })
  })
  describe('Xargs reader command risk', () => {
    const routes = [
      ['bash', (argv: string[]) => argv.map((value) => `'${value}'`).join(' ')],
      ['python', (argv: string[]) => `import subprocess;subprocess.run(${JSON.stringify(argv)})`],
      [
        'python',
        (argv: string[]) =>
          `import subprocess;subprocess.run(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))},shell=True)`
      ],
      [
        'repl',
        (argv: string[]) =>
          `require("node:child_process").execFileSync(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))})`
      ],
      [
        'repl',
        (argv: string[]) =>
          `require("node:child_process").execSync(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))})`
      ],
      [
        'r',
        (argv: string[]) => `system(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))})`
      ]
    ] as const
    for (const [route, [language, source]] of routes.entries()) {
      it.each([
        [],
        ['-0'],
        ['-0rtx'],
        ['-n', '1'],
        ['-n1'],
        ['-0n1'],
        ['-L', '1'],
        ['-P2'],
        ['-s', '4096'],
        ['-E', 'rm'],
        ['-I', '{}'],
        ['-I{}'],
        ['-J', '%'],
        ['-I{}', '-R', '-1', '-S512'],
        ['-a', 'rm'],
        ['-d', ':'],
        ['--null'],
        ['--max-args=1'],
        ['--max-procs', '2'],
        ['--max-chars=4096'],
        ['--arg-file', 'rm'],
        ['--delimiter=:'],
        ['--replace={}'],
        ['--replace'],
        ['--eof'],
        ['--max-lines'],
        ['--max-lines=1'],
        ['--no-run-if-empty', '--verbose', '--exit'],
        ['--']
      ])(`keeps fixed reader route=${route} options=%j`, async (...options) => {
        const risks = await analyzeNotebookCodeRisk(
          language,
          source(['xargs', ...options, 'cat', '--', '{}'])
        )
        if (process.platform === 'win32' && [2, 4, 5].includes(route))
          expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
      it.each([
        [],
        ['-0'],
        ['echo', 'rm', '-delete'],
        ['/bin/echo', 'hello'],
        ['printf', '%s'],
        ['cat', '--'],
        ['head', '-n', '1'],
        ['tail', '-n', '1'],
        ['wc', '-c'],
        ['ls', '-l'],
        ['stat'],
        ['cksum'],
        ['du', '-s'],
        ['grep', '-e', 'rm']
      ])(`keeps output or reader route=${route} child=%j`, async (...child) => {
        const risks = await analyzeNotebookCodeRisk(language, source(['xargs', ...child]))
        if (process.platform === 'win32' && [2, 4, 5].includes(route))
          expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
      it.each([
        ['rm'],
        ['rm', '--help'],
        ['rmdir'],
        ['tee'],
        ['sort', '-o', 'target'],
        ['sed', '-n', '1p'],
        ['awk', '{print}'],
        ['git', 'clean', '--dry-run'],
        ['python3', '--help'],
        ['bash', '-c', '{}'],
        ['node', '-e', '{}'],
        ['Rscript', '{}'],
        ['env', 'cat'],
        ['nice', 'cat'],
        ['xargs', 'cat'],
        ['script.py'],
        ['cat.cmd'],
        ['unknown-tool'],
        ['-i', 'cat'],
        ['-l', 'cat'],
        ['-e', 'cat'],
        ['--unknown', 'cat'],
        ['--process-slot-var=X', 'cat'],
        ['-n'],
        ['-I'],
        ['-s'],
        ['-nfoo', 'cat'],
        ['--max-args', 'cat'],
        ['--null=rm', 'cat'],
        ['-0n1z', 'cat'],
        ['--', 'rm'],
        ['-', 'cat']
      ])(`reviews effects or unresolved input route=${route} argv=%j`, async (...child) => {
        expect(
          (await analyzeNotebookCodeRisk(language, source(['xargs', ...child]))).length
        ).toBeGreaterThan(0)
      })
    }
    it.each([
      'printf "hello\\n" | xargs echo',
      'printf "rm -delete\\n" | xargs',
      'find . -name "*.txt" -print0 | xargs -0 cat --',
      'xargs cat "$file"',
      'xargs cat $files',
      'xargs cat *.txt',
      'xargs -I a cat a',
      'xargs -I{} echo "{}; rm target"',
      'xargs -E "$marker" cat',
      'xargs -I "$replace" cat',
      'xargs -n "$count" cat',
      'command xargs -0 cat --',
      'env -i xargs -0 cat --',
      'nice -n 5 xargs wc -c',
      'find . -exec xargs cat \\;',
      'gxargs -0 cat --'
    ])('keeps reader pipeline/data: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('bash', code)).toEqual([])
    })
    it.each([
      'xargs $command',
      'xargs c*t',
      'xargs $options cat',
      'xargs -n $count cat',
      'xargs -I $replace cat',
      'xargs --max-args=$count cat',
      'xargs -a $paths cat',
      'xargs cat "$(rm target)"',
      'printf "$(rm target)" | xargs echo',
      'xargs cat > existing.txt',
      'find . -delete -print0 | xargs -0 echo',
      'xargs -0 rm --',
      'xargs -I{} sh -c "rm {}"',
      'gxargs rm'
    ])('retains independent effects or unresolved execution: %s', async (code) => {
      expect((await analyzeNotebookCodeRisk('bash', code)).length).toBeGreaterThan(0)
    })
  })
  describe('Find child command risk', () => {
    const routes = [
      ['bash', (argv: string[]) => argv.map((value) => `'${value}'`).join(' ')],
      [
        'python',
        (argv: string[]) => `import subprocess;subprocess.run(${JSON.stringify(argv)},check=True)`
      ],
      [
        'python',
        (argv: string[]) =>
          `import subprocess;subprocess.run(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))},shell=True,check=True)`
      ],
      [
        'repl',
        (argv: string[]) =>
          `require("node:child_process").execFileSync(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))})`
      ],
      [
        'repl',
        (argv: string[]) =>
          `require("node:child_process").execSync(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))})`
      ],
      [
        'r',
        (argv: string[]) => `system(${JSON.stringify(argv.map((value) => `'${value}'`).join(' '))})`
      ]
    ] as const
    for (const [route, [language, source]] of routes.entries()) {
      for (const action of ['-exec', '-execdir', '-ok', '-okdir']) {
        for (const terminator of action.startsWith('-exec') ? [';', '+'] : [';']) {
          it.each([
            ['cat', '{}'],
            ['wc', '-c', '{}'],
            ['echo', '{}'],
            ['/bin/echo', '{}'],
            ['stat', '{}'],
            ['cksum', '{}'],
            ['grep', 'test', '{}'],
            ['head', '-n', '1', '{}'],
            ['git', 'status', '--short', '{}'],
            ['python3', '--version', '{}']
          ])(`keeps reader route=${route} ${action} ${terminator}: %s`, async (...child) => {
            const risks = await analyzeNotebookCodeRisk(
              language,
              source(['find', '.', '-type', 'f', action, ...child, terminator])
            )
            if (process.platform === 'win32' && [2, 4, 5].includes(route))
              expect(risks.length).toBeGreaterThan(0)
            else expect(risks).toEqual([])
          })
          it.each([
            ['sed', '-n', '1p', '{}'],
            ['awk', '{print}', '{}'],
            ['env', '-i', 'sed', '-n', '1p', '{}'],
            ['nice', '-n', '5', 'awk', '{print}', '{}'],
            ['command', 'perl', '-e', 'print 1', '{}'],
            ['rm', '{}'],
            ['rmdir', '{}'],
            ['truncate', '-s', '0', '{}'],
            ['sed', '-i', '1d', '{}'],
            ['tee', '{}'],
            ['bash', '-c', 'echo hello', '{}'],
            ['script.py', '{}'],
            ['{}'],
            ['./{}'],
            ['python3', '-c', 'print(1)', '{}'],
            ['git', 'clean', '-f', '{}']
          ])(`reviews effects route=${route} ${action} ${terminator}: %s`, async (...child) => {
            expect(
              (
                await analyzeNotebookCodeRisk(
                  language,
                  source(['find', '.', '-type', 'f', action, ...child, terminator])
                )
              ).length
            ).toBeGreaterThan(0)
          })
        }
      }
      it.each([
        ['find', '.', '-exec', 'echo', '-delete', '{}', ';'],
        ['find', '.', '-exec', 'echo', '+', '{}', ';'],
        ['find', '.', '-exec', 'echo', '-exec', 'rm', '{}', ';'],
        ['find', '.', '-name', '-delete', '-exec', 'cat', '{}', ';'],
        ['find', '.', '-exec', 'cat', '{}', ';', '-exec', 'wc', '-c', '{}', '+'],
        ['find', '.', '-exec', 'echo', 'prefix{}suffix', ';']
      ])(`keeps data and multiple readers route=${route}: %s`, async (...argv) => {
        const risks = await analyzeNotebookCodeRisk(language, source(argv))
        if (process.platform === 'win32' && [2, 4, 5].includes(route))
          expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
      it.each([
        ['find', '.', '-exec', 'cat', '{}', ';', '-delete'],
        ['find', '.', '-exec', 'cat', '{}', '+', '-exec', 'rm', '{}', ';'],
        ['find', '.', '-exec', 'cat', '{}', ';', '-fprint', 'output.txt'],
        ['find', '.', '-exec', 'echo', '+', 'rm', '{}', '+', '-delete'],
        ['find', '.', '-exec', 'cat', '{}'],
        ['find', '.', '-exec', ';'],
        ['find', '.', '-exec', 'cat', '+']
      ])(`retains trailing/unterminated actions route=${route}: %s`, async (...argv) => {
        expect((await analyzeNotebookCodeRisk(language, source(argv))).length).toBeGreaterThan(0)
      })
    }
    it.each([
      'find . -type f -exec cat {} \\;',
      'find . -exec echo -delete {} \\;',
      'find . -name "$pattern" -exec wc -c {} \\;',
      'find . -exec echo + {} \\;',
      'find . -exec cat {} ";" -print'
    ])('handles fixed Bash terminators and consumed pattern data: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
    })
    it.each([
      'find . -exec cat {} \\; -delete',
      'find . -exec "$command" {} \\;',
      'find . -exec e* {} \\;',
      'find . $predicates -exec cat {} \\;',
      'find . -name $pattern -exec cat {} \\;',
      'find . -name * -exec cat {} \\;',
      'find . -exec cat {} \\; $predicates',
      'find . -exec cat {} \\; -name "$(rm target.txt)"',
      'find . -exec python3 {} --version \\;',
      'find . -exec git clean {} --dry-run \\;',
      'find . -exec cat {} \\; -exec rm {} \\;'
    ])('retains dynamic/executed Bash boundaries: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('bash', source)).length).toBeGreaterThan(0)
    })
    it.each([
      'find . -name "${pattern}" -exec cat {} \\;',
      'find . -name "prefix${pattern}suffix" -exec echo {} \\;',
      'find . -exec command echo {} \\;',
      'find . -exec env -i /bin/echo {} \\;',
      'find . -exec nice -n 5 cat {} \\;',
      'find . -exec cat {} \\; -name "-exec" -print'
    ])('keeps fixed wrappers and quoted scalar patterns ordinary: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
    })
    it.each([
      'find . -name ${pattern} -exec cat {} \\;',
      'find . -name prefix${pattern}suffix -exec cat {} \\;',
      'find . -exec env LD_PRELOAD=library cat {} \\;',
      'find . -exec command rm {} \\;',
      'find . -exec nice -n 5 rm {} \\;',
      'find . -exec find {} -delete \\;',
      'find . -exec cat {} \\; -exec $cmd {} \\;'
    ])('retains child wrapper and unquoted splitting boundaries: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('bash', source)).length).toBeGreaterThan(0)
    })
    it('keeps direct argv escaped semicolons literal rather than decoding Bash syntax', async () => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'import subprocess;subprocess.run(["find",".","-exec","cat","{}","\\\\;"])'
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each(['cat', 'wc', 'echo'])(
      'keeps quoted R Find terminators and reviews unquoted placeholders for %s',
      async (child) => {
        expect(
          await analyzeNotebookCodeRisk(
            'r',
            `system2("find",c(".","-type","f","-exec",${JSON.stringify(child)},"{}","+"))`
          )
        ).not.toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'r',
              `system2("find",c(".","-exec",${JSON.stringify(child)},shQuote("{}"),shQuote(";")))`
            )
          ).length > 0
        ).toBe(process.platform === 'win32')
      }
    )
  })
  describe('Python explicit callable forwarding', () => {
    const packs = [
      (args: string) => args,
      (args: string) => `*(${args},)`,
      (args: string) => `*[${args}]`,
      (args: string) => `*(*[${args}],)`
    ]
    for (const method of ['call', '__call__']) {
      for (const aliased of [false, true]) {
        const imported = aliased
          ? `import operator; from operator import ${method} as invoke`
          : 'import operator'
        const invoke = aliased ? 'invoke' : `operator.${method}`
        for (const [form, pack] of packs.entries()) {
          it.each([
            `${invoke}(${pack('len,[1,2]')})`,
            `${invoke}(${pack('open,"target.txt"')}).read()`,
            `${invoke}(${pack('getattr,open("target.txt"),"read"')})()`,
            `read=${invoke}(${pack('getattr,open("target.txt"),"read"')});read()`,
            `read=${invoke}(${pack('operator.methodcaller,"read"')});read(open("target.txt"))`,
            `${invoke}(${pack('operator.itemgetter,0')})(["test"])`,
            `${invoke}(${pack('operator.attrgetter,"name"')})(record)`,
            `import subprocess; ${invoke}(${pack('subprocess.run,["echo","hello"]')},**{"check":True})`,
            `import subprocess; ${invoke}(${pack(invoke + ',subprocess.run,["echo","hello"]')},check=True)`,
            `${invoke}(${pack('sorted,["bb","a"]')},**{"key":len})`
          ])(`keeps ${method} alias=${aliased} form=${form} ordinary: %s`, async (source) => {
            expect(
              await analyzeNotebookCodeRisk(
                'python',
                `${imported}
${source}`
              )
            ).toEqual([])
          })
          it.each([
            `import os; ${invoke}(${pack('os.unlink,"target.txt"')})`,
            `import os; erase=${invoke}(${pack('getattr,os,"unlink"')});erase("target.txt")`,
            `from pathlib import Path; erase=${invoke}(${pack('operator.methodcaller,"unlink"')});erase(Path("target.txt"))`,
            `import os; ${invoke}(${pack(invoke + ',os.unlink,"target.txt"')})`,
            `import os; ${invoke}(${pack('list,map(os.unlink,["target.txt"])')})`,
            `import os; ${invoke}(${pack('sorted,["target.txt"]')},**{"key":os.unlink})`,
            `import os; ${invoke}(${pack('len,[os.unlink("target.txt")]')})`,
            `import subprocess; ${invoke}(${pack('subprocess.run,["rm","target.txt"]')},check=True)`
          ])(`reviews ${method} alias=${aliased} form=${form} effects: %s`, async (source) => {
            expect(
              (
                await analyzeNotebookCodeRisk(
                  'python',
                  `${imported}
${source}`
                )
              ).length
            ).toBeGreaterThan(0)
          })
        }
      }
    }
    it.each([
      'operator.call(*arguments)',
      'callback=factory();operator.call(callback,"target.txt")',
      'operator.call(operator.call,*arguments)',
      'operator.call(subprocess.run,["echo","hello"],**options)',
      'operator.call(operator.methodcaller,"sort",**{"key":callback})(values)',
      'list(map(operator.call,callbacks))',
      'list(map(operator.__call__,callbacks))',
      'operator.call(factory)()',
      'operator.call(getattr,os,property_name)("target.txt")'
    ])('reviews unresolved forwarded execution: %s', async (source) => {
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import operator,os,subprocess
${source}`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      'import operator,subprocess;operator.call(subprocess.run,"echo hello",**{"shell":True,"check":True})',
      'import operator;operator.call(operator.call,operator.itemgetter,0)(["test"])',
      'import operator;reader=operator.call(getattr,open("target.txt"),"read");print(reader())',
      'import operator as op;op.__call__(getattr,open("target.txt"),"read")()',
      'import operator;operator.call(print,lambda:None)',
      'import operator;operator.call(open,3,opener=callback)'
    ])('checks forwarded ordinary special signatures: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
    })
    it.each([
      'import operator,os;operator.call(getattr,os,"listdir",os.unlink("target.txt"))(".")',
      'import operator,os;operator.call(open,"target.txt",opener=os.unlink)',
      'import operator,os;operator.call(operator.call,sorted,["target.txt"],key=os.unlink)',
      'import operator,subprocess;operator.call(subprocess.run,"rm target.txt",shell=True)',
      'import operator,subprocess;operator.call(subprocess.run,["echo","hello"],executable=program)',
      'import operator;operator.call(operator.call,*unknown,len)',
      'import operator as op;list(map(op.call,[len]))',
      'import operator as op,os;op.__call__(os.unlink,"target.txt")',
      'import operator,os\ninvoke=operator.call\nif condition:\n    callback=os.unlink\nelse:\n    callback=print\ninvoke(callback,"target.txt")'
    ])('retains forwarded eager/callback/process uncertainty: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
    })
    it('bounds deeply nested explicit forwarding without discharging uncertainty', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          `import operator\noperator.call(${Array(63).fill('operator.call').join(',')},len,[1])`
        )
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            `import operator\noperator.call(${Array(64).fill('operator.call').join(',')},len,[1])`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it('preserves saved callable and returned getter identities across history rebinding', async () => {
      const previous =
        'import operator,os\ninvoke=operator.call\nread=invoke(getattr,os,"listdir")\nerase=invoke(getattr,os,"unlink")'
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'operator.call=lambda *a:None\nread(".")',
          undefined,
          [previous]
        )
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'os.unlink=lambda p:None\nerase("target.txt")',
            undefined,
            [previous]
          )
        ).some((risk) => risk.operation.includes('unlink'))
      ).toBe(true)
      expect(
        (
          await analyzeNotebookCodeRisk('python', 'invoke(os.unlink,"target.txt")', undefined, [
            previous
          ])
        ).some((risk) => risk.operation.includes('unlink'))
      ).toBe(true)
    })
    it('reviews named and inline forwarded bodies without mistaking ordinary data for callbacks', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'import operator\ndef read():\n    return open("target.txt").read()\noperator.call(read)'
        )
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'import operator,os\ndef erase():\n    os.unlink("target.txt")\noperator.call(erase)'
          )
        ).some((risk) => risk.operation.includes('unlink'))
      ).toBe(true)
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'import operator,os\noperator.call(lambda:os.unlink("target.txt"))'
          )
        ).length
      ).toBeGreaterThan(0)
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'import operator,os\noperator.call(print,os.unlink)'
        )
      ).toEqual([])
    })
  })
  describe('Python packed accessor provenance', () => {
    const packs = [
      (args: string) => `*(${args},)`,
      (args: string) => `*[${args}]`,
      (args: string) => `*((${args},))`,
      (args: string) => `*(*[${args}],)`
    ]
    const names = [
      (name: string) => JSON.stringify(name),
      (name: string) => `(${JSON.stringify(name)})`,
      (name: string) => `f${JSON.stringify(name)}`
    ]
    for (const [packIndex, pack] of packs.entries()) {
      for (const [nameIndex, name] of names.entries()) {
        it.each([
          `import os; getattr(${pack('os,' + name('listdir'))})(".")`,
          `getattr(${pack('open("target.txt"),' + name('read'))})()`,
          `import os; read=getattr(${pack('os,' + name('listdir'))});read(".")`,
          `import os; getattr(${pack('os,' + name('listdir') + ',os.listdir')})(".")`,
          `import operator; read=operator.methodcaller(${pack(name('read'))});read(open("target.txt"))`,
          `import operator; list(map(operator.methodcaller(${pack(name('strip'))}),[" a "]))`,
          `import operator\ndef read():\n    return open("target.txt").read()\noperator.methodcaller(${pack(name('__call__'))})(${pack('read')})`,
          `import operator; operator.methodcaller(${pack(name('sort'))},**{"reverse":True})(["a","b"])`
        ])(
          `keeps fixed pack ${packIndex} name ${nameIndex} readers ordinary: %s`,
          async (source) => {
            expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
          }
        )
        it.each([
          `import os; getattr(${pack('os,' + name('unlink'))})("target.txt")`,
          `import os; getattr(${pack('os,' + name('listdir') + ',os.unlink("target.txt")')})(".")`,
          `import operator; from pathlib import Path; operator.methodcaller(${pack(name('unlink'))})(${pack('Path("target.txt")')})`,
          `import operator; from pathlib import Path; list(map(operator.methodcaller(${pack(name('unlink'))}),[Path("target.txt")]))`,
          `import operator,os\ndef erase():\n    os.unlink("target.txt")\noperator.methodcaller(${pack(name('__call__'))})(${pack('erase')})`
        ])(
          `retains fixed pack ${packIndex} name ${nameIndex} deleting effects: %s`,
          async (source) => {
            expect(
              (await analyzeNotebookCodeRisk('python', source)).some((risk) =>
                risk.operation.includes('unlink')
              )
            ).toBe(true)
          }
        )
        it(`retains frozen sort callback pack ${packIndex} name ${nameIndex}`, async () => {
          const source = `import operator,os; operator.methodcaller(${pack(name('sort'))},**{"key":os.unlink})(["target.txt"])`
          expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
        })
      }
      it.each([
        'len',
        'abs',
        'str',
        'int',
        'float',
        'bool',
        'None',
        'operator.itemgetter(0)',
        'operator.attrgetter("name")'
      ])(`keeps fixed packed sort readers ${packIndex}: %s`, async (key) => {
        expect(
          await analyzeNotebookCodeRisk(
            'python',
            `import operator; operator.methodcaller(${pack('"sort"')},**{"key":${key},"reverse":True})(values)`
          )
        ).toEqual([])
      })
      it(`preserves saved packed lookup aliases after history rebinding ${packIndex}`, async () => {
        const previous = `import os\nread=getattr(${pack('os,"listdir"')})\nerase=getattr(${pack('os,"unlink"')})`
        expect(await analyzeNotebookCodeRisk('python', 'read(".")', undefined, [previous])).toEqual(
          []
        )
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'os.unlink=lambda p:None\nerase("target.txt")',
              undefined,
              [previous]
            )
          ).some((risk) => risk.operation.includes('unlink'))
        ).toBe(true)
      })
    }
    it.each([
      'getattr(*args)("target.txt")',
      'import os; getattr(os,*names)("target.txt")',
      'import os; getattr(*(os,"listdir"),**options)(".")',
      'import os; getattr(*(os,property_name))("target.txt")',
      'import os; getattr(*(os,"listdir",os.unlink))(".")',
      'import operator; operator.methodcaller(*names)(receiver)',
      'import operator; operator.methodcaller(*("__call__",),*args)(receiver)',
      'import operator; operator.methodcaller(*("sort",),**options)(values)',
      'import operator; operator.methodcaller(*("sort",),**{"key":callback})(values)',
      'import operator; operator.methodcaller(*("__call__",))(*receivers)'
    ])('retains unknown names/receivers/frozen arguments: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
    })
    it.each(['operator.itemgetter(0)', 'operator.attrgetter("name")'])(
      'keeps frozen packed reader %s after source-name rebinding',
      async (factory) => {
        const previous = `import operator\nkey=${factory}\nsort=operator.methodcaller(*("sort",),**{"key":key})`
        expect(
          await analyzeNotebookCodeRisk(
            'python',
            'import os\nkey=os.unlink\nsort(values)',
            undefined,
            [previous]
          )
        ).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import operator,os\nkey=os.unlink\nsort=operator.methodcaller(*("sort",),**{"key":key})\nsort(["target.txt"])`
            )
          ).length
        ).toBeGreaterThan(0)
      }
    )
    it.each([
      'import operator,os; operator.methodcaller(*("sort",),**{"reverse":os.unlink("target.txt")})(values)',
      'import operator,os; operator.methodcaller(*("sort",),**{"key":operator.itemgetter(os.unlink("target.txt"))})(values)',
      'import os; getattr(*(os,*names),"listdir")(".")'
    ])('keeps eager or nested unknown packed lookup effects: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
    })
  })
  describe('Python literal positional unpacking', () => {
    const packs = [
      (args: string) => `*(${args},)`,
      (args: string) => `*[${args}]`,
      (args: string) => `*((${args},))`,
      (args: string) => `*(*[${args}],)`
    ]
    const collections = [
      ['map', 'cb,["target.txt"]', 'list'],
      ['filter', 'cb,["target.txt"]', 'list'],
      ['itertools.starmap', 'cb,[("target.txt",)]', 'list'],
      ['itertools.dropwhile', 'cb,["target.txt"]', 'list'],
      ['itertools.takewhile', 'cb,["target.txt"]', 'list'],
      ['itertools.filterfalse', 'cb,["target.txt"]', 'list'],
      ['itertools.groupby', '["target.txt"],cb', 'list'],
      ['heapq.nlargest', '1,["target.txt"],cb', 'list'],
      ['heapq.nsmallest', '1,["target.txt"],cb', 'list']
    ]
    for (const [index, pack] of packs.entries()) {
      for (const [method, args, consume] of collections) {
        it.each([false, true])(
          `classifies literal pack ${index} ${method} danger=%s`,
          async (danger) => {
            const source = `import os,itertools,heapq\ndef cb(path):\n    ${danger ? 'os.unlink(path)' : 'print(path)'}\n    return len(path)\n${consume}(${method}(${pack(args)}))`
            const risks = await analyzeNotebookCodeRisk('python', source)
            if (danger) expect(risks.some((risk) => risk.operation.includes('unlink'))).toBe(true)
            else expect(risks).toEqual([])
          }
        )
      }
      for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
        it.each(['cat', 'rm'])(
          `classifies process literal pack ${index} ${method} %s`,
          async (command) => {
            const source = `import subprocess; subprocess.${method}(${pack(`["${command}","target.txt"]`)})`
            const risks = await analyzeNotebookCodeRisk('python', source)
            if (command === 'rm') expect(risks.length).toBeGreaterThan(0)
            else expect(risks).toEqual([])
          }
        )
      }
      for (const target of ['open', 'io.open', 'builtins.open']) {
        it.each([false, true])(
          `classifies positional opener pack ${index} ${target} danger=%s`,
          async (danger) => {
            const source = `import os,io,builtins\ndef opener(path,flags):\n    ${danger ? 'os.unlink("victim.txt")' : 'print(path)'}\n    return os.open(path,flags)\n${target}(${pack('"target.txt","r",-1,None,None,None,True,opener')}).read()`
            const risks = await analyzeNotebookCodeRisk('python', source)
            if (danger) expect(risks.some((risk) => risk.operation.includes('unlink'))).toBe(true)
            else expect(risks).toEqual([])
          }
        )
        it(`keeps ignored descriptor opener pack ${index} ${target} ordinary`, async () => {
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              `import os,io,builtins\ndef opener(path,flags):\n    os.unlink("victim.txt")\n    return os.open(path,flags)\n${target}(${pack('3,"r",-1,None,None,None,False,opener')}).read()`
            )
          ).toEqual([])
        })
      }
      it.each(['cat', 'rm'])(`classifies expanded argv pack ${index} %s`, async (command) => {
        const source = `import subprocess; subprocess.run(["${command}",${pack('"target.txt"')}])`
        const risks = await analyzeNotebookCodeRisk('python', source)
        if (command === 'rm') expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
      it.each(['echo hello', 'rm target.txt'])(
        `classifies packed shell source ${index} %s`,
        async (command) => {
          const source = `import subprocess; subprocess.run(${pack(JSON.stringify(command))},shell=True)`
          const risks = await analyzeNotebookCodeRisk('python', source)
          if (command.startsWith('rm') || process.platform === 'win32')
            expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        }
      )
      it.each([false, true])(`classifies packed reducer ${index} danger=%s`, async (danger) => {
        const source = `import os,functools\ndef combine(acc,path):\n    ${danger ? 'os.unlink(path)' : 'print(path)'}\n    return acc+1\nfunctools.reduce(${pack('combine,["target.txt"],0')})`
        const risks = await analyzeNotebookCodeRisk('python', source)
        if (danger) expect(risks.some((risk) => risk.operation.includes('unlink'))).toBe(true)
        else expect(risks).toEqual([])
      })
    }
    it.each(['open', 'io.open', 'builtins.open'])(
      'reviews direct positional %s opener',
      async (target) => {
        const source = `import os,io,builtins\ndef opener(path,flags):\n    os.unlink("victim.txt")\n    return os.open(path,flags)\n${target}("target.txt","r",-1,None,None,None,True,opener).read()`
        expect(
          (await analyzeNotebookCodeRisk('python', source)).some((risk) =>
            risk.operation.includes('unlink')
          )
        ).toBe(true)
      }
    )
    it.each([
      'list(map(*callbacks))',
      'callbacks=factory(); list(map(*[*(callbacks,)]))',
      'list(map(*[*(callbacks)],str,["a"]))',
      'import heapq; heapq.nlargest(1,*items,len)',
      'import heapq; heapq.nlargest(*items,1,["a"],len)',
      'import subprocess; subprocess.run(*args)',
      'import subprocess; subprocess.run(["echo",*args])',
      'import subprocess; subprocess.run(*(["echo","hello"],),preexec_fn=cleanup)',
      'import subprocess; subprocess.run(*(["echo","hello"],),**options)',
      'import subprocess; subprocess.run("echo hello",*options,shell=True)',
      'callback=factory(); open(*args,opener=callback).read()',
      'import os; list(map(*(os.unlink,["target.txt"])))',
      'import os; cb=os.unlink; list(filter(*[cb,["target.txt"]]))',
      'import os; list(map(*[os.unlink("target.txt"),["a"]]))'
    ])('retains uncertain/captured/eager packed effects: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
    })
    it.each([
      'list(map(*(),str,["a"]))',
      'list(map(*(str,),*(),["a"]))',
      'list(map(*(str,),*(["a"],)))',
      'open(3,*args).read()',
      'open(3,*args,opener=callback).read()',
      'open(3,*args,**options).read()'
    ])('keeps fixed empty stars or ignored descriptor callbacks ordinary: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
    })
    it('retains the depth limit as uncertain callback evidence', async () => {
      let args = '(str,["a"])'
      for (let index = 0; index < 65; index++) args = `(*${args},)`
      expect(
        (await analyzeNotebookCodeRisk('python', `list(map(*${args}))`)).length
      ).toBeGreaterThan(0)
    })
    it('keeps packed callback source identity through history rebinding', async () => {
      const previous = 'import os\nreader=str\nerase=os.unlink'
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'str=os.unlink\nlist(map(*(reader,["a"])))',
          undefined,
          [previous]
        )
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'os.unlink=lambda p:None\nlist(map(*(erase,["target.txt"])))',
            undefined,
            [previous]
          )
        ).some((risk) => risk.operation.includes('unlink'))
      ).toBe(true)
    })
  })
  describe('static module destructuring provenance', () => {
    const forms = [
      (value: string) => JSON.stringify(value),
      (value: string) => `(${JSON.stringify(value)})`,
      (value: string) => '`' + value + '`',
      (value: string) => '(`' + value + '`)'
    ]
    for (const [moduleIndex, moduleForm] of forms.entries()) {
      for (const [keyIndex, keyForm] of forms.entries()) {
        for (const route of ['direct', 'assignment', 'nested', 'default']) {
          for (const danger of [false, true]) {
            it(`resolves module ${moduleIndex} key ${keyIndex} ${route} danger=${danger}`, async () => {
              const method =
                route === 'nested'
                  ? danger
                    ? 'unlink'
                    : 'readFile'
                  : danger
                    ? 'unlinkSync'
                    : 'readFileSync'
              const pattern =
                route === 'nested'
                  ? `{[${keyForm('promises')}]:{[${keyForm(method)}]: run}}`
                  : `{[${keyForm(method)}]: run${route === 'default' ? '=fs.' + method : ''}}`
              const definition =
                route === 'assignment'
                  ? `let run=fs.${danger ? 'readFileSync' : 'unlinkSync'}; (${pattern}=fs)`
                  : `const ${pattern}=fs`
              const source = `const fs=require(${moduleForm('node:fs')}); ${definition}; run('target.txt')`
              const risks = await analyzeNotebookCodeRisk('repl', source)
              if (danger)
                expect(
                  risks.some(
                    (risk) =>
                      risk.operation ===
                      'node:fs.' + (route === 'nested' ? 'promises.' : '') + method
                  )
                ).toBe(true)
              else expect(risks).toEqual([])
            })
          }
        }
      }
      it.each(['spawnSync', 'execFileSync'])(
        `keeps fixed module form ${moduleIndex} queries ordinary: %s`,
        async (api) => {
          const source = `const {${api}:run}=require(${moduleForm('child_process')}); run('echo',['hello'])`
          expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([])
        }
      )
      it.each([false, true])(
        `retains history identity form ${moduleIndex} danger=%s`,
        async (danger) => {
          const method = danger ? 'unlinkSync' : 'readFileSync'
          const previous = `const fs=require(${moduleForm('fs')}); const {[${moduleForm(method)}]: saved}=fs`
          const source = `fs.${method}=()=>{}; saved('target.txt')`
          const risks = await analyzeNotebookCodeRisk('repl', source, undefined, [previous])
          if (danger) expect(risks.some((risk) => risk.operation === 'fs.unlinkSync')).toBe(true)
          else expect(risks).toEqual([])
        }
      )
      it.each(['fs/promises', 'node:fs/promises'])(
        `preserves promises module form ${moduleIndex}: %s`,
        async (module) => {
          const prefix = `const fs=require(${moduleForm(module)}); const {[${moduleForm('readFile')}]:read,[${moduleForm('unlink')}]:erase}=fs; `
          expect(await analyzeNotebookCodeRisk('repl', prefix + 'read("target.txt")')).toEqual([])
          expect(
            (await analyzeNotebookCodeRisk('repl', prefix + 'erase("target.txt")')).some(
              (risk) => risk.operation === module.replace('fs/promises', 'fs.promises') + '.unlink'
            )
          ).toBe(true)
        }
      )
    }
    it.each([
      'const {[name]:run}=require("fs"); run("target.txt")',
      'const {[`${name}`]:run}=require("fs"); run("target.txt")',
      'const {[`read\\u0046ileSync`]:run}=require("fs"); run("target.txt")',
      'const {readFileSync:run}=require(moduleName); run("target.txt")',
      'const {readFileSync:run}=require(`${moduleName}`); run("target.txt")',
      'const {readFileSync:run}=require("f\\u0073"); run("target.txt")',
      'const fs=require("fs"); const {[`readFileSync`]:run=fs.unlinkSync}=fs; run("target.txt")',
      'const fs=require("fs"); const {[`missing`]:run=fs.unlinkSync}=fs; run("target.txt")',
      'const fs=require("fs"); const {[fs.unlinkSync("target.txt")]:run}=fs; run("target.txt")',
      'const fs=require("fs"); const {[`promises`]:{[name]:run}}=fs; run("target.txt")'
    ])('keeps uncertain/default/eager lookup effects reviewable: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('repl', source)).length).toBeGreaterThan(0)
    })
  })
  describe('fixed accessor and forwarding names', () => {
    const pythonNames = [
      (name: string) => JSON.stringify(name),
      (name: string) => `(${JSON.stringify(name)})`,
      (name: string) => `${JSON.stringify(name.slice(0, 1))} ${JSON.stringify(name.slice(1))}`,
      (name: string) => `f${JSON.stringify(name)}`
    ]
    for (const [index, form] of pythonNames.entries()) {
      it.each([
        `import os; getattr(os, ${form('listdir')})(".")`,
        `import os; read=getattr(os, ${form('listdir')}); read(".")`,
        `import os; getattr(os, ${form('listdir')}, os.listdir)(".")`,
        `getattr(open("target.txt"), ${form('read')})()`,
        `import operator; list(map(operator.methodcaller(${form('strip')}), [" a "," b "]))`,
        `from operator import methodcaller as method; read=method(${form('read')}); read(open("target.txt"))`,
        `import operator; operator.methodcaller(${form('replace')}, "a", "b")("a")`,
        `import operator; operator.methodcaller(${form('sort')})(["b","a"])`,
        `import operator; operator.methodcaller(${form('sort')},key=len)(["bb","a"])`,
        `import operator; operator.methodcaller(${form('sort')},key=None,reverse=True)(["b","a"])`,
        `getattr(records, ${form('sort')})(key=len)`
      ])(`keeps Python fixed accessor form ${index} ordinary: %s`, async (source) => {
        expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
      })
      it.each([
        `import os; getattr(os, ${form('unlink')})("target.txt")`,
        `import os; erase=getattr(os, ${form('unlink')}); erase("target.txt")`,
        `import operator; from pathlib import Path; operator.methodcaller(${form('unlink')})(Path("target.txt"))`,
        `import operator; from pathlib import Path; list(map(operator.methodcaller(${form('unlink')}),[Path("target.txt")]))`,
        `import os; getattr(os, ${form('listdir')}, os.unlink("target.txt"))(".")`,
        `import os; getattr(os, ${form('listdir')}, os.unlink)(".")`,
        `import operator, os; operator.methodcaller(${form('replace')}, os.unlink("target.txt"), "x")("a")`,
        `import operator, os; operator.methodcaller(${form('__call__')})(os.unlink)("target.txt")`,
        `import operator, os; operator.methodcaller(${form('sort')}, key=os.unlink)(["target.txt"])`,
        `import os; getattr(records, ${form('sort')})(key=os.unlink)`,
        `import operator,os; len=os.unlink; operator.methodcaller(${form('sort')},key=len)(["target.txt"])`
      ])(`reviews Python fixed accessor effects ${index}: %s`, async (source) => {
        expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
      })
    }
    const jsNames = [(name: string) => '`' + name + '`', (name: string) => '(`' + name + '`)']
    for (const api of ['exec', 'execFile']) {
      for (const forward of ['call', 'apply']) {
        for (const danger of [false, true]) {
          it(`inspects Node ${api} template ${forward} completion callback danger=${danger}`, async () => {
            const args =
              (api === 'exec' ? '"echo hello"' : '"echo",["hello"]') +
              ',(error,stdout)=>' +
              (danger ? 'fs.unlinkSync("target.txt")' : 'console.log(stdout)')
            const source = `const cp=require("child_process"), fs=require("fs"); cp.${api}[\`${forward}\`](null,${forward === 'apply' ? '[' + args + ']' : args})`
            const risks = await analyzeNotebookCodeRisk('repl', source)
            if (danger || (api === 'exec' && process.platform === 'win32'))
              expect(risks.length).toBeGreaterThan(0)
            else expect(risks).toEqual([])
          })
        }
      }
    }
    for (const [index, form] of jsNames.entries()) {
      for (const method of ['call', 'apply', 'bind']) {
        const invoke = (target: string, argv: string): string =>
          method === 'call'
            ? `${target}[${form(method)}](null, ${argv})`
            : method === 'apply'
              ? `${target}[${form(method)}](null, [${argv}])`
              : `${target}[${form(method)}](null)(${argv})`
        it.each([
          `const fs=require('fs'); ${invoke('fs.readFileSync', '"target.txt","utf8"')}`,
          `const fs=require('fs'); const read=fs.readFileSync[${form('bind')}](fs); ${invoke('read', '"target.txt","utf8"')}`,
          `function size(value){ return value.length }; ${invoke('size', '[1,2]')}`
        ])(`keeps Node fixed ${method} form ${index} ordinary: %s`, async (source) => {
          expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([])
        })
        it.each([
          `const fs=require('fs'); ${invoke('fs.unlinkSync', '"target.txt"')}`,
          `const fs=require('fs'); const erase=fs.unlinkSync[${form('bind')}](fs); ${invoke('erase', '"target.txt"')}`,
          `const fs=require('fs'); function erase(path){ fs.unlinkSync(path) }; ${invoke('erase', '"target.txt"')}`,
          `const fs=require('fs'); ${invoke('fs.readFileSync', 'fs.unlinkSync("target.txt"),"utf8"')}`
        ])(`reviews Node fixed ${method} form ${index} effects: %s`, async (source) => {
          expect((await analyzeNotebookCodeRisk('repl', source)).length).toBeGreaterThan(0)
        })
        if (method !== 'bind') {
          for (const api of ['spawnSync', 'execFileSync', 'execSync']) {
            for (const command of ['cat', 'rm']) {
              const args =
                api === 'execSync'
                  ? JSON.stringify(command + ' target.txt')
                  : `${JSON.stringify(command)},["target.txt"]`
              it(`classifies Node ${api} ${method} form ${index} ${command}`, async () => {
                const risks = await analyzeNotebookCodeRisk(
                  'repl',
                  `const cp=require('child_process'); ${invoke('cp.' + api, args)}`
                )
                if (command === 'rm' || (api === 'execSync' && process.platform === 'win32'))
                  expect(risks.length).toBeGreaterThan(0)
                else expect(risks).toEqual([])
              })
            }
          }
        }
      }
    }
    it.each([
      ['python', 'import os; paths.sort(key=os.unlink)'],
      ['python', 'import os; paths.sort(**{"key":os.unlink})'],
      ['python', 'import os; paths.sort(key=lambda path:os.unlink(path))'],
      ['python', 'import os; key=os.unlink; paths.sort(key=key)'],
      ['python', 'import operator; operator.methodcaller("sort",key=callback)(paths)'],
      ['python', 'import operator; operator.methodcaller("sort",**options)(paths)'],
      ['python', 'import operator; operator.methodcaller("sort",*args)(paths)'],
      ['python', 'import os; getattr(os, name)(".")'],
      ['python', 'import os; getattr(os, f"lis{suffix}")(".")'],
      ['python', 'import operator; operator.methodcaller(name)(receiver)'],
      ['python', 'import operator; operator.methodcaller("re\\u0061d")(receiver)'],
      ['repl', 'const fs=require("fs"); fs.readFileSync[`${method}`](null,"target.txt")'],
      ['repl', 'const fs=require("fs"); fs.unlinkSync[`ca\\u006cl`](null,"target.txt")'],
      ['repl', 'factory()[`bind`](null)("target.txt")'],
      [
        'repl',
        'const fs=require("fs"); const run=paths.forEach[`bind`](paths, fs.unlinkSync); run()'
      ],
      [
        'repl',
        'const fs=require("fs"); const run=(path=>fs.unlinkSync(path))[`bind`](null); run("target.txt")'
      ],
      ['repl', 'const cp=require("child_process"); cp.spawnSync[`apply`](null, args)']
    ] as const)('retains %s uncertain forwarding boundaries: %s', async (language, source) => {
      expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
    })
    it('keeps deferred bound deletion dormant until invocation', async () => {
      const previous = 'const fs=require("fs"); const erase=fs.unlinkSync[`bind`](fs,"target.txt")'
      expect(await analyzeNotebookCodeRisk('repl', previous)).toEqual([])
      expect(
        (await analyzeNotebookCodeRisk('repl', 'erase()', undefined, [previous])).some((risk) =>
          risk.operation.includes('unlinkSync')
        )
      ).toBe(true)
    })
    it.each([
      'paths.sort()',
      'paths.sort(key=len)',
      'paths.sort(key=lambda path:len(path))',
      'paths.sort(**{"reverse":True})',
      'import operator; key=operator.itemgetter(0); paths.sort(key=key)'
    ])('keeps ordinary Python sort data access prompt-free: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
    })
    it.each([
      'const fs=require("fs"); const read=fs.readFileSync[`bind`](fs); Reflect.apply(read,null,["target.txt","utf8"])',
      'const vm=require("vm"); const Script=vm.Script[`bind`](null,"1+1"); new Script()'
    ])('preserves inert fixed binding through Reflect/construct: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([])
    })
    it.each([
      'const fs=require("fs"); const erase=fs.unlinkSync[`bind`](fs); Reflect.apply(erase,null,["target.txt"])',
      'const vm=require("vm"); const Script=vm.Script[`bind`](null,"1+1"); new Script().runInThisContext()',
      'const vm=require("vm"); const Script=vm.Script[`bind`](null,"1+1"); const script=Reflect.construct(Script,[]); script.runInThisContext()',
      'const fs=require("fs"); const P=Promise[`bind`](null,()=>fs.unlinkSync("target.txt")); new P()'
    ])('retains effects through bound Reflect/construct: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('repl', source)).length).toBeGreaterThan(0)
    })
    it('preserves accessor provenance across cells and original-name rebinding', async () => {
      const previous = 'import os\nread=getattr(os,"lis" "tdir")\nerase=getattr(os,"un" "link")'
      expect(
        await analyzeNotebookCodeRisk('python', 'print(read("."))', undefined, [previous])
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk(
            'python',
            'os.unlink=lambda p:None\nerase("target.txt")',
            undefined,
            [previous]
          )
        ).some((risk) => risk.operation.includes('unlink'))
      ).toBe(true)
    })
    it('retains frozen builtin sort key across later source-name rebinding', async () => {
      const previous = 'import operator\nkey=len\nsort=operator.methodcaller("s" "ort",key=key)'
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'import os\nkey=os.unlink\nsort(["bb","a"])',
          undefined,
          [previous]
        )
      ).toEqual([])
    })
    it.each(['len', 'abs', 'str', 'int', 'float', 'bool'])(
      'distinguishes fixed frozen %s builtin from a shadowed deleting callback',
      async (name) => {
        expect(
          await analyzeNotebookCodeRisk(
            'python',
            `import operator, builtins\nkey=builtins.${name}\nread=operator.methodcaller("sort",key=key)\nread(values)`
          )
        ).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import operator, os\n${name}=os.unlink\nread=operator.methodcaller("sort",key=${name})\nread(["target.txt"])`
            )
          ).length
        ).toBeGreaterThan(0)
      }
    )
    it.each(['exec', 'execFile'])(
      'retains frozen Node %s callbacks despite ordinary later arguments',
      async (api) => {
        const frozen = api === 'exec' ? '"echo hello"' : '"echo",["hello"]'
        const source = `const cp=require("child_process"),fs=require("fs"); const run=cp.${api}[\`bind\`](null,${frozen},()=>fs.unlinkSync("target.txt")); run("echo",["hello"])`
        expect((await analyzeNotebookCodeRisk('repl', source)).length).toBeGreaterThan(0)
      }
    )
    it.each(['spawnSync', 'execFileSync', 'execSync', 'exec', 'execFile'])(
      'retains captured Node %s process arguments as unresolved',
      async (api) => {
        const source = `const cp=require("child_process"); const run=cp.${api}[\`bind\`](null,"command"); run("echo",["hello"])`
        expect((await analyzeNotebookCodeRisk('repl', source)).length).toBeGreaterThan(0)
      }
    )
    it.each(['spawnSync', 'execFileSync', 'execSync'])(
      'keeps Node %s receiver-only bind ordinary when command is still visible',
      async (api) => {
        const args = api === 'execSync' ? '"echo hello"' : '"echo",["hello"]'
        const risks = await analyzeNotebookCodeRisk(
          'repl',
          `const cp=require("child_process"); const run=cp.${api}[\`bind\`](null); run(${args})`
        )
        if (api === 'execSync' && process.platform === 'win32')
          expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      }
    )
  })
  describe('Python packed literal arguments', () => {
    const keys = [
      (name: string) => JSON.stringify(name),
      (name: string) => `(${JSON.stringify(name)})`,
      (name: string) => `${JSON.stringify(name.slice(0, 1))} ${JSON.stringify(name.slice(1))}`,
      (name: string) => `f${JSON.stringify(name)}`
    ]
    const pack = (key: (name: string) => string, command: string, shell: boolean): string =>
      `{${key('args')}:${shell ? JSON.stringify(command + ' target.txt') : `[${JSON.stringify(command)},"target.txt"]`},${key('shell')}:${shell ? 'True' : 'False'},${key('env')}:{"LC_ALL":"C"}}`
    for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
      for (const [index, key] of keys.entries()) {
        for (const shell of [false, true]) {
          for (const command of ['cat', 'rm']) {
            it(`classifies ${method} packed keys ${index} shell=${shell} ${command}`, async () => {
              const risks = await analyzeNotebookCodeRisk(
                'python',
                `import subprocess; subprocess.${method}(**${pack(key, command, shell)})`
              )
              if (command === 'rm' || (shell && process.platform === 'win32'))
                expect(risks.length).toBeGreaterThan(0)
              else expect(risks).toEqual([])
            })
          }
        }
      }
      for (const shell of [false, true]) {
        for (const command of ['cat', 'rm']) {
          const argv = shell
            ? JSON.stringify(command + ' target.txt')
            : `[${JSON.stringify(command)},"target.txt"]`
          it.each([
            `**({"args":${argv},"shell":${shell ? 'True' : 'False'}})`,
            `**{**{"args":${argv}},**{"shell":${shell ? 'True' : 'False'}}}`,
            `**{"args":${argv}}, **{"shell":${shell ? 'True' : 'False'},"env":{"LC_ALL":"C"}}`,
            `${argv}, **{"shell":${shell ? 'True' : 'False'},"env":{"LC_ALL":"C"}}`
          ])(`classifies ${method} merged shell=${shell} ${command}: %s`, async (argumentsText) => {
            const risks = await analyzeNotebookCodeRisk(
              'python',
              `import subprocess; subprocess.${method}(${argumentsText})`
            )
            if (command === 'rm' || (shell && process.platform === 'win32'))
              expect(risks.length).toBeGreaterThan(0)
            else expect(risks).toEqual([])
          })
        }
      }
    }
    for (const [index, key] of keys.entries()) {
      for (const [target, keyword] of [
        ['os.popen', 'cmd'],
        ['subprocess.getoutput', 'cmd'],
        ['subprocess.getstatusoutput', 'cmd']
      ]) {
        for (const command of ['cat', 'rm']) {
          it(`classifies ${target} packed key ${index} ${command}`, async () => {
            const risks = await analyzeNotebookCodeRisk(
              'python',
              `import os, subprocess; ${target}(**{${key(keyword)}:${JSON.stringify(command + ' target.txt')}})`
            )
            if (command === 'rm' || process.platform === 'win32')
              expect(risks.length).toBeGreaterThan(0)
            else expect(risks).toEqual([])
          })
        }
      }
      it.each([
        `open("target.txt", **{${key('encoding')}:"utf-8"}).read()`,
        `open(**{${key('file')}:"target.txt",${key('mode')}:"r",${key('errors')}:"strict"}).read()`,
        `open("target.txt", **{**{${key('encoding')}:"utf-8"},${key('opener')}:None}).read()`,
        `sorted([3,1,2], **{${key('reverse')}:True})`,
        `max(["a","bb"], **{${key('key')}:len})`
      ])(`keeps fixed reader/collection keys ${index} ordinary: %s`, async (source) => {
        expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
      })
      it.each([
        `import os; open("target.txt", **{${key('opener')}:os.unlink}).read()`,
        `import os; sorted(["target.txt"], **{${key('key')}:os.unlink})`,
        `import os; max(["target.txt"], **{${key('key')}:os.unlink})`,
        `import os; open("target.txt", **{${key('encoding')}:os.unlink(path)}).read()`
      ])(`retains eager/callback effects in keys ${index}: %s`, async (source) => {
        expect(
          (await analyzeNotebookCodeRisk('python', source)).some((risk) =>
            risk.operation.includes('unlink')
          )
        ).toBe(true)
      })
    }
    it.each([
      'import subprocess; subprocess.run("echo hello",shell=True,executable=None,preexec_fn=None,env=None, **options)',
      'import subprocess; subprocess.run("echo hello",shell=True,executable=None,preexec_fn=None,env=None, **{**options})',
      'import os; os.popen(cmd="echo hello", **options)',
      'import subprocess; subprocess.getoutput(cmd="echo hello", **{**options})',
      'import subprocess; subprocess.getstatusoutput(cmd="echo hello", **{key:None})',
      'import subprocess; subprocess.run("echo hello", **options)',
      'import subprocess; subprocess.run("echo hello",shell=True, **options)',
      'import subprocess; subprocess.run("echo hello", **{"shell":True, **options})',
      'import subprocess; subprocess.run("echo hello", **{"shell":True, key:None})',
      'import subprocess; subprocess.run("echo hello", **{"shell":True,"executable":program})',
      'import subprocess; subprocess.run("echo hello", **{"shell":True,"preexec_fn":cleanup})',
      'import subprocess; subprocess.run("echo hello", **{"shell":True,"env":settings})',
      'import subprocess; subprocess.run("echo hello", **{"shell":True,"env":{"LD_PRELOAD":"module"}})',
      'import subprocess; subprocess.run("echo hello", **{f"sh{suffix}":True})',
      'import subprocess; subprocess.run("echo hello", **{"sh\\u0065ll":True})',
      'import subprocess; subprocess.run("echo hello", **{"shell":True, **{"preexec_fn":cleanup}})',
      'import subprocess; subprocess.run("echo hello", **{"shell":True,"executable":None, **{"executable":"bash"}})',
      'open("target.txt", **{key:"utf-8"}).read()',
      'open("target.txt", **options).read()'
    ])('retains unknown packed execution/reader boundaries: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
    })
    it.each([
      ['"echo hello", **{"shell":False, **{"shell":True}}', false],
      ['"rm target.txt", **{"shell":False, **{"shell":True}}', true],
      [
        '"echo hello", **{"shell":True,"env":{"LD_PRELOAD":"module"}, **{"env":{"LC_ALL":"C"}}}',
        false
      ],
      [
        '"echo hello", **{"shell":True,"env":{"LC_ALL":"C"}, **{"env":{"LD_PRELOAD":"module"}}}',
        true
      ],
      ['["echo","hello"], **{"shell":True, **{"shell":False}}', false],
      ['["rm","target.txt"], **{"shell":True, **{"shell":False}}', true]
    ] as const)('uses last dictionary value: %s', async (args, dangerous) => {
      const risks = await analyzeNotebookCodeRisk(
        'python',
        `import subprocess; subprocess.run(${args})`
      )
      if (dangerous || (process.platform === 'win32' && args.startsWith('"')))
        expect(risks.length).toBeGreaterThan(0)
      else expect(risks).toEqual([])
    })
    it('preserves source history packed reader and shell calls', async () => {
      const history = [
        'import subprocess\ndef report():\n    return subprocess.check_output(**{"ar" "gs":["echo","hello"]})',
        'def reader(path):\n    return open(path, **{"encod" "ing":"utf-8"}).read()'
      ]
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'print(report()); print(reader("target.txt"))',
          undefined,
          history
        )
      ).toEqual([])
      expect(
        (
          await analyzeNotebookCodeRisk('python', 'print(report())', undefined, [
            'import subprocess\ndef report():\n    return subprocess.check_output(**{"args":"rm target.txt","sh" "ell":True})'
          ])
        ).length
      ).toBeGreaterThan(0)
    })
    it('reviews a valid two-argument opener even when supplied through fixed packed keys', async () => {
      const source =
        'import os\ndef opener(path, flags):\n    os.unlink("victim.txt")\n    return os.open(path, flags)\nprint(open("target.txt", **{"op" "ener":opener}).read())'
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([
        expect.objectContaining({ operation: 'opener: os.unlink', line: 5 })
      ])
    })
  })
  describe('static process string forms', () => {
    it.each([
      'const cp=require("child_process"); cp[`sp${suffix}`](`echo`,[`hello`])',
      'const cp=require("child_process"); cp.spawnSync(`echo`,[`hello`],{[`sh${suffix}`]:false})',
      'const cp=require("child_process"); cp.spawnSync(`echo`,[`hello`],{env:{[`${key}`]:`C`}})',
      'const cp=require("child_process"); cp.spawnSync(`r\\u006d`,[`target.txt`])'
    ])('retains interpolated/escaped template identity: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('repl', source)).length).toBeGreaterThan(0)
    })
    it('distinguishes Bash word prefixes from Python string prefixes', async () => {
      expect(await analyzeNotebookCodeRisk('bash', 'nice f"rm" target.txt')).toEqual([])
      expect(
        (await analyzeNotebookCodeRisk('bash', 'nice "rm" target.txt')).length
      ).toBeGreaterThan(0)
    })
    it.each([
      [
        'python',
        'import subprocess; subprocess.run(["e"\n# command fragments\n"cho","hello"],env={"LC_" "ALL":f"C"})'
      ],
      [
        'repl',
        'const cp=require(`child_process`); cp[`spawnSync`](`echo`,[`hello`],{[`env`]:{[`LC_ALL`]:`C`}})'
      ],
      [
        'repl',
        'const cp=require("child_process"); cp[`execFileSync`](`echo`,[`hello`],{[`shell`]:false})'
      ]
    ] as const)(
      'keeps %s fixed string property/keyword forms ordinary: %s',
      async (language, source) => {
        expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
      }
    )
    it.each([
      ['repl', 'const cp=require(`child_process`); cp[`spawnSync`](`rm`,[`target.txt`])'],
      [
        'repl',
        'const cp=require("child_process"); cp[`execFileSync`](`echo`,[`hello`],{[`shell`]:true})'
      ],
      [
        'repl',
        'const cp=require("child_process"); cp[`spawnSync`](`echo`,[`hello`],{[`env`]:{[`NODE_OPTIONS`]:`--require=module`}})'
      ],
      ['repl', 'const fs=require(`fs`); fs[`unlinkSync`](`target.txt`)'],
      ['python', 'import subprocess; subprocess.run(["r"\n# command fragments\n"m","target.txt"])'],
      [
        'python',
        'import subprocess; subprocess.run([f"echo","hello"],env={"LD_" "PRELOAD":f"module"})'
      ]
    ] as const)('retains %s static property/keyword destruction: %s', async (language, source) => {
      expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
    })
    const pythonForms = [
      (value: string) => `f${JSON.stringify(value)}`,
      (value: string) => `F${JSON.stringify(value)}`,
      (value: string) => `fr${JSON.stringify(value)}`,
      (value: string) => `rf${JSON.stringify(value)}`,
      (value: string) => `f"""${value}"""`,
      (value: string) => `${JSON.stringify(value.slice(0, 1))} ${JSON.stringify(value.slice(1))}`,
      (value: string) => `f${JSON.stringify(value.slice(0, 1))} ${JSON.stringify(value.slice(1))}`
    ]
    for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
      it.each(['"pwd"', 'args="pwd"', 'args=("pwd")', '**{"args":"pwd"}', 'f"pwd"', '"p" "wd"'])(
        `keeps Python ${method} single executable ordinary: %s`,
        async (argument) => {
          expect(
            await analyzeNotebookCodeRisk(
              'python',
              `import subprocess; subprocess.${method}(${argument})`
            )
          ).toEqual([])
        }
      )
      for (const [index, form] of pythonForms.entries()) {
        for (const shell of [false, true]) {
          it(`keeps Python ${method} fixed form ${index} shell=${shell} ordinary`, async () => {
            const argument = shell ? form('echo hello') : `[${form('echo')},${form('hello')}]`
            const risks = await analyzeNotebookCodeRisk(
              'python',
              `import subprocess; subprocess.${method}(${argument},shell=${shell ? 'True' : 'False'})`
            )
            if (shell && process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
            else expect(risks).toEqual([])
          })
          it(`reviews Python ${method} fixed form ${index} shell=${shell} deletion`, async () => {
            const argument = shell ? form('rm target.txt') : `[${form('rm')},${form('target.txt')}]`
            expect(
              (
                await analyzeNotebookCodeRisk(
                  'python',
                  `import subprocess; subprocess.${method}(${argument},shell=${shell ? 'True' : 'False'})`
                )
              ).length
            ).toBeGreaterThan(0)
          })
        }
        it(`recognizes Python ${method} fixed form ${index} single destructive executable`, async () => {
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                `import subprocess; subprocess.${method}(${form('rm')})`
              )
            ).length
          ).toBeGreaterThan(0)
        })
      }
    }
    for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
      const shell = method === 'exec' || method === 'execSync'
      for (const command of ['echo', 'rm']) {
        it(`classifies Node ${method} fixed template ${command}`, async () => {
          const argument = shell
            ? '`' + command + ' target.txt`'
            : '`' + command + '`, [`target.txt`]'
          const risks = await analyzeNotebookCodeRisk(
            'repl',
            `const cp=require('child_process'); cp.${method}(${argument})`
          )
          if (command === 'rm' || (shell && process.platform === 'win32'))
            expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        })
      }
      it(`keeps Node ${method} static template env/options ordinary`, async () => {
        const argument = shell ? '`echo hello`' : '`echo`, [`hello`]'
        const options = '{env:{LC_ALL:`C`},encoding:`utf8`}'
        const risks = await analyzeNotebookCodeRisk(
          'repl',
          `const cp=require('child_process'); cp.${method}(${argument}, ${options})`
        )
        if (shell && process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
    }
    it.each(pythonForms.map((form, index) => [index, form] as const))(
      'recognizes destructive method callback in Python form %s',
      async (_index, form) => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `from operator import methodcaller\nfrom pathlib import Path\nlist(map(methodcaller(${form('unlink')}), [Path("target.txt")]))`
            )
          ).length
        ).toBeGreaterThan(0)
      }
    )
    it.each([
      ['python', 'import subprocess; subprocess.run(f"{program}")'],
      ['python', 'import subprocess; subprocess.run([f"{program}","hello"])'],
      ['python', 'import subprocess; subprocess.run(f"echo {os.remove(path)}",shell=True)'],
      ['python', 'import subprocess; subprocess.run("cleanup.py")'],
      ['python', 'import subprocess; subprocess.run("python")'],
      ['python', 'import subprocess; subprocess.run("rm target.txt")'],
      ['python', 'import subprocess; subprocess.run("echo",executable="rm")'],
      ['python', 'import subprocess; subprocess.run("pwd",preexec_fn=cleanup)'],
      ['repl', 'const cp=require("child_process"); cp.spawnSync(`${program}`, ["hello"])'],
      [
        'repl',
        'const cp=require("child_process"); cp.execSync(`echo ${require("fs").unlinkSync(path)}`)'
      ],
      ['repl', 'const cp=require("child_process"); cp.execSync(`echo hello; rm target.txt`)'],
      ['repl', 'const cp=require("child_process"); cp.execSync(`echo\nrm target.txt`)'],
      ['repl', 'const cp=require("child_process"); cp.spawnSync(`cleanup.sh`,["--help"])'],
      [
        'repl',
        'const cp=require("child_process"); cp.execFile(`echo`,[`hello`],()=>require("fs").unlinkSync(path))'
      ],
      ['repl', 'const cp=require("child_process"); cp.execSync(String.raw`echo hello`)']
    ] as const)('retains %s dynamic/secondary effects: %s', async (language, source) => {
      expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
    })
    it.each([
      [
        'python',
        'import subprocess\ndef output():\n    return subprocess.check_output("pwd")',
        'print(output())'
      ],
      [
        'python',
        'import subprocess\ndef output():\n    return subprocess.check_output([f"echo", f"hello"])',
        'print(output())'
      ],
      [
        'repl',
        'const cp=require("child_process"); function output(){return cp.execFileSync(`echo`,[`hello`]).toString()}',
        'console.log(output())'
      ]
    ] as const)('replays %s fixed string source', async (language, previous, source) => {
      expect(await analyzeNotebookCodeRisk(language, source, undefined, [previous])).toEqual([])
    })
    it('retains Windows string argv ambiguity and distinguishes POSIX argv0', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
      for (const platform of ['linux', 'darwin', 'win32']) {
        try {
          Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
          const risks = await analyzeNotebookCodeRisk(
            'python',
            'import subprocess; subprocess.run("git reset --hard", executable="echo")'
          )
          if (platform === 'win32') expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
          expect(
            (
              await analyzeNotebookCodeRisk(
                'python',
                'import subprocess; subprocess.run("rm target.txt")'
              )
            ).length
          ).toBeGreaterThan(0)
        } finally {
          Object.defineProperty(process, 'platform', descriptor)
        }
      }
    })
  })
  describe('literal process environment roles', () => {
    it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'])(
      'supports Node %s literal numeric thread settings without hiding deletion',
      async (method) => {
        const shell = method === 'exec' || method === 'execSync'
        for (const command of ['echo', 'rm']) {
          const source = `const cp=require('child_process'); cp.${method}(${shell ? `'${command} target.txt'` : `'${command}', ['target.txt']`}, {env:{OMP_NUM_THREADS:2}})`
          const risks = await analyzeNotebookCodeRisk('repl', source)
          if (command === 'rm' || (shell && process.platform === 'win32'))
            expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        }
      }
    )
    it.each([
      ['python', 'import subprocess; subprocess.run(["echo","hello"], env={"TZ":"%PAYLOAD%"})'],
      [
        'repl',
        "const cp=require('child_process'); cp.spawnSync('echo',['hello'],{env:{TZ:'%PAYLOAD%'}})"
      ],
      ['r', 'system2("echo", "hello", env="TZ=%PAYLOAD%")']
    ] as const)('retains %s shell-expansion environment tokens: %s', async (language, source) => {
      expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
    })
    it.each([
      [
        'python',
        'import subprocess; subprocess.run(["echo","hello"], executable=None, preexec_fn=None, shell=False, **settings)'
      ],
      ['python', 'import subprocess; subprocess.run(["echo","hello"], env={LANG:"C"})'],
      [
        'python',
        'import subprocess; subprocess.run(["echo","hello"], env={"LC_ALL":"C", "LD_PRELOAD":"module"})'
      ],
      [
        'repl',
        "const cp=require('child_process'); const LANG='LD_PRELOAD'; cp.spawnSync('echo',['hello'],{env:{[LANG]:'module'}})"
      ],
      [
        'repl',
        "const cp=require('child_process'); cp.execSync('echo hello',{env:{LC_ALL:'C',NODE_OPTIONS:'--require=module'}})"
      ],
      [
        'repl',
        "const cp=require('child_process'); cp.spawnSync('echo',['hello'],{env:{__proto__:{LC_ALL:'C'}}})"
      ],
      ['r', 'system2("echo", "hello", env=c("LC_ALL=C", "LD_PRELOAD=module"))'],
      ['r', 'system2("echo", "hello", env="LC_ALL=C\\nrm target.txt")']
    ] as const)('keeps %s environment identity/packed boundaries: %s', async (language, source) => {
      expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
    })
    it.each([
      [
        'python',
        'import subprocess\ndef output():\n    return subprocess.check_output(["echo","hello"], env={"LC_ALL":"C"})',
        'print(output())'
      ],
      [
        'repl',
        "const cp=require('child_process'); function output(){return cp.execFileSync('echo',['hello'],{env:{LC_ALL:'C'}}).toString()}",
        'console.log(output())'
      ],
      [
        'r',
        'output <- function() system2("echo", "hello", env="LC_ALL=C", stdout=TRUE)',
        'print(output())'
      ]
    ] as const)(
      'replays %s passive environment wrapper source',
      async (language, previous, source) => {
        expect(await analyzeNotebookCodeRisk(language, source, undefined, [previous])).toEqual([])
      }
    )
    const settings = [
      {},
      { LC_ALL: 'C' },
      { LANG: 'C.UTF-8', LC_CTYPE: 'C', LANGUAGE: 'en:zh' },
      { TZ: 'UTC' },
      { OMP_NUM_THREADS: '2' },
      { OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '2' },
      { LC_ALL: 'C', TZ: 'UTC', OMP_NUM_THREADS: '2,1' },
      { NO_COLOR: '1' },
      { NO_COLOR: '' },
      { NODE_DISABLE_COLORS: '1' },
      { FORCE_COLOR: '0' },
      { FORCE_COLOR: '1' },
      { FORCE_COLOR: '3' },
      { FORCE_COLOR: 'true' },
      { PYTHONUNBUFFERED: '1' },
      { PYTHONUTF8: '1' },
      { PYTHONUTF8: '0' },
      { PYTHONIOENCODING: 'utf-8' },
      { PYTHONIOENCODING: 'UTF8:replace' },
      { PYTHONIOENCODING: 'ascii:backslashreplace' },
      { PYTHONIOENCODING: 'latin-1:strict' },
      { LC_ALL: 'C', NO_COLOR: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8:replace' }
    ]
    for (const method of ['run', 'call', 'check_call', 'check_output', 'Popen']) {
      for (const shell of [false, true]) {
        it.each(settings)(
          `keeps Python ${method} shell=${shell} passive env ordinary: %j`,
          async (env) => {
            const argv = shell ? 'echo hello' : ['echo', 'hello']
            const source = `import subprocess; subprocess.${method}(${JSON.stringify(argv)}, shell=${shell ? 'True' : 'False'}, env=${JSON.stringify(env)})`
            const risks = await analyzeNotebookCodeRisk('python', source)
            if (shell && process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
            else expect(risks).toEqual([])
          }
        )
        it.each(settings)(
          `reviews Python ${method} shell=${shell} deletion with passive env: %j`,
          async (env) => {
            const argv = shell ? 'rm target.txt' : ['rm', 'target.txt']
            expect(
              (
                await analyzeNotebookCodeRisk(
                  'python',
                  `import subprocess; subprocess.${method}(${JSON.stringify(argv)}, shell=${shell ? 'True' : 'False'}, env=${JSON.stringify(env)})`
                )
              ).length
            ).toBeGreaterThan(0)
          }
        )
      }
    }
    for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
      const shell = method === 'exec' || method === 'execSync'
      it.each(settings)(`keeps Node ${method} passive env ordinary: %j`, async (env) => {
        const source = `const cp=require('child_process'); cp.${method}(${shell ? "'echo hello'" : "'echo', ['hello']"}, {env:${JSON.stringify(env)}})`
        const risks = await analyzeNotebookCodeRisk('repl', source)
        if (shell && process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
      it.each(settings)(`reviews Node ${method} destruction with passive env: %j`, async (env) => {
        expect(
          (
            await analyzeNotebookCodeRisk(
              'repl',
              `const cp=require('child_process'); cp.${method}(${shell ? "'rm target.txt'" : "'rm', ['target.txt']"}, {env:${JSON.stringify(env)}})`
            )
          ).length
        ).toBeGreaterThan(0)
      })
    }
    it.each(settings)('keeps R system2 passive env ordinary: %j', async (env) => {
      const entries = Object.entries(env).map(([key, value]) => JSON.stringify(`${key}=${value}`))
      expect(
        await analyzeNotebookCodeRisk(
          'r',
          `system2("echo", "hello", env=c(${entries.join(',')}), stdout=TRUE)`
        )
      ).toEqual([])
    })
    it.each(settings)('reviews R system2 deletion with passive env: %j', async (env) => {
      const entries = Object.entries(env).map(([key, value]) => JSON.stringify(`${key}=${value}`))
      expect(
        (
          await analyzeNotebookCodeRisk(
            'r',
            `system2("rm", "target.txt", env=c(${entries.join(',')}))`
          )
        ).length
      ).toBeGreaterThan(0)
    })
    it.each([
      ['PYTHONUTF8', 'custom'],
      ['PYTHONUNBUFFERED', '$(rm target.txt)'],
      ['PYTHONIOENCODING', 'custom_codec'],
      ['PYTHONIOENCODING', 'utf-8:custom_handler'],
      ['PYTHONIOENCODING', 'utf-8;rm target.txt'],
      ['FORCE_COLOR', '$(rm target.txt)'],
      ['NO_COLOR', '1;rm target.txt'],
      ['NODE_DISABLE_COLORS', '1\nrm target.txt'],
      ['NO_COLOR', '%PAYLOAD%'],
      ['PYTHONUTF8', '%PAYLOAD%']
    ])(
      'distinguishes OS environment data from shell-source injection key=%s value=%s',
      async (key, value) => {
        for (const [language, source] of [
          [
            'python',
            `import subprocess;subprocess.run(["echo","hello"],env=${JSON.stringify({ [key]: value })})`
          ],
          [
            'repl',
            `const cp=require('child_process');cp.spawnSync('echo',['hello'],{env:${JSON.stringify({ [key]: value })}})`
          ],
          ['r', `system2("echo","hello",env=${JSON.stringify(key + '=' + value)},stdout=TRUE)`]
        ] as const)
          if (
            language !== 'r' &&
            ['NO_COLOR', 'NODE_DISABLE_COLORS', 'FORCE_COLOR', 'PYTHONUNBUFFERED'].includes(key)
          )
            expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
          else expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
      }
    )
    it.each([
      ['python', 'import subprocess;subprocess.run(["echo","hello"],env={"NO_COLOR":flag})'],
      ['python', 'import subprocess;subprocess.run(["echo","hello"],env={"PYTHONUTF8":True})'],
      [
        'python',
        'import subprocess;subprocess.run(["echo","hello"],env={"NO_COLOR":(os.unlink("target.txt"),"1")[1]})'
      ],
      [
        'repl',
        "const cp=require('child_process');cp.spawnSync('echo',['hello'],{env:{NO_COLOR:flag}})"
      ],
      [
        'repl',
        "const cp=require('child_process');cp.spawnSync('echo',['hello'],{env:{NO_COLOR:(require('fs').unlinkSync('target.txt'),'1')}})"
      ],
      ['r', 'system2("echo","hello",env=paste0("NO_COLOR=",flag))'],
      ['r', 'system2("echo","hello",env=c("NO_COLOR=1",unlink("target.txt")))'],
      [
        'python',
        `import os,subprocess;subprocess.run(["echo","hello"],env={"NO_COLOR":f"{os.unlink('target.txt')}"})`
      ],
      [
        'repl',
        "const cp=require('child_process');cp.spawnSync('echo',['hello'],{env:{NO_COLOR:`${require('fs').unlinkSync('target.txt')}`}})"
      ],
      [
        'repl',
        "const cp=require('child_process');cp.spawnSync('echo',['hello'],{env:{NO_COLOR:tag`value`}})"
      ]
    ] as const)(
      'retains %s dynamic output settings and eager side effects',
      async (language, source) => {
        expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
      }
    )
    it.each([
      [
        'python',
        'import subprocess;subprocess.run(["echo","hello"],env={**{"PYTHONUTF8":"1"},"NO_COLOR":"1"})'
      ],
      [
        'python',
        'import subprocess,operator;operator.call(subprocess.run,["echo","hello"],env={"PYTHONUNBUFFERED":"1"})'
      ],
      [
        'python',
        'import subprocess;subprocess.run(args=["echo","hello"],**{"env":{"PYTHONIOENCODING":"utf-8:replace"}})'
      ],
      [
        'repl',
        "const cp=require('node:child_process');cp.spawnSync('echo',['hello'],{env:{['NO_COLOR']:'1',FORCE_COLOR:0}})"
      ],
      [
        'repl',
        "const cp=require('child_process');const run=cp.spawnSync;run('echo',['hello'],{env:{FORCE_COLOR:1}})"
      ],
      [
        'r',
        'base::system2(command="echo",args="hello",env=base::c("NO_COLOR=1","PYTHONUTF8=1"),stdout=TRUE)'
      ],
      ['r', 'do.call(base::system2,list("echo",args="hello",env="NO_COLOR=1",stdout=TRUE))']
    ] as const)(
      'keeps %s literal output settings through argument forwarding',
      async (language, source) => {
        expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
      }
    )
    for (const [language, env] of [
      ['python', '{**{"NO_COLOR":"1"},**{"PYTHONUTF8":"1"}}'],
      ['python', '{**({"PYTHONIOENCODING":"utf-8"}),"NO_COLOR":"1"}'],
      ['python', '{**{**{"NO_COLOR":"1"}},"PYTHONUNBUFFERED":"1"}'],
      ['repl', "{...{NO_COLOR:'1'},...{FORCE_COLOR:1}}"],
      ['repl', "{...({NO_COLOR:'1'}),PYTHONUTF8:'1'}"],
      ['repl', "{...{...{NO_COLOR:'1'}},PYTHONIOENCODING:'utf-8'}"]
    ] as const) {
      for (const command of ['echo', 'rm']) {
        it(`checks ${language} literal environment expansion command=${command} env=${env}`, async () => {
          const source =
            language === 'python'
              ? `import subprocess;subprocess.run(["${command}","target.txt"],env=${env})`
              : `const cp=require('child_process');cp.spawnSync('${command}',['target.txt'],{env:${env}})`
          const risks = await analyzeNotebookCodeRisk(language, source)
          if (command === 'echo') expect(risks).toEqual([])
          else expect(risks.length).toBeGreaterThan(0)
        })
      }
    }
    it.each([
      ['python', '{**settings,"NO_COLOR":"1"}'],
      ['python', '{**{"LD_PRELOAD":"module"},"NO_COLOR":"1"}'],
      ['python', '{**{"NO_COLOR":value}}'],
      ['python', '{**{key:"1"}}'],
      ['python', '{**factory()}'],
      ['repl', "{...settings,NO_COLOR:'1'}"],
      ['repl', "{...{NODE_OPTIONS:'--require=module'},NO_COLOR:'1'}"],
      ['repl', '{...{NO_COLOR:value}}'],
      ['repl', "{...{[key]:'1'}}"],
      ['repl', '{...factory()}'],
      ['repl', "{...{get NO_COLOR(){return '1'}}}"],
      ['repl', "{...{get NO_COLOR(){require('fs').unlinkSync('target.txt');return '1'}}}"]
    ] as const)(
      'retains %s unknown/loading/getter environment expansions: %s',
      async (language, env) => {
        const source =
          language === 'python'
            ? `import subprocess;subprocess.run(["echo","hello"],env=${env})`
            : `const cp=require('child_process');cp.spawnSync('echo',['hello'],{env:${env}})`
        expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
      }
    )
    it('bounds deeply nested literal environment expansion', async () => {
      for (const language of ['python', 'repl'] as const) {
        let env = language === 'python' ? '{"NO_COLOR":"1"}' : "{NO_COLOR:'1'}"
        for (let depth = 0; depth < 65; depth++)
          env = language === 'python' ? `{**${env}}` : `{...${env}}`
        const source =
          language === 'python'
            ? `import subprocess;subprocess.run(["echo","hello"],env=${env})`
            : `const cp=require('child_process');cp.spawnSync('echo',['hello'],{env:${env}})`
        expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
      }
    })
    for (const key of [
      'PATH',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ENV',
      'NODE_OPTIONS',
      'PYTHONPATH',
      'R_PROFILE',
      'OMP_TOOL_LIBRARIES',
      'GIT_EXTERNAL_DIFF',
      'LOCPATH',
      'UNKNOWN'
    ]) {
      it(`retains ${key} environment uncertainty in all three languages`, async () => {
        const env = JSON.stringify({ [key]: 'custom' })
        for (const [language, source] of [
          ['python', `import subprocess; subprocess.run(["echo", "hello"], env=${env})`],
          [
            'repl',
            `const cp=require('child_process'); cp.spawnSync('echo', ['hello'], {env:${env}})`
          ],
          ['r', `system2("echo", "hello", env="${key}=custom")`]
        ] as const)
          expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
      })
    }
    it.each([
      [
        'python',
        'import subprocess; subprocess.run(["echo", "hello"], env={**settings, "LC_ALL":"C"})'
      ],
      ['python', 'import subprocess; subprocess.run(["echo", "hello"], env={key:"C"})'],
      ['python', 'import subprocess; subprocess.run(["echo", "hello"], env={"LC_ALL":locale})'],
      [
        'python',
        'import subprocess; subprocess.run(["echo", "hello"], env={"LC_ALL":"C"}, preexec_fn=cleanup)'
      ],
      [
        'repl',
        "const cp=require('child_process'); cp.spawnSync('echo', ['hello'], {env:{...process.env,LC_ALL:'C'}})"
      ],
      [
        'repl',
        "const cp=require('child_process'); cp.spawnSync('echo', ['hello'], {env:{[key]:'C'}})"
      ],
      [
        'repl',
        "const cp=require('child_process'); cp.spawnSync('echo', ['hello'], {env:{get LC_ALL(){return locale}}})"
      ],
      [
        'repl',
        "const cp=require('child_process'); cp.execFile('echo',['hello'],{env:{LC_ALL:'C'}},()=>require('fs').unlinkSync('target.txt'))"
      ],
      ['r', 'system2("echo", "hello", env=environment)'],
      ['r', 'system2("echo", "hello", env="LC_ALL=C; rm target.txt")'],
      ['r', 'system2("echo", "hello", env="TZ=$(rm target.txt)")'],
      ['r', 'system2("echo", "hello", env="OMP_NUM_THREADS=2 rm target.txt;")']
    ] as const)('retains %s dynamic environment/effects: %s', async (language, source) => {
      expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
    })
    it.each([
      ['python', 'import subprocess; subprocess.run(["echo","hello"], **{"env":{"LC_ALL":"C"}})'],
      ['python', 'import subprocess; subprocess.run(["echo","hello"], env=({"TZ":"UTC"}))'],
      [
        'repl',
        "const cp=require('child_process'); cp.spawnSync('echo',['hello'],{env:({['LC_ALL']:'C'})})"
      ],
      ['r', 'base::system2(env="LC_ALL=C", args="hello", command="echo", stdout=TRUE)'],
      ['r', 'system2(comm="echo", ar="hello", en="LC_ALL=C")']
    ] as const)('supports %s fixed environment argument forms: %s', async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
    })
  })
  describe('process wrapper command roles', () => {
    const routes = [
      ['bash', (argv: string[]) => argv.map((arg) => `'${arg}'`).join(' ')],
      [
        'python',
        (argv: string[]) => `import subprocess; subprocess.run(${JSON.stringify(argv)}, check=True)`
      ],
      [
        'python',
        (argv: string[]) =>
          `import subprocess; subprocess.getoutput(${JSON.stringify(argv.map((arg) => `'${arg}'`).join(' '))})`
      ],
      [
        'repl',
        (argv: string[]) =>
          `const cp=require('child_process'); cp.spawnSync(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))})`
      ],
      [
        'repl',
        (argv: string[]) =>
          `const cp=require('child_process'); cp.execSync(${JSON.stringify(argv.map((arg) => `'${arg}'`).join(' '))})`
      ],
      [
        'r',
        (argv: string[]) =>
          `system2(${JSON.stringify(argv[0])}, c(${argv
            .slice(1)
            .map((arg) => JSON.stringify(arg))
            .join(',')}))`
      ],
      [
        'r',
        (argv: string[]) =>
          `system(${JSON.stringify(argv.map((arg) => `'${arg}'`).join(' '))}, intern=TRUE)`
      ]
    ] as const
    const prefixes = [
      ['nice'],
      ['nice', '-n', '5'],
      ['nice', '-n+5'],
      ['nice', '-n-5'],
      ['nice', '--adjustment=5'],
      ['nice', '--adjustment', '-5'],
      ['nice', '-5'],
      ['nice', '--5'],
      ['nice', '-+5'],
      ['nice', '--'],
      ['nice', '-n', '5', '--'],
      ['gnice', '-n', '5'],
      ['nohup'],
      ['nohup', '--'],
      ['gnohup', '--'],
      ['timeout', '5'],
      ['timeout', '--foreground', '0.5s'],
      ['timeout', '-pvf', '1e1s'],
      ['timeout', '-k', '1s', '-s', 'TERM', '5s'],
      ['timeout', '-vk1s', '-sTERM', '5m'],
      ['timeout', '--signal=SIGTERM', '--kill-after=1s', '5h'],
      ['timeout', '--signal', '9', '--kill-after', '1s', '--', '5d'],
      ['gtimeout', '--preserve-status', '0'],
      ['nice', '-n', '5', 'nohup', '--'],
      ['nohup', 'nice', '-n', '5'],
      ['gtimeout', '-s', 'TERM', '5', 'gnice', '-n', '5', 'gnohup']
    ]
    for (const [language, route] of routes) {
      const sample = route(['echo', 'hello'])
      const shellRoute =
        sample.includes('getoutput') ||
        sample.includes('execSync') ||
        (language === 'r' && sample.startsWith('system('))
      it.each(prefixes.map((prefix) => [prefix]))(
        `keeps ${language} wrapped read/data ordinary: %j`,
        async (prefix) => {
          for (const payload of [
            ['echo', 'rm', '--help'],
            ['cat', 'file.txt']
          ]) {
            const risks = await analyzeNotebookCodeRisk(language, route([...prefix, ...payload]))
            if (process.platform === 'win32' && (shellRoute || prefix.includes('timeout')))
              expect(risks.length).toBeGreaterThan(0)
            else expect(risks).toEqual([])
          }
        }
      )
      it.each(prefixes.map((prefix) => [prefix]))(
        `reviews ${language} wrapped destruction: %j`,
        async (prefix) => {
          for (const payload of [
            ['rm', 'file.txt'],
            ['sed', '-i', 's/a/b/', 'file.txt'],
            ['tee', 'file.txt']
          ])
            expect(
              (await analyzeNotebookCodeRisk(language, route([...prefix, ...payload]))).length
            ).toBeGreaterThan(0)
        }
      )
      it.each(
        [
          ['nice', '-n', 'rm', 'echo', 'hello'],
          ['nice', '--unknown', 'echo', 'hello'],
          ['nohup', '-n', 'echo', 'hello'],
          ['timeout', '-k', 'rm', '5', 'echo', 'hello'],
          ['timeout', '-s', 'rm', '5', 'echo', 'hello'],
          ['gtimeout', 'duration', 'echo', 'hello'],
          ['gtimeout', '--unknown', '5', 'echo', 'hello'],
          ['nice', 'bash', '-c', 'rm file.txt'],
          ['nohup', 'cleanup.sh', '--help'],
          ['nice', 'python', '-c', 'print(1)', '--help'],
          ['nice', 'env', 'LD_PRELOAD=library.so', 'echo', 'hello']
        ].map((argv) => [argv])
      )(`retains ${language} wrapper uncertainty: %j`, async (argv) => {
        expect((await analyzeNotebookCodeRisk(language, route(argv))).length).toBeGreaterThan(0)
      })
    }
    it.each([
      'nice -n "$level" echo hello',
      'nohup "$program" hello',
      'timeout "$duration" echo hello',
      'gtimeout -s "$signal" 5 echo hello',
      'nice echo "$(rm file.txt)"',
      'nohup cat file.txt > output.txt',
      'nice -n 5 env LD_PRELOAD=library.so echo hello'
    ])('preserves dynamic/effect evidence: %s', async (source) => {
      expect((await analyzeNotebookCodeRisk('bash', source)).length).toBeGreaterThan(0)
    })
    it('keeps niceness query ordinary', async () => {
      expect(await analyzeNotebookCodeRisk('bash', 'nice')).toEqual([])
    })
    it('bounds recursive wrapper inspection', async () => {
      expect(
        (await analyzeNotebookCodeRisk('bash', `${'nice '.repeat(80)}echo hello`)).length
      ).toBeGreaterThan(0)
      expect(
        (await analyzeNotebookCodeRisk('bash', `${'env '.repeat(80)}echo hello`)).length
      ).toBeGreaterThan(0)
    })
    it('does not apply GNU timeout semantics to Windows native timeout', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
      try {
        Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              'import subprocess; subprocess.run(["timeout", "5", "echo", "hello"])'
            )
          ).length
        ).toBeGreaterThan(0)
      } finally {
        Object.defineProperty(process, 'platform', descriptor)
      }
    })
  })
  describe('survey-derived Git command roles', () => {
    const routes = [
      [
        'bash',
        (args: string[]) =>
          ['git', ...args].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')
      ],
      [
        'python',
        (args: string[]) =>
          `import subprocess; subprocess.run(${JSON.stringify(['git', ...args])}, check=True)`
      ],
      [
        'python',
        (args: string[]) =>
          `import subprocess; subprocess.getoutput(${JSON.stringify(['git', ...args].map((arg) => `'${arg}'`).join(' '))})`
      ],
      [
        'repl',
        (args: string[]) =>
          `const cp=require('child_process'); cp.spawnSync('git', ${JSON.stringify(args)})`
      ],
      [
        'repl',
        (args: string[]) =>
          `const cp=require('child_process'); cp.execSync(${JSON.stringify(['git', ...args].map((arg) => `'${arg}'`).join(' '))})`
      ],
      [
        'r',
        (args: string[]) => `system2("git", c(${args.map((arg) => JSON.stringify(arg)).join(',')}))`
      ],
      [
        'r',
        (args: string[]) =>
          `system(${JSON.stringify(['git', ...args].map((arg) => `'${arg}'`).join(' '))}, intern=TRUE)`
      ]
    ] as const
    const ordinary = [
      ['restore', '--staged', '--', 'data.csv'],
      ['restore', '-S', 'data.csv'],
      ['restore', 'data.csv', '--staged'],
      ['restore', '-qS', 'data.csv'],
      ['restore', '-SW', '--no-worktree', 'data.csv'],
      ['restore', '-S', '--', '--worktree'],
      ['restore', '--source', 'HEAD', '--staged', 'data.csv'],
      ['restore', '-sHEAD', '-S', 'data.csv'],
      ['restore', '-S', '--pathspec-from-file=paths.txt'],
      ['branch', '--list', '--', '-D'],
      ['branch', '--format', '-D'],
      ['branch', '--sort=-D'],
      ['branch', '-d', '--no-delete', '--list'],
      ['branch', '--contains', 'HEAD'],
      ['branch', '-u', 'origin/main', 'topic'],
      ['branch', '-c', 'topic', 'copy'],
      ['stash', 'list', '--grep=drop'],
      ['stash', 'show'],
      ['stash', 'save', 'clear'],
      ['clean', '-fdxn', '--', 'data.csv'],
      ['clean', '-e', '-f', '--dry-run'],
      ['reset', '--soft', 'HEAD~1'],
      ['diff', '--', 'restore', '--staged']
    ]
    const risky = [
      ['restore', '--', 'data.csv'],
      ['restore', '-SW', 'data.csv'],
      ['restore', '--staged', '--worktree', 'data.csv'],
      ['restore', '--staged', '--no-staged', 'data.csv'],
      ['restore', '-s', '--staged', 'data.csv'],
      ['restore', '--source', '--staged', 'data.csv'],
      ['restore', '--pathspec-from-file', '--staged'],
      ['restore', '--', '--staged'],
      ['restore', '--staged', '--unknown', 'data.csv'],
      ['restore', '--pathspec-from-file=-S', 'data.csv'],
      ['restore', '-S', '--conflict', '--worktree', '-W', 'data.csv'],
      ['branch', '-d', 'topic'],
      ['branch', '-D', 'topic'],
      ['branch', '-vd', 'topic'],
      ['branch', '--delete', 'topic'],
      ['branch', '--force', 'topic', 'HEAD'],
      ['branch', '-M', 'topic', 'main'],
      ['branch', '-C', 'topic', 'main'],
      ['branch', '--format=-D', '--delete', 'topic'],
      ['branch', '--contains', '-D', 'topic'],
      ['branch', '--no-delete', '-D', 'topic'],
      ['branch', '--abbrev', '-D', 'topic'],
      ['branch', '-uorigin/main', '-D', 'topic'],
      ['stash', 'drop', 'stash@{0}'],
      ['stash', 'clear'],
      ['clean', '-fdx', '--', '--dry-run'],
      ['clean', '-fe', '--dry-run'],
      ['reset', '--hard', 'HEAD'],
      ['checkout', '--', 'data.csv']
    ]
    for (const [language, route] of routes) {
      const shellRoute =
        route(['status']).includes('getoutput') ||
        route(['status']).includes('execSync') ||
        (language === 'r' && route(['status']).startsWith('system('))
      it.each(ordinary.map((args) => [args]))(
        `keeps ${language} Git preview/index/data ordinary: %j`,
        async (args) => {
          const risks = await analyzeNotebookCodeRisk(language, route(args))
          if (shellRoute && process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        }
      )
      it.each(risky.map((args) => [args]))(
        `reviews ${language} Git destruction/uncertainty: %j`,
        async (args) => {
          expect((await analyzeNotebookCodeRisk(language, route(args))).length).toBeGreaterThan(0)
        }
      )
    }
  })
  it.each([
    'git restore -S $options data.csv',
    'git restore -S -- "$(rm target.txt)"',
    'git branch $options',
    'git stash $operation',
    'git -C repo restore --staged --worktree data.csv',
    'git branch --format "$(rm target.txt)"'
  ])('retains dynamic/substituted Git effect evidence: %s', async (source) => {
    expect((await analyzeNotebookCodeRisk('bash', source)).length).toBeGreaterThan(0)
  })
  describe('fixed shell command source evidence', () => {
    it('retains review on Windows rather than assuming Bash semantics', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
      try {
        Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
        expect(
          await analyzeNotebookCodeRisk(
            'python',
            'import subprocess; subprocess.getoutput("echo hello")'
          )
        ).toEqual([expect.objectContaining({ operation: 'subprocess.getoutput nested execution' })])
      } finally {
        Object.defineProperty(process, 'platform', descriptor)
      }
    })
    it.each([
      [
        'python',
        'from subprocess import getoutput as read\ndef output():\n    return read("echo hello")',
        'print(output())'
      ],
      [
        'repl',
        "const cp=require('child_process'); const read=cp.execSync; function output(){return read('echo hello').toString()}",
        'console.log(output())'
      ],
      [
        'r',
        'read <- base::system; output <- function() read("echo hello", intern=TRUE)',
        'print(output())'
      ]
    ] as const)('replays %s fixed output wrapper evidence', async (language, previous, source) => {
      const risks = await analyzeNotebookCodeRisk(language, source, undefined, [previous])
      if (process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
      else expect(risks).toEqual([])
    })
    it.each([
      'print(' +
        Array.from({ length: 64 }, (_, i) => `"example${i}"`).join(',') +
        ')\nimport subprocess; subprocess.getoutput("echo hello")',
      'import subprocess; subprocess.getoutput("echo ' + 'a'.repeat(64001) + '")'
    ])('keeps excessive literal probes reviewable', async (source) => {
      expect((await analyzeNotebookCodeRisk('python', source)).length).toBeGreaterThan(0)
    })
    it('does not let unrelated history literals crowd out the current command', async () => {
      const previous =
        'print(' + Array.from({ length: 64 }, (_, i) => `"example${i}"`).join(',') + ')'
      const risks = await analyzeNotebookCodeRisk(
        'python',
        'import subprocess; subprocess.getoutput("echo hello")',
        undefined,
        [previous]
      )
      if (process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
      else expect(risks).toEqual([])
    })
    const routes = [
      ['python', (script: string) => `import os; os.system(${JSON.stringify(script)})`],
      [
        'python',
        (script: string) => `import os; print(os.popen(${JSON.stringify(script)}).read())`
      ],
      [
        'python',
        (script: string) =>
          `import subprocess; print(subprocess.getoutput(${JSON.stringify(script)}))`
      ],
      [
        'python',
        (script: string) =>
          `from subprocess import getstatusoutput as read; print(read(${JSON.stringify(script)}))`
      ],
      [
        'python',
        (script: string) =>
          `import subprocess; subprocess.run(${JSON.stringify(script)}, shell=True, check=True, capture_output=True, text=True)`
      ],
      [
        'repl',
        (script: string) =>
          `const cp=require('child_process'); console.log(cp.execSync(${JSON.stringify(script)}, {encoding:'utf8'}).trim())`
      ],
      [
        'repl',
        (script: string) =>
          `const cp=require('child_process'); cp.exec(${JSON.stringify(script)}, console.log)`
      ],
      [
        'repl',
        (script: string) =>
          `const cp=require('child_process'); const read=cp.execSync.bind(null); read(${JSON.stringify(script)})`
      ],
      ['r', (script: string) => `print(system(${JSON.stringify(script)}, intern=TRUE))`],
      [
        'r',
        (script: string) =>
          `read <- base::system; read(command=${JSON.stringify(script)}, intern=TRUE)`
      ]
    ] as const
    for (const [language, route] of routes) {
      it.each([
        'echo hello',
        'printf hello | wc -c',
        'cat data.txt',
        'head -n 3 data.txt',
        'git status --short',
        'find . -name data.txt',
        "echo 'rm target.txt'",
        "echo '$(rm target.txt)'",
        'echo hello && pwd',
        'echo hello > /dev/null'
      ])(`keeps ${language} fixed shell output/read ordinary: %s`, async (script) => {
        const risks = await analyzeNotebookCodeRisk(language, route(script))
        if (process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
        else expect(risks).toEqual([])
      })
      it.each([
        'rm -- target.txt',
        'find . -delete',
        'git reset --hard',
        'echo hello > target.txt',
        'echo $(rm target.txt)',
        'echo hello; rm target.txt',
        'sh -c command',
        '${program} target.txt',
        'echo "',
        'alias erase=rm; erase target.txt',
        'trap "rm target.txt" EXIT; echo hello',
        'LD_PRELOAD=module echo hello',
        'env echo hello'
      ])(`reviews ${language} destructive or unresolved shell source: %s`, async (script) => {
        expect((await analyzeNotebookCodeRisk(language, route(script))).length).toBeGreaterThan(0)
      })
    }
    it.each([
      [
        'python',
        'import subprocess\ndef read():\n    return subprocess.getoutput("echo hello")\nprint(read())'
      ],
      [
        'repl',
        "const cp=require('child_process'); function read(){return cp.execSync('echo hello').toString()} console.log(read())"
      ],
      ['r', 'read <- function() system("echo hello", intern=TRUE); print(read())']
    ] as const)('keeps %s named output wrappers ordinary', async (language, source) => {
      const risks = await analyzeNotebookCodeRisk(language, source)
      if (process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
      else expect(risks).toEqual([])
    })
    it.each([
      "const cp=require('child_process'); const fs=require('fs'); function done(){fs.unlinkSync(path)} cp.exec('echo hello', done)",
      "const cp=require('child_process'); const fs=require('fs'); function done(){fs.unlinkSync(path)} cp.exec('echo hello', {}, done)"
    ])('retains completion deletion beside ordinary shell output: %s', async (source) => {
      expect(
        (await analyzeNotebookCodeRisk('repl', source)).some((risk) =>
          risk.operation.includes('unlinkSync')
        )
      ).toBe(true)
    })
    it.each([
      ['python', 'import subprocess; subprocess.run("echo hello", shell=True, env=env)'],
      ['python', 'import subprocess; subprocess.run("echo hello", shell=True, executable=program)'],
      ['python', 'import subprocess; subprocess.run("echo hello", shell=True, preexec_fn=cleanup)'],
      ['python', 'import subprocess; subprocess.getoutput(command)'],
      ['repl', "const cp=require('child_process'); cp.exec('echo hello', {shell:'/custom/shell'})"],
      ['repl', "const cp=require('child_process'); cp.exec('echo hello', {env:environment})"],
      ['repl', "const cp=require('child_process'); cp.exec('echo hello', options)"],
      ['r', 'system(command, intern=TRUE)'],
      ['r', 'system("echo hello", ...)']
    ] as const)('retains %s unknown process options: %s', async (language, source) => {
      expect((await analyzeNotebookCodeRisk(language, source)).length).toBeGreaterThan(0)
    })
  })
  describe('direct process argv across languages', () => {
    it.each([
      "const cp=require('child_process'); cp.spawn('echo', null, {shell:null,env:null})",
      "const cp=require('child_process'); cp.execFile('echo', ['hello'], null, console.log)",
      "const cp=require('child_process'); cp.execFileSync('echo', ['hello'], null).toString().trim()",
      "const cp=require('child_process'); cp.spawnSync('echo', ['hello']).stdout.toString().trim()"
    ])('keeps literal defaults and result readers ordinary: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([])
    })
    it.each([
      'system2("echo", character(0), env=NULL)',
      'system2("echo", NULL, env=c(), stdout=TRUE)',
      'system2("echo", character(length=0), stderr=NULL)'
    ])('keeps known empty R vectors ordinary: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('r', source)).toEqual([])
    })
    it.each([
      "const cp=require('child_process'); cp.spawn.apply(null, packed)",
      "const cp=require('child_process'); ['echo'].map(cp.spawnSync)",
      "const cp=require('child_process'); cp.execSync('rm target.txt')",
      "const cp=require('child_process'); cp.execFile('script.js', ['--help'])"
    ])('retains opaque, shell and script execution review: %s', async (source) => {
      expect(
        (await analyzeNotebookCodeRisk('repl', source)).some((risk) =>
          risk.operation.includes('nested execution')
        )
      ).toBe(true)
    })
    it.each([
      "const cp=require('child_process'); cp.execFile('echo', ['hello'], factory())",
      "const cp=require('child_process'); cp.execFile('echo', ['hello'], {}, factory())"
    ])('does not discard unknown completion callbacks: %s', async (source) => {
      expect(
        (await analyzeNotebookCodeRisk('repl', source)).some((risk) =>
          /nested execution|dynamic callback/.test(risk.operation)
        )
      ).toBe(true)
    })
    it('reconstructs process/callback aliases from prior source', async () => {
      const previous =
        "const cp=require('child_process'); const fs=require('fs'); const launch=cp.execFile; function cleanup(){fs.unlinkSync(path)} const done=cleanup; cleanup=console.log"
      expect(
        (
          await analyzeNotebookCodeRisk('repl', "launch('echo', ['hello'], done)", undefined, [
            previous
          ])
        ).some((risk) => risk.operation.includes('unlinkSync'))
      ).toBe(true)
    })
    const methods = ['spawn', 'spawnSync', 'execFile', 'execFileSync']
    const routes = [
      (method: string, args: string) =>
        `const cp = require('node:child_process'); cp.${method}(${args})`,
      (method: string, args: string) =>
        `import { ${method} as launch } from 'child_process'; launch(${args})`,
      (method: string, args: string) =>
        `const cp = require('child_process'); const launch = cp.${method}.bind(null); launch(${args})`
    ]
    for (const method of methods)
      for (const route of routes) {
        it.each([
          "'echo', ['hello']",
          "'echo', ['rm -rf target']",
          "'echo', [message]",
          "'echo'",
          "'echo', { shell: false }",
          "'echo', ['hello'], { shell: false, encoding: 'utf8' }",
          "'cat', [path]",
          "'git', ['status', '--short']",
          "'find', ['.', '-name', '*.txt']",
          "'rm', ['--help']",
          "'printf', ['%s', 'hello']",
          "'echo', (['hello']), ({ ['shell']: (false) })"
        ])(`keeps ${method} ordinary argv prompt-free: %s`, async (args) => {
          expect(await analyzeNotebookCodeRisk('repl', route(method, args))).toEqual([])
        })
        it.each([
          "'rm', ['--', path]",
          "'find', ['.', '-delete']",
          "'git', ['reset', '--hard']",
          "'bash', ['-c', code]",
          "'node', ['-e', code]",
          "program, ['hello']",
          "'echo', argumentsList",
          "'echo', ['hello'], { shell: true }",
          "'echo', ['hello'], { shell: mode }",
          "'echo', ['hello'], { env: environment }",
          "'echo', ['hello'], options",
          "'echo', ['hello'], { ...options }",
          "'echo', [...argumentsList]",
          "'echo', ['hello'], { get shell() { return false } }",
          "'echo', ['hello'], { __proto__: options }",
          "'echo', ['hello'], { [key]: value }"
        ])(`reviews ${method} destructive/uncertain argv: %s`, async (args) => {
          expect(await analyzeNotebookCodeRisk('repl', route(method, args))).toEqual([
            expect.objectContaining({ operation: expect.stringContaining('nested execution') })
          ])
        })
      }
    const rRoutes = [
      (args: string) => `system2(${args})`,
      (args: string) => `base::system2(${args})`,
      (args: string) => `launch <- base::system2; launch(${args})`
    ]
    for (const route of rRoutes) {
      it.each([
        '"echo", "hello"',
        '"echo", c("hello", "world"), stdout=TRUE',
        '"echo"',
        '"echo", args=character(), stderr=FALSE',
        'command="echo", args=c("hello world"), stdout=TRUE',
        'comm="echo", ar=c("hello"), stdou=TRUE',
        'args=c("hello"), command="echo", stderr=NULL',
        '"git", c("status", "--short")',
        '"find", c(".", "-name", "data.txt")',
        '"echo", base::c("hello"), env=base::character()'
      ])('keeps R ordinary system2 output prompt-free: %s', async (args) => {
        expect(await analyzeNotebookCodeRisk('r', route(args))).toEqual([])
      })
      it.each([
        '"rm", c("--", "target")',
        '"find", c(".", "-delete")',
        '"git", "reset --hard"',
        '"sh", c("-c", "code")',
        'command, "hello"',
        '"echo", args=arguments',
        '"echo", "hello; rm target"',
        '"echo", "$(rm target)"',
        '"echo", "hello > target"',
        '"echo", "hello\\nrm target"',
        '"echo", "hello", env=c("LD_PRELOAD=module")',
        '"echo", "hello", stdout="target.txt"',
        '"echo", "hello", stderr="target.txt"',
        '"echo", "hello", ...',
        '"echo", c(... )',
        '"echo", c("hello"), std=TRUE'
      ])('reviews R destructive/uncertain system2 dispatch: %s', async (args) => {
        expect(await analyzeNotebookCodeRisk('r', route(args))).toEqual([
          expect.objectContaining({ operation: expect.stringContaining('nested execution') })
        ])
      })
    }
    it.each(['execFile', 'execFileSync', 'spawn', 'spawnSync'])(
      'retains eager argument deletion beside ordinary %s',
      async (method) => {
        expect(
          await analyzeNotebookCodeRisk(
            'repl',
            `const cp=require('child_process'); const fs=require('fs'); cp.${method}('echo', [fs.unlinkSync(path)])`
          )
        ).toEqual([expect.objectContaining({ operation: 'fs.unlinkSync' })])
      }
    )
    it.each([
      "const cp=require('child_process'); cp.execFile('echo', ['hello'], console.log)",
      "const cp=require('child_process'); cp.execFile('echo', console.log)",
      "const cp=require('child_process'); function done(e,out){console.log(out)} cp.execFile('echo', ['hello'], {encoding:'utf8'}, done)",
      "const cp=require('child_process'); cp.spawn.call(null, 'echo', ['hello'])",
      "const cp=require('child_process'); cp.spawn.apply(null, ['echo', ['hello']])",
      "const cp=require('child_process'); Reflect.apply(cp.execFileSync, null, ['echo', ['hello']])"
    ])('normalizes process overloads and explicit invocation: %s', async (source) => {
      expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([])
    })
    it.each([
      "const cp=require('child_process'); const fs=require('fs'); function done(){fs.unlinkSync(path)} cp.execFile('echo', ['hello'], done)",
      "const cp=require('child_process'); const fs=require('fs'); function done(){fs.unlinkSync(path)} cp.execFile('echo', done)",
      "const cp=require('child_process'); const fs=require('fs'); function done(){fs.unlinkSync(path)} cp.execFile('echo', ['hello'], {}, done)"
    ])('reviews completion callback effects after ordinary execution: %s', async (source) => {
      expect(
        (await analyzeNotebookCodeRisk('repl', source)).some((risk) =>
          risk.operation.includes('unlinkSync')
        )
      ).toBe(true)
    })
    it('does not trust a rebound R vector constructor', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'r',
          'c <- function(...) "hello; rm target"; system2("echo", c("hello"))'
        )
      ).toEqual([expect.objectContaining({ operation: 'system2 nested execution' })])
    })
  })
  describe('Python subprocess command semantics', () => {
    const methods = ['run', 'call', 'check_call', 'check_output', 'Popen']
    const routes = [
      (method: string, call: string) => `import subprocess\nsubprocess.${method}(${call})`,
      (method: string, call: string) =>
        `from subprocess import ${method} as launch\nlaunch(${call})`,
      (method: string, call: string) =>
        `import subprocess as process\nlaunch = process.${method}\nlaunch(${call})`
    ]
    for (const method of methods)
      for (const route of routes) {
        it.each([
          '["echo", "hello"]',
          '["echo", "rm -rf -- /not-a-command"]',
          '["echo", message], shell=False',
          '["printf", "%s", "hello"]',
          '["cat", path]',
          '["ls", "-l"]',
          '["rm", "--help"]',
          '["git", "status", "--short"]',
          '["find", ".", "-name", "*.txt"]',
          'args=["echo", "hello"], shell=False',
          '**{"args": ["echo", "hello"], "shell": False}',
          '["rm", "hello"], executable="/bin/echo"'
        ])(`keeps ${method} ordinary argv prompt-free: %s`, async (args) => {
          expect(await analyzeNotebookCodeRisk('python', route(method, args))).toEqual([])
        })
        it.each([
          '["echo", "hello"], shell=True',
          '["echo", "hello"], -1, None, None, None, None, None, True, True'
        ])(`inspects ${method} shell command rather than positional data: %s`, async (args) => {
          const risks = await analyzeNotebookCodeRisk('python', route(method, args))
          if (process.platform === 'win32') expect(risks.length).toBeGreaterThan(0)
          else expect(risks).toEqual([])
        })
        it.each([
          '["rm", "--", path]',
          '["find", ".", "-delete"]',
          '["git", "reset", "--hard"]',
          '["bash", "-c", "rm -- target"]',
          '["python", "-c", code]',
          'command',
          '[program, "hello"]',
          '["rm target.txt"], shell=True',
          '["echo", "hello"], shell=use_shell',
          '["echo", "hello"], executable=program',
          '["echo", path], executable="/bin/rm"',
          '["echo", "hello"], preexec_fn=cleanup',
          '["echo", "hello"], env=environment',
          '["echo", "hello"], **options',
          '["echo", *arguments]',
          '["echo", "hello"], -1, "/bin/rm"',
          '["rm target.txt"], -1, None, None, None, None, None, True, True'
        ])(`reviews ${method} destructive/uncertain dispatch: %s`, async (args) => {
          expect(await analyzeNotebookCodeRisk('python', route(method, args))).toEqual([
            expect.objectContaining({ operation: `subprocess.${method} nested execution` })
          ])
        })
      }
    it('keeps check=True ordinary echo prompt-free and still inspects eager arguments', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'import subprocess; subprocess.run(["echo", "hello"], check=True)'
        )
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'import subprocess, os; subprocess.run(["echo", os.unlink(path)], check=True)'
        )
      ).toEqual([expect.objectContaining({ operation: 'os.unlink' })])
    })
  })
  describe('loop and exception callable flow', () => {
    const cases = [
      {
        language: 'python' as const,
        prelude:
          'import os\ndef reader(path):\n    return open(path).read()\ndef other(path):\n    return os.path.getsize(path)\n',
        danger: 'os.unlink',
        routes: ['selected(path)', 'saved = selected\nsaved(path)', 'list(map(selected, [path]))'],
        loops: [
          'selected = DANGER\nfor item in []:\n    selected = reader\nCALLSITE',
          'selected = DANGER\nfor item in items:\n    selected = reader\nCALLSITE',
          'selected = reader\nfor item in [0, 1]:\n    CALLSITE\n    selected = DANGER',
          'selected = reader\ncount = 0\nwhile count < 2:\n    CALLSITE\n    selected = DANGER\n    count += 1',
          'for selected in [reader, DANGER]:\n    CALLSITE',
          'selected = DANGER\nwhile False:\n    selected = reader\nCALLSITE',
          'selected = reader\nfor item in [0]:\n    selected = DANGER\nCALLSITE'
        ]
      },
      {
        language: 'repl' as const,
        prelude:
          'const fs = require("node:fs"); function reader(path) { return fs.readFileSync(path) } function other(path) { return fs.statSync(path) } let selected;\n',
        danger: 'fs.unlinkSync',
        routes: [
          'selected(path)',
          'const saved = selected; saved(path)',
          '[path].map(selected)',
          'selected.call(null, path)',
          'Reflect.apply(selected, null, [path])'
        ],
        loops: [
          'selected = DANGER; for (const item of []) { selected = reader; } CALLSITE',
          'selected = DANGER; for (const item of items) { selected = reader; } CALLSITE',
          'selected = reader; for (const item of [0, 1]) { CALLSITE; selected = DANGER; }',
          'selected = reader; let count = 0; while (count < 2) { CALLSITE; selected = DANGER; count++; }',
          'for (selected of [reader, DANGER]) { CALLSITE; }',
          'selected = DANGER; while (false) { selected = reader; } CALLSITE',
          'selected = reader; for (const item of [0]) { selected = DANGER; } CALLSITE',
          'selected = DANGER; for (let item = 0; false; item++) { selected = reader; } CALLSITE'
        ]
      },
      {
        language: 'r' as const,
        prelude:
          'reader <- function(path) readLines(path)\nother <- function(path) file.info(path)\n',
        danger: 'unlink',
        routes: ['selected(path)', 'saved <- selected; saved(path)', 'lapply(c(path), selected)'],
        loops: [
          'selected <- DANGER\nfor (item in list()) { selected <- reader }\nCALLSITE',
          'selected <- DANGER\nfor (item in items) { selected <- reader }\nCALLSITE',
          'selected <- reader\nfor (item in list(0, 1)) { CALLSITE; selected <- DANGER }',
          'selected <- reader\ncount <- 0\nwhile (count < 2) { CALLSITE; selected <- DANGER; count <- count + 1 }',
          'for (selected in list(reader, DANGER)) { CALLSITE }',
          'selected <- DANGER\nwhile (FALSE) { selected <- reader }\nCALLSITE',
          'selected <- reader\nfor (item in list(0)) { selected <- DANGER }\nCALLSITE'
        ]
      }
    ]
    for (const entry of cases)
      for (const loop of entry.loops)
        for (const route of entry.routes)
          for (const history of [false, true]) {
            for (const risky of [false, true])
              it(`${entry.language} loop ${risky ? 'deletion' : 'reader'} (${history ? 'history' : 'cell'}): ${loop} -> ${route}`, async () => {
                const template = loop.replaceAll('DANGER', risky ? entry.danger : 'other')
                const definition =
                  entry.prelude +
                  (entry.language === 'python'
                    ? template.replace(/(^[ \t]*)CALLSITE/gm, (_match, indent: string) =>
                        route
                          .split('\n')
                          .map((line) => indent + line)
                          .join('\n')
                      )
                    : template.replaceAll('CALLSITE', route))
                // A following call also validates bindings reconstructed from a previous cell.
                const current = history ? 'selected(path)' : definition
                const risks = await analyzeNotebookCodeRisk(
                  entry.language,
                  current,
                  undefined,
                  history ? [definition] : []
                )
                if (risky)
                  expect(risks.some((risk) => risk.operation.includes('unlink'))).toBe(true)
                else expect(risks).toEqual([])
              })
          }
    it.each([
      ['python', 'import os\nfor item in []:\n    os.unlink(path)'],
      [
        'python',
        'import os\nwhile False:\n    os.unlink(path)\nelse:\n    print(open(path).read())'
      ],
      [
        'python',
        'import os\nselected = open\nfor item in [0]:\n    selected(path).read()\n    selected = os.unlink'
      ],
      ['repl', 'const fs = require("node:fs"); for (const item of []) { fs.unlinkSync(path); }'],
      [
        'repl',
        'const fs = require("node:fs"); for (let i = 0; false; fs.unlinkSync(path)) { fs.unlinkSync(path); }'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.readFileSync; do { selected(path); selected = fs.unlinkSync; } while (false)'
      ],
      ['r', 'for (item in list()) { unlink(path) }'],
      ['r', 'while (FALSE) { unlink(path) }'],
      ['r', 'selected <- readLines\nfor (item in list(0)) { selected(path); selected <- unlink }']
    ] as const)('keeps zero/single iteration %s code inert: %s', async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
    })
    it.each([
      [
        'python',
        'import os\nselected = open\nfor item in [0]:\n    selected = os.unlink\nelse:\n    selected = open\nselected(path).read()'
      ],
      [
        'python',
        'import os\nfor selected in [open, os.unlink]:\n    selected(path).read()\n    break'
      ],
      [
        'python',
        'import os\nfor selected in [open, os.unlink]:\n    selected(path).read()\n    if True:\n        break'
      ],
      [
        'python',
        'import os\nfor item in [0, 1]:\n    print(open(path).read())\n    continue\n    os.unlink(path)'
      ],
      [
        'python',
        'import os\nwhile enabled:\n    def selected(path):\n        return open(path).read()\n    selected(path)'
      ],
      [
        'python',
        'import os\ntry:\n    def selected(path):\n        inner = os.unlink\nexcept Exception:\n    pass\nprint(open(path).read())'
      ],
      [
        'repl',
        'const fs = require("node:fs"); for (const selected of [fs.readFileSync, fs.unlinkSync]) { selected(path); break; }'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.unlinkSync; do { selected = fs.readFileSync; } while (enabled); selected(path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.readFileSync; { const selected = fs.unlinkSync; } selected(path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.readFileSync; for (const selected of [fs.unlinkSync]) { console.log(selected); } selected(path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.readFileSync; try { const selected = fs.unlinkSync; mayFail(); } catch (error) {} selected(path)'
      ],
      ['r', 'selected <- unlink\nrepeat { selected <- readLines; break }\nselected(path)'],
      ['r', 'for (selected in list(readLines, unlink)) { selected(path); break }'],
      ['r', 'for (item in list(0, 1)) { readLines(path); next; unlink(path) }'],
      [
        'python',
        'import subprocess\nsubprocess.run((["echo", "hello"]), shell=(False), env=(None), preexec_fn=(None))'
      ]
    ] as const)(
      'respects %s control exits, lexical scopes and stored function data: %s',
      async (language, source) => {
        expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
      }
    )
    it.each([
      [
        'python',
        'import os\nfor (selected, value) in [(open, 0), (os.unlink, 0)]:\n    selected(path)'
      ],
      [
        'python',
        'import os\nfirst = open\nsecond = open\nthird = os.unlink\nfor item in items:\n    first(path)\n    first = second\n    second = third'
      ],
      [
        'python',
        'import os\nselected = os\nwhile enabled:\n    selected = selected.path\nselected.remove(path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); for (const [selected, value] of [[fs.readFileSync, 0], [fs.unlinkSync, 0]]) { selected(path) }'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.unlinkSync; { const selected = fs.readFileSync; } selected(path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.unlinkSync; for (const selected of [fs.readFileSync]) { selected(path); } selected(path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.unlinkSync; try { const selected = fs.readFileSync; mayFail(); } catch (error) {} selected(path)'
      ],
      [
        'python',
        'import os\nselected = os.unlink\ntry:\n    may_fail()\nexcept Exception as selected:\n    print(selected)\nselected(path)'
      ]
    ] as const)('retains %s risky loop and exception bindings: %s', async (language, source) => {
      const risks = await analyzeNotebookCodeRisk(language, source)
      expect(risks.length).toBeGreaterThan(0)
      expect(
        risks.some(
          (risk) => risk.operation.includes('unlink') || risk.operation === 'dynamic call target'
        )
      ).toBe(true)
    })
    it('bounds nested literal-loop expansion and retains review when analysis cannot finish', async () => {
      let source = ''
      for (let depth = 0; depth < 5; depth++)
        source += '    '.repeat(depth) + `for item${depth} in [${Array(16).fill('0').join(',')}]:\n`
      source += '    '.repeat(5) + 'print("ordinary data")'
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([
        { operation: 'code analysis unavailable', source, line: 1 }
      ])
    })
    const exceptions = [
      [
        'python',
        'import os\ndef reader(path):\n    return open(path).read()\n',
        'os.unlink',
        [
          'try:\n    selected = DANGER\n    may_fail()\nexcept Exception:\n    selected = reader\nselected(path)',
          'selected = DANGER\ntry:\n    may_fail()\n    selected = reader\nexcept Exception:\n    pass\nselected(path)',
          'selected = reader\ntry:\n    selected = DANGER\n    may_fail()\n    selected = reader\nexcept Exception:\n    pass\nselected(path)',
          'try:\n    selected = DANGER\nexcept ValueError:\n    selected = reader\nexcept Exception:\n    selected = reader\nfinally:\n    selected(path)',
          'selected = reader\ntry:\n    if enabled:\n        selected = DANGER\n        may_fail()\n        selected = reader\nexcept Exception:\n    pass\nselected(path)'
        ]
      ],
      [
        'repl',
        'const fs = require("node:fs"); function reader(path) { return fs.readFileSync(path) } let selected = reader;\n',
        'fs.unlinkSync',
        [
          'try { selected = DANGER; mayFail(); } catch (error) { selected = reader; } selected(path)',
          'selected = DANGER; try { mayFail(); selected = reader; } catch (error) {} selected(path)',
          'selected = reader; try { selected = DANGER; mayFail(); selected = reader; } catch (error) {} selected(path)',
          'try { selected = DANGER; } catch (error) { selected = reader; } finally { selected(path); }',
          'selected = reader; try { if (enabled) { selected = DANGER; mayFail(); selected = reader; } } catch (error) {} selected(path)'
        ]
      ]
    ] as const
    for (const [language, prelude, danger, sources] of exceptions)
      for (const source of sources)
        for (const risky of [false, true])
          for (const history of [false, true])
            it(`${language} exceptional ${risky ? 'deletion' : 'reader'} (${history ? 'history' : 'cell'}): ${source}`, async () => {
              const definition = prelude + source.replaceAll('DANGER', risky ? danger : 'reader')
              const risks = await analyzeNotebookCodeRisk(
                language,
                history ? 'selected(path)' : definition,
                undefined,
                history ? [definition] : []
              )
              if (risky) expect(risks.some((risk) => risk.operation.includes('unlink'))).toBe(true)
              else expect(risks).toEqual([])
            })
  })
  describe('conditional callable bindings', () => {
    const cases = [
      {
        language: 'python' as const,
        prelude:
          'import os\ndef reader(path):\n    return open(path).read()\ndef other(path):\n    return os.path.getsize(path)\n',
        branches: [
          'selected = DANGER\nif False:\n    selected = reader',
          'selected = reader\nif True:\n    selected = DANGER\nelse:\n    selected = reader',
          'if enabled:\n    selected = DANGER\nelse:\n    selected = reader',
          'selected = DANGER\nif enabled:\n    selected = reader',
          'if enabled:\n    selected = reader\nelif other_flag:\n    selected = DANGER\nelse:\n    selected = other',
          'if False:\n    selected = other\nelif True:\n    selected = DANGER\nelse:\n    selected = reader'
        ],
        danger: 'os.unlink',
        routes: [
          'selected(path)',
          'saved = selected\nsaved(path)',
          'list(map(selected, [path]))',
          'selected.__call__(path)'
        ]
      },
      {
        language: 'repl' as const,
        prelude:
          "const fs = require('node:fs'); function reader(path) { return fs.readFileSync(path); } function other(path) { return fs.statSync(path); } let selected;\n",
        branches: [
          'selected = DANGER; if (false) { selected = reader; }',
          'selected = reader; if (true) { selected = DANGER; } else { selected = reader; }',
          'if (enabled) { selected = DANGER; } else { selected = reader; }',
          'selected = DANGER; if (enabled) { selected = reader; }',
          'if (enabled) { selected = reader; } else if (other_flag) { selected = DANGER; } else { selected = other; }',
          'if (false) { selected = other; } else if (true) { selected = DANGER; } else { selected = reader; }'
        ],
        danger: 'fs.unlinkSync',
        routes: [
          'selected(path)',
          'const saved = selected; saved(path)',
          '[path].map(selected)',
          'selected.call(null, path)',
          'selected.apply(null, [path])',
          'Reflect.apply(selected, null, [path])'
        ]
      },
      {
        language: 'r' as const,
        prelude:
          'reader <- function(path) readLines(path)\nother <- function(path) file.info(path)\n',
        branches: [
          'selected <- DANGER\nif (FALSE) { selected <- reader }',
          'selected <- reader\nif (TRUE) { selected <- DANGER } else { selected <- reader }',
          'if (enabled) { selected <- DANGER } else { selected <- reader }',
          'selected <- DANGER\nif (enabled) { selected <- reader }',
          'if (enabled) { selected <- reader } else if (other_flag) { selected <- DANGER } else { selected <- other }',
          'if (FALSE) { selected <- other } else if (TRUE) { selected <- DANGER } else { selected <- reader }'
        ],
        danger: 'unlink',
        routes: ['selected(path)', 'saved <- selected\nsaved(path)', 'lapply(c(path), selected)']
      }
    ]
    for (const entry of cases) {
      for (const branch of entry.branches) {
        for (const route of entry.routes) {
          for (const history of [false, true]) {
            it(`retains ${entry.language} selected deletion (${history ? 'history' : 'cell'}): ${branch} -> ${route}`, async () => {
              const definition = entry.prelude + branch.replaceAll('DANGER', entry.danger)
              const risks = await analyzeNotebookCodeRisk(
                entry.language,
                history ? route : definition + '\n' + route,
                undefined,
                history ? [definition] : []
              )
              expect(risks.some((risk) => risk.operation.includes('unlink'))).toBe(true)
            })
            it(`keeps ${entry.language} alternate readers prompt-free (${history ? 'history' : 'cell'}): ${branch} -> ${route}`, async () => {
              const definition = entry.prelude + branch.replaceAll('DANGER', 'other')
              expect(
                await analyzeNotebookCodeRisk(
                  entry.language,
                  history ? route : definition + '\n' + route,
                  undefined,
                  history ? [definition] : []
                )
              ).toEqual([])
            })
          }
        }
      }
    }
    it.each([
      [
        'python',
        'import os\nimport operator\nselected = os\nif enabled:\n    selected = other\noperator.methodcaller("unlink", path)(selected)'
      ],
      [
        'python',
        'import os\nselected = os\nif enabled:\n    selected = other\ngetattr(selected, "unlink")(path)'
      ],
      [
        'python',
        'import os\nfrom pathlib import Path\nselected = Path(path)\nif enabled:\n    selected = other\nselected.unlink()'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs; if (enabled) { selected = other; } selected["unlinkSync"](path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs; if (enabled) { selected = other; } const erase = selected.unlinkSync.bind(null); erase(path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.unlinkSync; if (enabled) { selected = console.log; } selected.bind(null)(path)'
      ],
      ['python', 'import os\nif os.unlink(path):\n    print("done")\nelse:\n    print("done")'],
      [
        'repl',
        'const fs = require("node:fs"); if (fs.unlinkSync(path)) { console.log("done"); } else { console.log("done"); }'
      ],
      ['r', 'if (unlink(path)) { print("done") } else { print("done") }']
    ] as const)(
      'preserves conditional member and eager-condition effects in %s: %s',
      async (language, source) => {
        expect(
          (await analyzeNotebookCodeRisk(language, source)).some((risk) =>
            risk.operation.includes('unlink')
          )
        ).toBe(true)
      }
    )
    it.each([
      ['python', 'selected = open\nif enabled:\n    selected = print\nprint(selected)'],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs.unlinkSync; if (enabled) { selected = fs.readFileSync; } console.log(selected)'
      ],
      ['r', 'selected <- unlink\nif (enabled) { selected <- readLines }\nprint(selected)'],
      [
        'python',
        'import os\nselected = os\nif enabled:\n    selected = other\ngetattr(selected, "stat")(path)'
      ],
      [
        'repl',
        'const fs = require("node:fs"); let selected = fs; if (enabled) { selected = other; } selected.statSync(path)'
      ],
      [
        'python',
        'import os\nfrom pathlib import Path\nselected = Path(path)\nif enabled:\n    selected = other\nselected.read_text()'
      ]
    ] as const)(
      'keeps conditional function data and readers inert in %s: %s',
      async (language, source) => {
        expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
      }
    )
    it('does not analyze elif conditions after a selected earlier literal branch', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'import os\nif True:\n    print(open(path).read())\nelif os.unlink(path):\n    pass'
        )
      ).toEqual([])
    })
    it.each([false, true])(
      'keeps alternate R syntax constructors unevaluated (history: %s)',
      async (history) => {
        const definition = 'if (enabled) { syntax <- quote } else { syntax <- expression }'
        const invocation = 'syntax(unlink(path))'
        expect(
          await analyzeNotebookCodeRisk(
            'r',
            history ? invocation : definition + '\n' + invocation,
            undefined,
            history ? [definition] : []
          )
        ).toEqual([])
      }
    )
    it('inspects an R argument when an alternate callee evaluates ordinary arguments', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'r',
          'if (enabled) { syntax <- quote } else { syntax <- identity }\nsyntax(unlink(path))'
        )
      ).toEqual([expect.objectContaining({ operation: 'unlink' })])
    })
    it('keeps known deletion evidence beside an unresolved alternative module', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'import os\nselected = os\nif enabled:\n    selected = factory()\nselected.remove(path)'
        )
      ).toEqual([expect.objectContaining({ operation: 'os.remove' })])
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          'import os\nselected = os\nif enabled:\n    selected = factory()\nselected.stat(path)'
        )
      ).toEqual([])
    })
    it('does not let a fixed member discharge overflow uncertainty', async () => {
      let source = 'import os\nselected = os\n'
      for (let index = 0; index < 20; index++)
        source += `if flag${index}:\n    selected = module${index}\n`
      expect(await analyzeNotebookCodeRisk('python', source + 'selected.remove(path)')).toEqual([
        expect.objectContaining({ operation: 'dynamic call target' })
      ])
    })
    it('retains deletion when deeply nested alternatives exceed the provenance bound', async () => {
      let source = 'import os\nselected = os.unlink\n'
      for (let index = 0; index < 20; index++)
        source += `if flag${index}:\n    selected = read${index}\n`
      expect(await analyzeNotebookCodeRisk('python', source + 'selected(path)')).toEqual([
        expect.objectContaining({ operation: 'dynamic call target' })
      ])
    })
    it.each([
      [
        'python',
        'if False:\n    os.unlink(path)\nelif True:\n    print(open(path).read())\nelse:\n    os.unlink(path)'
      ],
      [
        'repl',
        'if (false) { fs.unlinkSync(path); } else if (true) { fs.readFileSync(path); } else { fs.unlinkSync(path); }'
      ],
      ['r', 'if (FALSE) { unlink(path) } else if (TRUE) { readLines(path) } else { unlink(path) }']
    ] as const)('skips unreachable %s deletion effects', async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
    })
  })
  describe('Python iterator callbacks, method wrappers and file openers', () => {
    const prelude =
      'import os\nimport itertools\nimport operator\nimport builtins\nimport io\ndef erase(*args):\n    os.unlink(path)\n    return 0\ndef read(*args):\n    return open(path).read()\n'
    const collections = [
      ['starmap', 'CALLBACK, [(path,)]'],
      ['dropwhile', 'CALLBACK, [path]'],
      ['takewhile', 'CALLBACK, [path]'],
      ['filterfalse', 'CALLBACK, [path]'],
      ['accumulate', '[path, path], CALLBACK'],
      ['accumulate', '[path, path], func=CALLBACK'],
      ['accumulate', '[path, path], **{"func": CALLBACK}'],
      ['groupby', '[path], CALLBACK'],
      ['groupby', '[path], key=CALLBACK'],
      ['groupby', '[path], **{"key": CALLBACK}']
    ]
    const aliases = (method: string, args: string): string[] => [
      `list(itertools.${method}(${args}))`,
      `from itertools import ${method} as consume\nlist(consume(${args}))`,
      `import itertools as tools\nlist(tools.${method}(${args}))`,
      `consume = itertools.${method}\nlist(consume(${args}))`
    ]
    it.each(
      collections.flatMap(([method, args]) => aliases(method, args.replace('CALLBACK', 'erase')))
    )('reviews invoked iterator deletion through aliases: %s', async (invocation) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).toEqual([
        expect.objectContaining({ operation: 'erase: os.unlink' })
      ])
    })
    it.each(
      collections.flatMap(([method, args]) => aliases(method, args.replace('CALLBACK', 'read')))
    )('keeps iterator readers prompt-free: %s', async (invocation) => {
      expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).toEqual([])
    })
    it.each([
      'list(iter(erase, 0))',
      'list(builtins.iter(erase, 0))',
      'consume = iter\nlist(consume(erase, 0))',
      'itertools.accumulate(values, **options)',
      'itertools.groupby(values, **options)',
      'itertools.accumulate(*values, read)',
      'itertools.groupby(*values, read)',
      'itertools.starmap(handlers[name], rows)'
    ])(
      'retains callable sentinel forms and unresolved callback positions: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).not.toEqual([])
      }
    )
    it.each([
      'list(iter(read, ""))',
      'iter(erase)',
      'iter([erase])',
      'list(itertools.repeat(erase, 2))',
      'list(itertools.accumulate([1, 2], initial=erase))',
      'list(itertools.accumulate([1, 2], func=None))',
      'list(itertools.groupby([erase]))',
      'list(itertools.groupby([1, 2], key=None))',
      'list(itertools.zip_longest([], [1], fillvalue=erase))',
      'list(itertools.filterfalse(None, [1, 2]))',
      'itertools.accumulate(values, **{"initial": erase})',
      'itertools.groupby(values, **{"key": read})',
      'itertools.groupby(*values, key=read)',
      'itertools.accumulate(*values, func=read)',
      'import heapq\nheapq.nlargest(*values, key=read)',
      'itertools.groupby(*values, **{"key": read})'
    ])(
      'keeps optional callbacks and function-valued iterator data inert: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).toEqual([])
      }
    )

    it.each(['r', 'repl'] as const)(
      'does not apply Python wrapper provenance to %s code',
      async (language) => {
        expect(
          await analyzeNotebookCodeRisk(language, 'operator.methodcaller("read")(receiver)')
        ).not.toEqual([])
      }
    )
    const methods = [
      ['read', 'handle'],
      ['readline', 'handle'],
      ['read_text', 'file'],
      ['stat', 'file'],
      ['is_file', 'file'],
      ['strip', 'text'],
      ['lower', 'text'],
      ['split', 'text'],
      ['remove', 'items']
    ]
    const methodAliases = (method: string, receiver: string): string[] => [
      `operator.methodcaller("${method}")(${receiver})`,
      `invoke = operator.methodcaller("${method}")\ninvoke(${receiver})`,
      `from operator import methodcaller as wrapper\ninvoke = wrapper("${method}")\ninvoke(${receiver})`,
      `import operator as ops\ninvoke = ops.methodcaller("${method}")\nsaved = invoke\nsaved(${receiver})`
    ]
    it.each(methods.flatMap(([method, receiver]) => methodAliases(method, receiver)))(
      'keeps known fixed reader/data method wrappers prompt-free: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).toEqual([])
      }
    )
    it.each([
      ...['unlink', 'rmdir'].flatMap((method) => methodAliases(method, 'file')),
      ...['remove', 'unlink', 'rmdir', 'system', 'popen'].flatMap((method) =>
        methodAliases(method, 'os')
      ),
      'invoke = operator.methodcaller("__call__")\ninvoke(erase)',
      'operator.methodcaller("read") (handlers[name])()',
      'operator.methodcaller(name)(handle)',
      'invoke = operator.methodcaller("map", os.unlink, paths)\ninvoke(builtins)',
      'invoke = operator.methodcaller("open", path, opener=erase)\ninvoke(builtins)',
      'import heapq\noperator.methodcaller("nlargest", 1, paths, erase)(heapq)',
      'import bisect\noperator.methodcaller("bisect_left", values, value, key=erase)(bisect)',
      'list(map(operator.methodcaller("unlink"), files))',
      'list(map(operator.methodcaller("remove", path), modules))',
      'list(map(operator.methodcaller("system", command), modules))',
      'list(map(operator.methodcaller("__call__"), callbacks))',
      'operator.methodcaller("__call__", path, opener=erase)(open)',
      'operator.methodcaller("__call__", os.unlink, paths)(map)',
      'list(map(operator.methodcaller("run", command), modules))',
      'list(map(operator.methodcaller("getoutput", command), modules))',
      'list(map(operator.methodcaller("run_path", path), modules))',
      'list(map(operator.methodcaller("eval", code), modules))',
      'list(map(operator.methodcaller("exec", code), modules))',
      'list(map(operator.methodcaller("__import__", module), modules))'
    ])(
      'retains destructive receivers, opaque callbacks and frozen callback arguments: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).not.toEqual([])
      }
    )
    it.each([
      'invoke = operator.methodcaller("unlink")\nprint(invoke)',
      'invoke = operator.methodcaller("system", command)\nprint(invoke)',
      'list(map(operator.methodcaller("strip"), texts))',
      'list(itertools.starmap(operator.methodcaller("read"), [(handle,)]))',
      'operator.methodcaller("__call__")(read)',
      'operator.methodcaller("read", 10)(handle)',
      'operator.methodcaller("remove", "a")(items)',
      'operator.methodcaller(\n# method name\n"read"\n)(handle)',
      'invoke = operator.methodcaller(\n# method name\n"read"\n)\ninvoke(handle)'
    ])(
      'does not execute stored wrappers and keeps fixed reader callbacks prompt-free: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).toEqual([])
      }
    )
    it('does not certify a mutable descriptor binding or discard eager opener effects', async () => {
      for (const source of [
        'fd = path\nif flag:\n    fd = 3\nopen(fd, opener=erase).read()',
        'fd = os.open(path, os.O_RDONLY)\nfd = path\nopen(fd, opener=erase).read()',
        'open(3, opener=erase(), **options).read()'
      ])
        expect(await analyzeNotebookCodeRisk('python', prelude + source)).not.toEqual([])
    })
    it('retains saved method-wrapper identity across cells and rebinding', async () => {
      const definition =
        prelude +
        'invoke = operator.methodcaller("read")\nsaved = invoke\ninvoke = operator.methodcaller("unlink")'
      expect(await analyzeNotebookCodeRisk('python', definition)).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'saved(handle)', undefined, [definition])
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'invoke(file)', undefined, [definition])
      ).not.toEqual([])
    })

    it.each(
      ['open', 'builtins.open', 'io.open'].flatMap((target) => [
        `${target}(path, opener=erase).read()`,
        `${target}(file=path, mode="r", opener=erase).read()`,
        `${target}(path, **{"opener": erase}).read()`,
        `acquire = ${target}\nacquire(path, opener=erase).read()`,
        `${target}(path, **options).read()`
      ])
    )(
      'reviews actual file opener effects or unresolved opener callbacks: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).not.toEqual([])
      }
    )
    it.each(
      ['open', 'builtins.open', 'io.open'].flatMap((target) => [
        `${target}(path).read()`,
        `${target}(path, opener=read).read()`,
        `${target}(path, opener=None).read()`,
        `${target}(path, **{"encoding": "utf8"}).read()`,
        `${target}(path, **{"opener": read}).read()`,
        `${target}(3, opener=erase).read()`,
        `${target}((3), opener=erase).read()`,
        `${target}(file=3, opener=erase).read()`,
        `${target}(3, **{"opener": erase}).read()`,
        `${target}(3, opener=erase, **options).read()`,
        `${target}(None, opener=erase)`
      ])
    )(
      'keeps reader openers, literal options and descriptor reads prompt-free: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('python', prelude + invocation)).toEqual([])
      }
    )
  })

  describe('deferred callbacks and reflected constructors', () => {
    const prelude =
      'const fs = require("fs"); const timers = require("node:timers"); const task = require("node:process"); function erase(path) { fs.unlinkSync(path) }; function read(path) { return fs.readFileSync(path, "utf8") };'
    it('keeps long ordinary returned-object chains bounded and prompt-free', async () => {
      expect(
        await analyzeNotebookCodeRisk('repl', `model.read()${'.normalize()'.repeat(80)}`)
      ).toEqual([])
    })
    const schedulers = [
      'setTimeout',
      'globalThis.setTimeout',
      'global.setTimeout',
      'setInterval',
      'setImmediate',
      'queueMicrotask',
      'process.nextTick',
      'globalThis.process.nextTick',
      'timers.setTimeout',
      'timers.setInterval',
      'timers.setImmediate',
      'task.nextTick'
    ]
    const invoke = (target: string, callback: string): string[] => [
      `${target}(${callback}, 0, path)`,
      `const schedule = ${target}; schedule(${callback}, 0, path)`,
      `${target}.call(null, ${callback}, 0, path)`,
      `${target}.apply(null, [${callback}, 0, path])`,
      `Reflect.apply(${target}, null, [${callback}, 0, path])`,
      `const schedule = ${target}.bind(null); schedule(${callback}, 0, path)`
    ]
    it.each(schedulers.flatMap((target) => invoke(target, 'erase')))(
      'reviews a scheduled named deletion: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('repl', `${prelude} ${invocation}`)).toEqual([
          expect.objectContaining({ operation: 'erase: fs.unlinkSync' })
        ])
      }
    )
    it.each(schedulers.flatMap((target) => invoke(target, 'read')))(
      'keeps a scheduled reader prompt-free: %s',
      async (invocation) => {
        expect(await analyzeNotebookCodeRisk('repl', `${prelude} ${invocation}`)).toEqual([])
      }
    )
    it.each([
      'const {setTimeout: schedule} = require("timers"); schedule(fs.unlinkSync, 0, path)',
      'import {setImmediate as schedule} from "node:timers"; schedule(fs.unlinkSync, path)',
      'import {nextTick as schedule} from "node:process"; schedule(fs.unlinkSync, path)',
      'timers.setTimeout(handlers[method], 0)',
      'setTimeout.apply(null, callbacks)',
      'process.nextTick.apply(process, callbacks)',
      'Reflect.apply(timers.setImmediate, null, callbacks)',
      'const schedule = setTimeout.bind(null, erase); schedule(0, path)',
      'const schedule = process.nextTick.bind(process, erase); schedule(path)',
      'setTimeout(...callbacks)',
      'queueMicrotask(...callbacks)'
    ])('retains imported, prebound or unresolved scheduling: %s', async (invocation) => {
      expect(await analyzeNotebookCodeRisk('repl', `${prelude} ${invocation}`)).not.toEqual([])
    })
    it('keeps saved scheduling provenance across kernel cells and rebinding', async () => {
      const definition = `${prelude} let schedule = timers.setTimeout; const saved = schedule; schedule = null;`
      expect(await analyzeNotebookCodeRisk('repl', definition)).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('repl', 'saved(erase, 0, path)', undefined, [definition])
      ).toEqual([expect.objectContaining({ operation: 'erase: fs.unlinkSync' })])
    })
    it.each([
      'const schedule = setTimeout; console.log(schedule)',
      'setTimeout(console.log, 0, fs.unlinkSync)',
      'process.nextTick(console.log, fs.unlinkSync)',
      'setTimeout("fs.unlinkSync(path)", 0)',
      'setTimeout(null, 0)',
      'timers.clearTimeout(fs.unlinkSync)',
      'timers.clearInterval(fs.unlinkSync)',
      'timers.clearImmediate(fs.unlinkSync)',
      'const values = require("node:timers/promises"); values.setTimeout(0, erase)',
      'const values = require("timers/promises"); values.setImmediate(erase)',
      'const values = require("node:timers/promises"); values.setInterval(0, erase)',
      'const {setTimeout: wait} = require("node:timers/promises"); wait(0, erase)',
      'import {setImmediate as wait} from "node:timers/promises"; wait(erase)',
      'timers.promises.setTimeout(0, erase)',
      'timers.promises.setImmediate(erase)',
      'const application = {}; application.setTimeout(erase)'
    ])('keeps cancellation, inert callbacks and promise values as data: %s', async (invocation) => {
      expect(await analyzeNotebookCodeRisk('repl', `${prelude} ${invocation}`)).toEqual([])
    })

    const constructs = (target: string, args: string): string[] => [
      `Reflect.construct(${target}, [${args}])`,
      `globalThis.Reflect.construct(${target}, [${args}])`,
      `Reflect["construct"](${target}, [${args}])`,
      `Reflect.construct.call(Reflect, ${target}, [${args}])`,
      `Reflect.construct.apply(Reflect, [${target}, [${args}]])`,
      `Reflect.apply(Reflect.construct, Reflect, [${target}, [${args}]])`,
      `invoke(${target}, [${args}])`
    ]
    const factoryPrelude = `${prelude} const vm = require("node:vm"); const invoke = Reflect.construct;`
    it.each(
      constructs('vm.Script', 'code').flatMap((factory) =>
        ['runInContext', 'runInNewContext', 'runInThisContext'].map((method) => [factory, method])
      )
    )(
      'reviews compiled objects at execution, including reflection: %s %s',
      async (factory, method) => {
        expect(
          await analyzeNotebookCodeRisk(
            'repl',
            `${factoryPrelude} const prepared = ${factory}; prepared.${method}(context)`
          )
        ).toEqual([
          expect.objectContaining({ operation: `node:vm.Script.${method} nested execution` })
        ])
      }
    )
    it.each(constructs('vm.Script', 'code'))(
      'keeps reflection compilation and caching prompt-free: %s',
      async (factory) => {
        expect(
          await analyzeNotebookCodeRisk(
            'repl',
            `${factoryPrelude} const prepared = ${factory}; prepared.createCachedData()`
          )
        ).toEqual([])
      }
    )
    it.each(
      ['Promise', 'globalThis.Promise', 'global.Promise'].flatMap((target) =>
        constructs(target, 'erase')
      )
    )('reviews an immediately invoked reflected Promise executor: %s', async (factory) => {
      expect(await analyzeNotebookCodeRisk('repl', `${factoryPrelude} ${factory}`)).toEqual([
        expect.objectContaining({ operation: 'erase: fs.unlinkSync' })
      ])
    })
    it.each(constructs('Promise', 'read'))(
      'keeps reflected reader executors prompt-free: %s',
      async (factory) => {
        expect(await analyzeNotebookCodeRisk('repl', `${factoryPrelude} ${factory}`)).toEqual([])
      }
    )
    it.each([
      'Reflect.construct(erase, [path])',
      'Reflect.construct(Promise, handlers)',
      'Reflect.construct(Promise, [...handlers])',
      'Reflect.construct(constructors[name], [path])',
      'const Factory = vm.Script; const prepared = Reflect.construct(Factory, [code]); prepared.runInThisContext()',
      'Reflect.construct(vm.Script, [code]).runInThisContext()',
      'const {construct: build} = Reflect; const prepared = build(vm.Script, [code]); prepared.runInThisContext()',
      'const Factory = Promise.bind(null); Reflect.construct(Factory, [erase])'
    ])(
      'retains constructor effects, instance aliases and uncertain targets: %s',
      async (invocation) => {
        expect(
          await analyzeNotebookCodeRisk('repl', `${factoryPrelude} ${invocation}`)
        ).not.toEqual([])
      }
    )
    it.each([
      'Reflect.construct(Array, [erase])',
      'Reflect.construct(Object, [erase])',
      'Reflect.construct(Date, [0])',
      'Reflect.construct(Promise, [null])',
      'const build = Reflect.construct; console.log(build)',
      'const prepare = () => Reflect.construct(vm.Script, [code]); console.log(prepare)',
      'new Promise(read)'
    ])('keeps constructor data and stored factories prompt-free: %s', async (invocation) => {
      expect(await analyzeNotebookCodeRisk('repl', `${factoryPrelude} ${invocation}`)).toEqual([])
    })
    it('retains reflected Script provenance across cells and rebinding', async () => {
      const definition = `${factoryPrelude} let prepared = Reflect.construct(vm.Script, [code]); const saved = prepared.runInThisContext.bind(prepared); prepared = null;`
      expect(await analyzeNotebookCodeRisk('repl', definition)).toEqual([])
      expect(await analyzeNotebookCodeRisk('repl', 'saved()', undefined, [definition])).toEqual([
        expect.objectContaining({ operation: 'node:vm.Script.runInThisContext nested execution' })
      ])
    })
  })

  it.each([
    'python3.13 -c "import os; os.unlink(path)"',
    '/opt/python/bin/python3.13 script.py',
    'python2.7 -m package',
    'pypy3 -c code',
    'pypy3.10 script.py',
    'command python3.13 script.py',
    'env -i python3.13 script.py',
    'python3.13 -c "print(1)" --help',
    'python3.13 -m package --version',
    'python3.13 -- script.py --help',
    'python3.13 -W --help',
    'python3.13 -X --help',
    'python3.13 -cV',
    'python3.13 -Xhelp',
    'python3.13 -Wfilter -- script.py',
    'python3.13 "$OPTIONS" -V',
    'python3.13 -W* -V',
    'python3.13 -X* -h',
    'python3.13 -? code',
    'python3.13 -W""* -V',
    'python3.13 "-W"* -V',
    'env -i python3.13 -W* -V',
    'command python3.13 -W* -V',
    'python3.* -V',
    'command python3.* -V',
    'builtin python3.* -V',
    'env -i python3.* -V',
    'env -u VAR* python3.13 -V',
    'env -C folder* python3.13 -V',
    'env --unset VAR* python3.13 -V',
    'env A=* python3.13 -V',
    'env -u* python3.13 -V'
  ])(
    'reviews versioned Python/PyPy command execution and consumed query arguments: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('bash', source)).not.toEqual([])
    }
  )

  it.each([
    'python -h',
    'python3 -V',
    'python3.13 -VV',
    'python3.13 -I --version',
    'python3.13 -IV',
    'python3.13 -X faulthandler -V',
    'python3.13 -W ignore -h',
    'python3.13 -Xdev --help-all',
    'python3.13 --help-env',
    'python3.13 --help-xoptions',
    'python3.13 --check-hash-based-pycs always -V',
    'python3.13 "-W*" -V',
    'python3.13 "-?"',
    'python3.13 -W\\* -V',
    'command git clean -ne*.csv',
    'env -i git clean -ne*.csv',
    'command -v python3.*',
    'env -u "VAR*" python3.13 -V',
    'env A="*" python3.13 -V',
    'pypy3 -h',
    'pypy3.10 -V',
    'env -i python3.13 -I -V',
    'python3.13-config --includes',
    'echo "python3.13 -c code"'
  ])(
    'keeps interpreter queries, configuration tools and command text prompt-free: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
    }
  )
  describe.each([
    ...['execl', 'execlp', 'execle', 'execlpe'].map((name) => [
      'os',
      name,
      `program, program, "-c", script${name.endsWith('e') ? ', env' : ''}`
    ]),
    ...['execv', 'execvp', 'execve', 'execvpe'].map((name) => [
      'os',
      name,
      `program, [program, "-c", script]${name.endsWith('e') ? ', env' : ''}`
    ]),
    ...['spawnl', 'spawnlp', 'spawnle', 'spawnlpe'].map((name) => [
      'os',
      name,
      `os.P_WAIT, program, program, "-c", script${name.endsWith('e') ? ', env' : ''}`
    ]),
    ...['spawnv', 'spawnvp', 'spawnve', 'spawnvpe'].map((name) => [
      'os',
      name,
      `os.P_WAIT, program, [program, "-c", script]${name.endsWith('e') ? ', env' : ''}`
    ]),
    ['os', 'posix_spawn', 'program, [program, "-c", script], env'],
    ['os', 'posix_spawnp', 'program, [program, "-c", script], env'],
    ['pty', 'spawn', '[program, "-c", script]'],
    ['runpy', 'run_path', 'path'],
    ['runpy', 'run_module', 'name']
  ])('Python %s.%s execution', (module, method, args) => {
    it('reviews actual invocation through import aliases and saved functions', async () => {
      for (const source of [
        `import ${module}\n${module}.${method}(${args})`,
        `import ${module} as runtime\nruntime.${method}(${args})`,
        `from ${module} import ${method} as launch\nlaunch(${args})`,
        `import ${module}\nlaunch = ${module}.${method}\nlaunch(${args})`,
        `import ${module}\ngetattr(${module}, "${method}")(${args})`,
        `import ${module}\n${module}.${method}.__call__(${args})`
      ]) {
        expect(await analyzeNotebookCodeRisk('python', source)).toEqual([
          expect.objectContaining({ operation: `${module}.${method} nested execution` })
        ])
      }
    })
    it('retains execution identity across cells but does not invoke stored data', async () => {
      const definition = `from ${module} import ${method} as launch\nsaved = launch\nlaunch = print`
      expect(await analyzeNotebookCodeRisk('python', definition)).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', `saved(${args})`, undefined, [definition])
      ).toEqual([expect.objectContaining({ operation: `${module}.${method} nested execution` })])
      expect(
        await analyzeNotebookCodeRisk(
          'python',
          `import ${module}\nprint(${module}.${method}.__name__)\nmax([], default=${module}.${method})`
        )
      ).toEqual([])
    })
  })

  describe.each(['runInContext', 'runInNewContext', 'runInThisContext'])('REPL vm.%s', (method) => {
    it('reviews module execution through direct, saved and forwarded targets', async () => {
      for (const source of [
        `vm.${method}(code, context)`,
        `const launch = vm.${method}; launch(code, context)`,
        `vm.${method}.call(vm, code, context)`,
        `vm.${method}.apply(vm, [code, context])`,
        `Reflect.apply(vm.${method}, vm, [code, context])`,
        `const launch = vm.${method}.bind(vm); launch(code, context)`
      ]) {
        expect(
          await analyzeNotebookCodeRisk('repl', `const vm = require("node:vm"); ${source}`)
        ).toEqual([expect.objectContaining({ operation: `node:vm.${method} nested execution` })])
      }
    })
    it('tracks compiled Script instances and saved methods until actual execution', async () => {
      for (const source of [
        `const script = new vm.Script(code); script.${method}(context)`,
        `new vm.Script(code).${method}(context)`,
        `const Script = vm.Script; const script = new Script(code); script.${method}(context)`,
        `const Script = vm.Script.bind(null); const script = new Script(code); script.${method}(context)`,
        `const script = new vm.Script(code); const launch = script.${method}.bind(script); launch(context)`,
        `const script = new vm.Script(code); Reflect.apply(script.${method}, script, [context])`,
        `vm.Script.prototype.${method}.call(script, context)`
      ]) {
        expect(
          await analyzeNotebookCodeRisk('repl', `const vm = require("node:vm"); ${source}`)
        ).toEqual([
          expect.objectContaining({
            operation: `node:vm.Script${source.startsWith('vm.Script.prototype') ? '.prototype' : ''}.${method} nested execution`
          })
        ])
      }
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          `import { Script as Compiled } from "vm"; const script = new Compiled(code); script.${method}(context)`
        )
      ).toEqual([expect.objectContaining({ operation: `vm.Script.${method} nested execution` })])
    })
    it('retains Script method provenance across cells and rebinding', async () => {
      const definition = `const vm = require("vm"); let script = new vm.Script(code); const saved = script.${method}.bind(script); script = null`
      expect(await analyzeNotebookCodeRisk('repl', definition)).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('repl', 'saved(context)', undefined, [definition])
      ).toEqual([expect.objectContaining({ operation: `vm.Script.${method} nested execution` })])
    })
  })

  it.each([
    'const vm = require("vm"); const script = new vm.Script("fs.unlinkSync(path)")',
    'const vm = require("vm"); const script = new vm.Script(code); script.createCachedData()',
    'const vm = require("vm"); const script = new vm.Script(code); const saved = script.runInThisContext.bind(script)',
    'const { Script: Compiled } = require("node:vm"); new Compiled(code)',
    'const vm = require("vm"); vm.compileFunction("fs.unlinkSync(path)", ["fs", "path"])',
    'const vm = require("vm"); vm.createContext({ callback: fs.unlinkSync })',
    'const vm = require("vm"); const launch = vm.runInThisContext; [launch].map(String)',
    'const report = { runInContext: Number }; report.runInContext(1)'
  ])(
    'keeps VM compilation, prepared callables and unrelated methods prompt-free: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('repl', `const fs = require("fs"); ${source}`)).toEqual(
        []
      )
    }
  )

  it.each([
    'const vm = require("vm"); const fs = require("fs"); new vm.Script(code, { filename: fs.unlinkSync(path) })',
    'const vm = require("vm"); const compiled = vm.compileFunction(code); compiled()',
    'const vm = require("vm"); const compiled = vm.compileFunction(code); paths.map(compiled)'
  ])(
    'does not suppress eager compilation effects or compiled function invocation: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('repl', source)).not.toEqual([])
    }
  )
  describe.each([
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float16Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array'
  ])('%s mapper execution', (constructor) => {
    it('follows actual mapper identity through aliases and forwarded calls', async () => {
      const target = `${constructor}.from`
      for (const invocation of [
        `${target}(paths, CALLBACK)`,
        `globalThis.${target}(paths, CALLBACK)`,
        `const collect = ${target}; collect(paths, CALLBACK)`,
        `${target}.call(${constructor}, paths, CALLBACK)`,
        `${target}.apply(${constructor}, [paths, CALLBACK])`,
        `Reflect.apply(${target}, ${constructor}, [paths, CALLBACK])`,
        `const collect = ${target}.bind(${constructor}); collect(paths, CALLBACK)`
      ]) {
        expect(
          await analyzeNotebookCodeRisk(
            'repl',
            `const fs = require("fs"); ${invocation.replace('CALLBACK', 'fs.unlinkSync')}`
          )
        ).toEqual([expect.objectContaining({ operation: 'fs.unlinkSync' })])
        expect(
          await analyzeNotebookCodeRisk('repl', invocation.replace('CALLBACK', 'Number'))
        ).toEqual([])
      }
    })
    it('keeps inputs and context as data but retains uncertain invocation', async () => {
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          `const fs = require("fs"); ${constructor}.from([fs.unlinkSync], Number, fs.unlinkSync)`
        )
      ).toEqual([])
      expect(await analyzeNotebookCodeRisk('repl', `${constructor}.from(...args)`)).not.toEqual([])
      expect(
        await analyzeNotebookCodeRisk('repl', `${constructor}.from.apply(${constructor}, args)`)
      ).not.toEqual([])
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          `const fs = require("fs"); const collect = ${constructor}.from.bind(${constructor}, paths, fs.unlinkSync)`
        )
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          `const fs = require("fs"); const collect = ${constructor}.from.bind(${constructor}, paths, fs.unlinkSync); collect()`
        )
      ).not.toEqual([])
    })
  })

  describe.each(['replace', 'replaceAll'])('text %s callback execution', (method) => {
    it('reviews named, aliased and forwarded replacement functions', async () => {
      for (const invocation of [
        `path.${method}(pattern, erase)`,
        `String.prototype.${method}.call(path, pattern, erase)`,
        `String.prototype.${method}.apply(path, [pattern, erase])`,
        `Reflect.apply(String.prototype.${method}, path, [pattern, erase])`,
        `const change = String.prototype.${method}.bind(path); change(pattern, erase)`
      ]) {
        expect(
          await analyzeNotebookCodeRisk(
            'repl',
            `const fs = require("fs"); function erase(path) { fs.unlinkSync(path); return "" }; ${invocation}`
          )
        ).toEqual([expect.objectContaining({ operation: 'erase: fs.unlinkSync' })])
        expect(
          await analyzeNotebookCodeRisk('repl', invocation.replaceAll('erase', 'String'))
        ).toEqual([])
      }
    })
    it('does not invoke replacement text or unrelated data', async () => {
      for (const replacement of [
        '"unlink"',
        '("$&")',
        'null',
        'false',
        '1',
        '`prefix`',
        '{ label: "unlink" }',
        '["unlink"]'
      ]) {
        expect(
          await analyzeNotebookCodeRisk(
            'repl',
            `const replacement = ${replacement}; const saved = replacement; "sample".${method}("sample", saved)`
          )
        ).toEqual([])
      }
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          `const fs = require("fs"); "sample".${method}("sample", "text", fs.unlinkSync)`
        )
      ).toEqual([])
    })
  })

  it.each([
    'rapply(list("x"), unlink)',
    'base::rapply(f=unlink, object=list("x"))',
    'rapply(list("x"), f=unlink)',
    'rapply(f=unlink, list("x"))',
    'rapply(list("x"), unlink, deflt=length)',
    'by("x", 1, unlink)',
    'base::by(FUN="unlink", data="x", INDICES=1)',
    'by("x", 1, F=unlink)',
    'by(1, unlink, data="x")',
    'outer("x", TRUE, unlink)',
    'base::outer(FUN="unlink", Y=TRUE, X="x")',
    'outer("x", TRUE, F=unlink)',
    'outer(TRUE, unlink, X="x")'
  ])('reviews recursive/group/outer R callback invocation: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('r', source)).toEqual([
      expect.objectContaining({ operation: 'unlink' })
    ])
    expect(await analyzeNotebookCodeRisk('r', source.replaceAll('unlink', 'length'))).toEqual([])
  })

  it.each([
    'rapply(list(1:3), sum)',
    'rapply(list(unlink), identity)',
    'rapply(list(1:3), sum, deflt=unlink)',
    'rapply(list(1:3), "unlink")',
    'rapply(list(1:3), ("unlink"))',
    'by(1:3, c(1,1,2), sum)',
    'by(list(unlink), 1, identity)',
    'outer(1:3, 1:3)',
    'outer(1:3, 1:3, "+")',
    'outer(list(unlink), list(unlink), function(x, y) x)',
    'rapply <- function(object, f) object; rapply(list("x"), unlink)',
    'by <- function(data, INDICES, FUN) data; by("x", 1, unlink)'
  ])(
    'keeps R non-invoked data and invalid string rapply callbacks prompt-free: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('r', source)).toEqual([])
    }
  )

  it.each([
    ['python', 'key = None; saved = key; sorted([2, 1], key=saved)'],
    ['python', 'import bisect; key = (None); bisect.insort([], 1, key=key)'],
    ['r', 'f <- NULL; saved <- f; tapply(1:3, 1:3, saved)'],
    ['repl', 'const handler = null; const saved = handler; Promise.resolve(1).then(saved)'],
    ['repl', 'const handler = 1; [1, 2].map(handler)'],
    ['repl', 'const handler = ("text"); Array.from([1], handler)'],
    ['repl', 'const [first, second] = [null, "text"]; Promise.resolve(1).then(first, second)']
  ] as const)(
    'preserves proven inert %s callback values through bindings: %s',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
    }
  )

  it.each([
    [
      'repl',
      'const fs = require("fs"); let callback = null; callback = fs.unlinkSync; "x".replace("x", callback)'
    ],
    [
      'repl',
      'const fs = require("fs"); let callback = "text"; callback = fs.unlinkSync; Uint8Array.from(paths, callback)'
    ],
    ['python', 'import os; key = None; key = os.unlink; sorted(paths, key=key)'],
    ['r', 'f <- NULL; f <- unlink; by(paths, groups, f)']
  ] as const)(
    'does not preserve an inert %s binding after destructive reassignment: %s',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
    }
  )

  it.each([
    'const holder = { handler: fs.unlinkSync }; const { handler } = holder; Uint8Array.from(paths, handler)',
    'const holder = { handler: fs.unlinkSync }; "x".replace("x", holder.handler)',
    'const holder = [fs.unlinkSync]; "x".replace("x", holder[0])',
    'const holder = { nested: { handler: fs.unlinkSync } }; const { nested: { handler } } = holder; "x".replaceAll("x", handler)',
    'const callback = factory(); "x".replace("x", callback)',
    'const callback = factory(); Uint8Array.from(paths, callback)'
  ])('keeps members of inert objects and unknown factories reviewable: %s', async (source) => {
    expect(
      await analyzeNotebookCodeRisk('repl', `const fs = require("fs"); ${source}`)
    ).not.toEqual([])
  })

  it.each([
    'unlink <- NULL; unlink("x")',
    'file.remove <- NULL; file.remove("x")',
    'unlink <- NULL; saved <- unlink; saved <- base::unlink; saved("x")'
  ])(
    'does not use a non-function R value to discharge named function lookup: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('r', source)).not.toEqual([])
    }
  )

  it.each([
    [
      'repl',
      'const fs = require("fs"); let erase = fs.unlinkSync; const saved = erase; erase = "text"',
      '"x".replace("x", saved)'
    ],
    [
      'repl',
      'const fs = require("fs"); let erase = fs.unlinkSync; const saved = erase; erase = Number',
      'Uint8Array.from(paths, saved)'
    ],
    ['r', 'erase <- unlink; saved <- erase; erase <- length', 'rapply(paths, saved)'],
    ['r', 'erase <- unlink; saved <- erase; erase <- length', 'by(paths, groups, saved)'],
    ['r', 'erase <- unlink; saved <- erase; erase <- length', 'outer(paths, TRUE, saved)']
  ] as const)(
    'retains batched %s callback identity across cells',
    async (language, definition, call) => {
      expect(await analyzeNotebookCodeRisk(language, definition)).toEqual([])
      expect(await analyzeNotebookCodeRisk(language, call, undefined, [definition])).not.toEqual([])
    }
  )
  it.skipIf(process.platform !== 'win32')(
    'uses native PowerShell ASTs without executing the submitted payload',
    async () => {
      expect(
        await analyzePowerShellCodeRisk('Get-ChildItem; Write-Output "Remove-Item x"')
      ).toEqual([])
      expect(await analyzePowerShellCodeRisk('Remove-Item x -Recurse')).not.toEqual([])
      expect(await analyzePowerShellCodeRisk('[System.IO.File]::Delete("x")')).not.toEqual([])
      expect(await analyzePowerShellCodeRisk('git reset --hard')).not.toEqual([])
    }
  )
  it.each([
    ['bash', 'rm -rf results'],
    ['bash', 'echo "$(rm results.csv)"'],
    ['bash', 'find . -delete'],
    ['bash', 'command rm -- results.csv'],
    ['bash', 'sh -c "rm results.csv"'],
    ['bash', 'xargs -0 rm < paths'],
    ['bash', 'git reset --hard'],
    ['bash', ': > important.csv'],
    ['python', 'import os as operating_system\noperating_system.remove("x")'],
    ['python', 'from shutil import rmtree as clear\nclear("x")'],
    ['python', 'import os.path\nos.unlink("x")'],
    ['python', 'import os\nf"{os.unlink(path)}"'],
    ['python', 'from os import unlink as erase\nerase = erase("x")'],
    ['python', 'from pathlib import Path as P\np = P("x")\np.unlink()'],
    ['python', 'import subprocess\nsubprocess.run(command)'],
    ['r', 'base::unlink("x", recursive=TRUE)'],
    ['r', 'file.remove(paths)'],
    ['r', 'erase <- unlink; erase("x")'],
    ['repl', 'const fs = require("node:fs"); fs.rmSync("x")'],
    ['repl', 'const {unlink: erase} = require("fs"); erase("x")'],
    ['repl', 'const fs = require("fs"); fs.promises.rm("x", {recursive:true})']
  ] as const)('reviews %s effect: %s', async (language, source) => {
    expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
  })

  it.each([
    ['bash', '# rm -rf results\necho "rm results"'],
    ['bash', 'ls -l; git status; pwd'],
    ['bash', 'rm --help'],
    ['bash', 'git reset --soft HEAD~1'],
    ['python', 'data = [1, 2]\ndata.remove(1)\ndel data[0]'],
    ['python', 'import matplotlib.pyplot as plt\nplt.savefig("plot.png")'],
    ['r', 'x <- 1; rm(x); plot(1:10)'],
    ['r', 'write.csv(data, "result.csv")'],
    ['r', 'unlink <- function(x) { x + 1 }; unlink(1)'],
    ['repl', 'delete object.property; values.delete("x")'],
    ['repl', 'await host.artifacts.save({content: "hello"})']
  ] as const)('does not confuse ordinary %s code with deletion: %s', async (language, source) => {
    expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
  })

  describe.each(['getoutput', 'getstatusoutput'])('Python subprocess.%s', (method) => {
    it.each([
      ['direct', (name: string) => `import subprocess\nsubprocess.${name}(command)`],
      ['module alias', (name: string) => `import subprocess as sp\nsp.${name}(command)`],
      ['import alias', (name: string) => `from subprocess import ${name} as run\nrun(command)`],
      [
        'attribute lookup',
        (name: string) => `import subprocess\ngetattr(subprocess, "${name}")(command)`
      ],
      ['callback', (name: string) => `import subprocess\nlist(map(subprocess.${name}, commands))`]
    ])('reviews actual shell invocation through %s', async (_label, code) => {
      expect(await analyzeNotebookCodeRisk('python', code(method))).toEqual([
        expect.objectContaining({ operation: `subprocess.${method} nested execution` })
      ])
    })

    it('defers saved callables until invocation and retains them across source replay', async () => {
      const definition = `from subprocess import ${method} as run\nsaved = run\nrun = print`
      expect(await analyzeNotebookCodeRisk('python', definition)).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'run("ready")', undefined, [definition])
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'saved(command)', undefined, [definition])
      ).toEqual([
        { operation: `subprocess.${method} nested execution`, source: 'saved(command)', line: 1 }
      ])
    })

    it.each([
      (name: string) => `import subprocess\nprint(subprocess.${name}.__name__)`,
      (name: string) =>
        `def ${name}(path):\n    return open(path).read()\nprint(${name}("data.txt"))`,
      (name: string) =>
        `from subprocess import ${name} as read\nread = open\nprint(read("data.txt").read())`,
      (name: string) =>
        `import subprocess\nprint(subprocess.CompletedProcess(["${name}"], 0, stdout="test").stdout)`
    ])('does not confuse ordinary reading or function data with execution: %s', async (code) => {
      expect(await analyzeNotebookCodeRisk('python', code(method))).toEqual([])
    })
  })

  it.each([
    'compile("import os; os.unlink(path)", "<cell>", "exec")',
    'compiled = compile("1 + 2", "<cell>", "eval"); print(compiled.co_consts)',
    'compile(b"print(1)", "<cell>", "single")',
    'import ast; compile("os.unlink(path)", "<cell>", "exec", flags=ast.PyCF_ONLY_AST)',
    'import ast; compile(ast.parse("os.unlink(path)"), "<cell>", "exec")',
    'import builtins; builtins.compile(code, "<cell>", "exec")',
    'from builtins import compile as prepare; prepare(code, "<cell>", "exec")',
    'prepare = compile; compile = exec; prepare(code, "<cell>", "exec")',
    'list(map(compile, ["1 + 2"], ["<cell>"], ["eval"]))',
    'import builtins; getattr(builtins, "compile")("1 + 2", "<cell>", "eval")',
    'compile = print; del compile; compile("1", "<cell>", "eval")'
  ])('does not treat Python compilation as execution: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
  })

  it.each([
    ['exec(compile("os.unlink(path)", "<cell>", "exec"))', 'exec dynamic execution'],
    ['eval(compile("os.unlink(path)", "<cell>", "eval"))', 'eval dynamic execution'],
    [
      'import builtins; builtins.exec(builtins.compile(code, "<cell>", "exec"))',
      'builtins.exec dynamic execution'
    ],
    ['compile = exec; compile(code)', 'exec dynamic execution'],
    ['import os; compile = os.unlink; compile(path)', 'os.unlink'],
    ['import os; compile(os.unlink(path), "<cell>", "exec")', 'os.unlink'],
    ['import os; compile("1", os.unlink(path), "eval")', 'os.unlink'],
    ['def compile(code):\n    exec(code)\ncompile(code)', 'compile: exec dynamic execution']
  ])('retains execution review around Python compilation: %s', async (source, operation) => {
    expect(await analyzeNotebookCodeRisk('python', source)).toEqual([
      expect.objectContaining({ operation })
    ])
  })

  it.each([
    ['exec.__call__(compiled)', 'exec dynamic execution'],
    ['import builtins; builtins.exec.__call__(compiled)', 'builtins.exec dynamic execution'],
    ['getattr(exec, "__call__")(compiled)', 'exec dynamic execution'],
    [
      'import types; fn = types.FunctionType(compiled, globals()); fn.__call__()',
      'dynamic call target'
    ],
    ['import types; types.FunctionType(compiled, globals()).__call__()', 'dynamic call target'],
    [
      'import types; fn = types.FunctionType(compiled, globals()); getattr(fn, "__call__")()',
      'dynamic call target'
    ],
    ['import os; fn = os.unlink; fn.__call__.__call__(path)', 'os.unlink'],
    ['import os; fn = os.unlink.__call__; fn(path)', 'os.unlink'],
    ['def work():\n    exec(compiled)\nwork.__call__()', 'work: exec dynamic execution']
  ])(
    'reviews explicit Python callable invocation after compilation: %s',
    async (source, operation) => {
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([
        expect.objectContaining({ operation })
      ])
    }
  )

  it.each([
    'compile.__call__("1", "<cell>", "eval")',
    'import builtins; getattr(builtins.compile, "__call__")("1", "<cell>", "eval")',
    'reader = open(path).read; reader.__call__()',
    'def read():\n    return open(path).read()\nread.__call__()',
    'import types; compiled = compile("print(1)", "<cell>", "exec"); fn = types.FunctionType(compiled, globals())'
  ])('preserves ordinary Python compilation and explicit reader calls: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
  })

  it('retains compilation and execution aliases across Python cells', async () => {
    const definition =
      'from builtins import compile as prepare, exec as run\ncompiled = prepare("os.unlink(path)", "<cell>", "exec")'
    expect(await analyzeNotebookCodeRisk('python', definition)).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('python', 'print(compiled.co_names)', undefined, [definition])
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('python', 'run(compiled)', undefined, [definition])
    ).toEqual([{ operation: 'builtins.exec dynamic execution', source: 'run(compiled)', line: 1 }])
  })

  it.each([
    'quote(unlink("data.txt"))',
    'base::quote(file.remove("data.txt"))',
    'expression(unlink("a.txt"), file.remove("b.txt"))',
    'base::expression(source("cleanup.R"))',
    'q <- base::quote; q(unlink("data.txt"))',
    'saved <- expression; expression <- identity; saved(unlink("data.txt"))',
    'reader <- mean; quote(reader <- unlink); reader(1:3)',
    'reader <- mean; expression(reader <- function(x) unlink(x)); reader(1:3)',
    'print(base::eval); saved <- base::do.call',
    'parse(text="unlink(path)"); call("unlink", "data.txt")',
    'eval <- identity; eval(1)',
    'evalq <- identity; evalq(1)'
  ])('keeps R expression construction and function data unevaluated: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('r', source)).toEqual([])
  })

  it.each([
    ['base::eval(parse(text="unlink(path)"))', 'base::eval'],
    ['base:::eval(expr)', 'base::eval'],
    ['base::evalq(action(path), envir=list(action=unlink, path="data.txt"))', 'base::evalq'],
    ['evalq(action(path), envir=list(action=unlink, path="data.txt"))', 'evalq'],
    ['base::eval.parent(expr)', 'base::eval.parent'],
    ['eval.parent(expr)', 'eval.parent'],

    ['base::do.call("unlink", list("data.txt"))', 'unlink'],
    ['base::source("cleanup.R")', 'base::source'],
    ['base::sys.source("cleanup.R", envir=new.env())', 'base::sys.source'],
    ['sys.source("cleanup.R", envir=new.env())', 'sys.source'],
    ['runner <- base::eval; runner(expr)', 'base::eval'],
    ['lapply(expressions, base::eval)', 'base::eval'],
    ['eval <- identity; base::eval(expr)', 'base::eval'],
    ['base::eval(quote(unlink("data.txt")))', 'base::eval']
  ])(
    'reviews R expression execution through the resolved entry point: %s',
    async (source, target) => {
      expect(await analyzeNotebookCodeRisk('r', source)).toEqual([
        expect.objectContaining({
          operation: target === 'unlink' ? target : `${target} dynamic execution`
        })
      ])
    }
  )

  it.each([
    ['erase <- unlink; quote(erase <- identity)', 'erase("data.txt")'],
    ['erase <- unlink; expression(erase <- identity)', 'erase("data.txt")'],
    ['quote <- unlink', 'quote("data.txt")'],
    ['expression <- unlink', 'expression("data.txt")']
  ])('preserves R callable bindings when syntax is only quoted: %s', async (definition, source) => {
    expect(await analyzeNotebookCodeRisk('r', definition)).toEqual([])
    expect(await analyzeNotebookCodeRisk('r', source, undefined, [definition])).toEqual([
      expect.objectContaining({ operation: 'unlink' })
    ])
  })

  it.each([
    'const cp = require("node:child_process"); cp.fork(script)',
    'const cp = require("child_process"); cp["fork"](script)',
    'const { fork: launch } = require("node:child_process"); launch(script)',
    'import { fork as launch } from "child_process"; launch(script)',
    'const cp = require("child_process"); const launch = cp.fork.bind(cp, script); launch()',
    'const cp = require("child_process"); cp.fork.call(cp, script)',
    'const cp = require("child_process"); cp.fork.apply(cp, [script])',
    'const cp = require("child_process"); Reflect.apply(cp.fork, cp, [script])',
    'const cp = require("child_process"); scripts.forEach(cp.fork)'
  ])('reviews Node fork execution through resolved callables: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([
      expect.objectContaining({
        operation: expect.stringMatching(/child_process\.fork nested execution$/)
      })
    ])
  })

  it.each([
    'const cp = require("child_process"); const launch = cp.fork',
    'const cp = require("node:child_process"); console.log(cp.fork.name)',
    'const cp = require("child_process"); const launch = cp.fork.bind(cp, "worker.cjs")',
    'const cp = require("child_process"); const functions = [cp.fork]; console.log(functions.length)',
    'function fork(value) { return value + 1 }; fork(1)',
    'const {fork: original} = require("child_process"); let launch = original; launch = Number; launch("1")'
  ])(
    'does not confuse Node fork references and ordinary data with process execution: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([])
    }
  )

  it('retains dynamically imported Node fork namespaces after import review', async () => {
    const definition = 'const cp = await import("node:child_process")'
    // Loading a module retains its existing review; its returned namespace must still be tracked.
    expect(await analyzeNotebookCodeRisk('repl', definition)).toEqual([
      { operation: 'dynamic call target', source: 'import("node:child_process")', line: 1 }
    ])
    expect(
      await analyzeNotebookCodeRisk('repl', 'cp.fork(script)', undefined, [definition])
    ).toEqual([
      { operation: 'node:child_process.fork nested execution', source: 'cp.fork(script)', line: 1 }
    ])
    expect(await analyzeNotebookCodeRisk('repl', `${definition}; cp.fork(script)`)).toEqual([
      { operation: 'dynamic call target', source: 'import("node:child_process")', line: 1 },
      { operation: 'node:child_process.fork nested execution', source: 'cp.fork(script)', line: 1 }
    ])
  })

  it('retains saved Node fork identities across cells after rebinding', async () => {
    const definition =
      'const cp = require("node:child_process"); let launch = cp.fork; const saved = launch; launch = Number'
    expect(await analyzeNotebookCodeRisk('repl', definition)).toEqual([])
    expect(await analyzeNotebookCodeRisk('repl', 'launch("1")', undefined, [definition])).toEqual(
      []
    )
    expect(await analyzeNotebookCodeRisk('repl', 'saved(script)', undefined, [definition])).toEqual(
      [{ operation: 'node:child_process.fork nested execution', source: 'saved(script)', line: 1 }]
    )
  })

  it.each([
    'Array.from(paths, fs.unlinkSync)',
    'globalThis.Array.from(paths, fs.unlinkSync)',
    'const { from: collect } = Array; collect(paths, fs.unlinkSync)',
    'const A = Array; A["from"](paths, fs.unlinkSync)',
    'Array.from.call(Array, paths, fs.unlinkSync)',
    'Array.from.apply(Array, [paths, fs.unlinkSync])',
    'Reflect.apply(Array.from, Array, [paths, fs.unlinkSync])',
    'const collect = Array.from.bind(Array); collect(paths, fs.unlinkSync)',
    'const collect = Array.from.bind(Array, paths, fs.unlinkSync); collect()',
    'Array.from(...args)',
    'Array.from(...items, Number)',
    'Array.from(paths, ...callbacks)',
    'Array.from.call(...args)',
    'Array.from.apply(Array, args)',
    'Reflect.apply(Array.from, Array, [...args, Number])'
  ])('reviews invoked Array.from mapping callbacks: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', `const fs = require("fs"); ${source}`)).toEqual([
      expect.objectContaining({ operation: expect.stringMatching(/fs.unlinkSync|dynamic/) })
    ])
  })

  it.each([
    'Array.from(["1", "2"], Number)',
    'Array.from([fs.unlinkSync])',
    'Array.from(values, undefined, fs.unlinkSync)',
    'Array.from(values, Number, fs.unlinkSync)',
    'Array.from(values, Number, null, fs.unlinkSync)',
    'Array.from(values, null)',
    'Array.from(values, { callback: fs.unlinkSync })',
    'Array.from.apply(Array, [values, , fs.unlinkSync])',
    'Reflect.apply(Array.from, Array, [values, Number, fs.unlinkSync])',
    'const collect = Array.from.bind(Array, values, fs.unlinkSync)',
    'function from(value) { return value }; from(fs.unlinkSync)',
    'const Array = { from: Number }; Array.from("1")',
    'Array.from(values, Number, ...context)'
  ])('preserves ordinary Array.from mapping and non-invoked data: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', `const fs = require("fs"); ${source}`)).toEqual([])
  })

  it('retains Array.from callbacks across cells and function rebinding', async () => {
    const definition =
      'const fs = require("fs"); function erase(path) { fs.unlinkSync(path) }; const saved = erase; erase = Number; const collect = Array.from'
    expect(await analyzeNotebookCodeRisk('repl', definition)).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'collect(values, erase)', undefined, [definition])
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'collect(paths, saved)', undefined, [definition])
    ).toEqual([{ operation: 'erase: fs.unlinkSync', source: 'collect(paths, saved)', line: 1 }])
  })

  it.each(['nlargest', 'nsmallest'])(
    'reviews heapq %s key invocation without confusing data',
    async (method) => {
      for (const call of [
        `heapq.${method}(1, paths, key=os.unlink)`,
        `heapq.${method}(1, paths, os.unlink)`,
        `heapq.${method}(key=os.unlink, iterable=paths, n=1)`,
        `pick = heapq.${method}\npick(1, paths, os.unlink)`,
        `from heapq import ${method} as pick\npick(1, paths, key=os.unlink)`
      ]) {
        expect(await analyzeNotebookCodeRisk('python', `import heapq, os\n${call}`)).toEqual([
          expect.objectContaining({ operation: 'os.unlink' })
        ])
      }
      for (const call of [
        `heapq.${method}(1, ["ab", "c"], key=len)`,
        `heapq.${method}(1, ["ab", "c"], len)`,
        `heapq.${method}(1, values, key=None)`,
        `heapq.${method}(1, [os.unlink])`,
        `heapq.${method}(n=1, iterable=[os.unlink])`,
        `from operator import itemgetter\nheapq.${method}(2, records, key=itemgetter(0))`,
        `saved = heapq.${method}\nprint(saved.__name__)`,
        `def ${method}(n, values, key=None):\n    return values\n${method}(1, values, os.unlink)`
      ]) {
        expect(await analyzeNotebookCodeRisk('python', `import heapq, os\n${call}`)).toEqual([])
      }
    }
  )

  it.each(['nlargest', 'nsmallest'])(
    'retains heapq %s key summaries across cells',
    async (method) => {
      const definition = `import os\nfrom heapq import ${method} as pick\ndef erase(path):\n    os.unlink(path)\nsaved = erase\nerase = len`
      expect(await analyzeNotebookCodeRisk('python', definition)).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'pick(1, paths, erase)', undefined, [definition])
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', 'pick(1, paths, saved)', undefined, [definition])
      ).toEqual([{ operation: 'erase: os.unlink', source: 'pick(1, paths, saved)', line: 1 }])
    }
  )

  it.each([
    ['bash', 'fc'],
    ['bash', 'fc -s'],
    ['bash', 'fc -s old=new'],
    ['bash', 'fc -e - -1'],
    ['bash', 'fc -ls'],
    ['bash', 'builtin fc -s'],
    ['bash', 'command fc -s'],
    ['bash', 'env bash -c "fc -s"'],
    ['bash', 'enable -f ./plugin.so plugin'],
    ['bash', 'enable -nf./plugin.so plugin'],
    ['bash', 'builtin enable -f "$plugin" plugin'],
    ['python', 'import bisect, os; bisect.bisect_left(paths, 1, key=os.unlink)'],
    ['python', 'import bisect, os; bisect.bisect_right(paths, 1, key=os.unlink)'],
    ['python', 'import bisect, os; bisect.bisect(paths, 1, key=os.unlink)'],
    ['python', 'import bisect, os; bisect.insort_left(paths, path, key=os.unlink)'],
    ['python', 'import bisect, os; bisect.insort_right(paths, path, key=os.unlink)'],
    ['python', 'from bisect import insort as put; import os; put(paths, path, key=os.unlink)'],
    ['python', 'import os; sorted(paths, **{"key": os.unlink})'],
    ['python', 'import os; min(paths, **{"key": os.unlink})'],
    ['python', 'import os; max(paths, **{"key": os.unlink})'],
    ['python', 'import heapq, os; heapq.nlargest(1, paths, **{"key": os.unlink})'],
    ['python', 'import bisect, os; bisect.insort([], path, **{"key": os.unlink})'],
    ['python', 'import os; sorted(paths, **{**{"key": os.unlink}})'],
    ['python', 'import os; sorted(paths, **{"key": len, **{"key": os.unlink}})'],
    ['python', 'sorted(paths, **options)'],
    ['python', 'sorted(paths, **{name: callback})'],
    ['r', 'mapply(unlink, paths)'],
    ['r', 'base::mapply("unlink", paths)'],
    ['r', 'mapply(paths, F=unlink)'],
    ['r', 'pick <- mapply; pick(unlink, paths)'],
    ['r', '.mapply(unlink, list(paths), NULL)'],
    ['r', 'eapply(env, unlink)'],
    ['r', 'base::eapply(FUN=unlink, env=env)'],
    ['r', 'eapply(unlink, env=env)'],
    ['r', 'tapply(paths, groups, unlink)'],
    ['r', 'base::tapply(INDEX=groups, X=paths, FUN="unlink")'],
    ['r', 'tapply(unlink, X=paths, INDEX=groups)']
  ] as const)('batch reviews hidden execution in %s: %s', async (language, source) => {
    expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
  })

  it.each([
    ['bash', 'fc -l'],
    ['bash', 'fc -lnr -10'],
    ['bash', 'fc -l -- -1'],
    ['bash', 'fc -l rm'],
    ['bash', 'fc -l -e rm'],
    ['bash', 'builtin fc -l'],
    ['bash', 'enable'],
    ['bash', 'enable -p'],
    ['bash', 'enable -n test'],
    ['bash', 'enable -a'],
    ['bash', 'enable -- -f'],
    ['bash', 'command -v fc'],
    ['python', 'import bisect; bisect.bisect_left(["a", "bb"], 2, key=len)'],
    ['python', 'import bisect; bisect.insort([], "a", key=len)'],
    ['python', 'import bisect, os; bisect.insort([], os.unlink)'],
    ['python', 'import bisect; bisect.bisect([1, 2], 2, key=None)'],
    ['python', 'import os; sorted(paths, **{"key": len, "reverse": True})'],
    ['python', 'import os; min([], **{"default": os.unlink})'],
    ['python', 'import os; sorted(paths, **{"key": os.unlink, "key": len})'],
    ['python', 'import os; sorted(paths, **{"key": os.unlink, **{"key": len}})'],
    ['python', 'sorted(paths, **{**options, "key": len})'],
    ['python', 'sorted(paths, key=len, **options)'],
    ['python', 'sorted(paths, key=(None))'],
    ['python', 'import heapq; heapq.nlargest(1, paths, (None))'],
    ['python', 'def sorted(data, **options):\n    return data\nsorted(paths, **options)'],
    ['r', 'mapply(sum, 1:3, 4:6)'],
    ['r', '.mapply(sum, list(1:3), NULL)'],
    ['r', 'mapply(identity, list(unlink))'],
    ['r', 'eapply(env, length)'],
    ['r', 'eapply(length, env=env)'],
    ['r', 'tapply(values, groups, mean)'],
    ['r', 'tapply(values, groups, NULL)'],
    ['r', 'tapply(values, groups, (NULL))'],
    ['r', 'tapply(values, groups)'],
    ['r', 'tapply(values, groups, identity, default=unlink)'],
    ['r', 'saved <- mapply; print(saved)']
  ] as const)('batch preserves ordinary %s data and inspection: %s', async (language, source) => {
    expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
  })

  it.each([
    ['Array.fromAsync', 'values, CALLBACK'],
    ['Object.groupBy', 'values, CALLBACK'],
    ['Map.groupBy', 'values, CALLBACK'],
    ['values.findLast', 'CALLBACK'],
    ['values.findLastIndex', 'CALLBACK']
  ])('batch tracks %s callbacks through aliases and forwarding', async (target, args) => {
    for (const invocation of [
      `${target}(${args})`,
      `const run = ${target}; run(${args})`,
      `${target}.call(null, ${args})`,
      `Reflect.apply(${target}, null, [${args}])`,
      `const run = ${target}.bind(null); run(${args})`
    ]) {
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          `const fs = require("fs"); ${invocation.replace('CALLBACK', 'fs.unlinkSync')}`
        )
      ).toEqual([expect.objectContaining({ operation: 'fs.unlinkSync' })])
      expect(
        await analyzeNotebookCodeRisk('repl', invocation.replace('CALLBACK', 'Number'))
      ).toEqual([])
    }
    expect(
      await analyzeNotebookCodeRisk(
        'repl',
        `const fs = require("fs"); const run = ${target}.bind(null, ${args.replace('CALLBACK', 'fs.unlinkSync')})`
      )
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk(
        'repl',
        `const fs = require("fs"); const run = ${target}.bind(null, ${args.replace('CALLBACK', 'fs.unlinkSync')}); run()`
      )
    ).not.toEqual([])
  })

  it.each([
    [
      'python',
      'import os, bisect\ndef erase(path):\n    os.unlink(path)\nsaved = erase\nerase = len',
      'bisect.insort([], path, **{"key": saved})'
    ],
    ['r', 'erase <- unlink; saved <- erase; erase <- length', 'mapply(saved, paths)'],
    ['r', 'erase <- unlink; saved <- erase; erase <- length', 'tapply(paths, groups, saved)'],
    [
      'repl',
      'const fs = require("fs"); let erase = fs.unlinkSync; const saved = erase; erase = Number',
      'Object.groupBy(paths, saved)'
    ]
  ] as const)(
    'batch retains saved %s callback effects across cells',
    async (language, definition, call) => {
      expect(await analyzeNotebookCodeRisk(language, definition)).toEqual([])
      expect(await analyzeNotebookCodeRisk(language, call, undefined, [definition])).not.toEqual([])
    }
  )

  it('allows creating and reading the temporary test files from the reported false positive', async () => {
    const source = `import os
import time

# Generate a unique directory name based on timestamp
unique_name = f"tmp_test_{int(time.time() * 1000)}"
tmp_dir = os.path.join(os.getcwd(), unique_name)
os.makedirs(tmp_dir, exist_ok=True)

# Create a.txt and b.txt with content "test"
for filename in ("a.txt", "b.txt"):
    with open(os.path.join(tmp_dir, filename), "w") as f:
        f.write("test")

abs_path = os.path.abspath(tmp_dir)
print(f"临时目录绝对路径: {abs_path}")
print(f"目录内容: {os.listdir(tmp_dir)}")
print(f"a.txt 内容: {open(os.path.join(abs_path, 'a.txt')).read()!r}")
print(f"b.txt 内容: {open(os.path.join(abs_path, 'b.txt')).read()!r}")`
    expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('python', 'os.unlink(a_path)', undefined, [source])
    ).toMatchObject([{ operation: 'os.unlink', source: 'os.unlink(a_path)', line: 1 }])
  })

  it.each([
    ['python', 'open(path).read().strip().splitlines()'],
    ['python', 'open(path).readline()'],
    ['python', 'open(path).readlines()'],
    ['python', 'import pandas as pd; pd.read_csv(path).dropna().reset_index(drop=True)'],
    ['python', 'import numpy as np; np.arange(12).reshape(3, 4).mean(axis=0)'],
    ['python', 'from pathlib import Path; Path(path).read_text().strip()'],
    ['python', '"{}".format(value)'],
    ['r', 'list(read = readLines)$read(path)'],
    ['repl', '[1, 2, 3].map(x => x + 1).filter(x => x > 1)'],
    ['repl', 'JSON.parse(text).values.map(x => x.name)']
  ] as const)(
    'does not treat a fixed %s member name as dynamic execution: %s',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
    }
  )

  it.each([
    ['python', 'from pathlib import Path; Path(path).resolve().unlink()'],
    ['python', 'factory().rmdir()'],
    ['python', 'open(os.unlink(path)).read()'],
    ['python', 'getattr(os, method)(path).read()'],
    ['python', 'import subprocess; subprocess.Popen(command).communicate()'],
    ['python', 'factory()(path)'],
    ['python', 'handlers[method](path)'],
    ['r', 'get(method)(path)'],
    ['r', 'handlers[[method]](path)'],
    ['r', 'factory()$unlink(path)'],
    ['repl', 'factory().unlinkSync(path)'],
    ['repl', 'factory()[method](path)'],
    ['repl', 'factory()(path)'],
    ['repl', '[1].map(() => require("fs").unlinkSync(path))']
  ] as const)(
    'still reviews deletion or dynamic execution within %s chains: %s',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
    }
  )

  it('allows the second reported create-and-read script', async () => {
    const source = `import os
import time

unique_name = f"tmp_erase_{int(time.time() * 1000)}"
tmp_dir = os.path.join(os.getcwd(), unique_name)
os.makedirs(tmp_dir, exist_ok=True)

test_file = os.path.join(tmp_dir, "test_file.txt")
with open(test_file, "w") as f:
    f.write("to be erased")

abs_path = os.path.abspath(tmp_dir)
print(f"测试目录绝对路径: {abs_path}")
print(f"测试文件路径: {test_file}")
print(f"测试文件存在: {os.path.isfile(test_file)}")
print(f"文件内容: {open(test_file).read()!r}")`
    expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
    expect(await analyzeNotebookCodeRisk('python', source, undefined, [source])).toEqual([])
  })

  it.each([
    ['python', 'with open(path) as f:\n    lines = [line.strip() for line in f]'],
    ['python', 'from pathlib import Path\nprint(Path(path).read_bytes().decode("utf-8"))'],
    ['python', 'import io\nprint(io.StringIO("a,b\\n1,2").read())'],
    ['python', 'import gzip\nprint(gzip.open(path, "rt").read())'],
    ['python', 'import json\nprint(json.loads(open(path).read()).get("results", []))'],
    ['python', 'import pandas as pd\npd.read_csv(path)["value"].dropna().mean()'],
    ['python', 'import pandas as pd\npd.DataFrame({"x": [1, 2]}).assign(y=lambda df: df.x * 2)'],
    ['python', 'import numpy as np\nnp.array([1, 2, 3]).astype(float).tolist()'],
    ['python', 'print([open(p).read() for p in paths])'],
    ['python', 'read = open(path).read\nprint(read())'],
    ['python', '# os.unlink(path)\nprint("rm -rf; os.remove; eval")'],
    ['python', '(print)("hello")'],
    ['python', '((open))(path).read()'],
    ['python', '(lambda x: x + 1)(2)'],
    ['r', 'read.csv(path)$value |> mean(na.rm = TRUE)'],
    ['r', 'data <- read.csv(path); data$value <- as.numeric(data$value)'],
    ['r', 'lapply(paths, function(path) readLines(path))'],
    ['r', 'dir.create(path); writeLines("test", file.path(path, "a.txt"))'],
    ['r', 'rm(list = ls()); gc()'],
    ['r', 'print("unlink(path)") # file.remove(path)'],
    ['r', '(mean)(1:3)'],
    ['r', '(function(x) x + 1)(2)'],
    ['repl', 'const fs = require("node:fs"); fs.readFileSync(path, "utf8").trim()'],
    ['repl', 'const fs = require("node:fs/promises"); (await fs.readFile(path, "utf8")).trim()'],
    ['repl', 'new Map([["x", 1]]).get("x")'],
    ['repl', 'JSON.parse(text).rows?.map(row => row.value)'],
    ['repl', 'console.log(`contents: ${buffer.toString("utf8")}`)'],
    ['repl', 'const values = new Set([1, 2]); values.delete(1); values.clear()'],
    ['repl', 'await host.artifacts.save({name: "result.txt", content: values.join("\\n")})'],
    ['repl', '(console.log)("hello")'],
    ['repl', '(() => [1, 2].map(x => x * 2))()'],
    ['repl', '(function () { return JSON.parse(text) })()'],
    ['bash', 'printf "%s\\n" "rm -rf"; cat data.csv | head -n 5'],
    ['bash', 'find . -type f -name "*.csv"'],
    ['bash', 'for file in *.csv; do wc -l "$file"; done'],
    ['bash', 'test -f data.csv && cat data.csv'],
    ['bash', "cat <<'EOF'\nrm -rf data\nEOF"],
    ['bash', 'git status --short; git diff --stat; git log -1'],
    ['bash', 'cat data.csv 2>&1'],
    ['bash', 'cat data.csv 1>&2'],
    ['bash', 'cat data.csv >/dev/null'],
    ['bash', 'cat data.csv >"/dev/null" 2>&1'],
    ['bash', 'git log --grep clean'],
    ['bash', 'git diff -- restore'],
    ['bash', 'git show HEAD:clean'],
    ['bash', 'git -C repo log --grep restore'],
    ['bash', 'git -c core.pager=cat diff -- clean'],
    ['bash', 'cat data.csv &>/dev/null'],
    ['bash', 'cat data.csv >|/dev/null'],
    ['bash', 'cat data.csv 3>&-'],
    ['bash', 'cat data.csv 2>&1-']
  ] as const)('allows ordinary %s analysis: %s', async (language, source) => {
    expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
  })

  it.each([
    ['python', '(os.unlink)(path)'],
    ['python', '(lambda path: os.unlink(path))(path)'],
    ['python', '(getattr(os, method))(path)'],
    ['python', '[open(os.unlink(p)).read() for p in paths]'],
    ['python', 'import pandas as pd\npd.DataFrame({"x": [1]}).apply(lambda row: os.unlink(path))'],
    ['python', 'erase = Path(path).unlink\nerase()'],
    ['r', '(base::unlink)(path)'],
    ['r', '(function(x) unlink(x))(path)'],
    ['r', 'lapply(paths, function(path) unlink(path))'],
    ['r', '(get(method))(path)'],
    ['repl', '(require("node:fs").unlinkSync)(path)'],
    ['repl', '(() => require("fs").rmSync(path))()'],
    ['repl', '(function () { require("fs").unlinkSync(path) })()'],
    ['repl', 'const fs = require("fs"); fs[method](path)'],
    ['repl', 'const erase = require("fs").unlinkSync; (erase)(path)'],
    ['bash', 'cat data.csv > output.csv'],
    ['bash', 'cat data.csv 2> errors.log'],
    ['bash', 'cat data.csv &> output.csv'],
    ['bash', 'cat data.csv >| output.csv'],
    ['bash', 'cat data.csv >& output.csv'],
    ['bash', 'cat data.csv > "$(rm data.csv)"'],
    ['bash', 'git "$command"'],
    ['bash', 'git -C "$repo" clean -fd'],
    ['bash', 'cat data.csv > "$destination"'],
    ['bash', 'cat data.csv > /dev/null; rm data.csv'],
    ['bash', 'echo "$(rm data.csv)" >/dev/null'],
    ['bash', 'git -C repo reset --hard'],
    ['bash', 'git --git-dir=.git clean -fd'],
    ['bash', 'git -c core.pager=cat restore -- data.csv'],
    ['bash', 'git checkout HEAD -- data.csv'],
    ['bash', 'cat <<EOF\n$(rm data.csv)\nEOF']
  ] as const)(
    'still reviews %s effects in ordinary-looking syntax: %s',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
    }
  )

  it.each([
    ['python', '(os.unlink)(path)', 'os.unlink'],
    ['python', '(lambda path: os.unlink(path))(path)', 'os.unlink'],
    ['r', '(function(path) unlink(path))(path)', 'unlink'],
    ['r', 'lapply(paths, function(path) unlink(path))', 'unlink'],
    ['repl', '(() => require("fs").unlinkSync(path))()', 'fs.unlinkSync']
  ] as const)(
    'identifies the actual %s effect through visible function syntax',
    async (language, source, operation) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([
        expect.objectContaining({ operation, line: 1 })
      ])
    }
  )

  it('reviews each later call of a destructive function, rather than granting its definition', async () => {
    const definition = 'import os\ndef cleanup():\n    os.unlink("x")'
    expect(await analyzeNotebookCodeRisk('python', definition)).toEqual([])
    for (let index = 0; index < 2; index++) {
      expect(
        await analyzeNotebookCodeRisk('python', 'cleanup()', undefined, [definition])
      ).toMatchObject([{ operation: 'cleanup: os.unlink', line: 1 }])
    }
  })

  it('uses prior import aliases only when they have not been replaced', async () => {
    expect(
      await analyzeNotebookCodeRisk('python', 'erase("x")', undefined, [
        'from os import unlink as erase'
      ])
    ).not.toEqual([])
    expect(
      await analyzeNotebookCodeRisk('python', 'erase("x")', undefined, [
        'from os import unlink as erase',
        'erase = print'
      ])
    ).toEqual([])
  })

  it.each([
    ['r', 'cleanup <- function(x) { base::unlink(x) }', 'cleanup("x")'],
    ['repl', 'import fs from "node:fs"; const cleanup = (x) => fs.unlinkSync(x)', 'cleanup("x")'],
    ['repl', 'import {rm as erase} from "fs/promises"', 'erase("x")'],
    ['bash', 'cleanup() { rm -rf x; }', 'cleanup']
  ] as const)(
    'recognizes a later %s helper or import alias',
    async (language, previous, source) => {
      expect(await analyzeNotebookCodeRisk(language, previous)).toEqual([])
      expect(await analyzeNotebookCodeRisk(language, source, undefined, [previous])).not.toEqual([])
    }
  )

  it.each([
    ['python', 'import os\ncleanup = lambda p: os.unlink(p)', 'cleanup(path)'],
    ['python', 'import os\ncleanup = (lambda p: os.unlink(p))', 'cleanup(path)'],
    [
      'python',
      'import os\ndef cleanup(p):\n    os.unlink(p)\nerase = cleanup\ndef cleanup(p):\n    print(p)',
      'erase(path)'
    ],
    [
      'r',
      'cleanup <- function(p) unlink(p); erase <- cleanup; cleanup <- function(p) print(p)',
      'erase(path)'
    ],
    [
      'repl',
      'const fs = require("fs"); let cleanup = p => fs.unlinkSync(p); const erase = cleanup; cleanup = p => console.log(p)',
      'erase(path)'
    ],
    ['python', 'import os\ndef cleanup(p):\n    os.unlink(p)', 'list(map(cleanup, paths))'],
    ['r', 'cleanup <- function(p) unlink(p)', 'lapply(paths, cleanup)'],
    ['r', 'cleanup <- function(p) unlink(p)', 'base::lapply(X=paths, FUN=cleanup)'],
    [
      'repl',
      'const fs = require("fs"); const cleanup = p => fs.unlinkSync(p)',
      'paths.forEach(cleanup)'
    ]
  ] as const)(
    'reviews deferred %s effects when actually invoked: %s',
    async (language, definition, call) => {
      expect(await analyzeNotebookCodeRisk(language, definition)).toEqual([])
      expect(await analyzeNotebookCodeRisk(language, call, undefined, [definition])).not.toEqual([])
      expect(await analyzeNotebookCodeRisk(language, `${definition}\n${call}`)).not.toEqual([])
    }
  )

  it.each([
    [
      'python',
      'def summarize(values):\n    return sum(values) / len(values)',
      'list(map(summarize, groups))'
    ],
    ['r', 'formatter <- function(x) sprintf("%.1f%%", x * 100)', 'lapply(1:3, formatter)'],
    [
      'repl',
      'const summarize = values => values.reduce((sum, n) => sum + n, 0)',
      'groups.map(summarize)'
    ],
    [
      'python',
      'import os\ndef cleanup(p):\n    os.unlink(p)\ndef cleanup(p):\n    print(p)',
      'cleanup(path)'
    ],
    ['r', 'cleanup <- function(p) unlink(p); cleanup <- function(p) print(p)', 'cleanup(path)'],
    [
      'repl',
      'const fs = require("fs"); let cleanup = p => fs.unlinkSync(p); cleanup = p => console.log(p)',
      'cleanup(path)'
    ]
  ] as const)('allows ordinary or replaced %s helpers', async (language, definition, call) => {
    expect(await analyzeNotebookCodeRisk(language, `${definition}\n${call}`)).toEqual([])
    expect(await analyzeNotebookCodeRisk(language, call, undefined, [definition])).toEqual([])
  })

  it.each([
    ['python', 'import os\nlist(map(os.unlink, paths))'],
    ['r', 'lapply(paths, unlink)'],
    ['r', 'lapply(paths, "unlink")'],
    ['r', 'Map(f=unlink, paths)'],
    ['r', 'lapply(paths, callbacks[[choice]])'],
    ['python', 'list(map(handlers[name], paths))'],
    ['repl', 'paths.forEach(handlers[name])'],
    ['r', 'vapply(X=paths, FUN=file.remove, FUN.VALUE=logical(1))'],
    ['repl', 'const fs = require("fs"); paths.forEach(fs.unlinkSync)'],
    ['repl', '(function cleanup() { require("fs").unlinkSync(path) })()'],
    ['bash', 'command rm data.csv'],
    ['bash', 'command -p rm data.csv'],
    ['bash', 'command -- rm data.csv'],
    ['bash', 'command "$operation" data.csv'],
    ['bash', 'command -v "$(rm data.csv)"'],
    ['bash', 'sed -i "s/old/new/" data.csv'],
    ['bash', 'sed -i.bak "s/old/new/" data.csv'],
    ['bash', 'sed --in-place=.bak "s/old/new/" data.csv'],
    ['bash', 'sed -n -i "s/old/new/p" data.csv'],
    ['bash', 'sed -ni "s/old/new/p" data.csv'],
    ['bash', 'tee data.csv'],
    ['bash', 'tee --output-error=exit data.csv'],
    ['bash', 'tee "$destination"'],
    ['bash', 'command sed -i "s/a/b/" data.csv']
  ] as const)('reviews actual %s callback or shell effects: %s', async (language, source) => {
    expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
  })

  it.each([
    'command -v conda || true; command -v micromamba || true; command -v module || true; command -v sbatch || true',
    'command -v rm',
    'command -V rm',
    'command -pv rm',
    'command -v "$tool"',
    'command -- cat data.csv',
    'command -p ls',
    'sed "s/old/new/" data.csv',
    'sed -n "1,5p" data.csv',
    'sed -n "1,5p" "$input_file"',
    'sed -e "$expression" "$input_file"',
    'sed -e "s/a/b/" -- -i',
    'sed -e -i data.csv',
    'tee',
    'tee /dev/null',
    'tee -a data.csv',
    'tee --append data.csv'
  ])('allows shell discovery and non-truncating commands: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
  })

  it.each([
    [
      'python',
      'import os\ncleanup = lambda p: os.unlink(p)',
      'map(cleanup, paths)',
      'cleanup: os.unlink'
    ],
    ['r', 'cleanup <- function(p) unlink(p)', 'lapply(paths, cleanup)', 'cleanup: unlink'],
    [
      'repl',
      'const fs = require("fs"); const cleanup = p => fs.unlinkSync(p)',
      'paths.forEach(cleanup)',
      'cleanup: fs.unlinkSync'
    ]
  ] as const)(
    'reports the actual %s helper effect at its current invocation',
    async (language, definition, call, operation) => {
      expect(await analyzeNotebookCodeRisk(language, call, undefined, [definition])).toEqual([
        { operation, source: call, line: 1 }
      ])
    }
  )

  it.each([
    'import os\ndef summarize(value=os.unlink(path)):\n    return value',
    'import os\nsummarize = lambda value=os.unlink(path): value'
  ])('reviews Python default expressions at definition time: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('python', source)).toMatchObject([
      { operation: 'os.unlink' }
    ])
  })

  it.each([
    ['r', 'summarize <- function(value=unlink(path)) value', 'summarize()'],
    [
      'repl',
      'const fs = require("fs"); const summarize = (value=fs.unlinkSync(path)) => value',
      'summarize()'
    ]
  ] as const)(
    'reviews deferred %s default expressions on invocation',
    async (language, source, call) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
      expect(await analyzeNotebookCodeRisk(language, call, undefined, [source])).not.toEqual([])
    }
  )

  it.each([
    ['python', 'list(filter(None, [1, None, 2]))'],
    ['r', 'lapply(1:3, "mean")']
  ] as const)('allows ordinary %s callback selectors', async (language, source) => {
    expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
  })

  it.each([
    ['python', 'import os\nerase = getattr(os, method)', 'erase(path)'],
    ['python', 'erase = handlers[method]', 'erase(path)'],
    ['python', 'erase = factory()', 'erase(path)'],
    ['python', 'erase = handlers[method]\ncopy = erase', 'copy(path)'],
    ['r', 'erase <- get(method)', 'erase(path)'],
    ['r', 'erase <- handlers[[method]]', 'erase(path)'],
    ['repl', 'const erase = handlers[method]', 'erase(path)'],
    ['repl', 'const erase = factory()', 'erase(path)'],
    ['repl', 'const erase = flag ? dangerous : ordinary', 'erase(path)'],
    ['repl', 'const erase = handlers[method]; const copy = erase', 'paths.forEach(copy)']
  ] as const)(
    'retains dynamic %s callable evidence through assignments and history',
    async (language, definition, call) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await analyzeNotebookCodeRisk(language, call, undefined, [definition])).toEqual([
          { operation: 'dynamic call target', source: call, line: 1 }
        ])
      }
    }
  )

  it.each([
    ['python', 'frame = load_data()\nframe.dropna().mean()'],
    ['python', 'content = open(path).read()\nprint(content.strip())'],
    ['python', 'reader = open(path).read\nprint(reader())'],
    ['python', 'action = handlers[name]\naction = print\naction("ready")'],
    ['r', 'data <- read.csv(path); print(data$value)'],
    ['r', 'action <- handlers[[name]]; action <- print; action("ready")'],
    ['repl', 'const rows = JSON.parse(text); rows.map(row => row.value)'],
    ['repl', 'let action = handlers[name]; action = console.log; action("ready")'],
    ['repl', 'const fs = require("fs"); fs["readFileSync"](path, "utf8").trim()'],
    ['repl', 'const fs = require("fs"); const read = fs["readFileSync"]; read(path)'],
    ['repl', 'JSON["parse"](text)']
  ] as const)(
    'does not confuse %s data and fixed member aliases with dynamic invocation',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
    }
  )

  it.each([
    ['const fs = require("fs"); fs["unlinkSync"](path)', 'fs.unlinkSync'],
    ['const fs = require("fs"); const erase = fs["unlinkSync"]; erase(path)', 'fs.unlinkSync'],
    ['const fs = require("fs"); fs["promises"]["rm"](path)', 'fs.promises.rm'],
    [
      'const cp = require("child_process"); cp["execSync"](command)',
      'child_process.execSync nested execution'
    ]
  ])('reports the real operation of a fixed bracket call: %s', async (source, operation) => {
    expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([
      expect.objectContaining({ operation })
    ])
  })

  it.each([
    'data <- list(1:3); lapply(mean, X=data)',
    'data <- list(1:3); sapply(mean, X=data)',
    'data <- list(1:3); vapply(mean, X=data, FUN.VALUE=numeric(1))',
    'data <- list(1:3); vapply(F=mean, X=data, FUN.VALUE=numeric(1))',
    'data <- matrix(1:4, 2); apply(mean, X=data, MARGIN=1)',
    'data <- matrix(1:4, 2); apply(1, mean, X=data)',
    'data <- matrix(1:4, 2); apply(data, mean, MARGIN=1)',
    'data <- list(1:3); lapply(X=data, F=mean)',
    'data <- matrix(1:4, 2); apply(X=data, M=1, F=mean)',
    'lapply(X=list(1:3), FUN="mean")'
  ])('matches R collection arguments before selecting the callback: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('r', source)).toEqual([])
  })

  it.each([
    'lapply(unlink, X=paths)',
    'sapply(file.remove, X=paths)',
    'vapply(file.remove, X=paths, FUN.VALUE=logical(1))',
    'vapply(F=file.remove, X=paths, FUN.VALUE=logical(1))',
    'apply(unlink, X=paths, MARGIN=1)',
    'apply(1, unlink, X=paths)',
    'apply(paths, unlink, MARGIN=1)',
    'lapply(X=paths, F=unlink)',
    'apply(X=paths, M=1, F=unlink)',
    'lapply("unlink", X=paths)'
  ])('retains R deletion detection with reordered and partial arguments: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('r', source)).toEqual([
      expect.objectContaining({
        operation: expect.stringMatching(/^(unlink|file\.remove)$/),
        source
      })
    ])
  })

  it.each([
    'find . -name "-delete"',
    'find . -iname "-exec"',
    'find . -path "-execdir"',
    'find . -ipath "-ok"',
    'find . -regex "-okdir"',
    'find . -iregex "-delete"',
    'find . -name "$pattern" -print',
    'find . -printf "-delete"',
    'find . -name "-delete" -o -name "-exec"'
  ])('does not treat a find pattern or format as an action: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
  })

  it.each([
    'find . -name "-delete" -delete',
    'find . -name "-exec" -exec rm {} +',
    'find . -path "-execdir" -execdir rm {} +',
    'find . -regex "$pattern" -delete',
    'find . -name "$(rm data.csv)"',
    'find . -fprint results.txt',
    'find . -fprint0 results.bin',
    'find . -fprintf results.txt "%p"',
    'find . -fls results.txt'
  ])('reviews actual find deletion, execution or output-file truncation: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).not.toEqual([])
  })

  it.each([
    ['python', 'reader, size = open, len\nprint(reader(path).read(), size([1, 2]))'],
    ['python', '(reader, (size, output)) = (open, (len, print))\noutput(reader(path).read())'],
    ['python', '[reader, size] = [open, len]\nreader(path).read()'],
    ['python', 'fig, ax = plt.subplots()\nax.plot([1, 2]); fig.tight_layout()'],
    ['python', 'reader, *rest = (open, 1, 2)\nreader(path).read()'],
    ['python', '*rest, reader = (1, 2, open,)\nreader(path).read()'],
    [
      'repl',
      'const fs = require("fs"); const [read, ...rest] = [fs.readFileSync, 1, 2]; read(path)'
    ],
    ['python', 'import os\nerase = os.unlink\nerase, size = print, len\nerase("ready")'],
    ['repl', 'const fs = require("fs"); const read = fs.readFileSync.bind(fs); read(path, "utf8")'],
    ['repl', 'const fs = require("fs"); fs.readFileSync.bind(fs, path)("utf8")'],
    ['repl', 'const fs = require("fs"); const read = fs["readFileSync"]["bind"](fs); read(path)'],
    [
      'repl',
      'const fs = require("fs"); const read = fs.readFileSync.bind(fs).bind(null); read(path)'
    ],
    ['repl', 'const parse = JSON.parse.bind(JSON); texts.map(parse)'],
    ['repl', 'function size(x) { return x.length }; const bound = size.bind(null); bound([1, 2])'],
    ['repl', 'const fs = require("fs"); const erase = fs.unlinkSync.bind(fs, path)'],
    [
      'repl',
      'const fs = require("fs"); const [read, size] = [fs.readFileSync, Math.abs]; read(path)'
    ],
    [
      'repl',
      'const fs = require("fs"); const [, read] = [fs.unlinkSync, fs.readFileSync]; read(path)'
    ],
    [
      'repl',
      'const fs = require("fs"); let erase = fs.unlinkSync; [erase] = [console.log]; erase("ready")'
    ],
    [
      'repl',
      'const [rows, metadata] = loadData(); rows.map(row => row.value); console.log(metadata)'
    ]
  ] as const)(
    'keeps ordinary %s function binding and destructuring free of prompts: %s',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
    }
  )

  it.each([
    ['python', 'import os\nreader, erase = open, os.unlink', 'erase(path)', 'os.unlink'],
    [
      'python',
      'import os\n(reader, (erase, size)) = (open, (os.unlink, len))',
      'erase(path)',
      'os.unlink'
    ],
    ['python', 'import os\n[reader, erase] = [open, os.unlink]', 'erase(path)', 'os.unlink'],
    [
      'python',
      'import os\nerase, reader = os.unlink, open\nreader, erase = erase, reader',
      'reader(path)',
      'os.unlink'
    ],
    ['python', 'reader, erase = handlers', 'erase(path)', 'dynamic call target'],
    ['python', 'reader, *rest, erase = handlers', 'erase(path)', 'dynamic call target'],
    [
      'repl',
      'const fs = require("fs"); const erase = fs.unlinkSync.bind(fs)',
      'erase(path)',
      'fs.unlinkSync'
    ],
    [
      'repl',
      'const fs = require("fs"); const erase = fs.unlinkSync.bind(fs).bind(null)',
      'erase(path)',
      'fs.unlinkSync'
    ],
    [
      'repl',
      'const fs = require("fs"); function erase(path) { fs.unlinkSync(path) }; const bound = erase.bind(null)',
      'bound(path)',
      'erase: fs.unlinkSync'
    ],
    [
      'repl',
      'const fs = require("fs"); const [read, erase] = [fs.readFileSync, fs.unlinkSync]',
      'erase(path)',
      'fs.unlinkSync'
    ],
    [
      'repl',
      'const fs = require("fs"); const [, erase] = [fs.readFileSync, fs.unlinkSync]',
      'erase(path)',
      'fs.unlinkSync'
    ],
    [
      'repl',
      'const fs = require("fs"); const [unused, erase] = [, fs.unlinkSync]',
      'erase(path)',
      'fs.unlinkSync'
    ],
    [
      'repl',
      'const fs = require("fs"); let [erase, read] = [fs.unlinkSync, fs.readFileSync]; [read, erase] = [erase, read]',
      'read(path)',
      'fs.unlinkSync'
    ],
    ['repl', 'const [read, erase] = handlers', 'erase(path)', 'dynamic call target'],
    ['repl', 'const erase = handlers[name].bind(null)', 'erase(path)', 'dynamic call target'],
    ['repl', 'const erase = factory().bind(null)', 'erase(path)', 'dynamic call target'],
    [
      'repl',
      'const fs = require("fs"); const erase = fs.unlinkSync.bind(fs)',
      'paths.forEach(erase)',
      'fs.unlinkSync'
    ]
  ] as const)(
    'preserves %s callable provenance through binding, destructuring and history',
    async (language, definition, call, operation) => {
      expect(await analyzeNotebookCodeRisk(language, definition)).toEqual([])
      expect(await analyzeNotebookCodeRisk(language, call, undefined, [definition])).toEqual([
        { operation, source: call, line: 1 }
      ])
    }
  )

  it.each([
    ['python', 'import os\n*rest, erase = (open, os.unlink,)', 'os.unlink'],
    ['python', 'import os\nreader, *rest, erase = (open, len, os.unlink)', 'os.unlink'],
    ['python', 'reader, erase = (*handlers,)', 'dynamic call target'],
    ['python', 'import os\n(erase,) = (lambda path: os.unlink(path),)', 'dynamic call target'],
    [
      'repl',
      'const fs = require("fs"); const [erase] = [path => fs.unlinkSync(path)]',
      'dynamic call target'
    ],
    ['repl', 'const fs = require("fs"); const [[erase]] = [[fs.unlinkSync]]', 'fs.unlinkSync'],
    ['repl', 'const fs = require("fs"); const [erase,] = [fs.unlinkSync,]', 'fs.unlinkSync'],
    ['repl', 'const [reader, erase] = [...handlers]', 'dynamic call target'],
    ['repl', 'const bind = method; const erase = handler[bind](null)', 'dynamic call target'],
    [
      'repl',
      'const fs = require("fs"); const erase = paths.forEach.bind(paths, fs.unlinkSync)',
      'dynamic call target'
    ],
    [
      'repl',
      'const fs = require("fs"); const erase = (path => fs.unlinkSync(path)).bind(null)',
      'dynamic call target'
    ]
  ] as const)(
    'retains %s risk evidence through rest patterns and unresolved bound targets',
    async (language, definition, operation) => {
      expect(
        await analyzeNotebookCodeRisk(language, 'erase(path)', undefined, [definition])
      ).toEqual([{ operation, source: 'erase(path)', line: 1 }])
    }
  )

  it('still checks arguments evaluated while binding a function', async () => {
    const source =
      'const fs = require("fs"); const read = fs.readFileSync.bind(fs, fs.unlinkSync(path))'
    expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([
      expect.objectContaining({ operation: 'fs.unlinkSync', source: 'fs.unlinkSync(path)' })
    ])
  })

  it.each([
    'git clean -n',
    'git clean --dry-run',
    'git clean -ndfx',
    'git clean -f -n -- data.csv',
    'git clean --dry-run -e "*.csv"',
    'git clean -ne*.csv',
    'git clean --exclude="-f" -n',
    'git clean --dry"-run"',
    'git clean --exclude="-n" --dry-run',
    'git clean --no-dry-run --dry-run -f',
    'git clean -n -- "$path"',
    'git -C project -c clean.requireForce=false clean -nd',
    'git reset -- --hard',
    'git switch main',
    'git checkout -b feature-clean',
    'git switch -c feature-clean',
    'git checkout -bfeature-clean',
    'git switch -cfeature-clean',
    'git switch --force --no-force main',
    'git checkout --force --no-force main'
  ])('distinguishes Git preview and option values from destructive flags: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
  })

  it.each([
    'git clean -fd',
    'git clean -n --no-dry-run -f',
    'git clean -n --no-"dry-run" -f',
    'git clean -n --no-"$option" -f',
    'git clean -f -- --dry-run',
    'git clean -f -e --dry-run',
    'git clean -fen',
    'git clean -f --exclude=-n',
    'git clean -n $options',
    'git clean -n --no-dry -f',
    'git clean -n -- "$(rm data.csv)"',
    'git checkout -f main',
    'git checkout -qf main',
    'git checkout --force main',
    'git checkout --no-force -f main',
    'git switch -f main',
    'git switch -qf main',
    'git switch --force main',
    'git switch --discard-changes main',
    'git switch --no-force --discard-changes main',
    'git switch --orphan empty',
    'git switch --orphan=empty',
    'git switch -Cmain',
    'git switch --force-create main',
    'git switch --force-create=main',
    'git checkout -Bmain',
    'git checkout -b feature -f',
    'git switch -c feature -f',
    'git checkout -- data.csv',
    'git reset --hard HEAD'
  ])('reviews actual Git deletion or discarded working-tree changes: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).not.toEqual([])
  })

  it.each([
    ['python', 'reader = alias = open\nreader(path).read(); alias(path).read()'],
    ['python', 'reader = alias = third = open\nreader(path).read()'],
    ['python', '(reader := open)(path).read()'],
    ['python', 'import os\nreader = os.unlink\n(reader := open)\nreader(path).read()'],
    ['python', 'import os\nreader = os.unlink\nreader = alias = open\nreader(path).read()'],
    ['python', 'text = (reader := open)(path).read()\nprint(text)'],
    ['r', 'reader <- alias <- readLines; reader(path)'],
    ['r', 'readLines -> reader; reader(path)'],
    ['r', 'readLines -> reader -> alias; reader(path); alias(path)'],
    ['r', 'readLines ->> reader; reader(path)'],
    ['r', 'reader <- unlink; readLines -> reader; reader(path)'],
    ['r', 'reader <- unlink; reader <- # use the reader\nreadLines; reader(path)'],
    ['r', '(reader <- readLines)(path)'],
    ['r', '(readLines -> reader)(path)'],
    [
      'repl',
      'const fs = require("fs"); let reader, alias; reader = alias = fs.readFileSync; reader(path)'
    ],
    [
      'repl',
      'const fs = require("fs"); let reader; const alias = (reader = fs.readFileSync); alias(path)'
    ],
    ['repl', 'const fs = require("fs"); let reader; (reader = fs.readFileSync)(path)'],
    [
      'repl',
      'const fs = require("fs"); let reader = fs.unlinkSync, alias; reader = alias = fs.readFileSync; reader(path)'
    ]
  ] as const)(
    'retains ordinary %s callable identities through assignment expressions: %s',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
    }
  )

  it.each([
    ['python', 'import os\nerase = alias = os.unlink', 'os.unlink'],
    ['python', 'import os\n(erase := os.unlink)', 'os.unlink'],
    ['python', 'import os\nerase = print\n(erase := os.unlink)', 'os.unlink'],
    ['python', 'erase = alias = handlers[method]', 'dynamic call target'],
    ['r', 'erase <- alias <- unlink', 'unlink'],
    ['r', 'unlink -> erase', 'unlink'],
    ['r', 'unlink -> alias -> erase', 'unlink'],
    ['r', 'unlink ->> erase', 'unlink'],
    ['r', 'erase <- print; unlink -> erase', 'unlink'],
    ['r', 'erase <- # selected cleanup\nunlink', 'unlink'],
    ['r', 'unlink -> # selected cleanup\nerase', 'unlink'],
    ['r', 'handlers[[method]] -> erase', 'dynamic call target'],
    [
      'repl',
      'const fs = require("fs"); let erase, alias; erase = alias = fs.unlinkSync',
      'fs.unlinkSync'
    ],
    [
      'repl',
      'const fs = require("fs"); let alias; const erase = (alias = fs.unlinkSync)',
      'fs.unlinkSync'
    ],
    ['repl', 'let erase, alias; erase = alias = handlers[method]', 'dynamic call target']
  ] as const)(
    'retains %s destructive assignment provenance in the next cell',
    async (language, definition, operation) => {
      expect(await analyzeNotebookCodeRisk(language, definition)).toEqual([])
      expect(
        await analyzeNotebookCodeRisk(language, 'erase(path)', undefined, [definition])
      ).toEqual([{ operation, source: 'erase(path)', line: 1 }])
    }
  )

  it.each([
    ['python', 'import os\n(erase := os.unlink)(path)', 'os.unlink'],
    ['r', '(erase <- unlink)(path)', 'unlink'],
    ['r', '(unlink -> erase)(path)', 'unlink'],
    ['repl', 'const fs = require("fs"); let erase; (erase = fs.unlinkSync)(path)', 'fs.unlinkSync']
  ] as const)(
    'reports the actual %s operation when an assignment result is invoked',
    async (language, source, operation) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([
        expect.objectContaining({ operation })
      ])
    }
  )

  it.each([
    ['python', 'import os\n(erase := lambda path: os.unlink(path))(path)'],
    ['r', '(erase <- function(path) unlink(path))(path)'],
    ['repl', 'const fs = require("fs"); let erase; (erase = path => fs.unlinkSync(path))(path)']
  ] as const)(
    'keeps immediate %s invocation of an assigned anonymous function reviewable',
    async (language, source) => {
      expect(await analyzeNotebookCodeRisk(language, source)).not.toEqual([])
    }
  )

  it.each([
    'report() { printf done; } > report.txt',
    'report() { printf done; } >| report.txt',
    'report() { printf done; } 2> errors.txt',
    'report() { printf done; } > report.txt 2>&1',
    'report() { printf done; } > "$(rm sentinel.txt)"',
    'report() { printf done; } < "$(rm sentinel.txt)"'
  ])('defers shell function redirection effects until invocation: %s', async (definition) => {
    expect(await analyzeNotebookCodeRisk('bash', definition)).toEqual([])
    expect(await analyzeNotebookCodeRisk('bash', 'report', undefined, [definition])).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'report', line: 1 })])
    )
  })

  it.each([
    'report() { printf done; } >> report.txt\nreport',
    'report() { printf done; } > /dev/null\nreport',
    'report() { printf done; } 2>&1\nreport',
    'report() { printf done; } 2>&-\nreport',
    'report() { cat; } < report.txt\nreport',
    'printf done 2>&-',
    'printf done 3>&-'
  ])(
    'keeps non-truncating function redirects and descriptor closes free of prompts: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
    }
  )

  it.each([
    ['cleanup', 'def cleanup(fn):\n    os.unlink(path)\n    return fn', 'cleanup: os.unlink'],
    [
      'alias',
      'def cleanup(fn):\n    os.unlink(path)\n    return fn\nalias = cleanup',
      'cleanup: os.unlink'
    ],
    ['cleanup', 'cleanup = lambda fn: (os.unlink(path), fn)[1]', 'cleanup: os.unlink'],
    ['cleanup', 'cleanup = decorators[name]', 'dynamic call target']
  ])(
    'checks implicit decorator invocation for @%s at definition time',
    async (decorator, definition, operation) => {
      const prior = `import os\n${definition}`
      expect(await analyzeNotebookCodeRisk('python', prior)).toEqual([])
      for (const decorated of ['def work():\n    pass', 'class Work:\n    pass']) {
        const source = `@${decorator}\n${decorated}`
        expect(await analyzeNotebookCodeRisk('python', source, undefined, [prior])).toEqual([
          { operation, source: `@${decorator}`, line: 1 }
        ])
      }
    }
  )

  it.each([
    'def annotate(fn):\n    print(fn.__name__)\n    return fn\n@annotate\ndef work():\n    return 1',
    'from functools import lru_cache\n@lru_cache(maxsize=32)\ndef work(x):\n    return x + 1',
    'from functools import lru_cache\n@(lru_cache(maxsize=32))\ndef work(x):\n    return x + 1',
    'from functools import cache\n@cache\ndef work(x):\n    return x + 1',
    'from functools import cache\n@(\n    # cache computed values\n    cache\n)\ndef work(x):\n    return x + 1',
    'import os\ndef annotate(fn):\n    return fn\n@annotate\ndef cleanup():\n    os.unlink(path)',
    'import os\ndef cleanup(fn):\n    os.unlink(path)\n    return fn'
  ])(
    'does not mistake ordinary decorators or an uncalled body for deletion: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
    }
  )

  it('keeps explicit decorator factory effects attributed to the existing call site', async () => {
    const definition = 'import os\ndef factory():\n    os.unlink(path)\n    return lambda fn: fn'
    expect(
      await analyzeNotebookCodeRisk('python', '@factory()\ndef work():\n    pass', undefined, [
        definition
      ])
    ).toEqual([{ operation: 'factory: os.unlink', source: 'factory()', line: 1 }])
  })

  it.each([
    ['python', 'import os\nreader = print\nprint = os.unlink', 'list(map(reader, paths))'],
    ['python', 'import os\nreader = bool\nbool = os.unlink', 'list(filter(reader, paths))'],
    [
      'repl',
      'const fs = require("fs"); const reader = Number; Number = fs.unlinkSync',
      'paths.map(reader)'
    ],
    ['r', 'reader <- mean; mean <- unlink', 'lapply(paths, reader)'],
    ['r', 'reader <- mean; mean <- unlink', 'lapply(paths, "reader")'],
    ['r', 'reader <- mean; mean <- unlink', 'sapply(paths, FUN=reader)'],
    ['r', 'reader <- mean; mean <- unlink', 'vapply(paths, reader, numeric(1))'],
    ['r', 'reader <- mean; mean <- unlink', 'Map(reader, paths)'],
    ['r', 'reader <- mean; mean <- unlink', 'apply(paths, 1, reader)']
  ] as const)(
    'keeps a saved %s callback independent of later rebinding of its original name',
    async (language, definition, invocation) => {
      expect(await analyzeNotebookCodeRisk(language, definition)).toEqual([])
      expect(await analyzeNotebookCodeRisk(language, `${definition}\n${invocation}`)).toEqual([])
      expect(await analyzeNotebookCodeRisk(language, invocation, undefined, [definition])).toEqual(
        []
      )
    }
  )

  it.each([
    ['python', 'runner = eval\neval = print', 'list(map(runner, paths))', 'eval dynamic execution'],
    ['repl', 'const runner = eval; eval = String', 'paths.map(runner)', 'eval dynamic execution'],
    ['r', 'erase <- unlink; unlink <- print', 'lapply(paths, erase)', 'unlink'],
    ['r', 'erase <- unlink; unlink <- print', 'lapply(paths, "erase")', 'unlink'],
    ['r', 'erase <- file.remove; file.remove <- print', 'Map(erase, paths)', 'file.remove'],
    ['r', 'erase <- unlink; unlink <- print', 'sapply(paths, FUN=erase)', 'unlink'],
    ['r', 'erase <- unlink; unlink <- print', 'vapply(paths, erase, integer(1))', 'unlink'],
    ['r', 'erase <- unlink; unlink <- print', 'apply(paths, 1, erase)', 'unlink'],
    ['r', 'reader <- mean; mean <- unlink', 'lapply(paths, "mean")', 'unlink']
  ] as const)(
    'retains saved %s callback effects while resolving R string callbacks by current name',
    async (language, definition, invocation, operation) => {
      for (const previousSources of [[], [definition]]) {
        const source = previousSources.length ? invocation : `${definition}\n${invocation}`
        expect(await analyzeNotebookCodeRisk(language, source, undefined, previousSources)).toEqual(
          [expect.objectContaining({ operation })]
        )
      }
    }
  )

  it.each([
    'fs.readFileSync.call(fs, path, "utf8")',
    'fs.readFileSync.apply(fs, [path, "utf8"])',
    'fs.readFileSync.apply(fs, readArgs)',
    'Reflect.apply(fs.readFileSync, fs, [path, "utf8"])',
    'fs["readFileSync"]["call"](fs, path)',
    '(fs.readFileSync.call)(fs, path)',
    'Math.max.apply(null, values)',
    'makeModel().apply(batch)',
    'const model = makeModel(); model.apply(batch)',
    'Array.prototype.map.call(values, /* normalize */ Number)',
    'Reflect.apply(/* target */ fs.readFileSync, fs, [path])',
    'Array.prototype.map.call(values, Number)',
    'Array.prototype.map.apply(values, [Number])',
    'Array.prototype.map.apply(values, ([Number]))',
    'Reflect.apply(Array.prototype.map, values, (([Number])))',
    'Array.prototype.map.apply(values, [/* normalize */ Number])',
    'Reflect.apply(Array.prototype.map, values, [Number])',
    'function read(path) { return fs.readFileSync(path) }; read.call(null, path)',
    'const read = fs.readFileSync.bind(fs); read.apply(null, [path])',
    'const invoke = Reflect.apply; invoke(fs.readFileSync, fs, [path])',
    'const { apply: invoke } = Reflect; invoke(fs.readFileSync, fs, [path])',
    'console.log.call(null, fs.unlinkSync)',
    'Reflect.apply(console.log, console, [fs.unlinkSync])',
    'Array.prototype.map.apply(values, [, fs.unlinkSync])'
  ])(
    'admits ordinary forwarded REPL calls without treating data as invoked code: %s',
    async (code) => {
      expect(await analyzeNotebookCodeRisk('repl', `const fs = require("fs"); ${code}`)).toEqual([])
    }
  )

  it.each([
    ['fs.unlinkSync.call(fs, path)', 'fs.unlinkSync'],
    ['fs.unlinkSync.apply(fs, [path])', 'fs.unlinkSync'],
    ['Reflect.apply(fs.unlinkSync, fs, [path])', 'fs.unlinkSync'],
    ['fs["unlinkSync"]["call"](fs, path)', 'fs.unlinkSync'],
    ['fs.unlinkSync["apply"](fs, [path])', 'fs.unlinkSync'],
    ['(fs.unlinkSync.call)(fs, path)', 'fs.unlinkSync'],
    ['const erase = fs.unlinkSync; erase.call(null, path)', 'fs.unlinkSync'],
    ['const erase = fs.unlinkSync.bind(fs); erase.apply(null, [path])', 'fs.unlinkSync'],
    [
      'function erase(path) { fs.unlinkSync(path) }; erase.call(null, path)',
      'erase: fs.unlinkSync'
    ],
    ['Array.prototype.forEach.call(paths, fs.unlinkSync)', 'fs.unlinkSync'],
    ['Array.prototype.forEach.apply(paths, [fs.unlinkSync])', 'fs.unlinkSync'],
    ['Array.prototype.forEach.apply(paths, ([fs.unlinkSync]))', 'fs.unlinkSync'],
    ['Reflect.apply(Array.prototype.forEach, paths, [fs.unlinkSync])', 'fs.unlinkSync'],
    ['const invoke = Reflect.apply; invoke(fs.unlinkSync, fs, [path])', 'fs.unlinkSync'],
    ['const { apply: invoke } = Reflect; invoke(fs.unlinkSync, fs, [path])', 'fs.unlinkSync'],
    ['Reflect.apply(handlers[method], null, [path])', 'dynamic call target'],
    ['Array.prototype.forEach.apply(paths, callbacks)', 'dynamic callback target'],
    ['Array.prototype.forEach.call(...args)', 'dynamic callback target'],
    ['Array.prototype.forEach.apply(paths, [...callbacks])', 'dynamic callback target']
  ])('reviews effects of the actual forwarded REPL target: %s', async (code, operation) => {
    expect(await analyzeNotebookCodeRisk('repl', `const fs = require("fs"); ${code}`)).toEqual([
      expect.objectContaining({ operation })
    ])
  })

  it.each([
    'erase.call(null, path)',
    'erase.apply(null, [path])',
    'Reflect.apply(erase, null, [path])'
  ])(
    'keeps forwarded deletion review after the original function is redefined across cells: %s',
    async (source) => {
      expect(
        await analyzeNotebookCodeRisk('repl', source, undefined, [
          'const fs = require("fs"); function cleanup(path) { fs.unlinkSync(path) }; const erase = cleanup',
          'function cleanup(path) { return fs.readFileSync(path) }'
        ])
      ).toEqual([{ operation: 'cleanup: fs.unlinkSync', source, line: 1 }])
      expect(
        await analyzeNotebookCodeRisk('repl', 'cleanup.call(null, path)', undefined, [
          'const fs = require("fs"); function cleanup(path) { fs.unlinkSync(path) }',
          'function cleanup(path) { return fs.readFileSync(path) }'
        ])
      ).toEqual([])
    }
  )

  it.each([
    'const { "readFileSync": read } = fs',
    "const { 'readFileSync': read } = fs",
    'const { ["readFileSync"]: read } = fs',
    'const { promises: { readFile: read } } = fs',
    'const { promises: { readFile: read, unlink: erase } } = fs',
    'const { "promises": { "readFile": read } } = fs',
    'const { ["promises"]: { ["readFile"]: read } } = fs',
    'const [{ promises: { readFile: read } }] = [fs]',
    'const { /* file I/O */ readFileSync: read, ...metadata } = fs',
    'let read = fs.unlinkSync; ({ "readFileSync": read } = fs)',
    'let read = fs.unlinkSync; ({ promises: { readFile: read } } = fs)',
    'let read = fs.unlinkSync; ({ promises: { readFile: read } } = (fs))',
    'const { readFileSync: read = fs.readFileSync } = fs',
    'const { readFileSync = fs.readFileSync } = fs; const read = readFileSync'
  ])('preserves ordinary object-destructured read identities: %s', async (definition) => {
    const prior = `const fs = require("fs"); ${definition}`
    expect(await analyzeNotebookCodeRisk('repl', prior)).toEqual([])
    expect(await analyzeNotebookCodeRisk('repl', `${prior}; read(path)`)).toEqual([])
    expect(await analyzeNotebookCodeRisk('repl', 'read(path)', undefined, [prior])).toEqual([])
  })

  it.each([
    ['const { "unlinkSync": erase } = fs', 'fs.unlinkSync'],
    ["const { 'unlinkSync': erase } = fs", 'fs.unlinkSync'],
    ['const { ["unlinkSync"]: erase } = fs', 'fs.unlinkSync'],
    ['const { promises: { unlink: erase } } = fs', 'fs.promises.unlink'],
    ['const { "promises": { "unlink": erase } } = fs', 'fs.promises.unlink'],
    ['const { ["promises"]: { ["unlink"]: erase } } = fs', 'fs.promises.unlink'],
    ['const [{ promises: { unlink: erase } }] = [fs]', 'fs.promises.unlink'],
    ['let erase = fs.readFileSync; ({ "unlinkSync": erase } = fs)', 'fs.unlinkSync'],
    ['const { [method]: erase } = fs', 'dynamic call target'],
    ['const { [method]: { unlink: erase } } = fs', 'dynamic call target'],
    ['const { missing: erase = fs.unlinkSync } = fs', 'dynamic call target'],
    ['const { missing = fs.unlinkSync } = fs; const erase = missing', 'dynamic call target'],
    ['const { unlinkSync: erase = fs.unlinkSync } = fs', 'fs.unlinkSync']
  ])(
    'retains object-destructured deletion or unresolved provenance: %s',
    async (definition, operation) => {
      const prior = `const fs = require("fs"); ${definition}`
      expect(await analyzeNotebookCodeRisk('repl', prior)).toEqual([])
      for (const source of ['erase(path)', '[path].forEach(erase)']) {
        expect(await analyzeNotebookCodeRisk('repl', source, undefined, [prior])).toEqual([
          { operation, source, line: 1 }
        ])
      }
    }
  )

  it.each([
    ['python', 'reader = open', 'reader: object', 'reader(path).read()'],
    [
      'python',
      'from pathlib import Path\nreader = Path',
      'reader: object',
      'reader(path).read_text()'
    ],
    ['python', 'def reader(path):\n    return open(path).read()', 'reader: object', 'reader(path)'],
    ['python', 'reader = open', 'if True:\n    reader: object', 'reader(path).read()'],
    ['python', 'reader = open', 'reader: object\nreader: object', 'reader(path).read()'],
    ['repl', 'var reader = fs.readFileSync', 'var reader', 'reader(path)'],
    ['repl', 'var reader = fs.readFileSync', 'var reader, other', 'reader(path)'],
    [
      'repl',
      'function reader(path) { return fs.readFileSync(path) }',
      'var reader',
      'reader(path)'
    ],
    ['repl', 'var reader = fs.readFileSync', 'if (true) { var reader }', 'reader(path)'],
    ['repl', '', 'var Number', 'Number("10")']
  ] as const)(
    'does not replace a %s callable value for a top-level declaration without an initializer',
    async (language, definition, declaration, invocation) => {
      const prefix = language === 'repl' ? 'const fs = require("fs"); ' : ''
      const prior = prefix + definition
      expect(
        await analyzeNotebookCodeRisk(language, `${prior}\n${declaration}\n${invocation}`)
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk(language, invocation, undefined, [prior, declaration])
      ).toEqual([])
    }
  )

  it.each([
    ['python', 'import os\nerase = os.unlink', 'erase: object', 'os.unlink'],
    [
      'python',
      'import os\ndef erase(path):\n    os.unlink(path)',
      'erase: object',
      'erase: os.unlink'
    ],
    ['python', 'erase = handlers[method]', 'erase: object', 'dynamic call target'],
    ['repl', 'var erase = fs.unlinkSync', 'var erase', 'fs.unlinkSync'],
    ['repl', 'function erase(path) { fs.unlinkSync(path) }', 'var erase', 'erase: fs.unlinkSync'],
    ['repl', 'var erase = handlers[method]', 'var erase', 'dynamic call target']
  ] as const)(
    'retains %s deletion or dynamic provenance across declarations without an initializer',
    async (language, definition, declaration, operation) => {
      const prefix = language === 'repl' ? 'const fs = require("fs"); ' : ''
      expect(
        await analyzeNotebookCodeRisk(language, 'erase(path)', undefined, [
          prefix + definition,
          declaration
        ])
      ).toEqual([{ operation, source: 'erase(path)', line: 1 }])
    }
  )

  it.each([
    ['python', 'import os\nreader = os.unlink\nreader: object = open\nreader(path).read()'],
    [
      'repl',
      'const fs = require("fs"); var reader = fs.unlinkSync; var reader = fs.readFileSync; reader(path)'
    ]
  ] as const)('continues to apply real %s declaration initializers', async (language, source) => {
    expect(await analyzeNotebookCodeRisk(language, source)).toEqual([])
  })

  it.each([
    ['python', 'import os\nreader = open\nreader: object = os.unlink\nreader(path)', 'os.unlink'],
    [
      'repl',
      'const fs = require("fs"); var reader = fs.readFileSync; var reader = fs.unlinkSync; reader(path)',
      'fs.unlinkSync'
    ],
    [
      'repl',
      'const fs = require("fs"); const reader = fs.readFileSync; { let reader; reader(path) }',
      'dynamic call target'
    ],
    [
      'python',
      'reader = open\ndef work():\n    reader: object\n    reader(path)\nwork()',
      'work: dynamic call target'
    ],
    [
      'repl',
      'const fs = require("fs"); var reader = fs.readFileSync; function work() { var reader; reader(path) }; work()',
      'work: dynamic call target'
    ]
  ] as const)(
    'keeps %s initialized and local declarations distinct',
    async (language, source, operation) => {
      expect(await analyzeNotebookCodeRisk(language, source)).toEqual([
        expect.objectContaining({ operation })
      ])
    }
  )

  it.each([
    ['import os\nopen = os.unlink', 'del open', 'open(path).read()'],
    [
      'import os\nopen = os.unlink\nprint = os.unlink',
      'del open, print',
      'print(open(path).read())'
    ],
    [
      'import os\nopen = os.unlink\nprint = os.unlink',
      'del (open, (print,))',
      'print(open(path).read())'
    ],
    [
      'import os\nopen = os.unlink\nprint = os.unlink',
      'del [open, print]',
      'print(open(path).read())'
    ],
    ['import os\nopen = os.unlink', 'if True:\n    del open', 'open(path).read()'],
    ['def open(path):\n    os.unlink(path)', 'del open', 'open(path).read()'],
    ['open = handlers[method]', 'del open', 'open(path).read()']
  ])(
    'restores ordinary builtin lookup after deleting a top-level binding: %s',
    async (definition, deletion, call) => {
      expect(
        await analyzeNotebookCodeRisk('python', `${definition}\n${deletion}\n${call}`)
      ).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('python', call, undefined, [definition, deletion])
      ).toEqual([])
    }
  )

  it.each([
    ['eval', 'eval("1 + 2")'],
    ['exec', 'exec("print(1)")']
  ])('reviews restored %s after deleting its harmless shadow', async (name, call) => {
    expect(
      await analyzeNotebookCodeRisk('python', `${name} = print\ndel ${name}\n${call}`)
    ).toEqual([{ operation: `${name} dynamic execution`, source: call, line: 3 }])
    expect(
      await analyzeNotebookCodeRisk('python', call, undefined, [`${name} = print`, `del ${name}`])
    ).toEqual([{ operation: `${name} dynamic execution`, source: call, line: 1 }])
  })

  it.each([
    'import os\nopen = os.unlink\nerase = open\ndel open\nerase(path)',
    'import os\nerase = os.unlink\ndel holder.erase\nerase(path)',
    'import os\nerase = os.unlink\ndel items[erase]\nerase(path)',
    'import os\ndel items[os.unlink(path)]',
    'import os\nopen = os.unlink\nclass Container:\n    try:\n        del open\n    except NameError:\n        pass\nopen(path)'
  ])(
    'retains deletion evidence in saved aliases and deletion target expressions: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([
        expect.objectContaining({ operation: 'os.unlink' })
      ])
    }
  )

  it('processes del targets from left to right before inspecting later target expressions', async () => {
    expect(
      await analyzeNotebookCodeRisk(
        'python',
        'import os\nopen = os.unlink\ndel open, items[open(path).read()]'
      )
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('python', 'eval = print\ndel eval, items[eval("1 + 2")]')
    ).toEqual([{ operation: 'eval dynamic execution', source: 'eval("1 + 2")', line: 2 }])
  })

  it.each(['del rows[0]', 'del table.column', 'del rows[1:3]', 'value = 1\ndel value'])(
    'does not treat ordinary Python memory deletion as filesystem deletion: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('python', source)).toEqual([])
    }
  )

  it.each([
    'if enabled:\n    del open',
    'for item in items:\n    del open',
    'try:\n    may_fail()\n    del open\nexcept Exception:\n    pass'
  ])('does not assume a conditional binding deletion has executed: %s', async (deletion) => {
    const definition = 'import os\nopen = os.unlink'
    expect(
      await analyzeNotebookCodeRisk('python', 'open(path)', undefined, [definition, deletion])
    ).toEqual([
      { operation: 'dynamic call target', source: 'open(path)', line: 1 },
      { operation: 'os.unlink', source: 'open(path)', line: 1 }
    ])
  })

  it('retains possible builtin dynamic execution after conditional unshadowing', async () => {
    expect(
      await analyzeNotebookCodeRisk('python', 'eval("1 + 2")', undefined, [
        'eval = print',
        'if enabled:\n    del eval'
      ])
    ).toEqual([{ operation: 'dynamic call target', source: 'eval("1 + 2")', line: 1 }])
  })

  it('ignores binding deletion in an explicitly false branch', async () => {
    expect(
      await analyzeNotebookCodeRisk(
        'python',
        'reader = open\nif False:\n    del reader\nreader(path).read()'
      )
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk(
        'python',
        'import os\nopen = os.unlink\nif False:\n    del open\nopen(path)'
      )
    ).toEqual([{ operation: 'os.unlink', source: 'open(path)', line: 5 }])
  })

  it.each([
    'sorted(paths)',
    'import operator\nsorted(records, key=operator.itemgetter(0))',
    'from operator import attrgetter\nsorted(records, key=attrgetter("name"))',
    'from operator import itemgetter as column\nkey = column("score")\nmax(records, key=key)',
    'import operator\nread = operator.itemgetter(0)\nread(records)',
    'sorted(paths, key=None)',
    'sorted(paths, reverse=True, key=str.lower)',
    'min(paths, key=len)',
    'max(paths, default=os.unlink, key=None)',
    'min(paths, default=os.unlink)',
    'import builtins\nbuiltins.sorted(paths, key=str.lower)',
    'from builtins import sorted as order\norder(paths, key=len)',
    'def sorted(values, **options):\n    return values\nsorted(paths, key=os.unlink)',
    'def min(values, **options):\n    return values\nmin(paths, key=os.unlink)',
    'import functools\nimport operator\nfunctools.reduce(operator.add, values, 0)',
    'from functools import reduce as fold\nimport operator\nfold(operator.add, values, 0)',
    'import builtins\nlist(builtins.filter(None, paths))',
    'from builtins import map as transform\nlist(transform(str, paths))'
  ])(
    'keeps ordinary Python keyword callbacks and function-valued data free of prompts: %s',
    async (source) => {
      expect(await analyzeNotebookCodeRisk('python', `import os\n${source}`)).toEqual([])
    }
  )

  it.each([
    ['sorted(paths, key=os.unlink)', 'os.unlink'],
    ['sorted(paths, reverse=True, key=os.unlink)', 'os.unlink'],
    ['min(paths, key=os.unlink)', 'os.unlink'],
    ['max(paths, key=os.unlink, default=None)', 'os.unlink'],
    ['import builtins\nbuiltins.sorted(paths, key=os.unlink)', 'os.unlink'],
    ['from builtins import min as smallest\nsmallest(paths, key=os.unlink)', 'os.unlink'],
    ['from builtins import max as largest\nlargest(paths, key=os.unlink)', 'os.unlink'],
    ['order = sorted\norder(paths, key=os.unlink)', 'os.unlink'],
    ['sorted(paths, key=handlers[method])', 'dynamic callback target'],
    ['import operator\nerase = operator.itemgetter(0)([os.unlink])\nerase(path)', 'os.unlink'],
    ['import operator\nsorted(records, key=operator.itemgetter(os.unlink(path)))', 'os.unlink'],
    [
      'import operator\nsorted(paths, key=operator.methodcaller("unlink"))',
      'operator.methodcaller:unlink dynamic method execution'
    ],
    ['import builtins\nlist(builtins.map(os.unlink, paths))', 'os.unlink'],
    ['from builtins import filter as select\nlist(select(os.unlink, paths))', 'os.unlink']
  ])(
    'reviews the invoked Python sorting or qualified collection callback: %s',
    async (source, operation) => {
      expect(await analyzeNotebookCodeRisk('python', `import os\n${source}`)).toEqual([
        expect.objectContaining({ operation })
      ])
    }
  )

  it.each([
    ['sorted(paths, key=erase)', 'def erase(path):\n    os.unlink(path)'],
    [
      'fold(erase, paths, [])',
      'from functools import reduce as fold\ndef erase(acc, path):\n    os.unlink(path)\n    return acc'
    ]
  ])('retains keyword/reduction callback summaries across cells: %s', async (call, definition) => {
    const prior = `import os\n${definition}`
    expect(await analyzeNotebookCodeRisk('python', prior)).toEqual([])
    expect(await analyzeNotebookCodeRisk('python', call, undefined, [prior])).toEqual([
      { operation: 'erase: os.unlink', source: call, line: 1 }
    ])
  })

  it.each([
    'getattr(frame, "shape")',
    'getattr(getattr(os, "path"), "exists")(path)',
    'getattr(os, # receiver\n"listdir")(path)',
    'getattr(frame, "shape", None)',
    'getattr(os, "unlink")',
    'read = getattr(os, "listdir")\nread(path)',
    'getattr(open(path), "read")()',
    'import builtins\nbuiltins.getattr(frame, "shape")',
    'from builtins import getattr as attribute\nattribute(os, "listdir")(path)',
    'getter = getattr\ngetter(frame, "shape")',
    'getattr(frame, "missing", os.unlink)',
    'getattr(os, "listdir", os.listdir)(path)',
    'def getattr(obj, name):\n    return obj\ngetattr(frame, method)'
  ])('does not treat fixed Python attribute lookup as execution: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('python', `import os\n${source}`)).toEqual([])
  })

  it.each([
    ['getattr(os, "unlink")(path)', 'os.unlink'],
    ['from pathlib import Path\ngetattr(Path(path), "unlink")()', 'pathlib.Path.unlink'],
    ['sorted(objects, key=getattr)', 'getattr dynamic execution'],
    [
      'import builtins\nsorted(objects, key=builtins.getattr)',
      'builtins.getattr dynamic execution'
    ],
    ['@getattr\ndef reader():\n    pass', 'getattr dynamic execution'],
    ['erase = getattr(os, "remove")\nerase(path)', 'os.remove'],
    ['sorted(paths, key=getattr(os, "unlink"))', 'os.unlink'],
    ['import builtins\nbuiltins.getattr(os, "unlink")(path)', 'os.unlink'],
    ['getattr(os, "unlink", os.unlink)(path)', 'os.unlink'],
    ['getattr(frame, "missing", os.unlink)(path)', 'os.unlink'],
    ['getattr(frame, method)', 'getattr dynamic execution'],
    ['import builtins\nbuiltins.getattr(frame, method)', 'builtins.getattr dynamic execution'],
    ['getattr(os.unlink(path), "shape")', 'os.unlink'],
    ['getattr(frame, "shape", os.unlink(path))', 'os.unlink'],
    ['import builtins\nbuiltins.eval(code)', 'builtins.eval dynamic execution'],
    ['from builtins import exec as execute\nexecute(code)', 'builtins.exec dynamic execution'],
    [
      'import builtins\nbuiltins.exec(builtins.compile(code, "<cell>", "exec"))',
      'builtins.exec dynamic execution'
    ],
    ['import builtins\nbuiltins.__import__(name)', 'builtins.__import__ dynamic execution'],
    ['import builtins\ngetattr(builtins, "eval")(code)', 'builtins.eval dynamic execution'],
    ['getattr = os.unlink\ngetattr(path)', 'os.unlink']
  ])('reviews effects after Python attribute lookup: %s', async (source, operation) => {
    expect(await analyzeNotebookCodeRisk('python', `import os\n${source}`)).toEqual([
      expect.objectContaining({ operation })
    ])
  })

  it('retains a retrieved Python callable across cells and name rebinding', async () => {
    const definition = 'import os\nerase = getattr(os, "unlink")\ngetattr = print'
    expect(await analyzeNotebookCodeRisk('python', definition)).toEqual([])
    expect(await analyzeNotebookCodeRisk('python', 'erase(path)', undefined, [definition])).toEqual(
      [{ operation: 'os.unlink', source: 'erase(path)', line: 1 }]
    )
  })

  it.each([
    'env',
    'env -',
    'env -i',
    'env LANG=C',
    'env LANG=C ls',
    'env LD_PRELOAD= ls',
    'env LD_PRELOAD=./plugin.so',
    'env -u LD_PRELOAD ls',
    'env LABEL=rm printf "%s" rm',
    'env -u rm pwd',
    'env --unset=rm pwd',
    'env -urm pwd',
    'env -iv -u NAME pwd',
    'env -iuNAME pwd',
    'env -C /tmp pwd',
    'env --chdir=/tmp pwd',
    'env -C/tmp pwd',
    'env -- LANG=C pwd',
    '/usr/bin/env LANG=C /bin/ls',
    'command env LANG=C ls',
    'env env LANG=C ls',
    'env LANG=C git clean -nd'
  ])('resolves ordinary env payloads without reviewing data operands: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
  })

  it.each([
    'env LANG=C rm data.txt',
    'env LD_PRELOAD=./plugin.so ls',
    'env LD_AUDIT=./audit.so ls',
    'env DYLD_INSERT_LIBRARIES=./plugin.dylib ls',
    'env -u rm rm data.txt',
    'env -iuNAME rm data.txt',
    'env --unset=NAME unlink data.txt',
    'env -C /tmp rm data.txt',
    'env --chdir=/tmp rm data.txt',
    'env -- rm data.txt',
    'env - rm data.txt',
    'env LANG=C sh -c "rm data.txt"',
    'env env LANG=C rm data.txt',
    'command env LANG=C rm data.txt',
    'env -S "rm data.txt"',
    'env --split-string="rm data.txt"',
    'env "$OPTIONS" ls',
    'env -u "$NAME" rm data.txt',
    'env LANG=C "$COMMAND" data.txt',
    'env --unknown ls',
    'env LABEL="$(rm data.txt)" pwd',
    'env LANG=C git clean -f',
    'env LANG=C ls > data.txt'
  ])('retains env payload and expansion risk review: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).not.toEqual([])
  })

  it.each([
    'builtin',
    'builtin --',
    'builtin printf "%s" rm',
    'builtin -- printf "%s" rm',
    'builtin builtin printf "%s" rm',
    'builtin command -v rm',
    'command builtin printf "%s" rm',
    'printf() { rm data.txt; }; builtin printf "%s" ok',
    'rm --help',
    'bash --help',
    'python3 --version',
    'env rm --help',
    'command rm --help'
  ])('preserves ordinary builtin calls and standard utility help: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
  })

  it.each([
    'builtin eval "rm data.txt"',
    'builtin source cleanup.sh',
    'builtin . cleanup.sh',
    'builtin -- eval "rm data.txt"',
    'builtin builtin eval "rm data.txt"',
    'command builtin eval "rm data.txt"',
    'builtin command eval "rm data.txt"',
    'builtin "$COMMAND" "$PAYLOAD"',
    'builtin printf "%s" "$(rm data.txt)"',
    'builtin printf "%s" ok > data.txt',
    './cleanup.sh --help',
    './cleanup.sh --version',
    './cleanup.py --help',
    './cleanup.js --help',
    './cleanup.R --help',
    './cleanup.ps1 --help',
    './cleanup.cmd --help',
    './cleanup.bat --version',
    './cleanup.cmd',
    'env ./cleanup.sh --help',
    'command ./cleanup.sh --help',
    'cleanup() { rm data.txt; }; cleanup --help'
  ])('reviews builtin execution and script-owned help arguments: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).not.toEqual([])
  })

  it.each([
    'Filter(is.finite, c(1, NA, Inf))',
    'Filter(x = c(1, NA), f = is.finite)',
    'base::Filter("is.finite", c(1, NA))',
    'Find(is.finite, c(NA, 2))',
    'Position(is.finite, c(NA, 2))',
    'Find(is.finite, numeric(), nomatch = unlink)',
    'Position(x = numeric(), nomatch = file.remove, f = is.finite)',
    'Reduce(`+`, 1:3)',
    'Reduce(function(acc, item) acc, list(), init = unlink)',
    'read <- is.finite; is.finite <- unlink; Filter(read, c(1, NA))',
    'Filter <- function(f, x) x; Filter(unlink, paths)',
    'keep <- base::Filter; keep(is.finite, c(1, NA))'
  ])('keeps R functional data/default arguments free of execution review: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('r', source)).toEqual([])
  })

  it.each([
    'Filter(file.remove, paths)',
    'Filter(x = paths, f = file.remove)',
    'Filter(x = paths, file.remove)',
    'base::Filter(base::file.remove, paths)',
    'Find(file.remove, paths)',
    'Find(x = paths, right = TRUE, f = file.remove)',
    'Position(file.remove, paths)',
    'Position(nomatch = 0L, x = paths, f = file.remove)',
    'Filter("file.remove", paths)',
    'erase <- file.remove; Filter("erase", paths)',
    'erase <- file.remove; file.remove <- is.finite; Filter(erase, paths)',
    'keep <- base::Filter; keep(file.remove, paths)',
    'Filter(function(path) { unlink(path); TRUE }, paths)',
    'step <- function(acc, path) { unlink(path); acc }; Reduce(step, paths, init = 0)',
    'step <- function(acc, path) { unlink(path); acc }; base::Reduce(x = paths, init = 0, f = step)'
  ])('reviews invoked R functional callbacks: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('r', source)).not.toEqual([])
  })

  it.each(['Filter', 'Find', 'Position', 'Reduce'])(
    'retains %s callback evidence from previous R cells',
    async (operation) => {
      const definition = 'erase <- function(...) { unlink("data.txt"); TRUE }'
      expect(await analyzeNotebookCodeRisk('r', definition)).toEqual([])
      expect(
        await analyzeNotebookCodeRisk('r', `${operation}(erase, paths)`, undefined, [definition])
      ).toEqual([{ operation: 'erase: unlink', source: `${operation}(erase, paths)`, line: 1 }])
    }
  )

  it.each([
    'Promise.resolve(erase)',
    'Promise.resolve(1).then(Number)',
    'Promise.reject(1).then(null, Number)',
    'Promise.reject(1).catch(Number)',
    'Promise.resolve(1).finally(console.log)',
    'Promise.resolve(1).then(null, undefined)',
    'Promise.resolve(1).then(42, "ignored")',
    'Promise.resolve(1).finally({})',
    'Promise.resolve(1).then(true, false)',
    'Promise.resolve(1).then(`text`, null)',
    'const undefined = Number; promise.then(undefined)',
    'Promise.resolve(1).then((null), [erase])',
    'Promise.resolve(1).then(Number, Number, erase)',
    'Promise.resolve(1).catch(Number, erase)',
    'Promise.resolve(1).finally(console.log, erase)',
    'Promise.prototype.then.apply(promise, [, Number])',
    'Promise.prototype.then.apply(promise, [null, Number])',
    'const bound = promise.then.bind(promise, erase);',
    'const reader = Number; Number = erase; promise.then(reader)'
  ])('preserves ordinary Promise callbacks and non-callable data: %s', async (source) => {
    expect(
      await analyzeNotebookCodeRisk(
        'repl',
        `const fs = require("fs"); const erase = fs.unlinkSync; ${source}`
      )
    ).toEqual([])
  })

  it.each([
    'Promise.resolve(path).then(erase)',
    'const undefined = erase; promise.then(undefined)',
    'const undefined = erase; promise.then.apply(promise, [null, undefined])',
    'Promise.reject(path).then(null, erase)',
    'Promise.reject(path).catch(erase)',
    'Promise.resolve(path).finally(erase)',
    'promise["then"](null, erase)',
    'promise.then.call(promise, null, erase)',
    'promise.then.apply(promise, [null, erase])',
    'promise.then.apply(promise, [, erase])',
    'Reflect.apply(promise.then, promise, [null, erase])',
    'Reflect.apply(promise.then, promise, [(null), /* handler */ erase])',
    'promise.then.apply(promise, handlers)',
    'promise.then(...handlers)',
    'promise.then(null, ...handlers)',
    'const bound = promise.then.bind(promise, null, erase); bound()',
    'const saved = erase; erase = Number; promise.then(null, saved)',
    'promise.then(null, handlers[index])',
    'promise.then(null, (erase(path), Number))'
  ])('reviews invoked Promise handlers including rejection callbacks: %s', async (source) => {
    expect(
      await analyzeNotebookCodeRisk(
        'repl',
        `const fs = require("fs"); let erase = fs.unlinkSync; ${source}`
      )
    ).not.toEqual([])
  })

  it.each([
    'new Promise(cleanup)',
    'const P = Promise; new P(cleanup)',
    'new globalThis.Promise(cleanup)',
    'const { Promise: P } = globalThis; new P(cleanup)',
    'const P = Promise.bind(null); new P(cleanup)',
    'const P = Promise.bind(null, cleanup); new P()',
    'new (globalThis.Promise.bind(null, cleanup))()',
    'new Promise(...handlers)',
    'new Promise(handlers[index])'
  ])('reviews the invoked Promise constructor executor: %s', async (source) => {
    const definition = 'const fs = require("fs"); function cleanup() { fs.unlinkSync("data.txt") }'
    expect(await analyzeNotebookCodeRisk('repl', `${definition}; ${source}`)).not.toEqual([])
  })

  it.each([
    'new Promise(resolve => resolve(1))',
    'function read(resolve) { resolve(fs.readFileSync("data.txt", "utf8")) }; new Promise(read)',
    'const P = Promise; new P(resolve => resolve(1))',
    'const P = Promise.bind(null); new P(resolve => resolve(1))',
    'const P = Promise.bind(null, cleanup)',
    'Promise.resolve(cleanup)',
    'new Promise(resolve => resolve(1), cleanup)',
    'new Promise(null)',
    'new Promise({ executor: cleanup })',
    'new Promise([cleanup])',
    'function Promise(value) { this.value = value }; new Promise(cleanup)'
  ])('preserves ordinary Promise constructor work and non-executed data: %s', async (source) => {
    const definition = 'const fs = require("fs"); function cleanup() { fs.unlinkSync("data.txt") }'
    expect(await analyzeNotebookCodeRisk('repl', `${definition}; ${source}`)).toEqual([])
  })

  it('retains saved Promise constructor executors across cells and rebinding', async () => {
    const definition =
      'const fs = require("fs"); function cleanup() { fs.unlinkSync("data.txt") }; const P = Promise; const saved = cleanup; cleanup = Number'
    expect(await analyzeNotebookCodeRisk('repl', definition)).toEqual([])
    expect(await analyzeNotebookCodeRisk('repl', 'new P(saved)', undefined, [definition])).toEqual([
      { operation: 'cleanup: fs.unlinkSync', source: 'new P(saved)', line: 1 }
    ])
  })

  it('retains a named Promise cleanup callback across REPL cells', async () => {
    const definition = 'const fs = require("fs"); function cleanup() { fs.unlinkSync("data.txt") }'
    expect(await analyzeNotebookCodeRisk('repl', definition)).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'Promise.resolve().finally(cleanup)', undefined, [
        definition
      ])
    ).toEqual([
      { operation: 'cleanup: fs.unlinkSync', source: 'Promise.resolve().finally(cleanup)', line: 1 }
    ])
  })

  it.each([
    'tee',
    'tee -a data.txt',
    'tee -ia data.txt',
    'tee --append data.txt',
    'tee -a -- -a',
    'tee /dev/null',
    'tee -a /dev/null -i',
    'tee -a data.txt -a'
  ])('accepts portable tee append options before file operands: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([])
  })

  it.each([
    'tee data.txt -a',
    'tee data.txt --append',
    'tee /dev/null -a',
    'tee /dev/null -i',
    'tee data.txt -ia',
    'tee "$OUTPUT" -a',
    'tee -- data.txt -a',
    'env POSIXLY_CORRECT=1 tee data.txt -a',
    'command tee data.txt -a'
  ])('does not let trailing tee operands discharge overwrite review: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('bash', source)).toEqual([
      expect.objectContaining({ operation: 'tee file overwrite' })
    ])
  })

  it('fails to reviewable evidence on invalid source', async () => {
    expect(await analyzeNotebookCodeRisk('python', 'def (')).toMatchObject([
      { operation: 'parse-error' }
    ])
  })
})

describe('call receiver and reflected property evidence', () => {
  const prefix = 'const fs=require("fs");'
  const forms = [
    '({run:FN}).run("target.txt","utf8")',
    '(({run:FN}))["run"]("target.txt","utf8")',
    '({run(){OP}}).run()',
    '({run:()=>{OP}}).run()',
    '({run:function(){OP}}).run()',
    'const saved=({run:FN}).run;saved("target.txt","utf8")',
    'const {run}=({run:FN});run("target.txt","utf8")',
    'Reflect.get(fs,"METHOD")("target.txt","utf8")',
    'globalThis.Reflect.get(fs,"METHOD")("target.txt","utf8")',
    'Reflect.get(require("node:fs"),"METHOD")("target.txt","utf8")',
    'Reflect.get({run:FN},"run")("target.txt","utf8")',
    'Reflect.get({run(){OP}},"run")()',
    'Reflect.get({run:()=>{OP}},"run").bind(null)()',
    'Reflect.get.call(null,fs,"METHOD")("target.txt","utf8")',
    'Reflect.get.apply(null,[fs,"METHOD"])("target.txt","utf8")',
    'Reflect.apply(Reflect.get,null,[fs,"METHOD"])("target.txt","utf8")',
    'Reflect.get.bind(null)(fs,"METHOD")("target.txt","utf8")',
    'const lookup=Reflect.get;const saved=lookup({run:FN},"run");saved("target.txt","utf8")',
    'Reflect.get({nested:{run:FN}},"nested").run("target.txt","utf8")',
    'Reflect.get(fs,"METHOD",{}).call(null,"target.txt","utf8")',
    'Reflect.get(fs,"METHOD").apply(null,["target.txt","utf8"])',
    '["target.txt"].forEach(Reflect.get({run:()=>{OP}},"run"))'
  ]
  for (const danger of [false, true]) {
    it.each(forms)('resolves receiver effects danger=' + danger + ': %s', async (form) => {
      const source =
        prefix +
        form
          .replaceAll('FN', danger ? 'fs.unlinkSync' : 'fs.readFileSync')
          .replaceAll('METHOD', danger ? 'unlinkSync' : 'readFileSync')
          .replaceAll(
            'OP',
            danger ? 'fs.unlinkSync("target.txt")' : 'return fs.readFileSync("target.txt","utf8")'
          )
      const risks = await analyzeNotebookCodeRisk('repl', source)
      if (danger) expect(risks.some((risk) => risk.operation.includes('fs.unlinkSync'))).toBe(true)
      else expect(risks).toEqual([])
    })
  }
  it.each([
    'const saved=Reflect.get(fs,"unlinkSync");console.log(typeof saved)',
    'const saved=Reflect.get({run:()=>fs.unlinkSync("target.txt")},"run");console.log(typeof saved)',
    'const saved=Reflect.get(fs,"readFile"+"Sync");console.log(saved("target.txt","utf8"))',
    'const lookup=Reflect.get.bind(null);lookup(fs,"readFileSync")("target.txt","utf8")',
    'let object={run:fs.readFileSync};object.run((object.run=fs.unlinkSync,"target.txt"),"utf8")',
    'const object={run:fs.readFileSync};Reflect.get(object,"run")((object.run=fs.unlinkSync,"target.txt"),"utf8")',
    'const object={run:fs.readFileSync};({nested:object}).nested.run("target.txt","utf8")',
    'const object={run:fs.readFileSync};for(let i=0;i<3;i++)Reflect.get(object,"run")("target.txt","utf8")',
    'const object={run:()=>fs.readFileSync("target.txt","utf8")};[1].forEach(object.run,(object.run=()=>fs.unlinkSync("target.txt"),null))',
    'const object={run:()=>fs.readFileSync("target.txt","utf8")};Reflect.apply(Array.prototype.forEach,[1],[object.run,(object.run=()=>fs.unlinkSync("target.txt"),null)])',
    'const object={run:()=>fs.unlinkSync("target.txt")};Array.from((object.run=()=>fs.readFileSync("target.txt","utf8"),[1]),object.run)',
    'const object={run:()=>fs.readFileSync("target.txt","utf8")};Array.prototype.forEach.call([1],object.run,(object.run=()=>fs.unlinkSync("target.txt"),null))'
  ])('keeps passive lookups and captured readers prompt-free: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', prefix + source)).toEqual([])
  })
  it.each([
    'let object={run:fs.unlinkSync};object.run((object.run=fs.readFileSync,"target.txt"))',
    'const object={run:fs.unlinkSync};Reflect.get(object,"run")((object.run=fs.readFileSync,"target.txt"))',
    'const object={run:()=>fs.unlinkSync("target.txt")};Reflect.get(object,key)()',
    'const object={run:()=>fs.unlinkSync("target.txt")};Reflect.get(...values)()',
    'Reflect.get.apply(null,values)()',
    'Reflect.get.bind(null,fs)("unlinkSync")("target.txt")',
    'const lookup=flag?Reflect.get:()=>fs.unlinkSync;lookup(fs,"readFileSync")("target.txt")',
    'Reflect.get({get run(){fs.unlinkSync("target.txt");return console.log}},"run")("hello")',
    'const object={run:()=>fs.unlinkSync("target.txt")};[1].forEach(object.run,(object.run=()=>fs.readFileSync("target.txt","utf8"),null))',
    'const object={run:()=>fs.unlinkSync("target.txt")};Reflect.apply(Array.prototype.forEach,[1],[object.run,(object.run=()=>fs.readFileSync("target.txt","utf8"),null)])',
    'const object={run:()=>fs.readFileSync("target.txt","utf8")};Array.from((object.run=()=>fs.unlinkSync("target.txt"),[1]),object.run)',
    'const object={run:()=>fs.unlinkSync("target.txt")};Array.prototype.forEach.call([1],object.run,(object.run=()=>fs.readFileSync("target.txt","utf8"),null))'
  ])('retains captured destructive calls and uncertain lookups: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', prefix + source)).not.toEqual([])
  })
  it('inspects eager receiver and argument effects exactly once', async () => {
    const source =
      prefix + '({run:fs.readFileSync,initial:fs.unlinkSync("other.txt")}).run("target.txt","utf8")'
    const risks = await analyzeNotebookCodeRisk('repl', source)
    expect(risks).toEqual([
      expect.objectContaining({ operation: 'fs.unlinkSync', source: 'fs.unlinkSync("other.txt")' })
    ])
  })
  it('keeps reflected aliases and captured property updates across history', async () => {
    const source =
      prefix +
      'const object={run:fs.readFileSync};const saved=Reflect.get(object,"run");object.run=fs.unlinkSync;'
    expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'saved("target.txt","utf8")', undefined, [source])
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'object.run("target.txt")', undefined, [source])
    ).not.toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'object.run("target.txt")', undefined, [
        { script: source, incomplete: true }
      ])
    ).not.toEqual([])
  })
})

describe('nested function forwarding evidence', () => {
  const prefix = 'const fs=require("fs");const cp=require("child_process");'
  const forms = [
    'Function.prototype.call.call(FN,null,ARG_LIST)',
    'Function.prototype.apply.call(FN,null,[ARG_LIST])',
    'Function.prototype.call.apply(FN,[null,ARG_LIST])',
    'Function.prototype.apply.apply(FN,[null,[ARG_LIST]])',
    'Reflect.apply(Function.prototype.call,FN,[null,ARG_LIST])',
    'Reflect.apply(Function.prototype.apply,FN,[null,[ARG_LIST]])',
    'fs.readFileSync.call.call(FN,null,ARG_LIST)',
    'fs.unlinkSync.apply.call(FN,null,[ARG_LIST])',
    'Reflect.apply(fs.readFileSync.call,FN,[null,ARG_LIST])',
    'Reflect.apply(Reflect.apply,null,[Function.prototype.apply,FN,[null,[ARG_LIST]]])',
    'const invoke=Function.prototype.call;invoke.call(FN,null,ARG_LIST)',
    'const invoke=Function.prototype.apply;Reflect.apply(invoke,FN,[null,[ARG_LIST]])',
    'const invoke=Function.prototype.apply.bind(FN,null);invoke([ARG_LIST])',
    'const invoke=Reflect.apply(Function.prototype.bind,Function.prototype.apply,[FN,null]);invoke([ARG_LIST])',
    'const invoke=Function.prototype.apply.bind(FN,null);invoke.call(null,[ARG_LIST])',
    'const invoke=Function.prototype.apply.bind(FN,null);invoke.apply(null,[[ARG_LIST]])',
    'const invoke=Function.prototype.apply.bind(FN,null);Reflect.apply(invoke,null,[[ARG_LIST]])',
    'const invoke=Function.prototype.apply.bind(FN,null);invoke.bind(null)([ARG_LIST])',
    'let fn=FN;Function.prototype.apply.call(fn,(fn=()=>{},null),[ARG_LIST])',
    'let fn=FN;Reflect.apply(Function.prototype.call,fn,[(fn=()=>{},null),ARG_LIST])'
  ]
  for (const danger of [false, true])
    it.each(forms)('resolves nested reader/deletion danger=' + danger + ': %s', async (form) => {
      const code =
        prefix +
        form
          .replaceAll('FN', danger ? 'fs.unlinkSync' : 'fs.readFileSync')
          .replaceAll('ARG_LIST', '"target.txt","utf8"')
      const risks = await analyzeNotebookCodeRisk('repl', code)
      if (danger) expect(risks.some((risk) => risk.operation.includes('fs.unlinkSync'))).toBe(true)
      else expect(risks).toEqual([])
    })
  for (const form of forms) {
    it.each([
      '"echo",["hello"]',
      '"echo",["rm -rf -- target.txt"]',
      '"printf",["%s","rm -- target.txt"]',
      '"cat",["target.txt"]',
      '"node",["--version"]',
      '"git",["clean","-n"]'
    ])('keeps ordinary forwarded argv ' + form + ': %s', async (argv) => {
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          prefix + form.replaceAll('FN', 'cp.execFileSync').replaceAll('ARG_LIST', argv)
        )
      ).toEqual([])
    })
    it.each([
      '"rm",["--","target.txt"]',
      '"find",[".","-delete"]',
      '"git",["reset","--hard"]',
      '"node",["-e",code]',
      'program,["hello"]',
      '"echo",args'
    ])('reviews destructive or uncertain forwarded argv ' + form + ': %s', async (argv) => {
      expect(
        await analyzeNotebookCodeRisk(
          'repl',
          prefix + form.replaceAll('FN', 'cp.execFileSync').replaceAll('ARG_LIST', argv)
        )
      ).not.toEqual([])
    })
  }
  it.each([
    'Reflect.apply(Function.prototype.apply,Array.prototype.forEach,[[1],[CALLBACK]])',
    'const run=Function.prototype.apply.bind(Array.prototype.forEach,[1]);run([CALLBACK])',
    'Reflect.apply(Function.prototype.call,Array.prototype.forEach,[[1],CALLBACK])'
  ])('preserves nested callback evidence: %s', async (form) => {
    const reader = '()=>fs.readFileSync("target.txt","utf8")'
    const erase = '()=>fs.unlinkSync("target.txt")'
    expect(
      await analyzeNotebookCodeRisk('repl', prefix + form.replaceAll('CALLBACK', reader))
    ).toEqual([])
    expect(
      (await analyzeNotebookCodeRisk('repl', prefix + form.replaceAll('CALLBACK', erase))).some(
        (risk) => risk.operation.includes('fs.unlinkSync')
      )
    ).toBe(true)
  })
  it.each([
    'const run=Function.prototype.apply.bind(fs.METHOD,null);',
    'const run=Reflect.apply(Function.prototype.bind,Function.prototype.apply,[fs.METHOD,null]);'
  ])('retains apply forwarding through complete and incomplete history: %s', async (form) => {
    const safe = prefix + form.replaceAll('METHOD', 'readFileSync')
    const danger = prefix + form.replaceAll('METHOD', 'unlinkSync')
    expect(await analyzeNotebookCodeRisk('repl', safe + 'console.log(run)')).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'run(["target.txt","utf8"])', undefined, [safe])
    ).toEqual([])
    expect(
      (await analyzeNotebookCodeRisk('repl', 'run(["target.txt"])', undefined, [danger])).some(
        (risk) => risk.operation.includes('fs.unlinkSync')
      )
    ).toBe(true)
    expect(
      await analyzeNotebookCodeRisk('repl', 'run(["target.txt"])', undefined, [
        { script: danger, incomplete: true }
      ])
    ).not.toEqual([])
  })
  it.each([
    'Reflect.apply(Function.prototype.apply,chooseHandler(),[null,["target.txt"]])',
    'Reflect.apply(Function.prototype.call,chooseHandler(),[null,"target.txt"])',
    'Function.prototype.apply.call(Array.prototype.forEach,[1],callbacks)',
    'const run=Function.prototype.apply.bind(Array.prototype.forEach,[1]);[callbacks].forEach(run)',
    'const run=Function.prototype.apply.bind(setTimeout,null);values.map(run)',
    'const run=Function.prototype.apply.bind(Function.prototype.call,null);values.map(run)',
    'const run=Function.prototype.apply.bind(cp.execFileSync,null);run(args)',
    'const run=Function.prototype.apply.bind(cp.execFileSync,null);run(["echo",...args])',
    'let helper=fs.readFileSync.call;if(flag)helper=fs.unlinkSync.call;Reflect.apply(Function.prototype.call,helper,[fs.unlinkSync,null,"target.txt"])'
  ])('retains unknown nested payloads and helper callbacks: %s', async (code) => {
    expect(await analyzeNotebookCodeRisk('repl', prefix + code)).not.toEqual([])
  })
  it('retains effects of repeatedly bound apply callbacks', async () => {
    const source =
      prefix +
      'const first=Function.prototype.apply.bind(fs.METHOD,null);const second=Function.prototype.apply.bind(first,null);[[["target.txt","utf8"]]].map(second)'
    expect(
      await analyzeNotebookCodeRisk('repl', source.replaceAll('METHOD', 'readFileSync'))
    ).toEqual([])
    expect(
      (await analyzeNotebookCodeRisk('repl', source.replaceAll('METHOD', 'unlinkSync'))).some(
        (risk) => risk.operation.includes('fs.unlinkSync')
      )
    ).toBe(true)
  })
  it.each([
    'Reflect.apply(Function.prototype.call,Reflect.construct,[null,vm.Script,["1+1"]])',
    'Function.prototype.apply.call(Reflect.construct,null,[vm.Script,["1+1"]])'
  ])('retains nested compiled construction provenance: %s', async (factory) => {
    const source = 'const vm=require("node:vm");const prepared=' + factory + ';'
    expect(await analyzeNotebookCodeRisk('repl', source + 'prepared.createCachedData()')).toEqual(
      []
    )
    expect(
      (await analyzeNotebookCodeRisk('repl', source + 'prepared.runInNewContext()')).some((risk) =>
        risk.operation.includes('vm.Script.runInNewContext')
      )
    ).toBe(true)
    expect(
      (
        await analyzeNotebookCodeRisk('repl', 'prepared.runInNewContext()', undefined, [source])
      ).some((risk) => risk.operation.includes('vm.Script.runInNewContext'))
    ).toBe(true)
  })
  it('preserves ordinary apply methods and eager effect cardinality', async () => {
    expect(
      await analyzeNotebookCodeRisk(
        'repl',
        prefix + 'const run=Function.prototype.apply.bind(fs.readFileSync,null);run(args)'
      )
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'const model=makeModel();model.apply(batch)')
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk(
        'repl',
        prefix +
          'Reflect.apply(Function.prototype.apply,fs.readFileSync,[null,[(fs.unlinkSync("other.txt"),"target.txt"),"utf8"]])'
      )
    ).toEqual([
      expect.objectContaining({ operation: 'fs.unlinkSync', source: 'fs.unlinkSync("other.txt")' })
    ])
  })
  it('bounds nested helper analysis conservatively', async () => {
    let args = '[fs.readFileSync,null,["target.txt","utf8"]]'
    for (let depth = 0; depth < 70; depth++) args = '[Reflect.apply,null,' + args + ']'
    const source = prefix + 'Reflect.apply(Reflect.apply,null,' + args + ')'
    expect(await analyzeNotebookCodeRisk('repl', source)).not.toEqual([])
  })
})

describe('forwarded binding receiver evidence', () => {
  const prefix = 'const fs=require("fs");'
  const forms = [
    ['', '(fs.METHOD.bind)(null)', '("target.txt","utf8")'],
    ['', '(fs.METHOD["bind"])(null)', '("target.txt","utf8")'],
    ['', 'Function.prototype.bind.call(fs.METHOD,null)', '("target.txt","utf8")'],
    ['', 'Function.prototype.bind.apply(fs.METHOD,[null])', '("target.txt","utf8")'],
    ['', 'Function.prototype.bind.apply(fs.METHOD,(([])))', '("target.txt","utf8")'],
    ['', 'Reflect.apply(Function.prototype.bind,fs.METHOD,[null])', '("target.txt","utf8")'],
    [
      '',
      'globalThis.Reflect.apply(Function.prototype.bind,fs.METHOD,[null])',
      '("target.txt","utf8")'
    ],
    [
      '',
      'Reflect.apply(Reflect.apply,null,[Function.prototype.bind,fs.METHOD,[null]])',
      '("target.txt","utf8")'
    ],
    ['const bind=Function.prototype.bind;', 'bind.call(fs.METHOD,null)', '("target.txt","utf8")'],
    ['const {bind}=Function.prototype;', 'bind.apply(fs.METHOD,[null])', '("target.txt","utf8")'],
    ['const bind=fs.OTHER.bind;', 'Reflect.apply(bind,fs.METHOD,[null])', '("target.txt","utf8")'],
    ['', 'fs.OTHER.bind.call(fs.METHOD,null)', '("target.txt","utf8")'],
    [
      'let fn=fs.METHOD;',
      'Function.prototype.bind.call(fn,(fn=fs.OTHER,null))',
      '("target.txt","utf8")'
    ],
    [
      'let fn=fs.METHOD;',
      'Function.prototype.bind.apply(fn,[(fn=fs.OTHER,null)])',
      '("target.txt","utf8")'
    ],
    [
      'let fn=fs.METHOD;',
      'Reflect.apply(Function.prototype.bind,fn,[(fn=fs.OTHER,null)])',
      '("target.txt","utf8")'
    ],
    ['', 'Function.prototype.apply.bind(fs.METHOD,null)', '(["target.txt","utf8"])'],
    [
      '',
      'Reflect.apply(Function.prototype.bind,Function.prototype.apply,[fs.METHOD,null])',
      '(["target.txt","utf8"])'
    ],
    [
      '',
      'Reflect.apply(Function.prototype.bind,Function.prototype.call,[fs.METHOD,null])',
      '("target.txt","utf8")'
    ]
  ]
  for (const danger of [false, true]) {
    const fill = (source: string): string =>
      source
        .replaceAll('METHOD', danger ? 'unlinkSync' : 'readFileSync')
        .replaceAll('OTHER', danger ? 'readFileSync' : 'unlinkSync')
    it.each(forms)(
      'resolves forwarded binding danger=' + danger + ': %s %s',
      async (setup, factory, invoke) => {
        const source = prefix + fill(setup) + `(${fill(factory)})${invoke}`
        const risks = await analyzeNotebookCodeRisk('repl', source)
        if (danger)
          expect(risks.some((risk) => risk.operation.includes('fs.unlinkSync'))).toBe(true)
        else expect(risks).toEqual([])
      }
    )
    it.each(forms)(
      'preserves forwarded saved bindings danger=' + danger + ': %s %s',
      async (setup, factory, invoke) => {
        const previous = prefix + fill(setup) + `const saved=${fill(factory)};`
        expect(
          await analyzeNotebookCodeRisk('repl', previous + 'console.log(typeof saved)')
        ).toEqual([])
        const risks = await analyzeNotebookCodeRisk('repl', 'saved' + invoke, undefined, [previous])
        if (danger)
          expect(risks.some((risk) => risk.operation.includes('fs.unlinkSync'))).toBe(true)
        else expect(risks).toEqual([])
      }
    )
  }
  it.each([
    'Function.prototype.bind.call(chooseHandler(),null)("target.txt")',
    'Function.prototype.bind.apply(fs.readFileSync,args)("target.txt")',
    'Reflect.apply(Function.prototype.bind,fs.readFileSync,args)("target.txt")',
    'Function.prototype.bind.call(fs.readFileSync,...args)("target.txt")',
    'const bind=Function.prototype.bind;bind(null)("target.txt")',
    'Reflect.apply(Function.prototype.bind,Array.prototype.forEach,[null,fs.unlinkSync])()',
    'Function.prototype.bind.call(setTimeout,null,fs.unlinkSync,0)()',
    'Function.prototype.bind.apply(require("child_process").execFileSync,[null,"rm",["target.txt"]])()',
    'const object={bind(){fs.unlinkSync("target.txt");return fs.readFileSync}};object.bind(null)("target.txt")'
  ])('retains unknown, pre-bound and custom effects: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', prefix + source)).not.toEqual([])
  })
  it.each([
    'Function.prototype.bind.call(callback,null)',
    'Function.prototype.bind.apply(callback,[null])',
    'Reflect.apply(Function.prototype.bind,callback,[null])'
  ])('resolves bound callback effects: %s', async (factory) => {
    const read =
      prefix + 'const callback=()=>fs.readFileSync("target.txt","utf8");[1].map(' + factory + ')'
    const erase = prefix + 'const callback=()=>fs.unlinkSync("target.txt");[1].map(' + factory + ')'
    expect(await analyzeNotebookCodeRisk('repl', read)).toEqual([])
    expect(
      (await analyzeNotebookCodeRisk('repl', erase)).some((risk) =>
        risk.operation.includes('fs.unlinkSync')
      )
    ).toBe(true)
  })
  it('visits eager binding arguments once and keeps incomplete history reviewable', async () => {
    const source =
      prefix +
      'Function.prototype.bind.call(fs.readFileSync,(fs.unlinkSync("other.txt"),null))("target.txt","utf8")'
    expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([
      expect.objectContaining({ operation: 'fs.unlinkSync', source: 'fs.unlinkSync("other.txt")' })
    ])
    const previous =
      prefix +
      'let fn=fs.unlinkSync;const saved=Reflect.apply(Function.prototype.bind,fn,[(fn=fs.readFileSync,null)]);'
    expect(
      await analyzeNotebookCodeRisk('repl', 'saved("target.txt")', undefined, [
        { script: previous, incomplete: true }
      ])
    ).not.toEqual([])
  })
  it.each([
    'Function.prototype.bind.call(vm.Script,null)',
    'Function.prototype.bind.apply(vm.Script,[null])',
    'Reflect.apply(Function.prototype.bind,vm.Script,[null])'
  ])('preserves forwarded bound constructor provenance: %s', async (factory) => {
    const source =
      'const vm=require("node:vm");const Constructor=' +
      factory +
      ';const prepared=new Constructor("1+1");'
    expect(await analyzeNotebookCodeRisk('repl', source + 'prepared.createCachedData()')).toEqual(
      []
    )
    expect(
      (await analyzeNotebookCodeRisk('repl', source + 'prepared.runInNewContext()')).some((risk) =>
        risk.operation.includes('vm.Script.runInNewContext')
      )
    ).toBe(true)
    expect(
      (
        await analyzeNotebookCodeRisk('repl', 'prepared.runInNewContext()', undefined, [source])
      ).some((risk) => risk.operation.includes('vm.Script.runInNewContext'))
    ).toBe(true)
  })
})

describe('returned callable evaluation evidence', () => {
  const prefix = 'const fs=require("fs");'
  const forms = [
    ['let fn=fs.METHOD;', 'fn.bind(null,(fn=fs.OTHER,"target.txt"),"utf8")'],
    [
      'let object={run:fs.METHOD};',
      'object.run.bind(null,(object.run=fs.OTHER,"target.txt"),"utf8")'
    ],
    ['let fn=fs.METHOD;', 'Function.prototype.call.bind(fn,(fn=fs.OTHER,null))'],
    ['let fn=fs.METHOD;', 'console.log.call.bind(fn,(fn=fs.OTHER,null))'],
    ['let object={run:fs.METHOD};', 'Reflect.get(object,"run",(object={run:fs.OTHER}))'],
    ['let object={run:fs.METHOD};', 'Reflect.get.call(null,object,"run",(object={run:fs.OTHER}))'],
    [
      'let object={run:fs.METHOD};',
      'Reflect.get.apply(null,[object,"run",(object={run:fs.OTHER})])'
    ],
    [
      'let object={run:fs.METHOD};',
      'Reflect.apply(Reflect.get,null,[object,"run",(object={run:fs.OTHER})])'
    ],
    [
      'let object={run:fs.METHOD};const lookup=Reflect.get;',
      'lookup(object,"run",(object={run:fs.OTHER}))'
    ],
    ['let object={run:fs.METHOD};', 'globalThis.Reflect.get(object,"run",(object={run:fs.OTHER}))'],
    ['let object={run:fs.METHOD};', 'Reflect.get.bind(null)(object,"run",(object={run:fs.OTHER}))'],
    ['let lookup=Reflect.get;', 'lookup(fs,"METHOD",(lookup=()=>fs.OTHER))'],
    ['let object={run:fs.OTHER};', 'Reflect.get(object,"run",(object.run=fs.METHOD,object))'],
    [
      'let object={run:fs.OTHER};',
      'Reflect.get.apply(null,[object,"run",(object.run=fs.METHOD,object)])'
    ],
    ['let fn=fs.METHOD;', 'fn.bind((fn=fs.OTHER,null),"target.txt","utf8")'],
    [
      'let object={run:fs.METHOD};',
      'Reflect.get(object,"run").bind(null,(object.run=fs.OTHER,"target.txt"),"utf8")'
    ],
    [
      'let object={run:fs.METHOD};',
      'Reflect.get(object,"run",(object={run:fs.OTHER})).bind(null,"target.txt","utf8")'
    ],
    [
      'let object={run:fs.METHOD};',
      'Reflect.get(object,"run",(object={run:fs.OTHER})).bind(null).bind(null)'
    ]
  ]
  for (const danger of [false, true]) {
    const fill = (source: string): string =>
      source
        .replaceAll('METHOD', danger ? 'unlinkSync' : 'readFileSync')
        .replaceAll('OTHER', danger ? 'readFileSync' : 'unlinkSync')
    it.each(forms)(
      'captures returned function danger=' + danger + ': %s %s',
      async (setup, callable) => {
        const source =
          prefix + fill(setup) + `const saved=${fill(callable)};saved("target.txt","utf8")`
        const risks = await analyzeNotebookCodeRisk('repl', source)
        if (danger)
          expect(risks.some((risk) => risk.operation.includes('fs.unlinkSync'))).toBe(true)
        else expect(risks).toEqual([])
      }
    )
    it.each(forms)(
      'captures immediate returned call danger=' + danger + ': %s %s',
      async (setup, callable) => {
        const risks = await analyzeNotebookCodeRisk(
          'repl',
          prefix + fill(setup) + `(${fill(callable)})("target.txt","utf8")`
        )
        if (danger)
          expect(risks.some((risk) => risk.operation.includes('fs.unlinkSync'))).toBe(true)
        else expect(risks).toEqual([])
      }
    )
    it.each(forms)(
      'keeps captured history danger=' + danger + ': %s %s',
      async (setup, callable) => {
        const previous = prefix + fill(setup) + `const saved=${fill(callable)};`
        expect(await analyzeNotebookCodeRisk('repl', previous)).toEqual([])
        const risks = await analyzeNotebookCodeRisk(
          'repl',
          'saved("target.txt","utf8")',
          undefined,
          [previous]
        )
        if (danger)
          expect(risks.some((risk) => risk.operation.includes('fs.unlinkSync'))).toBe(true)
        else expect(risks).toEqual([])
      }
    )
  }
  it.each([
    'let fn=fs.readFileSync;["target.txt"].map(fn.bind((fn=fs.unlinkSync,null)))',
    'let object={run:fs.readFileSync};["target.txt"].map(Reflect.get(object,"run",(object={run:fs.unlinkSync})))',
    'let object={run:fs.readFileSync};Reflect.apply(Array.prototype.map,["target.txt"],[Reflect.get(object,"run",(object={run:fs.unlinkSync}))])'
  ])('keeps captured reader callbacks ordinary: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', prefix + source)).toEqual([])
  })
  it.each([
    'let fn=fs.unlinkSync;["target.txt"].map(fn.bind((fn=fs.readFileSync,null)))',
    'let object={run:fs.unlinkSync};["target.txt"].map(Reflect.get(object,"run",(object={run:fs.readFileSync})))',
    'let object={run:fs.unlinkSync};Reflect.apply(Array.prototype.map,["target.txt"],[Reflect.get(object,"run",(object={run:fs.readFileSync}))])',
    'let object={run:chooseHandler()};Reflect.get(object,"run",(object={run:fs.readFileSync}))("target.txt")',
    'let fn=chooseHandler();fn.bind((fn=fs.readFileSync,null))("target.txt")',
    'Reflect.get(fs,key)()',
    'Reflect.get(...args)()',
    'Reflect.get({get run(){fs.unlinkSync("target.txt");return fs.readFileSync}},"run")("target.txt")'
  ])('retains captured deletion and unknown factory values: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', prefix + source)).not.toEqual([])
  })
  const compiledForms = [
    'new Constructor((Constructor=Array,"1+1"))',
    'new (Constructor.bind(null))((Constructor=Array,"1+1"))',
    'Reflect.construct(Constructor,[(Constructor=Array,"1+1")])',
    'Reflect.construct.call(null,Constructor,[(Constructor=Array,"1+1")])',
    'Reflect.apply(Reflect.construct,null,[Constructor,[(Constructor=Array,"1+1")]])'
  ]
  for (const form of compiledForms) {
    const previous =
      'const vm=require("node:vm");let Constructor=vm.Script;const prepared=' + form + ';'
    it('keeps captured construction passive: ' + form, async () => {
      expect(
        await analyzeNotebookCodeRisk('repl', previous + 'console.log(prepared.createCachedData())')
      ).toEqual([])
    })
    it('reviews execution on captured constructed objects: ' + form, async () => {
      expect(
        (await analyzeNotebookCodeRisk('repl', previous + 'prepared.runInNewContext()')).some(
          (risk) => risk.operation.includes('vm.Script.runInNewContext')
        )
      ).toBe(true)
    })
    it('keeps constructed provenance across source trees: ' + form, async () => {
      expect(
        (
          await analyzeNotebookCodeRisk('repl', 'prepared.runInNewContext()', undefined, [previous])
        ).some((risk) => risk.operation.includes('vm.Script.runInNewContext'))
      ).toBe(true)
    })
  }
  it('does not invent compiled provenance from a later constructor assignment', async () => {
    const source =
      'const vm=require("vm");let Constructor=Array;const prepared=new Constructor((Constructor=vm.Script,"1+1"));prepared.push(2)'
    expect(await analyzeNotebookCodeRisk('repl', source)).toEqual([])
  })
  it('refreshes returned function evidence on each loop iteration', async () => {
    const safe =
      prefix +
      'for(const fn of [fs.readFileSync,fs.readFileSync])fn.bind(null)("target.txt","utf8")'
    const danger =
      prefix + 'for(const fn of [fs.readFileSync,fs.unlinkSync])fn.bind(null)("target.txt")'
    expect(await analyzeNotebookCodeRisk('repl', safe)).toEqual([])
    expect(
      (await analyzeNotebookCodeRisk('repl', danger)).some((risk) =>
        risk.operation.includes('fs.unlinkSync')
      )
    ).toBe(true)
  })
  it('retains incomplete returned-function history and eager effects', async () => {
    const previous = prefix + 'let fn=fs.unlinkSync;const saved=fn.bind((fn=fs.readFileSync,null));'
    expect(
      await analyzeNotebookCodeRisk('repl', 'saved("target.txt")', undefined, [
        { script: previous, incomplete: true }
      ])
    ).not.toEqual([])
    const risks = await analyzeNotebookCodeRisk(
      'repl',
      prefix + 'fs.readFileSync.bind(null,(fs.unlinkSync("other.txt"),"target.txt"))("utf8")'
    )
    expect(risks).toEqual([
      expect.objectContaining({ operation: 'fs.unlinkSync', source: 'fs.unlinkSync("other.txt")' })
    ])
  })
})

describe('fixed object callable values', () => {
  const prefix = 'const fs=require("fs");'
  const definitions = [
    'const handlers={cleanup:()=>fs.unlinkSync("target.txt")};',
    'const handlers={cleanup:function(){fs.unlinkSync("target.txt")}};',
    'const handlers={cleanup:function remove(){fs.unlinkSync("target.txt")}};',
    'const handlers={cleanup:(()=>fs.unlinkSync("target.txt"))};',
    'const handlers={cleanup:fs.unlinkSync};',
    'const cleanup=fs.unlinkSync;const handlers={cleanup};'
  ]
  for (const definition of definitions) {
    it.each([
      'console.log(Object.keys(handlers))',
      'console.log(typeof handlers.cleanup)',
      'const saved=handlers.cleanup;console.log(typeof saved)',
      'const {cleanup:saved}=handlers;console.log(typeof saved)'
    ])('keeps stored functions passive: %s ' + definition, async (suffix) => {
      expect(await analyzeNotebookCodeRisk('repl', prefix + definition + suffix)).toEqual([])
    })
    it.each([
      'handlers.cleanup("target.txt")',
      'handlers["cleanup"]("target.txt")',
      'const saved=handlers.cleanup;saved("target.txt")',
      'const {cleanup:saved}=handlers;saved("target.txt")',
      'handlers.cleanup.call(null,"target.txt")',
      'handlers.cleanup.apply(null,["target.txt"])',
      'handlers.cleanup.bind(null)("target.txt")',
      '["target.txt"].forEach(handlers.cleanup)'
    ])('retains stored function invocation: %s ' + definition, async (suffix) => {
      expect(await analyzeNotebookCodeRisk('repl', prefix + definition + suffix)).not.toEqual([])
    })
  }
  it.each([
    'const handlers={cleanup(){fs.unlinkSync("target.txt")},cleanup:()=>console.log("hello")};handlers.cleanup()',
    'const handlers={cleanup:()=>fs.unlinkSync("target.txt"),cleanup(){console.log("hello")}};handlers.cleanup()',
    'const handlers={cleanup(){fs.unlinkSync("target.txt")},cleanup:console.log};const {cleanup}=handlers;cleanup("hello")',
    'const handlers={cleanup:fs.unlinkSync,cleanup:console.log};handlers.cleanup("hello")',
    'const cleanup=console.log;const handlers={cleanup(){fs.unlinkSync("target.txt")},cleanup};handlers.cleanup("hello")',
    'const handlers={read:console.log};const {read}=handlers;read("hello")',
    'const handlers={nested:{read:console.log}};const saved=handlers.nested.read;saved("hello")',
    'const handlers={cleanup:()=>fs.unlinkSync("target.txt")};handlers.cleanup=console.log;handlers.cleanup("hello")',
    'const handlers={run:require("child_process").execFileSync};console.log(handlers.run("echo",["hello"]).toString())',
    'const handlers={read:console.log};handlers.read.call.bind(handlers.read,null)("hello")',
    'const handlers={cleanup:fs.unlinkSync,read:console.log};handlers.cleanup.call.bind(handlers.read,null)("hello")',
    'const process=require("child_process");const saved=process.execFileSync.call.bind(process.execFileSync,null);saved("echo",["hello"])',
    'const handlers={cleanup:()=>fs.unlinkSync("target.txt")};const data={handlers};Object.keys(data)'
  ])('uses current property values without invoking prior definitions: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', prefix + source)).toEqual([])
  })
  it.each([
    'const handlers={cleanup:console.log,cleanup:fs.unlinkSync};handlers.cleanup("target.txt")',
    'const cleanup=fs.unlinkSync;const handlers={cleanup:console.log,cleanup};handlers.cleanup("target.txt")',
    'const handlers={cleanup:()=>console.log("hello"),cleanup(){fs.unlinkSync("target.txt")}};handlers.cleanup()',
    'const handlers={nested:{cleanup:fs.unlinkSync}};handlers.nested.cleanup("target.txt")',
    'const handlers={cleanup:()=>fs.unlinkSync("target.txt")};const saved=handlers.cleanup;handlers.cleanup=console.log;saved()',
    'const handlers={cleanup:fs.unlinkSync("target.txt"),cleanup:console.log};handlers.cleanup("hello")',
    'const handlers={read(){console.log("hello")},read:factory()};handlers.read()',
    'let handlers={cleanup:fs.unlinkSync};if(flag)handlers={cleanup:console.log};handlers.cleanup("target.txt")',
    'const handlers={run:require("child_process").execFileSync};handlers.run("rm",["target.txt"])',
    'const handlers={cleanup:fs.unlinkSync};handlers.cleanup.call.bind(handlers.cleanup,null)("target.txt")',
    'const handlers={cleanup:fs.unlinkSync};handlers.cleanup["call"]["bind"](handlers.cleanup,null)("target.txt")',
    'const handlers={cleanup:fs.unlinkSync,read:console.log};handlers.read.call.bind(handlers.cleanup,null)("target.txt")',
    'const handlers={cleanup:fs.unlinkSync};const forward=handlers.cleanup.call;const saved=forward.bind(handlers.cleanup,null);saved("target.txt")',
    'const process=require("child_process");const saved=process.execFileSync.call.bind(process.execFileSync,null);saved("rm",["target.txt"])',
    'const process=require("child_process");const saved=process.execFileSync.call.bind(process.execFileSync,null,"rm");saved(["target.txt"])',
    'const handlers={cleanup:()=>this.erase()};handlers.cleanup()',
    'const handlers={get cleanup(){fs.unlinkSync("target.txt");return console.log}};Object.values(handlers)',
    'const handlers={toString:()=>{fs.unlinkSync("target.txt");return "value"}};String(handlers)',
    'const handlers={toJSON:()=>{fs.unlinkSync("target.txt");return {}}};JSON.stringify(handlers)',
    'const handlers={...unknown,cleanup:()=>fs.unlinkSync("target.txt")};handlers.cleanup()',
    'const handlers={[key]:()=>fs.unlinkSync("target.txt")};handlers[key]()'
  ])('retains eager, invoked and unresolved effects: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', prefix + source)).not.toEqual([])
  })
  it.each(definitions)('keeps callable evidence across cells: %s', async (definition) => {
    const saved = prefix + definition + 'const saved=handlers.cleanup;handlers.cleanup=console.log;'
    expect(await analyzeNotebookCodeRisk('repl', saved)).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'saved("target.txt")', undefined, [saved])
    ).not.toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'handlers.cleanup("hello")', undefined, [saved])
    ).toEqual([])
    expect(
      await analyzeNotebookCodeRisk('repl', 'handlers.cleanup("target.txt")', undefined, [
        { script: saved, incomplete: true }
      ])
    ).not.toEqual([])
  })
})

describe('deferred ordinary object methods', () => {
  const definition =
    'const fs = require("fs"); let object = { cleanup() { fs.unlinkSync("data.txt") } };'
  it.each([
    '',
    'console.log(object)',
    'Object.keys(object)',
    'Object.values(object)',
    'const saved = object.cleanup',
    'const alias = object',
    'const opts = { env: object }; require("child_process").execFileSync("echo", ["hello"], { env: {} })'
  ])('leaves passive definitions and data prompt-free: %s', async (suffix) => {
    expect(await analyzeNotebookCodeRisk('repl', definition + suffix)).toEqual([])
  })
  it.each([
    'object.cleanup()',
    'const {cleanup}=object; cleanup()',
    'const {cleanup: saved}=object; saved()',
    'const {cleanup}=object; cleanup.call(null)',
    'let selected=object; if(flag) selected={cleanup(){}}; selected.cleanup=()=>fs.unlinkSync("data.txt"); selected.cleanup()',

    'object["cleanup"]()',
    'const saved = object.cleanup; saved()',
    'const alias = object; alias.cleanup()',
    'object.cleanup.call(null)',
    'object.cleanup.bind(null)()',
    'if (flag) { const other = { cleanup() {} }; object = other }; object.cleanup()',
    'object.cleanup = fs.unlinkSync; object.cleanup("data.txt")',
    'object["cleanup"] = () => fs.unlinkSync("data.txt"); object.cleanup()',
    'String({ toString() { fs.unlinkSync("data.txt"); return "value" } })'
  ])('retains executable method effects: %s', async (suffix) => {
    expect(await analyzeNotebookCodeRisk('repl', definition + suffix)).not.toEqual([])
  })
  it.each([
    'const obj = { toString() { fs.unlinkSync("data.txt"); return "value" } }; String([obj])',
    'const obj = { valueOf() { fs.unlinkSync("data.txt"); return 1 } }; obj + 1',
    'const obj = { toJSON() { fs.unlinkSync("data.txt"); return {} } }; JSON.stringify({nested:obj})',
    'const obj = { then(resolve) { fs.unlinkSync("data.txt"); resolve(1) } }; Promise.resolve(obj)',
    'const obj = { get value() { fs.unlinkSync("data.txt") } }; obj.value',
    'const obj = { [Symbol.toPrimitive]() { fs.unlinkSync("data.txt"); return "value" } }; String(obj)',
    'const obj = { method() { this.cleanup() } }; obj.method()'
  ])('retains unproven receivers and implicit execution: %s', async (source) => {
    expect(await analyzeNotebookCodeRisk('repl', 'const fs = require("fs");' + source)).not.toEqual(
      []
    )
  })
  it('keeps method aliases across history without executing their definitions', async () => {
    const previous = definition + 'const saved = object.cleanup; object = null;'
    expect(await analyzeNotebookCodeRisk('repl', previous)).toEqual([])
    expect(await analyzeNotebookCodeRisk('repl', 'saved()', undefined, [previous])).not.toEqual([])
  })
  it('yields history replay to timers and stops on abort', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 0)
    try {
      await expect(
        analyzeNotebookCodeRisk(
          'python',
          'print(1)',
          undefined,
          Array.from(
            { length: 200 },
            () => 'import subprocess; subprocess.run(["echo", "hello"], check=True)'
          ),
          controller.signal
        )
      ).rejects.toThrow()
    } finally {
      clearTimeout(timer)
    }
  })
  it('does not reuse a shell verdict across different analyses or dangerous commands', async () => {
    const safe = 'import subprocess; subprocess.run("echo hello", shell=True)'
    expect(await analyzeNotebookCodeRisk('python', safe, undefined, Array(40).fill(safe))).toEqual(
      []
    )
    expect(
      await analyzeNotebookCodeRisk(
        'python',
        'subprocess.run("rm data.txt", shell=True)',
        undefined,
        [safe]
      )
    ).not.toEqual([])
  })
})
