// Argument evaluation contracts, separate from AST traversal and file effects.
// A known name identifies a contract; it does not certify the supplied callback.
// See dplyr's programming/across guides and ggplot2's layer documentation.
// These constructors evaluate ordinary values; callbacks and unknown expressions in their
// arguments still go through the normal walker. They do not render or load plot inputs.
export const R_PLOT_COMPOSITION_CONSTRUCTORS = new Map([
  ['plot_annotation', 'patchwork'],
  ['plot_layout', 'patchwork']
])

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
  ['lapply', { package: 'base', precedingArguments: ['X'], keywords: ['FUN'] }],
  ['sapply', { package: 'base', precedingArguments: ['X'], keywords: ['FUN'] }],
  ['vapply', { package: 'base', precedingArguments: ['X'], keywords: ['FUN'] }],
  ['Map', { package: 'base', precedingArguments: [], keywords: ['f'] }],
  ['Filter', { package: 'base', precedingArguments: [], keywords: ['f'] }],
  ['Reduce', { package: 'base', precedingArguments: [], keywords: ['f'] }],
  ['mapply', { package: 'base', precedingArguments: [], keywords: ['FUN'] }],
  ...['map', 'map_chr', 'map_dbl', 'map_int', 'map_lgl', 'map_raw', 'map_vec'].map(
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
  ...['map2', 'map2_chr', 'map2_dbl', 'map2_int', 'map2_lgl', 'map2_raw', 'map2_vec'].map(
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

export const R_DPLYR_VALUE_CALLS = new Set(['coalesce', 'na_if'])
