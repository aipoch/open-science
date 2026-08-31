import {
  R_FUNCTIONAL_CALLS,
  R_TABLE_SELECTION_VALUE_ARGUMENTS,
  R_DPLYR_VALUE_CALLS,
  R_TIDY_SELECT_CALLS,
  R_GGPLOT_GEOMS,
  R_GGPLOT_STATS,
  R_GGPLOT_POSITIONS,
  R_GGPLOT_POSITION_CALLS,
  R_PLOT_COMPOSITION_CONSTRUCTORS,
  type RCallbackEvaluation
} from './dependency-analysis-r-evaluation'
import { notebookWriteOption, notebookWriteDisposition } from './notebook-write-semantics'
import { createHash } from 'node:crypto'
import {
  fieldChild,
  fieldChildren,
  withParsedNotebookSource,
  type Node
} from './dependency-analysis-parser'
import {
  isPotentialRFileWriteCall,
  R_FILE_CALL_EFFECTS,
  R_GRAPHICS_FILE_DEVICES,
  type NotebookFileCallEffect
} from './notebook-call-effects'
import type {
  NotebookDependencyAlias,
  NotebookDependencyCopyBinding,
  NotebookDependencyMemberWrite,
  NotebookDependencyReceiverCall,
  NotebookDependencyTypeBinding,
  NotebookDependencyTypeSummary,
  NotebookFileCallEffectSummary,
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessContext,
  NotebookSourceFileAccessExtraction,
  NotebookSourceFileWriteScope
} from './dependency-analysis-types'

type RExpr =
  | { kind: 'symbol'; name: string }
  | { kind: 'character'; value: string }
  | { kind: 'atomic'; logical?: boolean; number?: number }
  | { kind: 'null' }
  | { kind: 'formals'; names: string[]; values: Array<RExpr | null> }
  | {
      kind: 'call'
      operator: string | null
      callee: RExpr
      args: RExpr[]
      names: Array<string | null>
      resolvedFunction?: string
      staticBuiltinShadowed?: boolean
    }

const isSymbol = (expr: RExpr | null | undefined): expr is Extract<RExpr, { kind: 'symbol' }> =>
  expr?.kind === 'symbol'
const isCall = (expr: RExpr | null | undefined): expr is Extract<RExpr, { kind: 'call' }> =>
  expr?.kind === 'call'
const isCharacter = (
  expr: RExpr | null | undefined
): expr is Extract<RExpr, { kind: 'character' }> => expr?.kind === 'character'
const isNull = (expr: RExpr | null | undefined): boolean => !expr || expr.kind === 'null'
const emptySymbol = (): RExpr => ({ kind: 'symbol', name: '' })
const symbol = (name: string): RExpr => ({ kind: 'symbol', name })
const rCall = (
  operator: string,
  args: RExpr[],
  names?: Array<string | null>
): Extract<RExpr, { kind: 'call' }> => ({
  kind: 'call',
  operator,
  callee: symbol(operator),
  args,
  names: names ?? args.map(() => null)
})

type RStaticGluePart = { kind: 'text' | 'binding'; value: string }

const R_DIRECTORY_STATE_CALLS = new Set(['list.files'])

const parseRStaticGlueTemplate = (template: string): RStaticGluePart[] | undefined => {
  const parts: RStaticGluePart[] = []
  let text = ''
  const flushText = (): void => {
    if (!text) return
    parts.push({ kind: 'text', value: text })
    text = ''
  }
  for (let index = 0; index < template.length; index += 1) {
    const character = template[index]!
    if (character === '{' && template[index + 1] === '{') {
      text += '{'
      index += 1
      continue
    }
    if (character === '}' && template[index + 1] === '}') {
      text += '}'
      index += 1
      continue
    }
    if (character === '}') return undefined
    if (character !== '{') {
      text += character
      continue
    }
    const end = template.indexOf('}', index + 1)
    if (end < 0) return undefined
    const name = template.slice(index + 1, end).trim()
    if (!/^(?:[A-Za-z]|\.(?!\d))[A-Za-z\d._]*$/u.test(name)) return undefined
    flushText()
    parts.push({ kind: 'binding', value: name })
    index = end
  }
  flushText()
  return parts
}

