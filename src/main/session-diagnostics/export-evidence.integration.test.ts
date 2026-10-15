import { createAcpHandlerWorkflows } from '../acp/handler-workflows'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createLogger, errorLogFields, flushLogs, initLogger } from '@aipoch/diagnostics/node'
import { logPermissionDiagnostic } from '../permission-grants/diagnostics'
import { exportDiagnosticFiles } from '../diagnostics/integration-test-helpers'

const roots: string[] = []
afterEach(async () => {
  await flushLogs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('preserves an unfamiliar operation failure through real logging, rotation, reinitialization and archive export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-evidence-'))
  roots.push(root)
  const logDir = join(root, 'logs')
  const configRoot = join(root, 'config')
  await mkdir(configRoot)
  initLogger({ logDir, runId: 'before-restart', maxBytes: 4096, mirrorToConsole: false })
  const log = createLogger('new-component-without-export-registration')
  const cause = Object.assign(new Error('disk read failed'), { code: 'EIO', syscall: 'read' })
  const error = new Error('Cannot finish; api_key=diagnostic-secret-123', { cause })
  error.stack = 'Error: Cannot finish\n    at load (/opt/private-user/app/loader.js:42:7)'
  // Some owners already log detailed errors; export must preserve that existing evidence.
  log.error('operation failed', {
    operation: 'an-unregistered-operation',
    operationId: 'operation-evidence',
    phase: 'reading-a-new-source',
    sessionId: 'session',
    projectId: 'project',
    ...errorLogFields(error)
  })
  logPermissionDiagnostic({
    stage: 'decision',
    frameworkId: 'opencode',
    modelRoute: 'opencode-openai',
    sessionId: 'session',
    toolCallId: '/opt/private-user/private-tool',
    fallback: true,
    reason: 'command_not_rememberable',
    toolKind: 'execute',
    hasRawInput: true,
    hasReportedToolName: false,
    outcome: 'approval_required',
    authority: 'human'
  })
  for (const authority of ['registry_grant', 'human', 'automatic_policy'] as const) {
    logPermissionDiagnostic({
      stage: 'decision',
      sessionId: 'session',
      authority,
      fallback: false,
      outcome: 'allowed',
      reason: 'normal_permission_canary'
    })
  }
  await flushLogs()
  expect(await readFile(join(logDir, 'main.log'), 'utf8')).not.toContain('normal_permission_canary')
  // Force exactly one rotation with a record that fits alone but exceeds the remaining file space.
  log.info('rotation boundary', { reason: 'x'.repeat(3600) })
  await flushLogs()
  initLogger({ logDir, runId: 'after-restart', maxBytes: 4096, mirrorToConsole: false })
  await flushLogs()
  const before = await readFile(join(logDir, 'main.1.log'), 'utf8')
  expect(before).toContain('operation failed')
  const files = await exportDiagnosticFiles(
    {
      configRoot,
      dataRoot: join(root, 'data'),
      logPath: join(logDir, 'main.log'),
      appVersion: 'test'
    },
    { projectId: 'project', sessionId: 'session', selectedItems: ['log:main.1.log'] }
  )
  const exported = files['logs/main.1.log']
  for (const retained of [
    'new-component-without-export-registration',
    'an-unregistered-operation',
    'reading-a-new-source',
    'operation-evidence',
    'permission decision trace',
    'command_not_rememberable',
    '"toolKind":"execute"',
    '"hasRawInput":true',
    '"hasReportedToolName":false',
    'opencode-openai',
    'disk read failed',
    'EIO',
    'read',
    'loader.js:42:7'
  ])
    expect(exported).toContain(retained)
  for (const excluded of ['diagnostic-secret-123', '/opt/private-user', 'normal_permission_canary'])
    expect(exported).not.toContain(excluded)
  expect(await readFile(join(logDir, 'main.1.log'), 'utf8')).toBe(before)
  const manifest = JSON.parse(files['manifest.json'])
  expect(manifest.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'log:main.log', selected: false }),
      expect.objectContaining({ id: 'log:main.1.log', selected: true })
    ])
  )
})

