import { mkdtemp, mkdir, readFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { piBootstrapPath } from './pi-runtime'

afterEach(() => vi.unstubAllEnvs())

it.each([
  ['desktop', true, 'Open-Science.app/Contents/Resources/backend'],
  ['standalone', true, 'standalone'],
  ['development', false, 'development']
] as const)('reads the shipped Pi bootstrap in the %s backend', async (_, packaged, layout) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-bootstrap-'))
  try {
    const applicationPath = join(root, layout)
    const bootstrap = join(applicationPath, 'out', 'pi-bootstrap')
    await mkdir(bootstrap, { recursive: true })
    // build-pi-acp.mjs and stage-backend.mjs ship these beside out/backend.
    const files = ['package-lock.json', 'bootstrap.mjs', 'permission-guard.mjs']
    for (const file of files) {
      await copyFile(join(process.cwd(), 'src/main/pi-acp', file), join(bootstrap, file))
    }
    // node-entry sets resources to the backend's resources, not Electron's resources.
    vi.stubEnv('OPEN_SCIENCE_HOST_PACKAGED', packaged ? '1' : '0')
    vi.stubEnv('OPEN_SCIENCE_RESOURCES_PATH', join(applicationPath, 'resources'))
    const resolved = piBootstrapPath({ backendDirectory: join(applicationPath, 'out', 'backend') })
    for (const file of files) {
      expect(await readFile(join(resolved, file), 'utf8')).toBe(
        await readFile(join(bootstrap, file), 'utf8')
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
