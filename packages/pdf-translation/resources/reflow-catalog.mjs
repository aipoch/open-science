/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker. */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFString,
  PDFHexString,
  PDFNull,
  PDFRef,
  PDFStream,
  PDFObjectCopier
} from 'pdf-lib'

const name = (value) => PDFName.of(value)
const modes = ['', 'XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV']
const text = (value) => {
  if (!(value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName))
    throw Error('Invalid PDF name')
  return value.decodeText()
}

// Name/number trees may be nested. Bound traversal and reject cycles or duplicate keys.
function tree(root, field, numeric) {
  if (!root) return []
  const entries = [],
    seen = new Set(),
    keys = new Set()
  const walk = (node, depth) => {
    if (!(node instanceof PDFDict) || seen.has(node) || depth > 64 || seen.size >= 10000)
      throw Error('Invalid PDF tree')
    seen.add(node)
    const values = node.lookup(name(field)),
      kids = node.lookup(name('Kids'))
    if (values && kids) throw Error('Mixed PDF tree node')
    if (values) {
      if (!(values instanceof PDFArray) || values.size() % 2)
        throw Error('Invalid PDF tree entries')
      for (let i = 0; i < values.size(); i += 2) {
        const raw = values.lookup(i)
        const key = numeric && raw instanceof PDFNumber ? raw.asNumber() : numeric ? NaN : text(raw)
        if (
          (numeric && (!Number.isSafeInteger(key) || key < 0)) ||
          keys.has(key) ||
          keys.size >= 10000
        )
          throw Error('Invalid PDF tree key')
        keys.add(key)
        entries.push([key, values.lookup(i + 1), raw])
      }
    } else if (kids) {
      if (!(kids instanceof PDFArray)) throw Error('Invalid PDF tree children')
      for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i), depth + 1)
    } else throw Error('Empty PDF tree node')
  }
  walk(root, 0)
  return entries
}

// Copy only independent object graphs. A hidden source Page/Catalog reference must
// never import a detached page tree into the generated document.
function independent(source, value) {
  const pending = [value],
    seen = new Set()
  while (pending.length) {
    let object = pending.pop()
    if (object instanceof PDFRef) {
      object = source.context.lookup(object)
      if (!object) throw Error('Dangling PDF reference')
    }
    if (!object || seen.has(object)) continue
    if (seen.size >= 100000) throw Error('PDF object limit')
    seen.add(object)
    if (object instanceof PDFStream) object = object.dict
    if (object instanceof PDFDict) {
      if (['/Page', '/Pages', '/Catalog'].includes(object.lookup(name('Type'))?.toString()))
        throw Error('Page-dependent PDF structure')
      for (const [, child] of object.entries()) pending.push(child)
    } else if (object instanceof PDFArray) pending.push(...object.asArray())
  }
}