const stringValue = (node: Node): string =>
  fieldChild(node, 'content')?.text ?? node.text.replace(/^['"]|['"]$/gu, '')

const convertArguments = (node: Node | null): { args: RExpr[]; names: Array<string | null> } => {
  const args: RExpr[] = []
  const names: Array<string | null> = []
  if (!node) return { args, names }
  let afterValue = false
  let pendingEmpty = false
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    if (!child) continue
    if (
      child.type === '(' ||
      child.type === '[' ||
      child.type === ')' ||
      child.type === ']' ||
      child.type === ']]' ||
      child.type === '{' ||
      child.type === '}'
    ) {
      continue
    }
    if (child.type === ',' || child.type === 'comma') {
      if (!afterValue) {
        args.push(emptySymbol())
        names.push(null)
      }
      afterValue = false
      pendingEmpty = true
      continue
    }
    if (child.type === 'argument') {
      const nameNode = fieldChild(child, 'name')
      const valueNode = fieldChild(child, 'value')
      names.push(
        nameNode ? (nameNode.type === 'string' ? stringValue(nameNode) : nameNode.text) : null
      )
      args.push(valueNode ? (convertR(valueNode) ?? emptySymbol()) : emptySymbol())
      afterValue = true
      pendingEmpty = false
    }
  }
  if (pendingEmpty) {
    args.push(emptySymbol())
    names.push(null)
  }
  return { args, names }
}

const convertR = (node: Node | null | undefined): RExpr | null => {
  if (!node) return null
  switch (node.type) {
    case 'identifier':
    case 'dots':
    case 'dot_dot_i':
      return symbol(node.text)
    case 'string':
      return { kind: 'character', value: stringValue(node) }
    case 'integer': {
      const number = Number(node.text.replace(/L$/u, ''))
      return { kind: 'atomic', ...(Number.isFinite(number) ? { number } : {}) }
    }
    case 'float': {
      const number = Number(node.text)
      return { kind: 'atomic', ...(Number.isFinite(number) ? { number } : {}) }
    }
    case 'complex':
    case 'inf':
    case 'nan':
    case 'na':
      return { kind: 'atomic' }
    case 'true':
      return { kind: 'atomic', logical: true }
    case 'false':
      return { kind: 'atomic', logical: false }
    case 'null':
      return { kind: 'null' }
    case 'comment':
      return null
    case 'binary_operator': {
      const op = fieldChild(node, 'operator')?.text ?? ''
      const lhs = convertR(fieldChild(node, 'lhs')) ?? emptySymbol()
      const rhs = convertR(fieldChild(node, 'rhs')) ?? emptySymbol()
      return rCall(op, [lhs, rhs])
    }
    case 'unary_operator': {
      const op = fieldChild(node, 'operator')?.text ?? ''
      const rhs = convertR(fieldChild(node, 'rhs')) ?? emptySymbol()
      return rCall(op, [rhs])
    }
    case 'extract_operator': {
      const op = fieldChild(node, 'operator')?.text ?? '$'
      const lhs = convertR(fieldChild(node, 'lhs')) ?? emptySymbol()
      const rhs = convertR(fieldChild(node, 'rhs')) ?? emptySymbol()
      return rCall(op, [lhs, rhs])
    }
    case 'namespace_operator': {
      const op = fieldChild(node, 'operator')?.text ?? '::'
      const lhs = convertR(fieldChild(node, 'lhs')) ?? emptySymbol()
      const rhs = convertR(fieldChild(node, 'rhs')) ?? emptySymbol()
      return rCall(op, [lhs, rhs])
    }
    case 'call': {
      const fn = convertR(fieldChild(node, 'function')) ?? emptySymbol()
      const { args, names } = convertArguments(fieldChild(node, 'arguments'))
      return {
        kind: 'call',
        operator: isSymbol(fn) ? fn.name : null,
        callee: fn,
        args,
        names
      }
    }
    case 'subset':
    case 'subset2': {
      const op = node.type === 'subset2' ? '[[' : '['
      const fn = convertR(fieldChild(node, 'function')) ?? emptySymbol()
      const { args, names } = convertArguments(fieldChild(node, 'arguments'))
      return rCall(op, [fn, ...args], [null, ...names])
    }
    case 'braced_expression':
    case 'parenthesized_expression': {
      const op = node.type === 'braced_expression' ? '{' : '('
      const body = fieldChildren(node, 'body').map((child) => convertR(child) ?? emptySymbol())
      return rCall(op, body)
    }
    case 'function_definition': {
      const parameters = fieldChild(node, 'parameters')
      const names: string[] = []
      const values: Array<RExpr | null> = []
      for (const parameter of parameters?.namedChildren.filter(
        (child) => child.type === 'parameter'
      ) ?? []) {
        const name = fieldChild(parameter, 'name')?.text ?? ''
        names.push(name)
        const defaultValue = fieldChild(parameter, 'default')
        values.push(defaultValue ? convertR(defaultValue) : null)
      }
      const body = convertR(fieldChild(node, 'body')) ?? emptySymbol()
      return rCall('function', [{ kind: 'formals', names, values }, body])
    }
    case 'if_statement': {
      const args = [
        convertR(fieldChild(node, 'condition')) ?? emptySymbol(),
        convertR(fieldChild(node, 'consequence')) ?? emptySymbol()
      ]
      const alternative = fieldChild(node, 'alternative')
      if (alternative) args.push(convertR(alternative) ?? emptySymbol())
      return rCall('if', args)
    }
    case 'for_statement':
      return rCall('for', [
        convertR(fieldChild(node, 'variable')) ?? emptySymbol(),
        convertR(fieldChild(node, 'sequence')) ?? emptySymbol(),
        convertR(fieldChild(node, 'body')) ?? emptySymbol()
      ])
    case 'while_statement':
      return rCall('while', [
        convertR(fieldChild(node, 'condition')) ?? emptySymbol(),
        convertR(fieldChild(node, 'body')) ?? emptySymbol()
      ])
    case 'repeat_statement':
      return rCall('repeat', [convertR(fieldChild(node, 'body')) ?? emptySymbol()])
    default:
      if (node.namedChildCount === 1 && node.namedChildren[0])
        return convertR(node.namedChildren[0])
      if (node.namedChildCount > 1) {
        return rCall(
          '{',
          node.namedChildren.map((child) => convertR(child) ?? emptySymbol())
        )
      }
      return isSymbol({ kind: 'symbol', name: node.text }) ? symbol(node.text) : { kind: 'atomic' }
  }
}

const unique = <T>(values: T[]): T[] => [...new Set(values)]
const removeFirst = (values: string[], item: string): string[] => {
  const index = values.indexOf(item)
  return index === -1 ? values : [...values.slice(0, index), ...values.slice(index + 1)]
}

const analyzeRSource = (
  root: Node,
  contextualFileWrappers: readonly NotebookFileCallEffectSummary[] = [],
  contextualStaticStrings: readonly { name: string; value: string }[] = [],
  contextualStaticCollections: NotebookSourceFileAccessContext['staticCollections'] = [],
  contextualFunctions: NotebookSourceFileAccessContext['rFunctions'] = [],
  contextualKernelNames: readonly string[] = []
): NotebookRunDependencyFacts => {
  const shadowedCallbackCalls = new Set([
    ...contextualKernelNames,
    ...contextualStaticStrings.map(({ name }) => name),
    ...contextualStaticCollections.map(({ name }) => name)
  ])
  const expressions = root.namedChildren.flatMap((child) => {
    const converted = convertR(child)
    return converted ? [converted] : []
  })
  resolveRStaticCallIdentities(expressions, contextualFunctions, [...shadowedCallbackCalls])
  const localFileWrappers = rLocalFileWrappers(expressions)
  const baseLabelFormatCalls = ['format', 'format.default', 'formatC', 'pretty', 'prettyNum']
  const pureSafeCalls = [
    ...baseLabelFormatCalls,
    'abs',
    'acos',
    'all',
    'any',
    'asin',
    'as.character',
    'as.data.frame',
    'as.integer',
    'as.logical',
    'as.numeric',
    'atan',
    'atan2',
    'basename',
    'bzfile',
    'c',
    'ceiling',
    'character',
    'close',
    'colnames',
    'complete.cases',
    'cos',
    'cosh',
    'cumsum',
    'data.frame',
    'desc',
    'droplevels',
    'dirname',
    'exp',
    'factor',
    'file',
    'file.path',
    'floor',
    'gzfile',
    'gzcon',
    'integer',
    'I',
    'is.na',
    'is.null',
    'is.numeric',
    'is.character',
    'is.logical',
    'is.integer',
    'length',
    'list',
    'log',
    'log10',
    'log2',
    'logical',
    'matrix',
    'max',
    'mean',
    'median',
    'min',
    'n',
    'names',
    'ncol',
    'nrow',
    'numeric',
    'order',
    'paste',
    'paste0',
    'prop.table',
    'proportions',
    'quantile',
    'range',
    'rawConnection',
    'rank',
    'rep',
    'rev',
    'round',
    'rownames',
    'sd',
    'seq',
    'seq_along',
    'seq_len',
    'signif',
    'sin',
    'sinh',
    'slot',
    'sort',
    'sqrt',
    'sprintf',
    'setNames',
    'structure',
    'sum',
    'suppressMessages',
    'suppressPackageStartupMessages',
    'suppressWarnings',
    'table',
    'tan',
    'tanh',
    'textConnection',
    'trunc',
    'unique',
    'unz',
    'var',
    'which',
    'which.max',
    'which.min',
    'xzfile'
  ]
  const environmentSafeCalls = ['baseenv', 'emptyenv', 'environment', 'globalenv', 'new.env']
  // Ordinary drawing and numeric helpers. Interactive input, expression-evaluating
  // curve(), and plotting callbacks remain subject to the normal unknown-call rules.
  const baseGraphicsCalls = [
    'abline',
    'arrows',
    'axTicks',
    'Axis',
    'axis',
    'axis.Date',
    'axis.POSIXct',
    'barplot',
    'barplot.default',
    'box',
    'boxplot',
    'boxplot.default',
    'bxp',
    'clip',
    'contour',
    'contour.default',
    'dotchart',
    'frame',
    'grconvertX',
    'grconvertY',
    'grid',
    'hist',
    'hist.default',
    'image',
    'image.default',
    'layout',
    'layout.show',
    'lcm',
    'legend',
    'lines',
    'lines.default',
    'matlines',
    'matplot',
    'matpoints',
    'mtext',
    'par',
    'pie',
    'plot',
    'plot.default',
    'plot.new',
    'plot.window',
    'plot.xy',
    'points',
    'points.default',
    'polygon',
    'polypath',
    'rasterImage',
    'rect',
    'rug',
    'segments',
    'stem',
    'strheight',
    'strwidth',
    'stripchart',
    'symbols',
    'text',
    'text.default',
    'title',
    'xinch',
    'xspline',
    'xyinch',
    'yinch'
  ]
  const graphicsDeviceCalls = [
    ...R_GRAPHICS_FILE_DEVICES,
    'adjustcolor',
    'as.graphicsAnnot',
    'as.raster',
    'axisTicks',
    'boxplot.stats',
    'chull',
    'cm.colors',
    'col2rgb',
    'colors',
    'colours',
    'contourLines',
    'convertColor',
    'dev.capabilities',
    'dev.cur',
    'dev.flush',
    'dev.hold',
    'dev.list',
    'dev.off',
    'dev.size',
    'extendrange',
    'graphics.off',
    'gray',
    'gray.colors',
    'grey',
    'grey.colors',
    'hcl',
    'hcl.colors',
    'hcl.pals',
    'heat.colors',
    'hsv',
    'is.raster',
    'n2mfrow',
    'nclass.FD',
    'nclass.Sturges',
    'nclass.scott',
    'palette.colors',
    'palette.pals',
    'rainbow',
    'rgb',
    'rgb2hsv',
    'terrain.colors',
    'topo.colors',
    'trans3d',
    'xy.coords',
    'xyz.coords'
  ]
  const graphicsSafeCalls = [...baseGraphicsCalls, ...graphicsDeviceCalls]
  const ggplot2PositionScaleCalls = [
    'scale_x_continuous',
    'scale_y_continuous',
    'scale_x_discrete',
    'scale_y_discrete',
    'scale_x_log10',
    'scale_y_log10',
    'scale_x_sqrt',
    'scale_y_sqrt',
    'scale_x_reverse',
    'scale_y_reverse'
  ]
  const ggplot2SafeCalls = [
    ...ggplot2PositionScaleCalls,
    'aes',
    'aes_',
    'aes_string',
    'after_scale',
    'after_stat',
    'annotation_custom',
    'coord_cartesian',
    'coord_fixed',
    'coord_flip',
    'coord_map',
    'coord_polar',
    'element_blank',
    'element_line',
    'element_rect',
    'element_text',
    'expand_limits',
    'expand_scale',
    'expansion',
    'facet_grid',
    'facet_wrap',
    ...R_GGPLOT_GEOMS,
    'ggplot',
    'ggsave',
    'ggtitle',
    'guides',
    'labs',
    'lims',
    'position_dodge',
    'position_dodge2',
    'position_fill',
    'position_identity',
    'position_jitter',
    'position_jitterdodge',
    'position_nudge',
    'position_stack',
    'qplot',
    'scale_color_manual',
    'scale_colour_manual',
    'scale_fill_manual',
    'stage',
    'stat_identity',
    'theme',
    'theme_bw',
    'theme_classic',
    'theme_gray',
    'theme_light',
    'theme_minimal',
    'theme_void',
    'vars',
    'waiver',
    'xlab',
    'xlim',
    'ylab',
    'ylim'
  ]
  const readrTabularReadCalls = [
    'read_csv',
    'read_csv2',
    'read_delim',
    'read_fwf',
    'read_table',
    'read_tsv'
  ]
  const readrReferenceReadCalls = ['read_file', 'read_lines', 'read_rds']
  // Column specifications construct values; their arguments still carry dependencies/effects.
  // https://readr.tidyverse.org/reference/cols.html
  const readrColumnConstructors = new Set([
    'cols',
    'cols_only',
    'col_character',
    'col_double',
    'col_integer',
    'col_logical',
    'col_factor',
    'col_date',
    'col_time',
    'col_datetime',
    'col_number',
    'col_skip',
    'col_guess'
  ])
  const readrOutputCalls = [
    'write_csv',
    'write_delim',
    'write_file',
    'write_lines',
    'write_rds',
    'write_tsv'
  ]
  const readxlTabularReadCalls = ['read_excel', 'read_xls', 'read_xlsx']
  const havenTabularReadCalls = ['read_dta', 'read_por', 'read_sas', 'read_sav', 'read_xpt']
  const havenOutputCalls = ['write_dta', 'write_sas', 'write_sav', 'write_xpt']
  const baseValueReadCalls = ['dget', 'read.fwf', 'readBin', 'readChar', 'readLines']
  const jsonliteValueReadCalls = ['fromJSON', 'read_json']
  const jsonliteOutputCalls = ['write_json']
  const yamlValueReadCalls = ['read_yaml', 'yaml.load_file']
  const yamlOutputCalls = ['write_yaml']
  const vroomValueReadCalls = ['vroom', 'vroom_fwf', 'vroom_lines']
  const sfValueReadCalls = ['st_read']
  const matrixValueReadCalls = ['readMM']
  const seuratValueReadCalls = ['ReadMtx']
  const matrixOutputCalls = ['writeMM']
  const rhdf5ReferenceReadCalls = ['h5read']
  const rhdf5OutputCalls = ['h5write']
  const cairoOutputCalls = ['CairoJPEG', 'CairoPDF', 'CairoPNG', 'CairoSVG', 'CairoTIFF']
  const xml2ReferenceReadCalls = ['read_xml']
  const xml2OutputCalls = ['write_xml']
  const rMatlabReferenceReadCalls = ['readMat']
  const rMatlabOutputCalls = ['writeMat']
  const ncdf4ReferenceReadCalls = ['nc_open']
  const ncdf4OutputCalls = ['nc_close', 'nc_create']
  const biostringsReferenceReadCalls = ['readDNAStringSet']
  const biostringsOutputCalls = ['writeXStringSet']
  const readOdsTabularReadCalls = ['read_ods']
  const readOdsOutputCalls = ['write_ods']
  const magickReferenceReadCalls = ['image_read']
  const magickOutputCalls = ['image_write']
  const arrowReferenceReadCalls = [
    'read_csv_arrow',
    'read_delim_arrow',
    'read_feather',
    'read_ipc_file',
    'read_ipc_stream',
    'read_json_arrow',
    'read_parquet'
  ]
  const arrowOutputCalls = [
    'write_csv_arrow',
    'write_dataset',
    'write_feather',
    'write_ipc_file',
    'write_ipc_stream',
    'write_parquet'
  ]
  const fstReferenceReadCalls = ['read_fst']
  const fstOutputCalls = ['write_fst']
  const openxlsxReferenceReadCalls = ['loadWorkbook', 'read.xlsx']
  const openxlsxReferenceConstructors = ['createWorkbook']
  const openxlsxReferenceMutators = [
    'addStyle',
    'addWorksheet',
    'deleteData',
    'freezePane',
    'mergeCells',
    'removeWorksheet',
    'renameWorksheet',
    'setColWidths',
    'setRowHeights',
    'writeData',
    'writeDataTable'
  ]
  const openxlsxOutputCalls = ['saveWorkbook', 'write.xlsx']
  const raggOutputCalls = ['agg_jpeg', 'agg_png', 'agg_tiff']
  const svgliteOutputCalls = ['svglite']
  const hdf5ArrayOutputCalls = ['saveHDF5SummarizedExperiment']
  const openxlsx2ReferenceReadCalls = ['read_xlsx', 'wb_load']
  const openxlsx2OutputCalls = ['wb_save', 'write_xlsx']
  const qsReferenceReadCalls = ['qread']
  const qsOutputCalls = ['qsave']
  const terraReferenceReadCalls = ['rast', 'vect']
  const rioReferenceReadCalls = ['import']
  const rioOutputCalls = ['export']
  const writexlOutputCalls = ['write_xlsx']
  const htmlwidgetsSafeCalls = ['createWidget']
  const htmlwidgetsOutputCalls = ['saveWidget']
  const tibbleConstructorCalls = ['as_tibble', 'tibble', 'tribble']
  const dataTableConstructorCalls = ['as.data.table', 'data.table', 'fread']
  const dataTableReferenceMutators = [
    'set',
    'setalloccol',
    'setattr',
    'setcolorder',
    'setDF',
    'setDT',
    'setindex',
    'setindexv',
    'setkey',
    'setkeyv',
    'setnafill',
    'setnames',
    'setorder',
    'setorderv'
  ]
  const dataTableOutputCalls = ['fwrite']
  const biocConstructorCalls = ['ExpressionSet', 'SingleCellExperiment', 'SummarizedExperiment']
  const biocValueAccessors = [
    'altExp',
    'altExps',
    'assay',
    'assays',
    'colData',
    'colLabels',
    'exprs',
    'fData',
    'featureData',
    'logcounts',
    'normcounts',
    'pData',
    'reducedDim',
    'reducedDims',
    'rowData',
    'rowRanges',
    'rowSubset',
    'sizeFactors'
  ]
  const biocUnknownAccessors = ['experimentData', 'metadata']
  const outputSafeCalls = [
    'write.FCS',
    'cat',
    'capture.output',
    'dput',
    'dir.exists',
    'file.exists',
    'message',
    'print',
    'save',
    'saveRDS',
    'set.seed',
    'warning',
    'sink',
    'write.csv',
    'writeBin',
    'writeLines',
    'write.table',
    ...arrowOutputCalls,
    ...fstOutputCalls,
    ...openxlsxOutputCalls,
    ...raggOutputCalls,
    ...svgliteOutputCalls,
    ...hdf5ArrayOutputCalls,
    ...jsonliteOutputCalls,
    ...matrixOutputCalls,
    ...rhdf5OutputCalls,
    ...cairoOutputCalls,
    ...yamlOutputCalls,
    ...xml2OutputCalls,
    ...rMatlabOutputCalls,
    ...ncdf4OutputCalls,
    ...biostringsOutputCalls,
    ...readOdsOutputCalls,
    ...magickOutputCalls,
    ...openxlsx2OutputCalls,
    ...qsOutputCalls,
    ...readrOutputCalls,
    ...havenOutputCalls,
    ...rioOutputCalls,
    ...writexlOutputCalls,
    ...htmlwidgetsOutputCalls
  ]
  const tidyDataMaskCalls = [
    ...R_TABLE_SELECTION_VALUE_ARGUMENTS.keys(),
    'arrange',
    'count',
    'distinct',
    'filter',
    'group_by',
    'reframe',
    'mutate',
    'rename',
    'select',
    'summarise',
    'summarize',
    'transmute'
  ]
  const tidyrDataMaskCalls = [
    'complete',
    'drop_na',
    'extract',
    'fill',
    'pivot_longer',
    'pivot_wider',
    'replace_na',
    'separate',
    'separate_wider_delim',
    'unite',
    'unnest',
    'unnest_longer',
    'unnest_wider'
  ]
  const tabularTransformCalls = [...tidyDataMaskCalls, ...tidyrDataMaskCalls]
  const modelDataMaskCalls = ['aov', 'glm', 'lm']
  const safeCalls = new Set([
    ...pureSafeCalls,
    ...environmentSafeCalls,
    ...graphicsSafeCalls,
    ...R_DIRECTORY_STATE_CALLS,
    ...ggplot2SafeCalls,
    ...outputSafeCalls,
    ...tibbleConstructorCalls,
    ...dataTableOutputCalls,
    ...biocConstructorCalls,
    ...htmlwidgetsSafeCalls,
    ...htmlwidgetsOutputCalls,
    ...localFileWrappers.effects.keys(),
    ...contextualFileWrappers.map(({ name }) => name)
  ])
  const tabularReadCalls = [
    'read.csv',
    'read.csv2',
    'read.delim',
    'read.delim2',
    'read.table',
    'scan'
  ]
  const valueFileReadCalls = new Set([
    ...tabularReadCalls,
    ...readrTabularReadCalls,
    ...readxlTabularReadCalls,
    ...havenTabularReadCalls,
    ...baseValueReadCalls,
    ...jsonliteValueReadCalls,
    ...yamlValueReadCalls,
    ...vroomValueReadCalls,
    ...sfValueReadCalls,
    ...matrixValueReadCalls,
    ...seuratValueReadCalls
  ])
  const externalReadCalls = new Set(
    [...R_FILE_CALL_EFFECTS].flatMap(([name, effect]) => (effect.kind === 'read' ? [name] : []))
  )
  const dataMaskCalls = new Set(['aes', 'aes_', 'aes_string', 'vars'])
  const knownAttachedPackages = new Set([
    ...R_PLOT_COMPOSITION_CONSTRUCTORS.values(),
    'flowCore',
    'tximport',
    'Seurat',
    'GEOquery',
    'arrow',
    'Biobase',
    'Biostrings',
    'Cairo',
    'data.table',
    'dplyr',
    'fst',
    'ggplot2',
    'glue',
    'grDevices',
    'HDF5Array',
    'haven',
    'htmlwidgets',
    'jsonlite',
    'Matrix',
    'magick',
    'ncdf4',
    'openxlsx',
    'openxlsx2',
    'purrr',
    'ragg',
    'qs',
    'readr',
    'readxl',
    'readODS',
    'rhdf5',
    'rio',
    'R.matlab',
    'sf',
    'SingleCellExperiment',
    'SummarizedExperiment',
    'svglite',
    'terra',
    'tibble',
    'tidyr',
    'tidyselect',
    'vroom',
    'writexl',
    'xml2',
    'yaml'
  ])
  const knownNamespacePackages = new Set([...knownAttachedPackages, 'cowplot', 'gridExtra'])
  const pipeOps = new Set(['%>%', '|>'])
  const dataTableMutators = new Set(dataTableReferenceMutators)
  const openxlsxMutators = new Set(openxlsxReferenceMutators)
  const tidyMask = new Set(tidyDataMaskCalls)
  const tidyrMask = new Set(tidyrDataMaskCalls)
  const tabularTransform = new Set(tabularTransformCalls)
  const biocValue = new Set(biocValueAccessors)
  const biocUnknown = new Set(biocUnknownAccessors)
  const yamlReads = new Set(yamlValueReadCalls)
  const tibbleConstructors = new Set(tibbleConstructorCalls)
  const dataTableConstructors = new Set(dataTableConstructorCalls)
  const biocConstructors = new Set(biocConstructorCalls)
  const modelMask = new Set(modelDataMaskCalls)
  const pureSafe = new Set(pureSafeCalls)
  const outputSafe = new Set(outputSafeCalls)
  const functionalCallbacks = R_FUNCTIONAL_CALLS
  const callbackUnsafeCalls = new Set([
    'bzfile',
    'close',
    'file',
    'gzfile',
    'gzcon',
    'rawConnection',
    'textConnection',
    'unz',
    'xzfile'
  ])
  const pureCallbackOps = new Set([
    ...pureSafeCalls.filter((name) => !callbackUnsafeCalls.has(name)),
    '{',
    '(',
    '+',
    '-',
    '*',
    '/',
    '^',
    ':',
    '[[',
    '[',
    '!',
    '&',
    '&&',
    '|',
    '||',
    '<',
    '>',
    '<=',
    '>=',
    '==',
    '!='
  ])

  const summarizeCallback = (
    expr: RExpr | undefined,
    formulaParameters?: readonly string[]
  ): NotebookDependencyTypeSummary['methods'][number] | undefined => {
    if (!isCall(expr)) return undefined
    const formals = expr.args[0]
    const formula = callOperator(expr) === '~' && formulaParameters && expr.args.length === 1
    if (!formula && (callOperator(expr) !== 'function' || formals?.kind !== 'formals'))
      return undefined
    const parameters = formula
      ? [...formulaParameters]
      : formals.kind === 'formals'
        ? formals.names
        : []
    if (parameters.includes('...')) return undefined
    const locals = new Set(parameters)
    const reads = new Set<string>()
    const calls = new Set<string>()
    const inspect = (value: RExpr): boolean => {
      if (value.kind === 'atomic' || value.kind === 'character' || value.kind === 'null')
        return true
      if (value.kind === 'symbol') {
        if (value.name && !locals.has(value.name) && !['NULL', 'NA', 'pi'].includes(value.name))
          reads.add(value.name)
        return true
      }
      if (value.kind === 'formals') return false
      const op = calledName(value)
      if (op && ['<-', '=', '->'].includes(op)) {
        const target = value.args[op === '->' ? 1 : 0]
        const assigned = value.args[op === '->' ? 0 : 1]
        if (!isSymbol(target) || !assigned || !inspect(assigned)) return false
        locals.add(target.name)
        return true
      }
      if (op === '$')
        return Boolean(value.args[0] && inspect(value.args[0]) && isSymbol(value.args[1]))
      if (op === 'if') {
        // A branch may return a value; conditional local bindings need a control-flow summary.
        if (value.args.some((arg) => assignedNamesIn(arg).length)) return false
        return value.args.every(inspect)
      }
      if (op === 'return') return value.args.every(inspect)
      const composed =
        op && !qualifiedCall(value) && !locals.has(op) ? functions.get(op)?.methods[0] : undefined
      if (composed) {
        reads.add(op!)
        for (const name of composed.usedNames ?? []) reads.add(name)
        for (const name of composed.safeCallNames ?? []) calls.add(name)
        return value.args.every(inspect)
      }
      const quoted = quotedDataCall(value)
      if (quoted && (quoted.qualified || !locals.has(quoted.name))) {
        reads.add(quoted.dependency)
        calls.add(quoted.dependency)
        return true
      }

      if (op && dplyrValueCall(value)) {
        const qualified = qualifiedCall(value)
        if (!qualified && locals.has(op)) return false
        const name = qualified ? `${qualified.package}::${op}` : op
        reads.add(name)
        calls.add(name)
        return value.args.every(inspect)
      }
      if (!op || !pureCallbackOps.has(op)) return false
      const qualified = qualifiedCall(value)
      if (qualified && !knownQualifiedCall(qualified.package, op)) return false
      if (pureSafe.has(op)) {
        if (!qualified && (locals.has(op) || defined.includes(op) || shadowedCallbackCalls.has(op)))
          return false
        const name = qualified ? `${qualified.package}::${op}` : op
        reads.add(name)
        calls.add(name)
      }
      return value.args.every(inspect)
    }
    // R defaults are promises, evaluated in the callee when used. Only constant
    // defaults are summarized here; effectful or environment-dependent defaults stay opaque.
    if (
      !formula &&
      formals.kind === 'formals' &&
      formals.values.some((value) => value && !['atomic', 'character', 'null'].includes(value.kind))
    )
      return undefined
    const body = formula ? expr.args.at(-1) : expr.args[1]
    if (!body || !inspect(body)) return undefined
    return {
      name: '__call__',
      effect: 'read',
      usedNames: [...reads].sort(),
      safeCallNames: [...calls].sort()
    }
  }

  const defined: string[] = []
  const conditionallyDefined = new Set<string>()
  const isolatedConditionallyDefined = new Set<string>()
  const staticIterableNames = new Set(contextualStaticCollections.map(({ name }) => name))
  const staticNamedIterableNames = new Set(
    contextualStaticCollections.flatMap(({ name, entries }) => (entries ? [name] : []))
  )
  const staticScalarNames = new Set(contextualStaticStrings.map(({ name }) => name))
  const staticStrings = new Map(contextualStaticStrings.map(({ name, value }) => [name, value]))
  const staticCollections = rContextCollections(contextualStaticCollections)
  const localInputHandleNames = new Set<string>()
  const characterLoopNames = new Set<string>()
  let used: string[] = []
  let priorUsed: string[] = []
  const possiblyUsed: string[] = []
  const mutated: string[] = []
  const possiblyMutated: string[] = []
  const aliases = new Map<string, { target: string; source: string; kind: 'possible-reference' }>()
  const possibleAliases: NotebookDependencyAlias[] = []
  let copyOnModify: string[] = []
  let copyOnModifyBindings: NotebookDependencyCopyBinding[] = []
  let copyOnModifyInvalidated: string[] = []
  const safeCallNames: string[] = []
  const safeCallArgumentNames: string[] = []
  const typeSummaries: NotebookDependencyTypeSummary[] = []
  let typeBindings: NotebookDependencyTypeBinding[] = []
  const receiverCalls: NotebookDependencyReceiverCall[] = []
  const memberWrites: NotebookDependencyMemberWrite[] = []
  const unknown: string[] = []
  let controlDepth = 0
  let localAggregationDepth = 0
  let localNames: string[] = []
  const functions = new Map(contextualFunctions.map(({ name, summary }) => [name, summary]))
  const acceptedCallbacks = new Set<RExpr>()
  const quotedDataCall = (expr: RExpr | null | undefined): ReturnType<typeof rQuotedDataCall> => {
    const call = rQuotedDataCall(expr)
    return call &&
      (call.qualified ||
        (!defined.includes(call.name) &&
          !localNames.includes(call.name) &&
          !shadowedCallbackCalls.has(call.name) &&
          !functions.has(call.name)))
      ? call
      : undefined
  }
  const literalLabelNames = new Set<string>()
  const literalLabelValue = (expr: RExpr | null | undefined): boolean => {
    if (quotedDataCall(expr)) return true
    if (isSymbol(expr)) return literalLabelNames.has(expr.name)
    if (expr?.kind === 'character' || expr?.kind === 'atomic' || expr?.kind === 'null') return true
    if (!expr || !isCall(expr)) return false
    const name = rCalledName(expr)
    const qualified = rQualifiedCall(expr)
    return Boolean(
      name &&
      ['c', 'list'].includes(name) &&
      (qualified
        ? qualified.package === 'base'
        : !defined.includes(name) && !shadowedCallbackCalls.has(name)) &&
      expr.args.every(literalLabelValue)
    )
  }

  const resolveCallback = (
    expr: RExpr | undefined,
    formulaParameters?: readonly string[]
  ): NotebookDependencyTypeSummary['methods'][number] | undefined => {
    if (
      isCall(expr) &&
      callOperator(expr) === '::' &&
      isSymbol(expr.args[0]) &&
      isSymbol(expr.args[1])
    ) {
      const pkg = expr.args[0].name
      const name = expr.args[1].name
      if (pureSafe.has(name) && !callbackUnsafeCalls.has(name) && knownQualifiedCall(pkg, name)) {
        const dependency = `${pkg}::${name}`
        return {
          name: '__call__',
          effect: 'read',
          usedNames: [dependency],
          safeCallNames: [dependency]
        }
      }
    }
    if (isSymbol(expr)) {
      const known = functions.get(expr.name)?.methods[0]
      if (known) return known
      if (
        pureSafe.has(expr.name) &&
        !callbackUnsafeCalls.has(expr.name) &&
        !defined.includes(expr.name) &&
        !shadowedCallbackCalls.has(expr.name)
      )
        return {
          name: '__call__',
          effect: 'read',
          usedNames: [expr.name],
          safeCallNames: [expr.name]
        }
    }
    return summarizeCallback(expr, formulaParameters)
  }
  const mergeCallbackReads = (summary: NotebookDependencyTypeSummary['methods'][number]): void => {
    for (const name of summary.usedNames ?? []) {
      used.push(name)
      if (!defined.includes(name)) priorUsed.push(name)
    }
    safeCallNames.push(...(summary.safeCallNames ?? []))
    if (summary.safeCallNames?.some((name) => defined.includes(name))) unknown.push('opaque-call')
  }

  // Immediate callbacks read their closure now. Deferred callbacks with free variables
  // cannot be bound to this run until their eventual invocation can be tracked.
  const consumeCallback = (expr: RExpr | undefined, evaluation: RCallbackEvaluation): boolean => {
    if (evaluation.allowList && isCall(expr) && calledName(expr) === 'list') {
      const qualified = qualifiedCall(expr)
      if (
        qualified
          ? qualified.package !== 'base'
          : defined.includes('list') || shadowedCallbackCalls.has('list')
      )
        return false
      return expr.args
        .map((item) => consumeCallback(item, { ...evaluation, allowList: false }))
        .every(Boolean)
    }
    const summary = resolveCallback(expr, evaluation.formulaParameters)
    if (
      !summary ||
      (evaluation.phase === 'deferred' &&
        (summary.usedNames ?? []).some((name) => !summary.safeCallNames?.includes(name)))
    )
      return false
    mergeCallbackReads(summary)
    if (isCall(expr)) acceptedCallbacks.add(expr)
    if (isSymbol(expr)) {
      used.push(expr.name)
      if (!defined.includes(expr.name)) priorUsed.push(expr.name)
    }
    return true
  }
  const callbackArgumentIndex = (
    expr: Extract<RExpr, { kind: 'call' }>,
    keywords: readonly string[],
    preceding: readonly string[]
  ): number => {
    const named = expr.names.findIndex((name) => keywords.includes(name ?? ''))
    if (named >= 0) return named
    const remaining = preceding.filter((parameter) => !expr.names.includes(parameter)).length
    return expr.names.flatMap((name, index) => (name ? [] : [index]))[remaining] ?? -1
  }
  const contractAvailable = (name: string, pkg: string | undefined, expected: string): boolean =>
    pkg
      ? pkg === expected || (expected === 'tidyselect' && pkg === 'dplyr')
      : !defined.includes(name) && !localNames.includes(name) && !shadowedCallbackCalls.has(name)

  const callOperator = (expr: RExpr | null | undefined): string | null =>
    isCall(expr) && isSymbol(expr.callee) ? expr.callee.name : null
  const calledName = (expr: RExpr | null | undefined): string | null => {
    if (!isCall(expr)) return null
    if (isSymbol(expr.callee)) return expr.callee.name
    const calleeOp = callOperator(expr.callee)
    if (
      calleeOp &&
      (calleeOp === '::' || calleeOp === ':::') &&
      expr.callee.kind === 'call' &&
      expr.callee.args[1]
    ) {
      return isSymbol(expr.callee.args[1])
        ? expr.callee.args[1].name
        : isCharacter(expr.callee.args[1])
          ? expr.callee.args[1].value
          : null
    }
    return null
  }
  const qualifiedCall = (
    expr: RExpr | null | undefined
  ): { package: string; name: string } | null => {
    if (!isCall(expr) || !isCall(expr.callee) || expr.callee.args.length < 2) return null
    const qualifier = callOperator(expr.callee)
    if (qualifier !== '::' && qualifier !== ':::') return null
    const pkg = expr.callee.args[0]
    const name = expr.callee.args[1]
    const packageName = isSymbol(pkg) ? pkg.name : isCharacter(pkg) ? pkg.value : null
    const member = isSymbol(name) ? name.name : isCharacter(name) ? name.value : null
    if (!packageName || !member) return null
    return { package: packageName, name: member }
  }
  const qualifiedValueFileRead = (pkg: string, name: string): boolean =>
    ((pkg === 'base' || pkg === 'utils') &&
      (tabularReadCalls.includes(name) || baseValueReadCalls.includes(name))) ||
    (pkg === 'haven' && havenTabularReadCalls.includes(name)) ||
    (pkg === 'jsonlite' && jsonliteValueReadCalls.includes(name)) ||
    (pkg === 'Matrix' && matrixValueReadCalls.includes(name)) ||
    (pkg === 'Seurat' && seuratValueReadCalls.includes(name)) ||
    (pkg === 'readr' && readrTabularReadCalls.includes(name)) ||
    (pkg === 'readxl' && readxlTabularReadCalls.includes(name)) ||
    (pkg === 'sf' && sfValueReadCalls.includes(name)) ||
    (pkg === 'vroom' && vroomValueReadCalls.includes(name)) ||
    (pkg === 'yaml' && yamlValueReadCalls.includes(name))
  const qualifiedReferenceFileRead = (pkg: string, name: string): boolean =>
    (pkg === 'arrow' && arrowReferenceReadCalls.includes(name)) ||
    (pkg === 'base' && name === 'readRDS') ||
    (pkg === 'fst' && fstReferenceReadCalls.includes(name)) ||
    (pkg === 'openxlsx' && openxlsxReferenceReadCalls.includes(name)) ||
    (pkg === 'openxlsx2' && openxlsx2ReferenceReadCalls.includes(name)) ||
    (pkg === 'qs' && qsReferenceReadCalls.includes(name)) ||
    (pkg === 'readr' && readrReferenceReadCalls.includes(name)) ||
    (pkg === 'rio' && rioReferenceReadCalls.includes(name)) ||
    (pkg === 'terra' && terraReferenceReadCalls.includes(name))
  const knownQualifiedCall = (pkg: string, name: string): boolean =>
    R_PLOT_COMPOSITION_CONSTRUCTORS.get(name) === pkg ||
    (pkg === 'base' && name === 'requireNamespace') ||
    (pkg === 'flowCore' && ['read.FCS', 'read.flowSet', 'write.FCS'].includes(name)) ||
    (pkg === 'tximport' && name === 'tximport') ||
    (pkg === 'Seurat' && name === 'Read10X_h5') ||
    (pkg === 'GEOquery' && name === 'getGEO') ||
    (pkg === 'base' &&
      (pureSafe.has(name) ||
        outputSafe.has(name) ||
        R_DIRECTORY_STATE_CALLS.has(name) ||
        functionalCallbacks.get(name)?.package === 'base')) ||
    (pkg === 'fs' && name === 'path') ||
    (pkg === 'glue' && name === 'glue') ||
    (pkg === 'stats' && ['setNames', 'complete.cases'].includes(name)) ||
    qualifiedValueFileRead(pkg, name) ||
    qualifiedReferenceFileRead(pkg, name) ||
    (pkg === 'arrow' && arrowOutputCalls.includes(name)) ||
    (pkg === 'Cairo' && cairoOutputCalls.includes(name)) ||
    (pkg === 'Biostrings' &&
      (biostringsReferenceReadCalls.includes(name) || biostringsOutputCalls.includes(name))) ||
    (['Biobase', 'SingleCellExperiment', 'SummarizedExperiment'].includes(pkg) &&
      (biocConstructors.has(name) || biocValue.has(name) || biocUnknown.has(name))) ||
    (pkg === 'data.table' &&
      (dataTableConstructors.has(name) ||
        dataTableMutators.has(name) ||
        dataTableOutputCalls.includes(name) ||
        name === 'copy')) ||
    (pkg === 'dplyr' && (tidyMask.has(name) || R_DPLYR_VALUE_CALLS.has(name))) ||
    functionalCallbacks.get(name)?.package === pkg ||
    (pkg === 'dplyr' && name === 'where') ||
    (['dplyr', 'tidyselect'].includes(pkg) && R_TIDY_SELECT_CALLS.has(name)) ||
    (pkg === 'fst' && fstOutputCalls.includes(name)) ||
    (pkg === 'ggplot2' && ggplot2SafeCalls.includes(name)) ||
    (pkg === 'graphics' && baseGraphicsCalls.includes(name)) ||
    (pkg === 'grDevices' && graphicsDeviceCalls.includes(name)) ||
    (pkg === 'HDF5Array' && hdf5ArrayOutputCalls.includes(name)) ||
    (pkg === 'htmlwidgets' &&
      (htmlwidgetsSafeCalls.includes(name) || htmlwidgetsOutputCalls.includes(name))) ||
    (pkg === 'haven' &&
      (havenTabularReadCalls.includes(name) || havenOutputCalls.includes(name))) ||
    (pkg === 'jsonlite' &&
      (jsonliteValueReadCalls.includes(name) || jsonliteOutputCalls.includes(name))) ||
    (pkg === 'Matrix' &&
      (matrixValueReadCalls.includes(name) || matrixOutputCalls.includes(name))) ||
    (pkg === 'magick' &&
      (magickReferenceReadCalls.includes(name) || magickOutputCalls.includes(name))) ||
    (pkg === 'ncdf4' &&
      (ncdf4ReferenceReadCalls.includes(name) || ncdf4OutputCalls.includes(name))) ||
    (pkg === 'openxlsx' &&
      (openxlsxReferenceConstructors.includes(name) ||
        openxlsxMutators.has(name) ||
        openxlsxOutputCalls.includes(name))) ||
    (pkg === 'openxlsx2' && openxlsx2OutputCalls.includes(name)) ||
    (pkg === 'qs' && qsOutputCalls.includes(name)) ||
    (pkg === 'ragg' && raggOutputCalls.includes(name)) ||
    (pkg === 'readr' &&
      (readrTabularReadCalls.includes(name) ||
        readrColumnConstructors.has(name) ||
        readrReferenceReadCalls.includes(name) ||
        readrOutputCalls.includes(name))) ||
    (pkg === 'readxl' && readxlTabularReadCalls.includes(name)) ||
    (pkg === 'readODS' &&
      (readOdsTabularReadCalls.includes(name) || readOdsOutputCalls.includes(name))) ||
    (pkg === 'rhdf5' &&
      (rhdf5ReferenceReadCalls.includes(name) || rhdf5OutputCalls.includes(name))) ||
    (pkg === 'rio' && rioOutputCalls.includes(name)) ||
    (pkg === 'R.matlab' &&
      (rMatlabReferenceReadCalls.includes(name) || rMatlabOutputCalls.includes(name))) ||
    (pkg === 'tibble' && tibbleConstructors.has(name)) ||
    (pkg === 'tidyr' && tidyrMask.has(name)) ||
    (pkg === 'stats' && (modelMask.has(name) || pureSafe.has(name))) ||
    (pkg === 'svglite' && svgliteOutputCalls.includes(name)) ||
    (pkg === 'utils' && outputSafe.has(name)) ||
    (pkg === 'writexl' && writexlOutputCalls.includes(name)) ||
    (pkg === 'xml2' && (xml2ReferenceReadCalls.includes(name) || xml2OutputCalls.includes(name))) ||
    (pkg === 'yaml' && (yamlValueReadCalls.includes(name) || yamlOutputCalls.includes(name)))
  const tabularTransformName = (expr: RExpr | null | undefined): string | null => {
    const name = calledName(expr)
    if (!name || !tabularTransform.has(name)) return null
    const qualified = qualifiedCall(expr)
    if (!qualified) return contractAvailable(name, undefined, 'dplyr') ? name : null
    if (qualified.package === 'dplyr' && tidyMask.has(name)) return name
    if (qualified.package === 'tidyr' && tidyrMask.has(name)) return name
    return null
  }
  const tabularDataIndex = (expr: Extract<RExpr, { kind: 'call' }>): number =>
    callbackArgumentIndex(expr, [tidyMask.has(calledName(expr) ?? '') ? '.data' : 'data'], [])

  const dplyrValueCall = (expr: RExpr): boolean => {
    const name = calledName(expr)
    return Boolean(
      name &&
      R_DPLYR_VALUE_CALLS.has(name) &&
      contractAvailable(name, qualifiedCall(expr)?.package, 'dplyr')
    )
  }
  const memberName = (expr: RExpr | null | undefined): string | null => {
    const op = callOperator(expr)
    if (op && (op === '$' || op === '@') && isCall(expr) && expr.args[1]) {
      return isSymbol(expr.args[1])
        ? expr.args[1].name
        : isCharacter(expr.args[1])
          ? expr.args[1].value
          : null
    }
    if (op === 'slot' && isCall(expr) && isCharacter(expr.args[1])) return expr.args[1].value
    const name = calledName(expr)
    if (name && (biocValue.has(name) || biocUnknown.has(name))) return name
    return null
  }
  const namedArgument = (expr: RExpr | null | undefined, name: string): RExpr | null => {
    if (!isCall(expr)) return null
    const index = expr.names.findIndex((label) => label === name)
    return index >= 0 ? (expr.args[index] ?? null) : null
  }
  const yamlReadIsDynamic = (expr: RExpr): boolean => {
    if (!isCall(expr)) return false
    const handlersIndex = expr.names.findIndex((label) => label === 'handlers')
    if (handlersIndex >= 0) {
      const handlers = expr.args[handlersIndex]
      const emptyHandlers =
        isNull(handlers) ||
        (isCall(handlers) &&
          (callOperator(handlers) === 'c' || callOperator(handlers) === 'list') &&
          handlers.args.length === 0)
      if (!emptyHandlers) return true
    }
    const evalIndex = expr.names.findIndex((label) => label === 'eval.expr')
    if (evalIndex < 0) return false
    const value = expr.args[evalIndex]
    return !(value?.kind === 'atomic' && value.logical === false)
  }
  const externalReadHandleRoot = (expr: RExpr): string | null => {
    // A known character path is a value, not a connection whose cursor can be consumed.
    const handleRoot = (argument: RExpr | null | undefined): string | null =>
      (isSymbol(argument) && characterLoopNames.has(argument.name)) ||
      rStaticString(argument, staticStrings, staticCollections) !== undefined ||
      rStaticStringCollection(argument, staticStrings, staticCollections) !== undefined
        ? null
        : rootName(argument)
    for (const name of [
      'con',
      'file',
      'path',
      'input',
      'dsn',
      'txt',
      'x',
      'filename',
      'file_path',
      'filepath'
    ]) {
      const argument = namedArgument(expr, name)
      if (argument) return handleRoot(argument)
    }
    if (!isCall(expr) || !expr.args.length) return null
    const positional = expr.names
      .map((label, index) => ({ label, index }))
      .filter((item) => !item.label)
    if (!expr.names.some(Boolean)) return handleRoot(expr.args[0])
    if (!positional.length) return null
    return handleRoot(expr.args[positional[0]!.index])
  }
  const staticPackageName = (expr: RExpr): string | null => {
    if (!isCall(expr) || !expr.args[0]) return null
    const pkg = expr.args[0]
    if (isSymbol(pkg)) return pkg.name
    if (isCharacter(pkg)) return pkg.value
    return null
  }
  const rootName = (expr: RExpr | null | undefined): string | null => {
    if (isSymbol(expr)) return expr.name
    const op = callOperator(expr)
    if (op && ['$', '@', '[[', '['].includes(op) && isCall(expr)) return rootName(expr.args[0])
    if (op === 'slot' && isCall(expr)) return rootName(expr.args[0])
    const name = calledName(expr)
    if (name && (biocValue.has(name) || biocUnknown.has(name)) && isCall(expr))
      return rootName(expr.args[0])
    return null
  }
  const biocReplacementAccessor = (expr: RExpr | null | undefined): string | null => {
    const name = calledName(expr)
    if (name && (biocValue.has(name) || biocUnknown.has(name))) return name
    const op = callOperator(expr)
    if (op && ['$', '@', '[[', '[', 'slot'].includes(op) && isCall(expr))
      return biocReplacementAccessor(expr.args[0])
    return null
  }
  const baseReplacementName = (expr: RExpr | null | undefined): string | null => {
    const name = calledName(expr)
    const qualified = qualifiedCall(expr)
    if (
      !name ||
      !['names', 'colnames', 'rownames', 'dimnames', 'dim'].includes(name) ||
      (qualified
        ? qualified.package !== 'base'
        : defined.includes(name) || defined.includes(`${name}<-`))
    )
      return null
    return name
  }
  const staticScalarExpression = (expr: RExpr | null | undefined): boolean => {
    if (expr?.kind === 'atomic' || expr?.kind === 'character') return true
    if (isSymbol(expr)) return expr.name === 'pi' || staticScalarNames.has(expr.name)
    if (!isCall(expr)) return false
    const op = callOperator(expr)
    if (!op || !['+', '-', '*', '/', '^'].includes(op)) return false
    return expr.args.every(staticScalarExpression)
  }
  const staticCollectionExpression = (expr: RExpr | null | undefined): boolean => {
    if (isSymbol(expr)) return staticIterableNames.has(expr.name)
    const op = callOperator(expr)
    return Boolean(
      isCall(expr) &&
      (op === 'c' || op === 'list') &&
      expr.args.length > 0 &&
      expr.args.every(staticScalarExpression)
    )
  }
  const staticNamedCollectionExpression = (expr: RExpr | null | undefined): boolean => {
    if (!isCall(expr)) return false
    const name = calledName(expr)
    if (name === 'c' || name === 'list') {
      return (
        staticCollectionExpression(expr) &&
        expr.names.length === expr.args.length &&
        expr.names.every(Boolean)
      )
    }
    if (name === 'setNames') {
      const namesIndex = expr.names.findIndex((candidate) => candidate === 'nm')
      return (
        staticCollectionExpression(expr.args[0]) &&
        staticCollectionExpression(expr.args[namesIndex >= 0 ? namesIndex : 1])
      )
    }
    if (name === 'structure') {
      const namesIndex = expr.names.findIndex((candidate) => candidate === 'names')
      return (
        namesIndex >= 0 &&
        staticCollectionExpression(expr.args[0]) &&
        staticCollectionExpression(expr.args[namesIndex])
      )
    }
    return false
  }
  const knownNamedCollectionExpression = (expr: RExpr | null | undefined): boolean => {
    if (staticNamedCollectionExpression(expr)) return true
    if (!isCall(expr)) return false
    const name = calledName(expr)
    return Boolean(
      (name === 'c' || name === 'list') &&
      expr.args.length > 0 &&
      expr.names.length === expr.args.length &&
      expr.names.every(Boolean)
    )
  }
  const staticNonemptyIterable = (expr: RExpr | null | undefined): boolean => {
    const captured = rStaticStringCollection(expr, staticStrings, staticCollections)
    if (captured) return captured.values.length > 0
    if (isSymbol(expr)) return staticIterableNames.has(expr.name)
    if (!isCall(expr)) return false
    const op = callOperator(expr)
    if (
      op === 'names' &&
      expr.args.length === 1 &&
      ((isSymbol(expr.args[0]) && staticNamedIterableNames.has(expr.args[0].name)) ||
        knownNamedCollectionExpression(expr.args[0]))
    ) {
      return true
    }
    if (op === ':' && expr.args.length === 2 && expr.args.every(staticScalarExpression)) return true
    if (staticNamedCollectionExpression(expr)) return true
    const name = calledName(expr)
    if (
      name === 'seq_len' &&
      expr.args.length === 1 &&
      expr.args[0]?.kind === 'atomic' &&
      typeof expr.args[0].number === 'number'
    ) {
      return expr.args[0].number > 0
    }
    if (name === 'seq_along' && expr.args.length === 1) {
      return staticNonemptyIterable(expr.args[0])
    }
    if (rIsGlueCall(expr)) {
      const parts = rStaticGlueTemplate(expr)
      return Boolean(
        parts &&
        parts
          .filter((part) => part.kind === 'binding')
          .every(({ value }) => staticScalarNames.has(value) || staticIterableNames.has(value))
      )
    }
    if (name === 'sprintf') {
      return Boolean(
        expr.args.length > 1 &&
        expr.names.every(
          (candidate, index) => !candidate || (index === 0 && candidate === 'fmt')
        ) &&
        staticScalarExpression(expr.args[0]) &&
        expr.args
          .slice(1)
          .every((argument) => staticScalarExpression(argument) || staticNonemptyIterable(argument))
      )
    }
    const combination = rStringCombination(expr)
    if (combination) {
      return Boolean(
        combination.parts.length > 0 &&
        staticScalarExpression(combination.separator) &&
        combination.parts.every(
          (argument) => staticScalarExpression(argument) || staticNonemptyIterable(argument)
        )
      )
    }
    const pathPart = rPathPartArgument(expr)
    if (pathPart)
      return staticScalarExpression(pathPart.argument) || staticNonemptyIterable(pathPart.argument)
    if (
      (op === 'c' || op === 'list') &&
      expr.args.length > 0 &&
      expr.args.every(staticScalarExpression)
    ) {
      return true
    }
    return false
  }
  const tribbleColumnDeclaration = (expr: RExpr | null | undefined): boolean =>
    isCall(expr) && callOperator(expr) === '~' && expr.args.length === 1 && isSymbol(expr.args[0])
  const deterministicLoopBody = (expr: RExpr | null | undefined): boolean => {
    if (!isCall(expr)) return true
    const op = callOperator(expr)
    if (
      op &&
      [
        '<<-',
        '->>',
        'if',
        'while',
        'repeat',
        'switch',
        'function',
        'break',
        'next',
        'return',
        '&&',
        '||'
      ].includes(op)
    ) {
      return false
    }
    return expr.args.every(deterministicLoopBody)
  }
  const assignmentRootName = (expr: RExpr | null | undefined): string | null => {
    if (isSymbol(expr)) return expr.name
    if (!isCall(expr) || !['$', '@', '[[', '['].includes(callOperator(expr) ?? '')) return null
    return assignmentRootName(expr.args[0])
  }
  const localAggregationLoopMutationNames = (
    expr: RExpr | null | undefined
  ): Set<string> | undefined => {
    const names = new Set<string>()
    let safe = true
    const inspect = (candidate: RExpr | null | undefined): void => {
      if (!candidate || !safe || !isCall(candidate)) return
      const op = callOperator(candidate)
      if (op && ['<-', '=', '->'].includes(op)) {
        const target = op === '->' ? candidate.args[1] : candidate.args[0]
        const value = op === '->' ? candidate.args[0] : candidate.args[1]
        const name = assignmentRootName(target)
        if (!name || !deterministicLoopBody(value)) {
          safe = false
          return
        }
        names.add(name)
        return
      }
      if (op === '{' || op === '(') {
        for (const arg of candidate.args) inspect(arg)
        return
      }
      if (op === 'if') {
        if (!deterministicLoopBody(candidate.args[0])) {
          safe = false
          return
        }
        for (const branch of candidate.args.slice(1)) inspect(branch)
        return
      }
      safe = false
    }
    inspect(expr)
    return safe && names.size ? names : undefined
  }
  const assignedNamesIn = (expr: RExpr | null | undefined): string[] => {
    if (!isCall(expr) || callOperator(expr) === 'function') return []
    const op = callOperator(expr)
    if (op && ['<-', '=', '->'].includes(op)) {
      const target = op === '->' ? expr.args[1] : expr.args[0]
      const value = op === '->' ? expr.args[0] : expr.args[1]
      return [...(isSymbol(target) && target.name ? [target.name] : []), ...assignedNamesIn(value)]
    }
    if (op === 'for') {
      const target = expr.args[0]
      return [
        ...(isSymbol(target) && target.name ? [target.name] : []),
        ...assignedNamesIn(expr.args[2])
      ]
    }
    return expr.args.flatMap(assignedNamesIn)
  }
  const namespaceLoadsIn = (
    expr: RExpr | null | undefined,
    localScope: ReadonlySet<string> = new Set()
  ): string[] => {
    if (isSymbol(expr)) {
      return expr.name && !localScope.has(expr.name) ? [expr.name] : []
    }
    if (!isCall(expr)) return []
    const op = callOperator(expr)
    if (op === 'function') {
      const formals = expr.args[0]
      const body = expr.args[1]
      const locals = new Set(localScope)
      if (formals?.kind === 'formals') {
        for (const name of formals.names) if (name) locals.add(name)
      }
      for (const name of assignedNamesIn(body)) locals.add(name)
      return namespaceLoadsIn(body, locals)
    }
    if (op && ['<-', '=', '->'].includes(op)) {
      const target = op === '->' ? expr.args[1] : expr.args[0]
      const value = op === '->' ? expr.args[0] : expr.args[1]
      return [
        ...(!isSymbol(target) && isCall(target)
          ? namespaceLoadsIn(target.args[0], localScope)
          : []),
        ...namespaceLoadsIn(value, localScope)
      ]
    }
    if (op === 'for') {
      const target = expr.args[0]
      const loopScope = new Set(localScope)
      if (isSymbol(target) && target.name) loopScope.add(target.name)
      return [
        ...namespaceLoadsIn(expr.args[1], localScope),
        ...namespaceLoadsIn(expr.args[2], loopScope)
      ]
    }
    return [
      ...(op && !localScope.has(op) ? [op] : []),
      ...expr.args.flatMap((arg) => namespaceLoadsIn(arg, localScope))
    ]
  }
  const isolatedConditionalLoops = new Map<RExpr, Set<string>>()
  const localAggregationLoops = new Map<RExpr, Set<string>>()
  for (const [index, expression] of expressions.entries()) {
    if (
      !isCall(expression) ||
      callOperator(expression) !== 'for' ||
      !isSymbol(expression.args[0])
    ) {
      continue
    }
    const deterministicBody = deterministicLoopBody(expression.args[2])
    const localAggregationNames = localAggregationLoopMutationNames(expression.args[2])
    if (!deterministicBody && !localAggregationNames) continue
    const assignedNames = new Set([expression.args[0].name, ...assignedNamesIn(expression.args[2])])
    const laterLoads = new Set(
      expressions.slice(index + 1).flatMap((candidate) => namespaceLoadsIn(candidate))
    )
    if (localAggregationNames && !laterLoads.has(expression.args[0].name)) {
      localAggregationLoops.set(expression, localAggregationNames)
    }
    if (deterministicBody && [...assignedNames].every((name) => !laterLoads.has(name))) {
      isolatedConditionalLoops.set(expression, assignedNames)
    }
  }
  const copyOnModifySources = (expr: RExpr | null | undefined): string[] | null => {
    if (!expr || expr.kind === 'atomic' || expr.kind === 'character' || expr.kind === 'null')
      return []
    if (isSymbol(expr)) {
      if (!expr.name) return []
      if (copyOnModify.includes(expr.name)) return []
      const matching = copyOnModifyBindings.filter((binding) => binding.target === expr.name)
      if (matching.length) return matching[matching.length - 1]?.sourceNames ?? []
      if (copyOnModifyInvalidated.includes(expr.name)) return null
      if (defined.includes(expr.name)) return null
      return [expr.name]
    }
    if (!isCall(expr)) return null
    let op = callOperator(expr)
    const qualified = qualifiedCall(expr)
    const constructors = [
      'list',
      'c',
      'numeric',
      'integer',
      'logical',
      'character',
      'complex',
      'raw',
      'matrix',
      'array',
      'data.frame',
      'factor',
      'structure',
      ...tibbleConstructorCalls
    ]
    const valueOps = ['+', '-', '*', '/', '^', ':']
    if (!op && qualified?.package === 'tibble' && tibbleConstructors.has(qualified.name))
      op = qualified.name
    if (!op && qualified && qualifiedValueFileRead(qualified.package, qualified.name)) {
      if (qualified.package === 'yaml' && yamlReads.has(qualified.name) && yamlReadIsDynamic(expr))
        return null
      return []
    }
    if (op && valueFileReadCalls.has(op)) {
      if (yamlReads.has(op) && yamlReadIsDynamic(expr)) return null
      return []
    }
    // A frequency table owns its integer counts; it does not retain mutable input objects.
    if (op === 'table' || (qualified?.package === 'base' && qualified.name === 'table')) return []
    if (
      op === 'as.data.frame' ||
      (qualified?.package === 'base' && qualified.name === 'as.data.frame')
    ) {
      return copyOnModifySources(expr.args[0])
    }
    if (dplyrValueCall(expr)) {
      const sources = expr.args.map(copyOnModifySources)
      return sources.some((item) => item === null)
        ? null
        : unique(sources.flatMap((item) => item ?? []))
    }
    if (op && pipeOps.has(op) && expr.args.length >= 2) {
      const dataSources = copyOnModifySources(expr.args[0])
      const rhs = expr.args[1]
      const transformName = tabularTransformName(rhs)
      if (!dataSources || !transformName || !tabularTransform.has(transformName)) return null
      if (!['mutate', 'transmute', 'summarise', 'summarize'].includes(transformName))
        return dataSources
      const addedValues = isCall(rhs) ? rhs.args : []
      const addedSources = addedValues.map((value) => {
        if (value.kind === 'atomic' || value.kind === 'character') return [] as string[]
        if (isSymbol(value)) return copyOnModifySources(value)
        if (dplyrValueCall(value)) return copyOnModifySources(value)
        const valueOp = callOperator(value)
        if (valueOp && constructors.includes(valueOp)) return copyOnModifySources(value)
        if (valueOp && (valueOps.includes(valueOp) || pureSafe.has(valueOp))) return [] as string[]
        return null
      })
      if (addedSources.some((item) => item === null)) return null
      return unique([...dataSources, ...addedSources.flatMap((item) => item ?? [])])
    }
    const transformName = tabularTransformName(expr)
    if (transformName && tabularTransform.has(transformName) && expr.args.length >= 1) {
      const dataIndex = tabularDataIndex(expr)
      const dataSources = copyOnModifySources(expr.args[dataIndex])
      if (!dataSources) return null
      if (!['mutate', 'transmute', 'summarise', 'summarize'].includes(transformName))
        return dataSources
      const addedValues = expr.args.filter((_value, index) => index !== dataIndex)
      const addedSources = addedValues.map((value) => {
        if (value.kind === 'atomic' || value.kind === 'character') return [] as string[]
        if (isSymbol(value)) return copyOnModifySources(value)
        if (dplyrValueCall(value)) return copyOnModifySources(value)
        const valueOp = callOperator(value)
        if (valueOp && constructors.includes(valueOp)) return copyOnModifySources(value)
        if (valueOp && (valueOps.includes(valueOp) || pureSafe.has(valueOp))) return [] as string[]
        return null
      })
      if (addedSources.some((item) => item === null)) return null
      return unique([...dataSources, ...addedSources.flatMap((item) => item ?? [])])
    }
    if (!op || ![...constructors, ...valueOps].includes(op)) return null
    const callArgs =
      op === 'tribble' ? expr.args.filter((value) => !tribbleColumnDeclaration(value)) : expr.args
    const sources = callArgs.map(copyOnModifySources)
    if (sources.some((item) => item === null)) return null
    return unique(sources.flatMap((item) => item ?? []))
  }
  const walkAssignmentTarget = (target: RExpr): void => {
    const replacement = baseReplacementName(target)
    if (replacement && isCall(target)) {
      const dependency = `${qualifiedCall(target) ? 'base::' : ''}${replacement}<-`
      used.push(dependency)
      if (!defined.includes(dependency)) priorUsed.push(dependency)
      safeCallNames.push(dependency)
      for (const arg of target.args) walk(arg, false)
      return
    }
    const op = callOperator(target)
    if (!op || !isCall(target)) return
    if (op === '$' || op === '@') {
      walk(target.args[0], false)
      return
    }
    if (op === '[[' || op === '[' || op === 'slot') {
      for (const arg of target.args) walk(arg, false)
    }
  }
  const addPossibleAlias = (
    target: string,
    source: string,
    access?: string,
    member?: string
  ): void => {
    possibleAliases.push({
      target,
      source,
      kind: 'possible-reference',
      ...(access === 'attribute' || access === 'subscript' ? { access } : {}),
      ...(member ? { member } : {})
    })
  }
  const methodEffect = (
    fn: RExpr,
    receivers = ['self', 'private'],
    copyOnModifyMethod = false
  ): { effect: 'read' | 'mutate' | 'unknown'; unknownScope?: 'namespace' } => {
    let effect: 'read' | 'mutate' | 'unknown' = 'read'
    let namespaceUnknown = false
    const markMutate = (conditional = false): void => {
      if (conditional || copyOnModifyMethod) effect = 'unknown'
      else if (effect !== 'unknown') effect = 'mutate'
    }
    const markUnknown = (namespace = false): void => {
      effect = 'unknown'
      if (namespace) namespaceUnknown = true
    }
    const inspect = (expr: RExpr | null | undefined, conditional = false): void => {
      if (!isCall(expr)) return
      const op = callOperator(expr)
      if (op && ['<-', '=', '->', '<<-', '->>'].includes(op)) {
        const rightward = op === '->' || op === '->>'
        const target = rightward ? expr.args[1] : expr.args[0]
        const value = rightward ? expr.args[0] : expr.args[1]
        const targetRoot = rootName(target)
        if (targetRoot && receivers.includes(targetRoot)) markMutate(conditional)
        else if (!isSymbol(target) || op === '<<-' || op === '->>') markUnknown(true)
        inspect(value, conditional)
        return
      }
      if (op === 'function') {
        markUnknown()
        return
      }
      if (!op) {
        markUnknown(true)
        for (const arg of expr.args) inspect(arg, conditional)
        return
      }
      if (['if', 'for', 'while', 'repeat', 'switch'].includes(op)) {
        for (const arg of expr.args) inspect(arg, true)
        return
      }
      const syntax = [
        '{',
        '(',
        'if',
        'for',
        'while',
        'repeat',
        '+',
        '-',
        '*',
        '/',
        '^',
        ':',
        '::',
        ':::',
        '[[',
        '[',
        '$',
        '@',
        '!',
        '&',
        '&&',
        '|',
        '||',
        '<',
        '>',
        '<=',
        '>=',
        '==',
        '!='
      ]
      if (!syntax.includes(op) && !safeCalls.has(op) && op !== 'function') markUnknown(true)
      for (const arg of expr.args) inspect(arg, conditional)
    }
    if (callOperator(fn) !== 'function' || !isCall(fn) || fn.args.length < 2) {
      return { effect: 'unknown', unknownScope: 'namespace' }
    }
    inspect(fn.args[1])
    return { effect, unknownScope: namespaceUnknown ? 'namespace' : undefined }
  }
  const methodLocalNames = (fn: RExpr): string[] => {
    if (callOperator(fn) !== 'function' || !isCall(fn) || fn.args[0]?.kind !== 'formals') return []
    const locals = [...fn.args[0].names]
    const collectLocals = (expr: RExpr | null | undefined): void => {
      if (!isCall(expr)) return
      const op = callOperator(expr)
      if (op === 'function') return
      if (op && ['<-', '=', '->'].includes(op)) {
        const target = op === '->' ? expr.args[1] : expr.args[0]
        const value = op === '->' ? expr.args[0] : expr.args[1]
        if (isSymbol(target)) locals.push(target.name)
        collectLocals(value)
        return
      }
      for (const arg of expr.args) collectLocals(arg)
    }
    collectLocals(fn.args[1])
    return unique(locals)
  }
  const methodUsedNames = (fn: RExpr, receivers = ['self', 'private']): string[] => {
    if (callOperator(fn) !== 'function' || !isCall(fn)) return []
    const locals = methodLocalNames(fn)
    const usedNames: string[] = []
    const collectUsed = (expr: RExpr | null | undefined): void => {
      if (isSymbol(expr)) {
        if (expr.name && !locals.includes(expr.name) && !receivers.includes(expr.name))
          usedNames.push(expr.name)
        return
      }
      if (!isCall(expr)) return
      const op = callOperator(expr)
      if (op === 'function') return
      if (op && ['<-', '=', '->', '<<-', '->>'].includes(op)) {
        const rightward = op === '->' || op === '->>'
        const target = rightward ? expr.args[1] : expr.args[0]
        const value = rightward ? expr.args[0] : expr.args[1]
        if (!isSymbol(target) && isCall(target)) collectUsed(target.args[0])
        collectUsed(value)
        return
      }
      if (op && ['$', '@', 'slot'].includes(op)) {
        collectUsed(expr.args[0])
        return
      }
      if (op === '::' || op === ':::') return
      const syntaxOps = [
        '{',
        '(',
        'if',
        'for',
        'while',
        'repeat',
        'switch',
        '+',
        '-',
        '*',
        '/',
        '^',
        ':',
        '[[',
        '[',
        '!',
        '&',
        '&&',
        '|',
        '||',
        '<',
        '>',
        '<=',
        '>=',
        '==',
        '!='
      ]
      if (op && !syntaxOps.includes(op) && !receivers.includes(op)) usedNames.push(op)
      for (const arg of expr.args) collectUsed(arg)
    }
    collectUsed(fn.args[1])
    return unique(usedNames).sort()
  }
  const methodSafeCallNames = (fn: RExpr): string[] => {
    if (callOperator(fn) !== 'function' || !isCall(fn)) return []
    const calls: string[] = []
    const collect = (expr: RExpr | null | undefined): void => {
      if (!isCall(expr)) return
      const op = callOperator(expr)
      if (op === 'function') return
      if (op && safeCalls.has(op)) calls.push(op)
      for (const arg of expr.args) collect(arg)
    }
    collect(fn.args[1])
    return unique(calls).sort()
  }
  const valueRelationship = (expr: RExpr | null | undefined): 'value' | 'reference' | 'unknown' => {
    if (!expr || expr.kind === 'atomic' || expr.kind === 'character' || expr.kind === 'null')
      return 'value'
    const name = calledName(expr)
    if (name && (name === 'new.env' || name === 'environment')) return 'reference'
    if (
      name &&
      [
        'c',
        'list',
        'data.frame',
        'matrix',
        'array',
        'numeric',
        'integer',
        'logical',
        'character',
        'factor'
      ].includes(name)
    ) {
      return 'value'
    }
    if (isCall(expr) && !callOperator(expr) && memberName(expr.callee) === 'new') return 'reference'
    return 'unknown'
  }
  const summarizeR6 = (name: string, value: RExpr): NotebookDependencyTypeSummary | null => {
    if (calledName(value) !== 'R6Class' || !isCall(value)) return null
    if (namedArgument(value, 'inherit') || namedArgument(value, 'active')) return null
    const publicExpr = namedArgument(value, 'public')
    if (!publicExpr || callOperator(publicExpr) !== 'list' || !isCall(publicExpr)) return null
    if (publicExpr.names.some((label) => !label)) return null
    const fields: NotebookDependencyTypeSummary['fields'] = []
    const methods: NotebookDependencyTypeSummary['methods'] = []
    for (let index = 0; index < publicExpr.args.length; index += 1) {
      const entryName = publicExpr.names[index]
      const entry = publicExpr.args[index]
      if (!entryName) return null
      if (callOperator(entry) === 'function' && entry) {
        let analysis = methodEffect(entry)
        const safeNames = methodSafeCallNames(entry)
        const shadowed = safeNames.filter((item) => methodLocalNames(entry).includes(item))
        if (shadowed.length) analysis = { effect: 'unknown', unknownScope: 'namespace' }
        methods.push({
          name: entryName,
          effect: analysis.effect,
          usedNames: methodUsedNames(entry),
          safeCallNames: safeNames.filter((item) => !shadowed.includes(item)),
          unknownScope: analysis.unknownScope ?? 'receiver'
        })
      } else if (entry) fields.push({ name: entryName, relationship: valueRelationship(entry) })
    }
    return { name, kind: 'r-r6', fields, methods }
  }
  const summarizeS4 = (expr: RExpr): NotebookDependencyTypeSummary | null => {
    if (calledName(expr) !== 'setClass' || !isCall(expr) || !isCharacter(expr.args[0])) return null
    const name = expr.args[0].value
    const slots = namedArgument(expr, 'slots')
    const fields: NotebookDependencyTypeSummary['fields'] = []
    if (slots && callOperator(slots) === 'c' && isCall(slots)) {
      for (let index = 0; index < slots.args.length; index += 1) {
        const label = slots.names[index]
        if (!label) continue
        const slot = slots.args[index]
        const slotType = isCharacter(slot) ? slot.value : 'ANY'
        const relationship =
          slotType === 'environment'
            ? 'reference'
            : ['ANY', 'externalptr', 'weakref', 'list'].includes(slotType)
              ? 'unknown'
              : 'value'
        fields.push({ name: label, relationship })
      }
    }
    return { name, kind: 'r-s4', fields, methods: [] }
  }
  const summarizeS4Method = (expr: RExpr): NotebookDependencyTypeSummary | null => {
    if (calledName(expr) !== 'setMethod' || !isCall(expr)) return null
    const methodName = namedArgument(expr, 'f') ?? expr.args[0]
    const signature = namedArgument(expr, 'signature') ?? expr.args[1]
    let definition = namedArgument(expr, 'definition')
    if (!definition) {
      const functions = expr.args.filter((arg) => callOperator(arg) === 'function')
      definition = functions[functions.length - 1]
    }
    if (
      !isCharacter(methodName) ||
      !isCharacter(signature) ||
      callOperator(definition) !== 'function' ||
      !definition
    ) {
      return null
    }
    const formals =
      isCall(definition) && definition.args[0]?.kind === 'formals' ? definition.args[0] : null
    const receiver = formals?.names[0]
    if (!receiver) return null
    let analysis = methodEffect(definition, [receiver], true)
    const safeNames = methodSafeCallNames(definition)
    const shadowed = safeNames.filter((item) => methodLocalNames(definition).includes(item))
    if (shadowed.length) analysis = { effect: 'unknown', unknownScope: 'namespace' }
    return {
      name: signature.value,
      kind: 'r-s4',
      complete: false,
      fields: [],
      methods: [
        {
          name: methodName.value,
          effect: analysis.effect,
          usedNames: methodUsedNames(definition, [receiver]),
          safeCallNames: safeNames.filter((item) => !shadowed.includes(item)),
          unknownScope: analysis.unknownScope ?? 'receiver'
        }
      ]
    }
  }
  const constructorType = (expr: RExpr | null | undefined): string | null => {
    if (!isCall(expr)) return null
    if (dataTableQuery(expr)) return 'data.table'
    const qualified = qualifiedCall(expr)
    const name = calledName(expr)
    if (
      qualified?.package === 'data.table' &&
      (dataTableConstructors.has(qualified.name) || qualified.name === 'copy')
    ) {
      return 'data.table'
    }
    if (
      qualified?.package === 'openxlsx' &&
      (qualified.name === 'loadWorkbook' || openxlsxReferenceConstructors.includes(qualified.name))
    ) {
      return 'openxlsx.Workbook'
    }
    if (name && (dataTableConstructors.has(name) || name === 'copy')) return 'data.table'
    if (name && biocConstructors.has(name)) return name
    if (name === 'new' && isCharacter(expr.args[0])) return expr.args[0].value
    if (!callOperator(expr) && isCall(expr.callee) && memberName(expr.callee) === 'new')
      return rootName(expr.callee)
    return null
  }
  const addDataTableSummary = (): void => {
    if (!typeSummaries.some((summary) => summary.name === 'data.table')) {
      typeSummaries.push({ name: 'data.table', kind: 'r-r6', fields: [], methods: [] })
    }
  }
  const addOpenxlsxWorkbookSummary = (): void => {
    if (!typeSummaries.some((summary) => summary.name === 'openxlsx.Workbook')) {
      typeSummaries.push({ name: 'openxlsx.Workbook', kind: 'r-r6', fields: [], methods: [] })
    }
  }
  const addBiocSummary = (name: string): void => {
    const common = ['assay', 'assays', 'colData', 'rowData', 'rowRanges']
    const fields =
      name === 'SingleCellExperiment'
        ? [
            ...common,
            'altExp',
            'altExps',
            'colLabels',
            'logcounts',
            'normcounts',
            'reducedDim',
            'reducedDims',
            'rowSubset',
            'sizeFactors'
          ]
        : name === 'ExpressionSet'
          ? ['exprs', 'fData', 'featureData', 'pData']
          : common
    const extra = name === 'ExpressionSet' ? 'experimentData' : 'metadata'
    const fieldSummaries = [...fields, extra].map((field) => ({
      name: field,
      relationship: 'unknown' as const
    }))
    const accessors = unique([...fields, extra])
    typeSummaries.push({
      name,
      kind: 'r-s4',
      fields: fieldSummaries,
      methods: accessors.map((accessor) => ({
        name: accessor,
        effect: 'read',
        usedNames: [],
        safeCallNames: [],
        unknownScope: 'receiver'
      }))
    })
  }
  const addDataFrameSummary = (): void => {
    typeSummaries.push({ name: 'data.frame', kind: 'r-s4', fields: [], methods: [] })
  }
  const dataTableUpdate = (expr: RExpr): { update: RExpr } | null => {
    if (callOperator(expr) !== '[' || !isCall(expr) || expr.args.length < 3) return null
    const update = expr.args[2]
    if (!update || (isSymbol(update) && !update.name)) return null
    if (!isCall(update) || callOperator(update) !== ':=') return null
    return { update }
  }
  const dataTableQuery = (expr: RExpr): Record<string, never> | null => {
    if (callOperator(expr) !== '[' || !isCall(expr) || expr.args.length < 3) return null
    if (dataTableUpdate(expr)) return null
    const j = expr.args[2]
    if (!j || (isSymbol(j) && !j.name)) return null
    const hasClause =
      expr.names.some((label) => label === 'by' || label === 'keyby' || label === '.SDcols') ||
      (isCall(j) && callOperator(j) === '.')
    return hasClause ? {} : null
  }
  const walkDataMask = (
    expr: RExpr | null | undefined,
    trackEnvironment = false,
    phase: RCallbackEvaluation['phase'] = 'immediate'
  ): void => {
    if (isSymbol(expr)) {
      if (trackEnvironment && expr.name && expr.name !== '.data' && expr.name !== '.env')
        possiblyUsed.push(expr.name)
      return
    }
    if (!isCall(expr)) return
    const op = callOperator(expr)
    if (
      op &&
      (op === '$' || op === '[[') &&
      expr.args.length >= 2 &&
      isSymbol(expr.args[0]) &&
      (expr.args[0].name === '.env' || expr.args[0].name === '.data')
    ) {
      const pronoun = expr.args[0].name
      const key = expr.args[1]
      const name = op === '$' && isSymbol(key) ? key.name : isCharacter(key) ? key.value : null
      if (!name) {
        unknown.push('dynamic-data-mask-lookup')
        return
      }
      if (pronoun === '.env') {
        used.push(name)
        if (!defined.includes(name)) priorUsed.push(name)
      }
      return
    }
    const quoted = quotedDataCall(expr)
    if (quoted) {
      used.push(quoted.dependency)
      if (!defined.includes(quoted.dependency)) priorUsed.push(quoted.dependency)
      safeCallNames.push(quoted.dependency)
      return
    }
    const qualified = qualifiedCall(expr)
    let resolvedOp = op
    if (!resolvedOp && qualified) {
      if (knownQualifiedCall(qualified.package, qualified.name)) resolvedOp = qualified.name
      else unknown.push('opaque-call')
    }
    if (!resolvedOp && isCall(expr.callee)) {
      const calleeOp = callOperator(expr.callee)
      if (
        calleeOp &&
        (calleeOp === '$' || calleeOp === '[[') &&
        isCall(expr.callee) &&
        isSymbol(expr.callee.args[0])
      ) {
        const pronoun = expr.callee.args[0].name
        const key = expr.callee.args[1]
        const name =
          calleeOp === '$' && isSymbol(key) ? key.name : isCharacter(key) ? key.value : null
        if (pronoun === '.env' && name) {
          used.push(name)
          if (!defined.includes(name)) priorUsed.push(name)
        }
        unknown.push(name ? 'opaque-call' : 'dynamic-data-mask-lookup')
      }
    }
    const dependencyName = qualified ? `${qualified.package}::${qualified.name}` : resolvedOp
    const callback = resolvedOp ? functionalCallbacks.get(resolvedOp) : undefined
    if (callback && resolvedOp && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (!contractAvailable(resolvedOp, qualified?.package, callback.package))
        unknown.push('opaque-call')
      else safeCallNames.push(dependencyName)
      const index = callbackArgumentIndex(expr, callback.keywords, callback.precedingArguments)
      const argument = expr.args[index]
      if (
        !(callback.optional && (!argument || isNull(argument))) &&
        !consumeCallback(argument, {
          phase,
          formulaParameters: callback.formulaParameters,
          allowList: callback.allowList
        })
      )
        unknown.push('opaque-call')
      for (let i = 0; i < expr.args.length; i += 1) {
        if (i === index) continue
        if (
          ['.names', '.unpack'].includes(expr.names[i] ?? '') ||
          callback.valueArguments?.some((name) => callbackArgumentIndex(expr, [name], []) === i)
        )
          walk(expr.args[i], false)
        else walkDataMask(expr.args[i], trackEnvironment, phase)
      }
      return
    }
    if (resolvedOp && R_TIDY_SELECT_CALLS.has(resolvedOp) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (!contractAvailable(resolvedOp, qualified?.package, 'tidyselect'))
        unknown.push('opaque-call')
      else safeCallNames.push(dependencyName)
      // all_of(column_names), for example, reads an environment value, not a column.
      for (const argument of expr.args) walk(argument, false)
      return
    }
    if (resolvedOp && R_DPLYR_VALUE_CALLS.has(resolvedOp) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (dplyrValueCall(expr)) safeCallNames.push(dependencyName)
      else unknown.push('opaque-call')
      for (const argument of expr.args) walkDataMask(argument, trackEnvironment, phase)
      return
    }
    const composed = resolvedOp && !qualified ? functions.get(resolvedOp)?.methods[0] : undefined
    if (composed && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      mergeCallbackReads(composed)
      if (
        phase === 'deferred' &&
        (composed.usedNames ?? []).some((name) => !composed.safeCallNames?.includes(name))
      )
        unknown.push('opaque-call')
      for (const argument of expr.args) walkDataMask(argument, trackEnvironment, phase)
      return
    }
    const syntax = [
      '{',
      '(',
      '+',
      '-',
      '*',
      '/',
      '^',
      ':',
      '[[',
      '[',
      '$',
      '@',
      '!',
      '&',
      '&&',
      '|',
      '||',
      '<',
      '>',
      '<=',
      '>=',
      '==',
      '!=',
      '~'
    ]
    if (resolvedOp && !syntax.includes(resolvedOp) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (safeCalls.has(resolvedOp)) safeCallNames.push(dependencyName)
      else unknown.push('opaque-call')
    }
    for (const arg of expr.args) walkDataMask(arg, trackEnvironment, phase)
  }
  const walkTabularArguments = (expr: Extract<RExpr, { kind: 'call' }>, piped: boolean): void => {
    const dataIndex = piped ? -1 : tabularDataIndex(expr)
    const valueArguments = R_TABLE_SELECTION_VALUE_ARGUMENTS.get(calledName(expr) ?? '') ?? []
    expr.args.forEach((argument, index) => {
      if (index === dataIndex || valueArguments.includes(expr.names[index] ?? ''))
        walk(argument, false)
      else walkDataMask(argument, true)
    })
  }
  const walkDataTableMask = (expr: RExpr): void => {
    if (isCall(expr) && callOperator(expr) === '.') {
      for (const value of expr.args) walkDataMask(value, true)
      return
    }
    walkDataMask(expr, true)
  }
  const walkDataTableQuery = (expr: RExpr): void => {
    if (!isCall(expr)) return
    const receiver = rootName(expr.args[0])
    if (!receiver) {
      unknown.push('opaque-call')
      return
    }
    used.push(receiver)
    if (!defined.includes(receiver)) priorUsed.push(receiver)
    addDataTableSummary()
    for (let index = 1; index < expr.args.length; index += 1) {
      const arg = expr.args[index]
      if (isSymbol(arg) && !arg.name) continue
      walkDataTableMask(arg)
    }
  }
  const walkDataTableUpdate = (expr: RExpr, update: RExpr): void => {
    if (!isCall(expr) || !isCall(update)) return
    const receiver = rootName(expr.args[0])
    if (!receiver) {
      unknown.push('dynamic-assignment')
      return
    }
    used.push(receiver)
    if (!defined.includes(receiver)) priorUsed.push(receiver)
    mutated.push(receiver)
    addDataTableSummary()
    typeBindings.push({ target: receiver, typeName: 'data.table', argumentNames: [] })
    receiverCalls.push({ receiver, member: ':=', kind: 'mutating', argumentNames: [] })
    const updateLabels = update.names
    if (updateLabels.some((label) => label)) {
      for (const arg of update.args) walkDataMask(arg, true)
    } else if (update.args.length > 1) {
      for (const arg of update.args.slice(1)) walkDataMask(arg, true)
    }
    for (let index = 0; index < expr.args.length; index += 1) {
      if (index === 0 || index === 2) continue
      const arg = expr.args[index]
      if (isSymbol(arg) && !arg.name) continue
      walkDataMask(arg, true)
    }
  }
  const prepareAssignment = (name: string): void => {
    const conditional = controlDepth > 0
    isolatedConditionallyDefined.delete(name)
    staticIterableNames.delete(name)
    staticNamedIterableNames.delete(name)
    staticScalarNames.delete(name)
    literalLabelNames.delete(name)
    staticStrings.delete(name)
    staticCollections.delete(name)
    localInputHandleNames.delete(name)
    characterLoopNames.delete(name)
    functions.delete(name)
    typeBindings = typeBindings.filter((binding) => binding.target !== name)
    copyOnModify = copyOnModify.filter((item) => item !== name)
    copyOnModifyBindings = copyOnModifyBindings.filter((binding) => binding.target !== name)
    copyOnModifyInvalidated = copyOnModifyInvalidated.filter((item) => item !== name)
    if (conditional) {
      conditionallyDefined.add(name)
      unknown.push('control-flow')
    } else conditionallyDefined.delete(name)
    for (const [target, alias] of [...aliases.entries()]) {
      if (alias.source === name) {
        addPossibleAlias(target, name)
        aliases.delete(target)
        unknown.push('alias-rebind')
      }
    }
    const existing = aliases.get(name)
    if (existing) {
      if (conditional) addPossibleAlias(name, existing.source)
      else {
        used = removeFirst(used, existing.source)
        priorUsed = removeFirst(priorUsed, existing.source)
      }
    }
    aliases.delete(name)
  }
  const updateCopyOnModifyMember = (name: string, value: RExpr | undefined): void => {
    const rootSources = copyOnModifySources(symbol(name))
    const memberSources = copyOnModifySources(value)
    copyOnModify = copyOnModify.filter((item) => item !== name)
    copyOnModifyBindings = copyOnModifyBindings.filter((binding) => binding.target !== name)
    copyOnModifyInvalidated = copyOnModifyInvalidated.filter((item) => item !== name)
    if (!rootSources || !memberSources) {
      copyOnModifyInvalidated.push(name)
      return
    }
    const sources = unique([...rootSources, ...memberSources])
    if (!sources.length) copyOnModify.push(name)
    else copyOnModifyBindings.push({ target: name, sourceNames: sources })
  }
  const walk = (expr: RExpr | null | undefined, assignmentTarget = false): void => {
    if (!expr) return
    if (isSymbol(expr)) {
      if (!expr.name) return
      if (!assignmentTarget && localNames.includes(expr.name)) return
      if (assignmentTarget) defined.push(expr.name)
      else {
        used.push(expr.name)
        if (!defined.includes(expr.name)) priorUsed.push(expr.name)
      }
      return
    }
    if (!isCall(expr)) return
    const quoted = quotedDataCall(expr)
    if (quoted) {
      used.push(quoted.dependency)
      if (!defined.includes(quoted.dependency)) priorUsed.push(quoted.dependency)
      safeCallNames.push(quoted.dependency)
      return
    }
    let op = callOperator(expr)
    const qualified = qualifiedCall(expr)
    if (!op && qualified && knownQualifiedCall(qualified.package, qualified.name))
      op = qualified.name
    const dependencyName = qualified ? `${qualified.package}::${qualified.name}` : op

    const s4Summary = summarizeS4(expr)
    if (s4Summary) {
      typeSummaries.push(s4Summary)
      return
    }
    const s4MethodSummary = summarizeS4Method(expr)
    if (s4MethodSummary) {
      typeSummaries.push(s4MethodSummary)
      return
    }
    const tableUpdate = dataTableUpdate(expr)
    if (tableUpdate) {
      walkDataTableUpdate(expr, tableUpdate.update)
      return
    }
    if (dataTableQuery(expr)) {
      walkDataTableQuery(expr)
      return
    }
    if (op && (biocValue.has(op) || biocUnknown.has(op)) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      const receiver = expr.args[0] ? rootName(expr.args[0]) : null
      if (!receiver) unknown.push('opaque-call')
      else {
        used.push(receiver)
        if (!defined.includes(receiver)) priorUsed.push(receiver)
        const argumentRoots = unique(
          expr.args.map(rootName).filter((name): name is string => Boolean(name))
        )
        receiverCalls.push({ receiver, member: op, kind: 'generic', argumentNames: argumentRoots })
      }
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (rIsGlueCall(expr) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(R_GLUE_FUNCTION.name)
      const template = rStaticGlueTemplate(expr)
      if (!template) unknown.push('opaque-call')
      else {
        for (const name of unique(
          template.filter((part) => part.kind === 'binding').map((part) => part.value)
        )) {
          used.push(name)
          if (!defined.includes(name)) priorUsed.push(name)
        }
      }
      return
    }
    if (!op) {
      const receiver = rootName(expr.callee)
      if (receiver) {
        used.push(receiver)
        if (!defined.includes(receiver)) priorUsed.push(receiver)
        const member = memberName(expr.callee)
        if (member) {
          const argumentRoots = unique(
            expr.args.map(rootName).filter((name): name is string => Boolean(name))
          )
          receiverCalls.push({ receiver, member, argumentNames: argumentRoots })
        } else {
          possiblyMutated.push(receiver)
          unknown.push('opaque-mutation')
        }
      } else unknown.push('opaque-call')
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (['<-', '=', '->', '<<-', '->>'].includes(op)) {
      const rightward = op === '->' || op === '->>'
      const nonlocal = op === '<<-' || op === '->>'
      const target = rightward ? expr.args[1] : expr.args[0]
      const value = rightward ? expr.args[0] : expr.args[1]
      const name =
        rootName(target) ??
        (isCall(target) && baseReplacementName(target) ? rootName(target.args[0]) : null)
      const aliasedFunction = isSymbol(value) ? functions.get(value.name) : undefined
      const definedBefore = unique(defined)
      const usedBefore = used.length
      let r6Summary: NotebookDependencyTypeSummary | null = null
      let constructed: string | null = null
      let simpleAliasAssignment = false
      let functionDefinition = false
      if (name) {
        if (nonlocal) {
          used.push(name)
          possiblyMutated.push(name)
          unknown.push('nonlocal-assignment')
        } else if (isSymbol(target)) {
          const literalLabel = literalLabelValue(value)
          const copySources = copyOnModifySources(value)
          const staticString = rStaticString(value, staticStrings, staticCollections)
          const staticCollection = rStaticStringCollection(value, staticStrings, staticCollections)
          const inputHandleAlias = isSymbol(value) && localInputHandleNames.has(value.name)
          defined.push(name)
          prepareAssignment(name)
          if (controlDepth === 0 && literalLabel) literalLabelNames.add(name)
          if (controlDepth === 0 && staticString !== undefined)
            staticStrings.set(name, staticString)
          if (controlDepth === 0 && staticCollection) staticCollections.set(name, staticCollection)
          const valueCall = value ? calledName(value) : null
          const valueQualified = value ? qualifiedCall(value) : null
          if (
            controlDepth === 0 &&
            (inputHandleAlias ||
              (valueCall &&
                [
                  'I',
                  'rawConnection',
                  'textConnection',
                  'file',
                  'gzfile',
                  'bzfile',
                  'xzfile',
                  'unz',
                  'gzcon'
                ].includes(valueCall) &&
                (valueQualified?.package === 'base' ||
                  (!valueQualified && !localNames.includes(valueCall)))))
          ) {
            localInputHandleNames.add(name)
          }
          if (controlDepth === 0 && staticScalarExpression(value)) staticScalarNames.add(name)
          if (controlDepth === 0 && staticNonemptyIterable(value)) staticIterableNames.add(name)
          if (
            controlDepth === 0 &&
            ((isSymbol(value) && staticNamedIterableNames.has(value.name)) ||
              knownNamedCollectionExpression(value))
          ) {
            staticNamedIterableNames.add(name)
          }
          if (copySources) {
            if (!copySources.length) copyOnModify.push(name)
            else copyOnModifyBindings.push({ target: name, sourceNames: copySources })
          }
          r6Summary = value ? summarizeR6(name, value) : null
          const callable = summarizeCallback(value)
          if (callable && controlDepth === 0) {
            const summary: NotebookDependencyTypeSummary = {
              name: `r-function:${name}:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`,
              kind: 'r-function',
              fields: [],
              methods: [callable]
            }
            functions.set(name, summary)
            typeSummaries.push(summary)
            typeBindings.push({ target: name, typeName: summary.name, argumentNames: [] })
            functionDefinition = true
          }
          constructed = value ? constructorType(value) : null
          if (r6Summary) typeSummaries.push(r6Summary)
          else if (constructed) {
            if (constructed === 'data.table') addDataTableSummary()
            else if (constructed === 'openxlsx.Workbook') addOpenxlsxWorkbookSummary()
            else if (biocConstructors.has(constructed)) addBiocSummary(constructed)
            const constructorRoots = unique(
              (isCall(value) ? value.args : [])
                .map(rootName)
                .filter((item): item is string => Boolean(item))
            )
            typeBindings.push({
              target: name,
              typeName: constructed,
              argumentNames: constructorRoots
            })
          } else if (isSymbol(value)) {
            simpleAliasAssignment = true
            if (aliasedFunction && controlDepth === 0) functions.set(name, aliasedFunction)
            const source = value.name
            const canonical = aliases.get(source)
            const resolved = canonical ? canonical.source : source
            if (controlDepth > 0) addPossibleAlias(name, resolved)
            else aliases.set(name, { target: name, source: resolved, kind: 'possible-reference' })
          } else if (value) {
            const source = rootName(value)
            if (source) {
              const valueOp = callOperator(value)
              const access =
                valueOp && (valueOp === '[[' || valueOp === '[') ? 'subscript' : 'attribute'
              addPossibleAlias(name, source, access, memberName(value) ?? undefined)
            }
          }
        } else {
          staticStrings.delete(name)
          staticCollections.delete(name)
          used.push(name)
          mutated.push(name)
          if (value) updateCopyOnModifyMember(name, value)
          const replacementAccessor = biocReplacementAccessor(target)
          if (!replacementAccessor) {
            const member = memberName(target)
            memberWrites.push({ receiver: name, ...(member ? { member } : {}) })
          } else {
            const valueRoot = value ? rootName(value) : null
            receiverCalls.push({
              receiver: name,
              member: replacementAccessor,
              kind: 'generic',
              argumentNames: valueRoot ? [valueRoot] : []
            })
          }
          if (name === '.GlobalEnv' || name === '.BaseNamespaceEnv')
            unknown.push('dynamic-namespace')
          if (target) walkAssignmentTarget(target)
        }
      } else unknown.push('dynamic-assignment')
      if (!functionDefinition && !r6Summary && !constructed && !simpleAliasAssignment && value)
        walk(value, false)
      else if (constructed && value && isCall(value)) {
        const valueName = calledName(value)
        const valueQualified = qualifiedCall(value)
        const valueDependency = valueQualified
          ? `${valueQualified.package}::${valueQualified.name}`
          : valueName
        if (
          valueName &&
          (dataTableConstructors.has(valueName) ||
            valueName === 'copy' ||
            biocConstructors.has(valueName)) &&
          valueDependency
        ) {
          used.push(valueDependency)
          if (!defined.includes(valueDependency)) priorUsed.push(valueDependency)
          safeCallNames.push(valueDependency)
          if (valueName === 'fread') unknown.push('external-state')
        }
        if (dataTableQuery(value)) walkDataTableQuery(value)
        else {
          if (!callOperator(value)) {
            const constructorRoot = rootName(value.callee)
            if (constructorRoot) used.push(constructorRoot)
          }
          for (const arg of value.args) if (!isCharacter(arg)) walk(arg, false)
        }
      }
      if (used.length > usedBefore) {
        const assignmentReads = used.slice(usedBefore)
        const newPriorReads = assignmentReads.filter((item) => !definedBefore.includes(item))
        priorUsed.push(...newPriorReads.filter((item) => !priorUsed.includes(item)))
      }
      // Read-only functions may return an argument or a captured reference.
      // Preserve possible sharing; the projector can discharge ordinary R value copies.
      if (isSymbol(target) && isCall(value)) {
        const called = callOperator(value)
        const summary = called ? functions.get(called)?.methods[0] : undefined
        if (summary) {
          const sources = [
            ...value.args.map(rootName).filter((item): item is string => Boolean(item)),
            ...(summary.usedNames ?? []).filter((item) => !summary.safeCallNames?.includes(item))
          ]
          for (const source of unique(sources))
            if (source !== target.name) addPossibleAlias(target.name, source)
        }
      }
      return
    }
    if (op === 'assign') unknown.push('dynamic-assignment')
    if (
      op === 'save.image' ||
      (op === 'save' &&
        (namedArgument(expr, 'list') !== null || namedArgument(expr, 'envir') !== null))
    )
      unknown.push('dynamic-namespace')
    if (['get', 'eval', 'parse', 'substitute', 'do.call'].includes(op))
      unknown.push('dynamic-namespace')
    if (op === 'requireNamespace' && dependencyName) {
      const packageIndex = callbackArgumentIndex(expr, ['package'], [])
      const quietlyIndex = callbackArgumentIndex(expr, ['quietly'], ['package'])
      const packageExpr = expr.args[packageIndex]
      const pkg = isCharacter(packageExpr)
        ? packageExpr.value
        : isSymbol(packageExpr)
          ? staticStrings.get(packageExpr.name)
          : undefined
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      // Namespace loading is distinct from attaching exports. Only recognize known packages
      // with the default library search; custom lib.loc/versionCheck still need evidence.
      if (
        contractAvailable(op, qualified?.package, 'base') &&
        pkg &&
        knownNamespacePackages.has(pkg) &&
        expr.args.every((_, index) => index === packageIndex || index === quietlyIndex)
      )
        safeCallNames.push(dependencyName)
      else unknown.push('dynamic-namespace')
      for (const arg of expr.args) walk(arg, false)
      return
    }
    const valueConstructorPackage = readrColumnConstructors.has(op)
      ? 'readr'
      : R_PLOT_COMPOSITION_CONSTRUCTORS.get(op)
    if (valueConstructorPackage && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (contractAvailable(op, qualified?.package, valueConstructorPackage)) {
        safeCallNames.push(dependencyName)
        safeCallArgumentNames.push(
          ...expr.args.map(rootName).filter((name): name is string => Boolean(name))
        )
      } else unknown.push('opaque-call')
      for (const arg of expr.args) {
        // Constructor parameters are values, not a callback evaluation contract.
        if (
          (isCall(arg) && ['function', '~'].includes(callOperator(arg) ?? '')) ||
          (isSymbol(arg) && functions.has(arg.name))
        )
          unknown.push('opaque-call')
        walk(arg, false)
      }
      return
    }
    if (op === 'library' || op === 'require') {
      const pkg = staticPackageName(expr)
      if (pkg && knownAttachedPackages.has(pkg)) {
        if (expr.resolvedFunction === 'glue::attach' && controlDepth === 0) {
          defined.push('glue')
          typeSummaries.push(R_GLUE_FUNCTION)
          typeBindings.push({ target: 'glue', typeName: R_GLUE_FUNCTION.name, argumentNames: [] })
        }
        used.push(op)
        if (!defined.includes(op)) priorUsed.push(op)
        safeCallNames.push(op)
        return
      }
      unknown.push('dynamic-namespace')
    }
    if (['attach', 'detach', 'load', 'source', 'sys.source'].includes(op))
      unknown.push('dynamic-namespace')
    if (dataTableMutators.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      if (expr.args[0]) {
        const receiver = rootName(expr.args[0])
        if (!receiver) unknown.push('dynamic-assignment')
        else {
          used.push(receiver)
          if (!defined.includes(receiver)) priorUsed.push(receiver)
          mutated.push(receiver)
          if (op === 'setDT') {
            addDataTableSummary()
            typeBindings.push({ target: receiver, typeName: 'data.table', argumentNames: [] })
          } else if (op === 'setDF') {
            addDataFrameSummary()
            typeBindings.push({ target: receiver, typeName: 'data.frame', argumentNames: [] })
          }
          receiverCalls.push({
            receiver,
            member: dependencyName,
            kind: 'mutating',
            argumentNames: []
          })
        }
      }
      for (const arg of expr.args.slice(1)) walk(arg, false)
      return
    }
    if (qualified?.package === 'openxlsx' && openxlsxMutators.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      const receiver = rootName(namedArgument(expr, 'wb') ?? expr.args[0])
      if (!receiver) unknown.push('dynamic-assignment')
      else {
        used.push(receiver)
        if (!defined.includes(receiver)) priorUsed.push(receiver)
        mutated.push(receiver)
        receiverCalls.push({
          receiver,
          member: dependencyName,
          kind: 'mutating',
          argumentNames: unique(
            expr.args
              .slice(1)
              .map(rootName)
              .filter((name): name is string => Boolean(name))
          )
        })
      }
      for (const arg of expr.args.slice(1)) walk(arg, false)
      return
    }
    if (externalReadCalls.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      unknown.push('external-state')
      if (yamlReads.has(op) && yamlReadIsDynamic(expr))
        unknown.push('opaque-call', 'dynamic-namespace')
      const handleRoot = externalReadHandleRoot(expr)
      if (handleRoot) {
        if (localInputHandleNames.has(handleRoot)) mutated.push(handleRoot)
        else {
          possiblyMutated.push(handleRoot)
          unknown.push('opaque-mutation')
        }
      }
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op && R_GGPLOT_GEOMS.has(op)) {
      for (let index = 0; index < expr.args.length; index += 1) {
        const argument = expr.args[index]
        const name = expr.names[index]
        const callbackValue =
          (isCall(argument) && ['function', '~'].includes(callOperator(argument) ?? '')) ||
          (isSymbol(argument) && functions.has(argument.name))
        if (callbackValue && name !== 'formula') {
          if (!consumeCallback(argument, { phase: 'deferred', formulaParameters: ['.x'] }))
            unknown.push('opaque-call')
        }
        // These arguments can dispatch arbitrary extension code by name or ggproto object.
        if (name === 'stat' && !(isCharacter(argument) && R_GGPLOT_STATS.has(argument.value)))
          unknown.push('opaque-call')
        if (
          name === 'position' &&
          !(isCharacter(argument) && R_GGPLOT_POSITIONS.has(argument.value)) &&
          !(
            isCall(argument) &&
            R_GGPLOT_POSITION_CALLS.has(calledName(argument) ?? '') &&
            contractAvailable(calledName(argument)!, qualifiedCall(argument)?.package, 'ggplot2')
          )
        )
          unknown.push('opaque-call')
        if (name === 'key_glyph' && !callbackValue) unknown.push('opaque-call')
        if (name === 'distribution' && !callbackValue) unknown.push('opaque-call')
        if (
          name === 'geom' &&
          !(isCharacter(argument) && R_GGPLOT_GEOMS.has(`geom_${argument.value}`))
        )
          unknown.push('opaque-call')
        if (
          name === 'method' &&
          !(isCharacter(argument) && ['auto', 'lm', 'loess'].includes(argument.value))
        )
          unknown.push('opaque-call')
      }
    }
    if (op && ggplot2PositionScaleCalls.includes(op)) {
      for (const argument of expr.args) {
        if (consumeCallback(argument, { phase: 'deferred', formulaParameters: ['.x'] })) continue
        if (
          (isCall(argument) && ['function', '~'].includes(callOperator(argument) ?? '')) ||
          (isSymbol(argument) &&
            !['NULL', 'NA'].includes(argument.name) &&
            !literalLabelNames.has(argument.name) &&
            !staticScalarNames.has(argument.name) &&
            !staticIterableNames.has(argument.name))
        )
          unknown.push('opaque-call')
      }
    }
    const callback = op ? functionalCallbacks.get(op) : undefined
    if (op && callback && dependencyName) {
      if (callback.dataMask) {
        walkDataMask(expr, true)
        return
      }
      const resolvedCallbackIndex = callbackArgumentIndex(
        expr,
        callback.keywords,
        callback.precedingArguments
      )
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (
        contractAvailable(op, qualified?.package, callback.package) &&
        consumeCallback(expr.args[resolvedCallbackIndex], {
          phase: 'immediate',
          formulaParameters: callback.formulaParameters
        })
      ) {
        safeCallNames.push(dependencyName)
      } else unknown.push('function-scope', 'opaque-call')
      for (let index = 0; index < expr.args.length; index += 1) {
        if (index !== resolvedCallbackIndex) walk(expr.args[index], false)
      }
      return
    }
    if (op === 'function') {
      if (acceptedCallbacks.has(expr)) return
      unknown.push('function-scope')
      return
    }
    if (acceptedCallbacks.has(expr)) return
    if (op && functions.has(op) && !qualified) {
      const summary = functions.get(op)!
      used.push(op)
      if (!defined.includes(op)) priorUsed.push(op)
      mergeCallbackReads(summary.methods[0]!)
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (
      op &&
      !qualified &&
      (graphicsSafeCalls.includes(op) || baseLabelFormatCalls.includes(op)) &&
      !contractAvailable(
        op,
        undefined,
        baseLabelFormatCalls.includes(op)
          ? 'base'
          : baseGraphicsCalls.includes(op)
            ? 'graphics'
            : 'grDevices'
      )
    ) {
      unknown.push('opaque-call')
      used.push(op)
      if (!defined.includes(op)) priorUsed.push(op)
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op && graphicsSafeCalls.includes(op)) {
      for (const [index, argument] of expr.args.entries()) {
        // hist() can invoke a breaks function. Arbitrary callbacks need file and
        // evaluation evidence; merely reading their function name is insufficient.
        if (
          (isCall(argument) && ['function', '~'].includes(callOperator(argument) ?? '')) ||
          (isSymbol(argument) && functions.has(argument.name)) ||
          (['hist', 'hist.default'].includes(op) &&
            (expr.names[index] === 'breaks' || (index === 1 && !expr.names[index])) &&
            isSymbol(argument) &&
            !staticScalarNames.has(argument.name) &&
            !staticIterableNames.has(argument.name))
        )
          unknown.push('opaque-call')
      }
    }
    if (op === '$' || op === '@') {
      walk(expr.args[0], false)
      return
    }
    if (pipeOps.has(op) && expr.args.length >= 2) {
      walk(expr.args[0], false)
      const rhs = expr.args[1]
      const transformName = tabularTransformName(rhs)
      if (transformName && tabularTransform.has(transformName)) {
        const qualifiedRhs = qualifiedCall(rhs)
        const dependency = qualifiedRhs
          ? `${qualifiedRhs.package}::${qualifiedRhs.name}`
          : transformName
        used.push(dependency)
        if (!defined.includes(dependency)) priorUsed.push(dependency)
        safeCallNames.push(dependency)
        if (isCall(rhs)) walkTabularArguments(rhs, true)
        return
      }
      walk(rhs, false)
      return
    }
    if (modelMask.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (let index = 0; index < expr.args.length; index += 1) {
        if (expr.names[index] === 'data') walk(expr.args[index], false)
        else walkDataMask(expr.args[index], true)
      }
      return
    }
    if (tabularTransformName(expr) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      walkTabularArguments(expr, false)
      return
    }
    if (dplyrValueCall(expr) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      safeCallArgumentNames.push(
        ...expr.args.map(rootName).filter((name): name is string => Boolean(name))
      )
      for (const argument of expr.args) walk(argument, false)
      return
    }
    if (dataMaskCalls.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (const arg of expr.args) walkDataMask(arg, true, 'deferred')
      return
    }
    if (op === 'tribble' && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (const value of expr.args.filter((item) => !tribbleColumnDeclaration(item)))
        walk(value, false)
      return
    }
    if (
      op === 'for' &&
      expr.args.length >= 3 &&
      isSymbol(expr.args[0]) &&
      staticNonemptyIterable(expr.args[1]) &&
      deterministicLoopBody(expr.args[2])
    ) {
      const target = expr.args[0].name
      const characterValues = rStaticStringCollection(
        expr.args[1],
        staticStrings,
        staticCollections
      )
      walk(expr.args[1], false)
      prepareAssignment(target)
      if (characterValues?.values.length) characterLoopNames.add(target)
      defined.push(target)
      const previous = localNames
      localNames = [...localNames, target]
      walk(expr.args[2], false)
      localNames = previous
      return
    }
    if (op === 'for' && expr.args.length >= 3 && isSymbol(expr.args[0])) {
      const target = expr.args[0].name
      const localAggregationNames = localAggregationLoops.get(expr)
      const localAggregation =
        localAggregationNames &&
        [...localAggregationNames].every(
          (name) =>
            defined.includes(name) &&
            !aliases.has(name) &&
            !possibleAliases.some((alias) => alias.target === name)
        )
      walk(expr.args[1], false)
      if (localAggregation) {
        const previous = localNames
        localNames = [...localNames, target]
        localAggregationDepth += 1
        walk(expr.args[2], false)
        localAggregationDepth -= 1
        localNames = previous
        return
      }
      controlDepth += 1
      prepareAssignment(target)
      defined.push(target)
      const previous = localNames
      localNames = [...localNames, target]
      walk(expr.args[2], false)
      localNames = previous
      controlDepth -= 1
      const iterable = expr.args[1]
      const iterableCall = calledName(iterable)
      const iterableQualified = qualifiedCall(iterable)
      // Base sequence constructors return value vectors even when empty. Keep
      // the loop's assignments conditional, but do not taint unrelated results.
      const baseSequence =
        isCall(iterable) &&
        ['seq_len', 'seq_along'].includes(iterableCall ?? '') &&
        contractAvailable(iterableCall!, iterableQualified?.package, 'base')
      const iterableIsValue =
        (isSymbol(iterable) && copyOnModify.includes(iterable.name)) ||
        (isCall(iterable) && callOperator(iterable) === 'names') ||
        baseSequence
      if (iterableIsValue) {
        for (const name of isolatedConditionalLoops.get(expr) ?? []) {
          if (conditionallyDefined.has(name)) isolatedConditionallyDefined.add(name)
        }
      }
      return
    }
    if (op === 'if' && localAggregationDepth > 0) {
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op === 'if' && expr.args[0]?.kind === 'atomic' && expr.args[0].logical !== undefined) {
      walk(expr.args[0], false)
      walk(expr.args[expr.args[0].logical ? 1 : 2], false)
      return
    }
    if (['if', 'for', 'while', 'repeat', 'switch'].includes(op)) {
      unknown.push('control-flow')
      controlDepth += 1
      for (const arg of expr.args) walk(arg, false)
      controlDepth -= 1
      return
    }
    const syntaxOps = [
      '{',
      '(',
      'if',
      'for',
      'while',
      'repeat',
      '+',
      '-',
      '*',
      '/',
      '^',
      ':',
      '::',
      ':::',
      '[[',
      '[',
      '!',
      '&',
      '&&',
      '|',
      '||',
      '<',
      '>',
      '<=',
      '>=',
      '==',
      '!='
    ]
    if (!syntaxOps.includes(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
    }
    const roots = unique(expr.args.map(rootName).filter((name): name is string => Boolean(name)))
    if (
      (safeCalls.has(op) || (qualified?.package === 'fs' && qualified.name === 'path')) &&
      dependencyName
    ) {
      safeCallNames.push(dependencyName)
      safeCallArgumentNames.push(...roots)
    } else if (
      !syntaxOps.includes(op) &&
      !['assign', 'get', 'eval', 'parse', 'substitute', 'do.call'].includes(op)
    ) {
      if (roots.length) {
        // Isolating conditional loop bindings does not prove the effects of an
        // unresolved call on them; retain that barrier when dropping control-flow.
        if (controlDepth > 0 && roots.some((name) => localNames.includes(name)))
          unknown.push('opaque-call')
        receiverCalls.push({
          receiver: roots[0]!,
          member: op,
          kind: 'generic',
          argumentNames: roots
        })
      } else unknown.push('opaque-call')
    }
    for (const arg of expr.args) walk(arg, false)
  }

  for (const expr of expressions) walk(expr, false)
  const combinedAliases: NotebookDependencyAlias[] = [
    ...[...aliases.values()].map((alias) => ({
      target: alias.target,
      source: alias.source,
      kind: alias.kind
    })),
    ...possibleAliases
  ]
  const facts = {
    definedNames: unique(defined).sort(),
    conditionallyDefinedNames: [...conditionallyDefined].sort(),
    usedNames: unique(used).sort(),
    priorUsedNames: unique(priorUsed).sort(),
    possiblyUsedNames: unique(possiblyUsed).sort(),
    mutatedNames: unique(mutated).sort(),
    possiblyMutatedNames: unique(possiblyMutated).sort(),
    aliases: combinedAliases,
    copyOnModifyNames: unique(copyOnModify).sort(),
    copyOnModifyBindings,
    copyOnModifyInvalidatedNames: unique(copyOnModifyInvalidated).sort(),
    safeCallNames: unique(safeCallNames).sort(),
    safeCallArgumentNames: unique(safeCallArgumentNames).sort(),
    typeSummaries,
    typeBindings,
    receiverCalls,
    memberWrites
  }
  const reasons = new Set(unknown)
  if (
    conditionallyDefined.size > 0 &&
    isolatedConditionallyDefined.size > 0 &&
    [...conditionallyDefined].every((name) => isolatedConditionallyDefined.has(name)) &&
    possiblyMutated.length === 0 &&
    possibleAliases.length === 0
  ) {
    reasons.delete('control-flow')
  }
  if (reasons.size) return { state: 'unknown', reasons: [...reasons].sort(), ...facts }
  return { state: 'available', ...facts }
}

const rQualifiedCall = (expr: RExpr): { package: string; name: string } | undefined => {
  if (!isCall(expr)) return undefined
  if (!isCall(expr.callee) || !['::', ':::'].includes(expr.callee.operator ?? '')) return undefined
  const pkg = expr.callee.args[0]
  const member = expr.callee.args[1]
  const packageName = isSymbol(pkg) ? pkg.name : isCharacter(pkg) ? pkg.value : undefined
  const name = isSymbol(member) ? member.name : isCharacter(member) ? member.value : undefined
  return packageName && name ? { package: packageName, name } : undefined
}

const rCalledName = (expr: RExpr): string | undefined => {
  if (!isCall(expr)) return undefined
  return isSymbol(expr.callee) ? expr.callee.name : rQualifiedCall(expr)?.name
}

// Share argument matching between scalar paths, vector paths and loop-shape analysis.
// In particular, file.path's fsep is a control argument, never a path component.
const rStringCombination = (
  expr: Extract<RExpr, { kind: 'call' }>
): { parts: RExpr[]; separator: RExpr } | undefined => {
  const name = rCalledName(expr)
  const qualified = rQualifiedCall(expr)
  const fsPath = qualified?.package === 'fs' && name === 'path'
  if (
    !fsPath &&
    (!['file.path', 'paste', 'paste0'].includes(name ?? '') ||
      (qualified && qualified.package !== 'base'))
  )
    return undefined
  const separatorName = name === 'file.path' ? 'fsep' : name === 'paste' ? 'sep' : undefined
  const separators = expr.names.flatMap((name, index) =>
    name && name === separatorName ? [index] : []
  )
  if (
    separators.length > 1 ||
    expr.names.some((candidate) => candidate && candidate !== separatorName)
  )
    return undefined
  const separatorIndex = separators[0] ?? -1
  return {
    parts: expr.args.filter((_argument, index) => index !== separatorIndex),
    separator: expr.args[separatorIndex] ?? {
      kind: 'character',
      value: name === 'file.path' || fsPath ? '/' : name === 'paste' ? ' ' : ''
    }
  }
}

const rPathPartArgument = (
  expr: Extract<RExpr, { kind: 'call' }>
): { name: 'basename' | 'dirname'; argument: RExpr } | undefined => {
  const name = rCalledName(expr)
  const qualified = rQualifiedCall(expr)
  if (
    (name !== 'basename' && name !== 'dirname') ||
    (qualified && qualified.package !== 'base') ||
    expr.args.length !== 1 ||
    (expr.names[0] && expr.names[0] !== 'path')
  )
    return undefined
  return { name, argument: expr.args[0]! }
}

const rLexicalPathPart = (path: string, name: 'basename' | 'dirname'): string | undefined => {
  // Tilde expansion needs the user's home; backslash interpretation depends on the
  // R host OS. Neither can be guessed by this platform-independent static parser.
  if (path.startsWith('~') || path.includes('\\')) return undefined
  const trimmed = path.replace(/\/+$/u, '')
  if (!trimmed) return name === 'dirname' && path ? '/' : ''
  const separator = trimmed.lastIndexOf('/')
  if (name === 'basename') return trimmed.slice(separator + 1)
  return separator < 0 ? '.' : trimmed.slice(0, separator).replace(/\/+$/u, '') || '/'
}

// These primitives construct language objects without evaluating their arguments.
// Keep this boundary shared by variable analysis and file discovery: plotmath symbols
// and calls inside quoted data are neither namespace reads nor file operations.
const rQuotedDataCall = (
  expr: RExpr | null | undefined
): { name: string; dependency: string; qualified: boolean } | undefined => {
  if (!expr || !isCall(expr)) return undefined
  const name = rCalledName(expr)
  const qualified = rQualifiedCall(expr)
  if (
    !name ||
    !['expression', 'quote'].includes(name) ||
    (qualified && qualified.package !== 'base')
  )
    return undefined
  return { name, dependency: qualified ? `base::${name}` : name, qualified: Boolean(qualified) }
}

const R_GLUE_FUNCTION: NotebookDependencyTypeSummary = {
  name: 'glue::glue',
  kind: 'r-function',
  fields: [],
  // Only the template-aware analysis below can certify an invocation. An arbitrary
  // call through a callback/alias must not inherit a blanket "pure function" claim.
  methods: [{ name: '__call__', effect: 'unknown', unknownScope: 'namespace' }]
}

// Track shadowed static helpers and attached glue in statement order, reusing the
// existing R bindings. No new persistent import/package registry is needed.
const resolveRStaticCallIdentities = (
  expressions: RExpr[],
  functions: NotebookSourceFileAccessContext['rFunctions'] = [],
  kernelNames: readonly string[] = []
): void => {
  const known = new Set(
    functions.filter(({ summary }) => summary.name === R_GLUE_FUNCTION.name).map(({ name }) => name)
  )
  const assigned = new Set(
    [...kernelNames, ...functions.map(({ name }) => name)].filter((name) => !known.has(name))
  )
  let dynamicBindings = false
  const visit = (expr: RExpr, attachAllowed: boolean): void => {
    if (!isCall(expr)) return
    const name = rCalledName(expr)
    const qualified = rQualifiedCall(expr)
    expr.staticBuiltinShadowed =
      !qualified && (dynamicBindings || Boolean(name && assigned.has(name)))
    if (['function', 'quote', 'expression', '~'].includes(name ?? '')) return
    if (['if', 'for', 'while', 'repeat', 'switch'].includes(name ?? '')) {
      const before = new Set(known)
      if (name === 'for' && isSymbol(expr.args[0])) {
        known.delete(expr.args[0].name)
        assigned.add(expr.args[0].name)
      }
      for (const argument of expr.args) visit(argument, false)
      // Preserve existing identities only if every visited branch left them intact;
      // a conditional alias/import cannot establish a new identity after the branch.
      for (const binding of known) if (!before.has(binding)) known.delete(binding)
      return
    }
    if (['<-', '=', '->', '<<-', '->>'].includes(name ?? '')) {
      const rightward = name === '->' || name === '->>'
      const target = expr.args[rightward ? 1 : 0]
      const value = expr.args[rightward ? 0 : 1]
      if (value) visit(value, false)
      if (isSymbol(target)) {
        const alias = isSymbol(value) && known.has(value.name)
        known.delete(target.name)
        assigned.add(target.name)
        if (alias) known.add(target.name)
      }
      return
    }
    if (name === 'library' || name === 'require') {
      const argument = expr.args[0]
      const pkg = isSymbol(argument)
        ? argument.name
        : isCharacter(argument)
          ? argument.value
          : undefined
      if (
        attachAllowed &&
        (!qualified || qualified.package === 'base') &&
        !assigned.has(name) &&
        pkg === 'glue' &&
        !assigned.has('glue') &&
        expr.args.length === 1 &&
        !expr.names.some(Boolean)
      ) {
        known.add('glue')
        expr.resolvedFunction = 'glue::attach'
      } else known.clear()
      return
    }
    if (
      ['detach', 'attach', 'source', 'sys.source', 'load', 'assign', 'rm', 'remove'].includes(
        name ?? ''
      )
    ) {
      known.clear()
      dynamicBindings = true
      return
    }
    if (!qualified && name && known.has(name)) expr.resolvedFunction = R_GLUE_FUNCTION.name
    const transparent = name === '{' || name === 'suppressPackageStartupMessages'
    for (const argument of expr.args) visit(argument, attachAllowed && transparent)
  }
  for (const expression of expressions) visit(expression, true)
}

const rIsGlueCall = (expr: RExpr): boolean => {
  if (!isCall(expr)) return false
  const qualified = rQualifiedCall(expr)
  return (
    expr.resolvedFunction === R_GLUE_FUNCTION.name ||
    (qualified?.package === 'glue' && qualified.name === 'glue')
  )
}

const rStaticGlueTemplate = (expr: RExpr): RStaticGluePart[] | undefined => {
  if (!isCall(expr)) return undefined
  if (!rIsGlueCall(expr) || expr.names.some((name) => name && name !== '.sep')) return undefined
  const separators = expr.names.flatMap((name, index) => (name === '.sep' ? [index] : []))
  if (separators.length > 1) return undefined
  const separator = separators.length
    ? expr.args[separators[0]!]
    : { kind: 'character' as const, value: '' }
  const templates = expr.args.filter((_argument, index) => index !== separators[0])
  if (!isCharacter(separator) || !templates.length || !templates.every(isCharacter))
    return undefined
  const template = templates.map((part) => part.value).join(separator.value)
  // glue dedents multi-line templates. Keep those unsupported until that lexical
  // transformation is modeled, rather than capture a subtly different filename.
  return /[\r\n]/u.test(template) ? undefined : parseRStaticGlueTemplate(template)
}

const renderRStaticGlue = (
  parts: readonly RStaticGluePart[],
  bindings: ReadonlyMap<string, string>
): string | undefined => {
  const values = parts.map((part) => (part.kind === 'text' ? part.value : bindings.get(part.value)))
  return values.some((value) => value === undefined) ? undefined : (values as string[]).join('')
}

type RStaticFileCollection = {
  values: readonly string[]
  entries?: ReadonlyArray<readonly [string, string]>
  rKind?: 'vector' | 'list'
}

const rContextCollections = (
  collections: NotebookSourceFileAccessContext['staticCollections'] = []
): Map<string, RStaticFileCollection> =>
  new Map(
    collections.map((collection) => [
      collection.name,
      {
        values: collection.values,
        rKind: collection.rKind,
        ...(collection.entries
          ? { entries: collection.entries.map(({ key, value }) => [key, value] as const) }
          : {})
      }
    ])
  )

const applyRStaticSprintf = (format: string, values: readonly string[]): string | undefined => {
  let result = ''
  let valueIndex = 0
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index]!
    if (character !== '%') {
      result += character
      continue
    }
    const conversion = format[index + 1]
    if (conversion === '%') {
      result += '%'
      index += 1
      continue
    }
    if (conversion !== 's' || valueIndex >= values.length) return undefined
    result += values[valueIndex++]!
    index += 1
  }
  return valueIndex === values.length ? result : undefined
}

const rStaticString = (
  expr: RExpr | null | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): string | undefined => {
  if (isCharacter(expr)) return expr.value
  if (isSymbol(expr)) {
    const collection = collections.get(expr.name)
    return (
      bindings.get(expr.name) ??
      (collection?.rKind === 'vector' && collection.values.length === 1
        ? collection.values[0]
        : undefined)
    )
  }
  if (!isCall(expr)) return undefined
  const name = rCalledName(expr)
  const glueTemplate = rStaticGlueTemplate(expr)
  if (glueTemplate) return renderRStaticGlue(glueTemplate, bindings)
  if (name === '$' && expr.args.length === 2 && isSymbol(expr.args[1])) {
    const member = expr.args[1].name
    const receiver = rStaticStringCollection(expr.args[0], bindings, collections)
    if (receiver?.rKind !== 'list') return undefined
    return receiver.entries?.find(([key]) => key === member)?.[1]
  }
  if (name === '[') {
    const selected = rStaticStringCollection(expr, bindings, collections)
    return selected?.rKind === 'vector' && selected.values.length === 1
      ? selected.values[0]
      : undefined
  }
  if (name === '[[' && expr.args.length === 2) {
    const collection = rStaticStringCollection(expr.args[0], bindings, collections)
    const index = expr.args[1]
    if (
      index?.kind === 'atomic' &&
      index.number !== undefined &&
      Number.isInteger(index.number) &&
      index.number > 0
    ) {
      return collection?.values[index.number - 1]
    }
    const key = rStaticString(expr.args[1], bindings, collections)
    return key === undefined
      ? undefined
      : collection?.entries?.find(([entry]) => entry === key)?.[1]
  }
  if (rStringCombination(expr) || rPathPartArgument(expr)) {
    const values = rStaticStringCollection(expr, bindings, collections)?.values
    return values?.length === 1 ? values[0] : undefined
  }
  if (name === 'sprintf') {
    if (
      !expr.args.length ||
      !expr.names.every((candidate, index) => !candidate || (index === 0 && candidate === 'fmt'))
    ) {
      return undefined
    }
    const format = rStaticString(expr.args[0], bindings, collections)
    const values = expr.args
      .slice(1)
      .map((argument) => rStaticString(argument, bindings, collections))
    return format === undefined || values.some((value) => value === undefined)
      ? undefined
      : applyRStaticSprintf(format, values as string[])
  }
  return undefined
}

const MAX_STATIC_FILE_LOOP_ITERATIONS = 128

type RStaticSubsetSelector =
  { kind: 'integer'; values: number[] } | { kind: 'logical'; values: boolean[] }

// Evaluate only bounded base-R selector syntax, never notebook code or callbacks.
const rStaticSubsetSelector = (
  expr: RExpr | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>,
  depth = 0
): RStaticSubsetSelector | undefined => {
  if (depth > 32) return undefined
  if (expr?.kind === 'atomic') {
    if (expr.logical !== undefined) return { kind: 'logical', values: [expr.logical] }
    if (expr.number !== undefined && Number.isSafeInteger(expr.number))
      return { kind: 'integer', values: [expr.number] }
  }
  if (!isCall(expr) || expr.staticBuiltinShadowed) return undefined
  const qualified = rQualifiedCall(expr)
  if (qualified && qualified.package !== 'base') return undefined
  const name = rCalledName(expr)
  if (expr.names.some(Boolean)) return undefined
  const evaluate = (value: RExpr | undefined): RStaticSubsetSelector | undefined =>
    rStaticSubsetSelector(value, bindings, collections, depth + 1)
  if (name === '(' && expr.args.length === 1) return evaluate(expr.args[0])
  if (name === 'c') {
    const result: Array<number | boolean> = []
    let integer = false
    for (const argument of expr.args) {
      const selector = evaluate(argument)
      if (!selector || result.length + selector.values.length > MAX_STATIC_FILE_LOOP_ITERATIONS)
        return undefined
      integer ||= selector.kind === 'integer'
      result.push(...selector.values)
    }
    return integer
      ? { kind: 'integer', values: result.map(Number) }
      : { kind: 'logical', values: result as boolean[] }
  }
  if (['-', '+', '!'].includes(name ?? '') && expr.args.length === 1) {
    const value = evaluate(expr.args[0])
    if (!value) return undefined
    if (name === '!') return { kind: 'logical', values: value.values.map((item) => !item) }
    return {
      kind: 'integer',
      values: value.values.map((item) => Number(item) * (name === '-' ? -1 : 1))
    }
  }
  let start = 1
  let length: number | undefined
  let step = 1
  if (name === ':' && expr.args.length === 2) {
    const left = evaluate(expr.args[0])
    const right = evaluate(expr.args[1])
    if (
      left?.kind !== 'integer' ||
      right?.kind !== 'integer' ||
      left.values.length !== 1 ||
      right.values.length !== 1
    )
      return undefined
    start = left.values[0]!
    const end = right.values[0]!
    length = Math.abs(end - start) + 1
    step = end < start ? -1 : 1
  } else if (name === 'seq_len' && expr.args.length === 1) {
    const value = evaluate(expr.args[0])
    if (value?.kind === 'integer' && value.values.length === 1) length = value.values[0]
  } else if (name === 'seq_along' && expr.args.length === 1) {
    length = rStaticStringCollection(expr.args[0], bindings, collections)?.values.length
  }
  if (length === undefined || length < 0 || length > MAX_STATIC_FILE_LOOP_ITERATIONS)
    return undefined
  return { kind: 'integer', values: Array.from({ length }, (_item, index) => start + index * step) }
}

const rStaticStringCollection = (
  expr: RExpr | null | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): RStaticFileCollection | undefined => {
  if (isSymbol(expr)) {
    const value = bindings.get(expr.name)
    return (
      collections.get(expr.name) ??
      (value === undefined ? undefined : { rKind: 'vector', values: [value] })
    )
  }
  if (!isCall(expr)) return undefined
  const name = rCalledName(expr)
  if (name === '[' && expr.args.length === 2 && expr.names.every((tag) => !tag)) {
    if (expr.staticBuiltinShadowed) return undefined
    const receiver = rStaticStringCollection(expr.args[0], bindings, collections)
    if (!receiver?.rKind) return undefined
    const index = expr.args[1]
    if (isCall(index) && index.staticBuiltinShadowed) return undefined
    const selectedKeys = rStaticStringCollection(index, bindings, collections)
    const scalarKey = rStaticString(index, bindings, collections)
    const keys =
      selectedKeys?.rKind === 'vector'
        ? selectedKeys.values
        : scalarKey === undefined
          ? undefined
          : [scalarKey]
    let offsets: number[]
    if (keys) {
      offsets = keys.map((key) => receiver.entries?.findIndex(([name]) => name === key) ?? -1)
    } else {
      const selector = rStaticSubsetSelector(index, bindings, collections)
      if (!selector) return undefined
      const numbers = selector.values.map(Number)
      if (selector.kind === 'logical') {
        const length = selector.values.length
          ? Math.max(receiver.values.length, selector.values.length)
          : 0
        if (length > MAX_STATIC_FILE_LOOP_ITERATIONS) return undefined
        offsets = Array.from({ length }, (_value, offset) => offset).filter(
          (offset) => selector.values[offset % selector.values.length]
        )
      } else if (numbers.some((value) => value < 0)) {
        if (numbers.some((value) => value > 0)) return undefined
        const excluded = new Set(numbers.map((value) => -value - 1))
        offsets = receiver.values
          .map((_value, offset) => offset)
          .filter((offset) => !excluded.has(offset))
      } else {
        offsets = numbers.filter((value) => value !== 0).map((value) => value - 1)
      }
    }
    if (
      offsets.length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
      offsets.some((offset) => receiver.values[offset] === undefined)
    )
      return undefined
    return {
      rKind: receiver.rKind,
      values: offsets.map((offset) => receiver.values[offset]!),
      ...(receiver.entries ? { entries: offsets.map((offset) => receiver.entries![offset]!) } : {})
    }
  }
  const vectorGroups = (
    expressions: readonly RExpr[]
  ): readonly (readonly string[])[] | undefined => {
    const groups = expressions.map((argument) => {
      const collection = rStaticStringCollection(argument, bindings, collections)?.values
      if (collection) return collection
      const scalar = rStaticString(argument, bindings, collections)
      return scalar === undefined ? undefined : [scalar]
    })
    if (!groups.length || groups.some((group) => !group?.length)) return undefined
    const staticGroups = groups as readonly (readonly string[])[]
    const length = Math.max(...staticGroups.map((group) => group.length))
    return length <= MAX_STATIC_FILE_LOOP_ITERATIONS &&
      staticGroups.every((group) => group.length === 1 || group.length === length)
      ? staticGroups
      : undefined
  }
  const glueTemplate = rStaticGlueTemplate(expr)
  if (glueTemplate) {
    const names = [
      ...new Set(glueTemplate.filter((part) => part.kind === 'binding').map((part) => part.value))
    ]
    if (!names.length)
      return { rKind: 'vector', values: [renderRStaticGlue(glueTemplate, bindings)!] }
    const groups = names.map((binding) => {
      const collection = collections.get(binding)?.values
      if (collection) return collection
      const scalar = bindings.get(binding)
      return scalar === undefined ? undefined : [scalar]
    })
    if (groups.some((group) => !group?.length)) return undefined
    const staticGroups = groups as readonly (readonly string[])[]
    const length = Math.max(...staticGroups.map((group) => group.length))
    if (
      length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
      staticGroups.some((group) => group.length !== 1 && group.length !== length)
    ) {
      return undefined
    }
    return {
      rKind: 'vector',
      values: Array.from({ length }, (_unused, index) =>
        renderRStaticGlue(
          glueTemplate,
          new Map(
            names.map((name, groupIndex) => [
              name,
              staticGroups[groupIndex]![staticGroups[groupIndex]!.length === 1 ? 0 : index]!
            ])
          )
        )!
      )
    }
  }
  if (name === 'setNames' || name === 'structure') {
    const qualified = rQualifiedCall(expr)
    const dataName = name === 'setNames' ? 'object' : '.Data'
    const namesName = name === 'setNames' ? 'nm' : 'names'
    // Extra attributes (notably class/dim) can change extraction and dispatch.
    if (
      expr.args.length !== 2 ||
      (qualified && qualified.package !== (name === 'setNames' ? 'stats' : 'base')) ||
      expr.names.some((tag) => tag && tag !== dataName && tag !== namesName) ||
      expr.names.filter(Boolean).length !== new Set(expr.names.filter(Boolean)).size
    )
      return undefined
    const namesIndex = expr.names.findIndex((candidate) => candidate === namesName)
    if (name === 'structure' && namesIndex < 0) return undefined
    const dataIndex = expr.names.indexOf(dataName)
    const selectedNamesIndex = namesIndex >= 0 ? namesIndex : dataIndex === 1 ? 0 : 1
    const namesExpression = expr.args[selectedNamesIndex]
    const data = rStaticStringCollection(expr.args[1 - selectedNamesIndex], bindings, collections)
    const values = data?.values
    const names = rStaticStringCollection(namesExpression, bindings, collections)?.values
    if (
      !values?.length ||
      !names ||
      values.length !== names.length ||
      names.some((candidate) => !candidate)
    ) {
      return undefined
    }
    return {
      rKind: data?.rKind,
      values,
      entries: values.map((value, index) => [names[index]!, value] as const)
    }
  }
  const pathPart = rPathPartArgument(expr)
  if (pathPart) {
    const groups = vectorGroups([pathPart.argument])
    if (!groups) return undefined
    const values = groups[0]!.map((path) => rLexicalPathPart(path, pathPart.name))
    return values.some((value) => value === undefined)
      ? undefined
      : { rKind: 'vector', values: values as string[] }
  }
  const combination = rStringCombination(expr)
  if (combination) {
    const separator = rStaticString(combination.separator, bindings, collections)
    const groups = vectorGroups(combination.parts)
    if (separator === undefined || !groups) return undefined
    const length = Math.max(...groups.map((group) => group.length))
    return {
      rKind: 'vector',
      values: Array.from({ length }, (_unused, index) =>
        groups.map((group) => group[group.length === 1 ? 0 : index]!).join(separator)
      )
    }
  }
  if (name === 'sprintf') {
    if (
      expr.args.length <= 1 ||
      !expr.names.every((candidate, index) => !candidate || (index === 0 && candidate === 'fmt'))
    ) {
      return undefined
    }
    const format = rStaticString(expr.args[0], bindings, collections)
    const groups = vectorGroups(expr.args.slice(1))
    if (format === undefined || !groups) return undefined
    const length = Math.max(...groups.map((group) => group.length))
    const values = Array.from({ length }, (_unused, index) =>
      applyRStaticSprintf(
        format,
        groups.map((group) => group[group.length === 1 ? 0 : index]!)
      )
    )
    return values.some((value) => value === undefined)
      ? undefined
      : { rKind: 'vector', values: values as string[] }
  }
  if (name !== 'c' && name !== 'list') return undefined
  const values = expr.args.map((argument) => rStaticString(argument, bindings, collections))
  if (
    values.length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
    values.some((value) => value === undefined)
  ) {
    return undefined
  }
  const staticValues = values as string[]
  const entries =
    expr.names.length === staticValues.length && expr.names.every(Boolean)
      ? staticValues.map((value, index) => [expr.names[index]!, value] as const)
      : undefined
  return {
    rKind: name === 'list' ? 'list' : 'vector',
    values: staticValues,
    ...(entries ? { entries } : {})
  }
}

const rStaticLoopValues = (
  expr: RExpr | null | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): string[] | undefined => {
  if (isSymbol(expr)) {
    const scalar = bindings.get(expr.name)
    if (scalar !== undefined) return [scalar]
  }
  if (isCall(expr) && rCalledName(expr) === 'names' && expr.args.length === 1) {
    return rStaticStringCollection(expr.args[0], bindings, collections)?.entries?.map(
      ([name]) => name
    )
  }
  return rStaticStringCollection(expr, bindings, collections)?.values.slice()
}

const rLiteralNamedKeys = (expr: RExpr | null | undefined): string[] | undefined => {
  if (!isCall(expr)) return undefined
  const name = rCalledName(expr)
  return (name === 'c' || name === 'list') &&
    expr.args.length > 0 &&
    expr.names.length === expr.args.length &&
    expr.names.every((key): key is string => Boolean(key))
    ? expr.names
    : undefined
}

// R matches named arguments before positional arguments. Both direct calls and
// wrapper summaries must use this rule, including options preceding the input.
const rFileCallArgument = (
  expr: Extract<RExpr, { kind: 'call' }>,
  effect: NotebookFileCallEffect
): RExpr | undefined => {
  const namedIndex = expr.names.findIndex((name) => name && effect.keywords.includes(name))
  return namedIndex >= 0
    ? expr.args[namedIndex]
    : effect.position === 0
      ? expr.args.find((_arg, index) => !expr.names[index])
      : !expr.names[effect.position]
        ? expr.args[effect.position]
        : undefined
}

// The supported write/connection options accept R's partial argument names. Exact
// names win; ignoring a supplied prefix would incorrectly activate a default mode.
const rOptionArgumentIndex = (names: readonly (string | null)[], parameter: string): number => {
  const exact = names.indexOf(parameter)
  return exact >= 0 ? exact : names.findIndex((name) => Boolean(name && parameter.startsWith(name)))
}

const rWriterDisposition = (
  expr: Extract<RExpr, { kind: 'call' }>,
  name: string,
  bindings: ReadonlyMap<string, string>
): 'replace' | 'update' | 'unknown' => {
  const option = notebookWriteOption('r', name)
  if (!option) return 'replace'
  const namedIndex = rOptionArgumentIndex(expr.names, option.keyword)
  const argument =
    namedIndex >= 0
      ? expr.args[namedIndex]
      : option.position === undefined || expr.names[option.position]
        ? undefined
        : expr.args[option.position]
  const value = !argument
    ? option.defaultValue
    : option.keyword === 'append'
      ? argument.kind === 'atomic'
        ? argument.logical
        : undefined
      : rStaticString(argument, bindings, new Map())
  return notebookWriteDisposition(option, value)
}

const rLocalFileWrappers = (
  expressions: RExpr[]
): {
  effects: Map<string, NotebookFileCallEffectSummary>
  names: Set<string>
  complete: boolean
} => {
  const effects = new Map<string, NotebookFileCallEffectSummary>()
  const names = new Set<string>()
  let complete = true
  for (const expr of expressions) {
    if (!isCall(expr) || !['<-', '='].includes(expr.operator ?? '')) continue
    const [target, value] = expr.args
    if (!isSymbol(target) || !isCall(value) || value.operator !== 'function') continue
    names.add(target.name)
    const formals = value.args[0]
    let body = value.args[1]
    if (isCall(body) && body.operator === '{' && body.args.length === 1) body = body.args[0]
    const name = rCalledName(body)
    const effect = name ? R_FILE_CALL_EFFECTS.get(name) : undefined
    const parameters = formals?.kind === 'formals' ? formals.names : []
    const argument = isCall(body) && effect ? rFileCallArgument(body, effect) : undefined
    const parameterIndex = isSymbol(argument) ? parameters.indexOf(argument.name) : -1
    if (
      !effect ||
      effect.additionalPaths?.length ||
      [
        'getGEO',
        'read_exposure_data',
        'read_outcome_data',
        'tximport',
        'readMSData',
        'Spectra',
        'read.FCS',
        'read.flowSet',
        'write.FCS'
      ].includes(name ?? '') ||
      parameterIndex < 0 ||
      (effect.kind === 'write' &&
        isCall(body) &&
        rWriterDisposition(body, name!, new Map()) !== 'replace')
    ) {
      complete = false
      continue
    }
    effects.set(target.name, {
      name: target.name,
      kind: effect.kind,
      position: parameterIndex,
      keywords: [parameters[parameterIndex]!],
      ...(effect.inputForm ? { inputForm: effect.inputForm } : {}),
      dependencyNames: isCall(body) && isSymbol(body.callee) ? [body.callee.name] : []
    })
  }
  return { effects, names, complete }
}

const rLoopHasEarlyExit = (expr: RExpr): boolean => {
  if (isSymbol(expr)) return expr.name === 'break' || expr.name === 'next'
  if (!isCall(expr) || expr.operator === 'function') return false
  return expr.args.some(rLoopHasEarlyExit)
}

const rScientificWriteTarget = (
  qualified: ReturnType<typeof rQualifiedCall>,
  path: string
): 'exact' | NotebookSourceFileWriteScope['kind'] | 'unsupported' => {
  if (qualified?.package === 'arrow' && qualified.name === 'write_dataset') return 'directory'
  if (qualified?.package === 'HDF5Array' && qualified.name === 'saveHDF5SummarizedExperiment') {
    return 'directory'
  }
  const lowerPath = path.toLocaleLowerCase('en-US')
  if (qualified?.package === 'sf' && qualified.name === 'st_write') {
    if (lowerPath.endsWith('.shp')) return 'shapefile'
    return ['.fgb', '.geojson', '.gpkg', '.kml', '.kmz'].some((suffix) =>
      lowerPath.endsWith(suffix)
    )
      ? 'exact'
      : 'unsupported'
  }
  if (qualified?.package === 'terra' && qualified.name === 'writeRaster') {
    return lowerPath.endsWith('.tif') || lowerPath.endsWith('.tiff') ? 'geotiff' : 'unsupported'
  }
  return 'exact'
}

const rInMemoryInput = (
  expr: RExpr | null | undefined,
  bindings: ReadonlySet<string>,
  shadowedNames: ReadonlySet<string>
): boolean => {
  if (isSymbol(expr)) return bindings.has(expr.name)
  if (!isCall(expr)) return false
  const name = rCalledName(expr)
  if (!name || !['I', 'rawConnection', 'textConnection'].includes(name)) return false
  const qualified = rQualifiedCall(expr)
  return qualified?.package === 'base' || (!qualified && !shadowedNames.has(name))
}

const analyzeRFileAccessTree = (
  root: Node,
  context?: NotebookSourceFileAccessContext
): NotebookSourceFileAccessExtraction => {
  const expressions = root.namedChildren.flatMap((child) => {
    const converted = convertR(child)
    return converted ? [converted] : []
  })
  resolveRStaticCallIdentities(expressions, context?.rFunctions, [
    ...(context?.resolvedKernelNames ?? []),
    ...(context?.staticStrings.map(({ name }) => name) ?? []),
    ...(context?.staticCollections.map(({ name }) => name) ?? [])
  ])
  const localWrappers = rLocalFileWrappers(expressions)
  const shadowedQuotationNames = new Set([
    ...localWrappers.names,
    ...(context?.resolvedKernelNames ?? []),
    ...(context?.staticStrings.map(({ name }) => name) ?? []),
    ...(context?.staticCollections.map(({ name }) => name) ?? []),
    ...(context?.rFunctions?.map(({ name }) => name) ?? []),
    ...(context?.localFileWrappers.map(({ name }) => name) ?? [])
  ])
  const bindings = new Map(context?.staticStrings.map(({ name, value }) => [name, value]) ?? [])
  const collections = rContextCollections(context?.staticCollections)
  const namedCollectionKeys = new Map(
    context?.staticCollections.flatMap((collection) =>
      collection.entries
        ? [[collection.name, collection.entries.map(({ key }) => key)] as const]
        : []
    ) ?? []
  )
  const contextualWrappers = new Map(
    context?.localFileWrappers.map((wrapper) => [wrapper.name, wrapper]) ?? []
  )
  const reads = new Set<string>()
  const writes = new Set<string>()
  const definitelyWritten = new Set<string>()
  const inMemoryInputs = new Set<string>()
  type FileConnection = { path: string; mode: string | undefined }
  const fileConnections = new Map<string, FileConnection>()
  const writeScopes = new Map<string, NotebookSourceFileWriteScope>()
  let unresolvedReads = false
  let unresolvedWrites = false
  let unsupportedExternalState = false
  let directoryStateRead = false
  let staticLoopIterations = 0
  let conditionalDepth = 0

  const fcsReadParameters = [
    'filename',
    'transformation',
    'which.lines',
    'alter.names',
    'column.pattern',
    'invert.pattern',
    'decades',
    'ncdf',
    'min.limit',
    'truncate_max_range',
    'dataset',
    'emptyValue',
    'channel_alias'
  ]
  const flowSetReadParameters = [
    'files',
    'path',
    'pattern',
    'phenoData',
    'descriptions',
    'name.keyword',
    'alter.names',
    'transformation',
    'which.lines',
    'column.pattern',
    'invert.pattern',
    'decades',
    'sep',
    'as.is',
    'name',
    'ncdf',
    'dataset',
    'min.limit',
    'truncate_max_range',
    'emptyValue',
    'ignore.text.offset',
    'channel_alias'
  ]
  const geoParameters = [
    'GEO',
    'filename',
    'destdir',
    'GSElimits',
    'GSEMatrix',
    'AnnotGPL',
    'getGPL',
    'parseCharacteristics'
  ]
  const connectionArgument = (
    expr: Extract<RExpr, { kind: 'call' }>,
    parameters: string[],
    parameter: string
  ): RExpr | undefined => {
    const named = rOptionArgumentIndex(expr.names, parameter)
    if (named >= 0) return expr.args[named]
    const remaining = parameters.filter((name) => rOptionArgumentIndex(expr.names, name) < 0)
    return expr.args.filter((_value, index) => !expr.names[index])[remaining.indexOf(parameter)]
  }

  const fileConnection = (expr: RExpr | null | undefined): FileConnection | undefined => {
    if (isSymbol(expr)) return fileConnections.get(expr.name)
    if (!isCall(expr)) return undefined
    const connectionName = rCalledName(expr)
    const connectionQualified = rQualifiedCall(expr)
    if (
      connectionName === 'gzcon' &&
      (!connectionQualified || connectionQualified.package === 'base') &&
      !localWrappers.names.has(connectionName)
    ) {
      const named = expr.names.indexOf('con')
      return fileConnection(expr.args[named >= 0 ? named : 0])
    }
    if (
      !connectionName ||
      !['bzfile', 'file', 'gzfile', 'unz', 'xzfile'].includes(connectionName)
    ) {
      return undefined
    }
    if (
      (connectionQualified && connectionQualified.package !== 'base') ||
      (!connectionQualified && localWrappers.names.has(connectionName))
    ) {
      return undefined
    }
    const parameters =
      connectionName === 'unz' ? ['description', 'filename', 'open'] : ['description', 'open']
    const path = rStaticString(
      connectionArgument(expr, parameters, 'description'),
      bindings,
      collections
    )
    const modeArg = connectionArgument(expr, parameters, 'open')
    return path
      ? { path, mode: modeArg ? rStaticString(modeArg, bindings, collections) : '' }
      : undefined
  }
  const fileConnectionPath = (expr: RExpr | null | undefined): string | undefined =>
    fileConnection(expr)?.path

  const visit = (expr: RExpr): void => {
    if (!isCall(expr)) return
    const quoted = rQuotedDataCall(expr)
    if (quoted && (quoted.qualified || !shadowedQuotationNames.has(quoted.name))) return
    if (expr.operator === 'for') {
      const [variable, sequence, body] = expr.args
      if (sequence) visit(sequence)
      const namedSequence =
        isCall(sequence) &&
        rCalledName(sequence) === 'names' &&
        isSymbol(sequence.args[0]) &&
        sequence.args.length === 1
          ? namedCollectionKeys.get(sequence.args[0].name)
          : undefined
      const values = namedSequence ?? rStaticLoopValues(sequence, bindings, collections)
      if (
        isSymbol(variable) &&
        values &&
        body &&
        !rLoopHasEarlyExit(body) &&
        staticLoopIterations + values.length <= MAX_STATIC_FILE_LOOP_ITERATIONS
      ) {
        for (const value of values) {
          staticLoopIterations += 1
          bindings.set(variable.name, value)
          collections.delete(variable.name)
          namedCollectionKeys.delete(variable.name)
          visit(body)
        }
      } else if (body) {
        if (isSymbol(variable)) {
          bindings.delete(variable.name)
          collections.delete(variable.name)
          namedCollectionKeys.delete(variable.name)
        }
        conditionalDepth += 1
        visit(body)
        conditionalDepth -= 1
      }
      return
    }
    if (['if', 'while', 'repeat', 'switch'].includes(expr.operator ?? '')) {
      conditionalDepth += 1
      expr.args.forEach(visit)
      conditionalDepth -= 1
      return
    }
    if (['<-', '=', '->'].includes(expr.operator ?? '') && expr.args.length >= 2) {
      const left = expr.operator === '->' ? expr.args[1] : expr.args[0]
      const right = expr.operator === '->' ? expr.args[0] : expr.args[1]
      if (isCall(left)) {
        // R replacement assignment updates its root binding (ordinary vectors/lists copy on
        // modify). The old static value cannot describe the result of an arbitrary replacement.
        let receiver: RExpr | undefined = left
        while (isCall(receiver)) receiver = receiver.args[0]
        if (isSymbol(receiver)) {
          bindings.delete(receiver.name)
          collections.delete(receiver.name)
          namedCollectionKeys.delete(receiver.name)
          inMemoryInputs.delete(receiver.name)
          fileConnections.delete(receiver.name)
        }
      }
      if (isSymbol(left)) {
        shadowedQuotationNames.add(left.name)
        const value = rStaticString(right, bindings, collections)
        const namedValues =
          isCall(right) &&
          rCalledName(right) === 'names' &&
          isSymbol(right.args[0]) &&
          right.args.length === 1
            ? namedCollectionKeys.get(right.args[0].name)
            : undefined
        const collection =
          rStaticStringCollection(right, bindings, collections) ??
          (namedValues ? { values: namedValues } : undefined)
        const connectionPath = fileConnection(right)
        const namedKeys =
          rLiteralNamedKeys(right) ??
          (isSymbol(right) ? namedCollectionKeys.get(right.name) : undefined) ??
          collection?.entries?.map(([key]) => key)
        if (conditionalDepth > 0 || !namedKeys) namedCollectionKeys.delete(left.name)
        else namedCollectionKeys.set(left.name, namedKeys)
        if (conditionalDepth > 0) {
          bindings.delete(left.name)
          collections.delete(left.name)
          inMemoryInputs.delete(left.name)
          fileConnections.delete(left.name)
        } else if (value !== undefined && !collection?.entries) {
          bindings.set(left.name, value)
          collections.delete(left.name)
          inMemoryInputs.delete(left.name)
          fileConnections.delete(left.name)
        } else if (collection) {
          bindings.delete(left.name)
          collections.set(left.name, collection)
          inMemoryInputs.delete(left.name)
          fileConnections.delete(left.name)
        } else if (rInMemoryInput(right, inMemoryInputs, localWrappers.names)) {
          bindings.delete(left.name)
          collections.delete(left.name)
          inMemoryInputs.add(left.name)
          fileConnections.delete(left.name)
        } else if (connectionPath) {
          bindings.delete(left.name)
          collections.delete(left.name)
          inMemoryInputs.delete(left.name)
          fileConnections.set(left.name, connectionPath)
        } else {
          bindings.delete(left.name)
          collections.delete(left.name)
          inMemoryInputs.delete(left.name)
          fileConnections.delete(left.name)
        }
      }
      if (!(isCall(right) && right.operator === 'function')) visit(right)
      return
    }
    const name = rCalledName(expr)
    const qualified = rQualifiedCall(expr)
    // Aliases share the same connection state. Explicit reopen/close must not leave
    // a stale append/replace mode behind for later consumers in this run.
    if (
      name &&
      ['open', 'close'].includes(name) &&
      (!qualified || qualified.package === 'base') &&
      !localWrappers.names.has(name)
    ) {
      const parameters = ['con', 'open']
      const connection = fileConnection(connectionArgument(expr, parameters, 'con'))
      if (connection) {
        if (name === 'close') connection.mode = undefined
        else if (connection.mode === '') {
          // R warns and leaves already-open connections unchanged. Only a known
          // unopened connection can acquire a new mode; conditional opens are uncertain.
          const modeArg = connectionArgument(expr, parameters, 'open')
          connection.mode =
            conditionalDepth === 0 && modeArg
              ? rStaticString(modeArg, bindings, collections)
              : undefined
        }
      }
    }

    const referenceOnlyCall =
      qualified?.package === 'openxlsx' &&
      [
        'addStyle',
        'addWorksheet',
        'createWorkbook',
        'deleteData',
        'freezePane',
        'mergeCells',
        'removeWorksheet',
        'renameWorksheet',
        'setColWidths',
        'setRowHeights',
        'writeData',
        'writeDataTable'
      ].includes(qualified.name)
    if (
      name &&
      R_DIRECTORY_STATE_CALLS.has(name) &&
      (qualified?.package === 'base' || (!qualified && !localWrappers.names.has(name)))
    ) {
      directoryStateRead = true
    }
    let call: NotebookFileCallEffect | undefined = name
      ? qualified
        ? R_FILE_CALL_EFFECTS.get(name)
        : (localWrappers.effects.get(name) ??
          (localWrappers.names.has(name)
            ? undefined
            : (contextualWrappers.get(name) ?? R_FILE_CALL_EFFECTS.get(name))))
      : undefined
    let fileArgumentOverride: { value: RExpr | undefined } | undefined
    if (
      name &&
      R_GRAPHICS_FILE_DEVICES.has(name) &&
      qualified?.package !== undefined &&
      qualified.package !== 'grDevices'
    )
      call = undefined
    if (call && ['read.FCS', 'read.flowSet', 'write.FCS'].includes(name ?? '')) {
      if (qualified && qualified.package !== 'flowCore') call = undefined
      else if (qualified || !localWrappers.names.has(name!)) {
        const parameters =
          name === 'read.FCS'
            ? fcsReadParameters
            : name === 'read.flowSet'
              ? flowSetReadParameters
              : ['x', 'filename', 'what', 'delimiter', 'endian']
        const option = (parameter: string): RExpr | undefined =>
          connectionArgument(expr, parameters, parameter)
        // A scalar event count samples the FCS using R's ambient RNG. Only an
        // explicit multi-event numeric selection can avoid that implicit state.
        const selection = name === 'write.FCS' ? undefined : option('which.lines')
        const selectionRange =
          isCall(selection) && selection.operator === ':' && selection.args.length === 2
            ? selection.args.map((arg) => (arg.kind === 'atomic' ? arg.number : undefined))
            : []
        const [firstEvent, lastEvent] = selectionRange
        const explicitEvents =
          firstEvent !== undefined &&
          lastEvent !== undefined &&
          Number.isFinite(firstEvent) &&
          Number.isFinite(lastEvent) &&
          Math.abs(lastEvent - firstEvent) >= 1
        // write.FCS also accepts disk-backed cytoframes. The destination is exact,
        // but the object's hidden backing files require runtime/type evidence.
        if (name === 'write.FCS') unsupportedExternalState = true
        if (!isNull(selection) && !explicitEvents) unsupportedExternalState = true
        if (
          expr.names.some(
            (key) =>
              key &&
              !parameters.some((parameter) => parameter.startsWith(key)) &&
              !(name === 'read.FCS' && key === 'ignore.text.offset')
          )
        )
          unsupportedExternalState = true
        const literalLocalPath = (value: string | undefined): value is string =>
          Boolean(value) &&
          value !== '-' &&
          value !== '/dev/stdin' &&
          !/^(?:[a-z][a-z0-9+.-]*:\/\/|\|)/iu.test(value!) &&
          !/[*?]/u.test(value!)
        if (name === 'read.flowSet') {
          const pathArg = option('path')
          const pathValue = !pathArg ? '.' : rStaticString(pathArg, bindings, collections)
          const path = literalLocalPath(pathValue) ? pathValue : undefined
          const phenotype = option('phenoData')
          const files = option('files')
          if (!isNull(phenotype)) {
            // Phenotype metadata overrides files, and its FCS_File column selects
            // additional inputs that cannot be inferred from the source alone.
            const metadata = rStaticString(phenotype, bindings, collections)
            if (path !== undefined && literalLocalPath(metadata)) {
              const input = path === '.' ? metadata : `${path}/${metadata}`
              if (!definitelyWritten.has(input)) reads.add(input)
            }
            unresolvedReads = true
          } else if (isNull(files) || path === undefined) {
            unresolvedReads = true
            if (isNull(files)) directoryStateRead = true
          } else {
            const scalar = rStaticString(files, bindings, collections)
            const paths =
              scalar === undefined
                ? rStaticStringCollection(files, bindings, collections)?.values
                : [scalar]
            if (
              !paths ||
              paths.length === 0 ||
              paths.length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
              paths.some((file) => !literalLocalPath(file))
            )
              unresolvedReads = true
            else
              for (const file of paths) {
                const input = path === '.' ? file : `${path}/${file}`
                if (!definitelyWritten.has(input)) reads.add(input)
              }
          }
          expr.args.forEach(visit)
          return
        }
        const filename = option('filename')
        const filenameValue = rStaticString(filename, bindings, collections)
        fileArgumentOverride = {
          value:
            name === 'read.FCS' && filenameValue !== undefined && !literalLocalPath(filenameValue)
              ? undefined
              : filename
        }
      }
    }
    if (qualified?.package === 'Spectra' && qualified.name === 'backendInitialize') {
      const object = connectionArgument(expr, ['object', 'files'], 'object')
      const backend = isCall(object) ? rQualifiedCall(object) : undefined
      if (backend?.package === 'Spectra' && backend.name === 'MsBackendMzR') {
        call = { kind: 'read', position: 1, keywords: ['files'], inputForm: 'paths' }
        fileArgumentOverride = { value: connectionArgument(expr, ['object', 'files'], 'files') }
        // Headers are read now; peak data and backend state remain lazy.
        unsupportedExternalState = true
      }
    } else if (qualified?.package === 'BiocFileCache' && qualified.name === 'bfcadd') {
      const parameters = ['x', 'rname', 'fpath']
      call = { kind: 'read', position: 2, keywords: ['fpath'] }
      fileArgumentOverride = {
        value:
          connectionArgument(expr, parameters, 'fpath') ??
          connectionArgument(expr, parameters, 'rname')
      }
      // Adding a local resource copies, moves, or references its existing bytes.
      // The cache database and resulting storage path cannot be certified here.
      unsupportedExternalState = true
    }
    if (call && ['tximport', 'readMSData', 'Spectra'].includes(name ?? '')) {
      const packageName = name === 'readMSData' ? 'MSnbase' : name
      if (qualified && qualified.package !== packageName) call = undefined
      else {
        // Other import modes can discover inferential replicates, annotations,
        // file-backed peaks, or user-supplied importers beyond the entry paths.
        const option = (key: string): RExpr | undefined => expr.args[expr.names.indexOf(key)]
        const txOut = option('txOut')
        const dropInfReps = option('dropInfReps')
        const type = option('type')
        const explicitSalmon =
          name === 'tximport' &&
          type?.kind === 'character' &&
          type.value === 'salmon' &&
          txOut?.kind === 'atomic' &&
          txOut.logical === true &&
          dropInfReps?.kind === 'atomic' &&
          dropInfReps.logical === true &&
          expr.names.filter((key) => !key).length <= 1 &&
          expr.names.every((key) => !key || ['files', 'type', 'txOut', 'dropInfReps'].includes(key))
        if (!explicitSalmon) unsupportedExternalState = true
      }
    }
    if (!call && qualified?.package === 'sf' && qualified.name === 'st_write') {
      call = { kind: 'write', position: 1, keywords: ['dsn'] }
    } else if (!call && qualified?.package === 'terra' && qualified.name === 'writeRaster') {
      call = { kind: 'write', position: 1, keywords: ['filename'] }
    } else if (
      !call &&
      qualified?.package === 'HDF5Array' &&
      qualified.name === 'saveHDF5SummarizedExperiment'
    ) {
      call = { kind: 'write', position: 1, keywords: ['dir'] }
    }
    if (call && ['read_exposure_data', 'read_outcome_data'].includes(name ?? '')) {
      // format_data can generate random IDs when the actual table lacks an ID
      // column. File names alone cannot prove the global RNG state is irrelevant.
      unsupportedExternalState = true
    }
    if (call && name === 'getGEO') {
      const getGPL = connectionArgument(expr, geoParameters, 'getGPL')
      const annotGPL = connectionArgument(expr, geoParameters, 'AnnotGPL')
      if (
        !(getGPL?.kind === 'atomic' && getGPL.logical === false) ||
        (annotGPL && !(annotGPL.kind === 'atomic' && annotGPL.logical === false))
      ) {
        unsupportedExternalState = true
      }
    }
    if (!call) {
      if (!referenceOnlyCall && name && isPotentialRFileWriteCall(name)) unresolvedWrites = true
    } else {
      if (qualified?.package === 'htmlwidgets' && qualified.name === 'saveWidget') {
        const selfContainedIndex = expr.names.findIndex(
          (candidate) => candidate === 'selfcontained'
        )
        if (
          selfContainedIndex >= 0 &&
          !(
            expr.args[selfContainedIndex]?.kind === 'atomic' &&
            expr.args[selfContainedIndex].logical === true
          )
        ) {
          unresolvedWrites = true
        }
      }
      const libraryFread =
        name === 'fread' &&
        (qualified?.package === 'data.table' || (!qualified && !localWrappers.names.has(name)))
      const textIndex = libraryFread
        ? expr.names.findIndex((candidate) => candidate === 'text')
        : -1
      const commandIndex = libraryFread
        ? expr.names.findIndex((candidate) => candidate === 'cmd')
        : -1
      // Match all required formals together: named arguments consume their slots
      // before unnamed arguments, regardless of the order used at the call site.
      const pathEffects = [call, ...(call.additionalPaths ?? [])]
      const unmatchedEffects = pathEffects.filter(
        (effect) => !expr.names.some((name) => name && effect.keywords.includes(name))
      )
      const positionalArgs = expr.args.filter((_arg, index) => !expr.names[index])
      const pathArgument = (effect: (typeof pathEffects)[number]): RExpr | undefined => {
        const namedIndex = expr.names.findIndex((name) => name && effect.keywords.includes(name))
        return namedIndex >= 0
          ? expr.args[namedIndex]
          : positionalArgs[unmatchedEffects.indexOf(effect)]
      }
      for (const effect of call.additionalPaths ?? []) {
        const extraArgument = pathArgument(effect)
        const extraPath =
          fileConnectionPath(extraArgument) ?? rStaticString(extraArgument, bindings, collections)
        if (!extraPath) unresolvedReads = true
        else if (!definitelyWritten.has(extraPath)) reads.add(extraPath)
      }
      const argument = fileArgumentOverride
        ? fileArgumentOverride.value
        : name === 'getGEO'
          ? connectionArgument(expr, geoParameters, 'filename')
          : call.additionalPaths?.length
            ? pathArgument(call)
            : rFileCallArgument(expr, call)
      if (!argument && call.pathOptional) return
      const inMemoryRead =
        call.kind === 'read' &&
        (textIndex >= 0 || rInMemoryInput(argument, inMemoryInputs, localWrappers.names))
      const acceptsMultiplePaths = call.inputForm === 'paths'
      if (call.kind === 'read' && !inMemoryRead && acceptsMultiplePaths) {
        const paths =
          rStaticStringCollection(argument, bindings, collections)?.values ??
          (isCall(argument) && ['list', 'c'].includes(rCalledName(argument) ?? '')
            ? argument.args.map(fileConnectionPath)
            : undefined)
        if (
          paths &&
          paths.length <= MAX_STATIC_FILE_LOOP_ITERATIONS &&
          paths.every((path): path is string => path !== undefined)
        ) {
          for (const path of paths) if (!definitelyWritten.has(path)) reads.add(path)
          expr.args.forEach(visit)
          return
        }
      }
      const path = inMemoryRead
        ? undefined
        : (fileConnectionPath(argument) ?? rStaticString(argument, bindings, collections))
      // A device path may be a printf page template or a shell pipe, not an
      // exact output filename. Do not publish either as confirmed file evidence.
      const graphicsFileDevice = Boolean(name && R_GRAPHICS_FILE_DEVICES.has(name))
      const devicePipe = graphicsFileDevice && path?.trimStart().startsWith('|')
      if (graphicsFileDevice && name === 'postscript') {
        const parameters = [
          'file',
          'onefile',
          'family',
          'title',
          'fonts',
          'encoding',
          'bg',
          'fg',
          'width',
          'height',
          'horizontal',
          'pointsize',
          'paper',
          'pagecentre',
          'print.it',
          'command'
        ]
        const printValue = connectionArgument(expr, parameters, 'print.it')
        if (printValue && !(printValue.kind === 'atomic' && printValue.logical === false)) {
          unsupportedExternalState = true
        }
        if (connectionArgument(expr, parameters, 'command') || path === '') {
          unsupportedExternalState = true
        }
        if (connectionArgument(expr, parameters, 'encoding')) {
          // Encoding files can be resolved through R's installation search path.
          // A supplied encoding requires evidence beyond the output path.
          unresolvedReads = true
        }
      }
      if (graphicsFileDevice && (devicePipe || (path?.includes('%') ?? false))) {
        unresolvedWrites = true
        if (devicePipe) unsupportedExternalState = true
        expr.args.forEach(visit)
        return
      }
      if (commandIndex >= 0) {
        unresolvedReads = true
        unsupportedExternalState = true
      } else if (!inMemoryRead) {
        if (!path) {
          if (call.kind === 'read') unresolvedReads = true
          else unresolvedWrites = true
        } else if (call.kind === 'write') {
          const target = rScientificWriteTarget(qualified, path)
          if (target === 'unsupported') {
            unresolvedWrites = true
          } else {
            const connection = fileConnection(argument)
            const disposition = connection
              ? connection.mode === ''
                ? 'replace'
                : notebookWriteDisposition({ keyword: 'mode', defaultValue: 'w' }, connection.mode)
              : rWriterDisposition(expr, name!, bindings)
            if (disposition === 'update' && !definitelyWritten.has(path)) reads.add(path)
            if (disposition === 'unknown') {
              unresolvedReads = true
              unresolvedWrites = true
            }
            writes.add(path)
            if (conditionalDepth === 0 && disposition !== 'unknown') definitelyWritten.add(path)
            if (target !== 'exact') {
              writeScopes.set(`${target}\0${path}`, { kind: target, path })
            }
          }
        } else if (!definitelyWritten.has(path)) {
          reads.add(path)
        }
      }
    }
    expr.args.forEach(visit)
  }
  expressions.forEach(visit)

  return {
    reads: [...reads].sort(),
    writes: [...writes].sort(),
    ...(writeScopes.size ? { writeScopes: [...writeScopes.values()] } : {}),
    unresolvedReads,
    unresolvedWrites,
    unsupportedExternalState,
    directoryStateRead,
    localFileWrappersComplete: localWrappers.complete,
    context: {
      staticStrings: [...bindings]
        .map(([name, value]) => ({ name, value }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      staticCollections: [...collections]
        .map(([name, collection]) => ({
          name,
          values: [...collection.values],
          ...(collection.rKind ? { rKind: collection.rKind } : {}),
          ...(collection.entries
            ? { entries: collection.entries.map(([key, value]) => ({ key, value })) }
            : {})
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      localFileWrappers: [...localWrappers.effects.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
      )
    }
  }
}

const analyzeRSources = async (
  sources: readonly string[],
  context?: NotebookSourceFileAccessContext
): Promise<NotebookRunDependencyFacts[]> => {
  const results: NotebookRunDependencyFacts[] = []
  for (const source of sources) {
    const parsed = await withParsedNotebookSource('r', source, (root) =>
      analyzeRSource(
        root,
        context?.localFileWrappers,
        context?.staticStrings,
        context?.staticCollections,
        context?.rFunctions,
        context?.resolvedKernelNames
      )
    )
    results.push(
      parsed.state === 'ok' ? parsed.value : { state: 'unknown', reasons: [parsed.reason] }
    )
  }
  return results
}

// Variable and file evidence share this invocation's tree; no AST survives the call.
const analyzeRNotebookSource = async (
  source: string,
  context?: NotebookSourceFileAccessContext,
  fileContextForFacts?: (
    facts: NotebookRunDependencyFacts
  ) => NotebookSourceFileAccessContext | undefined
): Promise<{
  facts: NotebookRunDependencyFacts
  fileAccess?: NotebookSourceFileAccessExtraction
}> => {
  const parsed = await withParsedNotebookSource('r', source, (root) => {
    const facts = analyzeRSource(
      root,
      context?.localFileWrappers,
      context?.staticStrings,
      context?.staticCollections,
      context?.rFunctions,
      context?.resolvedKernelNames
    )
    return {
      facts,
      fileAccess: analyzeRFileAccessTree(
        root,
        fileContextForFacts ? fileContextForFacts(facts) : context
      )
    }
  })
  return parsed.state === 'ok'
    ? parsed.value
    : { facts: { state: 'unknown', reasons: [parsed.reason] } }
}

const analyzeRFileAccesses = async (
  sources: readonly string[],
  context?: NotebookSourceFileAccessContext
): Promise<Array<NotebookSourceFileAccessExtraction | undefined>> => {
  const results: Array<NotebookSourceFileAccessExtraction | undefined> = []
  for (const source of sources) {
    const parsed = await withParsedNotebookSource('r', source, (root) =>
      analyzeRFileAccessTree(root, context)
    )
    results.push(parsed.state === 'ok' ? parsed.value : undefined)
  }
  return results
}

export { analyzeRFileAccesses, analyzeRSources, analyzeRNotebookSource }
