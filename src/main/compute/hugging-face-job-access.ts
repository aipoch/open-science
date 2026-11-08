import { computeAccounts } from './compute-account-service'
import { z } from 'zod'

const hub = 'https://huggingface.co'
const account = z.object({ id: z.string().min(1), name: z.string().min(1) })
const identity = account.extend({
  orgs: z.array(account).optional(),
  auth: z.object({ accessToken: z.object({ role: z.string().optional() }).optional() }).optional()
})

async function readHub(
  path: string,
  signal: AbortSignal | undefined,
  token?: string
): Promise<unknown> {
  const deadline = AbortSignal.timeout(15_000)
  const response = await fetch(hub + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : undefined,
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Hugging Face preflight failed (HTTP ${response.status}).`)
  }
  return response.json()
}

export async function resolveHuggingFaceJobIdentity(
  namespace: string,
  signal?: AbortSignal
): Promise<{ token: string; account: string; readOnly: boolean }> {
  if (!/^[\w-]+$/.test(namespace)) throw new Error('Invalid Hugging Face payer namespace.')
  const token = await computeAccounts.hfToken(signal)
  const who = identity.parse(await readHub('/api/whoami-v2', signal, token))
  const payer = [who, ...(who.orgs ?? [])].find((entry) => entry.name === namespace)
  if (!payer)
    throw new Error('The Hugging Face account does not own or belong to the selected namespace.')
  // Stable across token refresh, different when either the principal or the payer is replaced.
  return {
    token,
    account: JSON.stringify([who.id, payer.id]),
    readOnly: who.auth?.accessToken?.role === 'read'
  }
}

export async function getHuggingFaceJobAccess(
  target: { namespace: string; flavor: string; bucket: string },
  signal?: AbortSignal
): Promise<{ token: string; account: string; rateMicroUsdPerMinute: number }> {
  const { namespace, flavor, bucket } = target
  if (
    !/^[\w-]+\/[\w.-]+$/.test(bucket) ||
    bucket.split('/')[0] !== namespace ||
    ['.', '..'].includes(bucket.split('/')[1])
  )
    throw new Error('Choose a private Hugging Face Bucket in the paying namespace.')
  const access = await resolveHuggingFaceJobIdentity(namespace, signal)
  if (access.readOnly) throw new Error('The Hugging Face token is read-only.')
  const [info, catalog] = await Promise.all([
    readHub('/api/buckets/' + bucket, signal, access.token),
    readHub('/api/jobs/hardware', signal)
  ])
  const verified = z.object({ id: z.literal(bucket), private: z.literal(true) }).safeParse(info)
  if (!verified.success) throw new Error('A verified private Hugging Face Bucket is required.')
  const hardware = z.array(z.object({ name: z.string() }).passthrough()).parse(catalog)
  const price = z
    .object({ unitLabel: z.literal('minute'), unitCostMicroUSD: z.number().int().nonnegative() })
    .safeParse(hardware.find((row) => row.name === flavor))
  if (!price.success)
    throw new Error('The selected Hugging Face hardware has no verified per-minute price.')
  return {
    account: access.account,
    token: access.token,
    rateMicroUsdPerMinute: price.data.unitCostMicroUSD
  }
}
