import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSync } from 'esbuild'

import { DelegatedProcessOwnership } from './delegation/process-ownership'
import { terminateProcessTree } from './process-tree'

const windows = process.platform === 'win32' ? describe : describe.skip
let root: string | undefined
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => terminateProcessTree(child)))
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})
const scope = {
  projectId: 'project',
  sessionId: 'session',
  frameId: 'frame',
  attemptId: 'attempt',
  frameworkId: 'codex'
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

windows('delegated Windows Job ownership (real processes)', () => {
  it('preserves piped ACP IO and argument boundaries for concurrent providers', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-windows-job-'))
    const owner = new DelegatedProcessOwnership(root)
    const values = ['space value', '"quoted"', '', 'trailing\\']
    for (let index = 0; index < 3; index++) {
      const child = owner.spawn(
        { ...scope, attemptId: `attempt-${index}` },
        process.execPath,
        [
          '-e',
          'process.stdin.once("data",data=>{process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:data.toString()}));});setInterval(()=>{},1000)',
          ...values
        ],
        { stdio: 'pipe', env: process.env, windowsHide: true }
      )
      children.push(child)
    }
    await Promise.all(
      children.map(async (child) => {
        const output = once(child.stdout, 'data')
        child.stdin.write('acp-request\n')
        expect(JSON.parse((await output)[0].toString())).toEqual({
          args: values,
          input: 'acp-request\n'
        })
        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
      })
    )
    expect(owner.receipts()).toEqual([])
  })

  it('recovers an exact Job after its root exits and preserves an unrelated process', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-windows-recovery-'))
    const owner = new DelegatedProcessOwnership(root)
    const unrelated = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      { stdio: 'pipe' }
    )
    children.push(unrelated)
    await once(unrelated.stdout, 'data')
    const pidFile = join(root, 'descendant.pid')
    const child = owner.spawn(
      scope,
      process.execPath,
      [
        '-e',
        `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`
      ],
      { stdio: 'pipe', env: process.env, windowsHide: true }
    )
    children.push(child)
    await once(child, 'exit')
    const descendant = Number(await readFile(pidFile, 'utf8'))
    expect(alive(descendant)).toBe(true)
    const reopened = new DelegatedProcessOwnership(root)
    await reopened.recover(scope)
    expect(alive(descendant)).toBe(false)
    expect(alive(unrelated.pid!)).toBe(true)
    expect(reopened.receipts()).toEqual([])
    await expect(reopened.recover(scope)).resolves.toBeUndefined()
  })

  it('reaps the owned tree when its application owner crashes and recovers the persisted receipt', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-windows-owner-crash-'))
    const provider = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); process.stdout.write(JSON.stringify({ root: process.pid, descendant: child.pid })); setInterval(()=>{},1000)`
    const script = buildSync({
      stdin: {
        contents: `import { DelegatedProcessOwnership } from './src/main/delegation/process-ownership'; const owner = new DelegatedProcessOwnership(${JSON.stringify(root)}); const child = owner.spawn(${JSON.stringify(scope)}, process.execPath, ['-e', ${JSON.stringify(provider)}], { stdio: 'pipe', env: process.env, windowsHide: true }); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); setInterval(()=>{},1000);`,
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      write: false
    }).outputFiles[0].text
    const entry = join(root, 'application.cjs')
    await writeFile(entry, script)
    const application = spawn(process.execPath, [entry], {
      stdio: 'pipe',
      env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }
    })
    children.push(application)
    const [output] = await once(application.stdout, 'data')
    const pids = JSON.parse(output.toString()) as { root: number; descendant: number }
    expect(alive(pids.root)).toBe(true)
    expect(alive(pids.descendant)).toBe(true)
    const exited = once(application, 'exit')
    application.kill() // Deliberately kill only the app owner; Job kill-on-close owns its descendants.
    await exited
    await expect.poll(() => alive(pids.root) || alive(pids.descendant)).toBe(false)
    const reopened = new DelegatedProcessOwnership(root)
    expect(reopened.receipts()).toHaveLength(1)
    await reopened.recover()
    expect(reopened.receipts()).toEqual([])
  })

  it('preserves the existing cmd launch contract', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-windows-cmd-'))
    const command = join(root, 'provider with spaces.cmd')
    await writeFile(command, '@echo off\r\necho ready\r\n')
    const owner = new DelegatedProcessOwnership(root)
    const child = owner.spawn(scope, `"${command}"`, [], {
      stdio: 'pipe',
      env: process.env,
      shell: true,
      windowsHide: true
    })
    children.push(child)
    const output = once(child.stdout, 'data')
    expect((await output)[0].toString().trim()).toBe('ready')
    await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
  })
})
