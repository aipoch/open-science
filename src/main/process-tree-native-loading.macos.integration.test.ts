import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const describeMacOS = process.platform === 'darwin' ? describe : describe.skip

describeMacOS('macOS native process ownership dependency (real processes)', () => {
  it('uses legacy single-PID signals only when the audit-token symbol is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-science-native-signal-'))
    try {
      // Compile the unchanged production sources into isolated test addons. The
      // linker-local dlsym definitions simulate platform capabilities without a
      // production environment switch or a callable fault-injection API.
      for (const source of ['process_tree_native.cc', 'windows_owned_process.cc']) {
        copyFileSync(
          join(__dirname, '../../packages/process-tree-native/src', source),
          join(directory, source)
        )
      }
      writeFileSync(
        join(directory, 'missing.cc'),
        '#include <dlfcn.h>\nextern "C" void* dlsym(void*, const char*) { return nullptr; }\n'
      )
      writeFileSync(
        join(directory, 'denied.cc'),
        '#include <dlfcn.h>\n#include <mach/message.h>\n#include <cerrno>\n' +
          'static int denied(audit_token_t*, int) { return EPERM; }\n' +
          'extern "C" void* dlsym(void*, const char*) { return reinterpret_cast<void*>(&denied); }\n'
      )
      writeFileSync(
        join(directory, 'binding.gyp'),
        JSON.stringify({
          targets: ['missing', 'denied'].map((name) => ({
            target_name: name,
            sources: ['process_tree_native.cc', 'windows_owned_process.cc', `${name}.cc`],
            defines: ['NAPI_VERSION=8'],
            xcode_settings: { CLANG_CXX_LANGUAGE_STANDARD: 'c++17' }
          }))
        })
      )
      execFileSync(
        process.execPath,
        [
          join(__dirname, '../../node_modules/node-gyp/bin/node-gyp.js'),
          'rebuild',
          '--directory',
          directory
        ],
        { timeout: 60000, stdio: 'pipe' }
      )
      const script = `
        const assert = require('node:assert/strict')
        const { spawn } = require('node:child_process')
        const actual = require('@aipoch/process-tree-native')
        const legacy = require(${JSON.stringify(join(directory, 'build/Release/missing.node'))})
        const denied = require(${JSON.stringify(join(directory, 'build/Release/denied.node'))})
        ;(async () => {
          const me = actual.getDarwinProcessCoalition(process.pid)
          assert.equal(me.status, 'ok')
          assert.deepEqual(legacy.signalDarwinProcess(process.pid, me.process.uniqueId, 19), { status: 'ok', signalMode: 'legacy' })
          for (const signal of [15, 9]) {
            const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
            const exited = new Promise(resolve => child.once('exit', (code, name) => resolve({ code, name })))
            const identity = actual.getDarwinProcessCoalition(child.pid)
            assert.equal(identity.status, 'ok')
            try {
              assert.deepEqual(legacy.signalDarwinProcess(child.pid, '1', signal), { status: 'mismatch', signalMode: 'legacy' })
              const refused = denied.signalDarwinProcess(child.pid, identity.process.uniqueId, signal)
              assert.equal(refused.status, 'unavailable')
              assert.equal(refused.signalMode, 'atomic')
              assert.equal(refused.error, require('node:os').constants.errno.EPERM)
              assert.equal(actual.getDarwinProcess(child.pid).uniqueId, identity.process.uniqueId)
              assert.deepEqual(legacy.signalDarwinProcess(child.pid, identity.process.uniqueId, signal), { status: 'ok', signalMode: 'legacy' })
              assert.deepEqual(await exited, { code: null, name: signal === 15 ? 'SIGTERM' : 'SIGKILL' })
            } finally {
              actual.signalDarwinProcess(child.pid, identity.process.uniqueId, 9)
              await exited
            }
          }
          process.stdout.write('verified')
        })().catch(error => { console.error(error); process.exitCode = 1 })
      `
      expect(
        execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 })
      ).toBe('verified')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 90000)

  it('retains coalition evidence across orphaning, setsid and an empty exec environment', () => {
    const script = `
      const assert = require('node:assert/strict')
      const { spawn } = require('node:child_process')
      const native = require('@aipoch/process-tree-native')
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
      const me = native.getDarwinProcessCoalition(process.pid)
      assert.equal(me.status, 'ok')
      const intermediate = spawn(process.execPath, ['-e', ${JSON.stringify(
        "const child = require('node:child_process').spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore', env: {} }); console.log(child.pid); child.unref()"
      )}], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
      let output = ''
      intermediate.stdout.on('data', chunk => { output += chunk })
      ;(async () => {
        await new Promise((resolve, reject) => { intermediate.once('close', resolve); intermediate.once('error', reject) })
        const pid = Number(output.trim())
        const orphan = native.getDarwinProcessCoalition(pid)
        assert.equal(orphan.status, 'ok')
        try {
          assert.equal(orphan.coalitionId, me.coalitionId)
          assert.equal(orphan.process.ppid, 1)
          assert.equal(orphan.process.sid, pid)
          assert.equal(native.getDarwinEnvironmentValue(pid, 'PATH'), false)
          assert.equal(native.signalDarwinProcess(pid, '1', 9).status, 'mismatch')
          assert.equal(native.getDarwinProcessCoalition(pid).process.uniqueId, orphan.process.uniqueId)
          assert.equal(native.signalDarwinProcess(pid, orphan.process.uniqueId, 15).status, 'ok')
          for (let i = 0; i < 200 && native.getDarwinProcessCoalition(pid).status !== 'missing'; i++) await pause(10)
          assert.equal(native.getDarwinProcessCoalition(pid).status, 'missing')
          assert.equal(native.signalDarwinProcess(pid, orphan.process.uniqueId, 9).status, 'missing')
          process.stdout.write('verified')
        } finally {
          native.signalDarwinProcess(pid, orphan.process.uniqueId, 9)
        }
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    expect(
      execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 })
    ).toBe('verified')
  })

  it('refuses invalid identity signals and supports exact-identity forced termination', () => {
    const script = `
      const assert = require('node:assert/strict')
      const { spawn } = require('node:child_process')
      const native = require('@aipoch/process-tree-native')
      assert.equal(native.getDarwinProcessCoalition(-1).status, 'unavailable')
      assert.equal(native.signalDarwinProcess(process.pid, '18446744073709551616', 9).status, 'unavailable')
      const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
      const identity = native.getDarwinProcessCoalition(child.pid)
      assert.equal(identity.status, 'ok')
      try {
        assert.equal(native.signalDarwinProcess(child.pid, identity.process.uniqueId, 0).status, 'unavailable')
        assert.equal(native.signalDarwinProcess(child.pid, identity.process.uniqueId, 9).status, 'ok')
      } catch (error) {
        native.signalDarwinProcess(child.pid, identity.process.uniqueId, 9)
        throw error
      }
      child.once('exit', (code, signal) => {
        assert.equal(code, null)
        assert.equal(signal, 'SIGKILL')
        process.stdout.write('verified')
      })
    `
    expect(
      execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 })
    ).toBe('verified')
  })

  it('rejects unavailable ownership before spawn and recovers on the next request', () => {
    // Isolate the CommonJS loader fault from Vitest and the running application's dependencies.
    // Only dependency availability is injected; Bash, identity capture and teardown are real.
    const script = `
      const Module = require('node:module')
      const { readFileSync } = require('node:fs')
      const { spawn } = require('node:child_process')
      const ts = require('typescript')
      const filename = ${JSON.stringify(join(__dirname, 'process-tree.ts'))}
      const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText
      const load = () => {
        const instance = new Module(filename, module)
        instance.filename = filename
        instance.paths = Module._nodeModulePaths(require('node:path').dirname(filename))
        instance._compile(code, filename)
        return instance.exports
      }
      const originalLoad = Module._load
      let unavailable = true
      let snapshotUnavailable = false
      let loadAttempts = 0
      let spawnCount = 0
      Module._load = function(id, ...args) {
        if (id === '@aipoch/process-tree-native') {
          loadAttempts++
          if (unavailable) throw Object.assign(new Error('Cannot find module ' + id), { code: 'MODULE_NOT_FOUND' })
          const actual = originalLoad.call(this, id, ...args)
          return {
            getDarwinProcess: actual.getDarwinProcess,
            getDarwinProcessCoalition: actual.getDarwinProcessCoalition,
            getDarwinEnvironmentValue: actual.getDarwinEnvironmentValue,
            signalDarwinProcess: actual.signalDarwinProcess,
            listDarwinProcesses: () => snapshotUnavailable ? null : actual.listDarwinProcesses()
          }
        }
        return originalLoad.call(this, id, ...args)
      }
      const probe = async (tree) => {
        let ownership
        try { ownership = tree.createPosixProcessTreeOwnership(process.env) }
        catch (error) { return { code: error.code, cause: error.cause.code, spawnCount } }
        spawnCount++
        const child = spawn('/bin/bash', ['-c', 'sleep 0.1; printf ready'], {
          detached: true, env: ownership.env, stdio: 'ignore'
        })
        tree.trackOwnedPosixProcessTree(child, ownership.token)
        await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
        return { exitCode: child.exitCode, ...await tree.terminateProcessTree(child) }
      }
      ;(async () => {
        const tree = load()
        const missing = await probe(tree)
        unavailable = false
        snapshotUnavailable = true
        const unusable = await probe(tree)
        snapshotUnavailable = false
        const installedInSameProcess = await probe(tree)
        const afterReload = await probe(load())
        process.stdout.write(JSON.stringify({ missing, unusable, installedInSameProcess, afterReload, loadAttempts }))
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }))
    expect(result).toEqual({
      missing: { code: 'PROCESS_TREE_UNAVAILABLE', cause: 'MODULE_NOT_FOUND', spawnCount: 0 },
      unusable: { code: 'PROCESS_TREE_UNAVAILABLE', spawnCount: 0 },
      installedInSameProcess: { exitCode: 0, reaped: true },
      afterReload: { exitCode: 0, reaped: true },
      loadAttempts: 3
    })
  })
})
