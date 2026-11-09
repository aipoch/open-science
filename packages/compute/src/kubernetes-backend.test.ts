import { describe, expect, it } from 'vitest'
import {
  createKubernetesBackendAdapter,
  parseKubernetesResourceRequest,
  type KubernetesFetch
} from './kubernetes-backend'
import type { ComputeBackendHandle } from './backend'

const target = { providerId: 'k8s:cluster', backendId: 'kubernetes' }

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

describe('kubernetes compute backend', () => {
  it('adopts an ambiguous submission only when the Job carries the saved launch token', async () => {
    const workspace = {
      jobId: 'job-1',
      providerId: target.providerId,
      namespace: 'trial',
      name: 'claim',
      uid: 'claim-uid'
    }
    let launch = 'other-token'
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'trial',
      image: 'worker',
      fetch: async () =>
        jsonResponse({
          metadata: {
            name: 'open-science-job-1',
            uid: 'existing-uid',
            annotations: { 'open-science.io/launch-token': launch }
          }
        })
    })
    await expect(adapter.recoverWorkspaceLaunch(workspace, 'approved-token')).rejects.toThrow(
      'approved launch'
    )
    launch = 'approved-token'
    expect(JSON.parse((await adapter.recoverWorkspaceLaunch(workspace, launch))!.value).uid).toBe(
      'existing-uid'
    )
  })

  it('submits a bounded Job manifest and keeps the provider handle opaque', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch: KubernetesFetch = async (url, init) => {
      requests.push({ url, init })
      return jsonResponse({ metadata: { name: 'open-science-job-1', uid: 'uid-1' } })
    }
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example/',
      namespace: 'science',
      image: 'python:3.12',
      fetch
    })

    const handle = await adapter.submit({
      jobId: 'job-1',
      target,
      command: 'python -c "print(1)"',
      workspaceCwd: '/workspace',
      timeoutSeconds: 120,
      resourceRequest: JSON.stringify({ cpus: 4, memory_mib: 8192, gpus: 1 })
    })

    expect(handle).toMatchObject({ backendId: 'kubernetes', providerId: target.providerId })
    expect(JSON.parse(handle.value)).toEqual({
      namespace: 'science',
      name: 'open-science-job-1',
      uid: 'uid-1'
    })
    expect(requests[0]?.url).toBe('https://cluster.example/apis/batch/v1/namespaces/science/jobs')
    const body = JSON.parse(String(requests[0]?.init?.body))
    expect(body.spec.backoffLimit).toBe(0)
    expect(body.spec.activeDeadlineSeconds).toBe(120)
    expect(body.spec.template.metadata.labels['open-science-job']).toBe('open-science-job-1')
    expect(body.spec.template.spec.containers[0]).toMatchObject({
      image: 'python:3.12',
      workingDir: '/workspace',
      resources: {
        requests: { cpu: '4', memory: '8192Mi', 'nvidia.com/gpu': '1' },
        limits: { cpu: '4', memory: '8192Mi', 'nvidia.com/gpu': '1' }
      }
    })
  })

  it('preserves injected HeadersInit authentication across request forms', async () => {
    const seen: Headers[] = []
    const fetch: KubernetesFetch = async (_url, init) => {
      seen.push(new Headers(init?.headers))
      return jsonResponse({})
    }
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      headers: new Headers({ Authorization: 'Bearer secret' }),
      fetch
    })

    await adapter.validateTarget(target)

    expect(seen[0]?.get('authorization')).toBe('Bearer secret')
    expect(seen[0]?.get('accept')).toBe('application/json')
  })

  it('refuses to mount a replaced file claim after recovering a reservation', async () => {
    const requests: string[] = []
    let metadata: Record<string, unknown> = {}
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'worker',
      fetch: async (url, init) => {
        requests.push(init?.method ?? 'GET')
        expect(url).toContain('/persistentvolumeclaims')
        if (init?.method === 'POST') {
          metadata = {
            ...JSON.parse(String(init.body)).metadata,
            namespace: 'science',
            uid: 'first'
          }
          return jsonResponse({}, 409)
        }
        return jsonResponse({ metadata })
      }
    })
    const receipt = await adapter.prepareWorkspace('job-1', target, 64)
    metadata.uid = 'replacement'
    await expect(
      adapter.submitInWorkspace({ jobId: 'job-1', target, command: 'true' }, receipt)
    ).rejects.toThrow('replaced')
    expect(requests).toEqual(['POST', 'GET', 'GET'])
  })

  it('rejects managed environments before HTTP submission', async () => {
    const fetch: KubernetesFetch = async () => {
      throw new Error('HTTP should not be called')
    }
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      fetch
    })

    await expect(
      adapter.submit({
        jobId: 'job-1',
        target,
        command: 'echo ready',
        environment: 'python-3.12'
      })
    ).rejects.toThrow('managed environments')
  })

  it('rejects malformed or unsupported resource requests before HTTP submission', () => {
    expect(() => parseKubernetesResourceRequest('{"account":"batch"}')).toThrow('unsupported')
    expect(() => parseKubernetesResourceRequest('{"cpus":0}')).toThrow('positive integer')
    expect(parseKubernetesResourceRequest('{}')).toBeUndefined()
  })

  it('waits for a ready Pod before reporting a running workload', async () => {
    let ready = 0
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      fetch: async () => jsonResponse({ metadata: { uid: 'uid-1' }, status: { active: 1, ready } })
    })
    await expect(adapter.observe(makeHandle())).resolves.toMatchObject({ phase: 'starting' })
    ready = 1
    await expect(adapter.observe(makeHandle())).resolves.toMatchObject({ phase: 'running' })
  })

  it.each(['controller-uid', 'batch.kubernetes.io/controller-uid'])(
    'checks owned, live Ready Pods with %s when Job.ready is absent',
    async (label) => {
      const owned = { ownerReferences: [{ kind: 'Job', uid: 'uid-1', controller: true }] }
      const ready = { conditions: [{ type: 'Ready', status: 'True' }] }
      const pods = [
        {
          metadata: { ownerReferences: [{ kind: 'Job', uid: 'other', controller: true }] },
          status: ready
        },
        { metadata: { ...owned, deletionTimestamp: '2026-01-01T00:00:00Z' }, status: ready },
        { metadata: owned, status: { conditions: [{ type: 'Ready', status: 'False' }] } }
      ]
      const adapter = createKubernetesBackendAdapter({
        endpoint: 'https://cluster.example',
        namespace: 'science',
        image: 'worker',
        fetch: async (url) => {
          const path = new URL(url)
          if (path.pathname.endsWith('/pods')) {
            expect(path.searchParams.get('labelSelector')).toBe(label + '=uid-1')
            return jsonResponse({ items: pods })
          }
          return jsonResponse({
            metadata: { uid: 'uid-1' },
            spec: { selector: { matchLabels: { [label]: 'uid-1' } } },
            status: { active: 1 }
          })
        }
      })
      await expect(adapter.observe(makeHandle())).resolves.toMatchObject({
        phase: 'starting',
        contact: 'live'
      })
      pods.push({ metadata: owned, status: ready })
      await expect(adapter.observe(makeHandle())).resolves.toMatchObject({
        phase: 'running',
        contact: 'live'
      })
    }
  )

  it('maps Job conditions and authentication failures to provider observations', async () => {
    const responses = [
      jsonResponse({
        metadata: { name: 'job-1', uid: 'uid-1' },
        status: { conditions: [{ type: 'Complete', status: 'True' }] }
      }),
      jsonResponse({ message: 'forbidden' }, 403)
    ]
    const fetch: KubernetesFetch = async () => responses.shift()!
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      fetch
    })
    const handle = {
      backendId: 'kubernetes',
      providerId: target.providerId,
      value: JSON.stringify({ namespace: 'science', name: 'job-1', uid: 'uid-1' })
    }

    await expect(adapter.observe(handle)).resolves.toEqual({
      phase: 'succeeded',
      contact: 'live',
      exitCode: 0
    })
    await expect(adapter.validateTarget(target)).resolves.toMatchObject({
      valid: false,
      contact: 'needs_auth'
    })
  })

  it('collects bounded pod logs and treats an already deleted Job as cancelled', async () => {
    const responses = [
      jsonResponse({
        items: [
          {
            metadata: {
              name: 'foreign',
              ownerReferences: [{ kind: 'Job', uid: 'foreign', controller: true }]
            }
          }
        ]
      }),
      jsonResponse({
        items: [
          {
            metadata: {
              name: 'pod-1',
              ownerReferences: [{ kind: 'Job', uid: 'uid-1', controller: true }]
            }
          }
        ]
      }),
      new Response('stdout\n'),
      jsonResponse({ message: 'not found' }, 404),
      jsonResponse({ items: [] }),
      jsonResponse({ items: [] })
    ]
    const fetch: KubernetesFetch = async (url, init) => {
      if (new URL(url).pathname.endsWith('/log')) {
        expect(new URL(url).pathname).toBe('/api/v1/namespaces/science/pods/pod-1/log')
        expect(new Headers(init?.headers).get('Accept')).toBe('*/*')
      }
      return responses.shift()!
    }
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      fetch,
      logTailLines: 100
    })
    const handle = {
      backendId: 'kubernetes',
      providerId: target.providerId,
      value: JSON.stringify({ namespace: 'science', name: 'job-1', uid: 'uid-1' })
    }

    await expect(adapter.collectLogs(handle, 'cursor-1')).resolves.toEqual({
      cursor: 'cursor-1',
      stdout: 'stdout\n',
      stderr: '',
      complete: true
    })
    await expect(adapter.cancel(handle)).resolves.toEqual({ outcome: 'confirmed' })
  })
})

