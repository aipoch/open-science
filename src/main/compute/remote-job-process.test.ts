import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { remoteJobPidTerminationFunctionLines } from './remote-job-process'

// Execute the production shell protocol with deterministic process observations. The kill double
// never sends a real signal; unexpected targets remain visible in stdout and fail the assertions.
const execute = (fixture: string): SpawnSyncReturns<string> =>
  spawnSync(
    '/bin/sh',
    [
      '-c',
      [
        'workdir=/job',
        ...remoteJobPidTerminationFunctionLines(),
        'sleep() { :; }',
        'lsof() { return 1; }',
        'kill() { echo "signal:$*"; }',
        fixture,
        'kill_job_pid 200; result=$?; echo result:$result'
      ].join('\n')
    ],
    { encoding: 'utf8' }
  )

describe.skipIf(process.platform === 'win32')('remote Job session termination protocol', () => {
  it('refuses a process in a shared session even when its cwd matches', () => {
    const result = execute(`
readlink() { echo /job; }
ps() { echo '200 100 100 S'; }
`)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('result:2\n')
  })

  it('never signals a reused PID whose cwd differs', () => {
    const result = execute('readlink() { echo /another-job; }')
    expect(result.stdout).toBe('result:1\n')
  })

  it('keeps cancellation unconfirmed when process enumeration fails', () => {
    const result = execute('readlink() { echo /job; }; ps() { return 1; }')
    expect(result.stdout).toBe('result:2\n')
  })

  it('does not mistake missing cwd permission for a disappeared process', () => {
    const result = execute(`
readlink() { return 1; }
ps() { echo '200 200 200 S'; }
`)
    expect(result.stdout).toBe('result:2\n')
  })

  it.each([1, 2, 127])('distinguishes no matching PID from a failed ps command (%s)', (status) => {
    const result = execute(`
readlink() { return 1; }
ps() { if [ "$1" = '-eo' ]; then echo '100 100 100 S'; else return ${status}; fi; }
`)
    expect(result.stdout).toBe(`result:${status === 1 ? 3 : 2}\n`)
  })

  it('does not confirm delivered signals while a workload is still alive', () => {
    const result = execute(`
readlink() { echo /job; }
ps() { printf '%s\\n' '200 200 200 T' '201 201 200 D'; }
`)
    expect(result.stdout).toContain('signal:-KILL -- -201\n')
    expect(result.stdout).not.toContain('signal:-KILL -- -200\n')
    expect(result.stdout).not.toContain('terminated')
    expect(result.stdout).toContain('result:2\n')
  })

  it('does not signal a reused workload group after terminating its original members', () => {
    const result = execute(`
readlink() { echo /job; }
root_alive=1; child_alive=1; foreign_alive=0
ps() {
  if [ "$root_alive" = 1 ]; then echo '200 200 200 T'; fi
  if [ "$child_alive" = 1 ]; then echo '201 201 200 S'; fi
  if [ "$foreign_alive" = 1 ]; then echo '301 201 300 S'; fi
  return 0
}
kill() {
  case "$1:$3" in
    -TERM:-201|-KILL:-201)
      if [ "$foreign_alive" = 1 ]; then
        echo 'signalled-unowned-group'
      else
        child_alive=0
        foreign_alive=1
      fi
      ;;
    -KILL:-200) root_alive=0 ;;
  esac
  return 0
}
`)
    // Either fatal signal releases the original PGID. No second signal may target its new owner.
    expect(result.stdout).toBe('terminated\nresult:0\n')
  })

  it('can retry after a partial stop without losing its ownership witness', () => {
    const result = execute(`
readlink() { echo /job; }
root_alive=1; child_alive=1; allow_exit=0
ps() {
  if [ "$root_alive" = 1 ]; then echo '200 200 200 T'; fi
  if [ "$child_alive" = 1 ]; then echo '201 201 200 D'; fi
  return 0
}
kill() {
  if [ "$1" = '-KILL' ] && [ "$allow_exit" = 1 ]; then
    case $3 in -201) child_alive=0 ;; -200) root_alive=0 ;; esac
  fi
  return 0
}
kill_job_pid 200; echo initial:$?
allow_exit=1
`)
    expect(result.stdout).toBe('initial:2\nterminated\nresult:0\n')
  })
})
