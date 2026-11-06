/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone Node test fixture callbacks use inferred JavaScript values. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { decodeTaskPrompt, executeTask, TASK_MARKER, taskCode } from './mac-update-task-agent.mjs'
import {
  assertIsolatedPaths,
  assertTaskStop,
  assertTaskWitness,
  rendererSaveFailureObserved,
  createProcessScenario
} from './mac-update-process-scenarios.mjs'

test('task prompts retain the last explicit request and reject absent or malformed requests', () => {
  const request = {
    kind: 'python',
    active: false,
    witness: '/fixture/task.json',
    nonce: randomUUID()
  }
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64')
  assert.deepEqual(decodeTaskPrompt(`previous prompt\n${TASK_MARKER}${encoded}`), request)
  assert.throws(() => decodeTaskPrompt('ordinary prompt'), /No acceptance task/)
  assert.throws(
    () =>
      decodeTaskPrompt(
        TASK_MARKER + Buffer.from(JSON.stringify({ ...request, kind: 'node' })).toString('base64')
      ),
    /Invalid acceptance/
  )
})

test(
  'generated task programs write nonce/PID evidence using real Python, JS and Bash runtimes',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mac-task-code-数据 '"))
    try {
      for (const kind of ['python', 'repl', 'bash']) {
        const request = {
          kind,
          active: false,
          witness: join(root, `${kind}.json`),
          nonce: randomUUID()
        }
        const code = taskCode(request)
        if (kind === 'python') execFileSync('/usr/bin/python3', ['-c', code], { timeout: 10000 })
        else if (kind === 'bash')
          execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', code], { timeout: 10000 })
        else
          await new (Object.getPrototypeOf(async () => {}).constructor)('require', 'process', code)(
            createRequire(import.meta.url),
            process
          )
        const witness = assertTaskWitness(
          JSON.parse(await readFile(request.witness, 'utf8')),
          request
        )
        if (kind === 'bash') assert.throws(() => process.kill(witness.pid, 0), { code: 'ESRCH' })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('witness and process oracles reject another task and a surviving birth identity', () => {
  const expected = { kind: 'repl', nonce: randomUUID(), pid: 100, uniqueId: '1000' }
  assert.throws(
    () => assertTaskWitness({ ...expected, nonce: randomUUID() }, expected),
    /another task/
  )
  assert.throws(() => assertTaskWitness({ ...expected, pid: -1 }, expected), /malformed/)
  assert.throws(() => assertTaskStop(expected, { pid: 100, uniqueId: '1000' }), /survived/)
  assert.doesNotThrow(() => assertTaskStop(expected, { pid: 100, uniqueId: '2000' }))
})

test('save-failure oracle requires the renderer phase failure rather than an unrelated shutdown failure', () => {
  const event = (diagnostics) => [
    { step: 'product-shutdown-diagnostics', diagnostics: JSON.stringify(diagnostics) }
  ]
  assert.equal(
    rendererSaveFailureObserved(
      event([
        { step: 'renderer-preflight', outcome: 'completed' },
        { step: 'backend-shutdown', outcome: 'failed' }
      ])
    ),
    false
  )
  assert.equal(
    rendererSaveFailureObserved(event([{ step: 'renderer-final', outcome: 'failed' }])),
    true
  )
  assert.equal(
    rendererSaveFailureObserved([
      { step: 'product-shutdown-diagnostics', diagnostics: 'not-json' }
    ]),
    false
  )
})

test('actual MCP admission must return a real run identity and idle completion', async () => {
  const request = {
    kind: 'repl',
    active: false,
    witness: '/fixture/witness.json',
    nonce: randomUUID()
  }
  const calls = []
  const client = {
    callTool: async (call) => {
      calls.push(call)
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'completed', runId: 'run' }) }]
      }
    }
  }
  assert.deepEqual(await executeTask(client, request), {
    kind: 'repl',
    active: false,
    runId: 'run',
    status: 'completed',
    nonce: request.nonce
  })
  assert.equal(calls[0].name, 'repl_execute')
  assert.equal(calls[0].arguments.background, false)
  await assert.rejects(
    executeTask(
      { callTool: async () => ({ content: [{ type: 'text', text: '{"status":"completed"}' }] }) },
      request
    ),
    /expected admission/
  )
  await assert.rejects(
    executeTask(
      { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'refused' }] }) },
      request
    ),
    /failed: refused/
  )
})

test('Python task creation refuses unavailable or disabled runtimes rather than substituting Node', async () => {
  const calls = []
  await assert.rejects(
    executeTask(
      {
        callTool: async (call) => {
          calls.push(call.name)
          return { content: [{ type: 'text', text: '{"runtimes":[]}' }] }
        }
      },
      { kind: 'python', active: true, witness: '/fixture/witness.json', nonce: randomUUID() }
    ),
    /No enabled runnable Python/
  )
  assert.deepEqual(calls, ['list_notebook_runtimes'])
})

test(
  'ACP task fixture starts the real protocol and refuses a task without an app-granted MCP capability',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mac-update-agent-protocol-'))
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./mac-update-task-agent.mjs', import.meta.url))],
      {
        env: { ...process.env, OPEN_SCIENCE_MAC_ACCEPTANCE_ROOT: root },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    const lines = createInterface({ input: child.stdout })
    const waiters = new Map()
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      waiters.get(message.id)?.(message)
    })
    const request = (id, method, params) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ACP fixture response deadline')), 5000)
        waiters.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    try {
      const initialized = await request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'native-acceptance-test', version: '1' }
      })
      assert.ok(initialized.result?.protocolVersion)
      const created = await request(2, 'session/new', { cwd: root, mcpServers: [] })
      assert.ok(created.result?.sessionId)
      const nonce = randomUUID()
      const params = {
        kind: 'repl',
        active: false,
        witness: join(root, 'task.json'),
        agentWitness: join(root, 'provider.json'),
        nonce
      }
      const refused = await request(3, 'session/prompt', {
        sessionId: created.result.sessionId,
        prompt: [
          {
            type: 'text',
            text: TASK_MARKER + Buffer.from(JSON.stringify(params)).toString('base64')
          }
        ]
      })
      assert.ok(refused.error)
      assertTaskWitness(JSON.parse(await readFile(params.agentWitness, 'utf8')), {
        kind: 'provider',
        nonce
      })
    } finally {
      lines.close()
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('scenario preparation rejects nonisolated storage and writes provider only outside signed bundle', async () => {
  assert.throws(
    () =>
      assertIsolatedPaths({
        root: '/fixture',
        configRoot: '/daily/data',
        profile: '/fixture/profile'
      }),
    /disposable/
  )
  const root = await mkdtemp(join(tmpdir(), 'mac-process-scenario-'))
  try {
    const ctx = { root, configRoot: join(root, 'data'), profile: join(root, 'profile'), report: {} }
    const scenario = createProcessScenario('M03', ctx)
    await scenario.prepareLaunch()
    const settings = JSON.parse(await readFile(join(ctx.configRoot, 'settings.json'), 'utf8'))
    const launcher = await readFile(settings.opencodePath, 'utf8')
    assert.match(launcher, /mac-update-task-agent\.mjs/)
    assert.match(settings.opencodePath, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(ctx.report.processScenario.status, 'not-run')
    assert.equal(ctx.report.processScenario.level, 'signed-package-required')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
