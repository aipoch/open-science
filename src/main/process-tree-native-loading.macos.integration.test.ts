import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const describeMacOS = process.platform === 'darwin' ? describe : describe.skip

describeMacOS('macOS native process ownership dependency (real processes)', () => {
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
            getDarwinEnvironmentValue: actual.getDarwinEnvironmentValue,
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
