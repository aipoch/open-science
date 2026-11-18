import { DurableJsonRecoveryBarrierError } from '@aipoch/durable-files'

export type JournalValue =
  | null
  | boolean
  | number
  | string
  | readonly JournalValue[]
  | { readonly [key: string]: JournalValue }
const MAX_DEPTH = 96
type Measurement = { bytes: number; depth: number }
const sizes = new WeakMap<object, Measurement>()
// Long text belongs to an immutable container, never a global string-keyed cache. The entry
// disappears with its owner; path copies inherit only fields whose values did not change.
const containerStrings = new WeakMap<object, Map<string | number, number>>()
// Schema keys and short enum values recur throughout a history. Keep a fixed-size cache only
// for small strings, never messages, tool output, or an unbounded set of user strings.
const scalarStrings = new Map<string, number>()
const encodedStringBytes = (value: string): number => {
  const cached = scalarStrings.get(value)
  if (cached !== undefined) return cached
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (value.length <= 64 && scalarStrings.size < 256) scalarStrings.set(value, bytes)
  return bytes
}
const encodedChildStringBytes = (owner: object, key: string | number, value: string): number => {
  if (value.length <= 64 || !Object.isFrozen(owner)) return encodedStringBytes(value)
  let fields = containerStrings.get(owner)
  const cached = fields?.get(key)
  if (cached !== undefined) return cached
  const bytes = encodedStringBytes(value)
  if (!fields) {
    fields = new Map()
    containerStrings.set(owner, fields)
  }
  fields.set(key, bytes)
  return bytes
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOwn = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key)

export class SessionJournalCorruptionError extends DurableJsonRecoveryBarrierError {
  constructor(message: string) {
    super(message)
    this.name = 'SessionJournalCorruptionError'
  }
}

const invalid = (message: string): never => {
  throw new SessionJournalCorruptionError(message)
}

// Match JSON's treatment of undefined object fields/array slots. Do not invoke toJSON or
// user-defined getters: callers submit ordinary persistence objects, never arbitrary instances.
export const normalizeJournalValue = (
  value: unknown,
  depth = 0,
  maxDepth = MAX_DEPTH
): JournalValue => {
  if (depth > maxDepth) return invalid('Session journal nesting exceeds its limit.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid('Session journal numbers must be finite.')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      Array.from(value, (item) =>
        normalizeJournalValue(item === undefined ? null : item, depth + 1, maxDepth)
      )
    )
  }
  if (!isObject(value)) return invalid('Session journal contains a non-JSON value.')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    return invalid('Session journal requires ordinary JSON objects.')
  const result: Record<string, JournalValue> = {}
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!hasOwn(descriptor, 'value')) return invalid('Session journal cannot contain accessors.')
    if (descriptor.value === undefined) continue
    Object.defineProperty(result, key, {
      value: normalizeJournalValue(descriptor.value, depth + 1, maxDepth),
      enumerable: true
    })
  }
  return Object.freeze(result)
}

export const freezeJournalValue = (value: JournalValue): JournalValue => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeJournalValue(child)
  return Object.freeze(value)
}

// JSON.parse has already eliminated undefined, accessors, prototypes and aliases. Validate its
// depth/numbers and freeze in place instead of cloning every historical object a second time.
export const freezeParsedJournalValue = (value: unknown, maxDepth = MAX_DEPTH): JournalValue => {
  const freezeParsed = (item: unknown, depth: number): JournalValue => {
    if (depth > maxDepth) return invalid('Session journal nesting exceeds its limit.')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return invalid('Session journal numbers must be finite.')
      return item
    }
    if (!item || typeof item !== 'object')
      return invalid('Session journal contains a non-JSON value.')
    for (const child of Object.values(item)) freezeParsed(child, depth + 1)
    return Object.freeze(item) as JournalValue
  }
  return freezeParsed(value, 0)
}

export const parseJournalValue = (contents: string, maxDepth = MAX_DEPTH): JournalValue =>
  freezeParsedJournalValue(JSON.parse(contents), maxDepth)

// Exact compact JSON byte length, with subtree caches only for immutable values. Replacing a
// message visits new ancestors and that message; stable historical subtrees retain their sizes.
const measureChild = (owner: object, key: string | number, child: JournalValue): Measurement =>
  typeof child === 'string'
    ? { bytes: encodedChildStringBytes(owner, key, child), depth: 0 }
    : measureJournalValue(child)