const makeHandle = (overrides: Record<string, unknown> = {}): ComputeBackendHandle => ({
  backendId: 'kubernetes',
  providerId: target.providerId,
  value: JSON.stringify({ namespace: 'science', name: 'job-1', uid: 'uid-1', ...overrides })
})

describe('kubernetes recovery boundaries', () => {
  it('keeps missing Jobs recoverable instead of inventing a terminal result', async () => {
    const fetch: KubernetesFetch = async () => jsonResponse({ message: 'not found' }, 404)
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      fetch
    })

    await expect(
      adapter.recover(
        { jobId: 'job-1', target, command: 'echo ready' },
        makeHandle({ uid: 'uid-1' })
      )
    ).resolves.toBeNull()
  })

  it('preserves identity conflicts and reports transport loss as non-terminal contact', async () => {
    const responses = [
      jsonResponse({ metadata: { name: 'job-1', uid: 'different-uid' } }),
      Promise.reject(new Error('connection reset'))
    ]
    const fetch: KubernetesFetch = async () => {
      const response = responses.shift()
      if (response instanceof Promise) return response
      return response!
    }
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      fetch
    })

    await expect(
      adapter.recover(
        { jobId: 'job-1', target, command: 'echo ready' },
        makeHandle({ uid: 'uid-1' })
      )
    ).rejects.toThrow('identity no longer matches')
    await expect(adapter.observe(makeHandle({ uid: 'uid-1' }))).resolves.toMatchObject({
      phase: 'starting',
      contact: 'unreachable'
    })
  })

  it('fences deletion by UID and distinguishes acceptance from completion', async () => {
    const seen: RequestInit[] = []
    const responses = [
      jsonResponse({}, 409),
      jsonResponse({}, 202),
      jsonResponse({}, 404),
      jsonResponse({ items: [] }),
      jsonResponse({ items: [{}] })
    ]
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      fetch: async (url, init) => {
        seen.push(init!)
        if (seen.length === 4)
          expect(new URL(url).searchParams.get('labelSelector')).toBe(
            'batch.kubernetes.io/controller-uid=uid-1'
          )
        if (seen.length === 5)
          expect(new URL(url).searchParams.get('labelSelector')).toBe('controller-uid=uid-1')
        return responses.shift()!
      }
    })
    await expect(adapter.cancel(makeHandle({ uid: undefined }))).resolves.toMatchObject({
      outcome: 'unknown'
    })
    expect(seen).toHaveLength(0)
    await expect(adapter.cleanup(makeHandle())).resolves.toMatchObject({ outcome: 'unknown' })
    expect(JSON.parse(String(seen[0].body))).toMatchObject({
      preconditions: { uid: 'uid-1' },
      propagationPolicy: 'Foreground'
    })
    await expect(adapter.cancel(makeHandle())).resolves.toEqual({ outcome: 'requested' })
    await expect(adapter.cancel(makeHandle())).resolves.toMatchObject({ outcome: 'unknown' })
  })

  it('returns unknown cancellation when the provider cannot confirm the request', async () => {
    const fetch: KubernetesFetch = async () => {
      throw new Error('connection reset')
    }
    const adapter = createKubernetesBackendAdapter({
      endpoint: 'https://cluster.example',
      namespace: 'science',
      image: 'python:3.12',
      fetch
    })

    await expect(adapter.cancel(makeHandle())).resolves.toMatchObject({ outcome: 'unknown' })
  })
})
