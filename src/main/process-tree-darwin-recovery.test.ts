import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Isolate the native binding and global process sampler. Only kernel observations/signals are
// injected; this executes the production tracker and teardown, including its retry cache.
const probe = (
  scenario: string
): {
  first: { reaped: boolean; diagnostics?: { failureCategory: string } }
  second: { reaped: boolean; diagnostics?: { failureCategory: string } }
  environmentReads: number
  signals: number[]
  admission?: string
} => {
  const filename = join(__dirname, 'process-tree.ts')
  const script = `
    const Module = require('node:module')
    const { EventEmitter } = require('node:events')
    const { readFileSync } = require('node:fs')
    const ts = require('typescript')
    const filename = ${JSON.stringify(filename)}
    const scenario = process.argv[1]
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const leader = { pid: 1000, ppid: process.pid, pgid: 1000, sid: 1000, uniqueId: '100', parentUniqueId: '50' }
    const candidate = { pid: 2000, ppid: 1, pgid: 2000, sid: 2000, uniqueId: scenario === 'cold-older-unreadable' ? '50' : '200', parentUniqueId: scenario === 'reparented-exec' ? '1' : '150' }
    if (scenario.startsWith('coalition-')) {
      if (scenario !== 'coalition-leader-missing') leader.coalitionId = '10'
      if (!['coalition-missing', 'coalition-history'].includes(scenario)) {
        candidate.coalitionId = scenario === 'coalition-same' ? '10' : '20'
      }
    }
    const processes = new Map([[1000, leader], [2000, candidate]])
    if (scenario === 'cold-owned-before-race') processes.set(3000, { ...candidate, pid: 3000, uniqueId: '300' })
    let environmentReads = 0
    let readable = false
    let incomplete = ['history-gap', 'cold-incomplete'].includes(scenario)
    let race = false
    const binding = {
      getDarwinProcess: pid => {
        if (pid === 2000 && scenario === 'coalition-unreadable') return null
        if (pid === 2000 && scenario === 'coalition-changed') return { ...candidate, coalitionId: undefined }
        if (pid === 2000 && scenario === 'coalition-reused') return { ...candidate, uniqueId: '201' }
        return processes.get(pid) ?? null
      },
      listDarwinProcesses: () => {
        const snapshot = { processes: [...processes.values()], complete: !incomplete }
        // The native snapshot already validated this identity. Model an external service exiting
        // before a redundant later read, without changing the evidence in the returned snapshot.
        if (scenario === 'coalition-vanished') processes.delete(2000)
        return snapshot
      },
      getDarwinEnvironmentValue: pid => {
        environmentReads++
        if (scenario === 'cold-marked-then-exit') {
          processes.delete(pid)
          return 'owner-token'
        }
        if (scenario === 'cold-owned-before-race') {
          if (pid === 2000) return 'owner-token'
          processes.delete(2000)
          processes.delete(pid)
          return null
        }
        if (!readable || scenario === 'cold-null') return null
        if ((['identity-race', 'cold-identity-race', 'cold-race-then-marked', 'cold-exit-race'].includes(scenario) && !race) || scenario === 'cold-sustained-race') {
          race = true
          if (scenario === 'cold-exit-race') processes.delete(pid)
          else processes.set(pid, { ...candidate, uniqueId: String(BigInt(processes.get(pid).uniqueId) + 1n) })
        }
        return ['owned', 'identity-race', 'reparented-exec', 'cold-marked', 'cold-race-then-marked'].includes(scenario) ? 'owner-token' : 'other-owner'
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
    const tree = instance.exports
    const signals = []
    process.kill = (pid, signal) => {
      if (scenario === 'cold-group-eperm' && pid === -1000) throw Object.assign(new Error('denied'), { code: 'EPERM' })
      const targets = [...processes.values()].filter(p => pid < 0 ? p.pgid === -pid : p.pid === pid)
      if (!targets.length) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (signal !== 0) {
        signals.push(pid)
        for (const target of targets) processes.delete(target.pid)
      }
      return true
    }
    const child = Object.assign(new EventEmitter(), { pid: 1000, exitCode: 0, signalCode: null, kill() { return true } })
    ;(async () => {
      if (scenario.startsWith('cold-')) {
        if (scenario !== 'cold-live') processes.delete(1000)
        if (scenario === 'cold-group') processes.set(2000, { ...candidate, pgid: 1000, sid: 1000 })
        readable = scenario !== 'cold-older-unreadable'
        const admission = await tree.proveRecordedPosixLeaderGone(
          { pid: 1000, birthToken: 'darwin-proc-uniqueid:100' }, 'owner-token', undefined,
          undefined, undefined, { terminateLive: false }
        )
        process.stdout.write(JSON.stringify({ admission, environmentReads, signals }))
        return
      }
      tree.trackOwnedPosixProcessTree(child, 'owner-token')
      await new Promise(resolve => setImmediate(resolve))
      const first = await tree.terminateProcessTree(child)
      readable = true
      if (scenario === 'coalition-history') candidate.coalitionId = '20'
      incomplete = false
      if (scenario === 'vanished') processes.delete(2000)
      const second = await tree.terminateProcessTree(child)
      process.stdout.write(JSON.stringify({ first, second, environmentReads, signals }))
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  return JSON.parse(execFileSync(process.execPath, ['-e', script, scenario], { encoding: 'utf8' }))
}

describe('Darwin ownership evidence reconciliation', () => {
  it('excludes a birth-validated foreign coalition before reading its environment', () => {
    const result = probe('coalition-foreign')
    expect(result.first.reaped).toBe(true)
    expect(result.second.reaped).toBe(true)
    expect(result.environmentReads).toBe(0)
    expect(result.signals).not.toContain(2000)
    expect(result.signals).not.toContain(-2000)
  })

  it.each(['unreadable', 'reused', 'changed', 'vanished'])(
    'preserves validated foreign-coalition evidence when a later process read is %s',
    (evidence) => {
      const result = probe(`coalition-${evidence}`)
      expect(result.first.reaped).toBe(true)
      expect(result.second.reaped).toBe(true)
      expect(result.environmentReads).toBe(0)
      expect(result.signals).toContain(-1000)
      expect(result.signals).not.toContain(2000)
      expect(result.signals).not.toContain(-2000)
    }
  )

  it.each(['same', 'missing', 'leader-missing', 'history'])(
    'retains strict cleanup when coalition evidence is %s',
    (evidence) => {
      const result = probe(`coalition-${evidence}`)
      expect(result.first.reaped).toBe(false)
      expect(result.second.reaped).toBe(false)
      expect(result.signals).not.toContain(2000)
      expect(result.signals).not.toContain(-2000)
    }
  )

  it('does not exclude an owned orphan that acquired launchd parent identity during exec', () => {
    const result = probe('reparented-exec')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(true)
    expect(result.environmentReads).toBeGreaterThan(0)
    expect(result.signals).toContain(-2000)
  })

  it('does not discharge an unreadable candidate when the same birth identity later has a different marker', () => {
    const result = probe('foreign')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(false)
    expect(result.signals).not.toContain(2000)
    expect(result.signals).not.toContain(-2000)
  })

  it('adopts and reaps a previously unreadable escaped descendant when its marker becomes available', () => {
    const result = probe('owned')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(true)
    expect(result.signals).toContain(-2000)
  })

  it('does not discharge missing historical evidence merely because a candidate vanished', () => {
    const result = probe('vanished')
    expect(result.second).toMatchObject({
      reaped: false,
      diagnostics: { failureCategory: 'ownership-candidate-unresolved' }
    })
  })

  it('retains an incomplete historical snapshot even after a complete retry', () => {
    expect(probe('history-gap').second).toMatchObject({
      reaped: false,
      diagnostics: { failureCategory: 'process-table-history-incomplete' }
    })
  })

  it('does not signal a replacement when identity changes during the environment read', () => {
    const result = probe('identity-race')
    expect(result.second.reaped).toBe(false)
    expect(result.signals).not.toContain(2000)
    expect(result.signals).not.toContain(-2000)
  })
})

describe('read-only Darwin main-agent admission proof', () => {
  it('accepts complete current evidence with an unrelated newer process', () => {
    const result = probe('cold-gone')
    expect(result.admission).toBe('gone')
    expect(result.environmentReads).toBeGreaterThan(0)
    expect(result.signals).toEqual([])
  })

  it('excludes an unreadable process born before the recorded leader', () => {
    const result = probe('cold-older-unreadable')
    expect(result.admission).toBe('gone')
    expect(result.environmentReads).toBe(0)
    expect(result.signals).toEqual([])
  })

  it('retains a positively identified survivor without letting a later snapshot replace that evidence', () => {
    const result = probe('cold-owned-before-race')
    expect(result.admission).toBe('blocked')
    expect(result.environmentReads).toBe(1)
    expect(result.signals).toEqual([])
  })

  it.each(['identity-race', 'exit-race'])(
    'retries a %s with a complete fresh snapshot instead of permanently rejecting a settled tree',
    (scenario) => {
      const result = probe(`cold-${scenario}`)
      expect(result.admission).toBe('gone')
      expect(result.environmentReads).toBeGreaterThan(0)
      expect(result.environmentReads).toBeLessThanOrEqual(3)
      expect(result.signals).toEqual([])
    }
  )

  it.each([
    'live',
    'group',
    'group-eperm',
    'marked',
    'incomplete',
    'null',
    'race-then-marked',
    'marked-then-exit',
    'sustained-race'
  ])('blocks %s evidence without signaling any process', (scenario) => {
    const result = probe(`cold-${scenario}`)
    expect(result.admission).toBe('blocked')
    expect(result.signals).toEqual([])
    if (scenario === 'sustained-race') expect(result.environmentReads).toBe(3)
  })
})
