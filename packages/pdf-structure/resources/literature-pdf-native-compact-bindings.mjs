/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { types } from 'node:util'

// Private pixel evidence only. The ordinary Source retainer keeps its existing
// object cap. Compact tuples still bind every original object and descriptor;
// Float64 storage preserves exact coordinates, including negative zero.
export function compactNativePixelTupleBindings(roots) {
  const seen = new Set(),
    queued = new Set(roots),
    tuples = new Map(),
    typedBindings = new Map(),
    pending = [...roots]
  let bytes = 0,
    scalarCount = 0
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    if (types.isProxy(value) || seen.size >= 262144) return
    seen.add(value)
    if (ArrayBuffer.isView(value)) {
      const keys = Reflect.ownKeys(value)
      if (keys.some((key, index) => key !== String(index))) return
      bytes += 12
      if (bytes > 8 * 1024 * 1024) return
      typedBindings.set(value, keys.length)
      continue
    }
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))) return
    const length = descriptors.length?.value,
      tuple =
        Array.isArray(value) &&
        Object.getPrototypeOf(value) === Array.prototype &&
        Number.isInteger(length) &&
        length >= 0 &&
        length <= 8 &&
        keys.length === length + 1 &&
        keys[length] === 'length' &&
        keys
          .slice(0, length)
          .every((key, index) => key === String(index) && Number.isFinite(descriptors[key].value))
    if (tuple) {
      // One original-object key and one packed offset/length/flags value.
      // The 20-bit scalar offset, four length bits and three flag bits fit
      // exactly in a Uint32; no second membership/reference array is kept.
      bytes += 12 + length * 9
      const d = descriptors.length,
        flags = Number(d.writable) | (Number(d.enumerable) << 1) | (Number(d.configurable) << 2)
      tuples.set(value, scalarCount * 128 + length * 8 + flags)
      scalarCount += length
      if (bytes > 8 * 1024 * 1024 || scalarCount > 524288) return
    } else {
      // Bound queue growth as well as unique-object visits. Aliases are kept by
      // the ordinary parent descriptor bindings, so enqueue each object once.
      for (const key of keys) {
        const child = descriptors[key].value
        if (child && typeof child === 'object' && !queued.has(child)) {
          queued.add(child)
          if (queued.size > 262144) return
          pending.push(child)
        }
      }
    }
  }
  const values = new Float64Array(scalarCount),
    flags = new Uint8Array(scalarCount)
  const attributes = (d) =>
    Number(d.writable) | (Number(d.enumerable) << 1) | (Number(d.configurable) << 2)
  for (const [value, packed] of tuples) {
    const d = Object.getOwnPropertyDescriptors(value),
      length = (packed >>> 3) & 15
    let offset = packed >>> 7
    for (let j = 0; j < length; j++, offset++) {
      values[offset] = d[j].value
      flags[offset] = attributes(d[j])
    }
  }
  return {
    contains: (value) => tuples.has(value),
    current: () => {
      for (const [value, count] of typedBindings) {
        const keys = Reflect.ownKeys(value)
        if (keys.length !== count || !keys.every((key, index) => key === String(index)))
          return false
      }
      for (const [value, packed] of tuples) {
        if (types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
        const keys = Reflect.ownKeys(value),
          length = (packed >>> 3) & 15,
          d = Object.getOwnPropertyDescriptor(value, 'length')
        if (
          keys.length !== length + 1 ||
          keys[length] !== 'length' ||
          !d ||
          d.value !== length ||
          attributes(d) !== (packed & 7)
        )
          return false
        for (let j = 0; j < length; j++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(j)),
            index = (packed >>> 7) + j
          if (
            keys[j] !== String(j) ||
            !descriptor ||
            !Object.hasOwn(descriptor, 'value') ||
            !Object.is(descriptor.value, values[index]) ||
            attributes(descriptor) !== flags[index]
          )
            return false
        }
      }
      return true
    }
  }
}
