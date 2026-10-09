import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const authorityBrand = Symbol('managed-output-authority')
export type ManagedOutputAuthority = Readonly<{ [authorityBrand]: true }>
type Scope = Readonly<{ projectId: string; sessionId: string; operationId: string }>
type Grant = Scope & { outputRoot: string; controller: AbortController; signal: AbortSignal }
const grants = new WeakMap<ManagedOutputAuthority, Grant>()

/** Main only: an environment owner mints this capability for its live execution lease. */
export function createManagedOutputAuthority(
  input: Scope & { outputRoot: string; signal?: AbortSignal }
): ManagedOutputAuthority {
  if (!isAbsolute(input.outputRoot)) throw new Error('Managed output root must be absolute.')
  const controller = new AbortController()
  const authority: ManagedOutputAuthority = Object.freeze({ [authorityBrand]: true })
  grants.set(authority, {
    ...input,
    outputRoot: resolve(input.outputRoot),
    controller,
    signal: input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal
  })
  return authority
}

export function revokeManagedOutputAuthority(authority: ManagedOutputAuthority): void {
  grants.get(authority)?.controller.abort(new Error('Managed output lease has ended.'))
}

/** Bytes still pass through Artifact's normal source observation and import validation. */
export async function resolveManagedOutputAuthority(
  authority: ManagedOutputAuthority,
  scope: Scope,
  path: string
): Promise<{ path: string; root: string; signal: AbortSignal }> {
  const grant = grants.get(authority)
  if (
    !grant ||
    grant.projectId !== scope.projectId ||
    grant.sessionId !== scope.sessionId ||
    grant.operationId !== scope.operationId
  )
    throw new Error('Managed output authority does not belong to this operation.')
  grant.signal.throwIfAborted()
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  )
    throw new Error('Managed output must use a relative file path.')
  const rootInfo = await lstat(grant.outputRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Managed output root is not a regular directory.')
  const root = await realpath(grant.outputRoot)
  if (root !== grant.outputRoot) throw new Error('Managed output root must be canonical.')
  let file = root
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    file = join(file, part)
    const info = await lstat(file)
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
      throw new Error('Managed output must contain only ordinary directories and files.')
    if (index === parts.length - 1 && info.nlink !== 1)
      throw new Error('Managed output must not be a hard link.')
  }
  const actual = await realpath(file)
  const within = relative(root, actual)
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error('Managed output escapes its leased root.')
  grant.signal.throwIfAborted()
  return { path: actual, root, signal: grant.signal }
}
