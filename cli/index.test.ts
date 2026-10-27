import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { isProcessAlive, parseCliArgs } from './index.mjs'

describe('local CLI utilities', () => {
  const sourceCli = fileURLToPath(new URL('../packages/open-science/cli.mjs', import.meta.url))
  const invoke = (
    entry: string,
    argv: string[],
    environment: NodeJS.ProcessEnv = {}
  ): SpawnSyncReturns<string> => {
    const env = { ...process.env }
    delete env.OPEN_SCIENCE_CONFIG_ROOT
    delete env.OPEN_SCIENCE_STORAGE_ROOT
    return spawnSync(process.execPath, [entry, ...argv], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...env, ...environment }
    })
  }

  it.each(['./index.mjs', '../packages/open-science/cli.mjs'])(
    'reports the application version through %s without initializing a profile',
    async (entry) => {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-version-'))
      const profile = join(directory, 'missing-profile')
      const { version } = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8')
      )
      try {
        for (const argv of [['--version'], ['-v'], ['version'], ['version', '--json']]) {
          const result = invoke(fileURLToPath(new URL(entry, import.meta.url)), argv, {
            OPEN_SCIENCE_CONFIG_ROOT: profile
          })
          expect(result.error).toBeUndefined()
          expect(result.status).toBe(0)
          expect(result.stderr).toBe('')
          expect(result.stdout).toBe(
            (argv.includes('--json') ? JSON.stringify({ version }) : version) + '\n'
          )
        }
        expect(existsSync(profile)).toBe(false)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('reports source startup and discovery paths separately', () => {
    const result = invoke(sourceCli, ['paths', '--json'])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      cliPath: sourceCli,
      nodePath: process.execPath,
      startupConfigRoot: join(homedir(), '.open-science-project'),
      discoveryConfigRoots: [
        join(homedir(), '.open-science-project'),
        join(homedir(), '.open-science')
      ]
    })
  })

  it('uses profile/environment precedence without reading or creating profile files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-paths-'))
    const explicit = join(directory, 'explicit profile')
    const config = join(directory, 'environment config')
    const storage = join(directory, 'environment storage')
    try {
      for (const [argv, env, expected] of [
        [
          ['--profile', explicit],
          { OPEN_SCIENCE_CONFIG_ROOT: config, OPEN_SCIENCE_STORAGE_ROOT: storage },
          explicit
        ],
        [['--config-root', explicit], { OPEN_SCIENCE_CONFIG_ROOT: config }, explicit],
        [[], { OPEN_SCIENCE_CONFIG_ROOT: config, OPEN_SCIENCE_STORAGE_ROOT: storage }, config],
        [[], { OPEN_SCIENCE_STORAGE_ROOT: storage }, storage]
      ] as Array<[string[], NodeJS.ProcessEnv, string]>) {
        const result = invoke(sourceCli, ['paths', '--json', ...argv], env)
        expect(result.status).toBe(0)
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout)).toMatchObject({
          startupConfigRoot: normalize(expected),
          discoveryConfigRoots: [normalize(expected)]
        })
      }
      const human = invoke(sourceCli, ['paths', '--profile', explicit])
      expect(human.status).toBe(0)
      expect(human.stdout).toContain(`Startup configuration: ${explicit}`)
      expect(human.stdout).toContain('Service discovery (in order):')
      const invalid = invoke(sourceCli, ['paths', '--json', '--profile', 'relative-profile'])
      expect(invalid.status).not.toBe(0)
      expect(invalid.stdout).toBe('')
      expect(JSON.parse(invalid.stderr).error.message).toContain('absolute path')
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['1.2.3', '1.2.3-nightly.gabcdef0'])(
    'uses installed metadata %s without a backend or optional native dependency',
    async (version) => {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-installed-version-'))
      const installed = join(directory, 'backend')
      try {
        await mkdir(installed)
        // Copy the shipped CLI files; no node_modules, native binaries or running service.
        for (const file of await readdir(new URL('../packages/open-science/', import.meta.url))) {
          if (/\.(mjs|cjs)$/.test(file)) {
            await cp(
              new URL(`../packages/open-science/${file}`, import.meta.url),
              join(installed, file)
            )
          }
        }
        await writeFile(
          join(installed, 'package.json'),
          JSON.stringify({
            name: '@aipoch/open-science',
            version,
            optionalDependencies: { '@aipoch/open-science-darwin-arm64': version }
          })
        )
        // An enclosing application's metadata must not supply the installed CLI version.
        await writeFile(
          join(directory, 'package.json'),
          JSON.stringify({ name: 'unrelated', version: '9.9.9' })
        )
        const entry = join(installed, 'cli.mjs')
        const result = invoke(entry, ['version', '--json'], {
          OPEN_SCIENCE_CONFIG_ROOT: 'invalid-relative-root'
        })
        expect(result.status).toBe(0)
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout)).toEqual({ version })
        const paths = invoke(entry, ['paths', '--json'])
        expect(paths.status).toBe(0)
        expect(paths.stderr).toBe('')
        const reportedPaths = JSON.parse(paths.stdout)
        // Windows may preserve an 8.3 temp path in import.meta.url; compare file identity.
        expect({ ...reportedPaths, cliPath: await realpath(reportedPaths.cliPath) }).toEqual({
          cliPath: await realpath(entry),
          nodePath: process.execPath,
          startupConfigRoot: join(homedir(), '.open-science'),
          discoveryConfigRoots: [
            join(homedir(), '.open-science-project'),
            join(homedir(), '.open-science')
          ]
        })
        for (const manifest of [
          '{',
          JSON.stringify({ name: '@aipoch/open-science', version: null })
        ]) {
          await writeFile(join(installed, 'package.json'), manifest)
          const invalid = invoke(entry, ['version', '--json'])
          expect(invalid.status).not.toBe(0)
          expect(invalid.stdout).toBe('')
        }
        await rm(join(installed, 'package.json'))
        const missing = invoke(entry, ['--version'])
        expect(missing.status).not.toBe(0)
        expect(missing.stdout).toBe('')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})

