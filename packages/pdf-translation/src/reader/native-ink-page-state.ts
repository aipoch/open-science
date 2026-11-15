import type { PDFPageProxy } from 'pdfjs-dist'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Viewport = ReturnType<PDFPageProxy['getViewport']>

const fontProperties = [
  'ascent',
  'bbox',
  'black',
  'bold',
  'charProcOperatorList',
  'cssFontInfo',
  'defaultVMetrics',
  'defaultWidth',
  'descent',
  'fallbackName',
  'fontExtraProperties',
  'fontMatrix',
  'isInvalidPDFjsFont',
  'isType3Font',
  'italic',
  'mimetype',
  'missingFile',
  'name',
  'remeasure',
  'systemFontInfo',
  'vertical',
  'cMap',
  'composite',
  'defaultEncoding',
  'differences',
  'isMonospace',
  'isSerifFont',
  'isSymbolicFont',
  'seacMap',
  'subtype',
  'toFontChar',
  'toUnicode',
  'type',
  'vmetrics',
  'widths'
] as const

function normalized(value: unknown, fonts: ReadonlyMap<string, string> = new Map()): unknown {
  if (value === undefined) return { undefined: true }
  if (typeof value === 'string') return fonts.get(value) ?? value
  if (ArrayBuffer.isView(value))
    return {
      type: value.constructor.name,
      values: Array.from(value as unknown as ArrayLike<number>)
    }
  if (Array.isArray(value)) return value.map((item): unknown => normalized(item, fonts))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key): [string, unknown] => [
          fonts.get(key) ?? key,
          normalized((value as Record<string, unknown>)[key], fonts)
        ])
        .sort(([a], [b]): number => a.localeCompare(b))
    )
  return value
}

function same(a: unknown, b: unknown, fonts?: ReadonlyMap<string, string>): boolean {
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b, fonts))
}

function requireEvidence(value: unknown): asserts value {
  if (!value) throw new Error('Incomplete auxiliary native evidence.')
}

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return Array.from(new Uint8Array(result), (n): string => n.toString(16).padStart(2, '0')).join('')
}

function viewportKey(viewport: Viewport): unknown {
  return {
    width: viewport.width,
    height: viewport.height,
    scale: viewport.scale,
    rotation: viewport.rotation,
    transform: [...viewport.transform]
  }
}

/** Identity only, not an ink certificate. The display caller compares this
 * before and after its asynchronous glyph/paint proofs. */
export async function nativeInkPageIdentity(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport
): Promise<
  | Readonly<{
      key: string
      content: Content
      viewport: Viewport
      operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
    }>
  | undefined
> {
  try {
    const operators = await page.getOperatorList()
    if (
      operators.fnArray.length > 100000 ||
      operators.fnArray.length !== operators.argsArray.length
    )
      return
    let nodes = 0
    const dataOnly = (value: unknown): boolean => {
      if (++nodes > 1000000) return false
      if (!value || typeof value !== 'object') return typeof value !== 'function'
      if (ArrayBuffer.isView(value)) return !(value instanceof DataView)
      if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)))
        return false
      return Reflect.ownKeys(value).every((key): boolean => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        return 'value' in descriptor && dataOnly(descriptor.value)
      })
    }
    if (!dataOnly(content) || !dataOnly(operators)) return
    for (const key of ['width', 'height', 'scale', 'rotation', 'transform']) {
      const descriptor = Object.getOwnPropertyDescriptor(viewport, key)
      if (!descriptor || !('value' in descriptor) || !dataOnly(descriptor.value)) return
    }
    const operatorSnapshot = structuredClone(operators),
      contentSnapshot = structuredClone(content),
      viewportSnapshot = structuredClone(viewportKey(viewport)) as Viewport,
      contentKey = normalized(contentSnapshot),
      operatorKey = normalized(operatorSnapshot),
      view = normalized(viewportKey(viewportSnapshot)),
      fonts: unknown[] = [],
      ids = [
        ...new Set(
          content.items.flatMap((i): string[] => ('str' in i && i.str.trim() ? [i.fontName] : []))
        )
      ]
    if (!ids.length || ids.length > 64) return
    let bytes = 0
    for (const id of ids) {
      const font = page.commonObjs.get(id)
      if (
        font?.loadedName !== id ||
        font.missingFile !== false ||
        !(font.data instanceof Uint8Array) ||
        !font.data.length ||
        (bytes += font.data.length) > 32 * 1024 * 1024
      )
        return
      fonts.push({
        id,
        program: await digest(font.data),
        properties: fontProperties.map((key): unknown => [key, normalized(font[key])])
      })
    }
    return {
      operators: operatorSnapshot,
      content: contentSnapshot,
      viewport: viewportSnapshot,
      key: JSON.stringify({
        content: contentKey,
        operators: operatorKey,
        viewport: view,
        fonts,
        page: normalized({
          ref: page.ref,
          view: page.view,
          rotate: page.rotate,
          userUnit: page.userUnit
        })
      })
    }
  } catch {
    return
  }
}

/** No promise is allowed between this bounded byte/reference check and Source commit. */
export function nativeInkPageCurrent(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  outlineKeys: readonly string[]
): (() => boolean) | undefined {
  return nativeInkPageWitness(page, content, viewport, operators, outlineKeys)?.current
}