export function readReflowCatalog(source) {
  try {
    const catalog = source.catalog,
      copied = [],
      destinations = []
    const allowed = new Set([
      'Type',
      'Pages',
      'Outlines',
      'AcroForm',
      'Metadata',
      'Lang',
      'Version',
      'Extensions',
      'ViewerPreferences',
      'PageLayout',
      'PageMode',
      'URI',
      'OutputIntents',
      'MarkInfo',
      'Names',
      'Dests',
      'PageLabels',
      'AF',
      'OpenAction'
    ])
    for (const key of catalog.keys())
      if (!allowed.has(key.decodeText())) throw Error('Unsupported catalog entry')
    const markInfo = catalog.lookup(name('MarkInfo'))
    if (
      markInfo &&
      (!(markInfo instanceof PDFDict) || markInfo.lookup(name('Marked'))?.toString() === 'true')
    )
      throw Error('Tagged document requires original structure')
    for (const key of [
      'Metadata',
      'Lang',
      'Version',
      'Extensions',
      'PageLayout',
      'PageMode',
      'URI',
      'OutputIntents',
      'MarkInfo',
      'AF'
    ]) {
      const value = catalog.get(name(key))
      if (value) {
        independent(source, value)
        copied.push([key, value])
      }
    }
    const info = source.context.trailerInfo.Info
    if (info) independent(source, info)
    const names = catalog.lookup(name('Names'))
    if (names && !(names instanceof PDFDict)) throw Error('Invalid names dictionary')
    if (names?.keys().some((key) => !['Dests', 'EmbeddedFiles'].includes(key.decodeText())))
      throw Error('Unsupported named structure')
    const embedded = names?.get(name('EmbeddedFiles'))
    if (embedded) {
      tree(source.context.lookup(embedded), 'Names', false)
      independent(source, embedded)
    }
    const rawDestinations = new Map()
    for (const [key, value, raw] of tree(names?.lookup(name('Dests')), 'Names', false))
      rawDestinations.set(key, { value, raw, legacy: false })
    const legacy = catalog.lookup(name('Dests'))
    if (legacy && !(legacy instanceof PDFDict)) throw Error('Invalid legacy destinations')
    for (const [raw, value] of legacy?.entries() ?? []) {
      const key = text(raw)
      if (rawDestinations.has(key)) throw Error('Ambiguous destination name')
      rawDestinations.set(key, { value: source.context.lookup(value), raw, legacy: true })
    }
    const pages = new Map(source.getPages().map((page, i) => [page.ref.toString(), i + 1]))
    const destination = (value, seen = new Set()) => {
      if (value instanceof PDFDict) {
        if (value.keys().some((key) => key.decodeText() !== 'D'))
          throw Error('Unsupported destination dictionary')
        value = value.lookup(name('D'))
      }
      if (value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName) {
        const key = text(value)
        if (seen.has(key) || seen.size > 64 || !rawDestinations.has(key))
          throw Error('Unresolved destination')
        seen.add(key)
        return destination(rawDestinations.get(key).value, seen)
      }
      if (!(value instanceof PDFArray)) throw Error('Invalid destination')
      const pageNumber = pages.get(value.get(0)?.toString()),
        mode = modes.indexOf(value.lookup(1)?.decodeText?.())
      const counts = [0, 3, 0, 1, 1, 4, 0, 1, 1]
      if (!pageNumber || mode < 1 || value.size() !== counts[mode] + 2)
        throw Error('Invalid destination view')
      const params = value
        .asArray()
        .slice(2)
        .map((raw) => {
          const operand = source.context.lookup(raw)
          if (operand === PDFNull) return null
          if (!(operand instanceof PDFNumber) || !Number.isFinite(operand.asNumber()))
            throw Error('Invalid destination operand')
          return operand.asNumber()
        })
      if (mode !== 1 && params.some((x) => x === null)) throw Error('Relative destination view')
      return { pageNumber, mode, params }
    }
    for (const entry of rawDestinations.values())
      destinations.push({ ...entry, destination: destination(entry.value) })
    let openAction = catalog.lookup(name('OpenAction'))
    if (openAction instanceof PDFDict) {
      if (
        openAction.lookup(name('S'))?.toString() !== '/GoTo' ||
        openAction.keys().some((key) => !['S', 'D', 'Type'].includes(key.decodeText()))
      )
        throw Error('Unsupported opening action')
      openAction = openAction.lookup(name('D'))
    }
    if (openAction) destinations.push({ openAction: true, destination: destination(openAction) })
    const labels = tree(catalog.lookup(name('PageLabels')), 'Nums', true).sort(
      (a, b) => a[0] - b[0]
    )
    if (labels.length && labels[0][0] !== 0) throw Error('Missing first page label')
    for (const [index, label] of labels) {
      if (
        index >= pages.size ||
        !(label instanceof PDFDict) ||
        label.keys().some((key) => !['S', 'P', 'St'].includes(key.decodeText()))
      )
        throw Error('Invalid page label')
      const style = label.lookup(name('S')),
        prefix = label.lookup(name('P')),
        start = label.lookup(name('St'))
      if (
        (style && !['/D', '/R', '/r', '/A', '/a'].includes(style.toString())) ||
        (prefix && !(prefix instanceof PDFString || prefix instanceof PDFHexString)) ||
        (start &&
          (!(start instanceof PDFNumber) ||
            !Number.isSafeInteger(start.asNumber()) ||
            start.asNumber() < 1))
      )
        throw Error('Invalid page label style')
    }
    const preferences = catalog.lookup(name('ViewerPreferences'))
    let printRange
    if (preferences) {
      if (!(preferences instanceof PDFDict)) throw Error('Invalid viewer preferences')
      independent(source, preferences)
      // ISO 32000-1 PrintPageRange uses one-based page numbers (unlike pdf-lib
      // convenience setters). Reject nonstandard zero-based ranges rather than guess.
      const ranges = preferences.lookup(name('PrintPageRange'))
      if (ranges) {
        if (!(ranges instanceof PDFArray) || ranges.size() % 2) throw Error('Invalid print ranges')
        printRange = ranges.asArray().map((raw) => {
          const value = source.context.lookup(raw)
          if (
            !(value instanceof PDFNumber) ||
            !Number.isSafeInteger(value.asNumber()) ||
            value.asNumber() < 1 ||
            value.asNumber() > pages.size
          )
            throw Error('Invalid print page')
          return value.asNumber()
        })
        for (let i = 0; i < printRange.length; i += 2)
          if (printRange[i] > printRange[i + 1]) throw Error('Reversed print range')
      }
    }
    return { copied, info, embedded, destinations, labels, preferences, printRange }
  } catch {
    return { wholeDocument: true }
  }
}

