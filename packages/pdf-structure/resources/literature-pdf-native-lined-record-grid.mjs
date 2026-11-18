/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import {
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'

const center = (i) => (i.rect[1] + i.rect[3]) / 2

// A separate bracketed-reference lane and complete measured anchors witness
// wrapped records. Empty optional measurements remain empty; no field is filled.
export function recoverNativeCitedMeasurementGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 7) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 2 &&
      i.rect[2] < crop[2] + 2
  )
  const h = Math.max(...near.map((i) => i.height))
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full
  if (
    divider[1] - opening[1] < h ||
    divider[1] - opening[1] > 4 * h ||
    Math.abs(closing[1] - crop[3]) > h
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < 3 * h
    ).length !== 1
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        (i.rect[1] < opening[1] &&
          !(i.baseline < divider[1] && i.rect[1] >= opening[1] - h * 0.2)) ||
        i.rect[3] > closing[1]
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    ref = header.filter((i) => /^Ref\.$/i.test(i.text.trim()))
  if (ref.length !== 1 || ref[0].rect[0] < crop[0] + (crop[2] - crop[0]) * 0.85) return
  const proposed = [
    opening[0],
    ...model.slice(1).map((c, n) => crop[0] + (model[n].rect[2] + c.rect[0]) / 2),
    ref[0].rect[0] - h * 0.5,
    opening[2]
  ]
  if (proposed.some((x, n) => n && x <= proposed[n - 1])) return
  const lanes = proposed
    .slice(1)
    .map((x, n) =>
      source.filter(
        (i) => (i.rect[0] + i.rect[2]) / 2 >= proposed[n] && (i.rect[0] + i.rect[2]) / 2 < x
      )
    )
  if (lanes.some((l) => !l.length) || !hasUniqueRecordTokens(source, lanes)) return
  const cuts = [opening[0]]
  for (let n = 1; n < lanes.length; n++) {
    const left = Math.max(...lanes[n - 1].map((i) => i.rect[2])),
      right = Math.min(...lanes[n].map((i) => i.rect[0]))
    if (right - left < h * 0.25) return
    cuts.push((left + right) / 2)
  }
  cuts.push(opening[2])
  if (!readSourceRow(header, cuts, { multiline: true })?.every((s) => /\p{L}/u.test(s))) return
  const anchors = lanes[0].filter((i) => body.includes(i)).sort((a, b) => a.baseline - b.baseline)
  if (
    anchors.length < 6 ||
    anchors.length > 30 ||
    anchors.some(
      (i) => !/^[a-z0-9]+-\d+$/i.test(i.text.trim()) || Math.abs(i.height - h) > h * 0.02
    ) ||
    anchors.some((i, n) => n && i.baseline - anchors[n - 1].baseline < h * 1.5)
  )
    return
  const records = anchors.map(() => [])
  for (const i of body) {
    const ranked = anchors
      .map((a, n) => ({ n, gap: Math.abs(i.baseline - a.baseline) }))
      .sort((a, b) => a.gap - b.gap)
    if (
      ranked[0].gap > h * 1.3 ||
      ranked[1].gap - ranked[0].gap < h * 0.05 ||
      i.height < h * 0.65 ||
      i.height > h * 1.02
    )
      return
    records[ranked[0].n].push(i)
  }
  for (let n = 0; n < records.length; n++) {
    const row = records[n],
      a = anchors[n],
      fields = cuts
        .slice(1)
        .map((x, k) => row.filter((i) => i.rect[0] >= cuts[k] && i.rect[2] <= x))
    if (
      !hasUniqueRecordTokens(
        row,
        fields.filter((f) => f.length)
      ) ||
      fields[0].length !== 1 ||
      !fields[1].length ||
      !fields[2].length ||
      !fields[6].length ||
      fields[7].length !== 1 ||
      !/^\[\d{1,4}\]$/.test(fields[7][0].text)
    )
      return
    if (
      [4, 5, 7].some(
        (k) =>
          fields[k].length !== 1 ||
          Math.abs(fields[k][0].baseline - a.baseline) > h * 0.05 ||
          Math.abs(fields[k][0].height - h) > h * 0.02
      ) ||
      [4, 5].some((k) => !/^(?:[+-]|\u2212)?\d+(?:\.\d+)?$/.test(fields[k][0].text)) ||
      fields[3].some(
        (i) => !/^\d+(?:\.\d+)?$/.test(i.text) || Math.abs(i.baseline - a.baseline) > h * 0.05
      )
    )
      return
    if (
      n &&
      Math.min(...row.map((i) => i.rect[1])) <= Math.max(...records[n - 1].map((i) => i.rect[3]))
    )
      return
  }
  if (
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  const top = Math.min(opening[1], ...header.map((i) => i.rect[1])),
    edges = [
      top,
      divider[1],
      ...records
        .slice(1)
        .map(
          (row, n) =>
            (Math.max(...records[n].map((i) => i.rect[3])) +
              Math.min(...row.map((i) => i.rect[1]))) /
            2
        ),
      closing[1]
    ]
  if (
    items.some(
      (i) =>
        !source.includes(i) &&
        i.text?.trim() &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        center(i) >= top &&
        center(i) < opening[1]
    )
  )
    return
  const nativeCrop = [opening[0], top, opening[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Two matching native interval fences can recover a missing identifier lane
// beside complete scientific records. Every field retains its whole sources;
// header packet overhang is proof geometry, never a new preview crop.
function recoverNativeTwoFenceScientificGrid(table, items, captions, rules, context) {
  try {
    const boundContext = nativeRecoveryOwnValues(context),
      c = boundContext?.nativeGlyphContext,
      page = boundContext?.sourcePage,
      work = boundContext?.viewport,
      crop = table.cropRect,
      same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      inside = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3],
      compact = (g) =>
        g
          .map((t) => t.text)
          .join('')
          .replace(/\s/gu, ''),
      integer = /^\d+$/u,
      scientific = /^\d+(?:\.\d+)?×10[−+-]?\d+$/u,
      scalar = /^\d+\.\d+$/u
    if (
      table.structure.objects.filter((o) => o.label === 'table column').length !== 6 ||
      !c ||
      !page ||
      !work ||
      table.readingRotation !== 0
    )
      return undefined
    if (
      table.spans?.length ||
      table.issues?.length ||
      table.structure.objects.some((o) => /spanning cell|projected row header/u.test(o.label))
    )
      return undefined
    const nativeValues = nativeRecoveryOwnValues(c)
    if (!nativeValues || !nativeRecoveryOwnValues(page)) return undefined
    const prototype = Object.getPrototypeOf(c),
      descriptors = Object.getOwnPropertyDescriptors(c),
      keys = Reflect.ownKeys(descriptors),
      carrierCurrent = () =>
        Object.getPrototypeOf(c) === prototype &&
        Reflect.ownKeys(c).length === keys.length &&
        Reflect.ownKeys(c).every((k, i) => k === keys[i]) &&
        keys.every((k) => {
          const d = Object.getOwnPropertyDescriptor(c, k),
            old = descriptors[k]
          return (
            d &&
            Object.hasOwn(d, 'value') &&
            Object.is(d.value, old.value) &&
            d.enumerable === old.enumerable &&
            d.configurable === old.configurable &&
            d.writable === old.writable
          )
        })
    const current = retainNativeRecoveryInputs(
      [
        // The standard packet does not consume the neighboring-page running
        // head witness. Retain its carrier identity above, not its other viewport.
        ...Object.entries(nativeValues)
          .filter(([k]) => k !== 'runningHeadWitness')
          .map(([, v]) => v),
        page,
        context.sourceContent,
        context.operators,
        work,
        table,
        items,
        captions,
        rules,
        [...context.rulePaintBounds]
      ],
      work
    )
    if (
      !current ||
      work.scale !== 1.5 ||
      page.renderRotation !== 0 ||
      work.width !== c.viewport.width * 1.5 ||
      work.height !== c.viewport.height * 1.5 ||
      context.content !== context.sourceContent ||
      !same(
        work.transform,
        c.viewport.transform.map((n) => n * 1.5)
      ) ||
      !matchNativeFigureRenderContext(
        c,
        page.pageNumber,
        context.sourceContent,
        c.viewport,
        page.graphicsBounds,
        c.sourceSha256
      )
    )
      return undefined
    const aliases = new Map(
        context.sourceContent.items.map((r, i) => [r.fontName, c.content.items[i].fontName])
      ),
      live = context.operators,
      original = c.operators
    if (
      !same(Array.from(live.fnArray), Array.from(original.fnArray)) ||
      live.argsArray.length !== original.argsArray.length ||
      live.argsArray.some((args, i) => {
        const op = live.fnArray[i],
          mapped =
            op === OPS.setFont
              ? [aliases.get(args[0]), ...args.slice(1)]
              : op === OPS.dependency
                ? args.map((id) => aliases.get(id) ?? id)
                : args
        return !same(mapped, original.argsArray[i])
      })
    )
      return undefined
    const fonts = items.filter((t) => t.text?.trim() && inside(crop, t.rect))
    if (!fonts.length || !proveNativeUniqueWholeFonts(fonts, items)) return undefined
    for (const t of fonts) {
      const raw = c.content.items[t.sourceItem.index],
        p = raw && tableTextToken(raw, work, 0)
      if (
        !raw ||
        raw.str !== t.text ||
        raw.sourceItem.pageNumber !== t.sourceItem.pageNumber ||
        !same(p.rect, t.rect) ||
        p.baseline !== t.baseline ||
        p.height !== t.height
      )
        return undefined
    }
    const whole = c.content.items.flatMap((r) =>
        r.str?.trim() ? [tableTextToken(r, c.viewport, 0)] : []
      ),
      packet = nativePageTextPacketInventory(
        page,
        whole,
        c,
        true,
        new Set(fonts.map((t) => t.sourceItem.index)),
        false
      )
    if (!packet || packet.evidence.images.length) return undefined
    const records = fonts.map((t) => packet.records.find((r) => r.index === t.sourceItem.index))
    if (
      records.some(
        (r) =>
          !r?.advanceComplete ||
          !packet.valid(r.ink) ||
          r.part.some(
            ({ g }) =>
              g.rendererSkipped ||
              g.textPaint?.fillAlpha !== 1 ||
              !/^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) ||
              g.textPaint.fillColor.toLowerCase() === '#ffffff'
          )
      )
    )
      return undefined
    const hs = fonts.map((t) => t.height).sort((a, b) => a - b),
      h = hs[Math.floor(hs.length / 2)],
      nativePaint = new Map(),
      nativeRules = collectTableRules(c.operators, work, nativePaint),
      vertical = nativeRules.filter(
        (r) =>
          r[0] === r[2] && r[1] >= crop[1] && r[3] <= crop[3] && r[0] > crop[0] && r[0] < crop[2]
      ),
      xs = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
    if (xs.length !== 2 || !vertical.every((r) => rules.some((s) => same(r, s)))) return undefined
    const bands = vertical.filter((r) => r[0] === xs[0]).sort((a, b) => a[1] - b[1]),
      other = vertical.filter((r) => r[0] === xs[1]).sort((a, b) => a[1] - b[1])
    if (
      bands.length < 4 ||
      bands.length > 20 ||
      other.length !== bands.length ||
      bands.some((r, i) => r[1] !== other[i][1] || r[3] !== other[i][3])
    )
      return undefined
    const dividers = nativeRules.filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > bands[0][3] &&
        r[1] < bands[1][1] &&
        r[0] <= Math.min(...fonts.map((t) => t.rect[0])) &&
        r[2] >= Math.max(...fonts.map((t) => t.rect[2]))
    )
    if (dividers.length !== 1) return undefined
    const divider = dividers[0]
    const physical = bands.map((r) => fonts.filter((t) => t.baseline >= r[1] && t.baseline <= r[3]))
    if (
      physical.flat().length !== fonts.length ||
      new Set(physical.flat()).size !== fonts.length ||
      physical.some((g) => !g.length) ||
      physical.some(
        (g, i) =>
          i &&
          Math.min(...g.map((t) => t.baseline)) <=
            Math.max(...physical[i - 1].map((t) => t.baseline))
      )
    )
      return undefined
    const fields = []
    for (const row of physical.slice(1)) {
      const stub = row.filter((t) => t.rect[2] <= xs[0]),
        middle = row
          .filter((t) => t.rect[0] >= xs[0] && t.rect[2] <= xs[1])
          .sort((a, b) => a.rect[0] - b.rect[0]),
        tail = row.filter((t) => t.rect[0] >= xs[1]).sort((a, b) => a.rect[0] - b.rect[0])
      if (
        stub.length !== 1 ||
        !integer.test(compact(stub)) ||
        tail.length !== 2 ||
        !tail.every((t) => integer.test(t.text)) ||
        stub.length + middle.length + tail.length !== row.length
      )
        return undefined
      const groups = []
      let group = []
      for (const t of middle) {
        if (
          group.length &&
          scientific.test(compact(group)) &&
          group.some((t) => t.height < h * 0.8) &&
          t.height >= h * 0.8
        ) {
          groups.push(group)
          group = []
        }
        group.push(t)
      }
      if (group.length) groups.push(group)
      if (groups.length !== 4) return undefined
      for (const g of groups) {
        const main = g.filter((t) => t.height >= h * 0.8),
          scripts = g.filter((t) => t.height < h * 0.8)
        if (!main.length || main.some((t) => Math.abs(t.baseline - main[0].baseline) > h * 0.04))
          return undefined
        if (scientific.test(compact(g))) {
          if (
            !scripts.length ||
            !scripts.every((t, i) =>
              i
                ? Math.abs(t.baseline - scripts[i - 1].baseline) < h * 0.04 &&
                  t.rect[0] >= scripts[i - 1].rect[2] - 0.02 &&
                  t.rect[0] - scripts[i - 1].rect[2] < h * 0.1
                : isAdjacentTableScript(t, main.at(-1))
            )
          )
            return undefined
        } else if (!scalar.test(compact(g)) || scripts.length) return undefined
      }
      fields.push([stub, ...groups, ...tail.map((t) => [t])])
    }
    if (
      [1, 2, 3, 4].some(
        (col) => fields.filter((row) => scientific.test(compact(row[col]))).length < 2
      )
    )
      return undefined
    const cuts = [crop[0], xs[0]]
    for (let col = 1; col < 4; col++) {
      const l = Math.max(...fields.flatMap((row) => row[col].map((t) => t.rect[2]))),
        r = Math.min(...fields.flatMap((row) => row[col + 1].map((t) => t.rect[0])))
      if (!(l < r)) return undefined
      cuts.push((l + r) / 2)
    }
    cuts.push(xs[1])
    const l = Math.max(...fields.flatMap((row) => row[5].map((t) => t.rect[2]))),
      r = Math.min(...fields.flatMap((row) => row[6].map((t) => t.rect[0])))
    if (!(l < r)) return undefined
    cuts.push((l + r) / 2, crop[2])
    const lane = (t) =>
        cuts.slice(1).flatMap((x, col) => (t.rect[0] >= cuts[col] && t.rect[2] <= x ? [col] : [])),
      header = physical[0],
      headers = cuts
        .slice(1)
        .map((_, col) => header.filter((t) => lane(t).length === 1 && lane(t)[0] === col))
    if (
      captions.filter(
        (cap) =>
          captionKind(cap.lines[0]) === 'table' &&
          cap.rect[0] < crop[2] &&
          cap.rect[2] > crop[0] &&
          cap.rect[3] <= Math.min(...header.map((t) => t.rect[1])) &&
          Math.min(...header.map((t) => t.rect[1])) - cap.rect[3] < h * 3
      ).length !== 1
    )
      return undefined
    if (
      headers.some((g) => !g.length) ||
      headers.flat().length !== header.length ||
      fields.some((row) =>
        row.some((g, col) => g.some((t) => lane(t).length !== 1 || lane(t)[0] !== col))
      )
    )
      return undefined
    for (const group of headers) {
      const normal = group.filter((t) => t.height >= h * 0.8)
      if (
        !normal.length ||
        normal.some(
          (t) =>
            !Number.isFinite(t.height) ||
            Math.abs(t.height - h) > h * 0.02 ||
            Math.abs(t.baseline - normal[0].baseline) > h * 0.04
        )
      )
        return undefined
      for (const t of group) {
        if (!Number.isFinite(t.height) || t.height < h * 0.55 || t.height > h * 1.02)
          return undefined
        if (t.rect[1] < bands[0][1] || t.rect[3] > bands[0][3]) {
          if (normal.filter((a) => a !== t && isAdjacentTableScript(t, a)).length !== 1)
            return undefined
        }
      }
    }
    // Start at the independent native band, then complete only its proved
    // header packets. This envelope excludes foreign ink; it does not enlarge
    // the returned cell faces or certify the unchanged preview padding.
    const headerPacketRecords = records.filter((r) =>
        header.some((t) => t.sourceItem.index === r.index)
      ),
      headerPacketInk = [
        Math.min(...headerPacketRecords.map((r) => r.ink[0])),
        Math.min(...headerPacketRecords.map((r) => r.ink[1])),
        Math.max(...headerPacketRecords.map((r) => r.ink[2])),
        Math.max(...headerPacketRecords.map((r) => r.ink[3]))
      ],
      headerFaceTop = Math.min(
        bands[0][1] / 1.5,
        Math.min(...header.map((t) => t.rect[1])) / 1.5,
        headerPacketInk[1]
      ),
      face = [
        Math.min(crop[0] / 1.5, headerPacketInk[0]),
        headerFaceTop,
        Math.max(crop[2] / 1.5, headerPacketInk[2]),
        crop[3] / 1.5
      ],
      ownedGlyphs = new Set(records.flatMap((r) => r.part.map((p) => p.g)))
    if (headerFaceTop < crop[1] / 1.5 || headerPacketInk[3] > divider[1] / 1.5) return undefined
    for (const g of packet.glyphs) {
      if (ownedGlyphs.has(g)) continue
      const nativeEmptySpace =
        g.text === ' ' && packet.finite(g.ink, 4) && g.ink[0] === g.ink[2] && g.ink[1] === g.ink[3]
      if (nativeEmptySpace) continue
      if (!packet.valid(g.ink) || hit(g.ink, face)) {
        return undefined
      }
    }
    const selected = [...vertical, divider],
      owned = new Set(),
      colors = new Map(),
      stack = []
    let color = '#000000'
    for (let i = 0; i < packet.o.fnArray.length; i++) {
      const op = packet.o.fnArray[i],
        a = packet.o.argsArray[i]
      if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) stack.push(color)
      else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
        if (!stack.length) return undefined
        color = stack.pop()
      } else if (op === OPS.setStrokeRGBColor) color = a[0]
      else if (
        [
          OPS.setStrokeColor,
          OPS.setStrokeColorN,
          OPS.setStrokeGray,
          OPS.setStrokeCMYKColor
        ].includes(op)
      )
        color = undefined
      else if (op === OPS.constructPath) colors.set(i, color)
    }
    if (stack.length) return undefined
    for (const [i, state] of packet.evidence.paths) {
      const a = packet.o.argsArray[i],
        q = a?.[1]?.[0]
      let key
      if (
        a?.[0] === OPS.stroke &&
        packet.finite(q, 6) &&
        q[0] === 0 &&
        q[3] === 1 &&
        state.solidStroke === true &&
        state.strokeAlpha === 1 &&
        state.lineCap === 0 &&
        state.lineWidth > 0
      ) {
        const matrix = Util.transform(work.transform, state.transform),
          u = [q[1], q[2]],
          v = [q[4], q[5]]
        Util.applyTransform(u, matrix)
        Util.applyTransform(v, matrix)
        const rect = [
          Math.min(u[0], v[0]),
          Math.min(u[1], v[1]),
          Math.max(u[0], v[0]),
          Math.max(u[1], v[1])
        ]
        if (selected.some((r) => same(r, rect))) key = rect.join(',')
      }
      if (key) {
        if (
          owned.has(key) ||
          !/^#[a-f0-9]{6}$/iu.test(colors.get(i)) ||
          colors.get(i).toLowerCase() === '#ffffff' ||
          !same(nativePaint.get(key), context.rulePaintBounds.get(key)) ||
          !packet.valid(state.clip) ||
          !inside(
            state.clip,
            nativePaint.get(key).map((v) => v / 1.5)
          )
        )
          return undefined
        owned.add(key)
      } else {
        const p = nativeFigurePathPaint(packet, i, state)
        if (!p || hit(p.rect, face)) return undefined
      }
    }
    if (owned.size !== selected.length) return undefined
    const extents = physical.map((g) => [
        Math.min(...g.map((t) => t.rect[1])),
        Math.max(...g.map((t) => t.rect[3]))
      ]),
      edges = [headerFaceTop * 1.5, divider[1]]
    for (let i = 2; i < physical.length; i++) {
      if (!(extents[i - 1][1] < extents[i][0])) return undefined
      edges.push((extents[i - 1][1] + extents[i][0]) / 2)
    }
    edges.push(crop[3])
    if (
      !current() ||
      !carrierCurrent() ||
      context.nativeGlyphContext !== c ||
      context.sourcePage !== page ||
      context.viewport !== work
    )
      return undefined
    return {
      cropRect: crop,
      rows: edges.slice(1).map((y, i) => [crop[0], edges[i], crop[2], y]),
      columns: cuts.slice(1).map((x, i) => [cuts[i], crop[1], x, crop[3]]),
      spans: [],
      headerRows: [0],
      completeSpans: true,
      ownedTokens: new Set(fonts),
      preservePhysicalRows: true,
      repair: 'native-body-records-recovered'
    }
  } catch {
    return undefined
  }
}

