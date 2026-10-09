// Shared by the HTTP and private desktop transports. Keep binary values on the existing
// Web RPC wire format so command owners receive the same arguments on either surface.
export const stringifyRpcJson = (value: unknown): string =>
  JSON.stringify(value ?? null, function (key, child) {
    // Buffer.toJSON runs before the replacer. Inspect the original holder value so
    // disk-backed results use the same binary wire format as worker Uint8Arrays.
    if (Buffer.isBuffer(this[key])) child = this[key]
    if (child instanceof ArrayBuffer || ArrayBuffer.isView(child)) {
      const bytes =
        child instanceof ArrayBuffer
          ? new Uint8Array(child)
          : new Uint8Array(child.buffer, child.byteOffset, child.byteLength)
      return { $binary: Buffer.from(bytes).toString('base64') }
    }
    return child
  })

export const parseRpcJson = (text: string): unknown =>
  JSON.parse(text, (_key, child) => {
    if (child && typeof child === 'object' && typeof child.$binary === 'string') {
      return Uint8Array.from(Buffer.from(child.$binary, 'base64'))
    }
    return child
  })
