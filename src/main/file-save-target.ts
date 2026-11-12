import { lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'

// This snapshot travels only over trusted main/helper/backend channels, never from renderer input.
export const fileSaveTargetSchema = z
  .object({
    path: z.string().min(1).max(32_768).refine(isAbsolute),
    fingerprint: z
      .string()
      .max(256)
      .regex(/^\d+:\d+:\d+:-?\d+:-?\d+$/)
      .nullable()
  })
  .strict()

export type FileSaveTarget = z.infer<typeof fileSaveTargetSchema>
export type FileSaveSelection = { canceled: boolean; filePath?: string; target?: FileSaveTarget }

// Null records an absent target; directories and symlinks must never authorize file replacement.
export async function fileFingerprint(path: string): Promise<string | null> {
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile()) throw new Error('Destination is not a regular file.')
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function snapshotFileTarget(path: string): Promise<FileSaveTarget> {
  return { path: resolve(path), fingerprint: await fileFingerprint(path) }
}

export function destinationChanged(): Error {
  return Object.assign(new Error('The destination changed. Review it and save again.'), {
    code: 'ESTALE'
  })
}

export async function assertFileTarget(path: string, target: FileSaveTarget): Promise<void> {
  // Reuse the reviewed snapshot; taking a fresh one here would authorize a competing write.
  if (resolve(path) !== target.path || (await fileFingerprint(path)) !== target.fingerprint)
    throw destinationChanged()
}

// Moving the captured file can change ctime, but must not change its identity, length or mtime.
export function matchesCapturedTarget(fingerprint: string | null, target: FileSaveTarget): boolean {
  return (
    fingerprint !== null &&
    target.fingerprint !== null &&
    fingerprint.split(':').slice(0, 4).join(':') ===
      target.fingerprint.split(':').slice(0, 4).join(':')
  )
}
