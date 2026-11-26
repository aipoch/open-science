import { arch, cpus, hostname, release, type } from 'node:os'

import type { LabDeviceInfo } from '../../shared/lab'

// Best-effort, purely cosmetic device identity for the Lab "my devices" page. The server never uses
// these fields for authentication or quota decisions, so every field is optional: a failing probe
// drops that field instead of failing sign-in.

export type LabDeviceInfoSources = Readonly<{
  hostname?: () => string
  username?: () => string
  platform?: string
  release?: () => string
  arch?: string
  appVersion?: string
  locale?: string
  cpuModel?: () => string | undefined
  timezone?: string
  channel?: string
}>

const CONTROL_CHARACTERS = /\p{Cc}/u

const clean = (
  value: string | undefined,
  maxCharacters: number,
  pattern?: RegExp
): string | undefined => {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > maxCharacters || CONTROL_CHARACTERS.test(trimmed))
    return undefined
  if (pattern && !pattern.test(trimmed)) return undefined
  return trimmed
}

const slug = (value: string | undefined, maxCharacters: number): string | undefined => {
  const cleaned = clean(value, maxCharacters)
  if (!cleaned) return undefined
  const lowered = cleaned.toLowerCase()
  return /^[a-z0-9._-]+$/u.test(lowered) ? lowered : undefined
}

export const collectLabDeviceInfo = (sources: LabDeviceInfoSources = {}): LabDeviceInfo => {
  const read = <T>(probe: (() => T) | undefined): T | undefined => {
    if (!probe) return undefined
    try {
      return probe()
    } catch {
      return undefined
    }
  }

  const cpuModel = read(sources.cpuModel ?? (() => cpus()[0]?.model))
  const info: LabDeviceInfo = {}
  const hostnameValue = clean(read(sources.hostname ?? hostname), 200)
  if (hostnameValue) info.hostname = hostnameValue
  const usernameValue = clean(read(sources.username), 200)
  if (usernameValue) info.os_username = usernameValue
  const platformValue = slug(sources.platform ?? type(), 32)
  if (platformValue) info.platform = platformValue
  const releaseValue = clean(read(sources.release ?? release), 100)
  if (releaseValue) info.os_version = releaseValue
  const archValue = slug(sources.arch ?? arch(), 32)
  if (archValue) info.arch = archValue
  const appVersion = clean(sources.appVersion, 64, /^[A-Za-z0-9._+~-]+$/u)
  if (appVersion) info.app_version = appVersion
  const localeValue = clean(sources.locale, 35, /^[A-Za-z0-9-]+$/u)
  if (localeValue) info.locale = localeValue
  const channel = slug(sources.channel ?? 'stable', 32)
  if (channel) info.client_channel = channel
  const cpu = clean(cpuModel, 100)
  if (cpu) info.cpu_model = cpu
  const timezoneValue = clean(sources.timezone, 64, /^[A-Za-z0-9._+/-]+$/u)
  if (timezoneValue) info.timezone = timezoneValue
  return info
}
