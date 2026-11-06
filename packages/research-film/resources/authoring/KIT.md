# Animation panels: the full toolset, and the drawing kit

An **animation panel** is the scene's hero visual: the thing the research is about, moving the way the session's data says. Examples: a vehicle lifting off a test pad, a tank draining, cells dividing, a robot arm reaching, a network learning.

You write **one JavaScript file per animation**. The file is the _body_ of `draw(k)`. It runs every frame, and everything it shows must follow from `k.t` (seconds since the scene started).

**Supported drawing surfaces:** the packaged drawing kit, raw Canvas through `k.ctx`, and inline SVG/HTML through `k.dom`. Create reusable DOM or geometry with `k.once(key, () => ...)`, then update it from `k.t` on every frame. The host invokes this code inside the isolated browser stage; return the requested file body, not commands or setup instructions.

The current application does not stage custom libraries, an animation asset directory or subject manifests. Do not use `libs`, `k.svg`, `k.image`, `k.asset`, `k.subject` or `k.anchor` for missing resources. Define recurring subjects as JavaScript functions in a shared `use` file (section 8). Session figures are separate, host-staged resources; CSV examples below require an explicitly supplied CSV.

**Authoring requirements:**

- **Clock:** derive motion from `k.t` and narration cues; use `k.rand(seed)` for reproducible variation. No imports, network calls, wall-clock timers, CSS animations or transitions.
- **Typography:** use named styles through `k.text`, `k.font` or the stage's text classes. Keep text legible at playback size.
- **Colours:** use the packaged palette and its tint/shade families.
- **Frame:** keep content within the panel except for intentional camera cropping. Leave room for captions, labels and margins.

These are visual requirements, not a promise of automatic visual certification. The runtime validates source structure, cues and JavaScript syntax; review the rendered result for layout, motion and factual accuracy.

## The style standard: fixed for every video

The packaged `resources/stage/tokens.json` supplies the palette, typography and spacing used by the stage and drawing helpers. Reuse those helpers. Company and product names are "AIPOCH" and "Open-Science".

| Visual requirement                                                                                            | Your choice per case                                  |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Colours** by role from the palette below, with their tints and shades                                       | What you draw and how: kit, raw canvas, SVG, HTML/CSS |
| **Text** only in the named styles below; avoid arbitrary sizes and fonts                                      | Which panels, how many, where                         |
| **Cards** in the house look: `k.card()` inside drawings, panels outside                                       | How to split the frame (`k.areas`, your own split)    |
| **Metrics:** the value sits directly above its label (`k.metric`, `k.readouts`)                               | Readouts in a panel or drawn in a card                |
| **Size:** text ≥ 20 px, 30 px margins, the drawing fills its canvas                                           | Shapes, icons, motifs, gradients, textures, depth     |
| **Motion:** cubic eases, entrances about 0.45 s, key moments on their words                                   | Pace and order of what appears                        |
| **Brand:** "AIPOCH" in one uppercase word, "Open-Science" with a hyphen, the logo never redrawn or recoloured | Whether to use the brand motifs                       |

**Colours (by role):**

| Name                                       | Value                                         | Role                                                        |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------- |
| `ink`                                      | #111111                                       | structure, subjects, primary text                           |
| `text2 / muted`                            | #61615C / #6B6B66                             | supporting text, labels                                     |
| `gold`                                     | #EDB732                                       | the **one** thing to look at                                |
| `goldSoft / goldDeep / accentSoft`         | #FBDD67 / #915600 / #FFF1D6                   | softer highlight, gold text, badges                         |
| `good / bad`                               | #147047 / #B42318                             | pass and fail **only**                                      |
| `warn`                                     | #F06E14                                       | attention, a limit being approached                         |
| `info`                                     | #759EB8                                       | informational marks                                         |
| `surface / canvas / border / track / line` | white / #F7F7F5 / #E7E5DE / #F1F0EC / #C9C6BC | cards, backgrounds, dividers, empty bars, rulers and ground |
| `blue *`                                   | #1F5FBF                                       | data lines, measured series                                 |
| `sky *`                                    | #BFDDF0                                       | air, gas, water, exhaust                                    |
| `steel *`                                  | #5C6670                                       | machinery, hardware parts                                   |

\* video extensions (the design system has no equivalent).

**Text styles** (`k.text(str, x, y, { style })`; panels use the same):

