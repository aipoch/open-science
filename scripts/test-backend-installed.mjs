/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Run inside an isolated Linux test environment with an unlocked OS vault, Python and bubblewrap.
// The fixture is the bundled existing e2e/fixtures/fake-opencode.mjs; no external model is called.
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { readFile, readdir, mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

assert.equal(process.platform, 'linux', 'This installed-artifact fixture targets Linux.')
const fakeAgent = process.env.OPEN_SCIENCE_TEST_FAKE_AGENT
assert.ok(fakeAgent, 'Set OPEN_SCIENCE_TEST_FAKE_AGENT to the bundled existing E2E agent fixture.')
const packageRoot =
  process.env.OPEN_SCIENCE_TEST_PACKAGE ?? '/usr/local/lib/node_modules/@aipoch/open-science'
const { connectToOpenScience } = await import(pathToFileURL(join(packageRoot, 'index.mjs')).href)
const root = await mkdtemp(join(tmpdir(), 'open-science-installed-'))
const bin = join(root, 'bin')
await mkdir(bin)
// Arguments are passed through a Node launcher, with no fixture path interpolation into shell code.
await writeFile(
  join(bin, 'opencode'),
  `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(fakeAgent).href)})\n`
)
await chmod(join(bin, 'opencode'), 0o700)
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPEN_SCIENCE_CONFIG_ROOT: root }
const exec = promisify(execFile)
const cli = async (...args) =>
  (await exec('open-science', args, { env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout
const start = () => cli('start', '--no-open', '--password-store=gnome-libsecret')
let running = false
let abortEvents
let consumeEvents
const passed = (message) => console.log(`PASS ${message}`)
const descendants = async (pid) => {
  const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')
  const result = []
  for (const child of children.trim().split(/\s+/).filter(Boolean)) {
    const stat = await readFile(`/proc/${child}/stat`, 'utf8').catch(() => '')
    if (stat)
      result.push({ pid: child, started: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] })
    result.push(...(await descendants(child)))
  }
  return result
}
try {
  const starts = await Promise.allSettled([start(), start()])
  running = true
  for (const result of starts) assert.equal(result.status, 'fulfilled', result.reason?.message)
  passed('concurrent installed CLI starts reuse one owner')
  const status = JSON.parse(await cli('status', '--json'))
  assert.equal(status.running, true)
  let state = JSON.parse(await readFile(join(root, 'web-service.json'), 'utf8'))
  const token = (await readFile(join(root, 'web-token'), 'utf8')).trim()
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-open-science-client': randomUUID()
  }
  const rpc = async (channel, ...args) => {
    const response = await fetch(
      `http://127.0.0.1:${state.port}/rpc/${encodeURIComponent(channel)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocolVersion: 1, args })
      }
    )
    const body = await response.json()
    assert.equal(body.ok, true, `${channel}: ${JSON.stringify(body)}`)
    return body.result
  }
  const html = await fetch(`http://127.0.0.1:${state.port}/`, { headers })
  assert.equal(html.status, 200)
  assert.match(await html.text(), /<html/)
  passed('packaged authenticated Web UI')
  const project = JSON.parse(await cli('project', 'create', 'Standalone verification', '--json'))
  const projectId = project.id
  assert.ok(projectId)
  const python = process.env.OPEN_SCIENCE_TEST_PYTHON ?? '/usr/bin/python3'
  await rpc('runtime:register-interpreter', { language: 'python', path: python })
  const environments = await rpc('runtime:list-environments')
  const selected = environments.python.find((entry) => entry.interpreterPath === python)
  assert.ok(selected?.runnable)
  await rpc('runtime:set-environment-enabled', {
    language: 'python',
    envId: selected.envId,
    enabled: true
  })
  const snapshot = await rpc('settings:upsert-provider', {
    type: 'custom',
    name: 'Standalone fixture',
    apiEndpoints: ['openai'],
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'e2e-model',
    key: 'fixture-key',
    supportsImageInput: true
  })
  const provider = snapshot.providers.find((item) => item.name === 'Standalone fixture')
  await rpc('settings:set-active-provider', { id: provider.id, model: 'e2e-model' })
  await rpc('settings:set-agent-framework', { id: 'opencode' })
  const detected = await rpc('settings:detect-opencode')
  assert.equal(detected.opencode.resolvedPath, join(bin, 'opencode'))
  assert.equal(detected.credentialStore, 'os')

  const client = await connectToOpenScience({ configRoot: root })
  abortEvents = new AbortController()
  const events = client.events({ signal: abortEvents.signal })
  await events.ready
  const observed = []
  consumeEvents = (async () => {
    for await (const event of events) observed.push(event)
  })()
  const task = JSON.parse(
    await cli(
      'run',
      '--project',
      projectId,
      '--prompt',
      'Verify Python background completion delivery.',
      '--approval-profile',
      'auto',
      '--wait',
      '--json'
    )
  )
  assert.equal(task.status, 'completed')
  assert.match(task.output, /Background execution submitted/)
  const scope = { projectId, sessionId: task.sessionId, workspaceCwd: task.cwd }
  const first = await rpc('notebook:execute', {
    ...scope,
    language: 'python',
    code: 'value = 40\nvalue + 2'
  })
  assert.equal(first.status, 'completed', first.text.stderr)
  assert.ok(
    first.outputs.some((output) => output.type === 'display' && output.data['text/plain'] === '42')
  )
  const second = await rpc('notebook:execute', { ...scope, language: 'python', code: 'value + 3' })
  assert.equal(second.status, 'completed', second.text.stderr)
  assert.ok(
    second.outputs.some((output) => output.type === 'display' && output.data['text/plain'] === '43')
  )
  passed('CLI task → real Agent protocol/MCP → sandboxed stateful Python → Web Notebook')
  assert.ok(observed.some((event) => event.runId === task.id))
  for (let index = 1; index < observed.length; index++)
    assert.ok(observed[index].sequence > observed[index - 1].sequence)
  passed('SDK event delivery and ordering')

  const held = await client.startRun({
    project: projectId,
    prompt: 'Cold recovery held child.',
    permissionProfile: 'auto'
  })
  await cli('run', 'cancel', held.id, '--json')
  assert.equal((await client.waitForRun(held.id)).status, 'cancelled')
  passed('CLI cancellation of an SDK-started task')
  abortEvents.abort()
  await consumeEvents
  const ownedChildren = await descendants(state.pid)
  assert.ok(ownedChildren.length > 0, 'Exercise shutdown with owned child processes.')
  const stopped = JSON.parse(await cli('stop', '--json'))
  running = false
  assert.equal(stopped.result, 'daemon-stopped')
  for (const child of ownedChildren) {
    const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8').catch(() => '')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    assert.ok(
      !stat || fields[0] === 'Z' || fields[19] !== child.started,
      `Owned child ${child.pid} remains running.`
    )
  }
  passed('graceful shutdown with live Notebook kernel and no surviving owned children')
  await start()
  running = true
  state = JSON.parse(await readFile(join(root, 'web-service.json'), 'utf8'))
  const restored = await rpc('sessions:load-one', { projectId, sessionId: task.sessionId })
  assert.equal(restored.id, task.sessionId)
  assert.equal(
    (await rpc('settings:detect-opencode')).providers.find((item) => item.id === provider.id)
      .hasKey,
    true
  )
  const history = await rpc('notebook:state', scope)
  assert.ok(JSON.stringify(history).includes(first.runId))
  passed('session/Notebook recovery and OS-encrypted credentials after restart')

  const owner = JSON.parse(await readFile(join(root, 'runtime-owner.json'), 'utf8'))
  const current = JSON.parse(await cli('status', '--json'))
  assert.equal(owner.pid, current.pid)
  process.kill(owner.pid, 'SIGKILL') // Only this authenticated test-owned process inside the container.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await start()
  state = JSON.parse(await readFile(join(root, 'web-service.json'), 'utf8'))
  assert.notEqual(state.pid, owner.pid)
  assert.equal(
    (await rpc('sessions:load-one', { projectId, sessionId: task.sessionId })).id,
    task.sessionId
  )
  passed('abnormal exit releases ownership; stale records do not prevent recovery')
} catch (error) {
  for (const file of await readdir(root)) {
    if (file.startsWith('cli-daemon-'))
      console.error((await readFile(join(root, file), 'utf8')).slice(-4000))
  }
  throw error
} finally {
  abortEvents?.abort()
  await consumeEvents?.catch(() => undefined)
  if (running) {
    await cli('stop', '--json')
    running = false
  }
  // Managed skill snapshots are intentionally read-only; restore only our test directory modes.
  const writableDirectories = async (directory) => {
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writableDirectories(join(directory, entry.name))
    }
  }
  await writableDirectories(root)
  await rm(root, { recursive: true, force: true })
}
