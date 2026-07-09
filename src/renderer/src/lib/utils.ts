import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))

// Formats a byte count as a compact human-readable size (B/KB/MB), or undefined when unknown.
export const formatByteSize = (size: number | undefined): string | undefined => {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined
  if (size < 1024) return `${size} B`

  const kilobytes = size / 1024

  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`

  return `${(kilobytes / 1024).toFixed(1)} MB`
}
