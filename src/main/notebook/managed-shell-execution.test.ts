import { describe, expect, it } from 'vitest'
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createManagedShellExecutionCapability,
  resolveManagedShellExecutionCapability,
  type ManagedShellExecutionCapability
} from './managed-shell-execution'

const scope = { projectId: 'project', sessionId: 'session', executionInvocationId: 'invocation' }
const workspace = join(tmpdir(), 'managed-work')
const inputRoot = join(tmpdir(), 'managed-input')
const elsewhere = join(tmpdir(), 'managed-elsewhere')
const input = (): typeof scope & {
  cwd: string
  environment: { PATH: string; HOME: string }
  filesystem: { readOnlyRoots: string[]; readWriteRoots: string[] }
} => ({
  ...scope,
  cwd: workspace,
  environment: { PATH: '/usr/bin:/bin', HOME: workspace },
  filesystem: { readOnlyRoots: [inputRoot], readWriteRoots: [workspace] }
})

describe('main-owned managed Shell capability', () => {
  it('loads the ordinary Shell adapter from a CommonJS recovery bundle without starting a sandbox', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'ordinary-shell-commonjs-'))
    try {
      const bundle = join(fixture, 'recovery.cjs')
      buildSync({
        stdin: {
          contents: `
            import { NotebookShellProcessAdapter } from './shell-process'
            console.log(JSON.stringify({ adapter: typeof NotebookShellProcessAdapter }))
          `,
          resolveDir: fileURLToPath(new URL('.', import.meta.url)),
          sourcefile: 'ordinary-shell-recovery.ts'
        },
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        logLevel: 'silent'
      })
      // Match the disposable Windows recovery controller: Node loads package exports at runtime,
      // rather than Vitest resolving an import-only TypeScript entry on its behalf.
      const output = execFileSync(process.execPath, [bundle], {
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') },
        timeout: 10_000
      })
      expect(JSON.parse(output)).toEqual({ adapter: 'function' })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects copies, serialized capabilities and wrong execution owners', () => {
    const capability = createManagedShellExecutionCapability(input())
    for (const forged of [{}, { ...capability }, JSON.parse(JSON.stringify(capability))]) {
      expect(() => resolveManagedShellExecutionCapability(forged, scope)).toThrow('does not belong')
    }
    for (const key of ['projectId', 'sessionId', 'executionInvocationId'] as const) {
      expect(() =>
        resolveManagedShellExecutionCapability(capability, { ...scope, [key]: 'other' })
      ).toThrow('does not belong')
    }
    expect(() =>
      resolveManagedShellExecutionCapability(
        null as unknown as ManagedShellExecutionCapability,
        scope
      )
    ).toThrow('does not belong')
  })

  it('snapshots mutable input and includes the complete policy in a canonical fingerprint', () => {
    const source = input()
    const capability = createManagedShellExecutionCapability(source)
    const captured = resolveManagedShellExecutionCapability(capability, scope)
    source.environment.PATH = '/unexpected'
    source.filesystem.readWriteRoots.push(elsewhere)
    expect(captured.environment.PATH).toBe('/usr/bin:/bin')
    expect(captured.filesystem.readWriteRoots).toEqual([workspace])
    expect(captured.filesystem.deniedWriteRoots).toContain(inputRoot)
    const reordered = input()
    reordered.filesystem.readOnlyRoots.push(inputRoot)
    expect(
      resolveManagedShellExecutionCapability(
        createManagedShellExecutionCapability(reordered),
        scope
      ).fingerprint
    ).toBe(captured.fingerprint)
    expect(
      resolveManagedShellExecutionCapability(createManagedShellExecutionCapability(source), scope)
        .fingerprint
    ).not.toBe(captured.fingerprint)
    expect(
      resolveManagedShellExecutionCapability(
        createManagedShellExecutionCapability({ ...input(), fingerprint: 'material-v2' }),
        scope
      ).fingerprint
    ).not.toBe(captured.fingerprint)
  })

  it('requires explicit writable cwd and keeps transient service authority out of frozen env', () => {
    expect(() => createManagedShellExecutionCapability({ ...input(), cwd: elsewhere })).toThrow(
      'explicit write root'
    )
    expect(() =>
      createManagedShellExecutionCapability({ ...input(), cwd: `${workspace}${sep}..${sep}work` })
    ).toThrow('normalized absolute')
    for (const key of [
      'OPEN_SCIENCE_SERVICE_SOCKET',
      'OPEN_SCIENCE_SERVICE_PORT',
      'OPEN_SCIENCE_SERVICE_PROOF',
      'OPEN_SCIENCE_SERVICE_PROOF_PATH'
    ]) {
      expect(() =>
        createManagedShellExecutionCapability({ ...input(), environment: { [key]: 'secret' } })
      ).toThrow('execution-owned')
    }
  })

  it('requires an explicit writable output root and binds it to the capability fingerprint', () => {
    expect(() =>
      createManagedShellExecutionCapability({ ...input(), outputRoot: elsewhere })
    ).toThrow('explicit writable root')
    expect(() =>
      createManagedShellExecutionCapability({
        ...input(),
        outputRoot: inputRoot,
        filesystem: { readOnlyRoots: [inputRoot], readWriteRoots: [workspace, inputRoot] }
      })
    ).toThrow('explicit writable root')
    const first = resolveManagedShellExecutionCapability(
      createManagedShellExecutionCapability({ ...input(), outputRoot: join(workspace, 'first') }),
      scope
    )
    const second = resolveManagedShellExecutionCapability(
      createManagedShellExecutionCapability({ ...input(), outputRoot: join(workspace, 'second') }),
      scope
    )
    expect(first.outputRoot).toBe(join(workspace, 'first'))
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })

  it('revokes subsequent resolution with the environment owner lifetime', () => {
    const controller = new AbortController()
    const capability = createManagedShellExecutionCapability({
      ...input(),
      signal: controller.signal
    })
    controller.abort(new Error('environment closed'))
    expect(() => resolveManagedShellExecutionCapability(capability, scope)).toThrow(
      'environment closed'
    )
  })
})

