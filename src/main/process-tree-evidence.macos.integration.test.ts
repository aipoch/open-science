import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProcessTreeKillResult } from './process-tree'

const describeMacOS = process.platform === 'darwin' ? describe : describe.skip

// Each isolated process uses the real native module, real forks/setsid and real signals. Faults
// affect only one environment query (or one snapshot), never the ownership/termination outcome.
type ProbeResult = {
  first: ProcessTreeKillResult
  second: ProcessTreeKillResult
  aliveAfterFirst: boolean
  aliveAfterSecond: boolean
  environmentReads: number
  execPreservedBirthIdentity?: boolean
  markerAbsentAfterExec?: boolean
}

const probe = (
  scenario: 'older-parent' | 'foreign' | 'owned' | 'owned-clear' | 'snapshot-gap'
): ProbeResult => {
  const filename = join(__dirname, 'process-tree.ts')
  const script = `
    const Module = require('node:module')
    const { spawn } = require('node:child_process')
    const { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs')
    const ts = require('typescript')
    const native = require('@aipoch/process-tree-native')
    const filename = ${JSON.stringify(filename)}
    const scenario = process.argv[1]
    const fixture = mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'owned-exec-proof-'))
    const gate = require('node:path').join(fixture, 'exec')
    const execReady = require('node:path').join(fixture, 'exec-ready')
    let ambiguousPid
    let readable = false
    let snapshotFault = false
    let environmentReads = 0
    const instance = new Module(filename, module)
    instance.filename = filename
    instance.paths = Module._nodeModulePaths(require('node:path').dirname(filename))
    const originalRequire = instance.require.bind(instance)
    instance.require = id => id === '@aipoch/process-tree-native' ? {
      ...native,
      getDarwinEnvironmentValue(pid, name) {
        if (pid === ambiguousPid) {
          environmentReads++
          if (!readable) return null
        }
        return native.getDarwinEnvironmentValue(pid, name)
      },
      listDarwinProcesses() {
        const table = native.listDarwinProcesses()
        return snapshotFault && table ? { ...table, complete: false } : table
      }
    } : originalRequire(id)
    instance._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, filename)
    const tree = instance.exports
    const children = []
    const identities = new Map()
    const remember = pid => {
      const identity = native.getDarwinProcess(pid)
      if (identity) identities.set(pid, identity.uniqueId)
      return identity
    }
    const start = (code, env = process.env) => {
      const child = spawn(process.execPath, ['-e', code], {
        detached: true, env, stdio: ['pipe', 'pipe', 'pipe']
      })
      children.push(child)
      remember(child.pid)
      return child
    }
    const exit = child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() :
      new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
    const readPid = child => new Promise((resolve, reject) => {
      let output = ''
      child.stdout.on('data', chunk => {
        output += chunk.toString()
        const match = output.match(/^(\\d+)\\s*$/)
        if (match) resolve(Number(match[1]))
      })
      child.once('error', reject)
    })
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const waitGone = async pid => {
      for (let i = 0; i < 150 && native.getDarwinProcess(pid); i++) await pause(20)
      if (native.getDarwinProcess(pid)) throw new Error('Probe process did not exit')
    }
    const helper = 'setInterval(() => {}, 1000)'
    const execHelper = 'require("node:fs").writeFileSync(' + JSON.stringify(execReady) + ', "");' + helper
    const clearMarker = 'while [ ! -f ' + JSON.stringify(gate) + ' ]; do /bin/sleep 0.02; done; exec /usr/bin/env -u OPEN_SCIENCE_PROCESS_TREE_ID ' + JSON.stringify(process.execPath) + " -e '" + execHelper + "'"
    const forkHelper = [
      "const {spawn}=require('node:child_process')",
      scenario === 'owned-clear'
        ? "const child=spawn('/bin/sh',['-c'," + JSON.stringify(clearMarker) + "],{detached:true,stdio:'ignore'})"
        : "const child=spawn(process.execPath,['-e'," + JSON.stringify(helper) + "],{detached:true,stdio:'ignore'})",
      'child.unref()',
      'console.log(child.pid)'
    ].join(';')
    ;(async () => {
      let tracked
      const keepAlive = setInterval(() => {}, 1000)
      try {
        const oldParent = scenario === 'older-parent' ? start("process.stdin.once('data',()=>{" + forkHelper + ";process.exit(0)})") : undefined
        const ownership = tree.createPosixProcessTreeOwnership(process.env)
        const ownerCode = scenario === 'owned' || scenario === 'owned-clear' ? [
          "const {spawn}=require('node:child_process')",
          'setTimeout(()=>{',
          "const middle=spawn(process.execPath,['-e'," + JSON.stringify(forkHelper) + "],{stdio:['ignore','pipe','inherit']})",
          'middle.stdout.pipe(process.stdout)',
          "middle.on('exit',()=>process.exit(0))",
          '},20)'
        ].join(';') : helper
        tracked = start(ownerCode, ownership.env)
        tree.trackOwnedPosixProcessTree(tracked, ownership.token)
        let parent = oldParent
        if (scenario === 'snapshot-gap') {
          snapshotFault = true
          await pause(50)
          snapshotFault = false
        } else if (scenario === 'owned' || scenario === 'owned-clear') {
          // No JS sampler runs while the intermediate parent forks and exits. The real inherited
          // marker must identify the surviving setsid grandchild, without a sampled parent chain.
          const until = Date.now() + 750
          while (Date.now() < until) void process.hrtime.bigint()
          ambiguousPid = await readPid(tracked)
          remember(ambiguousPid)
          await exit(tracked)
        } else {
          if (parent) parent.stdin.end('launch')
          else parent = start(forkHelper)
          ambiguousPid = await readPid(parent)
          remember(ambiguousPid)
          await exit(parent)
        }
        const first = await tree.terminateProcessTree(tracked)
        const aliveAfterFirst = Boolean(ambiguousPid && native.getDarwinProcess(ambiguousPid))
        let execPreservedBirthIdentity
        let markerAbsentAfterExec
        if (scenario === 'owned-clear') {
          writeFileSync(gate, '')
          // KERN_PROCARGS2 includes argv: env's assignment argument can look ready before exec.
          // Only the final Node helper can acknowledge that it has started with the new image.
          for (let i = 0; i < 150 && !existsSync(execReady); i++) await pause(20)
          if (!existsSync(execReady)) throw new Error('Helper did not exec')
          execPreservedBirthIdentity = native.getDarwinProcess(ambiguousPid)?.uniqueId === identities.get(ambiguousPid)
          markerAbsentAfterExec = native.getDarwinEnvironmentValue(ambiguousPid, 'OPEN_SCIENCE_PROCESS_TREE_ID') === false
        }
        readable = true
        const second = await tree.terminateProcessTree(tracked)
        if (scenario === 'owned' && second.reaped) await waitGone(ambiguousPid)
        const aliveAfterSecond = Boolean(ambiguousPid && native.getDarwinProcess(ambiguousPid))
        process.stdout.write(JSON.stringify({
          first, second, aliveAfterFirst, aliveAfterSecond, environmentReads,
          execPreservedBirthIdentity, markerAbsentAfterExec
        }))
      } finally {
        for (const [pid, uniqueId] of identities) {
          if (native.getDarwinProcess(pid)?.uniqueId === uniqueId) {
            try { process.kill(pid, 'SIGKILL') } catch {}
          }
        }
        await Promise.all(children.map(exit))
        if (ambiguousPid) await waitGone(ambiguousPid)
        rmSync(fixture, { recursive: true, force: true })
        clearInterval(keepAlive)
      }
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script, scenario], {
      encoding: 'utf8',
      timeout: 15_000
    })
  )
}

describeMacOS('Darwin ownership evidence with real processes', () => {
  it('does not infer nonownership from an older parent when the unrelated orphan environment is unreadable', () => {
    const result = probe('older-parent')
    expect(result.first.reaped).toBe(false)
    expect(result.second.reaped).toBe(false)
    expect(result.environmentReads).toBeGreaterThan(0)
    expect(result.aliveAfterSecond).toBe(true)
  }, 20_000)

  it('does not mistake a later negative environment read for historical nonownership', () => {
    const result = probe('foreign')
    expect(result.first).toMatchObject({
      reaped: false,
      diagnostics: { failureCategory: 'ownership-candidate-unresolved', recovery: 'retry-owner' }
    })
    expect(result.second.reaped).toBe(false)
    expect(result.aliveAfterSecond).toBe(true)
  }, 20_000)

  it('retains an unreadable escaped grandchild and reaps it when its original marker becomes readable', () => {
    const result = probe('owned')
    expect(result.first.reaped).toBe(false)
    expect(result.aliveAfterFirst).toBe(true)
    expect(result.second).toEqual({ reaped: true })
    expect(result.aliveAfterSecond).toBe(false)
  }, 20_000)

  it('retains ownership uncertainty when an unreadable escaped process execs without its marker', () => {
    const result = probe('owned-clear')
    expect(result.first.reaped).toBe(false)
    expect(result.execPreservedBirthIdentity).toBe(true)
    expect(result.markerAbsentAfterExec).toBe(true)
    expect(result.second).toMatchObject({
      reaped: false,
      diagnostics: { failureCategory: 'ownership-candidate-unresolved' }
    })
    expect(result.aliveAfterSecond).toBe(true)
  }, 20_000)

  it('keeps a historical snapshot gap fail-closed with an actionable evidence category', () => {
    const result = probe('snapshot-gap')
    expect(result.second).toMatchObject({
      reaped: false,
      diagnostics: {
        failureCategory: 'process-table-history-incomplete',
        recovery: 'stronger-ownership-proof-required'
      }
    })
  }, 20_000)
})
