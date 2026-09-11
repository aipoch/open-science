// Argument evaluation contracts, separate from AST traversal and file effects.
// A known name identifies a contract; it does not certify the supplied callback.
// With exclusively unclassed atomic inputs, these base operations produce atomic
// data (possibly empty), not callbacks. Classed/unknown arguments and shadowed
// functions do not satisfy this contract. This says nothing about vector length.
export const R_ATOMIC_VECTOR_CALLS = new Set([
  'c',
  'character',
  'integer',
  'logical',
  'numeric',
  'seq',
  'seq_along',
  'seq_len',
  'rep',
  'as.character',
  'as.integer',
  'as.logical',
  'as.numeric',
  'abs',
  'ceiling',
  'floor',
  'round',
  'signif',
  'sign',
  'trunc',
  'exp',
  'expm1',
  'log1p',
  'log',
  'log2',
  'log10',
  'min',
  'max',
  'pmin',
  'pmax',
  'range',
  'is.finite',
  'is.infinite',
  'is.nan',
  'sqrt',
  'sin',
  'cos',
  'tan',
  'sort',
  'rev',
  'unique',
  'paste',
  'paste0',
  'sprintf'
])

// See dplyr's programming/across guides and ggplot2's layer documentation.
// These constructors evaluate ordinary values; callbacks and unknown expressions in their
// arguments still go through the normal walker. They do not render or load plot inputs.
export const R_PLOT_COMPOSITION_CONSTRUCTORS = new Map([
  ['plot_annotation', 'patchwork'],
  ['plot_layout', 'patchwork'],
  ['plot_spacer', 'patchwork'],
  ['area', 'patchwork']
])

// Constructors/configuration values, not a prefix allowlist. In particular,
// theme_set/update, guide_custom and device-dependent unit conversion are absent.
export const R_PLOT_VALUE_CALLS = new Map<string, readonly string[]>([
  // Eager set-data plot constructor; interactive mode and argument ownership are
  // checked by the walker before accepting this package contract.
  ['ggVennDiagram', ['ggVennDiagram']],
  ['brewer.pal', ['RColorBrewer']],
  ...[
    'margin',
    'margin_auto',
    'margin_part',
    'rel',
    'theme_dark',
    'theme_linedraw',
    'theme_test',
    'theme_grey',
    'element_point',
    'element_polygon',
    'element_geom',
    'guide_legend',
    'guide_colourbar',
    'guide_colorbar',
    'guide_coloursteps',
    'guide_colorsteps',
    'guide_bins',
    'guide_axis',
    'guide_none'
  ].map((name): [string, readonly string[]] => [name, ['ggplot2']]),
  ...['unit.c', 'unit.pmax', 'unit.pmin', 'unit.psum', 'unit.rep'].map(
    (name): [string, readonly string[]] => [name, ['grid']]
  ),
  ['unit', ['grid', 'ggplot2']],
  ['alpha', ['scales', 'ggplot2']]
])

export const R_SET_OPERATIONS = new Set(['union', 'intersect', 'setdiff', 'setequal'])

export interface RCallbackEvaluation {
  phase: 'immediate' | 'deferred'
  formulaParameters?: readonly string[]
  allowList?: boolean
}

export interface RFunctionalCall {
  package: string
  precedingArguments: readonly string[]
  keywords: readonly string[]
  formulaParameters?: readonly string[]
  dataMask?: boolean
  valueArguments?: readonly string[]
  allowList?: boolean
  optional?: boolean
}

