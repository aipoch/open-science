import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Execute the production cold-recovery algorithm in an isolated process. Only native process
// observations and signals are faked, so these cases are portable and never signal real PIDs.
const probe = (scenario: string): { outcome: string; signals: number[] } => {
  const filename = join(__dirname, 'process-tree.ts')
  const script = `
    const Module = require('node:module')
    const { readFileSync } = require('node:fs')
    const ts = require('typescript')
    const filename = ${JSON.stringify(filename)}
    const scenario = process.argv[1]
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const unrelated = { pid: 2000, ppid: 1, pgid: 2000, sid: 2000, uniqueId: '200', parentUniqueId: '1' }
    const processes = new Map([[2000, unrelated]])
    if (scenario === 'reused-leader') processes.set(1000, { ...unrelated, pid: 1000, uniqueId: '300' })
    if (scenario === 'surviving-group') processes.set(3000, { ...unrelated, pid: 3000, pgid: 1000 })
    const binding = {
      getDarwinProcess: pid => processes.get(pid) ?? null,
      listDarwinProcesses: () => ({ processes: [...processes.values()], complete: scenario !== 'incomplete-table' }),
      getDarwinEnvironmentValue: pid => {
        if (scenario === 'unreadable') return null
        if (scenario === 'identity-race') processes.set(pid, { ...unrelated, uniqueId: '301' })
        if (scenario === 'escaped') return 'owner-token'
        if (scenario === 'foreign-marker') return 'another-owner-token'
        return false
      }
    }
    const instance = new Module(filename, module)
    instance.filename = filename
    instance.paths = Module._nodeModulePaths(require('node:path').dirname(filename))
    const originalRequire = instance.require.bind(instance)
    instance.require = id => id === '@aipoch/process-tree-native' ? binding : originalRequire(id)
    instance._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, filename)
    const signals = []
    process.kill = (pid, signal) => {
      const targets = [...processes.values()].filter(p => pid < 0 ? p.pgid === -pid : p.pid === pid)
      if (!targets.length) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (signal !== 0) signals.push(pid)
      return true
    }
    instance.exports.proveRecordedPosixLeaderGone({ pid: 1000, birthToken: 'darwin-proc-uniqueid:100' }, 'owner-token')
      .then(outcome => process.stdout.write(JSON.stringify({ outcome, signals })))
      .catch(error => { console.error(error); process.exitCode = 1 })
  `
  return JSON.parse(execFileSync(process.execPath, ['-e', script, scenario], { encoding: 'utf8' }))
}

describe('Darwin cold process recovery', () => {
  it.each(['ordinary-process', 'foreign-marker', 'reused-leader'])(
    'clears a gone tree despite an unrelated %s',
    (scenario) => {
      expect(probe(scenario)).toEqual({ outcome: 'gone', signals: [] })
    }
  )

  it.each(['escaped', 'unreadable', 'incomplete-table', 'identity-race', 'surviving-group'])(
    'retains the receipt for %s without signalling unrelated processes',
    (scenario) => {
      expect(probe(scenario)).toEqual({ outcome: 'blocked', signals: [] })
    }
  )
})
