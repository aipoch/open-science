type LimitedText = { text: string; truncated: boolean }
export const limitUtf8 = (value: string, limitBytes: number): LimitedText => {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= limitBytes) return { text: value, truncated: false }
  if (limitBytes <= 0) return { text: '', truncated: value.length > 0 }

  let end = Math.min(limitBytes, encoded.byteLength)
  while (end > 0 && end < encoded.byteLength && (encoded[end] & 0xc0) === 0x80) end -= 1
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true }
}
