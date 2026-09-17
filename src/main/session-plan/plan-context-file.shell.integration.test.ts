import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { getNotebookInputRoot } from '../notebook/input-staging'
import { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import { runShellCommand } from '../notebook/shell-process'
import { PlanContextFileStore } from './plan-context-file'

const roots: string[] = []

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const projection: ActivePlanProjection = {
  artifactId: 'plan-artifact',
  artifactVersionId: 'plan-version-7',
  artifactChecksum: 'checksum-7',
  revision: 7,
  approval: 'approved',
  lifecycle: 'in_progress',
  document: {
    schema_version: 1,
    task_summary: 'Verify the Shell-visible Plan reference.',
    phases: [
      {
        name: 'Verification',
        delegations: [
          {
            name: 'Shell',
            steps: [{ title: 'Read reference', description: 'Read only the needed JSON lines.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Readable Plan context'],
    feasibility: { confidence: 'high', rationale: 'The local Shell is available.' }
  },
  stepStatuses: {},
  stepStates: { 'Read reference': { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
}

describe.runIf(process.platform !== 'win32')('Plan context Shell reference', () => {
  it('reads the header and exact nested title directly through the production sandbox', async () => {
    const storageRoot = await temporaryRoot('plan-context-shell-storage-')
    const runtimeRoot = await temporaryRoot('plan-context-shell-runtime-')
    const workspace = join(storageRoot, 'workspace')
    const handoffDir = join(storageRoot, 'handoff')
    const projectId = 'project-1'
    const sessionId = 'session-1'
    const inputRoot = getNotebookInputRoot(storageRoot, projectId, sessionId)
    const store = new PlanContextFileStore({
      storageRoot,
      readCurrent: async () => projection
    })
    await Promise.all([store.refresh(projectId, sessionId), mkdir(workspace), mkdir(handoffDir)])

    const sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(storageRoot, 'command-temp'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })

    try {
      const result = await runShellCommand({
        command: `sed -n '1,8p; /"title": "Read reference"/p' "$OPEN_SCIENCE_INPUT_DIR/session-plan/current.json"`,
        cwd: workspace,
        handoffDir,
        runtimeRoot,
        inputRoot,
        sessionId,
        projectId,
        platform: process.platform,
        processSandbox: sandbox
      })

      expect(result).toMatchObject({ exitCode: 0, stderr: '' })
      expect(result.stdout).toContain('"active": true')
      expect(result.stdout).toContain('"artifactVersionId": "plan-version-7"')
      expect(result.stdout).toContain('"title": "Read reference"')
      expect(result.stdout).not.toContain('task_summary')
    } finally {
      await sandbox.dispose()
    }
  })

  it('is readable but immutable and isolated to the current session in the production sandbox', async () => {
    const storageRoot = await temporaryRoot('plan-context-sandbox-storage-')
    const runtimeRoot = join(storageRoot, 'runtime')
    const workspace = join(storageRoot, 'workspace')
    const handoffDir = join(storageRoot, 'handoff')
    const projectId = 'project-1'
    const sessionId = 'session-1'
    const otherSessionId = 'session-2'
    const inputRoot = getNotebookInputRoot(storageRoot, projectId, sessionId)
    const otherInputRoot = getNotebookInputRoot(storageRoot, projectId, otherSessionId)
    const currentPlan = join(inputRoot, 'session-plan', 'current.json')
    const otherPlan = join(otherInputRoot, 'session-plan', 'current.json')
    await Promise.all([mkdir(workspace), mkdir(handoffDir)])

    const store = new PlanContextFileStore({
      storageRoot,
      readCurrent: async (_projectId, requestedSessionId) =>
        requestedSessionId === sessionId
          ? projection
          : {
              ...projection,
              artifactVersionId: 'plan-version-other',
              artifactChecksum: 'checksum-other',
              revision: 8
            }
    })
    await store.refresh(projectId, sessionId)
    await store.refresh(projectId, otherSessionId)

    const sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(storageRoot, 'command-temp'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })

    try {
      const result = await runShellCommand({
        command: [
          `test "$OPEN_SCIENCE_INPUT_DIR" = ${JSON.stringify(inputRoot)}`,
          'plan=$(cat "$OPEN_SCIENCE_INPUT_DIR/session-plan/current.json")',
          'case "$plan" in *\'"artifactVersionId": "plan-version-7"\'*) ;; *) exit 40 ;; esac',
          'if { printf changed > "$OPEN_SCIENCE_INPUT_DIR/session-plan/current.json"; } 2>/dev/null; then exit 41; fi',
          `if { /bin/cat ${JSON.stringify(otherPlan)} >/dev/null; } 2>/dev/null; then exit 42; fi`,
          'printf verified'
        ].join(' && '),
        cwd: workspace,
        handoffDir,
        runtimeRoot,
        inputRoot,
        environment: {
          PATH: process.env.PATH,
          OPEN_SCIENCE_INPUT_DIR: otherInputRoot
        },
        sessionId,
        projectId,
        platform: process.platform,
        processSandbox: sandbox
      })

      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toBe('verified')
      expect(await readFile(currentPlan, 'utf8')).toContain('"artifactVersionId": "plan-version-7"')
      expect(await readFile(otherPlan, 'utf8')).toContain(
        '"artifactVersionId": "plan-version-other"'
      )
    } finally {
      await sandbox.dispose()
    }
  }, 20_000)

  it('keeps the Plan immutable when Shell cwd is an ancestor of its input root', async () => {
    const storageRoot = await temporaryRoot('plan-context-overlap-storage-')
    const runtimeRoot = await temporaryRoot('plan-context-overlap-runtime-')
    const handoffDir = join(storageRoot, 'handoff')
    const projectId = 'project-1'
    const sessionId = 'session-1'
    const inputRoot = getNotebookInputRoot(storageRoot, projectId, sessionId)
    const store = new PlanContextFileStore({
      storageRoot,
      readCurrent: async () => projection
    })
    await mkdir(handoffDir)
    const reference = await store.refresh(projectId, sessionId)
    const original = await readFile(reference!.path, 'utf8')
    const sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(storageRoot, 'command-temp'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })

    try {
      const result = await runShellCommand({
        command: [
          'plan="$OPEN_SCIENCE_INPUT_DIR/session-plan/current.json"',
          'test -r "$plan"',
          'if chmod u+w "$plan" 2>/dev/null; then exit 41; fi',
          'if { printf changed > "$plan"; } 2>/dev/null; then exit 42; fi',
          'if rm "$plan" 2>/dev/null; then exit 43; fi',
          'if { printf replacement > "$OPEN_SCIENCE_INPUT_DIR/session-plan/replacement.json"; } 2>/dev/null; then exit 44; fi',
          'printf writable > workspace-result.txt',
          'printf verified'
        ].join(' && '),
        cwd: storageRoot,
        handoffDir,
        runtimeRoot,
        inputRoot,
        sessionId,
        projectId,
        platform: process.platform,
        processSandbox: sandbox
      })
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toBe('verified')
      expect(await readFile(reference!.path, 'utf8')).toBe(original)
      expect(await readFile(join(storageRoot, 'workspace-result.txt'), 'utf8')).toBe('writable')
    } finally {
      await sandbox.dispose()
    }
  }, 20_000)
})
