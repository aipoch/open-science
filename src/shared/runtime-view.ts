import { z } from 'zod'

const projectHeader = z
  .string()
  .regex(/^x-[a-z0-9-]{1,80}$/)
  .refine((value) => !/^x-(?:forwarded|proxy|open-science|os-runtime)/.test(value))
const projectProtocol = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/)
export function isRuntimeViewPath(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value)
    return (
      value.length <= 8192 &&
      value.startsWith('/') &&
      !value.startsWith('//') &&
      ![...value].some(
        (char) => char === '\\' || char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127
      ) &&
      !decoded.startsWith('//') &&
      ![...decoded].some(
        (char) => char === '\\' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    )
  } catch {
    return false
  }
}
const entryPath = z.string().refine(isRuntimeViewPath)

/** Workload declaration only. Main owns destination, proof, parent origins and all credentials. */
export const runtimeViewLaunchSchema = z
  .object({
    title: z.string().trim().min(1).max(256),
    entryPath: entryPath.optional(),
    allowedRequestHeaders: z.array(projectHeader).max(16).optional(),
    webSocketProtocols: z.array(projectProtocol).max(8).optional(),
    adaptFrameAncestors: z.boolean().optional()
  })
  .strict()
export type RuntimeViewLaunch = z.infer<typeof runtimeViewLaunchSchema>

/** A live project page belongs to one actual Run and one owned service generation. */
export interface RuntimeViewScope {
  projectId: string
  sessionId: string
  runId: string
  environmentId: string
  generationId: string
}

export interface RuntimeViewDescriptor {
  viewId: string
  scope: RuntimeViewScope
  title: string
  state: 'ready' | 'closed' | 'failed'
  createdAt: string
  expiresAt: string
  closedReason?: string
  /** Explicit, per-service compatibility change; original Artifact bytes remain untouched. */
  embeddingAdapted: boolean
}

export interface RuntimeViewAccess {
  view: RuntimeViewDescriptor
  /** Ephemeral bootstrap credential. Never persist it in an Artifact, journal or .science file. */
  url: string
}