describe('managed confinement and private bindings', () => {
  it('fingerprints only public authority and snapshots private lease data in memory', () => {
    const make = (secret: string): ManagedShellExecutionCapability =>
      createManagedShellExecutionCapability({
        ...input(),
        confinement: { mode: 'research', allowedNetworkHosts: ['api.example.org'] },
        privateEnvironment: { RESEARCH_API_KEY: secret },
        secretValues: [secret]
      })
    const first = resolveManagedShellExecutionCapability(make('first-private-value'), scope)
    const second = resolveManagedShellExecutionCapability(make('second-private-value'), scope)
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.environment).not.toHaveProperty('RESEARCH_API_KEY')
    expect(first.privateEnvironment?.RESEARCH_API_KEY).toBe('first-private-value')
    expect(
      resolveManagedShellExecutionCapability(
        createManagedShellExecutionCapability({
          ...input(),
          confinement: { mode: 'research', allowedNetworkHosts: ['other.example.org'] }
        }),
        scope
      ).fingerprint
    ).not.toBe(first.fingerprint)
    expect(JSON.stringify(make('first-private-value'))).toBe('{}')
  })

  it('rejects offline credentials, wildcard hosts, unknown modes and reserved environment overrides', () => {
    expect(() =>
      createManagedShellExecutionCapability({
        ...input(),
        confinement: { mode: 'offline-demo' },
        privateEnvironment: { API_KEY: 'secret' }
      })
    ).toThrow('cannot receive')
    expect(() =>
      createManagedShellExecutionCapability({
        ...input(),
        confinement: { mode: 'research', allowedNetworkHosts: ['*.example.org'] }
      })
    ).toThrow('exact hostnames')
    expect(() =>
      createManagedShellExecutionCapability({
        ...input(),
        confinement: { mode: 'offline-demo', allowedNetworkHosts: ['api.example.org'] }
      })
    ).toThrow('cannot allow')
    for (const key of [
      'PATH',
      'HOME',
      'NODE_OPTIONS',
      'HTTPS_PROXY',
      'OPEN_SCIENCE_SERVICE_PROOF'
    ]) {
      expect(() =>
        createManagedShellExecutionCapability({
          ...input(),
          privateEnvironment: { [key]: 'value' }
        })
      ).toThrow('private managed')
    }
  })
})
