import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Execute the production cold-recovery algorithm in an isolated process. Only native process
// observations and signals are faked, so these cases are portable and never signal real PIDs.
const probe = (
  scenario: string
): { outcome: string; signals: { pid: number; signal: string; identities: string[] }[] } => {
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
    const ownedScenarios = ['reuse-before-term', 'reuse-leader-after-term', 'reuse-descendant-before-term',
      'reuse-descendant-after-term', 'owned-escalation', 'leader-gone-during-term', 'incomplete-before-force',
      'reuse-before-kill', 'reuse-descendant-before-kill']
    if (ownedScenarios.includes(scenario)) {
      processes.set(1000, { pid: 1000, ppid: 1, pgid: 1000, sid: 1000, uniqueId: '100', parentUniqueId: '1' })
      processes.set(1100, { pid: 1100, ppid: 1000, pgid: 1100, sid: 1100, uniqueId: '110', parentUniqueId: '100' })
    }
    if (scenario === 'reused-leader') processes.set(1000, { ...unrelated, pid: 1000, uniqueId: '300' })
    if (scenario === 'surviving-group') processes.set(3000, { ...unrelated, pid: 3000, pgid: 1000 })
    let samples = 0
    const binding = {
      getDarwinProcess: pid => processes.get(pid) ?? null,
      listDarwinProcesses: () => {
        ++samples
        const sampled = [...processes.values()]
        if (samples === 2 && scenario === 'reuse-before-term')
          processes.set(1000, { ...unrelated, pid: 1000, pgid: 1000, sid: 1000, uniqueId: '300' })
        if (samples === 2 && scenario === 'reuse-descendant-before-term')
          processes.set(1100, { ...unrelated, pid: 1100, pgid: 1100, sid: 1100, uniqueId: '310' })
        if (samples === 3 && scenario === 'reuse-before-kill')
          processes.set(1000, { ...unrelated, pid: 1000, pgid: 1000, sid: 1000, uniqueId: '300' })
        if (samples === 3 && scenario === 'reuse-descendant-before-kill')
          processes.set(1100, { ...unrelated, pid: 1100, pgid: 1100, sid: 1100, uniqueId: '310' })
        return { processes: sampled, complete: scenario !== 'incomplete-table' &&
          !(samples >= 3 && scenario === 'incomplete-before-force') }
      },
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
    let now = 0
    Date.now = () => now
    const originalTimeout = global.setTimeout
    global.setTimeout = (callback, delay) => originalTimeout(() => { now += delay; callback() }, 0)
    const keepAlive = setInterval(() => {}, 100)
    process.kill = (pid, signal) => {
      const targets = [...processes.values()].filter(p => pid < 0 ? p.pgid === -pid : p.pid === pid)
      if (!targets.length) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (signal !== 0) {
        signals.push({ pid, signal, identities: targets.map(p => p.uniqueId) })
        if (signal === 'SIGTERM' && pid === -1000 && scenario === 'reuse-leader-after-term')
          processes.set(1000, { ...unrelated, pid: 1000, pgid: 1000, sid: 1000, uniqueId: '300' })
        if (signal === 'SIGTERM' && pid === 1100 && scenario === 'reuse-descendant-after-term')
          processes.set(1100, { ...unrelated, pid: 1100, pgid: 1100, sid: 1100, uniqueId: '310' })
        if (signal === 'SIGTERM' && pid === -1000 && scenario === 'leader-gone-during-term') {
          processes.delete(1000)
          processes.set(1200, { ...unrelated, pid: 1200, pgid: 1000, sid: 1000, uniqueId: '120' })
        }
        if (signal === 'SIGKILL') for (const target of targets) processes.delete(target.pid)
      }
      return true
    }
    instance.exports.proveRecordedPosixLeaderGone({ pid: 1000, birthToken: 'darwin-proc-uniqueid:100' }, 'owner-token')
      .then(outcome => {
        if (!processes.has(2000)) throw new Error('unrelated control process was killed')
        process.stdout.write(JSON.stringify({ outcome, signals }))
      })
      .catch(error => { console.error(error); process.exitCode = 1 })
      .finally(() => clearInterval(keepAlive))
  `
  return JSON.parse(execFileSync(process.execPath, ['-e', script, scenario], { encoding: 'utf8' }))
}

describe('Darwin cold process recovery', () => {
  it.each(['ordinary-process', 'foreign-marker', 'reused-leader', 'identity-race'])(
    'clears a gone tree despite an unrelated %s',
    (scenario) => {
      expect(probe(scenario)).toEqual({ outcome: 'gone', signals: [] })
    }
  )

  it.each(['escaped', 'unreadable', 'incomplete-table', 'surviving-group'])(
    'retains the receipt for %s without signalling unrelated processes',
    (scenario) => {
      expect(probe(scenario)).toEqual({ outcome: 'blocked', signals: [] })
    }
  )

  it('rejects a leader reused during the asynchronous pre-signal snapshot', () => {
    expect(probe('reuse-before-term')).toEqual({ outcome: 'blocked', signals: [] })
  })

  it.each([
    'reuse-leader-after-term',
    'leader-gone-during-term',
    'incomplete-before-force',
    'reuse-before-kill'
  ])('never escalates a receipt after %s', (scenario) => {
    const result = probe(scenario)
    expect(result.outcome).toBe('blocked')
    expect(result.signals.some(({ signal }) => signal === 'SIGTERM')).toBe(true)
    expect(result.signals.filter(({ signal }) => signal === 'SIGKILL')).toEqual([])
  })

  it.each([
    'reuse-descendant-before-term',
    'reuse-descendant-after-term',
    'reuse-descendant-before-kill'
  ])('does not signal a detached replacement in %s', (scenario) => {
    const result = probe(scenario)
    expect(result.outcome).toBe('gone')
    expect(result.signals.flatMap(({ identities }) => identities)).not.toContain('310')
    expect(
      result.signals.filter(({ pid, signal }) => pid === 1100 && signal === 'SIGKILL')
    ).toEqual([])
  })

  it('can escalate exact recorded leader and detached descendant births while preserving a control', () => {
    expect(probe('owned-escalation')).toEqual({
      outcome: 'gone',
      signals: [
        { pid: -1000, signal: 'SIGTERM', identities: ['100'] },
        { pid: 1100, signal: 'SIGTERM', identities: ['110'] },
        { pid: -1000, signal: 'SIGKILL', identities: ['100'] },
        { pid: 1100, signal: 'SIGKILL', identities: ['110'] }
      ]
    })
  })
})
