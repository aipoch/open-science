import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPermissionGrantRegistry,
  type PermissionGrantRegistry
} from '../permission-grants/registry'
import { seedDefaultPermissionGrants } from '../permission-grants/defaults'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AcpPermissionBroker, projectRegistrySessionGrants } from './permission-broker'
import { withTrustedMcpToolIdentity } from './permission-policy'

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const shellRequest = (sessionId: string): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${sessionId}`,
    title: 'Inspect repository status',
    status: 'pending',
    kind: 'execute',
    rawInput: { command: 'git status' }
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-allow-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const retainedSessionCancellationKeys = (owner: object): unknown[] =>
  Object.entries(owner).flatMap(([name, value]) =>
    name.includes('sessionCancellation') && value instanceof Map ? Array.from(value.keys()) : []
  )

const registeredToolRequest = (toolName: string): RequestPermissionRequest => ({
  sessionId: 'session-registered',
  toolCall: {
    toolCallId: `tool-${toolName}`,
    title: toolName,
    status: 'pending',
    _meta: { toolName }
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const titleOnlyRequest = (title: string): RequestPermissionRequest => ({
  sessionId: `session-title-${title}`,
  toolCall: {
    toolCallId: `tool-title-${title}`,
    title,
    status: 'pending'
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const providerBuiltInRequest = (
  sessionId: string,
  toolName: 'WebFetch' | 'WebSearch'
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${sessionId}-${toolName}`,
    title: toolName,
    status: 'pending',
    rawInput:
      toolName === 'WebFetch'
        ? { url: 'https://www.ncbi.nlm.nih.gov/' }
        : { query: 'tumor immunology' },
    _meta: { claudeCode: { toolName } }
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-allow-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const mcpRequest = (
  sessionId: string,
  reportedName: string,
  title = reportedName
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${sessionId}`,
    title,
    status: 'pending',
    _meta: { toolName: reportedName },
    rawInput: {}
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const controlledEmptyGrantRegistry = (): {
  registry: PermissionGrantRegistry
  finishResolve: () => void
} => {
  let finish: (() => void) | undefined
  const registry = {
    resolve: vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined)
        })
    ),
    remember: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    listCached: vi.fn().mockReturnValue([]),
    revoke: vi.fn(),
    extendUndo: vi.fn(),
    restore: vi.fn(),
    prune: vi.fn(),
    finalizeOwnerDeletion: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => undefined)
  } satisfies PermissionGrantRegistry

  return {
    registry,
    finishResolve: () => {
      if (!finish) throw new Error('Grant lookup has not started.')
      finish()
    }
  }
}

describe('ACP permission broker with durable grants', () => {
  it('uses the durable parent Session as the grant owner for delegated provider requests', async () => {
    const registry = {
      resolve: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      listCached: vi.fn().mockReturnValue([]),
      revoke: vi.fn(),
      extendUndo: vi.fn(),
      restore: vi.fn(),
      prune: vi.fn(),
      finalizeOwnerDeletion: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => undefined)
    } as unknown as PermissionGrantRegistry
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    const providerResponse = broker.requestPermission(shellRequest('delegated-provider-session'), {
      profile: 'ask',
      projectId: 'parent-project',
      permissionGrantSessionId: 'parent-session'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(registry.resolve).toHaveBeenCalledWith(expect.anything(), {
      projectId: 'parent-project',
      sessionId: 'parent-session'
    })
    expect(emitted[0].sessionId).toBe('delegated-provider-session')
    const sessionOption = emitted[0].options.find((option) => option.scope === 'session')

    await expect(
      broker.respond({ requestId: emitted[0].requestId, optionId: sessionOption?.optionId })
    ).resolves.toBe(true)
    await expect(providerResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    expect(registry.remember).toHaveBeenCalledWith({
      capability: expect.anything(),
      scope: {
        kind: 'session',
        projectId: 'parent-project',
        sessionId: 'parent-session'
      }
    })
  })
  it.each([
    ['session', { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }],
    ['project', { kind: 'project', projectId: 'project-1' }],
    ['global', { kind: 'global' }]
  ] as const)(
    'commits a restored %s selection through the durable grant registry',
    async (scope, expectedScope) => {
      const registry = {
        resolve: vi.fn().mockResolvedValue(undefined),
        remember: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        listCached: vi.fn().mockReturnValue([]),
        revoke: vi.fn(),
        extendUndo: vi.fn(),
        restore: vi.fn(),
        prune: vi.fn(),
        finalizeOwnerDeletion: vi.fn(),
        subscribe: vi.fn().mockReturnValue(() => undefined)
      } satisfies PermissionGrantRegistry
      const broker = new AcpPermissionBroker(() => undefined, undefined, registry)
      const option = {
        optionId: `allow-${scope}`,
        name: `Allow for ${scope}`,
        kind: 'allow_always',
        scope
      } as const

      await broker.prepareRestoredDecision(
        {
          state: 'pending',
          request: {
            requestId: 'permission-1',
            sessionId: 'session-1',
            toolCallId: 'tool-1',
            title: 'Inspect repository status',
            options: [option]
          },
          originatingPromptMessageId: 'prompt-1',
          fingerprint: 'a'.repeat(64),
          capability: { kind: 'execution', key: 'shell:git-status' },
          createdAt: 1
        },
        option,
        'project-1'
      )

      expect(registry.remember).toHaveBeenCalledWith({
        capability: { kind: 'execution', key: 'shell:git-status' },
        scope: expectedScope
      })
    }
  )

  it('releases cleared Session cancellation state after a durable grant lookup settles', async () => {
    let finishResolve: (() => void) | undefined
    const registry = {
      resolve: vi.fn(
        () =>
          new Promise<undefined>((resolve) => {
            finishResolve = () => resolve(undefined)
          })
      ),
      remember: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listCached: vi.fn().mockReturnValue([]),
      revoke: vi.fn(),
      extendUndo: vi.fn(),
      restore: vi.fn(),
      prune: vi.fn(),
      finalizeOwnerDeletion: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => undefined)
    } satisfies PermissionGrantRegistry
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    const response = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    broker.clearSession('session-1')
    finishResolve?.()

    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(emitted).toEqual([])
    expect(broker.hasPendingForSession('session-1')).toBe(false)
    expect(retainedSessionCancellationKeys(broker)).not.toContain('session-1')
  })

  it('re-evaluates a request when grant lookup crosses a live profile change', async () => {
    const { registry, finishResolve } = controlledEmptyGrantRegistry()
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const response = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    expect(emitted).toEqual([])

    await broker.applyPermissionProfile('session-1', {
      selectedProfile: 'full',
      effectiveProfile: 'full',
      availableModeIds: [],
      fullAccessAvailable: true
    })
    finishResolve()

    await expect(response).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    expect(emitted).toEqual([])
    expect(broker.getPendingRequests()).toEqual([])
  })

  it('does not use a superseded live profile after grant lookup', async () => {
    const { registry, finishResolve } = controlledEmptyGrantRegistry()
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const response = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    let current = true
    await broker.applyPermissionProfile(
      'session-1',
      {
        selectedProfile: 'full',
        effectiveProfile: 'full',
        availableModeIds: [],
        fullAccessAvailable: true
      },
      () => current
    )
    current = false
    finishResolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted).toHaveLength(1)
    expect(broker.getPendingRequests()).toHaveLength(1)
    broker.cancelAllPending()
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('re-evaluates a delayed grant lookup against a provider mode downgrade', async () => {
    const { registry, finishResolve } = controlledEmptyGrantRegistry()
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const response = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })

    broker.setLivePermissionProfile('session-1', {
      selectedProfile: 'full',
      effectiveProfile: 'full',
      availableModeIds: ['default', 'bypassPermissions'],
      currentModeId: 'bypassPermissions',
      fullAccessAvailable: true
    })
    broker.setLivePermissionProfile('session-1', {
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      availableModeIds: ['default', 'bypassPermissions'],
      currentModeId: 'default',
      fullAccessAvailable: true
    })
    finishResolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted).toHaveLength(1)
    expect(broker.getPendingRequests()).toHaveLength(1)
    broker.cancelAllPending()
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('fails closed and reports when a remembered approval cannot be persisted', async () => {
    const registry = {
      resolve: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn().mockRejectedValue(new Error('database locked')),
      list: vi.fn().mockResolvedValue([]),
      listCached: vi.fn().mockReturnValue([]),
      revoke: vi.fn(),
      extendUndo: vi.fn(),
      restore: vi.fn(),
      prune: vi.fn(),
      finalizeOwnerDeletion: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => undefined)
    } satisfies PermissionGrantRegistry
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const providerResponse = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const projectOption = emitted[0].options.find((option) => option.scope === 'project')
    const rendererResponse = broker.respond({
      requestId: emitted[0].requestId,
      optionId: projectOption?.optionId
    })

    await expect(rendererResponse).rejects.toThrow(
      'Permission approval could not be saved; the tool call was cancelled.'
    )
    await expect(providerResponse).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('settles durable Session authority before committing a persistent grant', async () => {
    const journal: string[] = []
    const registry = {
      resolve: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn(async () => {
        journal.push('grant')
        return undefined as never
      }),
      list: vi.fn().mockResolvedValue([]),
      listCached: vi.fn().mockReturnValue([]),
      revoke: vi.fn(),
      extendUndo: vi.fn(),
      restore: vi.fn(),
      prune: vi.fn(),
      finalizeOwnerDeletion: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => undefined)
    } satisfies PermissionGrantRegistry
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker(
      (request) => emitted.push(request),
      undefined,
      registry,
      undefined,
      {
        persist: vi.fn(async () => true),
        settleLive: vi.fn(async () => {
          journal.push('authority')
        })
      }
    )
    const providerResponse = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1',
      promptMessageId: 'prompt-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const projectOption = emitted[0].options.find((option) => option.scope === 'project')
    await broker.respond({
      requestId: emitted[0].requestId,
      optionId: projectOption?.optionId
    })

    expect(journal).toEqual(['authority', 'grant'])
    await expect(providerResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
  })

  it('does not commit a persistent grant when durable Session settlement fails', async () => {
    const registry = {
      resolve: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listCached: vi.fn().mockReturnValue([]),
      revoke: vi.fn(),
      extendUndo: vi.fn(),
      restore: vi.fn(),
      prune: vi.fn(),
      finalizeOwnerDeletion: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => undefined)
    } satisfies PermissionGrantRegistry
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker(
      (request) => emitted.push(request),
      undefined,
      registry,
      undefined,
      {
        persist: vi.fn(async () => true),
        settleLive: vi.fn(async () => {
          throw new Error('Session write failed')
        })
      }
    )
    const providerResponse = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1',
      promptMessageId: 'prompt-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const projectOption = emitted[0].options.find((option) => option.scope === 'project')
    await expect(
      broker.respond({
        requestId: emitted[0].requestId,
        optionId: projectOption?.optionId
      })
    ).rejects.toThrow('Permission approval could not be saved')

    expect(registry.remember).not.toHaveBeenCalled()
    await expect(providerResponse).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('commits a Global grant before returning only the provider one-call decision', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-registry-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    const first = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session',
      'project',
      'global'
    ])
    const globalOption = emitted[0].options.find((option) => option.scope === 'global')
    broker.respond({ requestId: emitted[0].requestId, optionId: globalOption?.optionId })

    await expect(first).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    const [grant] = await registry.list()
    expect(grant).toMatchObject({
      capability: {
        kind: 'execution',
        key: 'exec:agent/shell',
        qualifier: { mode: 'exact', value: expect.stringMatching(/^sha256:v1:[a-f0-9]{64}$/) }
      },
      scope: { kind: 'global' }
    })
    expect(JSON.stringify(grant)).not.toContain('git status')

    await expect(
      broker.requestPermission(shellRequest('session-2'), {
        profile: 'ask',
        projectId: 'project-1'
      })
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })
    expect(emitted).toHaveLength(1)
  })

  it.each([
    ['posix', 'python upload.py --token secret', ['python', 'upload.py']],
    ['posix', 'curl --auth-token secret https://example.com', ['curl']],
    ['posix', 'curl --bearer secret https://example.com', ['curl']],
    ['posix', 'curl --oauth2-bearer secret https://example.com', ['curl']],
    ['posix', 'curl --cookie session=secret https://example.com', ['curl']],
    ['posix', 'curl -uuser:secret https://example.com', ['curl']],
    ['posix', 'curl -b session=secret https://example.com', ['curl']],
    ['posix', 'curl -bsession=secret https://example.com', ['curl']],
    ['powershell', 'CURL.EXE -bsession=secret https://example.com', ['CURL.EXE']],
    ['posix', 'docker login -p secret', ['docker', 'login']],
    ['posix', 'docker login -psecret', ['docker', 'login']],
    ['powershell', 'Docker login -psecret', ['Docker', 'login']],
    ['posix', 'sshpass -psecret ssh user@example.com', ['sshpass']],
    ['posix', 'redis-cli -asecret ping', ['redis-cli']],
    ['posix', 'mysql -psecret app', ['mysql']],
    ['posix', 'mysqldump -psecret app', ['mysqldump']],
    ['posix', 'npm config set //registry.npmjs.org/:_authToken=secret', ['npm', 'config', 'set']],
    ['posix', 'aws configure set aws_secret_access_key secret', ['aws', 'configure', 'set']],
    ['posix', 'gpg --passphrase secret --decrypt payload.gpg', ['gpg']],
    ['posix', 'gpg --passphrase-file=credentials.txt --decrypt payload.gpg', ['gpg']],
    [
      'posix',
      'gcloud auth activate-service-account --key-file credentials.json',
      ['gcloud', 'auth', 'activate-service-account']
    ],
    ['posix', 'oauth login --client-secret secret', ['oauth', 'login']],
    ['posix', 'deploy --github-token secret', ['deploy']],
    ['posix', 'deploy --client_secret=secret', ['deploy']],
    ['posix', 'deploy --x-api-key secret', ['deploy']],
    ['posix', 'deploy --aws-secret-access-key secret', ['deploy']],
    ['posix', 'deploy --credentials credentials.json', ['deploy']],
    ['powershell', 'Invoke-RestMethod -Credential secret', ['Invoke-RestMethod']],
    ['powershell', 'Invoke-RestMethod -ClientSecret:secret', ['Invoke-RestMethod']]
  ] as const)(
    'offers only provider Once for a credential-bearing Codex %s command group: %s',
    async (shellDialect, command, commandPrefix) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-secret-'))
      client = createProjectDbClient(storageRoot)
      await migrateApplicationDatabase(client)
      await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
      const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
      const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
      const broker = new AcpPermissionBroker(
        (request) => emitted.push(request),
        undefined,
        registry
      )
      const request = shellRequest('session-1')
      request.toolCall.rawInput = { command }
      request.options.splice(2, 0, {
        optionId: 'accept_execpolicy_amendment',
        name: `Allow Commands Starting With \`${commandPrefix.join(' ')}\``,
        kind: 'allow_always',
        _meta: {
          codex: {
            execpolicyAmendment: [...commandPrefix]
          }
        }
      })

      const pending = broker.requestPermission(request, {
        profile: 'ask',
        frameworkId: 'codex',
        shellDialect,
        projectId: 'project-1'
      })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
      broker.respond({ requestId: emitted[0].requestId, optionId: 'provider-allow-once' })
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
      })
      await expect(registry.list()).resolves.toEqual([])
    }
  )

  it('offers only provider Once for a command that executes a mutable script', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-mutable-script-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const request = shellRequest('session-1')
    request.toolCall.rawInput = { command: 'python analyze.py --input data.csv' }
    request._meta = {
      codex: { params: { proposedExecpolicyAmendment: ['python', 'analyze.py'] } }
    }

    const pending = broker.requestPermission(request, {
      profile: 'ask',
      frameworkId: 'codex',
      shellDialect: 'posix',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
    broker.respond({ requestId: emitted[0].requestId, optionId: 'provider-allow-once' })
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    await expect(registry.list()).resolves.toEqual([])
  })

  it.each([
    ['posix', 'rm -rf build'],
    ['posix', 'git status && rm -rf build'],
    ['posix', 'git status "$(rm -rf build)"'],
    ['posix', 'git status "`rm -rf build`"'],
    ['posix', 'git status "$API_KEY"'],
    ['posix', 'git status ${ARGUMENTS}'],
    ['posix', 'git status "$?"'],
    ['posix', 'git\u00a0status'],
    ['posix', 'git status\nrm -rf build'],
    ['posix', 'git status\rrm -rf build'],
    ['posix', 'git status "line\nbreak"'],
    ['posix', '"g\\it" status'],
    ['powershell', 'git status (Remove-Item build)'],
    ['powershell', 'git status \\(Remove-Item build)'],
    ['powershell', 'git status "$(Remove-Item build)"'],
    ['powershell', 'git status { Remove-Item build }'],
    ['powershell', 'git status $env:API_KEY'],
    ['powershell', 'git status "${env:API_KEY}"'],
    ['powershell', 'git status @arguments'],
    ['powershell', 'git status\r\nRemove-Item build'],
    ['posix', './g* --version', ['./g*']],
    ['posix', 'g?t status', ['g?t', 'status']],
    ['posix', '[g]it status', ['[g]it', 'status']],
    ['posix', '{git,gh} status', ['{git,gh}', 'status']],
    ['posix', '~/bin/git status', ['~/bin/git', 'status']],
    ['posix', '=git status', ['=git', 'status']],
    ['powershell', '~/bin/git status', ['~/bin/git', 'status']],
    ['powershell', 'Remove-Item *.tmp', ['Remove-Item', '*.tmp']],
    ['powershell', 'Remove-Item file?.tmp', ['Remove-Item', 'file?.tmp']],
    ['powershell', 'Remove-Item [ab].tmp', ['Remove-Item', '[ab].tmp']]
  ] as const)(
    'offers only provider Once when a Codex %s command group does not safely prefix %s',
    async (...args) => {
      const [shellDialect, command] = args
      const proposedPrefix = args.length === 3 ? args[2] : undefined
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-mismatched-command-group-'))
      client = createProjectDbClient(storageRoot)
      await migrateApplicationDatabase(client)
      await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
      const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
      const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
      const broker = new AcpPermissionBroker(
        (request) => emitted.push(request),
        undefined,
        registry
      )
      const request = shellRequest('session-1')
      request.toolCall.rawInput = { command }
      request.options.splice(2, 0, {
        optionId: 'accept_execpolicy_amendment',
        name: `Allow Commands Starting With \`${(proposedPrefix ?? ['git', 'status']).join(' ')}\``,
        kind: 'allow_always',
        _meta: { codex: { execpolicyAmendment: [...(proposedPrefix ?? ['git', 'status'])] } }
      })

      const pending = broker.requestPermission(request, {
        profile: 'ask',
        frameworkId: 'codex',
        shellDialect,
        projectId: 'project-1'
      })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
      expect(emitted[0].commandPrefix).toBeUndefined()
      broker.respond({ requestId: emitted[0].requestId, optionId: 'provider-allow-once' })
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
      })
      await expect(registry.list()).resolves.toEqual([])
    }
  )

  it('offers durable scopes for a Codex-proposed command group', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-codex-command-group-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const request = shellRequest('session-1')
    request.toolCall.rawInput = { command: 'python analyze.py --input data.csv' }
    request.options.splice(2, 0, {
      optionId: 'accept_execpolicy_amendment',
      name: 'Allow Commands Starting With `python analyze.py`',
      kind: 'allow_always',
      _meta: {
        codex: {
          decision: 'acceptWithExecpolicyAmendment',
          execpolicyAmendment: ['python', 'analyze.py']
        }
      }
    })

    const pending = broker.requestPermission(request, {
      profile: 'ask',
      frameworkId: 'codex',
      shellDialect: 'posix',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session',
      'project',
      'global'
    ])
    expect(emitted[0].commandPrefix).toEqual(['python', 'analyze.py'])
    await broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find((option) => option.scope === 'session')?.optionId
    })
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })

    const [grant] = await registry.list()
    expect(grant).toMatchObject({
      capability: {
        kind: 'execution',
        key: 'exec:agent/shell',
        qualifier: {
          mode: 'category',
          value: expect.stringMatching(/^argv-prefix:sha256:v1:[a-f0-9]{64}$/)
        }
      },
      scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
    })
    expect(JSON.stringify(grant)).not.toContain('python')
    expect(JSON.stringify(grant)).not.toContain('analyze.py')

    const nextRequest = shellRequest('session-1')
    nextRequest.toolCall.rawInput = { command: 'python analyze.py --output results.csv' }
    nextRequest.options.splice(2, 0, {
      optionId: 'accept_execpolicy_amendment',
      name: 'Allow Commands Starting With `python analyze.py`',
      kind: 'allow_always'
    })
    nextRequest._meta = {
      codex: { params: { proposedExecpolicyAmendment: ['python', 'analyze.py'] } }
    }

    await expect(
      broker.requestPermission(nextRequest, {
        profile: 'ask',
        frameworkId: 'codex',
        shellDialect: 'posix',
        projectId: 'project-1'
      })
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    expect(emitted).toHaveLength(1)
  })

  it.each(['WebFetch', 'WebSearch'] as const)(
    'keeps provider-native %s Once-only and prompts again on the next call',
    async (toolName) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-built-in-'))
      client = createProjectDbClient(storageRoot)
      await migrateApplicationDatabase(client)
      await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
      const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
      const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
      const broker = new AcpPermissionBroker(
        (request) => emitted.push(request),
        undefined,
        registry
      )
      const context = { profile: 'ask' as const, projectId: 'project-1' }

      const first = broker.requestPermission(
        providerBuiltInRequest('session-built-in', toolName),
        context
      )
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
      await broker.respond({
        requestId: emitted[0].requestId,
        optionId: 'provider-allow-once'
      })
      await expect(first).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
      })

      const second = broker.requestPermission(
        providerBuiltInRequest('session-built-in', toolName),
        context
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(emitted).toHaveLength(2)
      await broker.respond({ requestId: emitted[1].requestId, cancelled: true })
      await expect(second).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      await expect(registry.list()).resolves.toEqual([])
    }
  )

  it.each(['agent_create', 'Skill', 'mcp__open_science_notebook__notebook_execute'])(
    'never creates durable authority from the display-only title %s',
    async (title) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-title-only-'))
      client = createProjectDbClient(storageRoot)
      await migrateApplicationDatabase(client)
      await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
      const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
      const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
      const broker = new AcpPermissionBroker(
        (request) => emitted.push(request),
        undefined,
        registry
      )

      const pending = broker.requestPermission(titleOnlyRequest(title), {
        profile: 'ask',
        projectId: 'project-1',
        mcpServerNames: ['open_science_notebook']
      })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
      broker.respond({
        requestId: emitted[0].requestId,
        optionId: 'provider-allow-once'
      })
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
      })
      await expect(registry.list()).resolves.toEqual([])
    }
  )

  it('routes every registered customization and local executor identity into durable scopes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-registered-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const toolNames = [
      'agent_create',
      'agent_update',
      'skill_publish',
      'skill_edit',
      'agent_attach_skill',
      'agent_detach_skill',
      'agent_attach_connector',
      'agent_detach_connector',
      'local_exec_python',
      'local_exec_bash'
    ]

    for (const toolName of toolNames) {
      const pending = broker.requestPermission(registeredToolRequest(toolName), {
        profile: 'ask',
        projectId: 'project-1'
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      const request = emitted.at(-1)!
      broker.respond({
        requestId: request.requestId,
        optionId: request.options.find((option) => option.scope === 'global')?.optionId
      })
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
      })
    }

    await expect(registry.list()).resolves.toHaveLength(10)
    expect((await registry.list()).map((grant) => grant.capability.key).sort()).toEqual(
      [
        'customize:agent_create',
        'customize:agent_update',
        'customize:skill_publish',
        'customize:skill_edit',
        'customize:agent_attach_skill',
        'customize:agent_detach_skill',
        'customize:agent_attach_connector',
        'customize:agent_detach_connector',
        'exec:local/python',
        'exec:local/bash'
      ].sort()
    )
  })

  it('uses default Global grants without prompting', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-default-grant-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    await seedDefaultPermissionGrants(registry, client)
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    await expect(
      broker.requestPermission(registeredToolRequest('agent_create'), {
        profile: 'ask',
        projectId: 'project-1'
      })
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })
    await expect(
      broker.requestPermission(registeredToolRequest('skill'), {
        profile: 'ask',
        projectId: 'project-1'
      })
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })
    await expect(
      broker.requestPermission(
        mcpRequest('session-literature', 'mcp__open_science_literature__read_document'),
        {
          profile: 'ask',
          projectId: 'project-1',
          mcpServerNames: ['open-science-literature']
        }
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })
    expect(emitted).toEqual([])
  })

  it('reuses one app MCP grant across Claude Code, Codex, OpenCode, and runtime-trusted sparse requests', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-acp-mcp-aliases-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const context = {
      profile: 'ask' as const,
      projectId: 'project-1',
      mcpServerNames: ['open-science-notebook']
    }

    const first = broker.requestPermission(
      mcpRequest('session-claude', 'mcp__open_science_notebook__manage_packages'),
      context
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find((option) => option.scope === 'global')?.optionId
    })
    await expect(first).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })

    for (const [sessionId, reportedName] of [
      ['session-codex', 'mcp.open-science-notebook.manage_packages'],
      ['session-opencode', 'open_science_notebook_manage_packages']
    ] as const) {
      await expect(
        broker.requestPermission(mcpRequest(sessionId, reportedName), context)
      ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })
    }

    await expect(
      broker.requestPermission(
        withTrustedMcpToolIdentity(
          mcpRequest('session-sparse', 'manage_packages', 'Manage packages'),
          'open-science-notebook/manage_packages'
        ),
        context
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })

    expect(emitted).toHaveLength(1)
    await expect(registry.list()).resolves.toEqual([
      expect.objectContaining({
        capability: {
          kind: 'mcp_tool',
          key: 'mcp:open-science-notebook/manage_packages'
        },
        scope: { kind: 'global' }
      })
    ])
  })

  it('offers durable Ask scopes for Plan capabilities without sharing their grants', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-plan-grants-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const context = {
      profile: 'ask' as const,
      projectId: 'project-1',
      mcpServerNames: ['open-science-plan']
    }

    const generate = broker.requestPermission(
      mcpRequest('session-plan', 'mcp__open_science_plan__generate_plan'),
      context
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session',
      'project',
      'global'
    ])
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find((option) => option.scope === 'session')?.optionId
    })
    await expect(generate).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })

    const update = broker.requestPermission(
      mcpRequest('session-plan', 'mcp__open_science_plan__update_step_status'),
      context
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted).toHaveLength(2)
    expect(emitted[1].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session',
      'project',
      'global'
    ])
    broker.respond({ requestId: emitted[1].requestId, optionId: 'provider-allow-once' })
    await expect(update).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })

    await expect(
      broker.requestPermission(
        mcpRequest('session-plan', 'mcp__open_science_plan__generate_plan'),
        context
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })
    expect(emitted).toHaveLength(2)
    await expect(registry.list()).resolves.toEqual([
      expect.objectContaining({
        capability: {
          kind: 'mcp_tool',
          key: 'mcp:open-science-plan/generate_plan'
        },
        scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-plan' }
      })
    ])
  })

  it('uses runtime-trusted identity to align sparse dynamic MCP requests', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-dynamic-mcp-aliases-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const context = {
      profile: 'ask' as const,
      projectId: 'project-1',
      mcpServerNames: ['custom-server']
    }

    const first = broker.requestPermission(
      mcpRequest('session-claude', 'mcp__custom_server__lookup'),
      context
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find((option) => option.scope === 'global')?.optionId
    })
    await first

    const sparseCodex = withTrustedMcpToolIdentity(
      mcpRequest('session-codex', 'lookup', 'Lookup records'),
      'custom-server/lookup'
    )
    await expect(broker.requestPermission(sparseCodex, context)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    await expect(
      broker.requestPermission(mcpRequest('session-opencode', 'custom_server_lookup'), context)
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })

    expect(emitted).toHaveLength(1)
    expect((await registry.list())[0].capability).toEqual({
      kind: 'mcp_tool',
      key: 'mcp:custom-server/lookup'
    })
  })

  it('rejects a trusted MCP identity outside the configured server set', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-mismatched-mcp-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const pending = broker.requestPermission(
      withTrustedMcpToolIdentity(
        mcpRequest('session-mismatch', 'lookup', 'Lookup records'),
        'other-server/lookup'
      ),
      {
        profile: 'ask',
        projectId: 'project-1',
        mcpServerNames: ['custom-server']
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
    broker.respond({ requestId: emitted[0].requestId, optionId: 'provider-allow-once' })
    await pending
    await expect(registry.list()).resolves.toEqual([])
  })

  it('projects and revokes a durable Session grant through the composer seam', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-composer-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    const pending = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find((option) => option.scope === 'session')?.optionId
    })
    await pending

    const [composerGrant] = broker.listGrants('session-1')
    expect(composerGrant).toMatchObject({
      categoryKey: expect.any(String),
      kind: 'shell',
      label: 'Shell · Specific input',
      scope: 'session'
    })
    expect(projectRegistrySessionGrants(await registry.list())).toEqual({
      'session-1': [composerGrant]
    })
    await broker.revokeGrant('session-1', composerGrant.categoryKey)

    expect(broker.listGrants('session-1')).toEqual([])
    await expect(registry.list()).resolves.toEqual([])
  })
})
