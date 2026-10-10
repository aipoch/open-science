import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
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