export const R_FUNCTIONAL_CALLS = new Map<string, RFunctionalCall>([
  ['aggregate', { package: 'stats', precedingArguments: ['x', 'by'], keywords: ['FUN'] }],
  ['apply', { package: 'base', precedingArguments: ['X', 'MARGIN'], keywords: ['FUN'] }],
  ['lapply', { package: 'base', precedingArguments: ['X'], keywords: ['FUN'] }],
  ['sapply', { package: 'base', precedingArguments: ['X'], keywords: ['FUN'] }],
  ['vapply', { package: 'base', precedingArguments: ['X'], keywords: ['FUN'] }],
  ['Map', { package: 'base', precedingArguments: [], keywords: ['f'] }],
  ['Filter', { package: 'base', precedingArguments: [], keywords: ['f'] }],
  ['Reduce', { package: 'base', precedingArguments: [], keywords: ['f'] }],
  ['mapply', { package: 'base', precedingArguments: [], keywords: ['FUN'] }],
  ...['walk', 'map', 'map_chr', 'map_dbl', 'map_int', 'map_lgl', 'map_raw', 'map_vec'].map(
    (name) =>
      [
        name,
        {
          package: 'purrr',
          precedingArguments: ['.x'],
          keywords: ['.f'],
          formulaParameters: ['.', '.x', '..1']
        }
      ] as const
  ),
  ...['walk2', 'map2', 'map2_chr', 'map2_dbl', 'map2_int', 'map2_lgl', 'map2_raw', 'map2_vec'].map(
    (name) =>
      [
        name,
        {
          package: 'purrr',
          precedingArguments: ['.x', '.y'],
          keywords: ['.f'],
          formulaParameters: ['.', '.x', '.y', '..1', '..2']
        }
      ] as const
  ),
  ...['pmap', 'pmap_chr', 'pmap_dbl', 'pmap_int', 'pmap_lgl', 'pmap_raw', 'pmap_vec'].map(
    (name) =>
      [
        name,
        {
          package: 'purrr',
          precedingArguments: ['.l'],
          keywords: ['.f'],
          formulaParameters: [
            '.',
            '.x',
            '.y',
            ...Array.from({ length: 20 }, (_, i) => `..${i + 1}`)
          ]
        }
      ] as const
  ),
  ...['across', 'if_any', 'if_all'].map(
    (name) =>
      [
        name,
        {
          package: 'dplyr',
          precedingArguments: ['.cols'],
          keywords: ['.fns'],
          formulaParameters: ['.', '.x', '..1'],
          dataMask: true,
          allowList: true,
          optional: name === 'across'
        }
      ] as const
  ),
  [
    'where',
    {
      package: 'tidyselect',
      precedingArguments: [],
      keywords: ['fn'],
      formulaParameters: ['.', '.x', '..1'],
      dataMask: true
    }
  ],
  [
    'rename_with',
    {
      package: 'dplyr',
      precedingArguments: ['.data'],
      keywords: ['.fn'],
      formulaParameters: ['.', '.x', '..1'],
      dataMask: true,
      valueArguments: ['.data']
    }
  ],
  ...['group_map', 'group_modify'].map(
    (name) =>
      [
        name,
        {
          package: 'dplyr',
          precedingArguments: ['.data'],
          keywords: ['.f'],
          formulaParameters: ['.', '.x', '.y', '..1', '..2'],
          dataMask: true,
          valueArguments: ['.data']
        }
      ] as const
  )
])

export const R_TIDY_SELECT_CALLS = new Set([
  'all_of',
  'any_of',
  'everything',
  'last_col',
  'starts_with',
  'ends_with',
  'contains',
  'matches',
  'num_range'
])

// These public built-in layers share callback-valued data/key_glyph arguments.
// Extension geoms require their own contract; never match an arbitrary geom_* prefix.
export const R_GGPLOT_GEOMS = new Set([
  'geom_abline',
  'geom_area',
  'geom_bar',
  'geom_bin_2d',
  'geom_bin2d',
  'geom_blank',
  'geom_boxplot',
  'geom_col',
  'geom_contour',
  'geom_contour_filled',
  'geom_count',
  'geom_crossbar',
  'geom_curve',
  'geom_density',
  'geom_density_2d',
  'geom_density2d',
  'geom_density_2d_filled',
  'geom_dotplot',
  'geom_errorbar',
  'geom_errorbarh',
  'geom_freqpoly',
  'geom_hex',
  'geom_histogram',
  'geom_hline',
  'geom_jitter',
  'geom_label',
  'geom_line',
  'geom_linerange',
  'geom_map',
  'geom_path',
  'geom_point',
  'geom_pointrange',
  'geom_polygon',
  'geom_qq',
  'geom_qq_line',
  'geom_raster',
  'geom_rect',
  'geom_ribbon',
  'geom_rug',
  'geom_segment',
  'geom_smooth',
  'geom_spoke',
  'geom_step',
  'geom_text',
  'geom_tile',
  'geom_violin',
  'geom_vline'
])

// Package identity and deferred-argument rules are shared by core and registered
// extension layers. An arbitrary geom_* name is not evidence of a known layer.
export const R_PLOT_LAYER_PACKAGES = new Map<string, string>([
  ...[...R_GGPLOT_GEOMS].map((name): [string, string] => [name, 'ggplot2']),
  ['geom_text_repel', 'ggrepel'],
  ['geom_label_repel', 'ggrepel']
])