| Style       | Look                    | Use                                                |
| ----------- | ----------------------- | -------------------------------------------------- |
| `display`   | Georgia 400 · 88 px     | hero titles (design system: Display · Hero XL)     |
| `section`   | Georgia 400 · 56 px     | section titles, big statements (Display · Hero)    |
| `cardTitle` | Georgia 400 · 36 px     | card headings (Display · Section/Card)             |
| `value`     | Georgia 400 · 56 px     | the key number of a metric (value above its label) |
| `valueSm`   | Georgia 400 · 36 px     | secondary metric values                            |
| `heading`   | Inter 600 · 30 px       | names of things, panel headings (UI Heading)       |
| `body`      | Inter 400 · 26 px       | short explanations (Body Large)                    |
| `label`     | Inter 500 · 22 px       | labels under values, legends (UI Label)            |
| `eyebrow`   | Roboto Mono 500 · 20 px | section markers, card eyebrows (Meta Eyebrow)      |
| `data`      | Roboto Mono 700 · 28 px | live readouts, measured values (MetaData)          |
| `dataSm`    | Roboto Mono 500 · 22 px | units, axis ticks, small data                      |
| `tag`       | Inter 600 · 22 px       | pill tags and stamps                               |

## 1 · Add the panel to the scene

```json
{ "type": "animation", "script": "anims/tank.js", "data": ["tank_level.csv"], "size": "wide" }
```

- `script` is relative to `video.json`.
- `data` lists the session **CSV** files you read with `k.data(name)` (CSV only). Leave it out when the numbers come from the messages.
- Like every panel, it takes `at` / `until` cues. By default it appears at the scene's first line.
- `size` sets the canvas:

  | `size`   | 16:9     | 9:16    |
  | -------- | -------- | ------- |
  | `wide`   | 1240×600 | 900×760 |
  | `square` | 760×660  | 900×860 |
  | `tall`   | 620×700  | 860×980 |
  | `slim`   | 460×600  | 900×300 |
  | `band`   | 1240×260 | 900×320 |

  In a `"layout": "row"` or `"side"` scene in 16:9, the width is at most 760.
  - `slim` is a narrow subject beside cards in 16:9 and a short strip above them in 9:16. Use it with `"layout": "side"`.
  - `band` is a short, wide strip, e.g. under a `title`.

- The panel sits on a white card; `"box": "plain"` drops the card (e.g. a subject floating under a title). It can share the scene with other panels (a `verdict` under it, a `bars` next to it), but the animation should carry the scene.
- **Subject beside its cards:** `"layout": "side"` puts the first panel (the animation) on the left and stacks the scene's other panels to its right in 16:9; in 9:16 everything stacks.
- **A subject or setup that recurs across scenes** (the same vehicle, rig, organism): draw it once in a shared file and list it in each panel's `use`; it runs before the scene's script, so the script can call what it defines.
  ```json
  { "type": "animation", "script": "anims/failure.js", "use": ["anims/stand.js"], "size": "slim" }
  ```
  Define the recurring subject in `anims/stand.js`; each scene script calls the same function with its own state.

## 2 · Coordinates and time

- **Canvas:** `k.W × k.H` px. (0,0) is the top-left, y grows downward.
  - Always place things relative to `k.W` / `k.H`, never fixed numbers: the same code runs in both 16:9 and 9:16, and `k.tall` is true in 9:16.
  - Keep a 30 px margin.
- **`k.t`**: seconds since the scene began.
  - The panel appears at `k.start`; `k.local = k.t - k.start`.
  - The scene ends at `k.sceneEnd`.
- **`k.cue("1:thrust")`**: when the voice reaches a word, in scene seconds. Cue syntax:

  | Cue        | Meaning                                                                                                 |
  | ---------- | ------------------------------------------------------------------------------------------------------- |
  | `"0"`      | line 0 starts                                                                                           |
  | `"1+0.4"`  | 0.4 s after line 1 starts                                                                               |
  | `"1:word"` | when line 1 reaches "word" (first caption word starting with it; numbers work too: `"1:4.4"`, `"1:22"`) |
  | `"1.end"`  | line 1 ends                                                                                             |
  | `"end-1"`  | 1 s before the scene ends                                                                               |

