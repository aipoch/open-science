/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { types } from 'node:util'

const MAX_SCAN = 262144,
  MAX_BINDING_BYTES = 8 * 1024 * 1024,
  MAX_TYPED_BYTES = 8 * 1024 * 1024,
  MAX_ORDINARY = 65536,
  typedPrototype = Object.getPrototypeOf(Uint8Array.prototype),
  typedByteLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get,
  attributes = (d) =>
    Number(d.writable) | (Number(d.enumerable) << 1) | (Number(d.configurable) << 2)

// A private pixel-only storage contract. This does not itself authorize glyph,
// Source, path, image, clipping or ownership semantics. Callers must also retain
// every frontier object with the unchanged ordinary native-input retainer.
export function compactNativePixelArrayBindings(roots) {
  if (!Array.isArray(roots)) return
  const seen = new Set(),
    queued = new Set(),
    pending = [],
    arrays = [],
    typedViews = [],
    frontier = [],
    frontierMembers = new Set(),
    strings = new Set()
  let bindingBytes = 64,
    originalTypedBytes = 0,
    slotCount = 0,
    ordinaryCount = 0
  const enqueue = (value) => {
    if (!value || typeof value !== 'object' || queued.has(value)) return true
    if (queued.size >= MAX_SCAN) return false
    queued.add(value)
    pending.push(value)
    return true
  }
  if (!roots.every(enqueue)) return
  while (pending.length) {
    const value = pending.pop()
    if (seen.has(value)) continue
    if (types.isProxy(value)) return
    seen.add(value)
    if (ArrayBuffer.isView(value)) {
      // The existing ordinary retainer owns the actual typed hash, buffer,
      // view, prototype and property binding. No duplicate typed snapshot is
      // introduced here; charge each original view's bytes independently.
      if (
        ![
          Int8Array,
          Uint8Array,
          Uint8ClampedArray,
          Int16Array,
          Uint16Array,
          Int32Array,
          Uint32Array,
          Float32Array,
          Float64Array
        ].some((type) => Object.getPrototypeOf(value) === type.prototype)
      )
        return
      originalTypedBytes += typedByteLength.call(value)
      if (originalTypedBytes > MAX_TYPED_BYTES || ++ordinaryCount > MAX_ORDINARY) return
      const keys = Reflect.ownKeys(value)
      if (keys.some((key, i) => key !== String(i))) return
      typedViews.push(value)
      bindingBytes += 12
      if (bindingBytes > MAX_BINDING_BYTES) return
      continue
    }
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))) return
    const length = descriptors.length?.value,
      compact =
        Array.isArray(value) &&
        Object.getPrototypeOf(value) === Array.prototype &&
        Number.isInteger(length) &&
        length >= 0 &&
        length <= 8 &&
        keys.length === length + 1 &&
        keys[length] === 'length' &&
        keys.slice(0, length).every((key, index) => {
          const slot = descriptors[key].value
          return (
            key === String(index) &&
            (slot === null ||
              typeof slot === 'object' ||
              typeof slot === 'string' ||
              typeof slot === 'boolean' ||
              typeof slot === 'undefined' ||
              (typeof slot === 'number' && Number.isFinite(slot)))
          )
        })
    if (compact) {
      // Original array reference + membership reference + packed offset,
      // length/length flags; every slot keeps its exact scalar/reference and
      // descriptor flags. String contents are immutable and charged once.
      bindingBytes += 22 + length * 9
      slotCount += length
      arrays.push(value)
      for (let i = 0; i < length; i++) {
        const slot = descriptors[i].value
        if (typeof slot === 'string' && !strings.has(slot)) {
          strings.add(slot)
          bindingBytes += slot.length * 2
        }
        if (slot && typeof slot === 'object' && !frontierMembers.has(slot)) {
          frontierMembers.add(slot)
          frontier.push(slot)
          bindingBytes += 8
        }
      }
      if (bindingBytes > MAX_BINDING_BYTES) return
    } else if (++ordinaryCount > MAX_ORDINARY) return
    for (const key of keys) if (!enqueue(descriptors[key].value)) return
  }
  const members = new Set(arrays),
    offsets = new Uint32Array(arrays.length),
    lengths = new Uint8Array(arrays.length),
    lengthFlags = new Uint8Array(arrays.length),
    typedLengths = new Uint32Array(typedViews.map((value) => Reflect.ownKeys(value).length)),
    values = new Array(slotCount),
    flags = new Uint8Array(slotCount)
  let offset = 0
  for (let i = 0; i < arrays.length; i++) {
    const descriptors = Object.getOwnPropertyDescriptors(arrays[i]),
      length = descriptors.length.value
    offsets[i] = offset
    lengths[i] = length
    lengthFlags[i] = attributes(descriptors.length)
    for (let j = 0; j < length; j++, offset++) {
      values[offset] = descriptors[j].value
      flags[offset] = attributes(descriptors[j])
    }
  }
  return {
    // Include actual child roots even when an ordinary retainer skips their
    // compact parent. Cycles and aliases preserve identity without pruning.
    frontier: Object.freeze(frontier),
    stats: Object.freeze({
      scannedObjects: seen.size,
      compactArrays: arrays.length,
      compactSlots: slotCount,
      noncompactObjects: ordinaryCount,
      bindingBytes,
      originalTypedBytes,
      newTypedHashIdentityBytes: 0,
      newTypedOwnKeyBindingBytes: typedViews.length * 12,
      ordinaryDescriptorStorageIncluded: false
    }),
    contains: (value) => members.has(value),
    current: () =>
      typedViews.every((value, i) => {
        const keys = Reflect.ownKeys(value)
        return keys.length === typedLengths[i] && keys.every((key, index) => key === String(index))
      }) &&
      arrays.every((value, i) => {
        if (Object.getPrototypeOf(value) !== Array.prototype) return false
        const keys = Reflect.ownKeys(value),
          length = lengths[i],
          descriptor = Object.getOwnPropertyDescriptor(value, 'length')
        if (
          keys.length !== length + 1 ||
          keys[length] !== 'length' ||
          !descriptor ||
          !Object.hasOwn(descriptor, 'value') ||
          descriptor.value !== length ||
          attributes(descriptor) !== lengthFlags[i]
        )
          return false
        for (let j = 0; j < length; j++) {
          const d = Object.getOwnPropertyDescriptor(value, String(j)),
            index = offsets[i] + j
          if (
            keys[j] !== String(j) ||
            !d ||
            !Object.hasOwn(d, 'value') ||
            !Object.is(d.value, values[index]) ||
            attributes(d) !== flags[index]
          )
            return false
        }
        return true
      })
  }
}