function nativeInkPageWitness(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  outlineKeys: readonly string[]
): { current: () => boolean; released: () => boolean } | undefined {
  try {
    const common = page.commonObjs,
      get = common.get,
      has = common.has,
      apis = [page.getTextContent, page.getOperatorList, page.getViewport],
      reference = page.ref,
      view = page.view,
      fonts: {
        id: string
        font: Record<string, unknown>
        data: Uint8Array
        bytes: Uint8Array
        slots: (() => boolean)[]
      }[] = [],
      references: [object, string, object][] = [],
      seen = new Set<object>()
    const bind = (value: unknown): void => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (seen.size > 100000) throw Error('Native reference budget.')
      if (ArrayBuffer.isView(value)) return
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) throw Error('Native accessor.')
        if (descriptor.value && typeof descriptor.value === 'object') {
          references.push([value, key, descriptor.value])
          bind(descriptor.value)
        }
      }
    }
    // PDF.js exposes font data as fresh views and metrics as freshly decoded
    // arrays. Bind the property lookup itself; compare its decoded value below.
    // A data property, including a shadow over a getter, retains exact identity.
    const slot = (font: object, key: string): (() => boolean) => {
      const chain: {
        owner: object
        parent: object | null
        descriptor: PropertyDescriptor | undefined
      }[] = []
      let owner: object | null = font
      while (owner) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key),
          parent = Object.getPrototypeOf(owner)
        chain.push({ owner, parent, descriptor })
        if (descriptor) {
          if ('value' in descriptor) bind(descriptor.value)
          break
        }
        owner = parent
      }
      return () =>
        chain.every(({ owner, parent, descriptor }) => {
          const now = Object.getOwnPropertyDescriptor(owner, key)
          return (
            Object.getPrototypeOf(owner) === parent &&
            (descriptor === undefined
              ? now === undefined
              : now !== undefined &&
                ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
                  (field) =>
                    now[field as keyof PropertyDescriptor] ===
                    descriptor[field as keyof PropertyDescriptor]
                ))
          )
        })
    }
    let bytes = 0
    for (const id of new Set(
      content.items.flatMap((item) => ('str' in item && item.str.trim() ? [item.fontName] : []))
    )) {
      const font = common.get(id),
        data = font?.data
      if (
        !font ||
        font.loadedName !== id ||
        font.missingFile !== false ||
        !(data instanceof Uint8Array) ||
        !(data.buffer instanceof ArrayBuffer) ||
        !data.length ||
        (bytes += data.length) > 32 * 1024 * 1024 ||
        fonts.length >= 64
      )
        return
      const slots = ['loadedName', 'data', ...fontProperties].map((key) => slot(font, key))
      fonts.push({ id, font, data, bytes: data.slice(), slots })
    }
    if (!fonts.length) return
    let outlineBytes = 0
    const outlines: ((released: boolean) => boolean)[] = []
    for (const key of new Set(outlineKeys)) {
      if (outlines.length >= 10000) return
      const present = common.has(key)
      if (!present) {
        outlines.push((released) => released || !common.has(key))
        continue
      }
      const owner = common.get(key),
        path = owner?.path,
        currentSlot = slot(owner, 'path')
      if (
        !ArrayBuffer.isView(path) ||
        path instanceof DataView ||
        !(path.buffer instanceof ArrayBuffer) ||
        (outlineBytes += path.byteLength) > 16 * 1024 * 1024
      )
        return
      const pathKey = JSON.stringify(normalized(path))
      outlines.push((released) => {
        const now = owner.path
        return (
          (released || (common.has(key) && common.get(key) === owner)) &&
          currentSlot() &&
          ArrayBuffer.isView(now) &&
          now.buffer === path.buffer &&
          now.byteOffset === path.byteOffset &&
          now.byteLength === path.byteLength &&
          JSON.stringify(normalized(now)) === pathKey
        )
      })
    }
    bind([content, operators, viewport.transform, reference, view])
    const values = (): unknown =>
        normalized([
          content,
          operators,
          viewportKey(viewport),
          page.ref,
          page.view,
          page.rotate,
          page.userUnit,
          fonts.map(({ font }) => fontProperties.map((key) => font[key]))
        ]),
      snapshot = JSON.stringify(values())
    const check = (released: boolean): boolean => {
      try {
        if (
          page.commonObjs !== common ||
          common.get !== get ||
          common.has !== has ||
          page.ref !== reference ||
          page.view !== view ||
          ![page.getTextContent, page.getOperatorList, page.getViewport].every(
            (api, i) => api === apis[i]
          ) ||
          references.some(
            ([parent, key, value]) => Object.getOwnPropertyDescriptor(parent, key)?.value !== value
          ) ||
          JSON.stringify(values()) !== snapshot
        )
          return false
        for (const entry of fonts) {
          const data = entry.font.data
          if (
            (!released && common.get(entry.id) !== entry.font) ||
            entry.font.loadedName !== entry.id ||
            !entry.slots.every((current) => current()) ||
            !(data instanceof Uint8Array) ||
            data.buffer !== entry.data.buffer ||
            data.byteOffset !== entry.data.byteOffset ||
            data.length !== entry.bytes.length
          )
            return false
          for (let i = 0; i < entry.bytes.length; i++) if (data[i] !== entry.bytes[i]) return false
        }
        return outlines.every((current) => current(released))
      } catch {
        return false
      }
    }
    return { current: () => check(false), released: () => check(true) }
  } catch {
    return
  }
}

export {
  fontProperties,
  normalized,
  same,
  requireEvidence,
  digest,
  viewportKey,
  nativeInkPageWitness
}