it('exports the actual failed resume operation with session identity and redacted exception evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resume-diagnostic-evidence-'))
  roots.push(root)
  const logDir = join(root, 'logs')
  const configRoot = join(root, 'config')
  await mkdir(configRoot)
  initLogger({ logDir, mirrorToConsole: false })
  const failure = new Error('Resume failed; api_key=resume-secret-canary')
  failure.stack =
    'Error: Resume failed; api_key=resume-secret-canary\n    at resume (/opt/private-user/app/resume.js:42:7)'
  const workflows = createAcpHandlerWorkflows(
    {
      resumeSession: async () => {
        throw failure
      }
    } as unknown as Parameters<typeof createAcpHandlerWorkflows>[0],
    {} as Parameters<typeof createAcpHandlerWorkflows>[1]
  )
  await expect(
    workflows.resumeSession({
      sessionId: 'resume-session',
      projectId: 'resume-project',
      cwd: '/workspace',
      previousFrameworkId: 'codex',
      agentTarget: { frameworkId: 'opencode', providerId: 'provider', reasoningEffort: 'medium' }
    })
  ).rejects.toBe(failure)
  await flushLogs()
  const files = await exportDiagnosticFiles(
    {
      configRoot,
      dataRoot: join(root, 'data'),
      logPath: join(logDir, 'main.log'),
      appVersion: 'test'
    },
    { projectId: 'resume-project', sessionId: 'resume-session', selectedItems: ['log:main.log'] }
  )
  const exported = files['logs/main.log']
  for (const retained of [
    'acp:resume-session failed',
    'resume-session',
    'resume-project',
    'Resume failed',
    'resume.js:42:7'
  ])
    expect(exported).toContain(retained)
  for (const excluded of ['resume-secret-canary', '/opt/private-user'])
    expect(exported).not.toContain(excluded)
  const record = exported
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.event === 'acp:resume-session failed')
  expect(Number.isFinite(Date.parse(record.t))).toBe(true)
  expect(record.diagnostics).toMatchObject({
    sessionId: 'resume-session',
    projectId: 'resume-project',
    frameworkId: 'opencode',
    previousFrameworkId: 'codex',
    operationId: expect.any(String)
  })
})

it('exports separate Desktop and Runtime logs with transport budgets and redacted failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-runtime-diagnostics-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  const desktopDir = join(root, 'profile', 'desktop-logs')
  const runtimeDir = join(root, 'runtime-logs')
  await mkdir(configRoot)
  await mkdir(join(root, 'profile', 'logs'), { recursive: true })
  await writeFile(
    join(root, 'profile', 'logs', 'main.log'),
    JSON.stringify({ level: 'error', msg: 'earlier desktop failure' }) + '\n'
  )
  initLogger({ logDir: desktopDir, mirrorToConsole: false })
  createLogger('desktop').error('desktop operation failed', {
    error: { message: 'Stop failed api_key=private-canary', code: 'EIO' }
  })
  createLogger('desktop').info('runtime-attach', {
    mode: 'adopted',
    launch: 'desktop',
    control: 'granted',
    runtimePid: 123,
    generation: 'test-generation'
  })
  await flushLogs()
  initLogger({ logDir: runtimeDir, mirrorToConsole: false })
  const budgets = {
    queuedBytes: 21,
    queuedFrames: 2,
    frameBytes: 13,
    bufferedBytes: 8,
    byteBudget: 34,
    frameBudget: 5
  }
  createLogger('desktop-transport').warn('transport failed', budgets)
  await flushLogs()
  const files = await exportDiagnosticFiles(
    {
      configRoot,
      dataRoot: join(root, 'data'),
      logPath: join(runtimeDir, 'main.log'),
      desktopLogPath: join(desktopDir, 'main.log'),
      legacyDesktopLogPath: join(root, 'profile', 'logs', 'main.log'),
      appVersion: 'test'
    },
    {
      projectId: 'project',
      sessionId: 'session',
      selectedItems: ['log:main.log', 'desktop-log:main.log', 'desktop-legacy-log:main.log']
    }
  )
  expect(files['logs/desktop-legacy/main.log']).toContain('earlier desktop failure')
  const desktop = files['logs/desktop/main.log']
  expect(desktop).toContain('Stop failed')
  expect(desktop).toContain('EIO')
  expect(desktop).toContain('adopted')
  expect(desktop).not.toContain('private-canary')
  expect(desktop).not.toContain('transport failed')
  const runtime = files['logs/main.log']
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(runtime.find((line) => line.event === 'transport failed').diagnostics).toMatchObject(
    budgets
  )
  expect(files['logs/main.log']).not.toContain('runtime-attach')
})
