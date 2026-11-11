/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone browser JavaScript. */
// Drawing kit for animation panels. A model writes only the body of draw(k); it runs every frame and must depend on k.t only.
// The kit draws in the house style (colours, fonts, line weights), reads the session's data, times things to the voice,
// and records what was drawn so the checks can report problems (errors, off-canvas drawing, colliding text, no motion).
;(() => {
  const TK = window.TOKENS
  const C = {
    ...TK.color,
    ...TK.videoExtensions,
    goldDeep: TK.color.accentText,
    grid: TK.color.border
  }
  const FONT = TK.font
  let offPalette = null // set per animation while it draws
  // a colour is on-brand when it is a palette colour or one of its tints (toward white) or shades (toward black);
  // natural subject colours count as palette colours. Anything else is reported.
  const col = (c, d) => {
    if (c == null) return d
    if (C[c]) return C[c]
    if (offPalette && !inFamily(c) && !offPalette.includes(c)) offPalette.push(c)
    return c
  }
  const EASE = {
    linear: (p) => p,
    in: (p) => p * p * p,
    out: (p) => 1 - Math.pow(1 - p, 3),
    inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outBack: (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2),
    outElastic: (p) =>
      p === 0 || p === 1
        ? p
        : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
  }
  // particle presets (any option can still be overridden): direction is a default, set angle for your case
  const PRESET = {
    exhaust: {
      rate: 160,
      life: 0.9,
      angle: 90,
      spread: 18,
      speed: 520,
      size: 10,
      grow: 34,
      color: 'sky',
      alpha: 0.55
    },
    smoke: {
      rate: 40,
      life: 2.2,
      angle: -90,
      spread: 40,
      speed: 60,
      size: 10,
      grow: 40,
      color: 'badgeBorder',
      alpha: 0.35
    },
    sparks: {
      rate: 120,
      life: 0.45,
      angle: -90,
      spread: 160,
      speed: 420,
      gravity: 900,
      size: 3,
      grow: 0,
      color: 'gold',
      alpha: 0.9
    },
    bubbles: {
      rate: 25,
      life: 2.0,
      angle: -90,
      spread: 20,
      speed: 90,
      size: 4,
      grow: 6,
      color: 'sky',
      alpha: 0.6
    },
    flow: {
      rate: 90,
      life: 1.1,
      angle: 0,
      spread: 8,
      speed: 300,
      size: 5,
      grow: 2,
      color: 'blue',
      alpha: 0.6
    },
    dust: {
      rate: 60,
      life: 1.0,
      angle: -90,
      spread: 120,
      speed: 160,
      gravity: 200,
      size: 6,
      grow: 22,
      color: 'line',
      alpha: 0.45
    }
  }
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
  const lerp = (a, b, p) => a + (b - a) * p
  const hash = (n) => {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  const probe = document.createElement('canvas').getContext('2d')
  const rgbOf = (c) => {
    if (typeof c !== 'string') return null
    probe.fillStyle = '#010203'
    probe.fillStyle = c
    const v = probe.fillStyle
    if (v === '#010203' && c.trim().toLowerCase() !== '#010203') return null
    if (v[0] === '#')
      return [
        parseInt(v.slice(1, 3), 16),
        parseInt(v.slice(3, 5), 16),
        parseInt(v.slice(5, 7), 16),
        1
      ]
    const m = v.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const q = m[1].split(',').map(Number)
    return [q[0], q[1], q[2], q[3] ?? 1]
  }
  const FAMILY = [...new Set(Object.values(C).concat(Object.values(TK.subjectColors || {})))]
    .map(rgbOf)
    .filter(Boolean)
  const inFamily = (c) => {
    const v = rgbOf(c)
    if (!v || v[3] === 0) return true // not a plain colour (gradient, pattern) or invisible
    for (const P of FAMILY)
      for (const T of [
        [255, 255, 255],
        [0, 0, 0]
      ]) {
        const d = [T[0] - P[0], T[1] - P[1], T[2] - P[2]],
          q = [v[0] - P[0], v[1] - P[1], v[2] - P[2]],
          L = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
        const a = L ? clamp((q[0] * d[0] + q[1] * d[1] + q[2] * d[2]) / L) : 0
        if (Math.hypot(q[0] - a * d[0], q[1] - a * d[1], q[2] - a * d[2]) <= 24) return true
      }
    return false
  }
  const mix = (name, to, a) => {
    const P = rgbOf(C[name] || name) || [17, 17, 17]
    return `rgb(${P.map((x, i) => Math.round(x + (to[i] - x) * clamp(a)))
      .slice(0, 3)
      .join(', ')})`
  }
  const strHash = (s) => {
    let x = 0
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 1000000007
    return x
  }

  // ---- typography: the named text styles, for canvas text (k.font) and HTML/SVG text (class "t-<style>") ----
  const famOf = (f) => String(f).split(',')[0].replace(/["']/g, '').trim().toLowerCase()
  const STYLES = Object.entries(TK.text).map(([n, s]) => ({
    n,
    size: s.size,
    fam: famOf(FONT[s.font] || FONT.sans)
  }))
  const styleOf = (size, family) =>
    STYLES.find((s) => Math.abs(s.size - size) < 0.6 && s.fam === famOf(family))
  {
    const css = Object.entries(TK.text)
      .map(
        ([n, s]) =>
          `.t-${n}{font-family:${FONT[s.font] || FONT.sans};font-size:${s.size}px;font-weight:${s.weight};` +
          `letter-spacing:${s.tracking ?? 0}px;line-height:${s.line ?? Math.round(s.size * 1.2)}px;${s.upper ? 'text-transform:uppercase;' : ''}color:${C[s.color] || s.color || C.ink}}`
      )
      .join('\n')
    const st = document.createElement('style')
    st.textContent =
      css + '\n.kit-layer{position:absolute;left:0;top:0;overflow:hidden;pointer-events:none}'
    document.head.append(st)
  }

  // ---- icons (Lucide, the design system's icon set): 24×24 outlines, 2px stroke ----
  const iconPath = (name) => {
    const d = (window.LUCIDE || {})[name]
    if (!d) {
      const near = Object.keys(window.LUCIDE || {})
        .filter((k2) => k2.includes(String(name).split('-')[0]))
        .slice(0, 8)
      throw new Error(
        `no icon '${name}'${near.length ? ` (similar: ${near.join(', ')})` : ''} — names at https://lucide.dev/icons`
      )
    }
    const P2 = new Path2D()
    for (const part of d) P2.addPath(new Path2D(part))
    return P2
  }
  // natural colours for subjects and generators (tokens.subjectColors), e.g. Rubik stickers, atoms
  const NAT = () => TK.subjectColors || {}

  // ---- subjects: designed once per case (subjects/<name>.json), drawn from parts in the house style ----
  // part types: profile (outline points, smoothed), circle, ellipse, rect, line (open polyline). Coordinates are in the subject's own box size [w, h].
  // rounded-corner path through the points: straight edges, each corner rounded by `round` (0 = sharp, 1 = fully round);
  // a point may carry its own amount as a third value: [x, y, 0] keeps that corner sharp. Never overshoots, never wobbles.
  function roundedPath(g, pts, closed, round) {
    const n = pts.length,
      P = (i) => pts[(i + n) % n]
    const cut = (a, b, f) => {
      const d = (Math.hypot(b[0] - a[0], b[1] - a[1]) / 2) * f
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      return [a[0] + ((b[0] - a[0]) * d) / L, a[1] + ((b[1] - a[1]) * d) / L]
    }
    const amt = (i) => clamp(pts[i][2] ?? round)
    if (!closed) {
      g.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < n - 1; i++) {
        const f = amt(i),
          a = cut(pts[i], pts[i - 1], f),
          b = cut(pts[i], pts[i + 1], f)
        g.lineTo(a[0], a[1])
        g.quadraticCurveTo(pts[i][0], pts[i][1], b[0], b[1])
      }
      g.lineTo(pts[n - 1][0], pts[n - 1][1])
      return
    }
    const start = cut(P(0), P(1), amt(0))
    g.moveTo(start[0], start[1])
    for (let i = 1; i <= n; i++) {
      const c = P(i),
        f = amt(i % n),
        a = cut(c, P(i - 1), f),
        b = cut(c, P(i + 1), f)
      g.lineTo(a[0], a[1])
      g.quadraticCurveTo(c[0], c[1], b[0], b[1])
    }
    g.closePath()
  }
  // expand mirrored parts: "mirror": "x" reflects across the vertical centre line of the subject box (left/right symmetric things)
  function partsOf(subj) {
    const out = []
    // mirror line: subj.mirrorAt, else the centre line of the main silhouette (the first profile part)
    let mx = subj.mirrorAt
    if (mx == null) {
      const main = subj.parts.find((q) => q.type === 'profile') || subj.parts[0]
      const xs = main.points
        ? main.points.map((v) => v[0])
        : [main.x - (main.r || main.rx || 0), main.x + (main.r || main.rx || main.w || 0)]
      mx = (Math.min(...xs) + Math.max(...xs)) / 2
    }
    for (const q of subj.parts) {
      out.push(q)
      if (q.mirror === 'x') {
        const f = (x) => 2 * mx - x,
          m = { ...q, mirror: null }
        if (q.points) m.points = q.points.map(([x, y]) => [f(x), y]).reverse()
        if (q.x != null) m.x = q.type === 'rect' ? 2 * mx - q.x - q.w : f(q.x)
        if (q.rotate) m.rotate = -q.rotate
        out.push(m)
      }
    }
    return out
  }
  // natural colours (tokens.subjectColors) are allowed inside subjects only
  const subjCol = (col) => (c, d) =>
    c && TK.subjectColors && TK.subjectColors[c] ? TK.subjectColors[c] : col(c, d)
  // the drawing's own bounds in subject coordinates (strokes included): subjects are fitted to these, so no box tuning is needed
  function boundsOf(subj) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity
    const add = (a, b, c, d, pad) => {
      x0 = Math.min(x0, a - pad)
      y0 = Math.min(y0, b - pad)
      x1 = Math.max(x1, c + pad)
      y1 = Math.max(y1, d + pad)
    }
    for (const q of partsOf(subj)) {
      const pad = (q.stroke || q.type === 'line' ? (q.width ?? 3) : 0) / 2
      if (q.points)
        add(
          Math.min(...q.points.map((v) => v[0])),
          Math.min(...q.points.map((v) => v[1])),
          Math.max(...q.points.map((v) => v[0])),
          Math.max(...q.points.map((v) => v[1])),
          pad
        )
      else if (q.type === 'circle') add(q.x - q.r, q.y - q.r, q.x + q.r, q.y + q.r, pad)
      else if (q.type === 'icon')
        add(q.x - q.size / 2, q.y - q.size / 2, q.x + q.size / 2, q.y + q.size / 2, 1)
      else if (q.type === 'rect') add(q.x, q.y, q.x + q.w, q.y + q.h, pad)
      else if (q.type === 'ellipse') {
        const a = q.rotate || 0,
          hx = Math.hypot(q.rx * Math.cos(a), q.ry * Math.sin(a)),
          hy = Math.hypot(q.rx * Math.sin(a), q.ry * Math.cos(a))
        add(q.x - hx, q.y - hy, q.x + hx, q.y + hy, pad)
      }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  function renderSubject(g, subj, col0, onBox) {
    const col = subjCol(col0)
    for (const q of partsOf(subj)) {
      const fill = q.fill ? col(q.fill) : null,
        stroke = q.stroke ? col(q.stroke) : null
      g.save()
      g.globalAlpha *= q.alpha ?? 1
      g.lineWidth = q.width ?? 3
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.beginPath()
      if (q.type === 'profile' || q.type === 'line') {
        const closed = q.type === 'profile',
          pts = q.points
        roundedPath(g, pts, closed, q.round ?? (closed ? 0.6 : 0.8))
        if (onBox)
          onBox(
            Math.min(...pts.map((v) => v[0])),
            Math.min(...pts.map((v) => v[1])),
            Math.max(...pts.map((v) => v[0])),
            Math.max(...pts.map((v) => v[1]))
          )
      } else if (q.type === 'circle') {
        g.arc(q.x, q.y, q.r, 0, 2 * Math.PI)
        if (onBox) onBox(q.x - q.r, q.y - q.r, q.x + q.r, q.y + q.r)
      } else if (q.type === 'ellipse') {
        g.ellipse(q.x, q.y, q.rx, q.ry, q.rotate || 0, 0, 2 * Math.PI)
        if (onBox)
          onBox(
            q.x - Math.max(q.rx, q.ry),
            q.y - Math.max(q.rx, q.ry),
            q.x + Math.max(q.rx, q.ry),
            q.y + Math.max(q.rx, q.ry)
          )
      } else if (q.type === 'rect') {
        g.roundRect ? g.roundRect(q.x, q.y, q.w, q.h, q.radius || 0) : g.rect(q.x, q.y, q.w, q.h)
        if (onBox) onBox(q.x, q.y, q.x + q.w, q.y + q.h)
      } else if (q.type === 'icon') {
        if (onBox) onBox(q.x - q.size / 2, q.y - q.size / 2, q.x + q.size / 2, q.y + q.size / 2)
        const sc = q.size / 24
        g.translate(q.x - q.size / 2, q.y - q.size / 2)
        g.scale(sc, sc)
        g.lineWidth = (q.width ?? 2 * sc) / sc
        g.strokeStyle = stroke || col('ink')
        if (fill) {
          g.fillStyle = fill
          g.fill(iconPath(q.name))
        }
        g.stroke(iconPath(q.name))
        g.restore()
        continue
      }
      if (fill && q.type !== 'line') {
        g.fillStyle = fill
        g.fill()
      }
      if (stroke || q.type === 'line') {
        g.strokeStyle = stroke || col('ink')
        g.stroke()
      }
      g.restore()
    }
  }

  // ---- data tables (preloaded by the build from the session's CSV files) ----
  function table(name, cols, n) {
    const T = {
      name,
      rows: n,
      columns: Object.keys(cols),
      col(c) {
        if (!(c in cols))
          throw new Error(
            `data '${name}': no column '${c}' (columns: ${Object.keys(cols).join(', ')})`
          )
        return cols[c]
      },
      where(cond) {
        const keep = []
        for (let i = 0; i < n; i++)
          if (Object.entries(cond).every(([c, v]) => T.col(c)[i] == v)) keep.push(i)
        if (!keep.length) throw new Error(`data '${name}': no rows where ${JSON.stringify(cond)}`)
        return table(
          name,
          Object.fromEntries(Object.entries(cols).map(([c, a]) => [c, keep.map((i) => a[i])])),
          keep.length
        )
      },
      min(c) {
        return Math.min(...T.col(c).filter((v) => v != null))
      },
      max(c) {
        return Math.max(...T.col(c).filter((v) => v != null))
      },
      first(c) {
        return T.col(c)[0]
      },
      last(c) {
        return T.col(c)[n - 1]
      },
      // value of column y where column x == xv (linear interpolation; x must increase)
      at(y, x, xv) {
        const X = T.col(x),
          Y = T.col(y)
        if (xv <= X[0]) return Y[0]
        for (let i = 1; i < n; i++)
          if (X[i] >= xv) {
            const f = (xv - X[i - 1]) / (X[i] - X[i - 1] || 1)
            return lerp(Y[i - 1], Y[i], f)
          }
        return Y[n - 1]
      }
    }
    return T
  }

  // ---- cue resolution (same syntax as the spec): "1", "1+0.4", "1:thrust", "1.end", "end-1.5" ----
  function cueTime(cue, sc) {
    if (typeof cue === 'number') return cue
    const m = String(cue).match(/^(end|\d+)(\.end|:([^\s+-]+))?([+-]\d+(?:\.\d+)?)?$/)
    if (!m) throw new Error(`bad cue '${cue}' (use e.g. "1", "1:thrust", "1.end+0.3", "end-1")`)
    const off = parseFloat(m[4] || 0)
    if (m[1] === 'end') return sc.dur + off
    const ln = sc.lines[+m[1]]
    if (!ln) throw new Error(`cue '${cue}': the scene has lines 0–${sc.lines.length - 1}`)
    if (!m[2]) return ln.t0 + off
    if (m[2] === '.end') return ln.t1 + off
    const key = m[3].toLowerCase().replace(/[^\w.%,]/g, '')
    const w = ln.words.find((x) =>
      x[0]
        .toLowerCase()
        .replace(/[^\w.%,]/g, '')
        .startsWith(key)
    )
    if (!w)
      throw new Error(
        `cue '${cue}': no word starting with '${m[3]}' in line ${m[1]} ("${ln.caption}")`
      )
    return w[1] + off
  }

  // ---- one animation = one canvas + a compiled draw(k) ----
  function create(box, p, ctx) {
    const tall = ctx.tall
    const size = p.size || 'wide'
    const dims = tall
      ? {
          wide: [900, 760],
          square: [900, 860],
          tall: [860, 980],
          slim: [900, 300],
          band: [900, 320]
        }
      : {
          wide: [1240, 600],
          square: [760, 660],
          tall: [620, 700],
          slim: [460, 600],
          band: [1240, 260]
        }
    const [W, H] =
      (ctx.layout === 'row' || ctx.layout === 'side') && !tall
        ? [Math.min(dims[size][0], 760), dims[size][1]]
        : dims[size]
    const dpr = window.devicePixelRatio || 1
    const cv = window.A.h('canvas', {
      width: W * dpr,
      height: H * dpr,
      style: { width: `${W}px`, height: `${H}px`, display: 'block' }
    })
    const g = cv.getContext('2d')
    // the open layer: HTML, inline SVG, CSS (3D transforms included) and canvases of its own (e.g. WebGL), same size as the canvas
    const layer = window.A.h('div', {
      class: 'kit-layer',
      style: { width: `${W}px`, height: `${H}px` }
    })
    const wrap = window.A.h('div', {
      style: { position: 'relative', width: `${W}px`, height: `${H}px` }
    })
    wrap.append(cv, layer)
    box.append(wrap)
    // the video clock: inside a script, Math.random is seeded per frame, the wall clock and timers are unavailable
    let seed = 1
    const MATH = Object.create(Math)
    MATH.random = () => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }
    const wall = (what) => () => {
      throw new Error(
        `${what} runs on the wall clock — drive everything from k.t, so every render is the same`
      )
    }
    const NoDate = function () {
      throw new Error('Date is the wall clock — use k.t (seconds into the scene)')
    }
    NoDate.now = wall('Date.now()')
    // the raw canvas is open too; its colours, gradient stops and text are recorded for the checks
    const CP = CanvasRenderingContext2D.prototype
    let inner = false,
      rawText = () => {}
    for (const prop of ['fillStyle', 'strokeStyle', 'shadowColor']) {
      const d0 = Object.getOwnPropertyDescriptor(CP, prop)
      Object.defineProperty(g, prop, {
        configurable: true,
        get() {
          return d0.get.call(g)
        },
        set(v) {
          if (!inner && typeof v === 'string') col(v)
          d0.set.call(g, v)
        }
      })
    }
    for (const m of ['createLinearGradient', 'createRadialGradient', 'createConicGradient'])
      if (CP[m])
        g[m] = (...a) => {
          const gr = CP[m].apply(g, a),
            add = gr.addColorStop.bind(gr)
          gr.addColorStop = (o, c) => {
            col(c)
            add(o, c)
          }
          return gr
        }
    for (const m of ['fillText', 'strokeText'])
      g[m] = (s, x, y, mw) => {
        if (!inner) rawText(String(s), x, y)
        return mw == null ? CP[m].call(g, s, x, y) : CP[m].call(g, s, x, y, mw)
      }
    const persist = {}
    let fn = null,
      compileError = null
    fn = window.VIDEO_ANIMATIONS?.[p.code]
    if (!fn) compileError = 'Animation function is missing'
    const diag = {
      errors: compileError ? [compileError] : [],
      outside: [],
      textHits: [],
      small: [],
      last: [],
      frames: 0,
      cover: 0,
      offPalette: [],
      freeText: []
    }
    const sc = ctx.scene
    const tables = window.DATA.tables || {}
    const cache = {}

    function draw(t) {
      offPalette = diag.offPalette
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      if (!fn) return
      const texts = []
      diag.last = []
      const occ = new Uint8Array(16 * 10)
      const track = (x0, y0, x1, y1, what) => {
        const m = g.getTransform(),
          pts = [
            [x0, y0],
            [x1, y0],
            [x0, y1],
            [x1, y1]
          ].map(([x, y]) => [(m.a * x + m.c * y + m.e) / dpr, (m.b * x + m.d * y + m.f) / dpr])
        const xs = pts.map((q) => q[0]),
          ys = pts.map((q) => q[1])
        const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        // occupancy on a 16×10 grid: cells covered by drawn shapes (thin lines count only where they run)
        if ((r[2] - r[0] < W * 0.98 || r[3] - r[1] < H * 0.98) && g.globalAlpha > 0.2) {
          const c0 = Math.max(0, Math.floor((r[0] / W) * 16)),
            c1 = Math.min(15, Math.floor((r[2] / W) * 16)),
            r0 = Math.max(0, Math.floor((r[1] / H) * 10)),
            r1 = Math.min(9, Math.floor((r[3] / H) * 10))
          for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) occ[cy * 16 + cx] = 1
        }
        const over = Math.max(-r[0], -r[1], r[2] - W, r[3] - H)
        if (
          over > 4 &&
          !k._cam &&
          diag.outside.length < 12 &&
          !diag.outside.some(
            (o) => o.what.replace(/[\d.,]+/g, '#') === what.replace(/[\d.,]+/g, '#')
          )
        )
          diag.outside.push({ what, by: Math.round(over), t: +t.toFixed(2) })
        return r
      }
      const style = (o, defFill, defStroke) => {
        g.globalAlpha = clamp(o.alpha ?? 1) * (k._alpha ?? 1)
        g.setLineDash(o.dash ? (Array.isArray(o.dash) ? o.dash : [10, 8]) : [])
        g.lineWidth = o.width ?? 3
        g.lineCap = 'round'
        g.lineJoin = 'round'
        if (o.shadow) {
          g.shadowColor = 'rgba(0,0,0,.18)'
          g.shadowBlur = 18
          g.shadowOffsetY = 6
        } else {
          g.shadowColor = 'transparent'
          g.shadowBlur = 0
          g.shadowOffsetY = 0
        }
        return {
          fill: o.fill === undefined ? defFill : o.fill && col(o.fill),
          stroke: o.stroke === undefined ? defStroke : o.stroke && col(o.stroke)
        }
      }
      const paint = (s) => {
        if (s.fill) {
          g.fillStyle = s.fill
          g.fill()
        }
        if (s.stroke) {
          g.strokeStyle = s.stroke
          g.stroke()
        }
        g.globalAlpha = 1
        g.shadowColor = 'transparent'
      }

      // text drawn on the raw canvas: it must use a named style (k.font(name)); recorded for overlap and number checks
      rawText = (s, x, y) => {
        const m = /([\d.]+)px\s+(.+)$/.exec(g.font) || [],
          size = +m[1] || 0
        if (!styleOf(size, m[2] || '') && diag.freeText.length < 8 && !diag.freeText.includes(s))
          diag.freeText.push(s)
        if (size && size < TK.minTextSize && !diag.small.includes(s)) diag.small.push(s)
        if (!diag.last.includes(s)) diag.last.push(s)
        const w = CP.measureText.call(g, s).width,
          al = g.textAlign,
          bl = g.textBaseline
        const x0 = al === 'center' ? x - w / 2 : al === 'right' || al === 'end' ? x - w : x,
          y0 = bl === 'top' || bl === 'hanging' ? y : bl === 'middle' ? y - size / 2 : y - size
        if (g.globalAlpha > 0.5)
          texts.push({ str: s, r: track(x0, y0, x0 + w, y0 + size, `text "${s.slice(0, 24)}"`) })
      }
      // styled text (internal): every visible word goes through a named style from tokens.json
      const txt = (str, x, y, styleName, o = {}) => {
        const T0 = TK.text[styleName] || TK.text.body
        str = T0.upper ? String(str).toUpperCase() : String(str)
        const size = o.size ?? T0.size
        if (size < TK.minTextSize && !diag.small.includes(str)) diag.small.push(str)
        g.globalAlpha = clamp(o.alpha ?? 1) * (k._alpha ?? 1)
        g.font = `${o.weight ?? T0.weight} ${size}px ${FONT[o.font || T0.font] || FONT.sans}`
        g.letterSpacing = `${T0.tracking}px`
        g.fillStyle = col(o.color, col(T0.color))
        g.shadowColor = 'transparent'
        g.textAlign = o.align || 'left'
        g.textBaseline = o.baseline || 'middle'
        const w = g.measureText(str).width,
          x0 = g.textAlign === 'center' ? x - w / 2 : g.textAlign === 'right' ? x - w : x
        const y0 =
          g.textBaseline === 'top'
            ? y
            : g.textBaseline === 'bottom' || g.textBaseline === 'alphabetic'
              ? y - size
              : y - size / 2
        if (!diag.last.includes(str)) diag.last.push(str)
        if ((o.alpha ?? 1) * (k._alpha ?? 1) > 0.5)
          texts.push({ str, r: track(x0, y0, x0 + w, y0 + size, `text "${str.slice(0, 24)}"`) })
        inner = true
        g.fillText(str, x, y)
        inner = false
        g.globalAlpha = 1
        g.letterSpacing = '0px'
        return w
      }
      const k = {
        t,
        W,
        H,
        tall,
        C,
        ease: EASE,
        clamp,
        lerp,
        start: p.t_in,
        local: t - p.t_in,
        sceneEnd: sc.dur,
        // the full toolset: the raw 2D canvas (already cleared and scaled; save/restore around your own transforms) and the open layer
        ctx: g,
        dom: layer,
        // build things once (DOM nodes, SVG, a WebGL scene, precomputed geometry) and update them every frame from k.t
        once: (key, make) => (key in persist ? persist[key] : (persist[key] = make())),
        // typography and colour: named styles and the palette families
        font: (name) => {
          const s = TK.text[name]
          if (!s)
            throw new Error(`no text style '${name}' (styles: ${Object.keys(TK.text).join(', ')})`)
          return `${s.weight} ${s.size}px ${FONT[s.font] || FONT.sans}`
        },
        color: (name) => {
          if (!C[name])
            throw new Error(`no palette colour '${name}' (colours: ${Object.keys(C).join(', ')})`)
          return C[name]
        },
        tint: (name, a) => mix(name, [255, 255, 255], a),
        shade: (name, a) => mix(name, [0, 0, 0], a),
        // the case's assets (cases/<case>/assets/): SVG markup to inline, decoded images to draw, or a URL
        svg: (name) => {
          const s = (window.DATA.svgs || {})[name]
          if (s == null)
            throw new Error(
              `no SVG asset '${name}' (assets: ${(window.DATA.assets || []).join(', ') || 'none'})`
            )
          return s
        },
        image: (name) => {
          const im = (window.__assetImages || {})[name]
          if (!im)
            throw new Error(
              `no image asset '${name}' (assets: ${(window.DATA.assets || []).join(', ') || 'none'})`
            )
          return im
        },
        asset: (name) => `assets/${name}`,
        cue: (c) => cueTime(c, sc),
        // progress 0→1 of time through [a, b] (numbers or cues), eased
        seg(a, b, e = 'inOut') {
          const A0 = cueTime(a, sc),
            B0 = cueTime(b, sc)
          return (EASE[e] || EASE.inOut)(clamp((t - A0) / (B0 - A0 || 1e-6)))
        },
        since: (c) => t - cueTime(c, sc),
        wave: (period = 1, phase = 0) => Math.sin((t / period + phase) * 2 * Math.PI),
        rand: (seed) => hash(seed),
        // gravity: drop from rest at height h0 (m) for dt seconds → { h, v (m/s, down), landed, tLand }
        fall(h0, dt, gAcc = 9.81) {
          const tLand = Math.sqrt((2 * h0) / gAcc),
            u = clamp(dt, 0, tLand)
          return { h: h0 - 0.5 * gAcc * u * u, v: gAcc * u, landed: dt >= tLand, tLand }
        },
        data(name) {
          if (!cache[name]) {
            const d = tables[name]
            if (!d)
              throw new Error(
                `no data '${name}' — list it in the panel's "data" (available: ${Object.keys(tables).join(', ') || 'none'})`
              )
            cache[name] = table(name, d.cols, d.n)
          }
          return cache[name]
        },
        // value that follows the voice: keys [[cue or seconds, value], ...] → value now (eased between keys, held outside them).
        // Use it to map data time (or any quantity) so the data's key moments land on the words that name them.
        timeline(keys, e = 'linear') {
          const ks = keys.map(([c, v]) => [cueTime(c, sc), v]).sort((a, b) => a[0] - b[0])
          if (t <= ks[0][0]) return ks[0][1]
          for (let i = 1; i < ks.length; i++)
            if (t <= ks[i][0])
              return lerp(
                ks[i - 1][1],
                ks[i][1],
                (EASE[e] || EASE.linear)(
                  clamp((t - ks[i - 1][0]) / (ks[i][0] - ks[i - 1][0] || 1e-6))
                )
              )
          return ks.at(-1)[1]
        },
        // number counting from a to b with progress p, formatted with d decimals and thousands commas
        count: (a, b, p, d = 0) =>
          lerp(a, b, clamp(p)).toLocaleString('en-US', {
            minimumFractionDigits: d,
            maximumFractionDigits: d
          }),
        // canvas split into a main area (the subject) and a side column (readouts) — side by side in 16:9, stacked in 9:16
        areas(o = {}) {
          const m = o.margin ?? 30,
            gap = 24,
            f = o.main ?? 0.62
          if (!tall && W > H * 1.15) {
            const mw = (W - 2 * m - gap) * f
            return {
              main: { x: m, y: m, w: mw, h: H - 2 * m },
              side: { x: m + mw + gap, y: m, w: W - 2 * m - gap - mw, h: H - 2 * m }
            }
          }
          const mh = (H - 2 * m - gap) * f
          return {
            main: { x: m, y: m, w: W - 2 * m, h: mh },
            side: { x: m, y: m + mh + gap, w: W - 2 * m, h: H - 2 * m - gap - mh }
          }
        },
        // a metric (design system rule: the value sits directly above its label). o: { tone, small, align }. Returns the height used.
        metric(x, y, value, label, o = {}) {
          const vs = o.small ? 'valueSm' : 'value',
            V = TK.text[vs],
            Lb = TK.text.label
          txt(String(value), x, y, vs, {
            color: o.tone,
            align: o.align,
            baseline: 'top',
            alpha: o.alpha
          })
          txt(label, x, y + V.line + 4, 'label', {
            align: o.align,
            baseline: 'top',
            alpha: o.alpha
          })
          return V.line + 4 + Lb.line
        },
        // live readouts: rows [[label, value, tone?], ...] — data-style values above small labels; returns the height used
        readouts(x, y, rows, o = {}) {
          const D = TK.text.data,
            Lb = TK.text.label,
            gap = o.gap ?? 18
          let yy = y
          for (const [lab, val, tone] of rows) {
            txt(String(val), x, yy, 'data', { color: tone, baseline: 'top', alpha: o.alpha })
            txt(lab, x, yy + D.line + 4, 'label', { baseline: 'top', alpha: o.alpha })
            yy += D.line + 4 + Lb.line + gap
          }
          return yy - y - gap
        },
        // small comparison bars inside an animation: items [{ label, value, display, tone }], grown by o.p (0→1)
        bars(x, y, w, items, o = {}) {
          const max = o.max ?? Math.max(...items.map((i) => i.value)),
            bh = o.height ?? 32,
            Lb = TK.text.label,
            p = o.p ?? 1
          let yy = y
          for (const it of items) {
            txt(it.label, x, yy, 'label', { baseline: 'top' })
            const by = yy + Lb.line + 6
            k.rect(x, by, w, bh, { fill: 'track', radius: bh / 2 })
            const vw = Math.max(bh, w * clamp(it.value / max) * clamp(p)),
              inside = x + vw + 130 > x + w
            if (p > 0) k.rect(x, by, vw, bh, { fill: it.tone || 'gold', radius: bh / 2 })
            txt(
              it.display ?? String(it.value),
              inside ? x + 14 : x + vw + 12,
              by + bh / 2,
              'dataSm',
              {
                color: inside
                  ? ['gold', 'goldSoft', 'track', 'sky'].includes(it.tone || 'gold')
                    ? 'ink'
                    : 'paper'
                  : 'ink'
              }
            )
            yy = by + bh + 20
          }
          return yy - y - 20
        },
        // emphasis for a key event (impact, success, failure, breakthrough): rings + rays expanding with p (0→1)
        burst(x, y, p, o = {}) {
          if (p <= 0 || p >= 1) return
          const r = (o.size ?? 90) * EASE.out(p),
            c = o.tone || 'gold'
          k.circle(x, y, r, { fill: null, stroke: c, width: 6 * (1 - p) + 1, alpha: 1 - p })
          k.circle(x, y, r * 0.6, {
            fill: null,
            stroke: c,
            width: 4 * (1 - p) + 1,
            alpha: (1 - p) * 0.7
          })
          for (let i = 0; i < (o.rays ?? 10); i++) {
            const a = (i / (o.rays ?? 10)) * 2 * Math.PI + 0.3
            k.line(
              x + Math.cos(a) * r * 0.75,
              y + Math.sin(a) * r * 0.75,
              x + Math.cos(a) * r * 1.15,
              y + Math.sin(a) * r * 1.15,
              { stroke: c, width: 4, alpha: 1 - p }
            )
          }
        },
        // screen shake after an event: returns [dx, dy] that fade out over the shake; p is 0→1 through it
        shake(p, amount = 10) {
          if (p <= 0 || p >= 1) return [0, 0]
          const a = amount * (1 - p)
          return [a * Math.sin(p * 61), a * Math.cos(p * 47)]
        },
        // a grid of n cells (trials, wells, samples, pixels) inside a box: calls fn(i, x, y, size) for each cell
        grid(x, y, w, h, n, fn, o = {}) {
          const cols = o.cols ?? Math.ceil(Math.sqrt((n * w) / h)),
            rows = Math.ceil(n / cols),
            gap = o.gap ?? 6
          const s0 = Math.min((w - gap * (cols - 1)) / cols, (h - gap * (rows - 1)) / rows)
          const ox = x + (w - (cols * s0 + gap * (cols - 1))) / 2,
            oy = y + (h - (rows * s0 + gap * (rows - 1))) / 2
          for (let i = 0; i < n; i++)
            fn(i, ox + (i % cols) * (s0 + gap), oy + Math.floor(i / cols) * (s0 + gap), s0)
        },
        // a Lucide icon (design system icon set), centred on (x, y), `size` px. o: { color (default ink), fill, width (stroke px, default size/12), alpha }
        icon(name, x, y, size, o = {}) {
          const P2 = iconPath(name),
            sc = size / 24
          track(x - size / 2, y - size / 2, x + size / 2, y + size / 2, `icon ${name}`)
          g.save()
          g.globalAlpha = clamp(o.alpha ?? 1) * (k._alpha ?? 1)
          g.translate(x - size / 2, y - size / 2)
          g.scale(sc, sc)
          g.lineWidth = (o.width ?? size / 12) / sc
          g.lineCap = 'round'
          g.lineJoin = 'round'
          if (o.fill) {
            g.fillStyle = col(o.fill)
            g.fill(P2)
          }
          g.strokeStyle = col(o.color, C.ink)
          g.stroke(P2)
          g.restore()
        },
        // GENERATOR · a Rubik-style cube, n×n×n, in 3D, centred on (x, y), `size` px across.
        // o: { n (3), yaw, pitch (radians; default a ¾ view), turn: { axis: 'x'|'y'|'z', layer: index 0..n-1, angle (radians) },
        //      stickers: { U, D, F, B, L, R: [n*n colour names] } (default solved), gap (0.08) }
        cube(x, y, size, o = {}) {
          const n = o.n ?? 3,
            N = NAT()
          const DEF = {
            U: 'surface',
            D: 'goldSoft',
            F: N.red || '#C0392B',
            B: 'warn',
            L: 'blue',
            R: N.leaf || '#4E8A3E'
          }
          const yaw = o.yaw ?? -0.62,
            pitch = o.pitch ?? 0.52,
            gap = o.gap ?? 0.08,
            h0 = (n - 1) / 2
          const rot = (v, ax, a) => {
            const [c, s0] = [Math.cos(a), Math.sin(a)]
            const [X, Y, Z] = v
            return ax === 'x'
              ? [X, Y * c - Z * s0, Y * s0 + Z * c]
              : ax === 'y'
                ? [X * c + Z * s0, Y, -X * s0 + Z * c]
                : [X * c - Y * s0, X * s0 + Y * c, Z]
          }
          const view = (v) => rot(rot(v, 'y', yaw), 'x', pitch)
          const unit = size / (n * 1.75)
          const faces = []
          const FACE = {
            U: [[0, -1, 0], (i, j) => j === 0, (i, j, k2) => i + k2 * n],
            D: [[0, 1, 0], (i, j) => j === n - 1, (i, j, k2) => i + (n - 1 - k2) * n],
            F: [[0, 0, -1], (i, j, k2) => k2 === 0, (i, j) => i + j * n],
            B: [[0, 0, 1], (i, j, k2) => k2 === n - 1, (i, j) => n - 1 - i + j * n],
            L: [[-1, 0, 0], (i) => i === 0, (i, j, k2) => n - 1 - k2 + j * n],
            R: [[1, 0, 0], (i) => i === n - 1, (i, j, k2) => k2 + j * n]
          }
          for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++)
              for (let k2 = 0; k2 < n; k2++) {
                const c0 = [i - h0, j - h0, k2 - h0]
                const t = o.turn,
                  inLayer = t && { x: i, y: j, z: k2 }[t.axis] === t.layer
                for (const [fk, [nv, has, idx]] of Object.entries(FACE)) {
                  if (!has(i, j, k2)) continue
                  // face corners in cubie-local space
                  const ax = nv[0] ? 0 : nv[1] ? 1 : 2,
                    u = [0, 1, 2].filter((q) => q !== ax)
                  const corner = (a, b) => {
                    const v = [...c0]
                    v[ax] += nv[ax] * 0.5
                    v[u[0]] += a * (0.5 - gap / 2)
                    v[u[1]] += b * (0.5 - gap / 2)
                    return v
                  }
                  let pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
                    nrm = nv
                  if (inLayer) {
                    pts = pts.map((v) => rot(v, t.axis, t.angle))
                    nrm = rot(nv, t.axis, t.angle)
                  }
                  const nvw = view(nrm)
                  if (nvw[2] >= -0.02) continue // facing away
                  const pv = pts.map(view),
                    depth = pv.reduce((a2, v) => a2 + v[2], 0) / 4
                  const st =
                    (o.stickers && o.stickers[fk] && o.stickers[fk][idx(i, j, k2)]) || DEF[fk]
                  faces.push({
                    pv,
                    depth,
                    color: N[st] || st,
                    shade: 0.75 + 0.25 * Math.abs(nvw[1] < 0 ? -nvw[1] : nvw[2])
                  })
                }
              }
          // body (black core) then stickers, back to front
          faces.sort((a2, b2) => b2.depth - a2.depth)
          for (const f of faces) {
            const P = f.pv.map(([X, Y]) => [x + X * unit, y + Y * unit])
            k.poly(P, { close: true, fill: 'ink', stroke: 'ink', width: unit * gap * 1.6 })
            k.poly(P, { close: true, fill: f.color, alpha: 1 })
            k.poly(P, { close: true, fill: '#000', alpha: (1 - f.shade) * 0.6 })
          }
        },
        // GENERATOR · a network: layers (e.g. [4, 6, 6, 3], drawn left→right) or a radial cluster (o.nodes).
        // o: { layers, nodes, w, h, seed, p (0→1 grows in), pulse (0→1 signal travelling left→right), active: [node indices], tone }
        network(x, y, w, h, o = {}) {
          const pts = [],
            edges = [],
            seed = o.seed ?? 5
          if (o.layers) {
            o.layers.forEach((cnt, li) => {
              for (let q = 0; q < cnt; q++)
                pts.push({
                  x: x + (o.layers.length === 1 ? w / 2 : (li / (o.layers.length - 1)) * w),
                  y: y + (cnt === 1 ? h / 2 : (q / (cnt - 1)) * h),
                  l: li
                })
            })
            for (let a2 = 0; a2 < pts.length; a2++)
              for (let b2 = 0; b2 < pts.length; b2++)
                if (pts[b2].l === pts[a2].l + 1 && hash(a2 * 31 + b2 + seed) < (o.density ?? 0.7))
                  edges.push([a2, b2])
          } else {
            const n0 = o.nodes ?? 24
            for (let q = 0; q < n0; q++) {
              const a3 = q * 2.39996 + hash(q + seed),
                r3 = Math.sqrt((q + 0.5) / n0)
              pts.push({
                x: x + w / 2 + (Math.cos(a3) * r3 * w) / 2,
                y: y + h / 2 + (Math.sin(a3) * r3 * h) / 2,
                l: 0
              })
            }
            for (let a2 = 0; a2 < n0; a2++) {
              const near = pts
                .map((q, b2) => [Math.hypot(q.x - pts[a2].x, q.y - pts[a2].y), b2])
                .sort((u1, u2) => u1[0] - u2[0])
                .slice(1, 3)
              for (const [, b2] of near) if (a2 < b2) edges.push([a2, b2])
            }
          }
          const p = o.p ?? 1,
            act = new Set(o.active || []),
            layersN = o.layers ? o.layers.length : 1
          for (const [a2, b2] of edges) {
            const A2 = pts[a2],
              B2 = pts[b2],
              ep = clamp(p * 1.4 - (A2.l / Math.max(1, layersN)) * 0.4)
            if (ep <= 0) continue
            k.line(A2.x, A2.y, lerp(A2.x, B2.x, ep), lerp(A2.y, B2.y, ep), {
              stroke: act.has(a2) && act.has(b2) ? o.tone || 'gold' : 'line',
              width: act.has(a2) && act.has(b2) ? 3 : 1.5,
              alpha: 0.8
            })
            if (o.pulse != null && o.layers) {
              const pu = o.pulse * (layersN - 1) - A2.l
              if (pu > 0 && pu < 1)
                k.circle(lerp(A2.x, B2.x, pu), lerp(A2.y, B2.y, pu), 3.5, {
                  fill: o.tone || 'gold'
                })
            }
          }
          pts.forEach((q, i3) => {
            const np = clamp(p * 1.4 - (q.l / Math.max(1, layersN)) * 0.4)
            if (np > 0)
              k.circle(q.x, q.y, (o.r ?? 9) * EASE.outBack(np), {
                fill: act.has(i3) ? o.tone || 'gold' : 'ink',
                stroke: 'surface',
                width: 2
              })
          })
          return pts
        },
        // GENERATOR · a molecule from atoms + bonds, fitted into a box centred on (x, y), `size` px across.
        // atoms: [{ el: 'C'|'O'|'N'|'H'|'S'|'P'|…, x, y }] (any units), bonds: [[i, j, order]]. o: { rotate, p (0→1 grows in), labels }
        molecule(x, y, size, atoms, bonds = [], o = {}) {
          const N = NAT(),
            EL = {
              C: 'ink',
              O: N.red || '#C0392B',
              N: 'blue',
              H: 'surface',
              S: 'goldSoft',
              P: N.amber || '#C98A2B',
              Cl: N.leaf || '#4E8A3E',
              F: N.leaf || '#4E8A3E'
            }
          const R0 = { H: 0.55, C: 0.8, N: 0.8, O: 0.8 }
          const xs = atoms.map((a2) => a2.x),
            ys = atoms.map((a2) => a2.y),
            cx0 = (Math.min(...xs) + Math.max(...xs)) / 2,
            cy0 = (Math.min(...ys) + Math.max(...ys)) / 2
          const span =
              Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1) + 2,
            sc = size / span,
            rr = o.rotate || 0,
            p = o.p ?? 1
          const P = atoms.map((a2) => {
            const dx = a2.x - cx0,
              dy = a2.y - cy0
            return [
              x + (dx * Math.cos(rr) - dy * Math.sin(rr)) * sc,
              y + (dx * Math.sin(rr) + dy * Math.cos(rr)) * sc
            ]
          })
          for (const [i3, j3, ord = 1] of bonds) {
            const [a2, b2] = [P[i3], P[j3]],
              bp = clamp(p * 1.5 - 0.3)
            if (bp <= 0) continue
            const nx = -(b2[1] - a2[1]),
              ny = b2[0] - a2[0],
              L = Math.hypot(nx, ny) || 1,
              off = sc * 0.13
            for (let m = 0; m < ord; m++) {
              const s3 = (m - (ord - 1) / 2) * off
              k.line(
                a2[0] + (nx / L) * s3,
                a2[1] + (ny / L) * s3,
                lerp(a2[0], b2[0], bp) + (nx / L) * s3,
                lerp(a2[1], b2[1], bp) + (ny / L) * s3,
                { stroke: 'steel', width: Math.max(2, sc * 0.08) }
              )
            }
          }
          atoms.forEach((a2, i3) => {
            const ap = clamp(p * 1.5 - (i3 / atoms.length) * 0.5)
            if (ap <= 0) return
            const r3 = sc * 0.38 * (R0[a2.el] ?? 0.9) * EASE.outBack(ap)
            k.circle(P[i3][0], P[i3][1], r3, {
              fill: EL[a2.el] || 'steel',
              stroke: a2.el === 'H' ? 'line' : null,
              width: 2
            })
            if (o.labels !== false && a2.el !== 'C' && a2.el !== 'H' && r3 > 14)
              txt(a2.el, P[i3][0], P[i3][1] + 1, 'tag', {
                align: 'center',
                color: a2.el === 'S' ? 'ink' : 'paper'
              })
          })
        },
        // a designed subject (subjects/<name>.json): drawn centred on (x, y), `width` px wide. o: { flip, rotate, alpha }
        subject(name, x, y, width, o = {}) {
          const S0 = (window.DATA.subjects || {})[name]
          if (!S0)
            throw new Error(
              `no subject '${name}' (available: ${Object.keys(window.DATA.subjects || {}).join(', ') || 'none'})`
            )
          const B = boundsOf(S0),
            sc = width / B.w,
            h0 = B.h * sc
          k.group({ x, y, rotate: o.rotate, alpha: o.alpha }, () => {
            g.save()
            g.scale(o.flip ? -sc : sc, sc)
            g.translate(-(B.x + B.w / 2), -(B.y + B.h / 2))
            g.globalAlpha = clamp(o.alpha ?? 1) * (k._alpha ?? 1)
            renderSubject(g, S0, col, (x0, y0, x1, y1) => track(x0, y0, x1, y1, `subject ${name}`))
            g.restore()
          })
          return { w: width, h: h0 }
        },
        // where a named point of a subject (its "anchors", e.g. a nozzle or a wheel) lands when drawn with k.subject(name, x, y, width)
        anchor(name, key, x, y, width, o = {}) {
          const S0 = (window.DATA.subjects || {})[name],
            a = S0 && S0.anchors && S0.anchors[key]
          if (!a)
            throw new Error(
              `subject '${name}' has no anchor '${key}' (anchors: ${Object.keys((S0 && S0.anchors) || {}).join(', ') || 'none'})`
            )
          const B = boundsOf(S0),
            sc = width / B.w
          return [
            x + (o.flip ? -1 : 1) * (a[0] - (B.x + B.w / 2)) * sc,
            y + (a[1] - (B.y + B.h / 2)) * sc
          ]
        },
        // shapes · o: { fill, stroke, width, alpha, dash, shadow }
        rect(x, y, w, h, o = {}) {
          const s = style(o, C.ink, null)
          track(x, y, x + w, y + h, 'rect')
          g.beginPath()
          g.roundRect ? g.roundRect(x, y, w, h, o.radius ?? 0) : g.rect(x, y, w, h)
          paint(s)
        },
        circle(x, y, r, o = {}) {
          const s = style(o, C.ink, null)
          track(x - r, y - r, x + r, y + r, 'circle')
          g.beginPath()
          g.arc(x, y, Math.max(0, r), 0, 2 * Math.PI)
          paint(s)
        },
        ellipse(x, y, rx, ry, o = {}) {
          const s = style(o, C.ink, null)
          track(x - rx, y - ry, x + rx, y + ry, 'ellipse')
          g.beginPath()
          g.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), o.rotate || 0, 0, 2 * Math.PI)
          paint(s)
        },
        line(x1, y1, x2, y2, o = {}) {
          const s = style(o, null, C.ink)
          track(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), 'line')
          g.beginPath()
          g.moveTo(x1, y1)
          g.lineTo(x2, y2)
          paint(s)
        },
        // points [[x,y],...]; o.close fills a shape; o.smooth draws a curve through the points
        poly(pts, o = {}) {
          if (!pts.length) return
          const s = style(o, o.close ? C.ink : null, o.close ? null : C.ink)
          track(
            Math.min(...pts.map((q) => q[0])),
            Math.min(...pts.map((q) => q[1])),
            Math.max(...pts.map((q) => q[0])),
            Math.max(...pts.map((q) => q[1])),
            'poly'
          )
          g.beginPath()
          g.moveTo(pts[0][0], pts[0][1])
          if (o.smooth && pts.length > 2) {
            for (let i = 1; i < pts.length - 1; i++) {
              const mx = (pts[i][0] + pts[i + 1][0]) / 2,
                my = (pts[i][1] + pts[i + 1][1]) / 2
              g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my)
            }
            g.lineTo(pts.at(-1)[0], pts.at(-1)[1])
          } else for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
          if (o.close) g.closePath()
          paint(s)
        },
        // SVG path data, drawn at (x, y) with scale; o.box = [w, h] of the path's own coordinates, for the off-canvas check
        path(d, x = 0, y = 0, scale = 1, o = {}) {
          const s = style(o, C.ink, null)
          g.save()
          g.translate(x, y)
          g.scale(scale, scale)
          if (o.box) track(0, 0, o.box[0], o.box[1], 'path')
          g.lineWidth = (o.width ?? 3) / scale
          const P = new Path2D(d)
          if (s.fill) {
            g.fillStyle = s.fill
            g.fill(P)
          }
          if (s.stroke) {
            g.strokeStyle = s.stroke
            g.stroke(P)
          }
          g.restore()
          g.globalAlpha = 1
        },
        arrow(x1, y1, x2, y2, o = {}) {
          const s = style(o, null, C.ink),
            a = Math.atan2(y2 - y1, x2 - x1),
            hd = o.head ?? 16
          track(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), 'arrow')
          g.beginPath()
          g.moveTo(x1, y1)
          g.lineTo(x2, y2)
          g.moveTo(x2 - hd * Math.cos(a - 0.45), y2 - hd * Math.sin(a - 0.45))
          g.lineTo(x2, y2)
          g.lineTo(x2 - hd * Math.cos(a + 0.45), y2 - hd * Math.sin(a + 0.45))
          paint(s)
        },
        // text in a named style (tokens.json): o: { style, color, align: left|center|right, baseline: middle|top|bottom, alpha }
        // styles: display, section, cardTitle, value, valueSm, heading, body, label, eyebrow, data, dataSm, tag
        text(str, x, y, o = {}) {
          if (
            (o.size != null || o.font != null || o.weight != null) &&
            diag.freeText.length < 8 &&
            !diag.freeText.includes(String(str))
          )
            diag.freeText.push(String(str))
          return txt(str, x, y, o.style || 'body', o)
        },
        // small pill tag: tone ink|gold|good|bad|muted|paper
        label(str, x, y, o = {}) {
          const T0 = TK.text.tag,
            tone = o.tone || 'ink'
          g.font = `${T0.weight} ${T0.size}px ${FONT[T0.font]}`
          const w = g.measureText(String(str)).width + T0.size * 1.2,
            h = T0.size * 1.75
          const x0 = o.align === 'left' ? x : o.align === 'right' ? x - w : x - w / 2
          k.rect(x0, y - h / 2, w, h, {
            fill: tone === 'paper' ? 'surface' : tone === 'muted' ? 'badgeBorder' : tone,
            stroke: tone === 'paper' ? 'border' : null,
            width: 1.5,
            radius: h / 2,
            alpha: o.alpha,
            shadow: o.shadow
          })
          txt(str, x0 + w / 2, y + 1, 'tag', {
            align: 'center',
            color: ['gold', 'paper', 'muted', 'goldSoft'].includes(tone) ? 'ink' : 'paper',
            alpha: o.alpha
          })
          return w
        },
        // a card in the house style (white surface, border, soft shadow, rounded): optional eyebrow/title; returns the inner box
        card(x, y, w, h, o = {}) {
          const pad = o.pad ?? 28
          k.rect(x, y, w, h, {
            fill: 'surface',
            stroke: 'border',
            width: 1.5,
            radius: TK.radius.inner,
            shadow: true,
            alpha: o.alpha
          })
          let iy = y + pad
          if (o.eyebrow) {
            txt(o.eyebrow, x + pad, iy, 'eyebrow', { baseline: 'top', alpha: o.alpha })
            iy += TK.text.eyebrow.line + 10
          }
          if (o.title) {
            txt(o.title, x + pad, iy, 'cardTitle', { baseline: 'top', alpha: o.alpha })
            iy += TK.text.cardTitle.line + 12
          }
          return { x: x + pad, y: iy, w: w - 2 * pad, h: y + h - pad - iy }
        },
        // brand motif · concentric rings (design system): grows in with o.p; o: { n, tone, alpha, width }
        rings(x, y, r, o = {}) {
          const n = o.n ?? 4,
            p = o.p ?? 1
          for (let i = 1; i <= n; i++) {
            const pi = clamp(p * n - (i - 1))
            if (pi > 0)
              k.circle(x, y, ((r * i) / n) * EASE.out(pi), {
                fill: null,
                stroke: o.tone || 'border',
                width: o.width ?? 2,
                alpha: (o.alpha ?? 1) * pi
              })
          }
        },
        // brand motif · sparse connected nodes around a core (design system): radial links from (x, y) to n dots; o: { n, seed, p, tone }
        nodes(x, y, r, o = {}) {
          const n = o.n ?? 10,
            p = o.p ?? 1,
            seed = o.seed ?? 3
          for (let i = 0; i < n; i++) {
            const a = (i / n) * 2 * Math.PI + hash(i + seed) * 0.5,
              rr = r * (0.55 + 0.45 * hash(i * 3 + seed)),
              pi = clamp(p * n * 0.6 - i * 0.6 + 0.6)
            if (pi <= 0) continue
            const nx = x + Math.cos(a) * rr * EASE.out(pi),
              ny = y + Math.sin(a) * rr * EASE.out(pi)
            k.line(x, y, nx, ny, {
              stroke: o.tone || 'border',
              width: 1.5,
              alpha: (o.alpha ?? 1) * pi
            })
            k.circle(nx, ny, 3 + 4 * hash(i + seed * 7), {
              fill: o.tone === 'gold' && i % 3 === 0 ? 'gold' : 'ink',
              alpha: (o.alpha ?? 1) * pi
            })
          }
        },
        // stamped verdict that pops in with progress p (0→1): tone good|bad
        stamp(str, x, y, p, o = {}) {
          if (p <= 0) return
          const sc2 = lerp(1.6, 1, EASE.outBack(clamp(p)))
          k.group({ x, y, scale: sc2 * 1.25, alpha: clamp(p * 2), rotate: o.rotate ?? -0.05 }, () =>
            k.label(`${o.tone === 'bad' ? '✕' : '✓'} ${str}`, 0, 0, {
              tone: o.tone || 'good',
              shadow: true
            })
          )
        },
        // bar gauge: value 0→1 · o: { tone, label, vertical, track }
        gauge(x, y, w, h, value, o = {}) {
          const v = clamp(value)
          k.rect(x, y, w, h, { fill: o.track || 'track', radius: Math.min(w, h) / 2 })
          if (v > 0.002)
            o.vertical
              ? k.rect(x, y + h * (1 - v), w, h * v, { fill: o.tone || 'gold', radius: w / 2 })
              : k.rect(x, y, w * v, h, { fill: o.tone || 'gold', radius: h / 2 })
          if (o.label)
            txt(o.label, o.vertical ? x + w / 2 : x, o.vertical ? y + h + 22 : y - 18, 'label', {
              align: o.vertical ? 'center' : 'left'
            })
        },
        // camera: brings (o.x, o.y) to the canvas centre (or o.to: [x, y]) at o.zoom (1 = as drawn); what runs past the
        // canvas edge inside it is cropped by the shot, not reported. Draw readouts and labels after it, outside the camera.
        camera(o, fn2) {
          const z = o.zoom ?? 1,
            [tx, ty] = o.to || [W / 2, H / 2]
          g.save()
          g.beginPath()
          g.rect(0, 0, W, H)
          g.clip()
          g.translate(tx, ty)
          g.scale(z, z)
          g.translate(-(o.x ?? W / 2), -(o.y ?? H / 2))
          const pc = k._cam
          k._cam = true
          try {
            fn2()
          } finally {
            k._cam = pc
            g.restore()
          }
        },
        // transforms: everything drawn inside fn is moved / scaled / rotated (radians) / faded together
        group(o, fn2) {
          g.save()
          g.translate(o.x || 0, o.y || 0)
          if (o.rotate) g.rotate(o.rotate)
          if (o.scale != null) g.scale(o.scale, o.scaleY ?? o.scale)
          const pa = k._alpha
          k._alpha = (pa ?? 1) * (o.alpha ?? 1)
          try {
            fn2()
          } finally {
            k._alpha = pa
            g.restore()
          }
        },
        // deterministic particles (exhaust, sparks, flow, dust). Each particle is born at time te and lives `life` seconds.
        // o: { from: te => [x, y] (emitter position at birth), on: te => bool (emitting?), rate (per s), life, angle (deg, 90 = down),
        //      spread (deg), speed (px/s), gravity (px/s²), size, grow (size gained over life), color, alpha, seed }
        particles(o) {
          o = { ...(PRESET[o.preset] || {}), ...o }
          const rate = o.rate ?? 60,
            life = o.life ?? 1,
            seed = o.seed ?? 1
          for (let n = Math.ceil((t - life) * rate); n <= Math.floor(t * rate); n++) {
            const te = n / rate,
              age = t - te
            if (age < 0 || te < 0 || (o.on && !o.on(te))) continue
            const r1 = hash(n * 7.1 + seed),
              r2 = hash(n * 3.7 + seed * 2),
              r3 = hash(n * 1.3 + seed * 3)
            const [x0, y0] = o.from ? o.from(te) : [W / 2, H / 2]
            const ang = (((o.angle ?? 90) + (r1 - 0.5) * (o.spread ?? 30)) * Math.PI) / 180,
              sp = (o.speed ?? 200) * (0.6 + 0.8 * r2)
            let x = x0 + Math.cos(ang) * sp * age,
              y = y0 + Math.sin(ang) * sp * age + 0.5 * (o.gravity ?? 0) * age * age
            if (o.floor != null && y > o.floor) {
              const over = y - o.floor
              y = o.floor - over * 0.15
              x += (r3 < 0.5 ? -1 : 1) * over * 0.9
            }
            const f = age / life,
              size = (o.size ?? 10) + (o.grow ?? 20) * f
            g.globalAlpha = clamp((o.alpha ?? 0.5) * (1 - f)) * (k._alpha ?? 1)
            g.fillStyle = col(o.color, C.sky)
            g.beginPath()
            g.arc(x, y, size, 0, 2 * Math.PI)
            g.fill()
          }
          g.globalAlpha = 1
        }
      }

      seed = 1 // the same sequence every frame: Math.random() gives a stable pattern, not flicker (vary on purpose with k.rand(n))
      try {
        fn(
          k,
          MATH,
          NoDate,
          { now: () => t * 1000 },
          wall('requestAnimationFrame'),
          wall('setTimeout'),
          wall('setInterval')
        )
      } catch (e) {
        const msg = String((e && e.message) || e)
        if (!diag.errors.includes(msg)) diag.errors.push(msg)
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, W, H)
      }
      if (window.__CHECK) {
        scanLayer(t, texts, occ)
        pixelCells(occ)
      }
      // text that collides with other text
      for (let i = 0; i < texts.length; i++)
        for (let j = i + 1; j < texts.length; j++) {
          const a = texts[i].r,
            b = texts[j].r,
            ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]),
            oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
          const area = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
          if (ox > 2 && oy > 2 && ox * oy > 0.15 * area) {
            const key = `"${texts[i].str}" / "${texts[j].str}"`,
              shape = key.replace(/[\d.,]+/g, '#')
            if (diag.textHits.length < 10 && !diag.textHits.some((x) => x.shape === shape))
              diag.textHits.push({ key, shape, t: +t.toFixed(2) })
          }
        }
      diag.cover = Math.max(diag.cover, occ.reduce((a, b) => a + b, 0) / occ.length)
      diag.frames++
    }
    const signature = () => {
      const d = g.getImageData(0, 0, cv.width, cv.height).data
      let s = 0,
        ink = 0
      for (let i = 0; i < d.length; i += 64) {
        s = (s * 31 + d[i] + d[i + 1] * 3 + d[i + 3] * 7) % 1000000007
        if (d[i + 3] > 10) ink++
      }
      if (layer.firstChild) {
        s = (s * 31 + strHash(layer.innerHTML)) % 1000000007
        ink += layer.querySelectorAll('*').length
      }
      return { s, ink }
    }
    // cells of the 16×10 occupancy grid with visible canvas pixels (whatever drew them)
    const pixelCells = (occ) => {
      const d = g.getImageData(0, 0, cv.width, cv.height).data,
        cw = cv.width,
        ch = cv.height
      for (let cy = 0; cy < 10; cy++)
        for (let cx = 0; cx < 16; cx++) {
          if (occ[cy * 16 + cx]) continue
          let hit = 0
          for (let sy = 1; sy < 6 && !hit; sy++)
            for (let sx = 1; sx < 6 && !hit; sx++) {
              const px = Math.floor(((cx + sx / 6) * cw) / 16),
                py = Math.floor(((cy + sy / 6) * ch) / 10)
              if (d[(py * cw + px) * 4 + 3] > 40) hit = 1
            }
          if (hit) occ[cy * 16 + cx] = 1
        }
    }
    // the open layer, measured as rendered: overflow, text styles and overlaps, numbers, colours, occupancy, CSS clocks
    const scanLayer = (t, texts, occ) => {
      if (!layer.firstChild) return
      const Lr = layer.getBoundingClientRect()
      if (!Lr.width) return
      const s = Lr.width / W
      if (
        layer.getAnimations &&
        layer.getAnimations({ subtree: true }).length &&
        !diag.errors.some((e) => e.startsWith('CSS animation'))
      )
        diag.errors.push(
          'CSS animations/transitions run on the wall clock — set styles from k.t every frame instead'
        )
      for (const el of layer.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue
        const R = el.getBoundingClientRect()
        if (R.width * R.height < 1) continue
        const r = [
            (R.left - Lr.left) / s,
            (R.top - Lr.top) / s,
            (R.right - Lr.left) / s,
            (R.bottom - Lr.top) / s
          ],
          tag = el.tagName.toLowerCase()
        const over = Math.max(-r[0], -r[1], r[2] - W, r[3] - H)
        if (
          over > 4 &&
          !el.closest('[data-crop]') &&
          diag.outside.length < 12 &&
          !diag.outside.some((o) => o.what === `<${tag}>`)
        )
          diag.outside.push({ what: `<${tag}>`, by: Math.round(over), t: +t.toFixed(2) })
        if (r[2] - r[0] < W * 0.98 || r[3] - r[1] < H * 0.98) {
          const c0 = Math.max(0, Math.floor((r[0] / W) * 16)),
            c1 = Math.min(15, Math.floor((r[2] / W) * 16)),
            r0 = Math.max(0, Math.floor((r[1] / H) * 10)),
            r1 = Math.min(9, Math.floor((r[3] / H) * 10))
          for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) occ[cy * 16 + cx] = 1
        }
        for (const prop of ['color', 'backgroundColor', 'fill', 'stroke', 'borderTopColor']) {
          const v = cs[prop]
          if (v && v !== 'none' && !/^url/.test(v)) col(v)
        }
        if (cs.backgroundImage && cs.backgroundImage !== 'none')
          (cs.backgroundImage.match(/rgba?\([^)]*\)/g) || []).forEach((c) => col(c))
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === 3 && n.textContent.trim())
          .map((n) => n.textContent.trim())
          .join(' ')
        if (own) {
          let size = parseFloat(cs.fontSize)
          if (el instanceof SVGElement && el.getScreenCTM) {
            const m = el.getScreenCTM()
            if (m) size *= Math.hypot(m.a, m.b) / s
          }
          if (
            !styleOf(size, cs.fontFamily) &&
            diag.freeText.length < 8 &&
            !diag.freeText.includes(own)
          )
            diag.freeText.push(own)
          if (size < TK.minTextSize - 0.5 && !diag.small.includes(own)) diag.small.push(own)
          if (!diag.last.includes(own)) diag.last.push(own)
          if (+cs.opacity > 0.5) texts.push({ str: own, r })
        }
      }
    }
    return { draw, diag, signature, W, H }
  }

  window.Kit = {
    create,
    C,
    renderSubject: (g, subj) => renderSubject(g, subj, col),
    partsOf,
    boundsOf
  }
})()