- **Times are cues or plain numbers.** Every function that takes a cue also takes a number of seconds (scene time).
- **`k.seg(a, b, ease?)`**: progress 0→1 of time through `[a, b]`. `a`/`b` are seconds or cues. Eases: `"linear"`, `"in"`, `"out"`, `"inOut"` (default), `"outBack"`, `"outElastic"`.
- **`k.since(cue)`**: seconds since a cue (negative before it).
- **Maths helpers:**
  - `k.lerp(a, b, p)`, `k.clamp(x, lo=0, hi=1)`
  - `k.wave(period, phase)`: a sine from −1 to 1
  - `k.rand(seed)`: a fixed 0–1 number per seed
  - `k.fall(h0, dt)`: a drop from rest from height `h0` (m), `dt` seconds after release. Returns `{ h, v, landed, tLand }`: height now (m, reaches 0), speed now (m/s), `landed` once `dt ≥ tLand`, and the fall time.
  - `k.count(a, b, p, decimals)`: a number counting from a to b as p goes 0→1. Returns a **string** formatted with commas (draw it with `k.text`).
- **`k.timeline([[cue, value], ...], ease?)`** (ease defaults to `"linear"`): a value that follows the voice. Use it to map _data time_ onto the scene, so each key moment in the data lands exactly on the word that names it:
  `const tt = k.timeline([["0", 0], ["0:runs", 3.37], ["1:drops", 3.37]])`
  Data time runs 0→3.37 until the voice says "runs", then holds until "drops".

**When the voice names two linked events far apart** (e.g. "the gas runs out…" then, seconds later, "…it drops"): show the first on its word and _hold that state_ (a sputtering plume, a "gas out" tag) until the second's word, then play the second. Mark held time with a small tag if it matters ("time held").

**Sync to the voice (the voice wins):** the moment the voice names something, it happens on screen. Compress or stretch the less important stretches around those moments with `k.timeline`. Never let the picture run ahead of or behind the words.

## 3 · Data

```js
const run = k.data('tank_level.csv').where({ trial: 2 }) // rows of trial 2
run.col('level_m') // the whole column (array)
run.at('level_m', 'time_s', 3.5) // level at time 3.5 s (interpolated)
;(run.min('level_m'),
  run.max('level_m'),
  run.first('time_s'),
  run.last('time_s'),
  run.rows,
  run.columns)
```

Numbers you _draw as text_ must come from the session: its messages, the scene's `cite` list, or the data.

- Live readouts that change every frame (a running timer, a draining gauge) are fine.
- Readouts that hold still must match the session after rounding.

## 4 · Drawing

Every shape takes an options object `o`:

| Option   | Meaning                               |
| -------- | ------------------------------------- |
| `fill`   | fill colour                           |
| `stroke` | outline colour                        |
| `width`  | line width (default 3)                |
| `alpha`  | opacity, 0–1                          |
| `dash`   | `true` or `[10, 8]` for a dashed line |
| `shadow` | `true` adds a soft drop shadow        |
| `radius` | rounded corners (rect only)           |

**Colours** are the palette names from the style standard above. Use the palette helpers for consistent shading.

**Shapes and lines:**

| Call                                       | Draws                                                         |
| ------------------------------------------ | ------------------------------------------------------------- |
| `k.rect(x, y, w, h, o)`                    | rectangle (`o.radius` for rounded corners)                    |
| `k.circle(x, y, r, o)`                     | circle                                                        |
| `k.ellipse(x, y, rx, ry, o)`               | ellipse                                                       |
| `k.line(x1, y1, x2, y2, o)`                | line                                                          |
| `k.arrow(x1, y1, x2, y2, o)`               | arrow (`o.head` = head size)                                  |
| `k.poly([[x,y], ...], o)`                  | polyline; `o.close` fills it as a shape, `o.smooth` curves it |
| `k.path("M0 0 L40 0 ...", x, y, scale, o)` | SVG path data; pass `o.box: [w, h]` of the path's own size    |

**Text and labels:**

