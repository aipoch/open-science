import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import * as parser from './dependency-analysis-parser'
import { analyzeNotebookCodeRisk } from './code-risk-analysis'
import {
  objectLoop162,
  objectLoop184,
  catalogPagination,
  fileMetadataPagination
} from './code-risk-budget-fixtures'

configureTestRuntimeMetadata()
const analyze = (
  source: string,
  history: string[] = []
): ReturnType<typeof analyzeNotebookCodeRisk> =>
  analyzeNotebookCodeRisk('repl', source, undefined, history)
const deletion = (risks: Awaited<ReturnType<typeof analyze>>): void => {
  expect(risks.some(({ operation }) => operation.includes('unlink'))).toBe(true)
  expect(risks.some(({ operation }) => operation.includes('unavailable'))).toBe(false)
}

describe('repeated JavaScript object allocation evidence', () => {
  it('keeps the two minimized reproduction sources unchanged', () => {
    expect(objectLoop162.length).toBe(162)
    expect(objectLoop184.length).toBe(184)
  })
  it.each([
    ['162-character loop', objectLoop162],
    ['184-character loop', objectLoop184],
    ['catalog pagination', catalogPagination],
    ['file metadata pagination', fileMetadataPagination],
    [
      'renamed bindings',
      objectLoop162.replaceAll('value', 'result').replaceAll('attempt', 'retry')
    ],
    [
      'different fields and parameters',
      objectLoop184.replace('page:p,size:100', 'offset:p,limit:25')
    ],
    ['no try/catch', objectLoop162.replace('try{', '{').replace('catch(e){value=null;}', '')],
    ['catch object', objectLoop162.replace('value=null;}', 'value={failed:true};}')]
  ])('converges under the unchanged work budget: %s', async (_, source) => {
    expect(await analyze(source)).toEqual([])
  })

  it.each([
    'fs.unlinkSync("target.txt")',
    'const action={run:fs.unlinkSync}; action.run("target.txt")',
    'const action={run(){fs.unlinkSync("target.txt")}}; action.run()',
    '["target.txt"].forEach(fs.unlinkSync)'
  ])('retains concrete deletion following ordinary object loops: %s', async (source) => {
    deletion(
      await analyze(
        objectLoop162.replace('return value;', '') + ';const fs=require("fs");' + source
      )
    )
  })

  it('retains filesystem-dependent overwrite evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'object-budget-'))
    try {
      await writeFile(join(directory, 'target.txt'), 'keep')
      const risks = await analyzeNotebookCodeRisk(
        'repl',
        objectLoop162.replace('return value;', '') +
          ';require("fs").writeFileSync("target.txt","new")',
        {
          workingDirectory: directory,
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: []
        }
      )
      expect(risks.some(({ operation }) => operation.includes('existing-file overwrite'))).toBe(
        true
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    'const obj={run:fn}; if(flag) saved=obj;',
    'const obj={run:fn}; const alias=obj; if(flag) saved=alias;',
    'const obj={run:fn}; if(flag) saved=obj.run;',
    'const obj={}; obj.run=fn; if(flag) saved=obj;',
    'const obj={}; obj.run=()=>fn("target.txt"); if(flag) saved=obj;',
    'const obj={run(){fn("target.txt")}}; if(flag) saved=obj;'
  ])('preserves old objects and callbacks across later allocations: %s', async (body) => {
    const script = `const fs=require("fs"); let saved;
      for(const fn of [fs.unlinkSync,fs.readFileSync]) { ${body} }
      ${body.includes('saved=obj.run') ? 'saved("target.txt")' : 'saved.run("target.txt")'}`
    deletion(await analyze(script))
  })

  describe('same-round updates and surviving old aliases', () => {
    it.each(['for(const i of [1,2])', 'for(let i=0;i<count;i++)', 'while(flag)'])(
      'strongly updates a fresh unaliased object in %s',
      async (loop) => {
        expect(
          await analyze(`const fs=require("fs"); ${loop} {
        const obj={run:fs.unlinkSync}; obj.run=fs.readFileSync; obj.run("target.txt");
      }`)
        ).toEqual([])
      }
    )
    it.each([
      'obj["run"]=fs.readFileSync; obj.run("target.txt");',
      'obj.run=()=>fs.readFileSync("target.txt"); obj.run();',
      'alias=obj; alias.run=fs.readFileSync; obj.run("target.txt");',
      'const sameRound=obj; obj.run=fs.readFileSync; sameRound.run("target.txt");',
      'let sameRound=obj; sameRound.run=fs.readFileSync; obj.run("target.txt");'
    ])('retains same-round safe updates: %s', async (update) => {
      expect(
        await analyze(`const fs=require("fs"); for(const i of [1,2]) {
        let alias=null; const obj={run:fs.unlinkSync}; ${update}
      }`)
      ).toEqual([])
    })
    it('ignores a later same-declaration alias still in the temporal dead zone', async () => {
      expect(
        await analyze(`const fs=require("fs"); for(const i of [1,2]) {
        const obj={run:fs.unlinkSync}, alias=obj; obj.run=fs.readFileSync; alias.run("target.txt");
      }`)
      ).toEqual([])
    })
    it.each(['let saved;', 'var saved;'])(
      'keeps cross-round outer aliases: %s',
      async (declaration) => {
        deletion(
          await analyze(`const fs=require("fs"); ${declaration}
        for(const fn of [fs.unlinkSync,fs.readFileSync]) {
          const obj={run:fn}; if(flag) saved=obj;
        } saved.run("target.txt");`)
        )
      }
    )
    it('keeps old objects stored in a nested container', async () => {
      deletion(
        await analyze(`const fs=require("fs"); const saved={};
        for(const fn of [fs.unlinkSync,fs.readFileSync]) {
          const obj={run:fn}; if(flag) saved.item=obj;
        } saved.item.run("target.txt");`)
      )
    })
    it('keeps an already initialized lexical alias to the old object', async () => {
      deletion(
        await analyze(`const fs=require("fs"); let saved;
        for(const fn of [fs.unlinkSync,fs.readFileSync]) {
          const earlier=saved; const obj={run:fn}; saved=obj;
          if(earlier) earlier.run("target.txt");
        }`)
      )
    })
    it('evaluates old-owner references before replacing the allocation', async () => {
      deletion(
        await analyze(`const fs=require("fs");
        for(const fn of [fs.unlinkSync,fs.readFileSync]) {
          var obj={run:fn, value:obj && obj.run("target.txt")};
        }`)
      )
    })
    it.each([
      `let saved,result; for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        { const obj={run:fn}; result=obj; const saved=null; }
        if(flag) saved=result; result=null;
      } saved.run("target.txt");`,
      `let obj,result; for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        { const obj={run:fn}; result=obj; }
        if(flag) obj=result; result=null;
      } obj.run("target.txt");`,
      `let saved,result; for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        { const saved=null; const obj={run:fn}; result=obj; }
        if(flag) saved=result; result=null;
      } saved.run("target.txt");`,
      `let saved,result; for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        for(let saved of [null]) { const obj={run:fn}; result=obj; }
        if(flag) saved=result; result=null;
      } saved.run("target.txt");`,
      `let saved,result; for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        try { throw null; } catch(saved) { const obj={run:fn}; result=obj; }
        if(flag) saved=result; result=null;
      } saved.run("target.txt");`
    ])('retains shadowed outer aliases restored at block exit: %s', async (source) => {
      deletion(await analyze('const fs=require("fs");' + source))
    })
    it.each([
      `const root={inner:{}}; for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        const obj={run:fn}; if(flag)root.inner.item=obj;
      } root.inner.item.run("target.txt");`,
      `let saved; for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        const obj={run:fn}; obj.self=obj; if(flag)saved=obj;
      } saved.self.run("target.txt");`,
      `let saved; for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        const obj={run:fn}; const other={parent:obj}; obj.child=other; if(flag)saved=other;
      } saved.parent.run("target.txt");`
    ])('keeps nested and cyclic reachable object members: %s', async (source) => {
      deletion(await analyze('const fs=require("fs");' + source))
    })
    it('allows unconditional same-round safe replacement despite a saved alias', async () => {
      expect(
        await analyze(`const fs=require("fs"); let saved;
        for(const i of [1,2]) { const obj={run:fs.unlinkSync}; if(flag)saved=obj;
          obj.run=fs.readFileSync; obj.run("target.txt"); }
      `)
      ).toEqual([])
    })
    it('preserves an old alias retained by an exception prefix', async () => {
      deletion(
        await analyze(`const fs=require("fs"); let saved;
        try { for(const fn of [fs.unlinkSync,fs.readFileSync]) {
          const obj={run:fn}; if(flag) saved=obj; saved=null;
        } } catch(e) { saved.run("target.txt"); }`)
      )
    })
  })
  it('keeps captured arguments live while a later argument collects objects', async () => {
    const history = [
      { script: 'const fs=require("fs"); let obj={run:fs.unlinkSync};', incomplete: false }
    ]
    for (let repeat = 0; repeat < 2; repeat++)
      deletion(
        await analyzeNotebookCodeRisk(
          'repl',
          `Reflect.get(obj,"run",(()=>{obj=null; for(const i of [1]){const junk={};}})())("target.txt");`,
          undefined,
          history
        )
      )
  })
  it.each([
    `for(const v of [obj,(()=>{obj=null;for(const k of [1]){const junk={};}})()]) {
      if(v)v.run("target.txt"); }`,
    `for(const v of [null,obj]) { obj=null; for(const k of [1]){const junk={};}
      if(v)v.run("target.txt"); }`
  ])('keeps captured iterable elements live until every iteration: %s', async (script) => {
    const history = [
      { script: 'const fs=require("fs");let obj={run:fs.unlinkSync};', incomplete: false }
    ]
    for (let repeat = 0; repeat < 2; repeat++)
      deletion(await analyzeNotebookCodeRisk('repl', script, undefined, history))
  })
  it('leaves object-free triple loops within the original work budget', async () => {
    const objects = Array.from({ length: 20 }, (_, i) => `const c${i}={x:1,y:2,z:3};`).join('')
    const values = Array.from({ length: 16 }, (_, i) => i).join(',')
    expect(
      await analyze(`${objects}for(const i of [${values}]) {
      for(const j of [${values}]) { for(const k of [${values}]) {Math.abs(i+j+k);} }
    }`)
    ).toEqual([])
  })
  it('amortizes collection over scalar bindings as well as live objects', async () => {
    const scalars = Array.from({ length: 100 }, (_, i) => `const c${i}=${i};`).join('')
    const values = Array.from({ length: 16 }, (_, i) => i).join(',')
    expect(
      await analyze(`${scalars}for(const i of [${values}]) {
      for(const j of [${values}]) { const junk={x:1}; Math.abs(i+j); }
    }`)
    ).toEqual([])
  })
  it('amortizes transient allocation collection over a persistent object heap', async () => {
    const objects = Array.from({ length: 20 }, (_, i) => `const c${i}={x:1,y:2,z:3};`).join('')
    const values = Array.from({ length: 16 }, (_, i) => i).join(',')
    expect(
      await analyze(`${objects}for(const i of [${values}]) {
      for(const j of [${values}]) { const junk={x:1}; Math.abs(i+j); }
    }`)
    ).toEqual([])
  })
  it('does not repeatedly collect top-level objects in object-free nested loops', async () => {
    const objects = Array.from({ length: 400 }, (_, i) => `const c${i}={x:1,y:2,z:3};`).join('')
    const values = Array.from({ length: 16 }, (_, i) => i).join(',')
    expect(
      await analyze(`${objects}for(const i of [${values}]) {
      for(const j of [${values}]) { Math.abs(i+j); }
    }`)
    ).toEqual([])
  })
  it('analyzes method-heavy exception prefixes within the work budget', async () => {
    const source =
      'try{' +
      Array.from({ length: 80 }, (_, index) => `const o${index}={a(){},b(){},c(){}};`).join('') +
      '}catch(e){}'
    expect(await analyze(source)).toEqual([])
    const history = [{ script: source + '\n// cold replay', incomplete: false }]
    // First replay is cold; the second restores the completed replay snapshot.
    for (let repeat = 0; repeat < 2; repeat++)
      expect(await analyzeNotebookCodeRisk('repl', 'return 42;', undefined, history)).toEqual([])
  })
  it('retains the original work bound for incomplete method-heavy history', async () => {
    const source = (count: number): string =>
      'try{' +
      Array.from({ length: count }, (_, index) => `const o${index}={a(){},b(){},c(){}};`).join('') +
      '}catch(e){}'
    // The original analyzer already exhausts 100,000 steps at 80 objects with both the
    // catch prefix and incomplete-cell prefix. Object collection cannot waive it.
    expect(
      await analyzeNotebookCodeRisk('repl', 'return 42;', undefined, [
        { script: source(80), incomplete: true }
      ])
    ).toEqual([expect.objectContaining({ operation: 'code analysis unavailable' })])
    const history = [{ script: source(40), incomplete: true }]
    for (let repeat = 0; repeat < 2; repeat++)
      expect(await analyzeNotebookCodeRisk('repl', 'return 42;', undefined, history)).toEqual([])
  })

  it('preserves an older alias across conditional member updates', async () => {
    deletion(
      await analyze(`const fs=require("fs"); let saved;
      for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        const obj={run:fn}; if(flag) saved=obj; if(other) obj.run=fs.readFileSync;
      } saved.run("target.txt");`)
    )
  })
  it('lets duplicate literal keys replace earlier values without invoking them', async () => {
    expect(
      await analyze(`const fs=require("fs");
      for(let i=0;i<count;i++) {
        const obj={run(){fs.unlinkSync("target.txt")},run:fs.readFileSync};
        obj.run("target.txt");
      }`)
    ).toEqual([])
  })
  it('keeps older aliases visible while evaluating replacement properties', async () => {
    deletion(
      await analyze(`const fs=require("fs"); let saved;
      for(const fn of [fs.unlinkSync,fs.readFileSync]) {
        const obj={run:fn, value:saved && saved.run("target.txt")}; saved=obj;
      }`)
    )
  })
  it('evaluates property expressions on every repeated visit', async () => {
    deletion(
      await analyze(`const fs=require("fs");
      for(const fn of [fs.readFileSync,fs.unlinkSync]) { const obj={value:fn("target.txt")}; }`)
    )
  })
  it.each([false, true])(
    'separates same-position objects between scripts (warm cache=%s)',
    async (warm) => {
      const history = `const fs=require("fs"); const obj={run:fs.unlinkSync}; const saved=obj; // warm=${warm}`
      if (warm) expect(await analyze('return 0;', [history])).toEqual([])
      deletion(
        await analyze(
          'const fs=require("fs"); const obj={run:fs.readFileSync}; saved.run("target.txt");',
          [history]
        )
      )
    }
  )

  it('does not cache a genuinely exhausted source as a successful replay', async () => {
    const source = '0;'.repeat(50_001)
    const spy = vi.spyOn(parser, 'withParsedNotebookSource')
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        spy.mockClear()
        expect(await analyze('return 42;', [source])).toEqual([
          expect.objectContaining({ operation: 'code analysis unavailable' })
        ])
        expect(spy.mock.calls.some(([, script]) => script === source)).toBe(true)
      }
      expect(await analyze('return 42;')).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
  it('does not cache cancelled analysis as successful history', async () => {
    const source = objectLoop162 + '\n// cancellation regression'
    const controller = new AbortController()
    const pending = analyzeNotebookCodeRisk('repl', source, undefined, [], controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const spy = vi.spyOn(parser, 'withParsedNotebookSource')
    try {
      expect(await analyze('return 42;', [source])).toEqual([])
      expect(spy.mock.calls.some(([, script]) => script === source)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