// Repeated native vertical segments prove five technical lanes and each
// physical row, including a narrow fixed-parameter lane omitted by the model.
export function recoverNativeSegmentedScientificGrid(table, items, captions, rules, context) {
  const scientific = recoverNativeTwoFenceScientificGrid(table, items, captions, rules, context)
  if (scientific) return scientific
  const crop = table.cropRect
  if (![4, 5].includes(table.structure.objects.filter((o) => o.label === 'table column').length))
    return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 2 &&
      i.rect[2] < crop[2] + 2
  )
  const h = [...near.map((i) => i.height)].sort((a, b) => a - b)[Math.floor(near.length / 2)]
  if (!(h > 0)) return
  const horizontal = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h
    )
    .sort((a, b) => a[1] - b[1])
  const vertical = rules.filter(
    (r) => r[0] === r[2] && r[0] > crop[0] && r[0] < crop[2] && r[1] > crop[1] && r[3] < crop[3]
  )
  const xs = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
  if (xs.length !== 4 || horizontal.length < 3 || horizontal.length > 4) return
  const bands = vertical.filter((r) => r[0] === xs[0]).sort((a, b) => a[1] - b[1])
  if (bands.length < 4 || bands.length > 14) return
  if (
    xs.some((x) => {
      const segments = vertical.filter((r) => r[0] === x).sort((a, b) => a[1] - b[1])
      return (
        segments.length !== bands.length ||
        segments.some(
          (r, n) => Math.abs(r[1] - bands[n][1]) > 0.02 || Math.abs(r[3] - bands[n][3]) > 0.02
        )
      )
    })
  )
    return
  const opening = horizontal.find(
    (r) => r[1] < bands[0][1] && bands[0][1] - r[1] < h * 0.08 && r[1] > bands[0][1] - h * 0.08
  )
  const divider = horizontal.find((r) => r[1] > bands[0][3] && r[1] < bands[1][1])
  const closing = horizontal.find(
    (r) => r[1] > bands.at(-1)[3] && r[1] - bands.at(-1)[3] < h * 0.08
  )
  if (
    !opening ||
    !divider ||
    !closing ||
    horizontal.some(
      (r) =>
        Math.abs(r[0] - opening[0]) > 0.02 ||
        Math.abs(r[2] - opening[2]) > 0.02 ||
        (r !== opening &&
          r !== divider &&
          r !== closing &&
          !(r[1] < opening[1] && opening[1] - r[1] < h * 0.3))
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 2
    ).length !== 1
  )
    return
  if (
    bands.some(
      (r, n) =>
        r[3] - r[1] < h ||
        r[3] - r[1] > h * 2.5 ||
        (n && r[1] - bands[n - 1][3] < -0.02) ||
        (n && r[1] - bands[n - 1][3] > h * 0.1)
    )
  )
    return
  const edges = [opening[1], divider[1], ...bands.slice(1, -1).map((r) => r[3]), closing[1]],
    cuts = [opening[0], ...xs, opening[2]]
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  const faces = edges
    .slice(1)
    .map((y, n) => source.filter((i) => center(i) > edges[n] && center(i) < y))
  if (
    !hasUniqueRecordTokens(source, faces) ||
    !readSourceRow(faces[0], cuts, { multiline: true })?.every((s) => /\p{L}/u.test(s))
  )
    return
  for (const face of faces.slice(1)) {
    const text = readSourceRow(face, cuts, { multiline: true }),
      main = face.filter((i) => i.height >= h * 0.95)
    if (
      !text ||
      !/\d.*\p{L}/u.test(text[0]) ||
      !text.slice(1).every((s) => /^(?:[−–-]|[<>≤≥+−\d.×±-]+)$/u.test(s)) ||
      !main.length ||
      main.some((i) => Math.abs(i.baseline - main[0].baseline) > h * 0.05) ||
      face.some(
        (i) =>
          i.height < h * 0.95 &&
          (i.height < h * 0.55 ||
            i.height > h * 0.8 ||
            main[0].baseline - i.baseline < h * 0.15 ||
            main[0].baseline - i.baseline > h * 0.65)
      )
    )
      return
  }
  const nativeCrop = [opening[0], opening[1], opening[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Two independent integer lanes anchor a wrapped narrative record. Its
// continuation is bounded by the next complete stub/count/count baseline,
// not by a model row or a sentence-ending guess.
export function recoverNativeWrappedCountNarrativeGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 4) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 4 &&
      i.rect[2] < crop[2] + 4
  )
  const h = Math.max(...near.map((i) => i.height))
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < 3 * h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full
  if (divider[1] - opening[1] < h || divider[1] - opening[1] > 3 * h) return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < 2 * h
    ).length !== 1
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        (i.rect[1] < opening[1] &&
          !(i.baseline < divider[1] && i.rect[1] >= opening[1] - h * 0.2)) ||
        i.rect[3] > closing[1]
    )
  )
    return
  const proposed = [
    opening[0],
    ...model.slice(1).map((c, n) => crop[0] + (model[n].rect[2] + c.rect[0]) / 2),
    opening[2]
  ]
  const lanes = proposed
    .slice(1)
    .map((x, n) =>
      source.filter(
        (i) => (i.rect[0] + i.rect[2]) / 2 >= proposed[n] && (i.rect[0] + i.rect[2]) / 2 < x
      )
    )
  if (lanes.some((l) => !l.length) || !hasUniqueRecordTokens(source, lanes)) return
  const cuts = [opening[0]]
  for (let n = 1; n < lanes.length; n++) {
    const left = Math.max(...lanes[n - 1].map((i) => i.rect[2])),
      right = Math.min(...lanes[n].map((i) => i.rect[0]))
    if (right - left < h * 0.25) return
    cuts.push((left + right) / 2)
  }
  cuts.push(opening[2])
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (!readSourceRow(header, cuts, { multiline: true })?.every((s) => /\p{L}/u.test(s))) return
  const counts = body.filter((i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[2]),
    ends = body.filter((i) => i.rect[0] >= cuts[3])
  if (
    counts.length < 3 ||
    counts.length > 30 ||
    ends.length !== counts.length ||
    [...counts, ...ends].some((i) => !/^\d+$/.test(i.text) || Math.abs(i.height - h) > h * 0.02)
  )
    return
  const anchors = [...counts].sort((a, b) => a.baseline - b.baseline),
    records = []
  for (let n = 0; n < anchors.length; n++) {
    const a = anchors[n],
      end = ends.filter((i) => Math.abs(i.baseline - a.baseline) < h * 0.05)
    const stub = body.filter(
      (i) => i.rect[2] <= cuts[1] && Math.abs(i.baseline - a.baseline) < h * 0.05
    )
    if (
      end.length !== 1 ||
      !stub.length ||
      !stub.some((i) => /\p{L}/u.test(i.text)) ||
      stub.some((i) => Math.abs(i.height - h) > h * 0.02)
    )
      return
    const start = n ? (anchors[n - 1].baseline + a.baseline) / 2 : divider[1]
    const next = anchors[n + 1]
    const narrative = body.filter(
      (i) =>
        i.rect[0] >= cuts[2] &&
        i.rect[2] <= cuts[3] &&
        i.baseline >= a.baseline - h * 0.05 &&
        (!next || i.baseline < next.baseline - h * 0.05)
    )
    if (
      !narrative.length ||
      !narrative.some((i) => /\p{L}/u.test(i.text)) ||
      narrative.some((i) => Math.abs(i.height - h) > h * 0.02)
    )
      return
    const lines = []
    for (const i of [...narrative].sort((a, b) => a.baseline - b.baseline)) {
      if (!lines.some((y) => Math.abs(y - i.baseline) < h * 0.05)) lines.push(i.baseline)
    }
    if (
      Math.abs(lines[0] - a.baseline) > h * 0.05 ||
      lines.some((y, n) => n && (y - lines[n - 1] < h * 0.9 || y - lines[n - 1] > h * 1.6))
    )
      return
    const record = [...stub, a, end[0], ...narrative]
    if (
      n &&
      Math.min(...record.map((i) => i.rect[1])) < Math.max(...records[n - 1].map((i) => i.rect[3]))
    )
      return
    if (Math.min(...record.map((i) => i.rect[1])) < start - h) return
    records.push(record)
  }
  if (
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  const top = Math.min(opening[1], ...header.map((i) => i.rect[1]))
  if (
    items.some(
      (i) =>
        !source.includes(i) &&
        i.text?.trim() &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        center(i) >= top &&
        center(i) < opening[1]
    )
  )
    return
  const edges = [
      top,
      divider[1],
      ...records
        .slice(1)
        .map(
          (record, n) =>
            (Math.max(...records[n].map((i) => i.rect[3])) +
              Math.min(...record.map((i) => i.rect[1]))) /
            2
        ),
      closing[1]
    ],
    nativeCrop = [opening[0], top, opening[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// A captioned symbol/definition table has repeated complete short symbolic
// stubs. Main-font stub baselines identify records; smaller adjoining formula
// glyphs stay with their uniquely nearest record, without decoding meanings.
export function recoverNativeSymbolDefinitionGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 2) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] >= crop[0] - 2 &&
      i.rect[2] < crop[2] + 2
  )
  const h = Math.max(...near.map((i) => i.height))
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        r[2] >= crop[2] - h &&
        r[2] - crop[2] < (crop[2] - crop[0]) * 0.12
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full
  if (
    divider[1] - opening[1] < h ||
    divider[1] - opening[1] > 2 * h ||
    Math.abs(closing[1] - crop[3]) > h
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < 2 * h
    ).length !== 1
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        (i.rect[1] < opening[1] &&
          !(i.baseline < divider[1] && i.rect[1] > opening[1] - h * 0.2)) ||
        i.rect[3] > closing[1]
    )
  )
    return
  const proposed = crop[0] + (model[0].rect[2] + model[1].rect[0]) / 2
  const left = source.filter((i) => (i.rect[0] + i.rect[2]) / 2 < proposed),
    right = source.filter((i) => !left.includes(i))
  if (!left.length || !right.length || !hasUniqueRecordTokens(source, [left, right])) return
  const l = Math.max(...left.map((i) => i.rect[2])),
    r = Math.min(...right.map((i) => i.rect[0]))
  if (r - l < h * 0.5) return
  const cuts = [opening[0], (l + r) / 2, opening[2]],
    header = source.filter((i) => i.baseline < divider[1]),
    head = readSourceRow(header, cuts)
  if (
    !head ||
    !/^Symbol$/i.test(head[0]) ||
    !/^(?:Meaning|Definition)$/i.test(head[1]) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.05)
  )
    return
  const body = source.filter((i) => !header.includes(i)),
    stubs = left.filter((i) => body.includes(i) && i.height >= h * 0.95)
  const anchors = []
  for (const i of stubs.sort((a, b) => a.baseline - b.baseline)) {
    if (!anchors.some((y) => Math.abs(y - i.baseline) < h * 0.05)) anchors.push(i.baseline)
  }
  if (
    anchors.length < 8 ||
    anchors.length > 40 ||
    anchors.some((y, n) => n && (y - anchors[n - 1] < h * 1.1 || y - anchors[n - 1] > h * 1.5))
  )
    return
  const records = anchors.map(() => [])
  for (const i of body) {
    const ranked = anchors
      .map((y, n) => ({ n, gap: Math.abs(i.baseline - y) }))
      .sort((a, b) => a.gap - b.gap)
    if (
      ranked[0].gap > h * 0.65 ||
      ranked[1].gap - ranked[0].gap < h * 0.05 ||
      i.height < h * 0.65 ||
      i.height > h * 1.02 ||
      (i.height >= h * 0.95 && ranked[0].gap > h * 0.05)
    )
      return
    records[ranked[0].n].push(i)
  }
  if (
    records.some((row) => {
      const a = row.filter((i) => i.rect[2] <= cuts[1]),
        b = row.filter((i) => i.rect[0] >= cuts[1])
      return (
        !a.length ||
        !b.length ||
        a.map((i) => i.text).join('').length > 35 ||
        !b.some((i) => /\p{L}/u.test(i.text)) ||
        !hasUniqueRecordTokens(row, [a, b])
      )
    }) ||
    records.filter((row) => row.some((i) => i.height < h * 0.8)).length < 3 ||
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  for (const row of records)
    for (const lane of [
      row.filter((i) => i.rect[2] <= cuts[1]),
      row.filter((i) => i.rect[0] >= cuts[1])
    ]) {
      const witnessed = new Set(lane.filter((i) => i.height >= h * 0.95))
      for (const i of [...lane]
        .filter((i) => i.height < h * 0.95)
        .sort((a, b) => a.rect[0] - b.rect[0])) {
        const anchor = [...witnessed].some(
          (a) =>
            i.rect[0] - a.rect[2] >= -i.height * 0.05 &&
            i.rect[0] - a.rect[2] < h * 0.6 &&
            ((a.height >= h * 0.95 && Math.abs(i.baseline - a.baseline) > h * 0.08) ||
              (Math.abs(a.height - i.height) < h * 0.02 &&
                Math.abs(i.baseline - a.baseline) < h * 0.05))
        )
        if (!anchor) return
        witnessed.add(i)
      }
    }
  const top = Math.min(opening[1], ...header.map((i) => i.rect[1])),
    edges = [
      top,
      divider[1],
      ...records
        .slice(1)
        .map((row, n) => (Math.max(...records[n].map(center)) + Math.min(...row.map(center))) / 2),
      closing[1]
    ]
  if (
    records.some((row, n) =>
      row.some((i) => center(i) <= edges[n + 1] || center(i) >= edges[n + 2])
    )
  )
    return
  const nativeCrop = [opening[0], top, opening[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    nativeSymbolicRecords: true,
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// This recovers the body of an already predicted small configuration table.
// A header divider and repeated native stub-divider faces witness every row;
// three complete text fields are required on each independent baseline.
export function recoverNativeConfigurationGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 3 || !table.structure.objects.some((o) => o.label === 'table')) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 2 &&
      i.rect[2] < crop[2] + 20
  )
  const h = Math.max(...near.map((i) => i.height))
  if (!(h > 0)) return
  const horizontal = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[1] > crop[1] &&
      r[1] < crop[3] &&
      Math.abs(r[0] - crop[0]) < h &&
      Math.abs(r[2] - crop[2]) < h
  )
  const vertical = rules
    .filter(
      (r) => r[0] === r[2] && r[0] > crop[0] && r[0] < crop[2] && r[1] > crop[1] && r[3] < crop[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    horizontal.length !== 1 ||
    vertical.length < 4 ||
    vertical.length > 9 ||
    vertical.some((r) => Math.abs(r[0] - vertical[0][0]) > 0.02)
  )
    return
  const divider = horizontal[0],
    x = vertical[0][0]
  if (
    Math.abs(vertical[0][3] - divider[1]) > h * 0.08 ||
    Math.abs(vertical[1][1] - divider[1]) > h * 0.08 ||
    vertical.some(
      (r, n) =>
        r[3] - r[1] < h ||
        r[3] - r[1] > h * 2 ||
        (n && (r[1] - vertical[n - 1][3] < -0.02 || r[1] - vertical[n - 1][3] > h * 0.1))
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > vertical[0][1] &&
      center(i) < vertical.at(-1)[3] &&
      i.rect[0] < divider[2] &&
      i.rect[2] > divider[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        Math.abs(i.height - h) > h * 0.02 ||
        i.rect[0] < divider[0] ||
        i.rect[2] > divider[2] ||
        i.rect[1] < vertical[0][1] - h * 0.3 ||
        i.rect[3] > vertical.at(-1)[3]
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  const cut = crop[0] + (model[1].rect[2] + model[2].rect[0]) / 2,
    left = source.filter((i) => i.rect[0] >= x && (i.rect[0] + i.rect[2]) / 2 < cut),
    right = source.filter((i) => (i.rect[0] + i.rect[2]) / 2 >= cut)
  if (!left.length || !right.length) return
  const a = Math.max(...left.map((i) => i.rect[2])),
    b = Math.min(...right.map((i) => i.rect[0]))
  if (b - a < h * 0.25) return
  const cuts = [divider[0], x, (a + b) / 2, divider[2]],
    head = readSourceRow(header, cuts)?.map((s) => s.replace(/\s+/g, ''))
  if (
    !head ||
    !/^Configuration$/i.test(head[0]) ||
    !/^Local\p{L}+$/iu.test(head[1]) ||
    !/^Global\p{L}+$/iu.test(head[2]) ||
    head[1].slice(5).toLowerCase() !== head[2].slice(6).toLowerCase() ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.05)
  )
    return
  const records = []
  for (const i of [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = records.at(-1)
    if (row && Math.abs(row[0].baseline - i.baseline) < h * 0.05) row.push(i)
    else records.push([i])
  }
  if (
    records.length !== vertical.length - 1 ||
    records.some((row, n) => {
      const text = readSourceRow(row, cuts)
      return (
        !text?.every((s) => /\p{L}/u.test(s)) ||
        row.some((i) => center(i) <= vertical[n + 1][1] || center(i) >= vertical[n + 1][3]) ||
        (n &&
          Math.abs(
            row[0].baseline -
              records[n - 1][0].baseline -
              (records[1][0].baseline - records[0][0].baseline)
          ) >
            h * 0.05)
      )
    }) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const nativeCrop = [
    Math.min(crop[0], divider[0]),
    Math.min(crop[1], ...header.map((i) => i.rect[1])),
    Math.max(crop[2], divider[2]),
    vertical.at(-1)[3]
  ]
  if (
    items.some(
      (i) =>
        i.text?.trim() &&
        !source.includes(i) &&
        center(i) > nativeCrop[1] &&
        center(i) < nativeCrop[3] &&
        i.rect[0] < nativeCrop[2] &&
        i.rect[2] > nativeCrop[0]
    )
  )
    return
  const edges = [
    nativeCrop[1],
    divider[1],
    ...vertical.slice(1, -1).map((r) => r[3]),
    nativeCrop[3]
  ]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((p, n) => [cuts[n], nativeCrop[1], p, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
