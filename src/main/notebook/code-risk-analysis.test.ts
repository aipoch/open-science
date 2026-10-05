import { describe, expect, it } from 'vitest'
import { analyzeNotebookCodeRisk, analyzePowerShellCodeRisk } from './code-risk-analysis'

describe('Notebook execution code risk', () => {
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

  it('fails to reviewable evidence on invalid source', async () => {
    expect(await analyzeNotebookCodeRisk('python', 'def (')).toMatchObject([
      { operation: 'parse-error' }
    ])
  })
})
