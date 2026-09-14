import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionFile } from '../../src/shared/session-persistence'

it.skipIf(process.platform !== 'win32')(
  'collects redacted tool errors from files emitted by the production Session writer',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'open-science-diag-envelope-'))
    const canary = 'PRIVATE_DIAGNOSTIC_CANARY_3465'
    const time = Date.parse('2026-09-13T03:07:30Z')
    const document = createSessionFile({
      id: 'private-session',
      projectId: 'private-project',
      title: canary,
      status: 'idle',
      messages: [
        {
          id: 'private-prompt',
          role: 'user',
          content: canary,
          status: 'complete',
          eventIds: [],
          createdAt: time,
          updatedAt: time
        }
      ],
      activities: [
        {
          id: 'private-call',
          kind: 'tool',
          title: 'notebook_execute',
          providerToolName: 'notebook_execute',
          promptMessageId: 'private-prompt',
          status: 'failed',
          sortIndex: 1,
          eventIds: [],
          rawInput: { code: canary },
          rawOutput: { error: `Invalid notebook RPC token. ${canary}` },
          createdAt: time,
          updatedAt: time
        }
      ],
      createdAt: time,
      updatedAt: time
    })
    const input = JSON.stringify(document)
    const sessionFile = join(root, 'session.json')
    const logFile = join(root, 'main.log')
    writeFileSync(sessionFile, input)
    writeFileSync(logFile, '')
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve('scripts/support-diagnostics/diagnose.ps1'),
        '-LogPath',
        logFile,
        '-SessionPath',
        sessionFile,
        '-OutputRoot',
        root
      ],
      { windowsHide: true, timeout: 20_000 }
    )
    const reportDir = readdirSync(root).find((name) => name.startsWith('diagnosis-'))!
    const raw = readFileSync(join(root, reportDir, 'diagnosis.json'), 'utf8').replace(/^\uFEFF/, '')
    const report = JSON.parse(raw)
    expect(report.signatureCounts['invalid-notebook-rpc-token']).toBe(1)
    expect(report.inputs.find((entry: { kind: string }) => entry.kind === 'session')).toMatchObject(
      {
        format: 'envelope-v2',
        decodeStatus: 'decoded',
        activityCount: 1,
        inspectedActivityCount: 1,
        failedActivityCount: 1,
        activitiesWithOutput: 1
      }
    )
    const txt = readFileSync(join(root, reportDir, 'diagnosis.txt'), 'utf8')
    for (const secret of [canary, 'private-session', 'private-call', 'private-prompt', root]) {
      expect(raw).not.toContain(secret)
      expect(txt).not.toContain(secret)
    }
    expect(readFileSync(sessionFile, 'utf8')).toBe(input)
  },
  30_000
)
