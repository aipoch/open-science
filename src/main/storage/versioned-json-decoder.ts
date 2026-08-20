export type VersionedJsonDecodeResult<Value> =
  | Readonly<{ status: 'valid'; version: number; value: Value }>
  | Readonly<{ status: 'legacy'; version?: number; value: Value }>
  | Readonly<{ status: 'unsupported'; version: number }>
  | Readonly<{ status: 'corrupt' }>

export type VersionedJsonDecoder<Value> = Readonly<{
  currentVersion: number
  legacyVersions?: readonly number[]
  readVersion: (value: unknown) => unknown
  decode: (value: unknown) => Value | undefined
  decodeUnversioned?: (value: unknown) => Value | undefined
}>

export const decodeVersionedJson = <Value>(
  serialized: string,
  decoder: VersionedJsonDecoder<Value>
): VersionedJsonDecodeResult<Value> => {
  try {
    const parsed: unknown = JSON.parse(serialized)
    const version = decoder.readVersion(parsed)
    if (version === undefined && decoder.decodeUnversioned) {
      const value = decoder.decodeUnversioned(parsed)
      return value === undefined ? { status: 'corrupt' } : { status: 'legacy', value }
    }
    if (Number.isSafeInteger(version) && Number(version) > decoder.currentVersion) {
      return { status: 'unsupported', version: Number(version) }
    }
    const legacyVersion =
      Number.isSafeInteger(version) && decoder.legacyVersions?.includes(Number(version)) === true
    if (version !== decoder.currentVersion && !legacyVersion) return { status: 'corrupt' }
    const value = decoder.decode(parsed)
    if (value === undefined) return { status: 'corrupt' }
    return legacyVersion
      ? { status: 'legacy', version: Number(version), value }
      : { status: 'valid', version: decoder.currentVersion, value }
  } catch {
    return { status: 'corrupt' }
  }
}
