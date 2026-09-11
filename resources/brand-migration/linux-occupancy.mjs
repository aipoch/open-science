import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const inspector = readFileSync(new URL('./linux-occupancy.py', import.meta.url), 'utf8')

// Only this bundled, read-only inspector may run with elevation. The migration and its writers
// stay under the invoking user. -I disables Python user imports; roots are data on stdin, not code.
export function assertNoLinuxOpenFiles(
  roots,
  {
    probe = spawnSync,
    privileged = process.env.OPEN_SCIENCE_MIGRATION_PRIVILEGED_INSPECTION === '1'
  } = {}
) {
  const args = ['-I', '-S', '-B', '-c', inspector]
  const options = {
    input: JSON.stringify({ roots, ownerPid: process.pid }),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' }
  }
  const inspect = (command, commandArgs) => {
    const result = probe(command, commandArgs, options)
    if (result.error || result.status !== 0 || result.stderr?.trim())
      throw new Error(
        result.error?.message ?? (result.stderr || 'inspection process failed').trim()
      )
    const value = JSON.parse(result.stdout)
    if (
      value.version !== 1 ||
      typeof value.complete !== 'boolean' ||
      typeof value.permissionDenied !== 'boolean' ||
      !Array.isArray(value.errors) ||
      !value.errors.every((error) => typeof error === 'string') ||
      !Array.isArray(value.occupied) ||
      !value.occupied.every(
        (entry) =>
          Number.isSafeInteger(entry.pid) && entry.pid > 0 && typeof entry.descriptor === 'string'
      ) ||
      (value.complete && value.permissionDenied) ||
      value.complete !== (value.errors.length === 0)
    )
      throw new Error('Incomplete Linux occupancy report')
    return value
  }
  let report
  try {
    report = inspect('/usr/bin/python3', args)
    // Never retry away a positive writer, even when unrelated system processes are unreadable.
    if (!report.occupied.length && !report.complete && report.permissionDenied && privileged)
      report = inspect('/usr/bin/sudo', ['-n', '--', '/usr/bin/python3', ...args])
  } catch (error) {
    throw new Error(`Cannot verify migration file occupancy: ${error.message}`)
  }
  if (report.occupied.length) {
    const entry = report.occupied[0]
    throw new Error(
      `Migration paths are occupied (PID ${entry.pid}, ${entry.descriptor}); close the writer or leave its cwd first`
    )
  }
  if (!report.complete)
    throw new Error(
      `Cannot verify migration file occupancy: ${report.errors.join('; ')}. ` +
        'Linux needs visibility of every cwd, descriptor and mapping. An administrator may authorize ' +
        'the bundled read-only inspector with OPEN_SCIENCE_MIGRATION_PRIVILEGED_INSPECTION=1 and non-interactive sudo; the migrator itself must remain unprivileged.'
    )
}