| Call                                                  | Draws                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k.text(str, x, y, o)`                                | text in a **named style**: `o.style` (see the table above; default `body`), `o.color` (palette name), `o.align` (`left`, `center`, `right`), `o.baseline` (`middle` default, `top`, `bottom`), `o.alpha`. Returns the width. Don't pass sizes or fonts.                                                                                                               |
| `k.metric(x, y, value, label, o)`                     | a metric: the value (`value` style, or `valueSm` with `o.small`) directly above its label. `o.tone`, `o.align`. Returns the height used.                                                                                                                                                                                                                              |
| `k.card(x, y, w, h, o)`                               | a card in the house look (white, border, soft shadow, rounded), with optional `o.eyebrow` and `o.title`. Returns the inner box `{x, y, w, h}` to draw into.                                                                                                                                                                                                           |
| `k.label(str, x, y, o)`                               | pill tag, **centred on x** (`o.align: "left"` or `"right"` to anchor an edge). `o.tone` (`ink`, `gold`, `good`, `bad`, `muted`, `paper`).                                                                                                                                                                                                                             |
| `k.stamp(str, x, y, p, o)`                            | ✓/✕ verdict popping in as `p` goes 0→1, **centred on x**. `o.tone` is `good` or `bad`. Keep it short (≤ 24 characters).                                                                                                                                                                                                                                               |
| `k.gauge(x, y, w, h, value01, o)`                     | bar gauge. `o.tone`, `o.label`, `o.vertical`                                                                                                                                                                                                                                                                                                                          |
| `k.readouts(x, y, [[label, value, tone?], ...], o)`   | live readouts: `data`-style values, each **above** its label (design system rule). Returns the height used.                                                                                                                                                                                                                                                           |
| `k.bars(x, y, w, [{label, value, display, tone}], o)` | small comparison bars (result vs limit, ours vs baseline). Each bar's length is `value / o.max`, multiplied by `o.p` (0→1) for the grow-in; for bars that appear at different times, call `k.bars` once per bar with its own `p`. `o.max` sets the full-width value, `o.height` the bar thickness (32). Each bar uses about 86 px of height. Returns the height used. |

**Layout:**

- `k.areas({ main: 0.62 })` returns `{ main, side }` boxes `{x, y, w, h}`: the subject on the left with readouts on the right in 16:9, the subject on top with readouts below in 9:16. Start every animation with it, so the same code fills both formats.
  - In 9:16 the side area is **wide and short** (about 840 × 250 px with `wide`). Put readouts and bars side by side there, e.g. `const cols = side.w > side.h * 1.4`, as in example A. If it still doesn't fit, show less in 9:16 rather than shrinking text.
- `k.grid(x, y, w, h, n, (i, cx, cy, size) => {...}, o)` lays out n cells (trials, samples, wells, pixels, people) in a box. `o.cols` defaults to a near-square layout for the box's shape; `o.gap` is 6.

**Edges:** bursts, shakes and particle plumes also need enough space inside the canvas. Keep the key event at least `size` px from the edges.

**Icons** (Lucide, the design system's icon set: 1,908 outline icons, names at https://lucide.dev/icons):

- `k.icon(name, x, y, size, { color, fill, width, alpha })` draws one centred on (x, y). An unknown name fails with similar names suggested.
- Use icons for small markers and as a fallback subject. Draw the hero subject (section 8) when it matters.

**Generators** build things that are really geometry. They come out right every time, so build these rather than drawing them by hand:

| Call                                                                              | Builds                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k.cube(x, y, size, { n, yaw, pitch, turn, stickers, gap })`                      | A Rubik-style n×n×n cube in 3D. `turn: { axis: "x"\|"y"\|"z", layer, angle }` rotates one layer (animate `angle` with `k.seg`). `stickers: { U, D, F, B, L, R: [n·n colour names] }` shows a scrambled state; the default is solved. Use `yaw` / `pitch` to spin the view. |
| `k.network(x, y, w, h, { layers, nodes, density, p, pulse, active, tone, seed })` | A layered network (`layers: [3, 5, 5, 2]`, left → right) or a radial cluster (`nodes: 24`). `p` grows it in, `pulse` (0→1) sends a signal through the layers, and `active` lists node indices to highlight. Returns the node positions.                                    |
| `k.molecule(x, y, size, atoms, bonds, { rotate, p, labels })`                     | Atoms `[{ el, x, y }]` (any units) and bonds `[[i, j, order]]`, fitted into `size`. Element colours are fixed: C ink, O red, N blue, H white, S yellow, P amber.                                                                                                           |

`k.grid` (above) covers arrays of trials, samples and wells.

**Brand motifs** (design system: rings, radial connections, sparse nodes). Use them sparingly, behind a subject or as a moment of emphasis:

- `k.rings(x, y, r, { n, p, tone, alpha })` draws concentric rings that grow in with `p`.
- `k.nodes(x, y, r, { n, p, seed, tone })` draws sparse dots linked radially to a core. `tone: "gold"` marks a few dots in gold.

