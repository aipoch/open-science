import { execFile } from 'node:child_process'
import type { KubernetesBackendOptions } from '@aipoch/compute/node'

export type KubernetesJobTarget = KubernetesBackendOptions & { context: string }

async function runKubectl(
  args: string[],
  signal?: AbortSignal,
  body?: string
): Promise<{ ok: boolean; output: string }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile(
      'kubectl',
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        signal,
        timeout: 60_000,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) return reject(signal.reason)
        if (!error) return resolve({ ok: true, output: stdout })
        // Never expose kubeconfig exec-plugin output, which can contain authentication details.
        if (error.killed || typeof error.code !== 'number')
          return reject(new Error('kubectl could not complete the request.'))
        resolve({ ok: false, output: stderr })
      }
    )
    child.stdin?.on('error', () => {
      /* The child exit callback owns request failure. */
    })
    child.stdin?.end(body)
  })
}

/** Resolve public routing information only. kubectl owns authentication, including exec plugins. */
export async function resolveKubernetesJobTarget(
  context: string,
  namespace: string,
  image: string,
  signal?: AbortSignal
): Promise<KubernetesJobTarget> {
  if (!context.trim() || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace) || !image.trim())
    throw new Error('An explicit Kubernetes context, namespace and image are required.')
  const flags = ['--context=' + context, '--namespace=' + namespace]
  const resolveEndpoint = async (signal?: AbortSignal): Promise<string> => {
    const view = await runKubectl(
      [...flags, 'config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}'],
      signal
    )
    if (!view.ok) throw new Error('Kubernetes context could not be resolved.')
    const url = new URL(view.output.trim())
    if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password)
      throw new Error(
        'Kubernetes context requires an HTTPS API endpoint without embedded credentials.'
      )
    return url.href.replace(/\/$/, '')
  }
  const endpoint = await resolveEndpoint(signal)
  return {
    context,
    endpoint,
    namespace,
    image,
    fetch: async (input, init) => {
      const normalized = new URL(input)
      if (normalized.href !== input || normalized.hash || /%2f|%5c/i.test(normalized.pathname))
        throw new Error('Invalid Kubernetes API path.')
      const path = input.startsWith(endpoint + '/') ? input.slice(endpoint.length) : ''
      const base = '/api/v1/namespaces/' + namespace
      if (!(
        path === base ||
        path.startsWith(base + '/') ||
        path.startsWith('/apis/batch/v1/namespaces/' + namespace + '/')
      ))
        throw new Error('Kubernetes request is outside the bound namespace.')
      const method = init?.method ?? 'GET'
      if (!['GET', 'POST', 'DELETE'].includes(method))
        throw new Error('Unsupported Kubernetes request method.')
      if ((await resolveEndpoint(init?.signal ?? undefined)) !== endpoint)
        throw new Error('Kubernetes context endpoint changed after approval.')
      const verb = method === 'POST' ? 'create' : method.toLowerCase()
      const args = [...flags, '--server=' + endpoint, verb, '--raw=' + path]
      if (method !== 'GET') args.push('-f', '-')
      const reply = await runKubectl(
        args,
        init?.signal ?? undefined,
        typeof init?.body === 'string' ? init.body : undefined
      )
      if (reply.ok) return new Response(reply.output)
      const reason =
        /^Error from server \((NotFound|AlreadyExists|Conflict|Forbidden|Unauthorized)\):/m.exec(
          reply.output
        )?.[1]
      const statuses: Record<string, number> = {
        NotFound: 404,
        AlreadyExists: 409,
        Conflict: 409,
        Forbidden: 403,
        Unauthorized: 401
      }
      if (!reason) throw new Error('The Kubernetes API request failed.')
      return Response.json({ message: reason }, { status: statuses[reason] })
    }
  }
}
