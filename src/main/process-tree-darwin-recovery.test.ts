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
    const candidate = { pid: 2000, ppid: 1, pgid: 2000, sid: 2000, uniqueId: '200', parentUniqueId: scenario === 'reparented-exec' ? '1' : '150' }
    const processes = new Map([[1000, leader], [2000, candidate]])
    if (scenario.startsWith('owned-query') || ['owned-inaccessible', 'owned-pending-reap'].includes(scenario)) processes.delete(2000)
    let hideOwned = false
    let environmentReads = 0
    let readable = scenario.startsWith('coalition-marked')
    let incomplete = scenario === 'history-gap'
    let race = false
    let identityReadFailure = scenario === 'initial-identity-throws'
    const binding = {
      signalDarwinProcess: (pid, uniqueId, signal) => {
        if (hideOwned && pid === 1000) return { status: 'unavailable', error: 1 }
        const current = processes.get(pid)
        if (!current) return { status: 'missing' }
        if (current.uniqueId !== uniqueId) return { status: 'mismatch' }
        signals.push(pid)
        processes.delete(pid)
        return { status: 'ok' }
      },
      getDarwinProcess: pid => {
        if (identityReadFailure) {
          identityReadFailure = false
          throw new Error('Initial native identity query failed')
        }
        return hideOwned && pid === 1000 ? null : processes.get(pid) ?? null
      },
      getDarwinProcessCoalition: pid => {
        if (scenario === 'coalition-unavailable' ||
          (scenario === 'coalition-retry' && pid === 2000 && !readable)) return { status: 'unavailable', error: 1 }
        const identity = processes.get(pid)
        if (pid === 1000 && scenario === 'coalition-leader-race') return { status: 'ok', coalitionId: '10', process: { ...identity, uniqueId: '101' } }
        if (!identity) return { status: 'missing' }
        return {
          status: 'ok', coalitionId: pid === 2000 && scenario.startsWith('coalition-') ? '20' : '10',
          process: (scenario === 'coalition-identity-race' || (scenario === 'coalition-marked-race' && race)) && pid === 2000
            ? { ...identity, uniqueId: scenario === 'coalition-marked-race' ? '202' : '201' } : identity
        }
      },
      listDarwinProcesses: () => ({ processes: [...processes.values()].filter(p => !(hideOwned && p.pid === 1000)), complete: !incomplete }),
      getDarwinEnvironmentValue: pid => {
        environmentReads++
        if (!readable) return null
        if (['identity-race', 'coalition-marked-race'].includes(scenario) && !race) {
          race = true
          processes.set(pid, { ...candidate, uniqueId: '201' })
          return 'owner-token'
        }
        if (['identity-race', 'coalition-marked-race'].includes(scenario) && race && processes.get(pid)?.uniqueId === '201') return 'other-owner'
        return ['owned', 'identity-race', 'reparented-exec', 'coalition-marked', 'coalition-marked-race'].includes(scenario) ? 'owner-token' : 'other-owner'
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
      if (hideOwned && pid === 1000 && scenario !== 'owned-pending-reap') throw Object.assign(new Error('unavailable'), { code: scenario === 'owned-query-error' ? 'EIO' : 'EPERM' })
      const targets = [...processes.values()].filter(p => pid < 0 ? p.pgid === -pid : p.pid === pid)
      if (!targets.length) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (signal !== 0) {
        signals.push(pid)
        for (const target of targets) processes.delete(target.pid)
      }
      return true
    }
    const child = Object.assign(new EventEmitter(), { pid: 1000, exitCode: 0, signalCode: null, kill() { signals.push(1000); return true } })
    // A mocked ChildProcess has no real handle to keep the production unref polling alive.
    const keepAlive = setInterval(() => {}, 1000)
    ;(async () => {
      tree.trackOwnedPosixProcessTree(child, 'owner-token')
      await new Promise(resolve => setImmediate(resolve))
      hideOwned = scenario.startsWith('owned-query') || ['owned-inaccessible', 'owned-pending-reap'].includes(scenario)
      if (scenario === 'owned-pending-reap') setImmediate(() => processes.delete(1000))
      const first = await tree.terminateProcessTree(child)
      readable = true
      incomplete = false
      if (scenario === 'vanished') processes.delete(2000)
      const second = await tree.terminateProcessTree(child)
      process.stdout.write(JSON.stringify({ first, second, environmentReads, signals }))
    })().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearInterval(keepAlive))
  `
  return JSON.parse(execFileSync(process.execPath, ['-e', script, scenario], { encoding: 'utf8' }))
}

describe('Darwin ownership evidence reconciliation', () => {
  it('retains an unavailable tracker when the initial native identity query throws', () => {
    const result = probe('initial-identity-throws')
    for (const outcome of [result.first, result.second]) {
      expect(outcome).toMatchObject({
        reaped: false,
        diagnostics: { failureCategory: 'leader-identity-unavailable' }
      })
    }
    expect(result.signals).toEqual([])
    expect(result.environmentReads).toBe(0)
  })

  it('waits for ESRCH when a pinned child leaves the snapshot before the event loop reaps it', () => {
    const result = probe('owned-pending-reap')
    expect(result.first).toEqual({ reaped: true })
    expect(result.second).toEqual({ reaped: true })
    expect(result.signals).toEqual([])
  })

  it.each(['owned-inaccessible', 'owned-query-error'])(
    'retains a known owned process omitted from a complete snapshot: %s',
    (scenario) => {
      const result = probe(scenario)
      expect(result.first).toMatchObject({
        reaped: false,
        diagnostics: { failureCategory: 'owned-processes-still-running' }
      })
      expect(result.second.reaped).toBe(false)
      expect(result.signals).toEqual([])
    }
  )

  it('excludes an unreadable orphan with an independently confirmed foreign coalition', () => {
    const result = probe('coalition-foreign')
    expect(result.first.reaped).toBe(true)
    expect(result.environmentReads).toBeGreaterThan(0)
    expect(result.signals).not.toContain(2000)
    expect(result.signals).not.toContain(-2000)
  })

  it('discharges exact candidate uncertainty once a foreign coalition can be confirmed', () => {
    const result = probe('coalition-retry')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(true)
    expect(result.signals).not.toContain(-2000)
  })

  it('retains positive marker ownership across a broker-created coalition', () => {
    const result = probe('coalition-marked')
    expect(result.first.reaped).toBe(true)
    expect(result.signals).toContain(2000)
  })

  it('retains matching marker uncertainty when coalition and marker observations race identity reuse', () => {
    const result = probe('coalition-marked-race')
    expect(result.first.reaped).toBe(false)
    expect(result.signals).not.toContain(2000)
  })

  it('does not capture coalition evidence from a replacement leader generation', () => {
    const result = probe('coalition-leader-race')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(false)
    expect(result.signals).not.toContain(2000)
  })

  it('does not weaken ownership evidence when coalition queries are unavailable', () => {
    const result = probe('coalition-unavailable')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(false)
  })

  it('does not exclude an older candidate using a replacement process coalition', () => {
    const result = probe('coalition-identity-race')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(false)
    expect(result.signals).not.toContain(-2000)
  })

  it('does not exclude an owned orphan that acquired launchd parent identity during exec', () => {
    const result = probe('reparented-exec')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(true)
    expect(result.environmentReads).toBeGreaterThan(0)
    expect(result.signals).toContain(2000)
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
    expect(result.signals).toContain(2000)
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