**Emphasis for the key event:**

- `k.burst(x, y, p, { tone, size })` draws expanding rings and rays as `p` goes 0→1. Use it on impact, breakthrough, failure or success.
- `k.shake(p, amount)` returns `[dx, dy]` to offset a group for a moment after a hit.

**Grouping and effects:**

- `k.group({ x, y, scale, rotate, alpha }, () => { ... })` moves, scales, rotates (radians) or fades everything drawn inside. Draw a subject once around (0,0), then place it with a group.
- `k.camera({ x, y, zoom, to }, () => { ... })` frames the drawing: (x, y) comes to the canvas centre (or to `to: [x, y]`) at `zoom`. Content outside its bounds is intentionally cropped. Rules in section 5, Camera.
- `k.particles({...})` draws exhaust, sparks, bubbles, dust or flow. Particles are fixed in time, so each frame is the same on every render. Start from a preset and override what your case needs: `preset: "exhaust"`, `"smoke"`, `"sparks"`, `"bubbles"`, `"flow"` or `"dust"`. Options:

  | Option               | Meaning                                                                                                                                                                                                             |
  | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `from: te => [x, y]` | emitter position **at each particle's birth time `te`** (not now). For a moving emitter, compute its position for time `te` with the same formula you use for the subject, so the plume trails behind it naturally. |
  | `on: te => bool`     | emitting at `te`?                                                                                                                                                                                                   |
  | `rate`               | particles per second                                                                                                                                                                                                |
  | `life`               | seconds each particle lives                                                                                                                                                                                         |
  | `angle`              | direction in degrees (90 = down, −90 = up)                                                                                                                                                                          |
  | `spread`             | spread in degrees                                                                                                                                                                                                   |
  | `speed`              | px/s                                                                                                                                                                                                                |
  | `gravity`            | px/s²                                                                                                                                                                                                               |
  | `floor`              | y where particles spread sideways                                                                                                                                                                                   |
  | `size`               | starting size                                                                                                                                                                                                       |
  | `grow`               | size gained over life                                                                                                                                                                                               |
  | `color`              | colour                                                                                                                                                                                                              |
  | `alpha`              | opacity                                                                                                                                                                                                             |
  | `seed`               | fixes the random pattern                                                                                                                                                                                            |

## 5 · What makes a good animation (any case)

1. **Show the thing the research is about.** It might be a vehicle, organism, cell, molecule, machine, structure, dataset, model or population.
   - Draw it however the case needs: there is no fixed drawing style. Make it recognisable (criteria and method below), in the palette (subjects may also use natural colours), and without anyone's logo.
   - Make it big: the subject takes most of `main`.
   - For an abstract result (a rate, a score, a ranking), show the population or the contest: trials in a `k.grid` that flip to pass/fail, competitors racing, a counter climbing against a baseline.
2. **The motion is the explanation.** Position, level, size, colour or state follows the session's numbers: rising, draining, growing, flipping, racing, breaking.
3. **Make small changes visible.** If the real change is tiny next to the subject (a 1 m hover under a 4 m car, a 0.3% gain), exaggerate the _drawing_ and say so with a tag such as `k.label("height ×3 · not to scale", ...)`. Never change the _numbers_ shown.
4. **Pin every key moment to its word.** Use `k.timeline` and `k.cue` (section 2). Slow down or hold the less important parts so the key moment lands when it is said.
5. **Land the climax.** At the moment of the result:
   - a `k.burst` and/or `k.shake`
   - the deciding number in a `k.stamp`
   - the number set against its reference (limit, target, baseline, chance) with `k.bars`, so the viewer sees _how far_ it misses or beats it
6. **Readouts in the side area:** two to four with `k.readouts` or `k.metric`, or inside a `k.card`. Add a state tag (e.g. "running", "stopped", "failed") with `k.label`.
7. **The animation carries the scene, but keep other panels that add something** (a verdict line, a comparison) if they fit. Check their fit in the rendered player.
8. **Clean frame:** nothing outside the canvas (except what a `k.camera` shot crops), no text over text, only named text styles and palette colours, and the drawing fills the canvas.

### Drawing well: how to judge a graphic

There is no fixed style for what you draw: draw whatever the case needs. These are the criteria that tell a good coded graphic from a weak one. Check every drawing against them at its **final playback size**, not zoomed in.