export function writeReflowCatalog(
  source,
  output,
  catalog,
  navigation,
  sourcePageNumbers,
  sourcePages
) {
  const copier = PDFObjectCopier.for(source.context, output.context)
  if (catalog.info) output.context.trailerInfo.Info = copier.copy(catalog.info)
  for (const [key, value] of catalog.copied) output.catalog.set(name(key), copier.copy(value))
  const names = output.context.obj({}),
    legacy = output.context.obj({}),
    named = []
  if (catalog.embedded) names.set(name('EmbeddedFiles'), copier.copy(catalog.embedded))
  for (const entry of navigation.catalogDestinations) {
    const target = entry.target
    const value = output.context.obj([
      output.getPage(target.pageNumber - 1).ref,
      name(modes[target.mode]),
      ...target.params
    ])
    if (entry.openAction) output.catalog.set(name('OpenAction'), value)
    else if (entry.legacy) legacy.set(entry.raw, value)
    else named.push(entry.raw, value)
  }
  if (named.length) names.set(name('Dests'), output.context.obj({ Names: named }))
  if (names.keys().length) output.catalog.set(name('Names'), names)
  if (legacy.keys().length) output.catalog.set(name('Dests'), legacy)
  if (catalog.labels.length) {
    const nums = []
    for (const [index, sourceNumber] of sourcePageNumbers.entries()) {
      const [start, label] = catalog.labels.findLast(([start]) => start < sourceNumber)
      const copy = copier.copy(label).clone(output.context)
      if (label.has(name('S')))
        copy.set(
          name('St'),
          PDFNumber.of((label.lookup(name('St'))?.asNumber() ?? 1) + sourceNumber - 1 - start)
        )
      nums.push(index, copy)
    }
    output.catalog.set(name('PageLabels'), output.context.obj({ Nums: nums }))
  }
  if (catalog.preferences) {
    const preferences = copier.copy(catalog.preferences)
    if (catalog.printRange) {
      const selected = sourcePages.flatMap((pages, index) =>
        pages.some((number) =>
          catalog.printRange.some(
            (start, i, ranges) => i % 2 === 0 && number >= start && number <= ranges[i + 1]
          )
        )
          ? [index + 1]
          : []
      )
      const ranges = []
      for (const index of selected) {
        if (ranges.length && ranges.at(-1) + 1 === index) ranges[ranges.length - 1] = index
        else ranges.push(index, index)
      }
      preferences.set(name('PrintPageRange'), output.context.obj(ranges))
    }
    output.catalog.set(name('ViewerPreferences'), preferences)
  }
}