describe('CLI argument parsing', () => {
  it('parses machine-readable start output', () => {
    expect(parseCliArgs(['start', '--json'])).toEqual({
      command: 'start',
      options: { open: true, json: true }
    })
  })

  it('rejects unsupported --json for url instead of ignoring it', () => {
    expect(() => parseCliArgs(['url', '--json'])).toThrow('--json is not supported')
  })

  it('parses start options', () => {
    expect(
      parseCliArgs([
        'start',
        '--port',
        '44200',
        '--app-path',
        '/opt/open-science',
        '--config-root',
        '/tmp/open-science',
        '--no-open'
      ])
    ).toEqual({
      command: 'start',
      options: {
        open: false,
        json: false,
        port: 44200,
        appPath: '/opt/open-science',
        configRoot: '/tmp/open-science'
      }
    })
  })

  it('parses the explicit no-sandbox start fallback', () => {
    expect(parseCliArgs(['start', '--no-sandbox'])).toEqual({
      command: 'start',
      options: { open: true, json: false, noSandbox: true }
    })
  })

  it('parses status JSON output and rejects invalid options', () => {
    expect(parseCliArgs(['status', '--json'])).toEqual({
      command: 'status',
      options: { open: true, json: true }
    })
    expect(() => parseCliArgs(['start', '--port', '70000'])).toThrow('Invalid port')
    expect(() => parseCliArgs(['start', '--unknown'])).toThrow('Unknown option')
  })

  it('requires a value for value-taking flags', () => {
    expect(() => parseCliArgs(['start', '--app-path'])).toThrow('requires a value')
    expect(() => parseCliArgs(['start', '--config-root'])).toThrow('requires a value')
  })
})

describe('removed application update command', () => {
  it.each(
    ['./index.mjs', '../packages/open-science/cli.mjs'].flatMap((entry) =>
      [[], ['--json'], ['--help']].map((flags) => ({ entry, flags }))
    )
  )(
    'rejects update through $entry with $flags without creating a profile',
    async ({ entry, flags }) => {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-removed-update-'))
      const profile = join(directory, 'profile')
      try {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL(entry, import.meta.url)),
            'update',
            '--config-root',
            profile,
            ...flags
          ],
          { encoding: 'utf8', timeout: 10_000 }
        )
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('Unknown command: update')
        if (flags.includes('--json')) {
          expect(JSON.parse(result.stderr)).toMatchObject({
            error: { code: 'invalid_cli_usage' },
            exitCode: 2
          })
        }
        expect(existsSync(profile)).toBe(false)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})

describe('isProcessAlive', () => {
  it('returns true for the running test process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns false for invalid or non-existent pids', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
    // A pid this large is effectively certain not to be running.
    expect(isProcessAlive(2 ** 30)).toBe(false)
  })
})