1. **It reads in one second.** A stranger names the thing at the size it's drawn. If they couldn't, it isn't finished. Things smaller than about 60 px are markers, not drawings: give named things room.
2. **Silhouette before detail.** Recognition comes from the outline and its proportions. Get those right first (from real dimensions, coordinates or a reference), then add parts.
3. **One focal point.** The thing the line names is the largest, highest-contrast or gold element. Supporting things are ink or steel; context sits back in `line`, `track`, `sky` or low alpha.
4. **Depth, not floating shapes.** Build in layers: a backdrop that says _where_ (sky, water, a bench, a tissue), a ground or base the subject stands on with a contact shadow, the subject, then labels. Light comes from one side: a slightly darker fill on the shaded faces.
5. **One graphic system.** The same outline weight for everything of the same rank (main outlines about 3–4 px, inner detail 1.5–2 px at 1080p), round joins, solid fills from the palette. Don't mix outline-only and fill-only versions of the same kind of thing.
6. **Detail where the eye goes.** Three levels: the silhouette, the main parts, a few accents on the focal part. Even, tiny detail everywhere reads as noise.
7. **Real geometry when it exists.** A map uses the real coordinates (projected), a machine its real proportions, a curve the session's data. Invented geometry is labelled schematic.
8. **It fills its space.** The composition uses the canvas: the subject takes most of `main`, nothing important sits in a corner, and empty space is a choice, not left over.
9. **States are part of the drawing.** Design the subject with the states the story needs (idle, running, failed; empty, full; before, after) as parameters of one draw function, so every scene shows the same object in a different state.
10. **Motion is clear.** One main motion at a time, eased, landing on its word and then held for at least a second. Text labels are sparse: the drawing explains, labels only name.

### Drawing well: method

1. **Collect the facts.** Dimensions, coordinates, counts and states from the session and its files. Use only the supplied evidence; if geometry is unavailable, keep it schematic and label it accordingly. Authoring has no web-search step.
2. **Block in at final size.** Put boxes for the subject, its context and the readouts on the canvas, with `k.areas` or your own split, and look at the frame before drawing any detail.
3. **Draw the subject in its own coordinates.** Use a local box (e.g. 0–420 × 0–170), with `k.path` for real outlines (SVG path syntax: `M L Q C Z`), then place it with `k.group({ x, y, scale })`. Mirror symmetric shapes; build repeated parts (windows, legs, cells) in a loop with small seeded variation (`k.rand`).
4. **Silhouette, then parts, then accents.** One closed path for the outer shape; then the 2–5 main parts as separate fills; then a few accents (one gold, highlights, a darker shaded side).
5. **Context that explains where.** A route needs its city: water, parks and main streets as soft bands under the route, landmarks as recognisable shapes at their projected positions, the route drawn on top with a light casing (a wider pale line under it) and a moving marker. A vehicle needs its ground or stand, a cell its medium, an instrument its bench.
6. **Make it a function with states.** `function city(state) { … }`, `function stand(box, st) { … }` in a shared file (`use`), so every scene calls the same drawing.
7. **Look and revise.** Inspect the actual player at final size against the criteria above. Squint: is the focal point still obvious? Revise the drawing, not the criteria. Expect several rounds for the subject; it is reused in every scene.

### Camera

Fixed for every video:

- **Readouts, labels, stamps and the scene's title stay still.** Only the drawing moves: put it inside `k.camera({ x, y, zoom }, () => { … })`, which brings the point (x, y) to the canvas centre at `zoom` (1 = as drawn). Draw the readouts after it, outside the camera. Inside the camera, parts may run past the canvas edge (they are intentionally cropped).
- **At most one camera move per scene:** a push-in toward the key moment, or a pan that follows the subject. Ease it (`k.seg(a, b, "inOut")`) over 0.8–1.5 s, finish it before the key word, then hold.
- **Zoom between 1× and 2.5×.** No rotation, no drift. Shake only on an impact (`k.shake`).
- **Continuity:** the first scene that shows the recurring subject establishes it (wide). Later scenes keep the same framing unless a closer or wider view shows something new.
- **Never move while a number is being read.**

```js
// push in on the landmark where the route changes, then hold; readouts stay still
const z = k.lerp(1, 1.8, k.seg('1:shorter-1.2', '1:shorter-0.2', 'inOut'))
k.camera(
  {
    x: k.lerp(k.W / 2, pts[7][0], (z - 1) / 0.8),
    y: k.lerp(k.H / 2, pts[7][1], (z - 1) / 0.8),
    zoom: z
  },
  () => city({ route })
)
k.readouts(side.x, side.y, [['exact shortest', '12.118 km', 'goldDeep']])
```

