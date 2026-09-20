// Each reported cell gets a fresh session and analyzer cache, as in the external report.
export const stdlibReplayCases = [
  [
    'builtin open',
    "with open('result.txt', 'x', encoding='utf-8') as stream:\n    stream.write('6')"
  ],
  [
    'Path.open',
    "from pathlib import Path\nwith Path('result.txt').open('x', encoding='utf-8') as stream:\n    stream.write('6')"
  ],
  [
    'Decimal',
    "from decimal import Decimal\nvalue = Decimal('6')\nwith open('result.txt', 'x', encoding='utf-8') as stream:\n    stream.write(str(value))"
  ],
  [
    'defaultdict',
    "from collections import defaultdict\nvalues = defaultdict(int)\nvalues['x'] = 6\nwith open('result.txt', 'x', encoding='utf-8') as stream:\n    stream.write(str(values['x']))"
  ],
  [
    'plain int/dict/str',
    "value = 6\nvalues = {'x': value}\nwith open('result.txt', 'x', encoding='utf-8') as stream:\n    stream.write(str(values['x']))"
  ]
] as const
