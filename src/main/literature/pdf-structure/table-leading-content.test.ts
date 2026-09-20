import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

it('recovers an underlined parent despite subpixel endpoint differences', () => {
  const table = {
    cropRect: [465, 174, 811, 270],
    structure: {
      objects: [
        { label: 'table column', rect: [142.0371, 31.0233, 220.345, 96] },
        { label: 'table row', rect: [10.5925, 87.0478, 329.3876, 96] },
        { label: 'table row', rect: [10.6414, 65.5268, 329.4252, 87.4177] },
        { label: 'table column', rect: [10.2716, 31.5985, 141.3124, 96] },
        { label: 'table row', rect: [10.5852, 31.5318, 329.509, 65.1959] },
        { label: 'table column', rect: [220.5492, 31.4216, 295.9588, 96] },
        { label: 'table column', rect: [296.6404, 30.8253, 329.6876, 96] },
        { label: 'table column header', rect: [10.6043, 31.4771, 329.4936, 65.308] }
      ]
    }
  }
  const items = [
    {
      text: '(proportion).',
      rect: [469.8424, 159.1624, 542.7028, 171.8647],
      height: 12.7023,
      baseline: 171.8647,
      horizontal: true
    },
    {
      text: 'Characteristic',
      rect: [475.455, 220.5423, 554.0384, 232.4976],
      height: 11.955300000000001,
      baseline: 232.4976,
      horizontal: true
    },
    {
      text: 'Block',
      rect: [618.1511, 183.2095, 650.0119, 195.1648],
      height: 11.955300000000001,
      baseline: 195.1648,
      horizontal: true
    },
    {
      text: 'p',
      rect: [771.1371, 205.6603, 778.9797, 217.6156],
      height: 11.955300000000001,
      baseline: 217.6156,
      horizontal: true
    },
    {
      text: 'value',
      rect: [771.1371, 220.5423, 802.3643, 232.4976],
      height: 11.955300000000001,
      baseline: 232.4976,
      horizontal: true
    },
    {
      text: 'Serratus',
      rect: [618.1511, 205.6603, 665.5419, 217.6156],
      height: 11.955300000000001,
      baseline: 217.6156,
      horizontal: true
    },
    {
      text: '(n',
      rect: [618.1511, 220.5423, 629.4727, 232.4976],
      height: 11.955300000000001,
      baseline: 232.4976,
      horizontal: true
    },
    {
      text: '=',
      rect: [631.5876, 220.5423, 638.3065, 232.4976],
      height: 11.955300000000001,
      baseline: 232.4976,
      horizontal: true
    },
    {
      text: '40)',
      rect: [640.517, 220.5423, 659.9205, 232.4976],
      height: 11.955300000000001,
      baseline: 232.4976,
      horizontal: true
    },
    {
      text: 'PECS 2',
      rect: [694.6877, 205.6603, 734.4594, 217.6156],
      height: 11.955300000000001,
      baseline: 217.6156,
      horizontal: true
    },
    {
      text: '(n',
      rect: [694.6877, 220.5423, 706.0094, 232.4976],
      height: 11.955300000000001,
      baseline: 232.4976,
      horizontal: true
    },
    {
      text: '=',
      rect: [708.1243, 220.5423, 714.8431, 232.4976],
      height: 11.955300000000001,
      baseline: 232.4976,
      horizontal: true
    },
    {
      text: '40)',
      rect: [716.9688, 220.5423, 736.3722, 232.4976],
      height: 11.955300000000001,
      baseline: 232.4976,
      horizontal: true
    },
    {
      text: 'Age; years',
      rect: [475.4562, 244.0129, 531.7692, 255.9682],
      height: 11.955300000000001,
      baseline: 255.9682,
      horizontal: true
    },
    {
      text: '57.9 (13.4)',
      rect: [618.1523, 244.0129, 674.2967, 255.9682],
      height: 11.955300000000001,
      baseline: 255.9682,
      horizontal: true
    },
    {
      text: '58.4 (12.7)',
      rect: [694.6889, 244.0129, 750.7485, 255.9682],
      height: 11.955300000000001,
      baseline: 255.9682,
      horizontal: true
    }
  ]
  const rules = [[618.1514959716797, 201.58650000715238, 750.7275, 201.58650000715238]]
  const result = refineTable(table, items, [], [], rules)
  expect(result.cells).toContainEqual(
    expect.objectContaining({ text: 'Block', row: 0, column: 1, colSpan: 2 })
  )
  expect(result.unassigned).not.toContain('Block')
})

