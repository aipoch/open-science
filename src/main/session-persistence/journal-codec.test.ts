import { describe, expect, it } from 'vitest'
import {
  appendJournalArray,
  freezeParsedJournalValue,
  journalValueByteLength,
  normalizeJournalValue,
  parseJournalValue,
  replaceJournalChild,
  type JournalValue
} from './journal-codec'
const exact = (value: JournalValue): void =>
  expect(journalValueByteLength(value)).toBe(Buffer.byteLength(JSON.stringify(value)))
describe('immutable JSON values and byte limits', () => {
  it('validates and freezes a parsed snapshot in place without cloning any historical node', () => {
    const parsed = JSON.parse('{"session":{"messages":[{"content":"history"}]}}')
    const message = parsed.session.messages[0]
    expect(freezeParsedJournalValue(parsed)).toBe(parsed)
    expect(parsed.session.messages[0]).toBe(message)
    expect(Object.isFrozen(message)).toBe(true)
    expect(() => freezeParsedJournalValue(JSON.parse('{"value":1e999}'))).toThrow('finite')
    expect(() =>
      freezeParsedJournalValue(JSON.parse('['.repeat(98) + '0' + ']'.repeat(98)))
    ).toThrow('nesting')
  })

  it.each(['ASCII', '汉字 😀', '"\\\n\t', '\ud800', '\udc00'])(
    'measures %j exactly after an append and replacement',
    (text) => {
      const before = normalizeJournalValue({
        content: text.repeat(100),
        eventIds: [text],
        updatedAt: 1
      }) as Record<string, JournalValue>
      exact(before)
      const ids = appendJournalArray(before.eventIds as readonly JournalValue[], [text, 'next'])
      let after = replaceJournalChild(before, 'eventIds', ids)
      after = replaceJournalChild(after, 'content', text.repeat(110))
      after = replaceJournalChild(after, 'updatedAt', 2)
      exact(after)
      exact(before)
      expect(Object.isFrozen(after)).toBe(true)
    }
  )
  it('preserves JSON key order, undefined semantics and special own keys', () => {
    const before = normalizeJournalValue(JSON.parse('{"z":1,"__proto__":"own","a":2}'))
    const after = replaceJournalChild(before, '__proto__', 'safe')
    expect(JSON.stringify(after)).toBe('{"z":1,"__proto__":"safe","a":2}')
    expect(
      normalizeJournalValue({ present: null, omitted: undefined, array: [undefined] })
    ).toEqual({ present: null, array: [null] })
    expect(({} as { safe?: boolean }).safe).toBeUndefined()
    exact(after)
  })
  it('freezes parsed values without accepting nonfinite numbers or excessive depth', () => {
    const parsed = parseJournalValue('{"a":[{"text":"value"}]}') as { a: object[] }
    expect(Object.isFrozen(parsed.a[0])).toBe(true)
    expect(() => parseJournalValue('1e999')).toThrow('finite')
    expect(() => parseJournalValue('['.repeat(98) + '0' + ']'.repeat(98))).toThrow('nesting')
    expect(() =>
      normalizeJournalValue({
        get value() {
          throw new Error('must not invoke getter')
        }
      })
    ).toThrow('accessors')
    expect(() => normalizeJournalValue(new Date())).toThrow('ordinary JSON')
  })
  it('keeps exact depths after replacing the deepest child and subsequently expanding it', () => {
    let deep: JournalValue = 'x'
    for (let depth = 0; depth < 94; depth++) deep = { child: deep }
    const before = normalizeJournalValue({ deep, shallow: null })
    exact(before)
    const smaller = replaceJournalChild(before, 'deep', null)
    exact(smaller)
    const restored = replaceJournalChild(smaller, 'shallow', deep)
    exact(restored)
    expect(() => replaceJournalChild(before, 'missing', 1)).toThrow('does not exist')
    expect(() => replaceJournalChild(normalizeJournalValue([]), -1, 1)).toThrow('does not exist')
  })
})
