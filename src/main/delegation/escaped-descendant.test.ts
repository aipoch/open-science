import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import {
  proveRecordedPosixLeaderGone,
  capturePosixProcessTreeIdentity,
  trackOwnedPosixProcessTree
} from '../process-tree'

describe('Escaped descendant detection', () => {
  it('blocks cold recovery when a detached descendant carries the ownership marker', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return

    const marker = `test-escaped-${Date.now()}`
    const childScript = `/tmp/test-child-${Date.now()}.mjs`

    // Child sleeps 5 seconds
    writeFileSync(childScript, `setTimeout(() => {}, 5000)`)

    try {
      // Spawn a leader that creates a detached child then exits
      const leader = spawn('node', [
        '-e',
        `
        import { spawn } from 'node:child_process'
        const child = spawn('node', ['${childScript}'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, OPEN_SCIENCE_PROCESS_TREE_ID: '${marker}' }
        })
        child.unref()
        process.exit(0)
      `
      ])

      const leaderPid = leader.pid!
      const leaderBirthToken = 'fake-token' // In real code this would be read from /proc

      // Wait for leader to exit
      await new Promise((resolve) => leader.on('exit', resolve))

      // Leader is gone, but detached child should still be running with the marker
      // proveRecordedPosixLeaderGone should return 'blocked' due to the marker scan
      const outcome = await proveRecordedPosixLeaderGone(
        { pid: leaderPid, birthToken: leaderBirthToken },
        marker
      )

      // Should be blocked because the detached child still carries the marker
      expect(outcome).toBe('blocked')
    } finally {
      unlinkSync(childScript)
    }
  }, 10000)

  it('returns gone when complete scan finds leader absent, group absent, and no marker', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return

    const marker = `test-gone-${Date.now()}`

    // Spawn a process that exits immediately
    const proc = spawn('node', ['-e', 'process.exit(0)'], {
      env: { ...process.env, OPEN_SCIENCE_PROCESS_TREE_ID: marker }
    })
    const pid = proc.pid!

    // Track the process so we can capture its identity
    trackOwnedPosixProcessTree(proc, marker)

    // Capture the real birth token
    const identity = capturePosixProcessTreeIdentity(proc)
    const birthToken = identity?.birthToken ?? 'unknown'

    await new Promise((resolve) => proc.on('exit', resolve))

    // Wait a bit to ensure the PID is fully released from the system
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Leader is gone, group is gone, complete marker scan finds nothing. Per the documented
    // contract: return 'gone' when the recorded pid is absent, the owned group is gone, and
    // no process in the system carries that marker (with a complete scan).
    const outcome = await proveRecordedPosixLeaderGone({ pid, birthToken }, marker)

    expect(outcome).toBe('gone')
  })
})
