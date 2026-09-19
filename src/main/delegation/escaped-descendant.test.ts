import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { proveRecordedPosixLeaderGone } from '../process-tree'

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

  it('remains blocked in cold recovery even when leader, group, and marker scan are all clean', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return

    const marker = `test-gone-${Date.now()}`

    // Spawn a process that exits immediately
    const proc = spawn('node', ['-e', 'process.exit(0)'], {
      env: { ...process.env, OPEN_SCIENCE_PROCESS_TREE_ID: marker }
    })
    const pid = proc.pid!
    const birthToken = 'fake-token'

    await new Promise((resolve) => proc.on('exit', resolve))

    // Leader is gone, group is gone, complete marker scan finds nothing. However, in cold recovery
    // (where we did not actively terminate), a descendant could have unsetenv() the marker or
    // daemonized, making it invisible to scans while still alive. Without an authoritative OS-owned
    // lifecycle handle (like Windows Job objects) or reboot proof, cold recovery must remain blocked.
    const outcome = await proveRecordedPosixLeaderGone({ pid, birthToken }, marker)

    expect(outcome).toBe('blocked')
  })
})
