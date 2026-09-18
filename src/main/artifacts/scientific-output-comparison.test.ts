import { describe, it, expect } from 'vitest'
import { compareReproducedContent, validOutputComparisonReport } from './output-comparison'
import {
  DEFAULT_OUTPUT_COMPARISON_POLICY,
  type ScientificComparisonPolicy,
  type OutputComparisonReport
} from '../../shared/output-comparison'

const compare = async (
  expected: string,
  actual: string,
  scientific: ScientificComparisonPolicy
): Promise<OutputComparisonReport> =>
  (
    await compareReproducedContent({
      filename: 'results.csv',
      expected: Buffer.from(expected),
      actual: Buffer.from(actual),
      policy: { ...DEFAULT_OUTPUT_COMPARISON_POLICY, scientific }
    })
  ).report
const clusters: ScientificComparisonPolicy = {
  kind: 'cell-clusters',
  cellColumn: 'barcode',
  clusterColumn: 'cluster',
  minimumAdjustedRand: 1
}
const de: ScientificComparisonPolicy = {
  kind: 'differential-expression',
  geneColumn: 'gene',
  effectColumn: 'log2FoldChange',
  adjustedPColumn: 'padj',
  contrast: 'treated / control',
  adjustedPThreshold: 0.05,
  minimumAbsoluteEffect: 1,
  minimumGeneJaccard: 1,
  minimumDirectionAgreement: 1
}
describe('scientific output criteria', () => {
  it('matches cells by exact barcode and ignores permutation of cluster labels', async () => {
    const report = await compare(
      'barcode,cluster\na,0\nb,0\nc,1\nd,1\n',
      'cluster,barcode\nB,d\nA,b\nB,c\nA,a\n',
      clusters
    )
    expect(report.outcome).toBe('different')
    expect(report.scientific).toMatchObject({
      outcome: 'meets-criteria',
      adjustedRand: 1,
      identifiers: 4
    })
  })
  it('detects changed partitions and never silently intersects cell sets', async () => {
    const a = 'barcode,cluster\na,0\nb,0\nc,1\nd,1\n'
    expect(
      (await compare(a, 'barcode,cluster\na,A\nb,B\nc,A\nd,B\n', clusters)).scientific
    ).toMatchObject({ adjustedRand: -0.5, outcome: 'does-not-meet' })
    expect(
      (await compare(a, 'barcode,cluster\na,0\nb,0\nc,1\ne,1\n', clusters)).scientific
    ).toMatchObject({ missingIdentifiers: 1, addedIdentifiers: 1, outcome: 'does-not-meet' })
    expect(
      (await compare(a, 'barcode,cluster\na,0\na,0\nc,1\nd,1\n', clusters)).scientific?.outcome
    ).toBe('unavailable')
  })
  it('handles degenerate partitions and strict leading-zero identities', async () => {
    expect(
      (await compare('barcode,cluster\n01,x\n02,y\n', 'barcode,cluster\n01,9\n02,8\n', clusters))
        .scientific?.adjustedRand
    ).toBe(1)
    expect(
      (await compare('barcode,cluster\n01,x\n02,x\n', 'barcode,cluster\n01,z\n02,z\n', clusters))
        .scientific?.adjustedRand
    ).toBe(1)
    expect(
      (await compare('barcode,cluster\n01,x\n02,x\n', 'barcode,cluster\n1,z\n2,z\n', clusters))
        .scientific?.outcome
    ).toBe('does-not-meet')
  })
  it('compares significant gene sets and effect direction under explicit thresholds', async () => {
    const a = 'gene,log2FoldChange,padj\nENSG1,2,0.001\nENSG2,-3,0.01\nENSG3,0.1,0.8\n'
    const b = 'gene,log2FoldChange,padj\nENSG3,0.2,0.7\nENSG2,-2.9,0.009\nENSG1,2.1,0.002\n'
    const report = await compare(a, b, de)
    expect(report.scientific).toMatchObject({
      outcome: 'meets-criteria',
      geneJaccard: 1,
      directionAgreement: 1,
      commonSignificant: 2
    })
    expect(
      validOutputComparisonReport(report, report.expectedChecksum, report.actualChecksum)
    ).toBe(true)
    const tampered = structuredClone(report)
    tampered.scientific!.directionAgreement = 0
    expect(
      validOutputComparisonReport(tampered, report.expectedChecksum, report.actualChecksum)
    ).toBe(false)
    expect((await compare(a, b.replace('ENSG2,-2.9', 'ENSG2,2.9'), de)).scientific).toMatchObject({
      outcome: 'does-not-meet',
      directionAgreement: 0.5
    })
    expect((await compare(a, b.replace('0.009', '0.09'), de)).scientific).toMatchObject({
      outcome: 'does-not-meet',
      geneJaccard: 0.5
    })
  })
  it('preserves missingness and rejects absent evidence instead of claiming scientific agreement', async () => {
    const a = 'gene,log2FoldChange,padj\ng1,2,0.01\ng2,0,NA\n'
    expect((await compare(a, a.replace('g2,0,NA', 'g2,0,0.9'), de)).scientific).toMatchObject({
      outcome: 'does-not-meet',
      missingValueChanges: 1
    })
    expect((await compare(a, a.replace('0.01', 'bad'), de)).scientific?.outcome).toBe('unavailable')
    const empty = 'gene,log2FoldChange,padj\ng1,0,NA\ng2,0,0.9\n'
    expect((await compare(empty, empty, de)).scientific?.outcome).toBe('unavailable')
  })
})