export const R_GGPLOT_STATS = new Set([
  'identity',
  'count',
  'bin',
  'bin_2d',
  'bin2d',
  'boxplot',
  'contour',
  'contour_filled',
  'sum',
  'density',
  'density_2d',
  'density2d',
  'bindot',
  'binhex',
  'ydensity',
  'align',
  'qq',
  'qq_line',
  'smooth'
])
export const R_GGPLOT_POSITIONS = new Set([
  'identity',
  'stack',
  'fill',
  'dodge',
  'dodge2',
  'jitter',
  'jitterdodge',
  'nudge'
])
export const R_GGPLOT_POSITION_CALLS = new Set(
  [...R_GGPLOT_POSITIONS].map((name) => `position_${name}`)
)

// These row selectors evaluate limits/options in the calling environment, while
// positions, ordering expressions and grouping selectors use the data mask.
export const R_TABLE_SELECTION_VALUE_ARGUMENTS = new Map<string, readonly string[]>([
  ['slice', ['.preserve']],
  ['slice_head', ['n', 'prop']],
  ['slice_tail', ['n', 'prop']],
  ['slice_min', ['n', 'prop', 'with_ties', 'na_rm']],
  ['slice_max', ['n', 'prop', 'with_ties', 'na_rm']],
  ['relocate', []]
])

export const R_DPLYR_VALUE_CALLS = new Set([
  'coalesce',
  'na_if',
  'case_when',
  'bind_rows',
  'bind_cols'
])

// Unlike selected columns, these tidyr options are evaluated in the calling
// environment. Positional lists stop at `...`; later options must be named.
// Callback options invoke functions (or lists of functions) immediately.
export const R_TIDYR_ARGUMENTS = new Map<
  string,
  {
    positional: readonly string[]
    values: readonly string[]
    callbacks?: readonly string[]
  }
>([
  [
    'pivot_longer',
    {
      positional: ['data', 'cols'],
      values: [
        'cols_vary',
        'names_to',
        'names_prefix',
        'names_sep',
        'names_pattern',
        'names_ptypes',
        'names_repair',
        'values_to',
        'values_drop_na',
        'values_ptypes'
      ],
      callbacks: ['names_transform', 'values_transform']
    }
  ],
  [
    'pivot_wider',
    {
      positional: ['data'],
      values: [
        'id_expand',
        'names_prefix',
        'names_sep',
        'names_sort',
        'names_vary',
        'names_expand',
        'names_repair',
        'values_fill'
      ],
      callbacks: ['values_fn', 'unused_fn']
    }
  ],
  ['complete', { positional: ['data'], values: ['fill', 'explicit'] }],
  ['fill', { positional: ['data'], values: ['.direction'] }],
  ['replace_na', { positional: ['data', 'replace'], values: ['replace'] }],
  [
    'separate',
    {
      positional: ['data', 'col', 'into', 'sep', 'remove', 'convert', 'extra', 'fill'],
      values: ['into', 'sep', 'remove', 'convert', 'extra', 'fill']
    }
  ],
  [
    'separate_wider_delim',
    {
      positional: ['data', 'cols', 'delim'],
      values: ['delim', 'names', 'names_sep', 'names_repair', 'too_few', 'too_many', 'cols_remove']
    }
  ],
  [
    'extract',
    {
      positional: ['data', 'col', 'into', 'regex', 'remove', 'convert'],
      values: ['into', 'regex', 'remove', 'convert']
    }
  ],
  ['unite', { positional: ['data', 'col'], values: ['sep', 'remove', 'na.rm'] }],
  [
    'unnest',
    { positional: ['data', 'cols'], values: ['keep_empty', 'ptype', 'names_sep', 'names_repair'] }
  ],
  [
    'unnest_longer',
    {
      positional: [
        'data',
        'col',
        'values_to',
        'indices_to',
        'indices_include',
        'keep_empty',
        'names_repair',
        'simplify',
        'ptype',
        'transform'
      ],
      values: [
        'values_to',
        'indices_to',
        'indices_include',
        'keep_empty',
        'names_repair',
        'simplify',
        'ptype'
      ],
      callbacks: ['transform']
    }
  ],
  [
    'unnest_wider',
    {
      positional: [
        'data',
        'col',
        'names_sep',
        'simplify',
        'strict',
        'names_repair',
        'ptype',
        'transform'
      ],
      values: ['names_sep', 'simplify', 'strict', 'names_repair', 'ptype'],
      callbacks: ['transform']
    }
  ]
])
