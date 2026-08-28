import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const productionComputeSources = (): Array<{ path: string; source: string }> =>
  readdirSync(resolve(root, 'src/main/compute'), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.integration.ts')
    )
    .map((entry) => ({
      path: `src/main/compute/${entry.name}`,
      source: read(`src/main/compute/${entry.name}`)
    }))

describe('Compute password authentication release guards', () => {
  it('keeps public Host projections and settings free of credential material', () => {
    const sharedContract = read('src/shared/compute.ts')
    const hostProjection = sharedContract.slice(
      sharedContract.indexOf('export type ComputeHost ='),
      sharedContract.indexOf('export type CreateComputeHostRequest')
    )
    expect(hostProjection).not.toMatch(/password|ciphertext|credentialRef|secret/i)
    expect(read('src/shared/settings.ts')).not.toMatch(/compute[^\n]*(password|ciphertext)/i)
  })

  it('stores only OS-protected ciphertext in the main-owned credential relation', () => {
    const schema = read('prisma/schema.prisma')
    const credential = schema.slice(
      schema.indexOf('model ComputeCredential'),
      schema.indexOf('model ComputeAuthOperation')
    )
    expect(credential).toContain('ciphertext')
    expect(credential).toContain('Bytes')
    expect(credential).not.toMatch(/password\s+/i)
    expect(read('src/main/compute/credential-vault.ts')).toContain('safeStorage')
    expect(read('src/main/compute/credential-vault.ts')).not.toContain(
      'safeStorage.setUsePlainTextEncryption'
    )
    const createPersistence = read('src/main/compute/repository.ts').slice(
      read('src/main/compute/repository.ts').indexOf('async createPasswordHost('),
      read('src/main/compute/repository.ts').indexOf('async getCredential(')
    )
    expect(createPersistence).toContain('client.$transaction')
    expect(createPersistence).toContain('credential: { create:')
    expect(createPersistence).toContain('transaction.computeAuthOperation.create')
  })

  it('keeps password authentication isolated from keys, agents, proxies, and connection reuse', () => {
    const adapter = read('src/main/compute/connection-adapters.ts')
    for (const policy of [
      'StrictHostKeyChecking=yes',
      'NumberOfPasswordPrompts=1',
      'ControlMaster=no',
      'ProxyCommand=none',
      'IdentitiesOnly=yes',
      'IdentityFile=/dev/null',
      'IdentityAgent=none',
      'ForwardAgent=no',
      'PubkeyAuthentication=no',
      'KbdInteractiveAuthentication=no'
    ]) {
      expect(adapter, policy).toContain(`'${policy}'`)
    }
    expect(adapter).not.toContain('PASSWORD: password')
    expect(read('resources/compute-askpass.sh')).not.toMatch(/\$PASSWORD|%PASSWORD%/)
    expect(read('resources/compute-askpass-win.cjs')).not.toMatch(/\$PASSWORD|%PASSWORD%/)
  })

  it('ships the constrained askpass helper outside the archive', () => {
    expect(read('electron-builder.yml')).toContain('- resources/**')
    expect(read('resources/compute-askpass.cjs')).toContain('OPEN_SCIENCE_ASKPASS_CAPABILITY')
    expect(read('resources/compute-askpass-win.cjs')).toContain('OPEN_SCIENCE_ASKPASS_CAPABILITY')
  })

  it('routes the complete Compute Job lifecycle through the connection Broker', () => {
    for (const path of [
      'src/main/compute/job-dispatcher.ts',
      'src/main/compute/job-poller.ts',
      'src/main/compute/harvest-engine.ts',
      'src/main/compute/job-deletion-owner.ts'
    ]) {
      const source = read(path)
      expect(source, path).toContain('ComputeConnectionBroker')
      expect(source, path).not.toMatch(/from ['"]\.\/ssh-runner['"]/)
      expect(source, path).not.toMatch(/from ['"]\.\/scp-runner['"]/)
      expect(source, path).not.toMatch(/resolveSshTarget|SystemSshRunner|SystemScpRunner/)
    }
  })

  it('routes browsing, short commands, and direct downloads through the connection Broker', () => {
    const source = read('src/main/compute/compute-remote-operation-owner.ts')
    expect(source).toContain('ComputeConnectionBroker')
    expect(source).toContain("intent: 'direct_browse'")
    expect(source).toContain("intent: 'direct_command'")
    expect(source).toContain("intent: 'direct_download'")
    expect(source).not.toMatch(/from ['"]\.\/ssh-runner['"]/)
    expect(source).not.toMatch(/resolveSshTarget|SystemSshRunner|SystemScpRunner|runScpTransfer/)
  })

  it('allows transport construction and runtime secret lookup only in the authentication modules', () => {
    const transportConstructionAllowlist = new Set([
      'src/main/compute/authentication-runtime.ts',
      'src/main/compute/connection-adapters.ts',
      'src/main/compute/connection-broker.ts',
      'src/main/compute/ipc.ts',
      'src/main/compute/scp-runner.ts',
      'src/main/compute/ssh-runner.ts'
    ])
    const credentialLookupAllowlist = new Set([
      'src/main/compute/connection-adapters.ts',
      'src/main/compute/credential-vault.ts',
      'src/main/compute/repository.ts'
    ])

    for (const { path, source } of productionComputeSources()) {
      if (!transportConstructionAllowlist.has(path)) {
        expect(source, `${path} constructs a managed SSH/SCP transport`).not.toMatch(
          /\b(?:new\s+System(?:Ssh|Scp)Runner|resolveSshTarget\s*\(|runScp(?:Transfer|Upload)\s*\()/
        )
      }
      if (!credentialLookupAllowlist.has(path)) {
        expect(source, `${path} performs a runtime Compute credential lookup`).not.toMatch(
          /\b(?:safeStorage|decryptString|acquirePasswordLease|getCredential)\s*(?:\.|\()/
        )
      }
    }
  })

  it('keeps every managed remote-operation owner on the Broker seam', () => {
    const owners = {
      'src/main/compute/compute-host-profile-owner.ts': ["intent: 'probe'"],
      'src/main/compute/compute-remote-operation-owner.ts': [
        "intent: 'direct_browse'",
        "intent: 'direct_command'",
        "intent: 'direct_download'"
      ],
      'src/main/compute/job-dispatcher.ts': ["intent: 'job_dispatch'"],
      'src/main/compute/job-poller.ts': ["intent: 'job_poll'"],
      'src/main/compute/harvest-engine.ts': ["intent: 'job_harvest'"],
      'src/main/compute/job-deletion-owner.ts': ["intent: 'job_cleanup'"]
    } as const

    for (const [path, intents] of Object.entries(owners)) {
      const source = read(path)
      expect(source, path).toMatch(/ComputeConnectionBroker/)
      expect(source, path).toMatch(/connectionBroker\.acquire\s*\(/)
      for (const intent of intents) expect(source, `${path}: ${intent}`).toContain(intent)
    }
  })
})