const measureJournalValue = (value: JournalValue): Measurement => {
  if (typeof value === 'string') return { bytes: encodedStringBytes(value), depth: 0 }
  if (value === null || typeof value !== 'object')
    return { bytes: JSON.stringify(value).length, depth: 0 }
  const cached = sizes.get(value)
  if (cached !== undefined) return cached
  let bytes = 2
  let depth = 0
  const appendChild = (key: string | number, child: JournalValue): void => {
    const measured = measureChild(value, key, child)
    bytes += measured.bytes
    depth = Math.max(depth, measured.depth + 1)
  }
  if (Array.isArray(value)) {
    bytes += Math.max(0, value.length - 1)
    for (let index = 0; index < value.length; index++) appendChild(index, value[index])
  } else {
    const entries = Object.entries(value)
    bytes += Math.max(0, entries.length - 1)
    for (const [key, child] of entries) {
      bytes += encodedStringBytes(key) + 1
      appendChild(key, child)
    }
  }
  if (depth > MAX_DEPTH) return invalid('Session journal nesting exceeds its limit.')
  const measured = { bytes, depth }
  if (Object.isFrozen(value)) sizes.set(value, measured)
  return measured
}

export const journalValueByteLength = (value: JournalValue): number =>
  measureJournalValue(value).bytes

const retainUpdatedContainer = (
  previous: object,
  result: JournalValue[] | Record<string, JournalValue>,
  key: string | number,
  before: JournalValue,
  after: JournalValue
): JournalValue => {
  Object.freeze(result)
  const previousStrings = containerStrings.get(previous)
  if (previousStrings) {
    const retained = new Map(previousStrings)
    retained.delete(key)
    if (retained.size) containerStrings.set(result, retained)
  }
  const measured = sizes.get(previous)
  if (!measured) return result
  // A path copy replaces exactly one member. Reuse the old total instead of remeasuring every
  // sibling (including a long unchanged message body) after each metadata operation.
  const oldChild = measureChild(previous, key, before)
  const newChild = measureChild(result, key, after)
  const bytes = measured.bytes + newChild.bytes - oldChild.bytes
  const oldDepth = oldChild.depth + 1
  const newDepth = newChild.depth + 1
  let depth = Math.max(measured.depth, newDepth)
  if (oldDepth === measured.depth && newDepth < oldDepth) {
    // Removing/shrinking the deepest member can lower the exact depth. Recheck depths only;
    // strings have depth zero, and immutable object subtrees already have measurements.
    depth = 0
    for (const child of Object.values(result)) {
      depth = Math.max(
        depth,
        child !== null && typeof child === 'object' ? measureJournalValue(child).depth + 1 : 1
      )
    }
  }
  if (depth > MAX_DEPTH) return invalid('Session journal nesting exceeds its limit.')
  sizes.set(result, { bytes, depth })
  return result
}

// Internal immutable construction for both codecs. These helpers carry exact measurements
// across known changes; they do not interpret persisted paths or operations.
// Inputs are already normalized Journal values; callers cannot mutate their cached subtrees.
export const replaceJournalChild = (
  previous: JournalValue,
  key: string | number,
  replacement: JournalValue
): JournalValue => {
  if (Array.isArray(previous)) {
    if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0 || key >= previous.length)
      return invalid('Journal array member does not exist.')
    const result = [...previous]
    result[key] = replacement
    return retainUpdatedContainer(previous, result, key, previous[key], replacement)
  }
  if (!isObject(previous) || typeof key !== 'string' || !hasOwn(previous, key))
    return invalid('Journal object member does not exist.')
  const result = { ...previous } as Record<string, JournalValue>
  Object.defineProperty(result, key, { value: replacement, enumerable: true })
  return retainUpdatedContainer(previous, result, key, previous[key] as JournalValue, replacement)
}

export const appendJournalArray = (
  previous: readonly JournalValue[],
  additions: readonly JournalValue[]
): readonly JournalValue[] => {
  const result = Object.freeze([...previous, ...additions])
  const previousSize = sizes.get(previous)
  if (previousSize) {
    let bytes = previousSize.bytes
    let depth = previousSize.depth
    if (additions.length > 0) {
      bytes += additions.length - (previous.length === 0 ? 1 : 0)
      for (let offset = 0; offset < additions.length; offset++) {
        const child = measureChild(result, previous.length + offset, additions[offset])
        bytes += child.bytes
        depth = Math.max(depth, child.depth + 1)
      }
    }
    if (depth > MAX_DEPTH) return invalid('Session journal nesting exceeds its limit.')
    sizes.set(result, { bytes, depth })
  }
  return result
}