## 6 · Validate and inspect

The application validates the supported screenplay, source references, cues, file paths and script syntax. It does not run a separate animation-check command or produce filmstrip/contact sheets. A script that compiles can still draw badly or fail at runtime.

In the actual player, inspect the opening, each scene's key cue and the end. Play, pause, seek backward and jump between scenes. Check that the subject is recognizable, text remains readable, labels do not collide and visual changes agree with the narration. Check both aspect ratios if both will be used; desktop MP4 export currently uses 16:9 only. Revise the drawing when it fails this review rather than claiming that syntax validation certified it.

## 7 · Two examples from different kinds of case

Neither is a template to copy. They show the habits that work: `k.areas` for both formats, `k.timeline` to pin key moments to words, a big subject, readouts in the side area, and a climax with burst, stamp and comparison.

### A · A physical process from data: a tank draining through a valve

**Data:** `tank_level.csv` (`trial, time_s, level_m, flow_l_s`).

**Voice:**

- line 0: "The valve opens, and the tank drains in 40 seconds."
- line 1: "It falls below the 0.5 m safety line at 31 seconds."

```js
// A · physical process from data: a tank draining through a valve
const run = k.data('tank_level.csv').where({ trial: 1 })
const T = run.last('time_s'),
  H0 = run.max('level_m')
// data time follows the voice: 0→31 s until "below" (the key moment), then 31→40 s until the line ends
const tt = k.timeline([
  ['0:valve', 0],
  ['1:below', 31],
  ['1.end', T]
])
const level = run.at('level_m', 'time_s', tt),
  flow = run.at('flow_l_s', 'time_s', tt)
const { main, side } = k.areas()

// subject: the tank, big, in the main area
const tw = Math.min(main.w * 0.42, main.h * 0.75),
  th = main.h * 0.78
const tx = main.x + main.w * 0.3 - tw / 2,
  ty = main.y + main.h * 0.08,
  floor = ty + th
const yOf = (m) => ty + th * (1 - m / H0)
const hit = k.seg('1:below', '1:below+0.7', 'linear')
const [dx, dy] = k.shake(hit, 6)
k.group({ x: dx, y: dy }, () => {
  k.rect(tx, yOf(level), tw, floor - yOf(level), { fill: 'sky' })
  k.rect(tx, ty, tw, th, { fill: null, stroke: 'ink', width: 6, radius: 12 })
  k.line(tx - 24, yOf(0.5), tx + tw + 24, yOf(0.5), { stroke: 'bad', dash: true, width: 3 })
  k.text('0.5 m safety line', tx + tw - 14, yOf(0.5) - 20, {
    style: 'dataSm',
    color: 'bad',
    align: 'right'
  })
  k.rect(tx + tw, floor - 34, 70, 24, { fill: 'steel', radius: 5 })
})
k.particles({
  preset: 'flow',
  from: () => [tx + tw + 70, floor - 22],
  on: (te) => te > k.cue('0:valve') && te < k.cue('1.end'),
  angle: 15,
  gravity: 900,
  floor: floor + 8,
  speed: 320 * (0.4 + flow / run.max('flow_l_s'))
})
k.line(main.x, floor + 10, main.x + main.w, floor + 10, { stroke: 'line', width: 4 })
k.burst(tx + tw / 2, yOf(0.5), hit, { tone: 'bad', size: tw * 0.6 })

// readouts + climax in the side area (two columns when the side area is wide and short, as in 9:16)
const cols = side.w > side.h * 1.4,
  bx = cols ? side.x + side.w * 0.45 : side.x,
  by = cols ? side.y : side.y + side.h * 0.42
k.readouts(side.x, side.y + 4, [
  ['time', `${tt.toFixed(1)} s`],
  ['level', `${level.toFixed(2)} m`, level < 0.5 ? 'bad' : 'ink']
])
k.bars(
  bx,
  by,
  (cols ? side.w * 0.55 : side.w) * 0.95,
  [
    {
      label: 'level now',
      value: level,
      display: `${level.toFixed(2)} m`,
      tone: level < 0.5 ? 'bad' : 'blue'
    },
    { label: 'safety line', value: 0.5, display: '0.5 m', tone: 'muted' }
  ],
  { max: H0 }
)
k.stamp(
  'below at 31 s',
  cols ? main.x + main.w * 0.7 : side.x + side.w * 0.45,
  cols ? main.y + main.h * 0.15 : side.y + side.h * 0.93,
  k.seg('1:below', '1:below+0.5', 'linear'),
  { tone: 'bad' }
)
```

