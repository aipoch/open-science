/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativePlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { intersection as inter, union } from './literature-pdf-page-geometry.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeOpenAxisArray } from './literature-pdf-native-open-axis-array.mjs'
const inside = (a, b, e = 1e-5) => b.every((v, i) => (i < 2 ? v >= a[i] - e : v <= a[i] + e)),
  overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  close = (a, b) => Math.abs(a - b) < 0.05

export function nativeFormAxisArrayEvidence(pageInput, f, captions, tables, tokens, ctx) {
  try {
    const rules = collectTableRules(ctx.operators, ctx.viewport),
      page = pageInput.pageNumber,
      samePageCaptions = captions.filter((c) => c.page === page),
      o = ctx.operators,
      v = ctx.viewport,
      inventory = nativePlotPacketInventory(
        pageInput,
        f,
        captions,
        tables,
        rules,
        tokens,
        ctx,
        true
      )
    if (!inventory) return
    const proof = {
      records: inventory.records.map((z) => ({
        index: z.index,
        text: z.r.str,
        rect: z.rect,
        operations: [...new Set(z.part.map((p) => p.g.i))],
        ink: union(z.part.map((p) => p.g.ink))
      })),
      packets: inventory.packets,
      glyphs: inventory.glyphs
    }
    const seed = nativeOpenAxisArray(pageInput, samePageCaptions, tables, rules)
    if (!seed || !inside(f.rect, seed.rect)) return
    const vs = rules.filter((r) => r[0] === r[2] && r[3] - r[1] >= 35),
      hs = rules.filter((r) => r[1] === r[3] && r[2] - r[0] >= 65),
      faces = vs
        .flatMap((v) =>
          hs
            .filter((h) => close(h[0], v[0]) && close(h[1], v[3]))
            .map((h) => [v[0], v[1], h[2], v[3]])
        )
        .filter((r, i, all) => !all.slice(0, i).some((q) => q.every((n, k) => close(n, r[k]))))
    const formEvidence = []
    let transform = [1, 0, 0, 1, 0, 0],
      active
    const states = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        z = o.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        states.push({ transform, active, op })
        if (op === OPS.paintFormXObjectBegin) {
          if (z?.[0]) {
            if (!inventory.finite(z[0], 6)) return
            transform = Util.transform(transform, z[0])
          }
          const b = z?.[1]
          if (!b || b.length !== 4 || !Array.from(b).every(Number.isFinite)) return
          const m = Util.transform(v.transform, transform),
            pts = [
              [b[0], b[1]],
              [b[2], b[1]],
              [b[2], b[3]],
              [b[0], b[3]]
            ]
          pts.forEach((p) => Util.applyTransform(p, m))
          const form = {
            start: i,
            parent: active?.start,
            rect: union(pts.map((p) => [...p, ...p]))
          }
          formEvidence.push(form)
          active = form
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (op === OPS.paintFormXObjectEnd && active) active.end = i
        const s = states.pop()
        if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
        transform = s.transform
        active = s.active
      } else if (op === OPS.transform) {
        if (!inventory.finite(z, 6)) return
        transform = Util.transform(transform, z)
      }
    }
    if (states.length || faces.length < 3 || !faces.every((face) => inside(seed.rect, face))) return
    const forms = formEvidence.filter(
      (x) =>
        x.parent === undefined &&
        Number.isInteger(x.end) &&
        faces.every((face) => inside(x.rect, face))
    )
    if (forms.length !== 1) return
    const form = forms[0],
      e = inventory.evidence
    const paints = [],
      textAlpha = new Map()
    let color,
      stroke,
      ml = 10,
      fillAlpha = 1
    const stack = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        z = o.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin)
        stack.push({ color, stroke, ml, fillAlpha })
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd)
        ({ color, stroke, ml, fillAlpha } = stack.pop())
      else if (op === OPS.setGState) {
        for (const [key, value] of z[0]) if (key === 'ca') fillAlpha = value
      } else if (op === OPS.showText) textAlpha.set(i, fillAlpha)
      else if (op === OPS.setFillRGBColor) color = z[0]
      else if (op === OPS.setStrokeRGBColor) stroke = z[0]
      else if (op === OPS.setMiterLimit) ml = z[0]
      if (op !== OPS.constructPath || [OPS.endPath, OPS.clip, OPS.eoClip].includes(z[0])) continue
      const s = e.paths.get(i)
      if (
        !s ||
        !inventory.finite(z[2], 4) ||
        !inventory.finite(s.transform, 6) ||
        !Number.isFinite(s.lineWidth) ||
        s.lineWidth < 0 ||
        !Number.isFinite(s.fillAlpha) ||
        !Number.isFinite(s.strokeAlpha) ||
        !Array.isArray(z[1]) ||
        z[1].length !== 1
      )
        return
      const m = Util.transform(v.transform, s.transform),
        b = Array.from(z[2]),
        pts = [
          [b[0], b[1]],
          [b[2], b[1]],
          [b[2], b[3]],
          [b[0], b[3]]
        ]
      pts.forEach((p) => Util.applyTransform(p, m))
      const rect = union(pts.map((p) => [...p, ...p])),
        cmd = Array.from(z[1]?.[0] ?? [])
      let endpoints
      if (cmd.length === 6 && cmd[0] === 0 && cmd[3] === 1) {
        endpoints = [
          [cmd[1], cmd[2]],
          [cmd[4], cmd[5]]
        ]
        endpoints.forEach((p) => Util.applyTransform(p, m))
      }
      paints.push({ i, color, stroke, kind: z[0], rect, path: cmd, endpoints, state: s, miter: ml })
    }
    const strokeKinds = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ]
    for (const p of paints) {
      const pad = strokeKinds.includes(p.kind) ? (p.state.lineWidth * Math.max(1, p.miter)) / 2 : 0,
        matrix = Util.transform(v.transform, p.state.transform)
      let q = inventory.box(
        Array.from(o.argsArray[p.i][2], (n, k) => n + (k < 2 ? -pad : pad)),
        matrix
      )
      // An isolated axis-aligned segment has no joins: its true footprint is
      // governed by the cap, not the conservative miter envelope for paths.
      if (
        p.endpoints &&
        p.kind === OPS.stroke &&
        [0, 1, 2].includes(p.state.lineCap) &&
        ((matrix[1] === 0 && matrix[2] === 0) || (matrix[0] === 0 && matrix[3] === 0))
      ) {
        const horizontal = p.rect[1] === p.rect[3],
          vertical = p.rect[0] === p.rect[2]
        if (horizontal !== vertical) {
          const rx = (p.state.lineWidth * Math.hypot(matrix[0], matrix[2])) / 2,
            ry = (p.state.lineWidth * Math.hypot(matrix[1], matrix[3])) / 2,
            dx = vertical || p.state.lineCap !== 0 ? rx : 0,
            dy = horizontal || p.state.lineCap !== 0 ? ry : 0
          q = [p.rect[0] - dx, p.rect[1] - dy, p.rect[2] + dx, p.rect[3] + dy]
        }
      }
      if (!inventory.finite(q, 4)) return
      let completeInk = q
      // A closed straight polygon's actual corner angles bound its miters more
      // tightly than the configured limit. Round/bevel joins fit this bound too.
      if (
        strokeKinds.includes(p.kind) &&
        p.path[0] === 0 &&
        p.path.at(-1) === 4 &&
        [10, 13].includes(p.path.length) &&
        p.path.every(
          (n, k) =>
            Number.isFinite(n) &&
            (k === p.path.length - 1 || k % 3 !== 0 || n === (k === 0 ? 0 : 1))
        )
      ) {
        const vertices = Array.from({ length: (p.path.length - 1) / 3 }, (_, k) =>
          p.path.slice(k * 3 + 1, k * 3 + 3)
        )
        let ratio = 1,
          turn,
          convex = true
        for (let k = 0; k < vertices.length; k++) {
          const a = vertices[(k + vertices.length - 1) % vertices.length],
            b = vertices[k],
            c = vertices[(k + 1) % vertices.length],
            u = [a[0] - b[0], a[1] - b[1]],
            w = [c[0] - b[0], c[1] - b[1]],
            length = Math.hypot(...u) * Math.hypot(...w)
          const cross = u[0] * w[1] - u[1] * w[0]
          if (
            !Number.isFinite(length) ||
            !length ||
            !Number.isFinite(cross) ||
            !cross ||
            (turn !== undefined && Math.sign(cross) !== turn)
          ) {
            convex = false
            break
          }
          turn = Math.sign(cross)
          const sine = Math.sqrt(Math.max(0, (1 - (u[0] * w[0] + u[1] * w[1]) / length) / 2))
          if (!Number.isFinite(sine) || !sine) {
            convex = false
            break
          }
          ratio = Math.max(ratio, Math.min(p.miter, 1 / sine))
        }
        const radius = (p.state.lineWidth * ratio) / 2
        if (convex)
          completeInk = inventory.box(
            Array.from(o.argsArray[p.i][2], (n, k) => n + (k < 2 ? -radius : radius)),
            matrix
          )
      }
      p.completePaint = !p.state.clip || inside(p.state.clip, completeInk)
      p.ink = p.state.clip
        ? [
            Math.max(q[0], p.state.clip[0]),
            Math.max(q[1], p.state.clip[1]),
            Math.min(q[2], p.state.clip[2]),
            Math.min(q[3], p.state.clip[3])
          ]
        : q
      p.blankBackdrop =
        p.color === '#ffffff' &&
        p.state.fillAlpha === 1 &&
        [OPS.fill, OPS.eoFill].includes(p.kind) &&
        p.path.length === 13 &&
        p.path[0] === 0 &&
        p.path.at(-1) === 4 &&
        [3, 6, 9].every((i) => p.path[i] === 1) &&
        p.path[1] === p.path[10] &&
        p.path[4] === p.path[7] &&
        p.path[2] === p.path[5] &&
        p.path[8] === p.path[11] &&
        inside(p.rect, form.rect) &&
        p.i === paints.find((q) => q.i > form.start && q.i < form.end)?.i
    }
    const visibleStroke = (p) =>
      p.i > form.start &&
      p.i < form.end &&
      p.completePaint &&
      p.state.strokeAlpha === 1 &&
      p.state.solidStroke === true &&
      strokeKinds.includes(p.kind)
    const samePoint = (a, b) => a.every((n, i) => close(n, b[i]))
    // Rules propose panel geometry. Each side must also be an actually painted,
    // opaque, solid, fully unclipped native segment in this very Form.
    if (
      !faces.every(([left, top, right, bottom]) =>
        [
          [
            [left, top],
            [left, bottom]
          ],
          [
            [left, bottom],
            [right, bottom]
          ]
        ].every(([a, b]) =>
          paints.some(
            (p) =>
              visibleStroke(p) &&
              p.endpoints &&
              ((samePoint(p.endpoints[0], a) && samePoint(p.endpoints[1], b)) ||
                (samePoint(p.endpoints[1], a) && samePoint(p.endpoints[0], b)))
          )
        )
      )
    )
      return
    const overlapsForm = proof.records.filter((r) =>
      r.operations.some((i) => i > form.start && i < form.end)
    )
    if (
      overlapsForm.some(
        (r) =>
          !r.operations.every((i) => i > form.start && i < form.end && textAlpha.get(i) === 1) ||
          !inside(form.rect, r.ink)
      )
    )
      return
    const own = overlapsForm,
      outside = own.filter((r) => !inside(f.rect, r.ink))
    const allowed = new Set(),
      newPaint = new Set(),
      packets = proof.packets.filter((p) => p.start > form.start && p.end < form.end)
    const sameMarker = (a, b) => {
      if (a.path.length !== b.path.length || a.path.length < 7) return false
      const normalize = (p) => {
        const r = p.rect,
          w = r[2] - r[0],
          h = r[3] - r[1]
        if (!(w > 0 && h > 0)) return
        const m = Util.transform(v.transform, p.state.transform),
          out = []
        for (let i = 0; i < p.path.length;) {
          const cmd = p.path[i++],
            n = cmd === 0 || cmd === 1 ? 1 : cmd === 2 ? 3 : cmd === 4 ? 0 : -1
          if (n < 0) return
          out.push(cmd)
          for (let k = 0; k < n; k++) {
            const q = [p.path[i++], p.path[i++]]
            if (!q.every(Number.isFinite)) return
            Util.applyTransform(q, m)
            out.push((q[0] - r[0]) / w, (q[1] - r[1]) / h)
          }
        }
        return out
      }
      const aa = normalize(a),
        bb = normalize(b)
      return (
        !!aa && !!bb && aa.length === bb.length && aa.every((n, i) => Math.abs(n - bb[i]) < 1e-4)
      )
    }
    const top = outside.filter((r) => r.rect[3] < f.rect[1])
    const legends = []
    for (const r of top) {
      const h = ctx.content.items[r.index].height,
        markers = paints.filter(
          (p) =>
            p.i > form.start &&
            p.i < form.end &&
            visibleStroke(p) &&
            p.state.fillAlpha === 1 &&
            [OPS.fillStroke, OPS.eoFillStroke].includes(p.kind) &&
            p.path.at(-1) === 4 &&
            p.rect[0] < r.rect[0] &&
            p.rect[2] < r.rect[0] &&
            r.rect[0] - p.rect[2] < h * 1.2 &&
            p.rect[3] - p.rect[1] < h * 1.5 &&
            Math.abs((p.rect[1] + p.rect[3] - r.rect[1] - r.rect[3]) / 2) < h * 0.4
        )
      if (markers.length !== 1) continue
      const key = markers[0],
        siblings = paints.filter(
          (p) =>
            p !== key &&
            p.i > form.start &&
            p.i < form.end &&
            p.kind === key.kind &&
            visibleStroke(p) &&
            p.state.fillAlpha === 1 &&
            p.color === key.color &&
            p.stroke === key.stroke &&
            sameMarker(p, key) &&
            faces.some((face) => inside(face, p.rect))
        )
      if (!faces.every((face) => siblings.some((p) => inside(face, p.rect)))) continue
      legends.push({ record: r, marker: key, siblingCount: siblings.length })
    }
    if (
      top.length >= 3 &&
      legends.length === top.length &&
      new Set(legends.map((z) => z.marker.i)).size === legends.length &&
      top.every((r) => close(r.rect[1], top[0].rect[1]) && close(r.rect[3], top[0].rect[3]))
    ) {
      for (const { record, marker } of legends) {
        allowed.add(record.index)
        newPaint.add(marker.i)
      }
    }
    const rotated = own.filter((r) => {
      const m = ctx.content.items[r.index].transform
      return (
        m[0] > 0 &&
        m[1] > 0 &&
        m[2] < 0 &&
        m[3] > 0 &&
        r.rect[1] > Math.max(...faces.map((f) => f[3]))
      )
    })
    const rotatedLinks = []
    for (const r of rotated) {
      const raw = ctx.content.items[r.index],
        h = raw.height,
        axis = faces.filter(
          (f) => r.rect[2] >= f[0] && r.rect[2] <= f[2] && r.rect[1] >= f[3] && r.rect[1] - f[3] < h
        )
      if (axis.length !== 1) continue
      const ticks = paints.filter(
        (p) =>
          p.i > form.start &&
          p.i < form.end &&
          visibleStroke(p) &&
          [OPS.stroke, OPS.fillStroke].includes(p.kind) &&
          p.endpoints &&
          close(p.endpoints[0][0], p.endpoints[1][0]) &&
          close(p.endpoints[0][1], axis[0][3]) &&
          p.endpoints[1][1] > p.endpoints[0][1] &&
          Math.abs(p.endpoints[1][0] - r.rect[2]) < h * 0.2 &&
          r.rect[1] >= p.endpoints[1][1] &&
          r.rect[1] - p.endpoints[1][1] < h * 0.2
      )
      if (ticks.length !== 1 || !legends.some((k) => k.record.text === r.text)) continue
      rotatedLinks.push({ record: r, face: faces.indexOf(axis[0]), tick: ticks[0] })
    }
    const groups = []
    if (
      rotatedLinks.length === rotated.length &&
      rotated.length >= faces.length * 3 &&
      new Set(rotatedLinks.map((l) => l.tick.i)).size === rotatedLinks.length
    ) {
      for (const l of rotatedLinks) allowed.add(l.record.index)
      for (let n = 0; n < faces.length; n++) {
        const row = rotatedLinks
            .filter((l) => l.face === n)
            .sort((a, b) => a.tick.rect[0] - b.tick.rect[0]),
          k = legends.length
        if (!k || row.length % k) continue
        for (let j = 0; j < row.length; j += k) {
          const run = row.slice(j, j + k)
          if (new Set(run.map((l) => l.record.text)).size !== k) continue
          const center = run.reduce((s, l) => s + l.tick.rect[0], 0) / k,
            bottom = Math.max(...run.map((l) => l.record.rect[3]))
          const labels = own.filter((r) => {
            const m = ctx.content.items[r.index].transform
            return (
              m[1] === 0 &&
              m[2] === 0 &&
              r.rect[1] > faces[n][3] &&
              r.rect[3] > bottom &&
              r.rect[3] - bottom < ctx.content.items[r.index].height &&
              Math.abs((r.rect[0] + r.rect[2]) / 2 - center) < 0.05
            )
          })
          if (labels.length === 1) groups.push({ record: labels[0], face: n, ordinal: j / k })
        }
      }
      for (const g of groups)
        if (
          groups.filter((q) => q.ordinal === g.ordinal && q.record.text === g.record.text)
            .length === faces.length
        )
          allowed.add(g.record.index)
    }
    for (const packet of packets.filter((p) => p.rect[3] > f.rect[3] && p.rect[1] < f.rect[3])) {
      const records = own.filter((r) =>
        r.operations.every((i) => i > packet.start && i < packet.end)
      )
      if (records.length < 3 || records.some((r) => allowed.has(r.index))) continue
      const face = faces.filter(
        (face) =>
          packet.rect[0] >= face[0] &&
          packet.rect[2] <= face[2] &&
          packet.rect[1] > face[3] &&
          !faces.some(
            (other) =>
              other !== face &&
              other[0] === face[0] &&
              other[3] > face[3] &&
              other[3] < packet.rect[1]
          )
      )
      if (face.length !== 1) continue
      const heights = records.map((r) => ctx.content.items[r.index].height),
        h = Math.max(...heights),
        small = records.filter((r, i) => heights[i] < h * 0.85 && heights[i] >= h * 0.5),
        base = records.filter((r, i) => Math.abs(heights[i] - h) < 1e-6)
      if (
        !small.length ||
        !base.length ||
        !base.every((r) => close(r.rect[3], base[0].rect[3])) ||
        small.some(
          (r) =>
            !base.some(
              (b) =>
                Math.abs(r.rect[0] - b.rect[2]) < h * 0.2 &&
                overlap([b.rect[0], b.rect[1], b.rect[2] + h * 0.2, b.rect[3]], r.rect)
            )
        )
      )
        continue
      const ticks = own.filter(
        (r) =>
          /^[-−]?\d+(?:\.\d+)?$/.test(r.text) &&
          r.rect[1] >= face[0][3] &&
          r.rect[1] - face[0][3] < ctx.content.items[r.index].height &&
          r.rect[0] >= face[0][0] &&
          r.rect[2] <= face[0][2]
      )
      if (
        ticks.length < 2 ||
        !ticks.every((r) => close(r.rect[3], ticks[0].rect[3])) ||
        Math.max(...ticks.map((r) => r.rect[2])) - Math.min(...ticks.map((r) => r.rect[0])) <
          (face[0][2] - face[0][0]) * 0.5 ||
        Math.abs((packet.rect[0] + packet.rect[2] - face[0][0] - face[0][2]) / 2) > h
      )
        continue
      for (const r of records) allowed.add(r.index)
    }
    const candidate = union([
        f.rect,
        ...outside.filter((r) => allowed.has(r.index)).flatMap((r) => [r.rect, r.ink]),
        ...paints.filter((p) => newPaint.has(p.i)).map((p) => p.ink)
      ]),
      padding = 2 / (Math.ceil(pageInput.width * 1.5) / pageInput.width),
      paintRect = candidate.map((n, i) => n + (i < 2 ? -padding : padding)),
      oldPaint = f.rect.map((n, i) => n + (i < 2 ? -padding : padding)),
      rejected = outside.filter((r) => !allowed.has(r.index)),
      foreign = proof.records.filter((r) => !own.includes(r) && overlap(paintRect, r.ink)),
      unprovedPaint = paints.filter(
        (p) =>
          !newPaint.has(p.i) &&
          !p.blankBackdrop &&
          inter(p.ink, paintRect) > inter(p.ink, oldPaint) + 1e-6
      )
    // The same native render must explain every newly exposed ink fragment,
    // including whitespace glyphs, images and graphics not represented by raw text.
    const ownedGlyphs = new Set(
      inventory.records.filter((r) => allowed.has(r.index)).flatMap((r) => r.part.map((p) => p.g))
    )
    if (
      inventory.glyphs.some(
        (g) => !ownedGlyphs.has(g) && inter(g.ink, paintRect) > inter(g.ink, oldPaint) + 1e-6
      ) ||
      e.images.some(
        (im) =>
          !inventory.valid(im.rect) || inter(im.rect, paintRect) > inter(im.rect, oldPaint) + 1e-6
      ) ||
      ctx.graphicsBounds.some((g) => {
        if (!inventory.valid(g.normalizedRect) || !Number.isSafeInteger(g.operationIndex))
          return true
        const q = g.normalizedRect.map((n, i) => n * (i % 2 ? pageInput.height : pageInput.width))
        if (inter(q, paintRect) <= inter(q, oldPaint) + 1e-6) return false
        return (
          !newPaint.has(g.operationIndex) &&
          !paints.some((p) => p.i === g.operationIndex && p.blankBackdrop)
        )
      })
    )
      return
    if (
      rejected.length ||
      foreign.length ||
      unprovedPaint.length ||
      !outside.length ||
      captions.some((cap) => cap.page === page && overlap(paintRect, cap.rect)) ||
      tables.some((t) => overlap(paintRect, t))
    )
      return
    // Reader independent navigation admits only this orthogonal cardinal basis.
    // Diagonal fonts stay in the original image and existing coverage exclusions;
    // they must not invalidate independently proved whole source-unit claims.
    const sourceItems = own
      .filter(({ index }) => {
        const item = ctx.content.items[index],
          style = ctx.content.styles?.[item.fontName]
        if (item.dir !== 'ltr' || style?.vertical || item.width <= 0) return false
        const [a, b, c, d] = item.transform,
          advance = Math.hypot(a, b),
          font = Math.hypot(c, d)
        if (advance <= 0 || font <= 0) return false
        const quarter = ((Math.round(Math.atan2(-b, a) / (Math.PI / 2)) % 4) + 4) % 4,
          [ux, uy] = [
            [1, 0],
            [0, 1],
            [-1, 0],
            [0, -1]
          ][quarter]
        return (
          Math.hypot(a / advance - ux, -b / advance - uy) <= 0.0001 &&
          Math.abs((a * c + b * d) / (advance * font)) <= 0.0001 &&
          a * d - b * c > 0
        )
      })
      .map(({ index }) => {
        const source = ctx.content.items[index].sourceItem
        return { pageNumber: source.pageNumber, index: source.index, text: source.text }
      })
      .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
    return { rect: candidate, sourceItems }
  } catch {
    return
  }
}
