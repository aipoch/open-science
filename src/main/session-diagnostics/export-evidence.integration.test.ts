import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as tar from 'tar'
import { createLogger, errorLogFields, flushLogs, initLogger } from '../logger'
import { logPermissionDiagnostic } from '../permission-grants/diagnostics'
import { runSessionDiagnosticWorker } from './collector'

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
  const directory = join(root, 'export')
  await mkdir(configRoot)
  await mkdir(directory)
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
  const result = await runSessionDiagnosticWorker({
    action: 'export',
    projectId: 'project',
    sessionId: 'session',
    configRoot,
    dataRoot: join(root, 'data'),
    logPath: join(logDir, 'main.log'),
    directory,
    appVersion: 'test',
    selectedItems: ['log:main.1.log']
  })
  expect(result.kind).toBe('archive')
  const extracted = join(root, 'unpacked')
  await mkdir(extracted)
  await tar.x({ file: join(directory, 'archive.tar.gz'), cwd: extracted })
  const exported = await readFile(join(extracted, 'logs/main.1.log'), 'utf8')
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
  const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'))
  expect(manifest.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'log:main.log', selected: false }),
      expect.objectContaining({ id: 'log:main.1.log', selected: true })
    ])
  )
})