### B · An abstract result, with numbers from the message (no data file): three algorithms race

**Message:** "Sorting 10,000 items took 1.2 s with merge sort, 3.4 s with heap sort and 9.8 s with bubble sort, so merge sort was about 8× faster."

**Voice:**

- line 0: "Three algorithms sorted the same 10,000 items."
- line 1: "Merge sort won in 1.2 seconds — about eight times faster than bubble sort."

```js
// B · abstract result, numbers from the message (no data file): three algorithms race to sort 10,000 items
const algos = [
  { name: 'merge sort', s: 1.2, tone: 'gold' },
  { name: 'heap sort', s: 3.4, tone: 'blue' },
  { name: 'bubble sort', s: 9.8, tone: 'steel' }
]
const { main, side } = k.areas({ main: 0.68 })
// race clock: 0 → 1.2 s lands exactly on "won", then runs on to 9.8 s by the end of line 1
const clock = k.timeline([
  ['0+0.4', 0],
  ['1:won', 1.2],
  ['1.end-0.3', 9.8]
])
const lane = main.h / algos.length,
  x0 = main.x + main.w * 0.24,
  x1 = main.x + main.w - lane * 0.62
k.line(x1, main.y, x1, main.y + main.h, { stroke: 'ink', width: 4, dash: [8, 8] }) // finish line
algos.forEach((a, i) => {
  const yc = main.y + lane * (i + 0.5),
    p = Math.min(1, clock / a.s),
    done = clock >= a.s
  k.text(a.name, main.x, yc, { style: 'heading', color: done && i === 0 ? 'goldDeep' : 'ink' })
  k.rect(x0, yc - lane * 0.22, x1 - x0, lane * 0.44, { fill: '#F1F0EC', radius: lane * 0.22 }) // track
  k.rect(x0, yc - lane * 0.22, Math.max(lane * 0.44, (x1 - x0) * p), lane * 0.44, {
    fill: a.tone,
    radius: lane * 0.22,
    alpha: 0.9
  })
  k.circle(x0 + (x1 - x0) * p, yc, lane * 0.26, {
    fill: 'paper',
    stroke: a.tone,
    width: 5,
    shadow: true
  }) // runner
  if (done) k.label(`${a.s} s`, x0 + 70, yc, { tone: i === 0 ? 'ink' : 'paper' })
  k.burst(x1, yc, k.clamp((clock - a.s) / 0.9), { tone: a.tone, size: lane * 0.6 })
})
k.readouts(side.x + 10, side.y + 10, [
  ['items sorted', '10,000'],
  ['race clock', `${clock.toFixed(1)} s`]
])
k.stamp(
  'about 8× faster',
  side.x + side.w / 2,
  side.y + side.h * 0.75,
  k.seg('1:eight', '1:eight+0.5', 'linear'),
  { tone: 'good' }
)
```

## 8 · Reuse subjects through shared JavaScript

Draw the main subject once in a shared helper such as `anims/subject.js`. Reference it through each animation panel's `use` array. The host concatenates those helpers before the scene script; there is no subject-manifest loader in this application path.

```js
// Shared helper body: anims/subject.js
function drawTank(k, level) {
  const w = k.W * 0.35
  const h = k.H * 0.6
  const x = (k.W - w) / 2
  const y = (k.H - h) / 2
  k.rect(x, y, w, h, { fill: 'surface', stroke: 'steel', radius: 12 })
  k.rect(x + 6, y + h * (1 - level), w - 12, Math.max(0, h * level - 6), {
    fill: 'sky'
  })
}
```

```js
// Scene body: anims/draining.js; its panel declares use: ['anims/subject.js']
drawTank(k, k.lerp(0.8, 0.2, k.seg('0', '0.end')))
```

Treat this example as schematic, not a measured result. Give real subjects a recognizable silhouette, coherent proportions, contextual background and contact shadow. Model their meaningful states as function parameters so the same subject remains consistent across scenes. Keep scientific quantities grounded in the supplied source.