it('recovers a ruled interval header without a model header prediction', () => {
  const table = {
    cropRect: [74, 354, 796, 440],
    structure: {
      objects: [
        { label: 'table column', rect: [457.6167, 35.4736, 552.5241, 86] },
        { label: 'table column', rect: [368.0293, 35.5238, 457.5812, 86] },
        { label: 'table row', rect: [13.8487, 55.8604, 706.1701, 84.0012] },
        { label: 'table column', rect: [12.5595, 35.4405, 278.3905, 86] },
        { label: 'table row', rect: [13.85, 35.6885, 706.1304, 56.0144] },
        { label: 'table column', rect: [553.5043, 35.396, 645.4346, 86] },
        { label: 'table column', rect: [645.9356, 35.4793, 705.7403, 86] },
        { label: 'table column', rect: [277.5666, 35.4277, 367.9064, 86] }
      ]
    }
  }
  const items = [
    {
      text: 'Table 5',
      rect: [85.0394, 331.4216, 130.8633, 346.3655],
      height: 14.9439,
      baseline: 346.3655,
      horizontal: true
    },
    {
      text: 'Factors associated with the amount of drainage',
      rect: [138.3592, 331.4216, 412.1539, 346.3655],
      height: 14.9439,
      baseline: 346.3655,
      horizontal: true
    },
    {
      text: 'b',
      rect: [375.5323, 359.8239, 383.0043, 374.7678],
      height: 14.9439,
      baseline: 374.7678,
      horizontal: true
    },
    {
      text: 'S.E. of',
      rect: [465.0777, 359.8239, 506.1256, 374.7678],
      height: 14.9439,
      baseline: 374.7678,
      horizontal: true
    },
    {
      text: 'b',
      rect: [511.084, 359.8239, 518.5559, 374.7678],
      height: 14.9439,
      baseline: 374.7678,
      horizontal: true
    },
    {
      text: 'p',
      rect: [564.8282, 359.8239, 571.822, 374.7678],
      height: 14.9439,
      baseline: 374.7678,
      horizontal: true
    },
    {
      text: 'value',
      rect: [576.8192, 359.8239, 607.2898, 374.7678],
      height: 14.9439,
      baseline: 374.7678,
      horizontal: true
    },
    {
      text: '95% CI for OR',
      rect: [653.6084, 359.8239, 749.6603, 374.7678],
      height: 14.9439,
      baseline: 374.7678,
      horizontal: true
    },
    {
      text: 'β',
      rect: [85.123, 388.2263, 93.372, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '-Glucan',
      rect: [93.372, 388.2263, 138.9001, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '-',
      rect: [375.5308, 388.2263, 387.202, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '1.295',
      rect: [387.1811, 388.2263, 418.8607, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '0.399',
      rect: [465.0777, 388.2263, 496.7572, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '0.002',
      rect: [564.8282, 388.2263, 596.4046, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '-',
      rect: [653.6084, 388.2263, 665.2796, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '2.085',
      rect: [665.3438, 388.2263, 696.9203, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '-',
      rect: [743.2389, 388.2263, 754.9101, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: '0.504',
      rect: [754.9744, 388.2263, 786.5508, 403.1702],
      height: 14.9439,
      baseline: 403.1702,
      horizontal: true
    },
    {
      text: 'Age',
      rect: [85.1215, 415.0984, 106.8948, 430.0423],
      height: 14.9439,
      baseline: 430.0423,
      horizontal: true
    },
    {
      text: '0.045',
      rect: [387.1796, 415.0984, 418.8592, 430.0423],
      height: 14.9439,
      baseline: 430.0423,
      horizontal: true
    },
    {
      text: '0.046',
      rect: [465.0762, 415.0984, 496.7557, 430.0423],
      height: 14.9439,
      baseline: 430.0423,
      horizontal: true
    },
    {
      text: '0.334',
      rect: [564.8267, 415.0984, 596.4031, 430.0423],
      height: 14.9439,
      baseline: 430.0423,
      horizontal: true
    },
    {
      text: '-',
      rect: [653.6069, 415.0984, 665.2781, 430.0423],
      height: 14.9439,
      baseline: 430.0423,
      horizontal: true
    },
    {
      text: '0.046',
      rect: [665.3424, 415.0984, 696.9188, 430.0423],
      height: 14.9439,
      baseline: 430.0423,
      horizontal: true
    },
    {
      text: '0.135',
      rect: [743.2374, 415.0984, 774.8139, 430.0423],
      height: 14.9439,
      baseline: 430.0423,
      horizontal: true
    }
  ]
  const rules = [
    [85.03950119018555, 356.14467260742185, 786.6134948730469, 356.14467260742185],
    [85.03950119018555, 384.76034948730467, 786.6134948730469, 384.76034948730467]
  ]
  const result = refineTable(table, items, [], [], rules)
  expect(result.grid[0]).toEqual(['', 'b', 'S.E. of b', 'p value', '95% CI for OR', ''])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ text: '95% CI for OR', colSpan: 2 })
  )
  expect(refineTable(table, items, [], [], []).grid[0][0]).toBe('β-Glucan')
})

it('includes an enclosed continuation record above the detector crop', () => {
  const table = {
    id: 'page-11-table-1',
    detection: {
      label: 'table',
      score: 0.8807575297931419,
      rect: [127.25495570898056, 146.74172669649124, 382.1017053723335, 232.46905249357224]
    },
    cropRect: [117, 136, 393, 243],
    structure: {
      objects: [
        {
          label: 'table column',
          score: 0.9992823367016761,
          rect: [9.689536571502686, 29.48682762682438, 159.4448103904724, 76.67521952092648]
        },
        {
          label: 'table column',
          score: 0.9690977902984058,
          rect: [187.90440845489502, 29.597649678587914, 263.5748791694641, 76.57814140617847]
        },
        {
          label: 'table row',
          score: 0.9932993923832065,
          rect: [9.325889825820923, 59.973627120256424, 263.0274431705475, 77.0507080256939]
        },
        {
          label: 'table',
          score: 0.9977578398545562,
          rect: [9.367082834243774, 29.592805817723274, 262.9722833633423, 76.51558576524258]
        }
      ],
      inputSize: [1000, 388],
      preprocessMs: 13,
      inferenceMs: 1137,
      memory: {
        rss: 978108416,
        heapTotal: 41484288,
        heapUsed: 24709040,
        external: 127565519,
        arrayBuffers: 121481117
      }
    },
    rowCount: 1,
    columnCount: 2,
    spans: [],
    grid: [['Months since cancer', '63.68 \u00b1 52.23']],
    unassigned: [
      'Targeted therapy (Herceptin, n = 118)',
      '9 (7.6%)',
      'Demographics',
      'Mean \u00b1 SD',
      'Age, y',
      '58.68 \u00b1 10.04'
    ]
  }
  const items = [
    {
      text: 'Hormone therapy (n = 182)',
      rect: [136.5, 123.07499999999982, 260.20500000000004, 134.32499999999982],
      height: 11.25,
      baseline: 134.32499999999982,
      horizontal: true
    },
    {
      text: '118 (64.8%)',
      rect: [326.250015, 123.07499999999982, 382.48876500000006, 134.32499999999982],
      height: 11.25,
      baseline: 134.32499999999982,
      horizontal: true
    },
    {
      text: 'Targeted therapy (Herceptin, n = 118)',
      rect: [136.5, 145.57499999999982, 306.5775, 156.82499999999982],
      height: 11.25,
      baseline: 156.82499999999982,
      horizontal: true
    },
    {
      text: '9 (7.6%)',
      rect: [334.687515, 145.57499999999982, 374.051265, 156.82499999999982],
      height: 11.25,
      baseline: 156.82499999999982,
      horizontal: true
    },
    {
      text: 'Demographics',
      rect: [125.25, 178.78312500000004, 194.6175, 190.03312500000004],
      height: 11.25,
      baseline: 190.03312500000004,
      horizontal: true
    },
    {
      text: 'Mean \u00b1 SD',
      rect: [327.42001500000003, 178.78312500000004, 381.330015, 190.03312500000004],
      height: 11.25,
      baseline: 190.03312500000004,
      horizontal: true
    },
    {
      text: 'Months since cancer',
      rect: [136.5, 201.07499999999993, 228.975, 212.32499999999993],
      height: 11.25,
      baseline: 212.32499999999993,
      horizontal: true
    },
    {
      text: '63.68 \u00b1 52.23',
      rect: [323.077515, 201.07499999999993, 385.67251500000003, 212.32499999999993],
      height: 11.25,
      baseline: 212.32499999999993,
      horizontal: true
    },
    {
      text: 'Age, y',
      rect: [136.5, 223.57499999999993, 166.4925, 234.82499999999993],
      height: 11.25,
      baseline: 234.82499999999993,
      horizontal: true
    },
    {
      text: '58.68 \u00b1 10.04',
      rect: [323.077515, 223.57499999999993, 385.67251500000003, 234.82499999999993],
      height: 11.25,
      baseline: 234.82499999999993,
      horizontal: true
    }
  ]
  const rules = [
    [314.8275146484375, 120, 314.8275146484375, 142.50424432754517],
    [116.25, 141.75, 315.58177185058594, 141.75],
    [117, 120, 117, 141.75424432754517],
    [393.9225082397461, 120, 393.9225082397461, 141.75424432754517],
    [314.82325744628906, 141.75, 394.6725082397461, 141.75],
    [314.8275146484375, 141.74575500015635, 314.8275146484375, 165.00424432754517],
    [116.25, 164.25, 315.58177185058594, 164.25],
    [117, 141.74575500015635, 117, 164.25424432754517],
    [393.9225082397461, 141.74575500015635, 393.9225082397461, 164.25424432754517],
    [314.82325744628906, 164.25, 394.6725082397461, 164.25],
    [314.8275146484375, 164.24575500015635, 314.8275146484375, 175.5042450428009],
    [116.25, 174.75, 315.58177185058594, 174.75],
    [117, 164.24575500015635, 117, 174.7542450428009],
    [393.9225082397461, 164.24575500015635, 393.9225082397461, 174.7542450428009],
    [314.82325744628906, 174.75, 394.6725082397461, 174.75],
    [314.8275146484375, 174.74575500015635, 314.8275146484375, 198.00424432754517],
    [116.25, 197.25, 315.58177185058594, 197.25],
    [117, 174.74575500015635, 117, 197.25424432754517],
    [393.9225082397461, 174.74575500015635, 393.9225082397461, 197.25424432754517],
    [314.82325744628906, 197.25, 394.6725082397461, 197.25],
    [314.8275146484375, 197.24575500015635, 314.8275146484375, 220.50424432754517],
    [116.25, 219.75, 315.58177185058594, 219.75],
    [117, 197.24575500015635, 117, 219.75424432754517],
    [393.9225082397461, 197.24575500015635, 393.9225082397461, 219.75424432754517],
    [314.82325744628906, 219.75, 394.6725082397461, 219.75],
    [314.8275146484375, 219.74575500015635, 314.8275146484375, 243],
    [116.25, 242.25, 314.83177185058594, 242.25],
    [117, 219.74575500015635, 117, 243],
    [393.9225082397461, 219.74575500015635, 393.9225082397461, 243],
    [314.82325744628906, 242.25, 394.6725082397461, 242.25]
  ]
  const result = refineTable(table, items, [], [], rules)
  expect(result.grid[0]).toEqual(['Hormone therapy (n = 182)', '118 (64.8%)'])
  expect(
    refineTable(
      table,
      items,
      [],
      [],
      rules.filter((r) => r[0] !== r[2])
    ).grid.flat()
  ).not.toContain('Hormone therapy (n = 182)')
})
