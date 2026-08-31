import { describe, expect, it } from 'vitest'

import { analyzeRSources } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('analyzeNotebookSourceFileAccess', () => {
  it.each([
    ['python', "frame.to_csv('result.csv', mode='w')"],
    ['python', "frame.to_hdf('result.csv', key='new', mode='w')"],
    ['python', "frame.to_csv('result.csv', mode='w')\nframe.to_csv('result.csv', mode='a')"],
    ['r', 'write.table(frame, "result.csv", append = FALSE)'],
    ['r', 'write.csv(frame, "result.csv", append = TRUE)'],
    ['r', 'write.table(frame, "result.csv")\nwrite.table(frame, "result.csv", append=TRUE)']
  ] as const)(
    'keeps %s replacing writes independent of earlier bytes: %s',
    async (language, source) => {
      const setup =
        language === 'python'
          ? "import pandas as pd\nframe = pd.DataFrame({'x':[1]})\n"
          : 'frame <- data.frame(x=1)\n'
      await expect(
        analyzeNotebookSourceFileAccess(language, setup + source)
      ).resolves.toMatchObject({
        reads: [],
        writes: ['result.csv'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )

  it.each([
    ['python', "frame.to_csv('result.csv', mode=unknown_mode)"],
    ['r', 'write.table(frame, "result.csv", append=unknown_flag)']
  ] as const)('keeps unresolved %s write modes conservative', async (language, source) => {
    const result = await analyzeNotebookSourceFileAccess(language, source)
    expect(result.readState).toBe('partial')
    expect(result.writeState).toBe('partial')
  })

  it.each([
    ['python', "def save_rows(path):\n    frame.to_csv(path, mode='a')\nsave_rows('result.csv')"],
    [
      'r',
      'save_rows <- function(path) write.table(frame, path, append=TRUE)\nsave_rows("result.csv")'
    ]
  ] as const)(
    'does not erase hidden append semantics in a %s wrapper',
    async (language, source) => {
      const result = await analyzeNotebookSourceFileAccess(language, source)
      expect(result.externalState).not.toBe('complete')
    }
  )

  it.each([
    ['python', "frame.to_csv('result.csv', mode='a')"],
    ['python', "frame.to_hdf('result.csv', key='new')"],
    ['r', 'write.table(frame, "result.csv", append = TRUE)'],
    ['r', 'readr::write_csv(frame, "result.csv", append = TRUE)']
  ] as const)(
    'retains an existing output dependency for %s append writes: %s',
    async (language, source) => {
      const setup =
        language === 'python'
          ? "import pandas as pd\nframe = pd.DataFrame({'x': [1]})\n"
          : 'frame <- data.frame(x=1)\n'
      await expect(
        analyzeNotebookSourceFileAccess(language, setup + source)
      ).resolves.toMatchObject({
        reads: ['result.csv'],
        writes: ['result.csv'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )

  it.each([
    'read.csv(path)',
    'utils::read.csv(file = path)',
    'read.table(file = path, header = TRUE)',
    'readLines(con = path)',
    'readRDS(file = path)',
    'readr::read_csv(file = path)',
    'data.table::fread(file = path)',
    'jsonlite::fromJSON(txt = path)',
    'yaml::yaml.load_file(input = path)'
  ])('captures a static R path used by %s without treating it as a connection', async (read) => {
    await expect(
      analyzeNotebookSourceFileAccess('r', `path <- "inputs/groups.csv"\nvalue <- ${read}`)
    ).resolves.toMatchObject({
      readState: 'complete',
      externalState: 'complete',
      reads: ['inputs/groups.csv'],
      reasonCodes: []
    })
  })

  it.each([
    'original <- "inputs/groups.csv"\npath <- original',
    'folder <- "inputs"\npath <- file.path(folder, "groups.csv")',
    'path <- "inputs/"\npath <- paste0(path, "groups.csv")'
  ])('resolves an R path assignment: %s', async (assignment) => {
    await expect(
      analyzeNotebookSourceFileAccess('r', `${assignment}\nvalue <- read.csv(path)`)
    ).resolves.toMatchObject({
      readState: 'complete',
      externalState: 'complete',
      reads: ['inputs/groups.csv'],
      reasonCodes: []
    })
  })

  it.each(['path <- file("inputs/groups.csv")', 'path <- "inputs/groups.csv"\npath <- file(path)'])(
    'tracks a locally constructed R file connection: %s',
    async (assignment) => {
      const source = `${assignment}\nvalue <- read.csv(path)`
      const [facts] = await analyzeRSources([source])
      expect(facts.mutatedNames).toContain('path')
      expect(facts).toMatchObject({ state: 'unknown', reasons: ['external-state'] })
      await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
        readState: 'complete',
        externalState: 'complete',
        reads: ['inputs/groups.csv'],
        reasonCodes: []
      })
    }
  )

  it.each([
    'path <- 3',
    'path <- "inputs/groups.csv"\nif (flag) path <- file(path)',
    'path <- "inputs/groups.csv"\npath[1] <- unknown'
  ])('does not certify an unresolved R connection or changed path: %s', async (assignment) => {
    const source = `${assignment}\nvalue <- read.csv(path)`
    const [facts] = await analyzeRSources([source])
    expect(facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      readState: 'partial',
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('extracts a direct Matplotlib output without inventing input files', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import numpy as np',
        'import matplotlib.pyplot as plt',
        'x = np.linspace(0, 2 * np.pi, 500)',
        "plt.plot(x, np.sin(x), color='#1f77b4')",
        "plt.savefig('sin.png', dpi=120)",
        'plt.close()'
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['sin.png'],
      reasonCodes: []
    })
  })

  it('resolves Matplotlib outputs from a deterministic tuple loop with computed plot values', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import numpy as np, matplotlib',
        'matplotlib.use("Agg")',
        'import matplotlib.pyplot as plt',
        'x = np.linspace(0, 2 * np.pi, 400)',
        'for name, y, color in [("sin", np.sin(x), "tab:blue"), ("cos", np.cos(x), "tab:red")]:',
        '    fig, ax = plt.subplots(figsize=(6, 3.5), dpi=150)',
        '    ax.plot(x, y, color=color)',
        '    ax.set_title(f"y = {name}(x)"); ax.set_xlabel("x"); ax.set_ylabel(f"{name}(x)")',
        '    ax.axhline(0, color="gray", lw=0.5); ax.grid(alpha=0.3)',
        '    fig.tight_layout(); fig.savefig(f"{name}.png"); plt.close(fig)',
        'print("ok")'
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['cos.png', 'sin.png'],
      reasonCodes: []
    })
  })

  it('keeps a multi-figure Matplotlib cell complete when plots only write static outputs', async () => {
    const source = [
      'import matplotlib.pyplot as plt',
      'import numpy as np',
      "labels = ['Ctrl', 'IRI']",
      'counts = [33, 33]',
      "colors = ['#4C72B0', '#DD8452']",
      'fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))',
      'ax = axes[0]',
      "bars = ax.bar(labels, counts, color=colors, edgecolor='black', linewidth=0.6)",
      'for b, v in zip(bars, counts):',
      "    ax.text(b.get_x() + b.get_width() / 2, v + 0.8, str(v), ha='center')",
      "plt.savefig('bar_charts.png', dpi=120)",
      'plt.close(fig)',
      'fig, ax = plt.subplots(figsize=(6, 6))',
      "wedges, texts, autotexts = ax.pie(counts, labels=labels, colors=colors, autopct='%1.1f%%')",
      'for at in autotexts:',
      "    at.set_color('white'); at.set_fontweight('bold')",
      "ax.text(0, 0, f'Total\\n{sum(counts)}')",
      "plt.savefig('donut.png', dpi=120)",
      'plt.close(fig)',
      "fig, ax = plt.subplots(figsize=(6.5, 6.5), subplot_kw=dict(projection='polar'))",
      'theta = np.linspace(0, 2 * np.pi, len(labels), endpoint=False)',
      'bars = ax.bar(theta, counts)',
      'for ang, r, lab in zip(theta, counts, labels):',
      "    ax.text(ang, r + 1.5, str(r), ha='center')",
      "plt.savefig('rose.png', dpi=120)",
      'plt.close(fig)'
    ].join('\n')
    const result = await analyzeNotebookSourceFileAccess('python', source)

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['bar_charts.png', 'donut.png', 'rose.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'nested destructuring',
      [
        'fig, (ax_left, ax_right) = plt.subplots(1, 2)',
        'ax_left.plot([0, 1], [0, 1])',
        'ax_right.plot([0, 1], [1, 0])'
      ].join('\n')
    ],
    [
      'secondary destructuring',
      [
        'fig, axes = plt.subplots(1, 2)',
        'ax_left, ax_right = axes',
        'ax_left.plot([0, 1], [0, 1])',
        'ax_right.plot([0, 1], [1, 0])'
      ].join('\n')
    ],
    [
      'axes.flat',
      [
        'fig, axes = plt.subplots(1, 2)',
        'for ax in axes.flat:',
        '    ax.plot([0, 1], [0, 1])'
      ].join('\n')
    ],
    [
      'axes.ravel()',
      [
        'fig, axes = plt.subplots(1, 2)',
        'flat_axes = axes.ravel()',
        'for ax in flat_axes:',
        '    ax.plot([0, 1], [0, 1])'
      ].join('\n')
    ],
    [
      'axes.flatten()',
      [
        'fig, axes = plt.subplots(1, 2)',
        'for ax in axes.flatten():',
        '    ax.plot([0, 1], [0, 1])'
      ].join('\n')
    ],
    [
      'axes.reshape()',
      [
        'fig, axes = plt.subplots(2, 2)',
        'for ax in axes.reshape(-1):',
        '    ax.plot([0, 1], [0, 1])'
      ].join('\n')
    ],
    [
      'multidimensional subscript',
      ['fig, axes = plt.subplots(2, 2)', 'ax = axes[0, 1]', 'ax.plot([0, 1], [0, 1])'].join('\n')
    ],
    [
      'numpy.ravel()',
      [
        'import numpy as np',
        'fig, axes = plt.subplots(2, 2)',
        'for ax in np.ravel(axes):',
        '    ax.plot([0, 1], [0, 1])'
      ].join('\n')
    ],
    [
      'numpy.atleast_1d().flat',
      [
        'import numpy as np',
        'fig, axes = plt.subplots(1, 1)',
        'for ax in np.atleast_1d(axes).flat:',
        '    ax.plot([0, 1], [0, 1])'
      ].join('\n')
    ]
  ])('keeps common Matplotlib subplot access through %s input-free', async (_name, body) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      ['import matplotlib.pyplot as plt', body, "fig.savefig('panels.png')"].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['panels.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'pyplot.subplot',
      ['ax = plt.subplot(111)', 'ax.plot([0, 1], [0, 1])', "plt.savefig('plot.png')"].join('\n')
    ],
    [
      'pyplot.gca',
      ['ax = plt.gca()', 'ax.scatter([0, 1], [1, 0])', "plt.savefig('plot.png')"].join('\n')
    ],
    [
      'figure.add_axes',
      [
        'fig = plt.figure()',
        'ax = fig.add_axes([0.1, 0.1, 0.8, 0.8])',
        'ax.plot([0, 1], [0, 1])',
        "fig.savefig('plot.png')"
      ].join('\n')
    ],
    [
      'figure.subplots',
      [
        'fig = plt.figure()',
        'ax = fig.subplots()',
        'ax.plot([0, 1], [0, 1])',
        "fig.savefig('plot.png')"
      ].join('\n')
    ],
    [
      'common axes rendering methods',
      [
        'fig, ax = plt.subplots()',
        'ax.hist([0, 1, 1])',
        'ax.imshow([[0, 1], [1, 0]])',
        'ax.errorbar([0, 1], [0, 1], yerr=[0.1, 0.1])',
        'ax.fill_between([0, 1], [0, 0], [1, 1])',
        "ax.annotate('peak', xy=(1, 1))",
        "ax.set_yscale('linear')",
        "ax.tick_params(axis='both')",
        "fig.savefig('plot.png')"
      ].join('\n')
    ]
  ])('keeps %s rendering-only Matplotlib code input-free', async (_name, body) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      ['import matplotlib.pyplot as plt', body].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['plot.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'Matplotlib lines',
      [
        'import matplotlib.pyplot as plt',
        'fig, ax = plt.subplots()',
        'lines = ax.plot([0, 1], [0, 1])',
        'for line in lines:',
        "    line.set_color('red')",
        "fig.savefig('plot.png')"
      ].join('\n'),
      ['plot.png']
    ],
    [
      'Matplotlib bars',
      [
        'import matplotlib.pyplot as plt',
        'fig, ax = plt.subplots()',
        'bars = ax.bar([0, 1], [1, 2])',
        'for bar in bars:',
        '    bar.set_alpha(0.8)',
        "fig.savefig('plot.png')"
      ].join('\n'),
      ['plot.png']
    ],
    [
      'pandas groups',
      [
        'import pandas as pd',
        "df = pd.DataFrame({'group': ['a', 'b'], 'value': [1, 2]})",
        "groups = df.groupby('group')",
        'for _, group in groups:',
        "    group.to_csv('group.csv', index=False)"
      ].join('\n'),
      ['group.csv']
    ]
  ])('keeps methods on iterated %s elements analyzable', async (_name, source, writes) => {
    const result = await analyzeNotebookSourceFileAccess('python', source)

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes,
      reasonCodes: []
    })
  })

  it.each([
    [
      'subscripted bar',
      ['bars = ax.bar([0, 1], [1, 2])', 'bar = bars[0]', 'bar.set_alpha(0.8)'].join('\n')
    ],
    ['unpacked line', ['line, = ax.plot([0, 1], [0, 1])', "line.set_color('red')"].join('\n')],
    [
      'enumerated line',
      [
        'lines = ax.plot([0, 1], [0, 1])',
        'for index, line in enumerate(lines):',
        '    line.set_linewidth(index + 1)'
      ].join('\n')
    ],
    [
      'reversed line',
      [
        'lines = ax.plot([0, 1], [0, 1])',
        'for line in reversed(lines):',
        '    line.set_visible(True)'
      ].join('\n')
    ]
  ])('preserves the element type of a %s', async (_name, body) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import matplotlib.pyplot as plt',
        'fig, ax = plt.subplots()',
        body,
        "fig.savefig('plot.png')"
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['plot.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'zip',
      'for name, y in zip(("sin", "cos"), (np.sin(x), np.cos(x))):',
      '    fig.savefig(f"{name}.png")',
      ['cos.png', 'sin.png']
    ],
    [
      'enumerate',
      'for index, y in enumerate((np.sin(x), np.cos(x)), start=1):',
      '    fig.savefig(f"plot-{index}.png")',
      ['plot-1.png', 'plot-2.png']
    ]
  ])(
    'resolves Matplotlib output names projected from %s over computed values',
    async (_name, loop, save, writes) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          'import numpy as np',
          'import matplotlib.pyplot as plt',
          'x = np.linspace(0, 2 * np.pi, 400)',
          loop,
          '    fig, ax = plt.subplots()',
          '    ax.plot(x, y)',
          save,
          '    plt.close(fig)'
        ].join('\n')
      )

      expect(result).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [],
        writes,
        reasonCodes: []
      })
    }
  )

  it.each([
    [
      'an assigned tuple sequence',
      ['plots = [("sin", np.sin(x)), ("cos", np.cos(x))]', 'for name, y in plots:'].join('\n')
    ],
    [
      'assigned zip inputs',
      [
        'names = ("sin", "cos")',
        'values = (np.sin(x), np.cos(x))',
        'for name, y in zip(names, values):'
      ].join('\n')
    ]
  ])('propagates Matplotlib output labels through %s', async (_name, setup) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import numpy as np',
        'import matplotlib.pyplot as plt',
        'x = np.linspace(0, 2 * np.pi, 400)',
        setup,
        '    fig, ax = plt.subplots()',
        '    ax.plot(x, y)',
        '    fig.savefig(f"{name}.png")',
        '    plt.close(fig)'
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['cos.png', 'sin.png'],
      reasonCodes: []
    })
  })

  it('resolves R output names projected from a named list with computed values', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        'x <- seq(0, 2 * pi, length.out = 400)',
        'plots <- list(sin = sin(x), cos = cos(x))',
        'for (name in names(plots)) {',
        '  png(sprintf("%s.png", name))',
        '  plot(x, plots[[name]], type = "l")',
        '  dev.off()',
        '}'
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['cos.png', 'sin.png'],
      reasonCodes: []
    })
  })

  it('propagates R computed-list names through a local binding', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        'x <- seq(0, 2 * pi, length.out = 400)',
        'plots <- list(sin = sin(x), cos = cos(x))',
        'plot_names <- names(plots)',
        'for (name in plot_names) {',
        '  png(sprintf("%s.png", name))',
        '  plot(x, plots[[name]], type = "l")',
        '  dev.off()',
        '}'
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['cos.png', 'sin.png'],
      reasonCodes: []
    })
  })

  it('resolves Python output names projected from dictionary keys with computed values', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import numpy as np',
        'import matplotlib.pyplot as plt',
        'x = np.linspace(0, 2 * np.pi, 400)',
        'plots = {"sin": np.sin(x), "cos": np.cos(x)}',
        'for name, y in plots.items():',
        '    fig, ax = plt.subplots()',
        '    ax.plot(x, y)',
        '    fig.savefig(f"{name}.png")',
        '    plt.close(fig)'
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['cos.png', 'sin.png'],
      reasonCodes: []
    })
  })

  it('keeps R file evidence complete for local assignments in a static output loop', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        'x <- seq(0, 2 * pi, length.out = 400)',
        'for (name in c("sin", "cos")) {',
        '  y <- sin(x)',
        '  png(sprintf("%s.png", name))',
        '  plot(x, y, type = "l")',
        '  dev.off()',
        '}'
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['cos.png', 'sin.png'],
      reasonCodes: []
    })
  })

  it('keeps CSV writer handle methods from inventing unresolved output paths', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import csv',
        'import matplotlib.pyplot as plt',
        'rows = [("sample-1", "Ctrl"), ("sample-2", "IRI")]',
        'csv_path = "groups.csv"',
        'with open(csv_path, "w", newline="") as handle:',
        '    writer = csv.writer(handle)',
        '    writer.writerow(["sample", "group"])',
        '    writer.writerows(rows)',
        '    dict_writer = csv.DictWriter(handle, fieldnames=["sample", "group"])',
        '    dict_writer.writeheader()',
        'with open(csv_path, "r") as handle:',
        '    records = list(csv.DictReader(handle))',
        'plt.pie([len(records)])',
        'plt.savefig("pie_groups.png")'
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['groups.csv', 'pie_groups.png'],
      reasonCodes: []
    })
  })

  it('keeps Matplotlib legend patches and compact pie-label styling input-free', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import numpy as np',
        'import matplotlib.pyplot as plt',
        'from matplotlib.patches import Patch',
        'order = ["Ctrl", "IRI"]',
        'sizes = [3, 4]',
        'colors = ["#4C72B0", "#DD8452"]',
        'group_color = {"Ctrl": "#4C72B0", "IRI": "#DD8452"}',
        'fig = plt.figure(figsize=(13, 9))',
        'gs = fig.add_gridspec(2, 2)',
        'ax_a = fig.add_subplot(gs[0, 0])',
        'bars = ax_a.bar(order, sizes, color=colors)',
        'for bar, value in zip(bars, sizes):',
        '    ax_a.text(bar.get_x() + bar.get_width() / 2, value, str(value))',
        'ax_a.set_axisbelow(True)',
        'ax_b = fig.add_subplot(gs[0, 1])',
        'wedges, texts, autotexts = ax_b.pie(sizes, autopct="%1.1f%%")',
        'for text in autotexts:',
        '    text.set_color("white"); text.set_fontweight("bold")',
        'ax_c = fig.add_subplot(gs[1, 0])',
        'ax_c.hlines(y=order, xmin=0, xmax=sizes)',
        'ax_d = fig.add_subplot(gs[1, 1])',
        'idx = np.arange(len(order))',
        'strip_colors = [group_color[group] for group in order]',
        'ax_d.scatter(idx, [1] * len(idx), c=strip_colors)',
        'ax_d.set_yticks([])',
        'handles = [Patch(facecolor=group_color[group], label=group) for group in order]',
        'ax_d.legend(handles=handles)',
        'fig.suptitle("Overview")',
        'fig.savefig("overview.png")'
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['overview.png'],
      reasonCodes: []
    })
  })

  it('extracts a base R graphics output without inventing input files', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        'x <- seq(0, 2 * pi, length.out = 200)',
        'y <- sin(x)',
        'png("plot.png")',
        'plot(x, y)',
        'dev.off()'
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['plot.png'],
      reasonCodes: []
    })
  })

  it('does not treat an R directory listing as reading every file', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        'x <- seq(0, 2 * pi, length.out = 400)',
        'png("sin_plot_r.png")',
        'plot(x, sin(x))',
        'dev.off()',
        'png("cos_plot_r.png")',
        'plot(x, cos(x))',
        'dev.off()',
        'list.files(pattern = "_r.png")'
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'partial',
      reads: [],
      writes: ['cos_plot_r.png', 'sin_plot_r.png'],
      reasonCodes: ['source-analysis-unsupported-call']
    })
  })

  it('keeps a file selected from an R directory listing conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      ['files <- list.files(pattern = "\\.csv$")', 'frame <- read.csv(files[[1]])'].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'partial',
      externalState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining([
        'dynamic-path-unresolved',
        'source-analysis-unsupported-call'
      ])
    })
  })

  it('resolves common Python reader and writer path arguments', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pandas as pd',
        "source = 'measurements.csv'",
        "output = 'summary.csv'",
        'frame = pd.read_csv(source)',
        'frame.to_csv(output, index=False)'
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['measurements.csv'],
      writes: ['summary.csv'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'Path receiver methods',
      [
        'from pathlib import Path',
        "source = Path('source.txt').read_text()",
        "Path('summary.txt').write_text(source)"
      ].join('\n'),
      ['source.txt'],
      ['summary.txt']
    ],
    [
      'shutil.copyfile',
      "import shutil\nshutil.copyfile('source.csv', 'copied.csv')",
      ['source.csv'],
      ['copied.csv']
    ],
    [
      'SciPy WAV writer',
      "from scipy.io import wavfile\nsamples = [0, 1]\nwavfile.write('tone.wav', 44100, samples)",
      [],
      ['tone.wav']
    ],
    [
      'SoundFile writer',
      "import soundfile as sf\nsamples = [0, 1]\nsf.write('tone.flac', samples, 44100)",
      [],
      ['tone.flac']
    ],
    [
      'Matrix Market writer',
      "from scipy.io import mmwrite\nmatrix = [[1]]\nmmwrite('matrix.mtx', matrix)",
      [],
      ['matrix.mtx']
    ],
    [
      'Matplotlib canvas writer',
      "import matplotlib.pyplot as plt\nfig = plt.figure()\nfig.canvas.print_png('figure.png')",
      [],
      ['figure.png']
    ],
    [
      'AnnData writer',
      "from anndata import AnnData\ndata = AnnData()\ndata.write_h5ad('cells.h5ad')",
      [],
      ['cells.h5ad']
    ],
    [
      'HDF5 modes',
      [
        'import h5py',
        "with h5py.File('source.h5', 'r') as source:",
        '    values = source.keys()',
        "with h5py.File('result.h5', 'w') as result:",
        '    result.create_dataset("values", data=[1])'
      ].join('\n'),
      ['source.h5'],
      ['result.h5']
    ],
    [
      'pandas ExcelWriter handle',
      [
        'import pandas as pd',
        "frame = pd.DataFrame({'value': [1]})",
        "with pd.ExcelWriter('book.xlsx') as writer:",
        '    frame.to_excel(writer, index=False)'
      ].join('\n'),
      [],
      ['book.xlsx']
    ]
  ])('extracts a static Python %s path', async (_name, source, reads, writes) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads,
      writes
    })
  })

  it.each([
    [
      'Python',
      'python' as const,
      [
        'import pandas as pd',
        "pd.DataFrame({'x': [1]}).to_csv('intermediate.csv', index=False)",
        "frame = pd.read_csv('intermediate.csv')",
        "frame.to_csv('result.csv', index=False)"
      ].join('\n')
    ],
    [
      'R',
      'r' as const,
      [
        'table <- data.frame(x = 1)',
        "write.csv(table, 'intermediate.csv', row.names = FALSE)",
        "reloaded <- read.csv('intermediate.csv')",
        "write.csv(reloaded, 'result.csv', row.names = FALSE)"
      ].join('\n')
    ]
  ])(
    'treats a same-run %s write-before-read file as an intermediate',
    async (_name, language, source) => {
      await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toEqual({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [],
        writes: ['intermediate.csv', 'result.csv'],
        reasonCodes: []
      })
    }
  )

  it.each([
    [
      'Python',
      'python' as const,
      [
        'import pandas as pd',
        'def save_table(frame, path):',
        '    frame.to_csv(path, index=False)',
        "save_table(pd.DataFrame({'x': [1]}), 'intermediate.csv')",
        "frame = pd.read_csv('intermediate.csv')",
        "save_table(frame, 'result.csv')"
      ].join('\n')
    ],
    [
      'R',
      'r' as const,
      [
        'save_table <- function(table, path) write.csv(table, path, row.names = FALSE)',
        "save_table(data.frame(x = 1), 'intermediate.csv')",
        "table <- read.csv('intermediate.csv')",
        "save_table(table, 'result.csv')"
      ].join('\n')
    ]
  ])(
    'propagates same-run %s intermediate paths through a strict helper',
    async (_name, language, source) => {
      await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toEqual({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [],
        writes: ['intermediate.csv', 'result.csv'],
        reasonCodes: []
      })
    }
  )

  it.each([
    [
      'Python read-before-write',
      'python' as const,
      [
        'import pandas as pd',
        "frame = pd.read_csv('intermediate.csv')",
        "frame.to_csv('intermediate.csv', index=False)"
      ].join('\n')
    ],
    [
      'Python conditional write',
      'python' as const,
      [
        'import pandas as pd',
        'if should_generate:',
        "    pd.DataFrame({'x': [1]}).to_csv('intermediate.csv', index=False)",
        "frame = pd.read_csv('intermediate.csv')"
      ].join('\n')
    ],
    [
      'R read-before-write',
      'r' as const,
      [
        "table <- read.csv('intermediate.csv')",
        "write.csv(table, 'intermediate.csv', row.names = FALSE)"
      ].join('\n')
    ],
    [
      'R conditional write',
      'r' as const,
      [
        'if (should_generate) {',
        "  write.csv(data.frame(x = 1), 'intermediate.csv', row.names = FALSE)",
        '}',
        "table <- read.csv('intermediate.csv')"
      ].join('\n')
    ]
  ])('keeps a %s file as a captured input', async (_name, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      reads: ['intermediate.csv'],
      writes: ['intermediate.csv']
    })
  })

  it.each([
    ['imported StringIO', 'from io import StringIO', 'StringIO(csv_data)'],
    ['qualified StringIO', 'import io', 'io.StringIO(csv_data)'],
    ['imported BytesIO', 'from io import BytesIO', "BytesIO(b'group\\nCtrl')"]
  ])('does not treat an in-memory %s buffer as a file path', async (_name, importLine, buffer) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pandas as pd',
        importLine,
        "csv_data = 'group\\nCtrl'",
        `frame = pd.read_csv(${buffer})`
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: [],
      reasonCodes: []
    })
  })

  it.each([
    [
      'pandas StringIO binding',
      [
        'import pandas as pd',
        'from io import StringIO',
        "buffer = StringIO('group\\nCtrl')",
        'frame = pd.read_csv(buffer)'
      ].join('\n')
    ],
    [
      'NumPy BytesIO binding',
      [
        'import numpy as np',
        'from io import BytesIO',
        "buffer = BytesIO(b'NUMPY')",
        'values = np.load(buffer)'
      ].join('\n')
    ],
    [
      'Polars BytesIO binding',
      [
        'import polars as pl',
        'from io import BytesIO',
        "buffer = BytesIO(b'group\\nCtrl')",
        'frame = pl.read_csv(buffer)'
      ].join('\n')
    ]
  ])('does not treat a bound Python %s as a file path', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: [],
      reasonCodes: []
    })
  })

  it.each([
    [
      'rebound buffer',
      [
        'import pandas as pd',
        'from io import StringIO',
        "buffer = StringIO('group\\nCtrl')",
        'buffer = build_path()',
        'frame = pd.read_csv(buffer)'
      ].join('\n')
    ],
    [
      'conditionally rebound buffer',
      [
        'import pandas as pd',
        'from io import StringIO',
        "buffer = StringIO('group\\nCtrl')",
        'if use_file:',
        '    buffer = build_path()',
        'frame = pd.read_csv(buffer)'
      ].join('\n')
    ]
  ])('keeps a Python %s conservative', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('does not treat a shadowed StringIO import as an in-memory buffer', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pandas as pd',
        'from io import StringIO',
        'StringIO = make_path',
        "frame = pd.read_csv(StringIO('measurements.csv'))"
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'partial',
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'data.table text input',
      ["csv_text <- 'group,value\\nCtrl,1'", 'table <- data.table::fread(text = csv_text)'].join(
        '\n'
      )
    ],
    [
      'readr literal input',
      ["csv_text <- 'group,value\\nCtrl,1'", 'table <- readr::read_csv(I(csv_text))'].join('\n')
    ],
    [
      'inline text connection',
      ["csv_text <- 'group,value\\nCtrl,1'", 'table <- read.csv(textConnection(csv_text))'].join(
        '\n'
      )
    ],
    [
      'bound text connection',
      [
        "csv_text <- 'group,value\\nCtrl,1'",
        'input <- textConnection(csv_text)',
        'table <- read.csv(input)'
      ].join('\n')
    ]
  ])('does not treat an R %s as a file path', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: [],
      reasonCodes: []
    })
  })

  it.each([
    [
      'shadowed textConnection',
      [
        'textConnection <- function(value) build_path(value)',
        "table <- read.csv(textConnection('measurements.csv'))"
      ].join('\n')
    ],
    ['fread command input', "table <- data.table::fread(cmd = 'generate-measurements')"]
  ])('keeps an R %s conservative', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      readState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'pathlib and built-in open',
      [
        'from pathlib import Path',
        "root = Path('results')",
        "with open(root / 'summary.txt', 'w') as stream:",
        "    stream.write('done')"
      ].join('\n'),
      [],
      ['results/summary.txt']
    ],
    [
      'NumPy save',
      [
        'import numpy as np',
        "source = 'samples.csv'",
        'values = np.loadtxt(source)',
        "np.save('samples.npy', values)"
      ].join('\n'),
      ['samples.csv'],
      ['samples.npy']
    ],
    [
      'PyTorch save',
      ['import torch', "torch.save(torch.tensor([1]), 'model.pt')"].join('\n'),
      [],
      ['model.pt']
    ],
    [
      'static f-string output',
      [
        'import matplotlib.pyplot as plt',
        "output_dir = 'figures'",
        "plt.savefig(f'{output_dir}/chart.png')"
      ].join('\n'),
      [],
      ['figures/chart.png']
    ],
    [
      'Path.joinpath',
      [
        'from pathlib import Path',
        'import matplotlib.pyplot as plt',
        "output = Path('figures').joinpath('daily', 'chart.png')",
        'plt.savefig(output)'
      ].join('\n'),
      [],
      ['figures/daily/chart.png']
    ],
    [
      'Path.with_suffix',
      [
        'from pathlib import Path',
        'import matplotlib.pyplot as plt',
        "output = Path('figures/chart').with_suffix('.png')",
        'plt.savefig(output)'
      ].join('\n'),
      [],
      ['figures/chart.png']
    ],
    [
      'Path.with_name',
      [
        'from pathlib import Path',
        'import matplotlib.pyplot as plt',
        "output = Path('figures/draft.png').with_name('chart.png')",
        'plt.savefig(output)'
      ].join('\n'),
      [],
      ['figures/chart.png']
    ]
  ])('extracts %s paths', async (_name, source, reads, writes) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads,
      writes,
      reasonCodes: []
    })
  })

  it('keeps a dynamic built-in open mode conservative', async () => {
    await expect(
      analyzeNotebookSourceFileAccess('python', "open('result.bin', mode_from_config)")
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'gzip reader',
      "import gzip\nwith gzip.open('measurements.csv.gz', 'rt') as stream:\n    stream.read()",
      ['measurements.csv.gz'],
      []
    ],
    [
      'bz2 writer',
      "import bz2\nwith bz2.open('summary.csv.bz2', 'wt') as stream:\n    stream.write('done')",
      [],
      ['summary.csv.bz2']
    ],
    [
      'lzma direct import',
      "from lzma import open as xz_open\nwith xz_open('summary.csv.xz', 'wt') as stream:\n    stream.write('done')",
      [],
      ['summary.csv.xz']
    ],
    [
      'ZIP reader',
      "import zipfile\nwith zipfile.ZipFile('inputs.zip', 'r') as archive:\n    archive.namelist()",
      ['inputs.zip'],
      []
    ],
    [
      'ZIP writer',
      "from zipfile import ZipFile\nwith ZipFile('results.zip', 'w') as archive:\n    pass",
      [],
      ['results.zip']
    ],
    [
      'tar writer',
      "import tarfile\nwith tarfile.open(name='results.tar.gz', mode='w:gz') as archive:\n    pass",
      [],
      ['results.tar.gz']
    ]
  ])('extracts a static Python %s path', async (_label, source, reads, writes) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads,
      writes,
      reasonCodes: []
    })
  })

  it('treats append mode as both consuming and updating an archive', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import zipfile\nwith zipfile.ZipFile('results.zip', 'a') as archive:\n    pass"
      )
    ).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['results.zip'],
      writes: ['results.zip'],
      reasonCodes: []
    })
  })

  it('does not invent a file dependency for an in-memory compressed stream', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        [
          'from io import BytesIO',
          'import tarfile',
          "buffer = BytesIO(b'archive')",
          "with tarfile.open(fileobj=buffer, mode='r:') as archive:",
          '    archive.getmembers()'
        ].join('\n')
      )
    ).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: [],
      reasonCodes: []
    })
  })

  it.each([
    [
      'gzip reader',
      "payload <- readLines(gzfile('measurements.txt.gz', 'rt'))",
      ['measurements.txt.gz'],
      []
    ],
    [
      'bound bzip2 writer',
      "connection <- bzfile('summary.txt.bz2', 'wt')\nwriteLines('done', connection)",
      [],
      ['summary.txt.bz2']
    ],
    ['xz writer', "writeLines('done', xzfile('summary.txt.xz', 'wt'))", [], ['summary.txt.xz']],
    [
      'ZIP member reader',
      "payload <- readLines(unz('inputs.zip', 'measurements.txt'))",
      ['inputs.zip'],
      []
    ]
  ])('extracts an R %s path', async (_label, source, reads, writes) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads,
      writes,
      reasonCodes: []
    })
  })

  it.each([
    [
      'temporary file',
      'python' as const,
      "import tempfile\nwith tempfile.NamedTemporaryFile() as stream:\n    stream.write(b'data')"
    ],
    [
      'SQLite connection',
      'python' as const,
      "import sqlite3\nconnection = sqlite3.connect('results.sqlite')\nconnection.execute('select 1')"
    ],
    [
      'DuckDB connection',
      'python' as const,
      "import duckdb\nconnection = duckdb.connect('results.duckdb')\nconnection.sql('select 1')"
    ],
    [
      'R DBI connection',
      'r' as const,
      "connection <- DBI::dbConnect(RSQLite::SQLite(), 'results.sqlite')\nDBI::dbGetQuery(connection, 'select 1')"
    ],
    [
      'R temporary file',
      'r' as const,
      "output <- tempfile(fileext = '.csv')\nwrite.csv(data.frame(value = 1), output)"
    ]
  ])(
    'keeps %s state conservative without inventing file paths',
    async (_label, language, source) => {
      await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
        externalState: 'partial',
        reads: [],
        writes: [],
        reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
      })
    }
  )

  it('keeps finite static branch outputs as complete candidates', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import matplotlib.pyplot as plt',
        'if False:',
        "    plt.savefig('chart.svg')",
        'else:',
        "    plt.savefig('chart.png')"
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['chart.png', 'chart.svg'],
      reasonCodes: []
    })
  })

  it('resolves a direct local Python file wrapper', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import matplotlib.pyplot as plt',
        'def save_plot(path):',
        '    plt.savefig(path)',
        "save_plot('wrapped.png')"
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['wrapped.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'Python',
      'python' as const,
      [
        'import pandas as pd',
        'def load_table(path):',
        '    return pd.read_csv(path)',
        "frame = load_table('measurements.csv')"
      ].join('\n')
    ],
    [
      'R',
      'r' as const,
      [
        'load_table <- function(path) readr::read_csv(path)',
        "table <- load_table('measurements.csv')"
      ].join('\n')
    ]
  ])('resolves a strict local %s reader helper', async (_name, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['measurements.csv'],
      writes: [],
      reasonCodes: []
    })
  })

  it.each([
    ['NumPy archive', "import numpy as np\nnp.savez('arrays.npz', values=[1, 2, 3])", 'arrays.npz'],
    ['xarray NetCDF', "import xarray as xr\nxr.Dataset().to_netcdf('dataset.nc')", 'dataset.nc'],
    ['OpenCV image', "import cv2\ncv2.imwrite('image.png', pixels)", 'image.png'],
    ['Plotly HTML', "import plotly.io as pio\npio.write_html(figure, 'figure.html')", 'figure.html']
  ])('extracts common Python %s output paths', async (_name, source, output) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'complete',
      writes: [output]
    })
  })

  it.each([
    [
      'Python',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        'for name in names:',
        "    plt.savefig(f'figures/{name}.png')"
      ].join('\n')
    ],
    [
      'Python tuple',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        "names = ('sin', 'cos')",
        'for name in names:',
        "    plt.savefig(f'figures/{name}.png')"
      ].join('\n')
    ],
    [
      'R',
      'r' as const,
      [
        "names <- c('sin', 'cos')",
        'for (name in names) {',
        "  ggplot2::ggsave(filename = file.path('figures', paste0(name, '.png')))",
        '}'
      ].join('\n')
    ],
    [
      'R list',
      'r' as const,
      [
        "names <- list('sin', 'cos')",
        'for (name in names) {',
        "  ggplot2::ggsave(filename = file.path('figures', paste0(name, '.png')))",
        '}'
      ].join('\n')
    ]
  ])('extracts finite %s loop output paths', async (_name, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['figures/cos.png', 'figures/sin.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'scalar broadcasting',
      [
        "names <- c('sin', 'cos')",
        "paths <- file.path('figures', paste0(names, '.png'))",
        'for (path in paths) {',
        '  ggplot2::ggsave(filename = path)',
        '}'
      ].join('\n'),
      ['figures/cos.png', 'figures/sin.png']
    ],
    [
      'equal-length vectors',
      [
        "directories <- c('figures/a', 'figures/b')",
        "names <- c('sin', 'cos')",
        "paths <- file.path(directories, paste0(names, '.png'))",
        'for (path in paths) {',
        '  ggplot2::ggsave(filename = path)',
        '}'
      ].join('\n'),
      ['figures/a/sin.png', 'figures/b/cos.png']
    ],
    [
      'static paste separator',
      [
        "directories <- c('figures/a', 'figures/b')",
        "names <- c('sin', 'cos')",
        "paths <- paste(directories, paste0(names, '.png'), sep = '/')",
        'for (path in paths) {',
        '  ggplot2::ggsave(filename = path)',
        '}'
      ].join('\n'),
      ['figures/a/sin.png', 'figures/b/cos.png']
    ]
  ])('resolves R vectorized path generation with %s', async (_name, source, writes) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes,
      reasonCodes: []
    })
  })

  it.each([
    [
      'uneven vector recycling',
      [
        "directories <- c('figures/a', 'figures/b')",
        "names <- c('sin', 'cos', 'tan')",
        "paths <- file.path(directories, paste0(names, '.png'))"
      ].join('\n')
    ],
    [
      'dynamic input',
      [
        'names <- build_output_names()',
        "paths <- file.path('figures', paste0(names, '.png'))"
      ].join('\n')
    ],
    [
      'collapsed result',
      ["names <- c('sin', 'cos')", "paths <- paste0(names, '.png', collapse = ',')"].join('\n')
    ]
  ])('keeps R vectorized path generation with %s conservative', async (_name, assignment) => {
    const source = [
      assignment,
      'for (path in paths) {',
      '  ggplot2::ggsave(filename = path)',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'one vector',
      ["names <- c('sin', 'cos')", "paths <- sprintf('figures/%s.png', names)"].join('\n'),
      ['figures/cos.png', 'figures/sin.png']
    ],
    [
      'equal-length vectors',
      [
        "directories <- c('figures/a', 'figures/b')",
        "names <- c('sin', 'cos')",
        "paths <- sprintf('%s/%s.png', directories, names)"
      ].join('\n'),
      ['figures/a/sin.png', 'figures/b/cos.png']
    ],
    [
      'escaped percent',
      ["names <- c('sin', 'cos')", "paths <- sprintf('figures/%s-100%%.png', names)"].join('\n'),
      ['figures/cos-100%.png', 'figures/sin-100%.png']
    ]
  ])('resolves R sprintf path generation with %s', async (_name, assignment, writes) => {
    const source = [
      assignment,
      'for (path in paths) {',
      '  ggplot2::ggsave(filename = path)',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes,
      reasonCodes: []
    })
  })

  it('resolves a direct R sprintf output path', async () => {
    const source = "ggplot2::ggsave(filename = sprintf(fmt = 'figures/%s.png', 'sin'))"

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'complete',
      writes: ['figures/sin.png'],
      reasonCodes: []
    })
  })

  it.each([
    ['dynamic format', ['format <- output_format()', "paths <- sprintf(format, 'sin')"].join('\n')],
    [
      'unsupported conversion',
      ["numbers <- c('1', '2')", "paths <- sprintf('figure-%02d.png', numbers)"].join('\n')
    ],
    [
      'uneven vectors',
      [
        "directories <- c('figures/a', 'figures/b')",
        "names <- c('sin', 'cos', 'tan')",
        "paths <- sprintf('%s/%s.png', directories, names)"
      ].join('\n')
    ]
  ])('keeps R sprintf path generation with %s conservative', async (_name, assignment) => {
    const source = [
      assignment,
      'for (path in paths) {',
      '  ggplot2::ggsave(filename = path)',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('resolves vectorized fs::path output paths', async () => {
    const source = [
      "names <- c('sin', 'cos')",
      "paths <- fs::path('figures', paste0(names, '.png'))",
      'for (path in paths) {',
      '  ggplot2::ggsave(filename = path)',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['figures/cos.png', 'figures/sin.png'],
      reasonCodes: []
    })
  })

  it('resolves equal-length fs::path vectors', async () => {
    const source = [
      "directories <- c('figures/a', 'figures/b')",
      "names <- c('sin.png', 'cos.png')",
      'paths <- fs::path(directories, names)',
      'for (path in paths) ggplot2::ggsave(filename = path)'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'complete',
      writes: ['figures/a/sin.png', 'figures/b/cos.png'],
      reasonCodes: []
    })
  })

  it('resolves a direct fs::path output path', async () => {
    const source = "ggplot2::ggsave(filename = fs::path('figures', 'sin.png'))"

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'complete',
      writes: ['figures/sin.png'],
      reasonCodes: []
    })
  })

  it.each([
    ['an unqualified call', "paths <- path('figures', 'sin.png')"],
    ['an unsupported named option', "paths <- fs::path('sin', ext = 'png')"]
  ])('keeps R fs path generation with %s conservative', async (_name, assignment) => {
    const source = [
      assignment,
      'for (path in paths) {',
      '  ggplot2::ggsave(filename = path)',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'a scalar binding',
      ["name <- 'sin'", "path <- glue::glue('figures/{name}.png')"].join('\n'),
      ['figures/sin.png']
    ],
    [
      'a vector binding',
      ["names <- c('sin', 'cos')", "path <- glue::glue('figures/{names}.png')"].join('\n'),
      ['figures/cos.png', 'figures/sin.png']
    ],
    [
      'equal-length bindings',
      [
        "directories <- c('figures/a', 'figures/b')",
        "names <- c('sin', 'cos')",
        "path <- glue::glue('{directories}/{names}.png')"
      ].join('\n'),
      ['figures/a/sin.png', 'figures/b/cos.png']
    ],
    [
      'escaped braces',
      ["name <- 'sin'", "path <- glue::glue('figures/{{draft}}-{name}.png')"].join('\n'),
      ['figures/{draft}-sin.png']
    ]
  ])('resolves R glue paths with %s', async (_name, assignment, writes) => {
    const source = [
      assignment,
      'for (output in path) {',
      '  ggplot2::ggsave(filename = output)',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes,
      reasonCodes: []
    })
  })

  it('records glue interpolation names as R dependencies', async () => {
    const [facts] = await analyzeRSources(["path <- glue::glue('figures/{name}.png')"])

    expect(facts).toMatchObject({
      state: 'available',
      definedNames: ['path'],
      usedNames: expect.arrayContaining(['glue::glue', 'name']),
      priorUsedNames: expect.arrayContaining(['glue::glue', 'name']),
      safeCallNames: ['glue::glue']
    })
  })

  it('resolves an R glue binding carried from a prior cell', async () => {
    const source = [
      "path <- glue::glue('figures/{name}.png')",
      'ggplot2::ggsave(filename = path)'
    ].join('\n')

    await expect(
      analyzeNotebookSourceFileAccess('r', source, {
        staticStrings: [{ name: 'name', value: 'sin' }],
        staticCollections: [],
        localFileWrappers: []
      })
    ).resolves.toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      writes: ['figures/sin.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'Python',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        'for name in names:',
        "    plt.savefig(f'figures/{name}.png')"
      ].join('\n')
    ],
    [
      'R',
      'r' as const,
      [
        "path <- glue::glue('figures/{names}.png')",
        'for (output in path) ggplot2::ggsave(filename = output)'
      ].join('\n')
    ]
  ])(
    'resolves a static collection carried from a prior %s cell',
    async (_name, language, source) => {
      await expect(
        analyzeNotebookSourceFileAccess(language, source, {
          staticStrings: [],
          staticCollections: [{ name: 'names', values: ['sin', 'cos'] }],
          localFileWrappers: []
        })
      ).resolves.toEqual({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [],
        writes: ['figures/cos.png', 'figures/sin.png'],
        reasonCodes: []
      })
    }
  )

  it.each([
    [
      'a dynamic template',
      ['template <- build_template()', 'path <- glue::glue(template)'].join('\n')
    ],
    [
      'an expression placeholder',
      ["name <- 'sin'", "path <- glue::glue('figures/{toupper(name)}.png')"].join('\n')
    ],
    ['an unmatched brace', "path <- glue::glue('figures/{name.png')"],
    [
      'uneven vectors',
      [
        "directories <- c('figures/a', 'figures/b')",
        "names <- c('sin', 'cos', 'tan')",
        "path <- glue::glue('{directories}/{names}.png')"
      ].join('\n')
    ],
    ['an unqualified call', ["name <- 'sin'", "path <- glue('figures/{name}.png')"].join('\n')]
  ])('keeps R glue paths with %s conservative', async (_name, assignment) => {
    const source = [
      assignment,
      'for (output in path) {',
      '  ggplot2::ggsave(filename = output)',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'Python dictionary values',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        "outputs = {'sin': 'figures/sin.png', 'cos': 'figures/cos.png'}",
        'for path in outputs.values():',
        '    plt.savefig(path)'
      ].join('\n')
    ],
    [
      'Python dictionary items',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        "outputs = {'sin': 'figures/sin.png', 'cos': 'figures/cos.png'}",
        'for name, path in outputs.items():',
        "    plt.savefig(f'figures/{name}.png')",
        '    plt.savefig(path)'
      ].join('\n')
    ],
    [
      'Python dictionary keys',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        "outputs = {'sin': 'figures/sin.png', 'cos': 'figures/cos.png'}",
        'for name in outputs.keys():',
        "    plt.savefig(f'figures/{name}.png')"
      ].join('\n')
    ],
    [
      'R named list values',
      'r' as const,
      [
        "outputs <- list(sin = 'figures/sin.png', cos = 'figures/cos.png')",
        'for (path in outputs) {',
        '  ggplot2::ggsave(filename = path)',
        '}'
      ].join('\n')
    ]
  ])('extracts finite %s output paths', async (_name, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['figures/cos.png', 'figures/sin.png'],
      reasonCodes: []
    })
  })

  it('keeps a partially dynamic Python dictionary conservative', async () => {
    const source = [
      'import matplotlib.pyplot as plt',
      "outputs = {'sin': 'figures/sin.png', 'cos': build_output_path()}",
      'for path in outputs.values():',
      '    plt.savefig(path)'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('keeps a Python dictionary with a dynamic key conservative', async () => {
    const source = [
      'import matplotlib.pyplot as plt',
      "outputs = {build_name(): 'figures/plot.png'}",
      'for name, path in outputs.items():',
      "    plt.savefig(f'figures/{name}.png')"
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('keeps unordered Python set iteration conservative', async () => {
    const source = [
      'import matplotlib.pyplot as plt',
      "names = {'sin', 'cos'}",
      'for index, name in enumerate(names):',
      "    plt.savefig(f'figures/{index}-{name}.png')"
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'named sequences',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        "paths = ['figures/sin.png', 'figures/cos.png']",
        'for name, path in zip(names, paths):',
        '    plt.savefig(path)'
      ].join('\n'),
      ['figures/cos.png', 'figures/sin.png']
    ],
    [
      'literal sequences',
      [
        'import matplotlib.pyplot as plt',
        "for name, path in zip(['sin', 'cos'], ['figures/sin.png', 'figures/cos.png']):",
        '    plt.savefig(path)'
      ].join('\n'),
      ['figures/cos.png', 'figures/sin.png']
    ],
    [
      'uneven sequences',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        "paths = ['figures/sin.png']",
        'for name, path in zip(names, paths):',
        '    plt.savefig(path)'
      ].join('\n'),
      ['figures/sin.png']
    ],
    [
      'repeated labels',
      [
        'import matplotlib.pyplot as plt',
        "names = ['plot', 'plot']",
        "paths = ['figures/first.png', 'figures/second.png']",
        'for name, path in zip(names, paths):',
        '    plt.savefig(path)'
      ].join('\n'),
      ['figures/first.png', 'figures/second.png']
    ]
  ])('resolves Python zip over %s', async (_name, source, writes) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes,
      reasonCodes: []
    })
  })

  it('keeps a Python zip with a dynamic sequence conservative', async () => {
    const source = [
      'import matplotlib.pyplot as plt',
      "names = ['sin', 'cos']",
      'for name, path in zip(names, build_output_paths()):',
      '    plt.savefig(path)'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'enumerate paths',
      [
        'import matplotlib.pyplot as plt',
        "paths = ['figures/sin.png', 'figures/cos.png']",
        'for index, path in enumerate(paths):',
        '    plt.savefig(path)'
      ].join('\n'),
      ['figures/cos.png', 'figures/sin.png']
    ],
    [
      'enumerate with start',
      [
        'import matplotlib.pyplot as plt',
        "paths = ['sin', 'cos']",
        'for index, path in enumerate(paths, start=1):',
        "    plt.savefig(f'figures/plot-{index}.png')"
      ].join('\n'),
      ['figures/plot-1.png', 'figures/plot-2.png']
    ],
    [
      'tuple-pair sequence',
      [
        'import matplotlib.pyplot as plt',
        "pairs = [('sin', 'figures/sin.png'), ('cos', 'figures/cos.png')]",
        'for name, path in pairs:',
        '    plt.savefig(path)'
      ].join('\n'),
      ['figures/cos.png', 'figures/sin.png']
    ]
  ])('resolves Python %s', async (_name, source, writes) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes,
      reasonCodes: []
    })
  })

  it.each([
    [
      'dynamic enumerate start',
      [
        'import matplotlib.pyplot as plt',
        "paths = ['sin', 'cos']",
        'for index, path in enumerate(paths, start=offset):',
        "    plt.savefig(f'figures/plot-{index}.png')"
      ].join('\n')
    ],
    [
      'dynamic tuple-pair value',
      [
        'import matplotlib.pyplot as plt',
        "for name, path in [('sin', 'figures/sin.png'), ('cos', build_output_path())]:",
        '    plt.savefig(path)'
      ].join('\n')
    ]
  ])('keeps Python %s conservative', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'reversed with enumerate',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        'for index, name in enumerate(reversed(names), start=1):',
        "    plt.savefig(f'figures/{index}-{name}.png')"
      ].join('\n'),
      ['figures/1-cos.png', 'figures/2-sin.png']
    ],
    [
      'sorted reverse',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        'for index, name in enumerate(sorted(names, reverse=True), start=1):',
        "    plt.savefig(f'figures/{index}-{name}.png')"
      ].join('\n'),
      ['figures/1-sin.png', 'figures/2-cos.png']
    ],
    [
      'list and tuple wrappers',
      [
        'import matplotlib.pyplot as plt',
        "paths = ['figures/sin.png', 'figures/cos.png']",
        'for path in list(tuple(paths)):',
        '    plt.savefig(path)'
      ].join('\n'),
      ['figures/cos.png', 'figures/sin.png']
    ]
  ])('resolves Python static %s', async (_name, source, writes) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes,
      reasonCodes: []
    })
  })

  it.each([
    [
      'sorted key',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        'for index, name in enumerate(sorted(names, key=str.lower), start=1):',
        "    plt.savefig(f'figures/{index}-{name}.png')"
      ].join('\n')
    ],
    [
      'dynamic sorted reverse',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        'for index, name in enumerate(sorted(names, reverse=descending), start=1):',
        "    plt.savefig(f'figures/{index}-{name}.png')"
      ].join('\n')
    ],
    [
      'shadowed sorted',
      [
        'import matplotlib.pyplot as plt',
        'def sorted(values):',
        '    return build_output_names(values)',
        "names = ['sin', 'cos']",
        'for name in sorted(names):',
        "    plt.savefig(f'figures/{name}.png')"
      ].join('\n')
    ]
  ])('keeps Python %s conservative', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'simple list comprehension',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        "paths = [f'figures/{name}.png' for name in names]",
        'for path in paths:',
        '    plt.savefig(path)'
      ].join('\n')
    ],
    [
      'tuple-target list comprehension',
      [
        'import matplotlib.pyplot as plt',
        "pairs = [('sin', 'figures/sin.png'), ('cos', 'figures/cos.png')]",
        'paths = [path for name, path in pairs]',
        'for path in paths:',
        '    plt.savefig(path)'
      ].join('\n')
    ]
  ])('resolves Python %s', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['figures/cos.png', 'figures/sin.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'filtered list comprehension',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        "paths = [f'figures/{name}.png' for name in names if enabled(name)]",
        'for path in paths:',
        '    plt.savefig(path)'
      ].join('\n')
    ],
    [
      'multi-generator list comprehension',
      [
        'import matplotlib.pyplot as plt',
        "names = ['sin', 'cos']",
        "formats = ['png', 'svg']",
        "paths = [f'figures/{name}.{format}' for name in names for format in formats]",
        'for path in paths:',
        '    plt.savefig(path)'
      ].join('\n')
    ],
    [
      'dynamic list-comprehension input',
      [
        'import matplotlib.pyplot as plt',
        "paths = [f'figures/{name}.png' for name in build_output_names()]",
        'for path in paths:',
        '    plt.savefig(path)'
      ].join('\n')
    ]
  ])('keeps Python %s conservative', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('resolves R named-list keys and double-bracket values', async () => {
    const source = [
      "outputs <- list(sin = 'figures/sin.png', cos = 'figures/cos.png')",
      'for (name in names(outputs)) {',
      '  ggplot2::ggsave(filename = outputs[[name]])',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['figures/cos.png', 'figures/sin.png'],
      reasonCodes: []
    })
  })

  it('resolves R named-list keys through a static alias', async () => {
    const source = [
      "outputs <- list(sin = 'figures/sin.png', cos = 'figures/cos.png')",
      'paths <- outputs',
      'for (name in names(paths)) {',
      '  ggplot2::ggsave(filename = paths[[name]])',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      writes: ['figures/cos.png', 'figures/sin.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'dynamic value',
      [
        "outputs <- list(sin = 'figures/sin.png', cos = build_output_path())",
        'for (name in names(outputs)) {',
        '  ggplot2::ggsave(filename = outputs[[name]])',
        '}'
      ].join('\n')
    ],
    [
      'partially named list',
      [
        "outputs <- list(sin = 'figures/sin.png', 'figures/cos.png')",
        'for (name in names(outputs)) {',
        '  ggplot2::ggsave(filename = outputs[[name]])',
        '}'
      ].join('\n')
    ]
  ])('keeps an R named list with a %s conservative', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    ['setNames', "outputs <- setNames(c('figures/sin.png', 'figures/cos.png'), c('sin', 'cos'))"],
    [
      'qualified setNames',
      "outputs <- stats::setNames(c('figures/sin.png', 'figures/cos.png'), c('sin', 'cos'))"
    ],
    [
      'structure names',
      "outputs <- structure(c('figures/sin.png', 'figures/cos.png'), names = c('sin', 'cos'))"
    ]
  ])('resolves R named collections created with %s', async (_name, assignment) => {
    const source = [
      assignment,
      'for (name in names(outputs)) {',
      '  ggplot2::ggsave(filename = outputs[[name]])',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      writes: ['figures/cos.png', 'figures/sin.png'],
      reasonCodes: []
    })
  })

  it.each([
    [
      'dynamic names',
      "outputs <- setNames(c('figures/sin.png', 'figures/cos.png'), build_names())"
    ],
    [
      'mismatched names',
      "outputs <- structure(c('figures/sin.png', 'figures/cos.png'), names = c('sin'))"
    ]
  ])('keeps R %s collection construction conservative', async (_name, assignment) => {
    const source = [
      assignment,
      'for (name in names(outputs)) {',
      '  ggplot2::ggsave(filename = outputs[[name]])',
      '}'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'Python',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        'for name in build_output_names():',
        "    plt.savefig(f'figures/{name}.png')"
      ].join('\n')
    ],
    [
      'R',
      'r' as const,
      [
        'for (name in build_output_names()) {',
        "  ggplot2::ggsave(filename = file.path('figures', paste0(name, '.png')))",
        '}'
      ].join('\n')
    ]
  ])('keeps a dynamic %s output loop conservative', async (_name, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'Python',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        'if enabled:',
        "    names = ['sin', 'cos']",
        'for name in names:',
        "    plt.savefig(f'figures/{name}.png')"
      ].join('\n')
    ],
    [
      'R',
      'r' as const,
      [
        'if (enabled) {',
        "  names <- c('sin', 'cos')",
        '}',
        'for (name in names) {',
        "  ggplot2::ggsave(filename = file.path('figures', paste0(name, '.png')))",
        '}'
      ].join('\n')
    ]
  ])(
    'does not trust a conditionally defined %s output collection',
    async (_name, language, source) => {
      await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
        writeState: 'partial',
        writes: [],
        reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
      })
    }
  )

  it.each([
    [
      'Python',
      'python' as const,
      [
        'import matplotlib.pyplot as plt',
        "for name in ['sin', 'cos']:",
        "    plt.savefig(f'figures/{name}.png')",
        '    break'
      ].join('\n')
    ],
    [
      'R',
      'r' as const,
      [
        "for (name in c('sin', 'cos')) {",
        "  ggplot2::ggsave(filename = file.path('figures', paste0(name, '.png')))",
        '  break',
        '}'
      ].join('\n')
    ]
  ])('keeps a %s loop with early exit conservative', async (_name, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'Python',
      'python' as const,
      `for path in [${Array.from({ length: 129 }, (_, index) => `'file-${index}.png'`).join(',')}]:\n    open(path, 'w')`
    ],
    [
      'R',
      'r' as const,
      `for (path in c(${Array.from({ length: 129 }, (_, index) => `'file-${index}.png'`).join(',')})) writeLines('x', path)`
    ]
  ])('caps oversized finite %s loops conservatively', async (_name, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'Python Zarr store',
      'python' as const,
      "dataset.to_zarr('dataset.zarr')",
      'dataset.zarr',
      'directory'
    ],
    [
      'Python Arrow dataset',
      'python' as const,
      "import pyarrow.dataset as ds\nds.write_dataset(table, 'dataset')",
      'dataset',
      'directory'
    ],
    [
      'R Arrow dataset',
      'r' as const,
      "arrow::write_dataset(table, 'dataset')",
      'dataset',
      'directory'
    ],
    [
      'R HDF5-backed dataset',
      'r' as const,
      "sce <- data.frame(x = 1)\nHDF5Array::saveHDF5SummarizedExperiment(sce, dir = 'sce_h5')",
      'sce_h5',
      'directory'
    ],
    ['R Shapefile', 'r' as const, "sf::st_write(layer, 'shape.shp')", 'shape.shp', 'shapefile'],
    ['R GeoTIFF', 'r' as const, "terra::writeRaster(raster, 'raster.tif')", 'raster.tif', 'geotiff']
  ])('extracts a scoped %s target', async (_name, language, source, path, kind) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      writeState: 'complete',
      writes: [path],
      writeScopes: [{ kind, path }]
    })
  })

  it('extracts an exact GeoPackage target from qualified sf', async () => {
    await expect(
      analyzeNotebookSourceFileAccess('r', "sf::st_write(layer, 'shape.gpkg')")
    ).resolves.toMatchObject({
      writeState: 'complete',
      writes: ['shape.gpkg']
    })
  })

  it('keeps an unregistered Python exporter conservative', async () => {
    const source = "model.export_bundle('bundle.zip')"

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    ['a non-Zarr target', "dataset.to_zarr('dataset.store')"],
    ['an unrelated imported function', "from custom import to_zarr\nto_zarr('dataset.zarr')"],
    ['an unrelated dataset method', "writer.write_dataset(table, 'dataset')"]
  ])('keeps Python %s conservative', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('does not apply a library effect to a shadowing Python function', async () => {
    const source = [
      'def savez(path):',
      '    stage(path)',
      '    publish(path)',
      "savez('archive.npz')"
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'data.table',
      [
        "table <- data.table::fread('measurements.csv')",
        "data.table::fwrite(table, 'summary.csv')"
      ].join('\n'),
      ['measurements.csv'],
      ['summary.csv']
    ],
    [
      'openxlsx',
      [
        "book <- openxlsx::loadWorkbook('source.xlsx')",
        "openxlsx::saveWorkbook(book, 'result.xlsx', overwrite = TRUE)"
      ].join('\n'),
      ['source.xlsx'],
      ['result.xlsx']
    ],
    [
      'ggplot2',
      [
        'chart <- ggplot2::ggplot(data.frame(x = 1:3, y = 1:3), ggplot2::aes(x, y))',
        "ggplot2::ggsave('chart.png', plot = chart)"
      ].join('\n'),
      [],
      ['chart.png']
    ],
    [
      'static paste output',
      [
        "output_name <- 'summary'",
        'table <- data.frame(x = 1:3)',
        "write.csv(table, paste(output_name, '.csv', sep = ''))"
      ].join('\n'),
      [],
      ['summary.csv']
    ],
    [
      'static branch outputs',
      [
        'table <- data.frame(x = 1:3)',
        'if (FALSE) {',
        "  write.csv(table, 'summary.csv')",
        '} else {',
        "  saveRDS(table, 'summary.rds')",
        '}'
      ].join('\n'),
      [],
      ['summary.csv', 'summary.rds']
    ]
  ])('extracts common R %s file access', async (_name, source, reads, writes) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads,
      writes,
      reasonCodes: []
    })
  })

  it.each([
    [
      'new openxlsx workbook',
      [
        'book <- openxlsx::createWorkbook()',
        "openxlsx::addWorksheet(book, 'Sheet 1')",
        "openxlsx::writeData(book, 'Sheet 1', data.frame(x = 1))",
        "openxlsx::saveWorkbook(book, 'book.xlsx', overwrite = TRUE)"
      ].join('\n'),
      'book.xlsx'
    ],
    [
      'qualified base graphics device',
      "grDevices::png('base.png')\nplot(1:3)\ngrDevices::dev.off()",
      'base.png'
    ],
    [
      'ragg graphics device',
      "ragg::agg_png('ragg.png')\nplot(1:3)\ngrDevices::dev.off()",
      'ragg.png'
    ],
    [
      'svglite graphics device',
      "svglite::svglite('chart.svg')\nplot(1:3)\ngrDevices::dev.off()",
      'chart.svg'
    ],
    [
      'compressed connection',
      [
        "connection <- gzfile('table.csv.gz', 'wt')",
        'write.csv(data.frame(x = 1), connection, row.names = FALSE)',
        'close(connection)'
      ].join('\n'),
      'table.csv.gz'
    ]
  ])('extracts a static R %s output', async (_name, source, output) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: [output]
    })
  })

  it('resolves a direct local R file wrapper', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        'save_plot <- function(path) {',
        '  ggplot2::ggsave(filename = path)',
        '}',
        "save_plot('wrapped.png')"
      ].join('\n')
    )

    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['wrapped.png'],
      reasonCodes: []
    })
  })

  it.each([
    ['binary file', "writeBin(as.raw(1:3), 'values.bin')", 'values.bin'],
    ['text file', "writeLines('done', 'note.txt')", 'note.txt'],
    ['workspace image', "save.image(file = 'workspace.RData')", 'workspace.RData']
  ])('extracts common R %s output paths', async (_name, source, output) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'complete',
      writes: [output]
    })
  })

  it('does not treat writeLines without a connection as a file write', async () => {
    await expect(analyzeNotebookSourceFileAccess('r', "writeLines('done')")).resolves.toMatchObject(
      {
        writeState: 'complete',
        writes: []
      }
    )
  })

  it.each([
    ['dynamic spatial dataset', 'sf::st_write(layer, output_path)'],
    ['unsupported raster format', "terra::writeRaster(raster, 'raster.grd')"]
  ])('keeps an unmodeled R %s conservative', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('does not apply a library effect to a shadowing R function', async () => {
    const source = [
      'save.image <- function(path) {',
      '  stage(path)',
      '  publish(path)',
      '}',
      "save.image('workspace.RData')"
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    [
      'Python',
      'python' as const,
      'import matplotlib.pyplot as plt\nplt.savefig(output_path)',
      'output_path',
      'figures/python.png'
    ],
    ['R', 'r' as const, 'ggplot2::ggsave(filename = output_path)', 'output_path', 'figures/r.png']
  ])(
    'resolves a static path carried from a prior %s cell',
    async (_name, language, source, name, value) => {
      await expect(
        analyzeNotebookSourceFileAccess(language, source, {
          staticStrings: [{ name, value }],
          staticCollections: [],
          localFileWrappers: []
        })
      ).resolves.toEqual({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [],
        writes: [value],
        reasonCodes: []
      })
    }
  )

  it.each([
    ['Python', 'python' as const, "save_plot('python.png')"],
    ['R', 'r' as const, "save_plot('r.png')"]
  ])(
    'resolves a strict file wrapper carried from a prior %s cell',
    async (_name, language, source) => {
      await expect(
        analyzeNotebookSourceFileAccess(language, source, {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [
            {
              name: 'save_plot',
              kind: 'write',
              position: 0,
              keywords: ['path'],
              dependencyNames: []
            }
          ]
        })
      ).resolves.toEqual({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [],
        writes: [language === 'r' ? 'r.png' : 'python.png'],
        reasonCodes: []
      })
    }
  )

  it('does not reuse a prior static path after a current-cell redefinition', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'output_path = build_output_path()\nplt.savefig(output_path)',
      {
        staticStrings: [{ name: 'output_path', value: 'stale.png' }],
        staticCollections: [],
        localFileWrappers: []
      }
    )

    expect(result).toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('keeps a dynamic output path conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'plt.savefig(build_output_path())'
    )

    expect(result).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining([
        'dynamic-path-unresolved',
        'source-analysis-unsupported-call'
      ])
    })
  })

  it('keeps formatted f-string output paths conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      "name = 'chart'; plt.savefig(f'{name!r}.png')"
    )

    expect(result).toMatchObject({
      writeState: 'partial',
      externalState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('keeps an unmodeled network input conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import requests',
        "response = requests.get('https://example.test/data.csv')",
        "open('result.csv', 'wb').write(response.content)"
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial',
      writes: ['result.csv'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('keeps an exact R output independent from a dynamic input path', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        'input_path <- build_input_path()',
        'table <- read.csv(input_path)',
        "write.csv(table, 'summary.csv')"
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial',
      reads: [],
      writes: ['summary.csv'],
      reasonCodes: expect.arrayContaining([
        'dynamic-path-unresolved',
        'source-analysis-unsupported-call'
      ])
    })
  })

  it('keeps unseeded random state conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import numpy as np',
        'values = np.random.normal(size=10)',
        "np.savetxt('samples.csv', values)"
      ].join('\n')
    )

    expect(result).toMatchObject({
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial',
      writes: ['samples.csv'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('keeps prior kernel variables conservative without a resolved same-epoch context', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      "plt.plot(x, y); plt.savefig('chart.png')"
    )

    expect(result).toMatchObject({
      readState: 'partial',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['chart.png'],
      reasonCodes: ['source-analysis-unsupported-call']
    })
  })

  it.each([
    ['Python', 'python' as const, "plt.plot(x, y); plt.savefig('chart.png')"],
    ['R', 'r' as const, "ggplot2::ggsave(filename = 'chart.png', plot = chart)"]
  ])(
    'separates resolved prior %s values from file-read coverage',
    async (_name, language, source) => {
      await expect(
        analyzeNotebookSourceFileAccess(language, source, {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          resolvedKernelNames: language === 'r' ? ['chart'] : ['plt', 'x', 'y']
        })
      ).resolves.toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        writes: ['chart.png'],
        reasonCodes: []
      })
    }
  )
})
