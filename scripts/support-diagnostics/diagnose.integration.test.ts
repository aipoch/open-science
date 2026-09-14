import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionFile } from '../../src/shared/session-persistence'
import { modelFacingAppMcpToolName } from '../../src/main/agent-framework/app-mcp-names'

it.skipIf(process.platform !== 'win32')(
  'collects redacted errors with production Session envelopes and tool identities',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'open-science-diag-envelope-'))
    const canary = 'PRIVATE_DIAGNOSTIC_CANARY_3465'
    const time = Date.parse('2026-09-13T03:07:30Z')
    const toolCases = [
      ...[
        ['open-science-notebook', 'notebook_execute'],
        ['open-science-plan', 'generate_plan'],
        ['open-science-skills', 'request_skill_import']
      ].flatMap(([server, tool]) =>
        [
          tool,
          `${server}/${tool}`,
          modelFacingAppMcpToolName('claude-code', server, tool),
          modelFacingAppMcpToolName('opencode', server, tool),
          modelFacingAppMcpToolName('codex', server, tool),
          modelFacingAppMcpToolName('codex', server, tool, true)
        ].map((name) => ({ name, tool }))
      ),
      ...[
        `open-science-notebook/${canary}`,
        `open-science-notebook/notebook_execute/${canary}`,
        `${canary} open-science-notebook/notebook_execute`,
        'open-science-notebook/notebook_execute\n'
      ].map((name) => ({ name, tool: 'unknown' }))
    ]
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
      activities: toolCases.map(({ name }, index) => ({
        id: `private-call-${index}`,
        kind: 'tool',
        title: canary,
        providerToolName: name,
        promptMessageId: 'private-prompt',
        status: 'failed',
        sortIndex: index,
        eventIds: [],
        rawInput: { code: canary },
        rawOutput: { error: `Invalid notebook RPC token. ${canary}` },
        createdAt: time,
        updatedAt: time
      })),
      createdAt: time,
      updatedAt: time
    })
    const input = JSON.stringify(document)
    const sessionFile = join(root, 'session.json')
    const logFile = join(root, 'main.log')
    writeFileSync(sessionFile, input)
    const logInput = toolCases
      .flatMap(({ name }, index) => [
        {
          t: new Date(time).toISOString(),
          msg: 'permission request received',
          data: { tool: name, toolCallId: `private-call-${index}` }
        },
        {
          t: new Date(time).toISOString(),
          msg: 'tool call failed',
          data: { toolCallId: `private-call-${index}`, sessionId: 'private-session' }
        }
      ])
      .map((record) => JSON.stringify(record))
      .join('\n')
    writeFileSync(logFile, logInput)
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
    expect(report.signatureCounts['invalid-notebook-rpc-token']).toBe(toolCases.length)
    expect(report.inputs.find((entry: { kind: string }) => entry.kind === 'session')).toMatchObject(
      {
        format: 'envelope-v2',
        decodeStatus: 'decoded',
        activityCount: toolCases.length,
        inspectedActivityCount: toolCases.length,
        failedActivityCount: toolCases.length,
        activitiesWithOutput: toolCases.length
      }
    )
    const persisted = report.events.filter(
      (event: { event: string }) => event.event === 'persisted-tool-result'
    )
    const failed = report.events.filter((event: { event: string }) => event.event === 'tool-failed')
    expect(persisted.map((event: { tool: string }) => event.tool)).toEqual(
      toolCases.map(({ tool }) => tool)
    )
    expect(failed.map((event: { tool: string }) => event.tool)).toEqual(
      toolCases.map(({ tool }) => tool)
    )
    expect(failed.map((event: { toolCall: string }) => event.toolCall)).toEqual(
      persisted.map((event: { toolCall: string }) => event.toolCall)
    )
    const txt = readFileSync(join(root, reportDir, 'diagnosis.txt'), 'utf8')
    for (const secret of [canary, 'private-session', 'private-call', 'private-prompt', root]) {
      expect(raw).not.toContain(secret)
      expect(txt).not.toContain(secret)
    }
    expect(readFileSync(sessionFile, 'utf8')).toBe(input)
    expect(readFileSync(logFile, 'utf8')).toBe(logInput)
  },
  30_000
)
