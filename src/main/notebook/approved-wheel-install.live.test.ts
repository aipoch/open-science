import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { installApprovedWheels, type WheelInstallPlan } from './approved-wheel-install'

// Opt-in certification downloads one public wheel into a disposable venv, never an app Runtime.
it.skipIf(process.env.OPEN_SCIENCE_LIVE_WHEEL_TEST !== '1')(
  'resolves, declines, approves and installs an exact wheel with real pip',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'approved-wheel-live-'))
    const execute = promisify(execFile)
    try {
      await execute('python3', ['-m', 'venv', join(root, 'venv')])
      const python = join(
        root,
        'venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      )
      // The macOS system venv seeds pip 21, which has no report/dry-run API. Bootstrap only this
      // disposable test fixture; production never silently upgrades an old Runtime installer.
      await execute(python, ['-m', 'pip', '--isolated', 'install', '--upgrade', 'pip==25.0.1'], {
        timeout: 60_000
      })
      const redirected = join(root, 'unexpected-target')
      const config = join(root, 'venv', process.platform === 'win32' ? 'pip.ini' : 'pip.conf')
      await writeFile(
        config,
        `[global]\ntarget = ${redirected}\nextra-index-url = https://unexpected.invalid/simple\n`
      )
      const configCheck = await execute(python, ['-m', 'pip', '--isolated', 'config', 'list'])
      expect(configCheck.stdout).toContain('unexpected.invalid')
      expect(configCheck.stdout).toContain(redirected)
      const plans: WheelInstallPlan[] = []
      const base = {
        cacheRoot: join(root, 'plans'),
        packages: ['packaging==24.2'],
        run: async (args: string[], configEnv: { PIP_CONFIG_FILE: string }) => {
          try {
            const result = await execute(python, ['-m', 'pip', ...args], {
              timeout: 60_000,
              env: { ...process.env, ...configEnv }
            })
            return { code: 0, ...result }
          } catch (error) {
            const failure = error as { code?: number; stdout?: string; stderr?: string }
            return {
              code: typeof failure.code === 'number' ? failure.code : 1,
              stdout: failure.stdout ?? '',
              stderr: failure.stderr ?? String(error)
            }
          }
        }
      }
      const denied = await installApprovedWheels({
        ...base,
        approve: async (plan) => {
          plans.push(plan)
          return false
        }
      })
      expect(denied.error, JSON.stringify(denied)).toContain('not approved')
      await expect(execute(python, ['-c', 'import packaging'])).rejects.toThrow()
      const installed = await installApprovedWheels({
        ...base,
        approve: async (plan) => {
          plans.push(plan)
          await writeFile(
            config,
            `[global]\ntarget = ${redirected}\nextra-index-url = https://changed.invalid/simple\n`
          )
          return true
        }
      })
      expect(installed.ok, JSON.stringify(installed)).toBe(true)
      expect(installed.log).not.toContain('unexpected.invalid')
      expect(installed.log).not.toContain('changed.invalid')
      await expect(stat(redirected)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(plans[1]).toEqual(plans[0])
      expect(
        (
          await execute(python, ['-c', 'import packaging; print(packaging.__version__)'])
        ).stdout.trim()
      ).toBe('24.2')
      const retry = await installApprovedWheels({
        ...base,
        approve: async () => {
          throw new Error('Unexpected repeat approval')
        }
      })
      expect(retry.ok).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)
