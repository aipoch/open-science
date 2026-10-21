import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function bundle(enabled: boolean): { text: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'local-update-build-'))
  roots.push(root)
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { resolveConfig } from 'electron-vite';
    import { build } from 'vite';
    const resolved = await resolveConfig({}, 'build');
    const main = resolved.config.main;
    await build({ ...main, configFile: false, logLevel: 'silent',
      build: { ...main.build, outDir: process.argv[1], emptyOutDir: true } });
  `,
      root
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION: enabled ? '1' : '',
        OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CREDENTIALS: 'sandbox',
        // Runtime flags are deliberately present during both bundles; they cannot select the adapter.
        OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG: '/should-not-enable-runtime-adapter.json'
      },
      stdio: 'pipe'
    }
  )
  const files = readdirSync(root).filter((file) => file.endsWith('.js'))
  return { files, text: files.map((file) => readFileSync(join(root, file), 'utf8')).join('\n') }
}

it('erases all local adapter code and runtime activation inputs from the ordinary main bundle', () => {
  const production = bundle(false)
  expect(production.text).not.toContain('OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG')
  expect(production.text).not.toContain('Native installation is disabled in this validation build')
  expect(production.text).not.toContain('LocalMacDownloadUpdater')
  expect(production.text).not.toContain('handoff-boundary')
  expect(production.text).not.toContain('local-update-credential-sandbox')
  expect(production.text).not.toContain('local-update-validation-updater.yml')
  expect(production.files.some((file) => file.startsWith('adapter-'))).toBe(false)
  const validation = bundle(true)
  expect(validation.text).toContain('OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG')
  expect(validation.text).toContain('LocalMacDownloadUpdater')
  expect(validation.text).toContain('handoff-boundary')
  expect(validation.text).toContain('local-update-credential-sandbox')
}, 60_000)
