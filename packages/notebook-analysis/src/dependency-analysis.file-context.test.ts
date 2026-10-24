import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Parser } from 'web-tree-sitter'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from './analysis-test-support'
import { NotebookDependencyAnalyzer, projectNotebookDependencies } from './analysis-test-support'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import type { NotebookSourceFileAccessContext } from './dependency-analysis-types'
import { projectNotebookFileContext, type FileContextEntry } from './dependency-file-context'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const roots: string[] = []
const analyzedPythonPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

describe('SciPy spectral and fitting content proof', () => {
  const setup =
    'import numpy as np\nfrom scipy import signal,optimize\nnp.save("cache.npy",np.array([1,2]))\ndef detrend(values):\n    open("cache.npy","w").write("changed")\n    return values\ndef model(x,a,b):\n    open("cache.npy","w").write("changed")\n    return a*x+b\ndef residual(x):\n    open("cache.npy","w").write("changed")\n    return x-np.array([2.,3.])\n'
  it.each([
    'signal.welch(np.array([1.,2.,3.,4.]),window="boxcar",nperseg=4,detrend=detrend)',
    'signal.welch(np.array([1.,2.,3.,4.]),1.,"boxcar",4,0,None,detrend)',
    'optimize.curve_fit(model,np.array([0.,1.,2.,3.]),np.array([1.,3.,5.,7.]))',
    'optimize.curve_fit(f=model,xdata=np.array([0.,1.,2.,3.]),ydata=np.array([1.,3.,5.,7.]))',
    'optimize.least_squares(residual,[0.,0.])',
    'optimize.least_squares(fun=residual,x0=[0.,0.])'
  ])('discards stale proof after %s', async (call) => {
    const source = setup + `result=${call}\nafter=np.load("cache.npy")`
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy'],
      externalState: 'partial'
    })
  })
})

describe('SciPy fitting callback boundaries', () => {
  const setup =
    'import numpy as np\nfrom scipy import signal,optimize\nnp.save("cache.npy",np.array([1,2]))\ndef residual(x):\n    open("cache.npy","w").write("changed")\n    return x-np.array([2.,3.])\n'
  it.each([
    'def jac(x,a,b):\n    open("cache.npy","w").write("changed")\n    return np.column_stack((x,np.ones_like(x)))\nresult=optimize.curve_fit(lambda x,a,b:a*x+b,np.array([0.,1.,2.]),np.array([1.,3.,5.]),jac=jac)',
    'def jac(x):\n    open("cache.npy","w").write("changed")\n    return np.eye(2)\nresult=optimize.least_squares(lambda x:x-np.array([2.,3.]),[0.,0.],jac=jac)',
    'def loss(z):\n    open("cache.npy","w").write("changed")\n    return np.vstack((z,np.ones_like(z),np.zeros_like(z)))\nresult=optimize.least_squares(lambda x:x-np.array([2.,3.]),[0.,0.],loss=loss)',
    'def progress(x):\n    open("cache.npy","w").write("changed")\nresult=optimize.least_squares(lambda x:x-np.array([2.,3.]),[0.,0.],callback=progress)',
    'def workers(fun,values):\n    open("cache.npy","w").write("changed")\n    return list(map(fun,values))\nresult=optimize.least_squares(lambda x:x-np.array([2.,3.]),[0.,0.],workers=workers)',
    'from scipy.optimize import least_squares as fit\nresult=fit(residual,[0.,0.])',
    'def calculate():\n    return optimize.least_squares(residual,[0.,0.])\nresult=calculate()'
  ])('discards proof through auxiliary callbacks, aliases and helpers: %s', async (call) => {
    const source = setup + call + '\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy'],
      externalState: 'partial'
    })
  })
  it.each([
    'signal.welch([1.,2.,3.,4.],nperseg=4)',
    'signal.welch([1.,2.,3.,4.],nperseg=4,detrend=False)',
    'signal.welch([1.,2.,3.,4.],nperseg=4,detrend="constant")',
    'signal.welch([1.,2.,3.,4.],nperseg=4,detrend="linear")',
    'signal.welch([1.,2.,3.,4.],1.,"boxcar",4,0,None,False)'
  ])('preserves proof for closed Welch detrending: %s', async (call) => {
    const source = setup + `result=${call}\nafter=np.load("cache.npy")`
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites).toHaveLength(1)
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })
  it.each([
    'signal.welch([1.,2.,3.,4.],**options)',
    'signal.welch(*arguments)',
    'signal.welch([1.,2.,3.,4.],detrend=unknown_detrend)'
  ])('keeps unresolved Welch options conservative: %s', async (call) => {
    const source = setup + `result=${call}\nafter=np.load("cache.npy")`
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual(['cache.npy'])
  })
  it('propagates registered fitting helper effects', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'from scipy.optimize import least_squares\ndef residual(x):\n    open("cache.npy","w").write("changed")\n    return x\ndef calculate():\n    return least_squares(residual,[1.])',
          exports: ['calculate']
        }
      ]
    }
    const source = setup + 'result=calculate()\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source, context)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect((await analyzeNotebookSourceFileAccess('python', source, context)).reads).toEqual([
      'cache.npy'
    ])
  })
  it.each([false, true])(
    'discards fitting-stale proof through cache reload (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [setup + 'result=optimize.least_squares(residual,[0.,0.])'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      const result = await analyzePythonNotebookSource('after=np.load("cache.npy")', context)
      expect(result.facts.typeBindings).not.toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
    }
  )
  it.each([
    'def calculate():\n    return optimize.least_squares(residual,[0.,0.])',
    'from scipy.optimize import least_squares as calculate\ndef calculate(*args):\n    return None\ncalculate(residual,[0.,0.])'
  ])('preserves proof for unused or rebound callbacks: %s', async (call) => {
    const result = await analyzePythonNotebookSource(setup + call + '\nafter=np.load("cache.npy")')
    expect(result.facts.serializedValueWrites).toHaveLength(1)
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
  it('discards nested argument saves before fitting callbacks', async () => {
    const source =
      setup +
      'result=optimize.least_squares(residual,[0.,0.],ftol=(np.save("nested.npy",np.array([3,4])) or 1e-8))\nafter=np.load("nested.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual(['nested.npy'])
  })
  it('preserves earlier reads and new saves following fitting callbacks', async () => {
    const source =
      setup +
      'before=np.load("cache.npy")\nresult=optimize.least_squares(residual,[0.,0.])\nnp.save("fresh.npy",np.array([3,4]))\nafter=np.load("fresh.npy")'
    const result = await analyzePythonNotebookSource(source)
    for (const target of ['before', 'after'])
      expect(result.facts.typeBindings).toContainEqual(
        expect.objectContaining({ target, typeName: 'numpy.ndarray' })
      )
    expect(result.facts.serializedValueWrites).toEqual([
      { path: 'fresh.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })
})

describe('SciPy solver and resampling content proof', () => {
  const setup =
    'import numpy as np\nfrom scipy import stats,integrate,ndimage,optimize\nnp.save("cache.npy",np.array([1,2]))\ndef callback(value):\n    open("cache.npy","w").write("changed")\n    return float(np.mean(value))\ndef rhs(t,y):\n    open("cache.npy","w").write("changed")\n    return -y\n'
  it.each([
    'stats.bootstrap(([2.,2.,2.],),callback,n_resamples=10,vectorized=False,method="percentile")',
    'stats.bootstrap(data=([2.,2.,2.],),statistic=callback,n_resamples=10,vectorized=False,method="percentile")',
    'integrate.solve_ivp(rhs,[0.,1.],[1.])',
    'integrate.solve_ivp(fun=rhs,t_span=[0.,1.],y0=[1.])',
    'ndimage.generic_filter(np.array([1.,2.,3.]),callback,size=3)',
    'ndimage.generic_filter(input=np.array([1.,2.,3.]),function=callback,size=3)',
    'optimize.minimize(callback,[0.])',
    'optimize.minimize(fun=callback,x0=[0.])'
  ])('invalidates previous content proof after %s', async (call) => {
    const source = setup + `result=${call}\nafter=np.load("cache.npy")`
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy'],
      externalState: 'partial'
    })
  })
  it.each([
    'def event(t,y):\n    open("cache.npy","w").write("changed")\n    return t-0.5\nresult=integrate.solve_ivp(lambda t,y:-y,[0.,1.],[1.],events=[event])',
    'def jac(t,y):\n    open("cache.npy","w").write("changed")\n    return np.array([[-1.]])\nresult=integrate.solve_ivp(lambda t,y:-y,[0.,1.],[1.],method="Radau",jac=jac)',
    'def gradient(x):\n    open("cache.npy","w").write("changed")\n    return np.array([2.*(x[0]-2.)])\nresult=optimize.minimize(lambda x:float((x[0]-2.)**2),[0.],jac=gradient)'
  ])('invalidates proof for auxiliary callbacks: %s', async (call) => {
    const source = setup + call + '\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy']
    })
  })
  it.each([
    'from scipy.ndimage import generic_filter as filter_values\nresult=filter_values(np.array([1.,2.,3.]),callback,size=3)',
    'def calculate():\n    return optimize.minimize(callback,[0.])\nresult=calculate()'
  ])('propagates alias and helper effects: %s', async (call) => {
    const source = setup + call + '\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy']
    })
  })
  it('propagates registered solver helper effects', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'from scipy.optimize import minimize\ndef callback(x):\n    open("cache.npy","w").write("changed")\n    return float(x[0]**2)\ndef calculate():\n    return minimize(callback,[1.])',
          exports: ['calculate']
        }
      ]
    }
    const source = setup + 'result=calculate()\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source, context)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: ['cache.npy']
    })
  })
  it.each([false, true])(
    'discards solver-stale proof through cache reload (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [setup + 'result=optimize.minimize(callback,[0.])'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      const result = await analyzePythonNotebookSource('after=np.load("cache.npy")', context)
      expect(result.facts.typeBindings).not.toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
    }
  )
  it.each([
    'def calculate():\n    return optimize.minimize(callback,[0.])',
    'from scipy.optimize import minimize as calculate\ndef calculate(*args):\n    return None\ncalculate(callback,[0.])',
    'result=stats.ttest_1samp([1.,2.,3.],2.)'
  ])('preserves proof for unused, rebound and unrelated operations: %s', async (call) => {
    const result = await analyzePythonNotebookSource(setup + call + '\nafter=np.load("cache.npy")')
    expect(result.facts.serializedValueWrites).toHaveLength(1)
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
  it('discards nested argument saves before a solver callback', async () => {
    const source =
      setup +
      'result=optimize.minimize(callback,[0.],tol=(np.save("nested.npy",np.array([3,4])) or 1e-8))\nafter=np.load("nested.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['nested.npy']
    })
  })
  it('preserves earlier reads and new saves following a solver callback', async () => {
    const source =
      setup +
      'before=np.load("cache.npy")\nresult=optimize.minimize(callback,[0.])\nnp.save("fresh.npy",np.array([3,4]))\nafter=np.load("fresh.npy")'
    const result = await analyzePythonNotebookSource(source)
    for (const target of ['before', 'after'])
      expect(result.facts.typeBindings).toContainEqual(
        expect.objectContaining({ target, typeName: 'numpy.ndarray' })
      )
    expect(result.facts.serializedValueWrites).toEqual([
      { path: 'fresh.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })
})

describe('SciPy callback file content proof', () => {
  const setup =
    'import numpy as np\nfrom scipy import signal,integrate,optimize,stats\nnp.save("cache.npy",np.array([1,2]))\ndef callback(value):\n    open("cache.npy","w").write("changed")\n    return value\n'
  it.each([
    'signal.periodogram(np.array([1.,2.,3.,4.]))',
    'signal.periodogram(np.array([1.,2.,3.,4.]),detrend=False)',
    'signal.periodogram(np.array([1.,2.,3.,4.]),detrend="linear")',
    'stats.binned_statistic([1,2],[1,2],bins=2)',
    'stats.binned_statistic([1,2],[1,2],statistic="mean",bins=2)',
    'stats.binned_statistic([1,2],[1,2],"sum",2)',
    'stats.binned_statistic([1,2],[1,2],statistic="count",bins=2)'
  ])('preserves proof for closed options: %s', async (call) => {
    const result = await analyzePythonNotebookSource(
      setup + `result=${call}\nafter=np.load("cache.npy")`
    )
    expect(result.facts.serializedValueWrites).toHaveLength(1)
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
  it.each([
    'from scipy.integrate import quad as integrate_value\nresult=integrate_value(callback,0.,1.)',
    'def calculate():\n    return integrate.quad(callback,0.,1.)\nresult=calculate()'
  ])('propagates active alias or local helper callback effects: %s', async (call) => {
    const source = setup + call + '\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy']
    })
  })
  it('propagates registered helper callback effects', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'from scipy.integrate import quad\ndef callback(value):\n    open("cache.npy","w").write("changed")\n    return value\ndef calculate():\n    return quad(callback,0.,1.)',
          exports: ['calculate']
        }
      ]
    }
    const source = setup + 'result=calculate()\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source, context)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: ['cache.npy']
    })
  })
  it.each([false, true])(
    'discards stale callback proof through cache reload (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [setup + 'result=integrate.quad(callback,0.,1.)'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      const result = await analyzePythonNotebookSource('after=np.load("cache.npy")', context)
      expect(result.facts.typeBindings).not.toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
    }
  )
  it.each([
    'def calculate():\n    return integrate.quad(callback,0.,1.)',
    'from scipy.integrate import quad as calculate\ndef calculate(*args):\n    return None\ncalculate(callback,0.,1.)'
  ])('does not invoke unused or rebound callbacks: %s', async (call) => {
    const result = await analyzePythonNotebookSource(setup + call + '\nafter=np.load("cache.npy")')
    expect(result.facts.serializedValueWrites).toHaveLength(1)
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
  it('invalidates saves evaluated in callback API arguments', async () => {
    const source =
      setup +
      'result=integrate.quad(callback,0.,1.,epsabs=(np.save("nested.npy",np.array([3,4])) or 1e-8))\nafter=np.load("nested.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['nested.npy']
    })
  })
  it('preserves reads before a callback and new saves after it', async () => {
    const source =
      setup +
      'before=np.load("cache.npy")\nresult=integrate.quad(callback,0.,1.)\nnp.save("fresh.npy",np.array([3,4]))\nafter=np.load("fresh.npy")'
    const result = await analyzePythonNotebookSource(source)
    for (const target of ['before', 'after'])
      expect(result.facts.typeBindings).toContainEqual(
        expect.objectContaining({ target, typeName: 'numpy.ndarray' })
      )
    expect(result.facts.serializedValueWrites).toEqual([
      { path: 'fresh.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })
  it.each([
    'signal.periodogram(np.array([1.,2.,3.,4.]),detrend=callback)',
    'signal.periodogram(np.array([1.,2.,3.,4.]),1.,"boxcar",None,callback)',
    'integrate.quad(callback,0.,1.)',
    'integrate.quad(func=callback,a=0.,b=1.)',
    'optimize.root_scalar(callback,bracket=[0.,2.])',
    'stats.binned_statistic([1,2],[1,2],statistic=callback,bins=2)',
    'stats.binned_statistic([1,2],[1,2],callback,2)'
  ])('revokes earlier file content proof after %s', async (call) => {
    const source = setup + `result=${call}\nafter=np.load("cache.npy")`
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy'],
      externalState: 'partial'
    })
  })
})

describe('NumPy text reader proof invalidation', () => {
  const setup =
    'import numpy as np\nnp.save("cache.npy",np.array([1,2]))\ndef convert(value):\n    open("cache.npy","w").write("changed")\n    return float(value)\ndef load(path):\n    return np.loadtxt(path,converters={0:convert})\n'
  it.each([false, true])(
    'discards converter-stale proof through cache reload (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [setup + 'rows=load("input.txt")'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      const result = await analyzePythonNotebookSource('after=np.load("cache.npy")', context)
      expect(result.facts.typeBindings).not.toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
    }
  )
  it.each([
    'rows=np.loadtxt("input.txt",converters={0:convert})',
    'rows=load("input.txt")',
    'def read(path):\n    return np.loadtxt(path,converters=lambda value:float(value)+float(open("offset.txt").read()))\nrows=read("input.txt")',
    'rows=np.loadtxt("input.txt",converters={0:convert},like=np.save("nested.npy",np.array([1,2])))'
  ])('revokes content proof after converter execution: %s', async (invocation) => {
    const source = setup + invocation + '\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: expect.arrayContaining(['cache.npy', 'input.txt'])
    })
  })
  it('propagates registered converter helper effects to dependency analysis', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'import numpy as np\ndef read(path):\n    return np.loadtxt(path,converters={0:convert})',
          exports: ['read']
        }
      ]
    }
    const result = await analyzePythonNotebookSource(
      setup + 'rows=read("input.txt")\nafter=np.load("cache.npy")',
      context
    )
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([
    'rows=np.loadtxt("input.txt",converters=None)',
    'rows=np.genfromtxt("input.txt",converters={})',
    'pass'
  ])('preserves proof without an active converter: %s', async (invocation) => {
    const result = await analyzePythonNotebookSource(
      setup + invocation + '\nafter=np.load("cache.npy")'
    )
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows a new proven save after a converter completes', async () => {
    const source =
      setup +
      'rows=load("input.txt")\nnp.save("fresh.npy",np.array([3,4]))\nafter=np.load("fresh.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites).toEqual([
      { path: 'fresh.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
})

it.each(['import numpy as np', 'from numpy import loadtxt as read'])(
  'retains NumPy text reader helper inputs with prior-cell imports: %s',
  async (imports) => {
    const context = await fileContext('python', [imports])
    const reader = imports.includes(' as read') ? 'read' : 'np.loadtxt'
    const source = `def load(path):\n    return ${reader}(path,converters={0:convert})\nvalue=load("input.txt")`
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: ['input.txt'],
      externalState: 'partial'
    })
  }
)
it.each([false, true])(
  'does not persist NumPy text reader helper callback summaries (%s)',
  async (precompute) => {
    const context = await fileContext(
      'python',
      ['import numpy as np\ndef load(path):\n    return np.loadtxt(path,converters={0:convert})'],
      [],
      precompute
    )
    expect(context?.localFileWrappers ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'load' })])
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value=load("input.txt")', context)
    ).toMatchObject({ externalState: 'partial' })
  }
)

it.each(['import numpy as np', 'from numpy import savetxt as emit'])(
  'retains NumPy text writer helper inputs using prior-cell imports: %s',
  async (importSource) => {
    const context = await fileContext('python', [importSource])
    const writer = importSource.includes('emit') ? 'emit' : 'np.savetxt'
    const source = `def export(path):\n    ${writer}(path,[1,2],header=open("header.txt").read())\nexport("result.txt")`
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: ['header.txt'],
      writes: ['result.txt'],
      externalState: 'partial'
    })
  }
)

it('does not persist a NumPy text writer helper path-only summary through cache reload', async () => {
  const context = await fileContext('python', [
    'import numpy as np\ndef export(path):\n    np.savetxt(path,np.load("input.npy"))'
  ])
  expect(context?.localFileWrappers ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'export' })])
  )
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'export("result.txt")\nvalue=np.loadtxt("result.txt")',
      context
    )
  ).toMatchObject({ reads: ['result.txt'], writes: [], externalState: 'partial' })
})

it.each(['import numpy as np', 'from numpy import savez as pack'])(
  'retains NumPy archive helper paths using prior-cell imports: %s',
  async (importSource) => {
    const context = await fileContext('python', [importSource])
    const writer = importSource.includes('pack') ? 'pack' : 'np.savez'
    const source = `def export(path):\n    ${writer}(path,values=[1,2])\nexport("result")`
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      writes: ['result.npz']
    })
  }
)

it('does not persist a misleading archive path-only summary through cache reload', async () => {
  const context = await fileContext('python', [
    'import numpy as np\ndef export(path):\n    np.savez(path,values=[1,2])'
  ])
  expect(context?.localFileWrappers ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'export' })])
  )
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'export("result")\nvalue=np.load("result")',
      context
    )
  ).toMatchObject({ reads: ['result'], writes: [], externalState: 'partial' })
})

describe('registered helper effects in same-cell serialization proof', () => {
  const contextFor = (operation: string): NotebookSourceFileAccessContext => ({
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonHelperModules: [
      {
        source: `import numpy as np\ndef reopen(path):\n    return ${operation}`,
        exports: ['reopen']
      }
    ]
  })
  const writer = 'with open("data.npy","r+b") as handle:\n    np.save(handle,np.array([4,5,6]))'

  it('preserves earlier read types while invalidating reads after the helper invocation', async () => {
    const context = {
      ...contextFor('np.load(path,mmap_mode="r+")'),
      verifiedSerializedValues: [
        { path: 'data.npy', format: 'npy' as const, valueType: 'numpy.ndarray' as const }
      ]
    }
    const source =
      'import numpy as np\nbefore=np.load("data.npy")\nmapped=reopen("data.npy")\nafter=np.load("data.npy")'
    const result = await analyzePythonNotebookSource(source, context)
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'before', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })

  it('propagates observed effects through nested registered helper calls', async () => {
    const context = contextFor('np.load(path,mmap_mode="r+")')
    context.pythonHelperModules![0]!.source += '\ndef outer(path):\n    return reopen(path)'
    context.pythonHelperModules![0]!.exports = ['outer']
    const source = `import numpy as np\nmapped=outer("data.npy")\n${writer}`
    const result = await analyzePythonNotebookSource(source, context)
    expect(result.fileAccess?.context.pythonMayHaveWritableMappings).toBe(true)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it('reprojects file context using corrected helper-dependent facts', async () => {
    const context = contextFor('np.load(path,mmap_mode="r+")')
    const callback = vi.fn<NonNullable<Parameters<typeof analyzePythonNotebookSource>[2]>>(
      () => context
    )
    const source = `import numpy as np\nmapped=reopen("data.npy")\n${writer}`
    const result = await analyzePythonNotebookSource(source, context, callback)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'unknown' })
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it.each([false, true])(
    'does not persist same-cell registered-helper proof through cache reload (%s)',
    async (precompute) => {
      const source = contextFor('np.load(path,mmap_mode="r+")').pythonHelperModules![0]!.source
      const helper = {
        helperId: 'same-cell-reopen',
        skillIdentity: 'skill://same-cell-reopen',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['reopen'],
        source,
        sourceDigest: 'digest-same-cell-reopen'
      }
      const context = await fileContext(
        'python',
        [`import numpy as np\nmapped=reopen("data.npy")\n${writer}`],
        [{ helperModules: [helper], helperEvidenceStatus: { state: 'complete' } }],
        precompute
      )
      expect(context?.pythonMayHaveWritableMappings).toBe(true)
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
    }
  )

  it.each([
    'np.load(path,mmap_mode="r+")',
    'np.lib.format.open_memmap(path,mode="r+")',
    'np.memmap(path,dtype="uint8",mode="r+")',
    'np.load(path,**options)'
  ])('revokes same-cell proof after observed registered mapping: %s', async (operation) => {
    const result = await analyzePythonNotebookSource(
      `import numpy as np\nmapped=reopen("data.npy")\n${writer}`,
      contextFor(operation)
    )
    expect(result.fileAccess?.context.pythonMayHaveWritableMappings).toBe(true)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it('discards accepted read types and their dependent outputs after helper mapping', async () => {
    const source = `import numpy as np\nnp.save("data.npy",np.array([1,2,3]))\nmapped=reopen("data.npy")\ncopy=np.load("data.npy")\nnp.save("copy.npy",copy)`
    const result = await analyzePythonNotebookSource(
      source,
      contextFor('np.memmap(path,dtype="uint8",mode="r+")')
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'copy', typeName: 'numpy.ndarray' })
    )
  })

  it.each(['np.load(path,mmap_mode="r")', 'np.load(path,mmap_mode="c")', 'np.load(path)'])(
    'retains same-cell proof for nonpersistent registered readers: %s',
    async (operation) => {
      const result = await analyzePythonNotebookSource(
        `import numpy as np\nmapped=reopen("data.npy")\n${writer}`,
        contextFor(operation)
      )
      expect(result.fileAccess?.context.pythonMayHaveWritableMappings).toBeUndefined()
      expect(result.facts.serializedValueWrites).toEqual([
        { path: 'data.npy', format: 'npy', valueType: 'numpy.ndarray' }
      ])
    }
  )

  it('does not infer effects from an uninvoked registered mapping', async () => {
    const result = await analyzePythonNotebookSource(
      `import numpy as np\n${writer}`,
      contextFor('np.load(path,mmap_mode="r+")')
    )
    expect(result.facts.serializedValueWrites).toHaveLength(1)
  })

  it('does not apply an obsolete registered helper after local rebinding', async () => {
    const source = `import numpy as np\ndef reopen(path):\n    return np.array([1,2,3])\nmapped=reopen("data.npy")\n${writer}`
    const result = await analyzePythonNotebookSource(
      source,
      contextFor('np.load(path,mmap_mode="r+")')
    )
    expect(result.fileAccess?.context.pythonMayHaveWritableMappings).toBeUndefined()
    expect(result.facts.serializedValueWrites).toHaveLength(1)
  })
})

it('persists live NumPy mapping risk through a helper call and cache reload', async () => {
  const context = await fileContext('python', [
    'import numpy as np\ndef reopen(path):\n    return np.load(path,mmap_mode="r+")\nmapped=reopen("data.npy")'
  ])
  expect(context?.pythonMayHaveWritableMappings).toBe(true)
  expect(
    (
      await analyzePythonNotebookSource(
        'import numpy as np\nnp.save("data.npy",np.array([3]))',
        context
      )
    ).facts.serializedValueWrites ?? []
  ).toEqual([])
})

it('does not certify a later-cell call from a discarded NumPy mapping summary', async () => {
  // Ordinary prior-cell function bodies are not persisted as registered helper modules.
  const context = await fileContext('python', [
    'import numpy as np\ndef reopen(path):\n    return np.load(path,mmap_mode="r+")'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'mapped=reopen("data.npy")', context)
  ).toMatchObject({ reads: [], writes: [], externalState: 'partial' })
})

it('persists NumPy mapping risk from a registered helper module', async () => {
  const source = 'import numpy as np\ndef reopen(path):\n    return np.load(path,mmap_mode="r+")'
  const helper = {
    helperId: 'reopen-array',
    skillIdentity: 'skill://reopen-array',
    packageOrigin: 'test',
    interfaceRevision: '1',
    registeredGeneration: 'generation-1',
    exports: ['reopen'],
    source,
    sourceDigest: 'digest-reopen-array'
  }
  const context = await fileContext(
    'python',
    ['mapped=reopen("data.npy")'],
    [{ helperModules: [helper], helperEvidenceStatus: { state: 'complete' } }]
  )
  expect(context?.pythonMayHaveWritableMappings).toBe(true)
  expect(
    (
      await analyzePythonNotebookSource(
        'import numpy as np\nnp.save("data.npy",np.array([3]))',
        context
      )
    ).facts.serializedValueWrites ?? []
  ).toEqual([])
})

it('does not export a path-only NumPy mapping wrapper summary', async () => {
  const context = await fileContext('python', [
    'import numpy as np',
    'def reopen(path):\n    return np.load(path,mmap_mode="r+")'
  ])
  expect(context?.localFileWrappers ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'reopen' })])
  )
})

it.each(['import numpy as np', 'from numpy import load as read'])(
  'retains NumPy helper mapping effects using a prior-cell import: %s',
  async (importSource) => {
    const context = await fileContext('python', [importSource])
    const loader = importSource.includes(' as read') ? 'read' : 'np.load'
    const source = `def reopen(path):\n    return ${loader}(path,mmap_mode="r+")\nmapped=reopen("seed.npy")`
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: ['seed.npy'],
      writes: ['seed.npy'],
      externalState: 'partial'
    })
  }
)

it.each(['"r"', '"c"', 'None'])(
  'does not persist writable risk for a nonpersistent NumPy helper mode: %s',
  async (mode) => {
    const context = await fileContext('python', [
      `import numpy as np\ndef reopen(path):\n    return np.load(path,mmap_mode=${mode})\nmapped=reopen("data.npy")`
    ])
    expect(context?.pythonMayHaveWritableMappings).toBeUndefined()
  }
)

it('does not import ndarray proof through an invalid NumPy load', async () => {
  const context = await fileContext('python', [
    'import numpy as np\nnp.save("data.npy",np.array([1,2]))'
  ])
  const source =
    'import numpy as np\nvalue=np.load("data.npy",bogus=True)\nnp.save("result.npy",value)'
  expect(
    (await analyzePythonNotebookSource(source, context)).facts.serializedValueWrites ?? []
  ).toEqual([])
})

it('does not export an invalid NumPy reader wrapper into later cells', async () => {
  const context = await fileContext('python', [
    'import numpy as np\ndef read(path):\n    return np.load(path,bogus=True)'
  ])
  expect(context?.localFileWrappers ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'read' })])
  )
  expect(
    await analyzeNotebookSourceFileAccess('python', 'value=read("seed.npy")', context)
  ).toMatchObject({ externalState: 'partial' })
})

it('rejects NumPy wrapper summaries when the import comes from an earlier cell', async () => {
  const context = await fileContext('python', [
    'import numpy as np',
    'def read(path):\n    return np.load(path,bogus=True)'
  ])
  expect(context?.localFileWrappers ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'read' })])
  )
  expect(
    await analyzeNotebookSourceFileAccess('python', 'value=read("seed.npy")', context)
  ).toMatchObject({ externalState: 'partial' })
})

it('does not infer a persistent mapping from a rejected NumPy load', async () => {
  const context = await fileContext('python', [
    'import numpy as np\nnp.load("data.npy",mmap_mode="r+",bogus=True)'
  ])
  expect(context?.pythonMayHaveWritableMappings).toBeUndefined()
})

it('retains possible persistent mappings from unresolved NumPy keyword expansion', async () => {
  const context = await fileContext('python', ['import numpy as np\nnp.load("data.npy",**options)'])
  expect(context?.pythonMayHaveWritableMappings).toBe(true)
  expect(
    (
      await analyzePythonNotebookSource(
        'import numpy as np\nnp.save("data.npy",np.array([3]))',
        context
      )
    ).facts.serializedValueWrites ?? []
  ).toEqual([])
})

it('does not recertify serialized files after a writable mapping survives cache reload', async () => {
  const context = await fileContext('python', [
    'import numpy as np\nmapped=np.memmap("data.npy", dtype="uint8", mode="r+")'
  ])
  const result = await analyzePythonNotebookSource(
    'import numpy as np\nwith open("data.npy","r+b") as handle:\n    np.save(handle,np.array([4,5,6]))',
    context
  )
  expect(result.facts.serializedValueWrites ?? []).toEqual([])
})

describe('writable mapping risk across notebook cells', () => {
  const mapping = 'import numpy as np\nmapped=np.memmap("data.npy",dtype="uint8",mode="r+")'
  const writer =
    'import numpy as np\nwith open("data.npy","r+b") as handle:\n    np.save(handle,np.array([4,5,6]))'

  it.each([
    'mapped=np.memmap("data.npy")',
    'mapped=np.memmap("data.npy",mode="readwrite")',
    'mapped=np.memmap("data.npy",mode=mode)',
    'mapped=np.load("data.npy",mmap_mode="r+")',
    'mapped=np.lib.format.open_memmap("data.npy")',
    'from numpy import memmap as mapping\nmapped=mapping("data.npy","uint8","r+")'
  ])('persists bounded mapping risk through the sidecar: %s', async (operation) => {
    const context = await fileContext('python', ['import numpy as np\n' + operation])
    expect(context?.pythonMayHaveWritableMappings).toBe(true)
    expect(
      (await analyzePythonNotebookSource(writer, context)).facts.serializedValueWrites ?? []
    ).toEqual([])
  })

  it.each([
    'mapped=np.memmap("data.npy",mode="r")',
    'mapped=np.memmap("data.npy",mode="readonly")',
    'mapped=np.memmap("data.npy",mode="c")',
    'mapped=np.memmap("data.npy",mode="copyonwrite")',
    'mapped=np.load("data.npy",mmap_mode="c")',
    'mapped=np.lib.format.open_memmap("data.npy",mode="r")',
    'def unused():\n    return np.memmap("data.npy",mode="r+")'
  ])(
    'does not introduce mapping risk for nonpersistent or unexecuted calls: %s',
    async (operation) => {
      const context = await fileContext('python', ['import numpy as np\n' + operation])
      expect(context?.pythonMayHaveWritableMappings).toBeUndefined()
      expect(
        (await analyzePythonNotebookSource(writer, context)).facts.serializedValueWrites
      ).toEqual([{ path: 'data.npy', format: 'npy', valueType: 'numpy.ndarray' }])
    }
  )

  it.each([
    'del mapped',
    'mapped=None',
    'mapped._mmap.close()',
    'unknown_call()',
    'import os\nos.chdir("other")'
  ])('retains same-kernel mapping risk after %s', async (source) => {
    const context = await fileContext('python', [mapping, source, 'import numpy as np'])
    expect(context?.pythonMayHaveWritableMappings).toBe(true)
    expect(
      (await analyzePythonNotebookSource(writer, context)).facts.serializedValueWrites ?? []
    ).toEqual([])
  })

  it('retains possible mapping state from a failed dispatched cell', async () => {
    const context = await fileContext(
      'python',
      [mapping + '\nraise RuntimeError("later")'],
      [{ status: 'failed' }]
    )
    expect(context?.pythonMayHaveWritableMappings).toBe(true)
    expect(
      (await analyzePythonNotebookSource(writer, context)).facts.serializedValueWrites ?? []
    ).toEqual([])
  })

  it('does not inherit mapping state from a cell never dispatched', async () => {
    const context = await fileContext(
      'python',
      [mapping],
      [{ status: 'failed', kernelDispatched: false }]
    )
    expect(context?.pythonMayHaveWritableMappings).toBeUndefined()
    expect(
      (await analyzePythonNotebookSource(writer, context)).facts.serializedValueWrites
    ).toHaveLength(1)
  })

  it('does not carry mapping risk into a new kernel epoch', async () => {
    const context = await fileContext('python', [mapping], [], true, undefined, 'epoch-2')
    expect(context?.pythonMayHaveWritableMappings).toBeUndefined()
    expect(
      (await analyzePythonNotebookSource(writer, context)).facts.serializedValueWrites
    ).toHaveLength(1)
  })

  it('does not carry mapping risk into another environment', async () => {
    const context = await fileContext('python', [mapping], [{ environment: 'other-python' }])
    expect(context?.pythonMayHaveWritableMappings).toBeUndefined()
  })

  it.each([false, 'true', []])('rebuilds invalid cached mapping metadata: %j', async (value) => {
    const context = await fileContext('python', [mapping], [], true, (json) => {
      const sidecar = JSON.parse(json)
      sidecar.runs['run-0'].fileContext.pythonMayHaveWritableMappings = value
      return JSON.stringify(sidecar)
    })
    expect(context?.pythonMayHaveWritableMappings).toBe(true)
  })

  it('blocks serialized proof in cached later run facts', async () => {
    await fileContext('python', [mapping, writer], [], true, (json) => {
      const sidecar = JSON.parse(json)
      expect(sidecar.runs['run-1'].facts.serializedValueWrites ?? []).toEqual([])
      expect(sidecar.runs['run-1'].fileContext.pythonMayHaveWritableMappings).toBe(true)
      return json
    })
  })

  it('does not use checksum-verified types while prior mapping state is unresolved', async () => {
    const context = await fileContext('python', [mapping])
    const result = await analyzePythonNotebookSource(
      'import numpy as np\nrestored=np.load("data.npy")',
      {
        ...context!,
        verifiedSerializedValues: [{ path: 'data.npy', format: 'npy', valueType: 'numpy.ndarray' }]
      }
    )
    expect(
      result.facts.typeBindings?.find((binding) => binding.target === 'restored')
    ).toBeUndefined()
  })

  it('retains mapping uncertainty through an unavailable history entry', () => {
    const context = projectNotebookFileContext('python', [
      {
        facts: { state: 'available', definedNames: [], usedNames: [], mutatedNames: [] },
        fileContext: {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonMayHaveWritableMappings: true
        }
      },
      undefined
    ])
    expect(context?.pythonMayHaveWritableMappings).toBe(true)
  })
})

it('restores writer paths from sliced collections after cache reload', async () => {
  const context = await fileContext('r', [
    'paths <- c("a.csv","b.csv","unused.csv")',
    'selected <- paths[1:2]'
  ])
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'list(data.frame(n=1)) |> purrr::walk2(selected,utils::write.csv)',
      context
    )
  ).toMatchObject({
    writes: ['a.csv', 'b.csv'],
    writeState: 'complete',
    externalState: 'complete'
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

const fileContext = async (
  language: 'python' | 'r',
  scripts: string[],
  overrides: Array<Partial<NotebookRunRecord>> = [],
  precompute = true,
  corruptCache?: (json: string) => string,
  currentKernelEpochId = 'epoch-1',
  currentRunOverrides?: Partial<NotebookRunRecord>,
  afterPrecompute?: (runs: NotebookRunRecord[]) => void
): Promise<NotebookSourceFileAccessContext | undefined> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
  roots.push(storageRoot)
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    inputKind: 'cell',
    kernelKind: language,
    kernelEpochId: 'epoch-1',
    environment: `default-${language}`,
    script,
    status: 'completed',
    startedAt: index,
    endedAt: index,
    executionCount: index,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: [],
    ...overrides[index]
  }))
  const currentRun = currentRunOverrides
    ? {
        ...runs.at(-1)!,
        runId: 'next-run',
        cellId: 'next-cell',
        script: '',
        ...currentRunOverrides
      }
    : undefined
  const repository = { readSessionRuns: async () => (currentRun ? [...runs, currentRun] : runs) }
  if (precompute)
    await new NotebookDependencyAnalyzer({ storageRoot, repository }).project({
      projectId: 'default-project',
      sessionId: 'session-1'
    })
  // Reload persisted facts, just as the file observer does after an app restart.
  if (corruptCache) {
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    await writeFile(cachePath, corruptCache(await readFile(cachePath, 'utf8')))
  }
  afterPrecompute?.(runs)
  return new NotebookDependencyAnalyzer({ storageRoot, repository }).sourceFileAccessContext({
    projectId: 'default-project',
    sessionId: 'session-1',
    currentRunId: 'next-run',
    language,
    environment: `default-${language}`,
    kernelEpochId: currentKernelEpochId
  })
}

describe('directory observations and analyzer revision review regressions', () => {
  it.each([
    'file.link("seed.txt", "alias.txt")',
    'base::file.link("seed.txt", "alias.txt")',
    'base::file.link(to="alias.txt", from="seed.txt")',
    'base::file.link(to="alias.txt", "seed.txt")'
  ])('retains R hard-link dependencies and mutation candidates: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['seed.txt'],
      writes: ['alias.txt', 'seed.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('retains R hard-link vector operands', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::file.link(c("a.txt", "b.txt"), c("x.txt", "y.txt"))'
      )
    ).toMatchObject({
      reads: ['a.txt', 'b.txt'],
      writes: ['a.txt', 'b.txt', 'x.txt', 'y.txt'],
      externalState: 'partial'
    })
  })

  it('excludes a fresh R hard-link source from prior inputs', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeLines("fresh", "seed.txt")\nbase::file.link("seed.txt", "alias.txt")'
      )
    ).toMatchObject({ reads: [], writes: ['alias.txt', 'seed.txt'], externalState: 'partial' })
  })

  it('retains later reads after an R hard-link shares a prior output', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeLines("fresh", "seed.txt")\nbase::file.link("seed.txt", "alias.txt")\nbase::writeLines("changed", "alias.txt")\nbase::readLines("seed.txt")'
      )
    ).toMatchObject({
      reads: ['seed.txt'],
      writes: ['alias.txt', 'seed.txt'],
      externalState: 'partial'
    })
  })

  it('restores R hard-link vectors after cache reload', async () => {
    const context = await fileContext('r', [
      'sources <- c("a.txt", "b.txt")\ntargets <- c("x.txt", "y.txt")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'base::file.link(sources, targets)', context)
    ).toMatchObject({
      reads: ['a.txt', 'b.txt'],
      writes: ['a.txt', 'b.txt', 'x.txt', 'y.txt'],
      externalState: 'partial'
    })
  })

  it.each([
    'file.link <- function(from, to) FALSE\nfile.link("seed.txt", "alias.txt")',
    'other::file.link("seed.txt", "alias.txt")',
    'base::file.link(source, "alias.txt")',
    'base::file.link(c("a.txt", "b.txt"), "alias.txt")'
  ])('does not invent R hard-link paths for unsupported calls: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      externalState: 'partial'
    })
  })

  it.each([
    ['file.remove("a.txt")', ['a.txt']],
    ['base::file.remove("a.txt")', ['a.txt']],
    ['base::file.remove(c("a.txt", "b.txt"))', ['a.txt', 'b.txt']],
    ['base::file.remove(first="a.txt", "b.txt")', ['a.txt', 'b.txt']]
  ] as const)('retains R removal mutation candidates: %s', async (source, writes) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('invalidates stale write evidence after R removal', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeLines("fresh", "a.txt")\nbase::file.remove("a.txt")\nbase::readLines("a.txt")'
      )
    ).toMatchObject({ reads: ['a.txt'], writes: ['a.txt'], externalState: 'partial' })
  })

  it('restores fresh output evidence after R removal and recreation', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::file.remove("a.txt")\nbase::writeLines("fresh", "a.txt")\nbase::readLines("a.txt")'
      )
    ).toMatchObject({ reads: [], writes: ['a.txt'], externalState: 'partial' })
  })

  it('restores R removal vectors after cache reload', async () => {
    const context = await fileContext('r', ['paths <- c("a.txt", "b.txt")'])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'base::file.remove(paths)', context)
    ).toMatchObject({ reads: [], writes: ['a.txt', 'b.txt'], externalState: 'partial' })
  })

  it.each([
    'file.remove <- function(...) FALSE\nfile.remove("a.txt")',
    'other::file.remove("a.txt")',
    'base::file.remove(paths)',
    'base::file.remove("~/a.txt")',
    'base::file.remove(list("a.txt", "b.txt"))'
  ])('does not invent R removal paths for unsupported calls: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      externalState: 'partial'
    })
  })

  it.each([
    'file.rename("seed.bin", "out.bin")',
    'base::file.rename("seed.bin", "out.bin")',
    'base::file.rename(to="out.bin", from="seed.bin")',
    'base::file.rename(to="out.bin", "seed.bin")'
  ])('retains R rename source and mutation candidates: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['seed.bin'],
      writes: ['out.bin', 'seed.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('retains paired R rename vector operands', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::file.rename(c("a.bin", "b.bin"), c("x.bin", "y.bin"))'
      )
    ).toMatchObject({
      reads: ['a.bin', 'b.bin'],
      writes: ['a.bin', 'b.bin', 'x.bin', 'y.bin'],
      externalState: 'partial'
    })
  })

  it('invalidates stale target write evidence after an R rename', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeLines("fresh", "out.txt")\nbase::file.rename("seed.txt", "out.txt")\nbase::readLines("out.txt")'
      )
    ).toMatchObject({
      reads: ['out.txt', 'seed.txt'],
      writes: ['out.txt', 'seed.txt'],
      externalState: 'partial'
    })
  })

  it('excludes a fresh R rename source from prior inputs', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeLines("fresh", "seed.txt")\nbase::file.rename("seed.txt", "out.txt")'
      )
    ).toMatchObject({ reads: [], writes: ['out.txt', 'seed.txt'], externalState: 'partial' })
  })

  it('restores R rename path vectors after cache reload', async () => {
    const context = await fileContext('r', [
      'sources <- c("a.bin", "b.bin")\ntargets <- c("x.bin", "y.bin")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'base::file.rename(sources, targets)', context)
    ).toMatchObject({
      reads: ['a.bin', 'b.bin'],
      writes: ['a.bin', 'b.bin', 'x.bin', 'y.bin'],
      externalState: 'partial'
    })
  })

  it.each([
    'file.rename <- function(from, to) FALSE\nfile.rename("seed.bin", "out.bin")',
    'other::file.rename("seed.bin", "out.bin")',
    'base::file.rename(source, "out.bin")',
    'base::file.rename(c("a.bin", "b.bin"), "out.bin")',
    'base::file.rename(from="seed.bin", unknown="out.bin")'
  ])('does not invent R rename paths for unsupported calls: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      externalState: 'partial'
    })
  })

  it.each([
    'from pathlib import Path\nPath("alias.bin").hardlink_to("seed.bin")',
    'from pathlib import Path\np = Path("alias.bin")\np.hardlink_to(target="seed.bin")',
    'import pathlib\npathlib.Path("alias.bin").hardlink_to("seed.bin")',
    'from pathlib import Path\nPath("alias.bin").hardlink_to(Path("seed.bin"))'
  ])('retains Path hard-link direction and mutations: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.bin'],
      writes: ['alias.bin', 'seed.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('excludes a fresh source when Path hard-link operands are reversed', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from pathlib import Path\nPath("seed.bin").write_bytes(b"fresh")\nPath("alias.bin").hardlink_to("seed.bin")'
      )
    ).toMatchObject({ reads: [], writes: ['alias.bin', 'seed.bin'], externalState: 'partial' })
  })

  it('retains later reads after a Path hard-link shares a prior output', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from pathlib import Path\nPath("seed.bin").write_bytes(b"fresh")\nPath("alias.bin").hardlink_to("seed.bin")\nPath("alias.bin").write_bytes(b"changed")\nPath("seed.bin").read_bytes()'
      )
    ).toMatchObject({
      reads: ['seed.bin'],
      writes: ['alias.bin', 'seed.bin'],
      externalState: 'partial'
    })
  })

  it.each([
    'from pathlib import PurePath as Path\nPath("alias.bin").hardlink_to("seed.bin")',
    'from pathlib import Path\nPath.hardlink_to = lambda *args: None\nPath("alias.bin").hardlink_to("seed.bin")',
    'from pathlib import Path\np = Path("alias.bin")\np.hardlink_to = lambda target: None\np.hardlink_to("seed.bin")',
    'from pathlib import Path\nopaque(Path)\nPath("alias.bin").hardlink_to("seed.bin")',
    'from pathlib import Path\np = Path("alias.bin")\nopaque(p)\np.hardlink_to("seed.bin")',
    'from pathlib import Path\nPath("alias.bin").hardlink_to(**options)'
  ])('does not invent Path hard-link paths without identity: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: [],
      externalState: 'partial'
    })
  })

  it.each([
    'import os\nos.link("seed.bin", "alias.bin")',
    'from os import link as publish\npublish(src="seed.bin", dst="alias.bin")',
    'import os as filesystem\nfilesystem.link("seed.bin", "alias.bin", follow_symlinks=False)',
    'import os\nos.link("seed.bin", "alias.bin", src_dir_fd=None, dst_dir_fd=None)'
  ])('retains hard-link source and mutation candidates: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.bin'],
      writes: ['alias.bin', 'seed.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it.each([
    'import os\nos.symlink("../seed.txt", "nested/alias.txt")',
    'from os import symlink as publish\npublish(dst="nested/alias.txt", src="../missing.txt")',
    'import os as filesystem\nfilesystem.symlink("../folder", "nested/alias.txt", target_is_directory=True)',
    'import os\nos.symlink(source, "nested/alias.txt", dir_fd=None)'
  ])('retains only the symbolic-link destination as a mutation: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: ['nested/alias.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('retains later symbolic-link reads without claiming a produced file', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nos.symlink("../seed.txt", "nested/alias.txt")\nPath("nested/alias.txt").read_text()'
      )
    ).toMatchObject({
      reads: [analyzedPythonPath('nested/alias.txt')],
      writes: ['nested/alias.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not reuse pre-symbolic-link replacement evidence after opaque conversion', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nPath("seed.txt").write_text("fresh")\nos.symlink(source, "alias.txt")\nPath("seed.txt").read_text()'
      )
    ).toMatchObject({ reads: ['seed.txt'], writes: ['alias.txt', 'seed.txt'] })
  })

  it.each([
    'os.symlink("seed.txt", "alias.txt", dir_fd=directory_fd)',
    'os.symlink(*paths)',
    'os.symlink(**options)',
    'os.symlink("seed.txt", "alias.txt", dst="different.txt")',
    'os.symlink("seed.txt", "alias.txt", unexpected=True)',
    'os.symlink = lambda src, dst: None\nos.symlink("seed.txt", "alias.txt")'
  ])('does not invent symbolic-link destinations for %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('python', `import os\n${call}`)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('restores symbolic-link identity and paths after cache reload', async () => {
    const context = await fileContext('python', [
      'from os import symlink as publish\ndestination = "nested/alias.txt"'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'publish("../seed.txt", destination)',
        context
      )
    ).toMatchObject({
      reads: [],
      writes: ['nested/alias.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'import shutil\nshutil.copy("seed.txt", "out")',
    'import shutil\nshutil.copy2("seed.txt", "out")',
    'from shutil import copy2 as publish\npublish(dst="out", src="seed.txt")',
    'import shutil as files\nfiles.copy("seed.txt", "out", follow_symlinks=False)'
  ])('keeps copy destination ambiguity partial: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.txt'],
      writes: ['out'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it.each(['copy', 'copy2'])(
    'retains reads after an ambiguous copy destination: %s',
    async (method) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `import shutil\nfrom pathlib import Path\nshutil.${method}("seed.txt", "copied.txt")\nPath("copied.txt").read_text()`
        )
      ).toMatchObject({
        reads: ['copied.txt', 'seed.txt'],
        writes: ['copied.txt'],
        externalState: 'partial'
      })
    }
  )

  it('excludes a fresh source before a bounded copy destination mutation', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nfrom pathlib import Path\nPath("seed.txt").write_text("fresh")\nshutil.copy2("seed.txt", "out")'
      )
    ).toMatchObject({ reads: [], writes: ['out', 'seed.txt'], externalState: 'partial' })
  })

  it('invalidates replacement proof after opaque copy destination or source conversion', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nfrom pathlib import Path\nPath("marker.txt").write_text("fresh")\nshutil.copy2(source, "copied.txt")\nPath("marker.txt").read_text()'
      )
    ).toMatchObject({
      reads: ['marker.txt'],
      writes: ['copied.txt', 'marker.txt'],
      externalState: 'partial'
    })
  })

  it.each([
    'shutil.copy2(*paths)',
    'shutil.copy2(**options)',
    'shutil.copy2("seed.txt", "out", dst="other")',
    'shutil.copy2 = lambda src, dst: None\nshutil.copy2("seed.txt", "out")'
  ])('does not invent a copy destination for unsupported calls: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('python', `import shutil\n${call}`)).toMatchObject(
      {
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it('retains source reads when opaque copy destination conversion can mutate fresh output', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nfrom pathlib import Path\nPath("seed.txt").write_text("fresh")\nshutil.copy2("seed.txt", destination)'
      )
    ).toMatchObject({ reads: ['seed.txt'], writes: ['seed.txt'], externalState: 'partial' })
  })

  it('restores copy destination candidates after cache reload', async () => {
    const context = await fileContext('python', [
      'from shutil import copy2 as publish\ndestination = "report.csv"'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'publish("seed.txt", destination)', context)
    ).toMatchObject({
      reads: ['seed.txt'],
      writes: ['report.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('retains a known source with an unresolved copy destination', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nshutil.copy2("seed.txt", destination)'
      )
    ).toMatchObject({ reads: ['seed.txt'], writes: [], externalState: 'partial' })
  })

  it('preserves exact file semantics for the copy destination of copyfile', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nfrom pathlib import Path\nshutil.copyfile("seed.txt", "copied.txt")\nPath("copied.txt").read_text()'
      )
    ).toMatchObject({
      reads: ['seed.txt'],
      writes: ['copied.txt'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'import shutil\nshutil.copyfile("seed.txt", "copied.txt", follow_symlinks=False)',
    'from shutil import copyfile as publish\npublish(dst="copied.txt", src="seed.txt", follow_symlinks=False)',
    'import shutil\nshutil.copyfile("seed.txt", "copied.txt", follow_symlinks=follow)'
  ])('keeps copyfile options with unverified target following partial: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.txt'],
      writes: ['copied.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('retains later reads for copyfile options that may create links', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nfrom pathlib import Path\nshutil.copyfile("seed.txt", "copied.txt", follow_symlinks=False)\nPath("copied.txt").read_text()'
      )
    ).toMatchObject({
      reads: ['copied.txt', 'seed.txt'],
      writes: ['copied.txt'],
      externalState: 'partial'
    })
  })

  it.each([
    [
      'source',
      'shutil.copyfile(source, "copied.txt")',
      ['marker.txt'],
      ['copied.txt', 'marker.txt']
    ],
    ['destination', 'shutil.copyfile("marker.txt", destination)', ['marker.txt'], ['marker.txt']],
    [
      'truth',
      'shutil.copyfile("marker.txt", "copied.txt", follow_symlinks=follow)',
      ['marker.txt'],
      ['copied.txt', 'marker.txt']
    ]
  ])(
    'invalidates replacement evidence around copyfile options conversion: %s',
    async (_, call, reads, writes) => {
      const source = `import shutil\nfrom pathlib import Path\nPath("marker.txt").write_text("fresh")\n${call}\nPath("marker.txt").read_text()`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads,
        writes,
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['external-state'])
      })
    }
  )

  it.each([
    'shutil.copyfile(*paths)',
    'shutil.copyfile(**options)',
    'shutil.copyfile("seed.txt", "copied.txt", dst="other.txt")',
    'shutil.copyfile("seed.txt", "copied.txt", unexpected=True)',
    'shutil.copyfile("seed.txt", "copied.txt", False)',
    'shutil.copyfile = lambda src, dst: None\nshutil.copyfile("seed.txt", "copied.txt")'
  ])('does not invent operands for invalid or shadowed copyfile options: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('python', `import shutil\n${call}`)).toMatchObject(
      {
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    'import shutil\nshutil.copyfile("seed.txt", "copied.txt")',
    'import shutil\nshutil.copyfile("seed.txt", "copied.txt", follow_symlinks=True)',
    'import shutil\nsource = "seed.txt"\ntarget = "copied.txt"\nshutil.copyfile(source, target)',
    'from shutil import copyfile as publish\npublish(dst="copied.txt", src="seed.txt")'
  ])('preserves bounded copyfile options with ordinary string paths: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.txt'],
      writes: ['copied.txt'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect((await analyzePythonNotebookSource(source)).facts.state).toBe('available')
  })

  it.each([true, false])(
    'restores copyfile options and string paths after cache reload: %s',
    async (follow) => {
      const context = await fileContext('python', [
        'from shutil import copyfile as publish\nsource = "seed.txt"\ntarget = "copied.txt"'
      ])
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `publish(source, target, follow_symlinks=${follow ? 'True' : 'False'})`,
          context
        )
      ).toMatchObject({
        reads: ['seed.txt'],
        writes: ['copied.txt'],
        readState: follow ? 'complete' : 'partial',
        writeState: follow ? 'complete' : 'partial',
        externalState: follow ? 'complete' : 'partial'
      })
    }
  )

  it.each([
    [
      'base::writeLines("fresh","result.txt")\nbase::file.copy("seed.txt","result.txt",overwrite=TRUE)\nbase::readLines("result.txt")',
      ['result.txt', 'seed.txt']
    ],
    [
      'base::writeLines("fresh","out/seed.txt")\nbase::file.copy("seed.txt","out",overwrite=TRUE)\nbase::readLines("out/seed.txt")',
      ['out/seed.txt', 'seed.txt']
    ],
    [
      'base::writeLines("fresh","result.txt")\nbase::file.copy("missing.txt","result.txt",overwrite=TRUE)\nbase::readLines("result.txt")',
      ['missing.txt', 'result.txt']
    ],
    [
      'base::writeLines("fresh","result.txt")\nbase::file.copy("seed.txt","result.txt",overwrite=FALSE)\nbase::readLines("result.txt")',
      ['result.txt', 'seed.txt']
    ],
    [
      'base::file.copy({base::writeLines("fresh","result.txt"); "seed.txt"},"result.txt",overwrite=TRUE)\nbase::readLines("result.txt")',
      ['result.txt']
    ],
    [
      'base::writeLines("fresh","out/input/seed.txt")\nbase::file.copy("input","out",recursive=TRUE,overwrite=TRUE)\nbase::readLines("out/input/seed.txt")',
      ['out/input/seed.txt']
    ]
  ])('retains reads after R copy mutation and argument evaluation: %s', async (source, reads) => {
    expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
      reads,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source as string)).facts.state).toBe('unknown')
  })

  it.each([
    ['base::file.copy(c("seed.txt","second.txt"),"out")', ['out']],
    [
      'base::file.copy(c("seed.txt","second.txt"),c("first.txt","last.txt"))',
      ['first.txt', 'last.txt']
    ],
    ['base::file.copy(to="out",c("seed.txt","second.txt"),copy.date=TRUE)', ['out']]
  ])('retains bounded R copy mutation vector operands: %s', async (source, writes) => {
    expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
      reads: ['second.txt', 'seed.txt'],
      writes,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source as string)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('restores R copy mutation vectors after cache reload', async () => {
    const context = await fileContext('r', [
      'sources <- c("seed.txt","second.txt")\ntargets <- c("first.txt","last.txt")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'base::file.copy(sources,targets)', context)
    ).toMatchObject({
      reads: ['second.txt', 'seed.txt'],
      writes: ['first.txt', 'last.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('excludes a fresh source before a bounded R copy mutation', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeLines("fresh","seed.txt")\nbase::file.copy("seed.txt","result.txt")'
      )
    ).toMatchObject({ reads: [], writes: ['result.txt', 'seed.txt'], externalState: 'partial' })
  })

  it.each([
    'other::file.copy("seed.txt","result.txt")',
    'file.copy <- function(from,to) FALSE\nfile.copy("seed.txt","result.txt")',
    'base::file.copy(from="seed.txt",from="second.txt",to="result.txt")',
    'base::file.copy(fr="seed.txt",to="result.txt")',
    'base::file.copy(c("seed.txt","second.txt"),c("a.txt","b.txt","c.txt"))',
    'base::file.copy(source,"result.txt")'
  ])('does not invent R copy mutation paths for unsupported calls: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'file.append("result.txt","seed.txt")',
    'base::file.append("result.txt","seed.txt")',
    'base::file.append(file2="seed.txt",file1="result.txt")',
    'base::file.append(file2="seed.txt","result.txt")'
  ])('retains R append target history, source and mutation direction: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['result.txt', 'seed.txt'],
      writes: ['result.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it.each([
    [
      'base::file.append("result.txt",c("seed.txt","second.txt"))',
      ['result.txt', 'second.txt', 'seed.txt'],
      ['result.txt']
    ],
    [
      'base::file.append(c("result.txt","other.txt"),"seed.txt")',
      ['other.txt', 'result.txt', 'seed.txt'],
      ['other.txt', 'result.txt']
    ]
  ])('retains R append vector recycling candidates: %s', async (source, reads, writes) => {
    expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
      reads,
      writes,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('restores R append vectors after cache reload', async () => {
    const context = await fileContext('r', [
      'targets <- c("result.txt","other.txt")\nsources <- c("seed.txt","second.txt")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'base::file.append(targets,sources)', context)
    ).toMatchObject({
      reads: ['other.txt', 'result.txt', 'second.txt', 'seed.txt'],
      writes: ['other.txt', 'result.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'base::writeLines("fresh","result.txt")\nbase::file.append("result.txt","seed.txt")',
      ['seed.txt'],
      ['result.txt']
    ],
    [
      'base::writeLines("fresh","seed.txt")\nbase::file.append("result.txt","seed.txt")',
      ['result.txt'],
      ['result.txt', 'seed.txt']
    ]
  ])(
    'excludes freshly produced content at the R append operation: %s',
    async (source, reads, writes) => {
      expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
        reads,
        writes,
        externalState: 'partial'
      })
    }
  )

  it.each([
    [
      'base::writeLines("fresh","result.txt")\nbase::file.append("result.txt","seed.txt")\nbase::readLines("result.txt")',
      ['result.txt', 'seed.txt']
    ],
    [
      'base::file.append({base::writeLines("fresh","result.txt"); "result.txt"},"seed.txt")\nbase::readLines("result.txt")',
      ['result.txt']
    ]
  ])('retains reads after R append and argument-side writes: %s', async (source, reads) => {
    expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
      reads,
      writes: ['result.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'other::file.append("result.txt","seed.txt")',
    'base::file.append("result.txt",source)',
    'base::file.append(file1="result.txt",file1="other.txt",file2="seed.txt")',
    'base::file.append("result.txt","seed.txt",extra=TRUE)',
    'base::file.append(list("result.txt"),"seed.txt")'
  ])('does not invent R append operands for unsupported calls: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('preserves complete analysis for a pure local R append shadow', async () => {
    const source =
      'file.append <- function(file1,file2) FALSE\nfile.append("result.txt","seed.txt")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect((await analyzeRNotebookSource(source)).facts.state).toBe('available')
  })

  it.each([
    ['file.create("result.txt")', ['result.txt']],
    ['base::file.create("result.txt")', ['result.txt']],
    ['base::file.create("result.txt","other.txt")', ['other.txt', 'result.txt']],
    ['base::file.create(c("result.txt","other.txt"))', ['other.txt', 'result.txt']],
    ['base::file.create(first="result.txt",second="other.txt")', ['other.txt', 'result.txt']],
    ['base::file.create(first="result.txt",first="other.txt")', ['other.txt', 'result.txt']],
    ['base::file.create(showWarnings=FALSE,"result.txt")', ['result.txt']],
    ['base::file.create("result.txt",showWarnings=FALSE)', ['result.txt']],
    ['base::file.create(showWarning="result.txt")', ['result.txt']],
    ['base::file.create("absent/result.txt",showWarnings=FALSE)', ['absent/result.txt']],
    ['base::file.create("out",showWarnings=FALSE)', ['out']]
  ])('retains bounded R create mutation candidates: %s', async (source, writes) => {
    expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
      reads: [],
      writes,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source as string)).facts).toMatchObject({
      state: 'unknown',
      reasons: ['external-state']
    })
  })

  it('restores R create vectors after cache reload', async () => {
    const context = await fileContext('r', ['targets <- c("result.txt","other.txt")'])
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::file.create(targets,showWarnings=FALSE)',
        context
      )
    ).toMatchObject({
      reads: [],
      writes: ['other.txt', 'result.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'base::writeLines("fresh","result.txt");base::file.create("result.txt");base::readLines("result.txt")',
      ['result.txt'],
      ['result.txt']
    ],
    [
      'base::file.create({base::writeLines("fresh","result.txt");"result.txt"});base::readLines("result.txt")',
      ['result.txt'],
      ['result.txt']
    ],
    [
      'base::writeLines("fresh","alias.txt");base::file.create("result.txt");base::readLines("alias.txt")',
      ['alias.txt'],
      ['alias.txt', 'result.txt']
    ]
  ])(
    'retains later reads after R create invalidates write proof: %s',
    async (source, reads, writes) => {
      expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
        reads,
        writes,
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each([
    'other::file.create("result.txt")',
    'file.create <- function(...) FALSE;file.create("result.txt")',
    'base::file.create(target)',
    'base::file.create("result.txt",showWarnings=TRUE,showWarnings=FALSE)',
    'base::file.create("result.txt",showWarnings=flag)',
    'base::file.create("result.txt",FALSE)',
    'base::file.create(list("result.txt"))'
  ])('does not invent R create operands for unsupported calls: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('preserves complete analysis for a pure local R create shadow', async () => {
    const source = 'file.create <- function(path) FALSE;file.create("result.txt")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect((await analyzeRNotebookSource(source)).facts.state).toBe('available')
  })

  it.each([
    'writeChar("new","result.bin",eos=NULL)',
    'base::writeChar("new","result.bin",eos=NULL)',
    'base::writeChar(con="result.bin",object="new",eos=NULL)',
    'base::writeChar(eos=NULL,object="new","result.bin")',
    'base::writeChar("new","result.bin")',
    'base::writeChar("new","result.bin",nchars=2L,eos=NULL)',
    'base::writeChar("new","result.bin",nchars=5L,eos=NULL)',
    'base::writeChar(c("new","row"),"result.bin",eos=NULL)'
  ])('retains bounded R writeChar destinations: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: ['result.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: ['external-state']
    })
  })

  it('restores an R writeChar destination after cache reload', async () => {
    const context = await fileContext('r', ['target <- "result.bin"'])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'base::writeChar("new",target,eos=NULL)', context)
    ).toMatchObject({ reads: [], writes: ['result.bin'], writeState: 'partial' })
  })

  it.each([
    ['wb', []],
    ['ab', ['result.bin']],
    ['r+b', ['result.bin']],
    ['', []],
    ['rb', ['result.bin']]
  ])(
    'retains R writeChar connection mode %s without certifying production',
    async (mode, reads) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `con <- base::file("result.bin","${mode}");alias <- con;base::writeChar("new",alias,eos=NULL);base::close(con)`
        )
      ).toMatchObject({
        reads,
        writes: ['result.bin'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each([
    'con <- base::file("result.bin","rb");base::close(con);base::writeChar("new",con,eos=NULL)',
    'base::writeLines("fresh","result.bin");base::writeChar("new","result.bin",eos=NULL);base::readChar("result.bin",3L,useBytes=TRUE)',
    'base::writeChar("new",{base::writeLines("fresh","result.bin");"result.bin"},eos=NULL);base::readChar("result.bin",3L,useBytes=TRUE)'
  ])('retains R writeChar reads after closure or earlier writes: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['result.bin'],
      writes: ['result.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('retains nested inputs and a possible output for an unbounded R writeChar payload', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeChar(base::readChar("seed.bin",3L,useBytes=TRUE),"result.bin",eos=NULL)'
      )
    ).toMatchObject({
      reads: ['seed.bin'],
      writes: ['result.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'other::writeChar("new","result.bin",eos=NULL)',
    'base::writeChar("new",target,eos=NULL)',
    'base::writeChar("new","result.bin",con="other.bin")',
    'base::writeChar("new","result.bin",nchars=length)',
    'base::writeChar("new","result.bin",useBytes=flag)',
    'base::writeChar("new","result.bin",extra=TRUE)'
  ])('does not invent R writeChar destinations for unsupported calls: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('preserves a pure local R writeChar shadow', async () => {
    const source =
      'writeChar <- function(object,con,eos) NULL;writeChar("new","result.bin",eos=NULL)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'complete',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.state).toBe('available')
  })

  it('excludes a freshly produced hard-link source from prior inputs', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nPath("seed.bin").write_bytes(b"fresh")\nos.link("seed.bin", "alias.bin")'
      )
    ).toMatchObject({ reads: [], writes: ['alias.bin', 'seed.bin'], externalState: 'partial' })
  })

  it('does not exclude later reads using pre-link write evidence', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nPath("seed.bin").write_bytes(b"fresh")\nos.link("seed.bin", "alias.bin")\nos.truncate("alias.bin", 2)\nPath("seed.bin").read_bytes()'
      )
    ).toMatchObject({
      reads: ['alias.bin', 'seed.bin'],
      writes: ['alias.bin', 'seed.bin'],
      externalState: 'partial'
    })
  })

  it.each([
    'os.link("seed.bin", "alias.bin", src_dir_fd=directory_fd)',
    'os.link("seed.bin", "alias.bin", dst_dir_fd=directory_fd)',
    'os.link(*paths)',
    'os.link(**options)'
  ])('does not invent hard-link paths for %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('python', `import os\n${call}`)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('retains a known hard-link destination when the source is unresolved', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('python', 'import os\nos.link(source, "alias.bin")')
    ).toMatchObject({ reads: [], writes: ['alias.bin'], externalState: 'partial' })
  })

  it('restores hard-link import identity after cache reload', async () => {
    const context = await fileContext('python', ['from os import link as publish'])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'publish("seed.bin", "alias.bin")', context)
    ).toMatchObject({
      reads: ['seed.bin'],
      writes: ['alias.bin', 'seed.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not retain hard-link identity after monkeypatching', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nos.link = lambda src, dst: None\nos.link("seed.bin", "alias.bin")'
      )
    ).toMatchObject({ reads: [], writes: [], externalState: 'partial' })
  })

  it.each([
    'import os\nos.truncate("data.bin", 4)',
    'from os import truncate as resize\nresize(path="data.bin", length=4)',
    'import os\nos.truncate("data.bin", length=12)',
    'import os\npath = "data.bin"\nos.truncate(path, 0)'
  ])('retains truncate input and mutation candidates: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['data.bin'],
      writes: ['data.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('preserves same-cell content origin across bounded truncate', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nPath("data.bin").write_bytes(b"fresh")\nos.truncate("data.bin", 2)\nPath("data.bin").read_bytes()'
      )
    ).toMatchObject({ reads: [], writes: ['data.bin'], externalState: 'partial' })
  })

  it.each([
    'os.truncate(fd, 4)',
    'os.ftruncate(fd, 4)',
    'os.truncate("data.bin", length)',
    'os.truncate(*args)',
    'os.truncate(**options)'
  ])('does not guess truncate paths for %s', async (call) => {
    const source = `import os\n${call}`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('invalidates prior write evidence across an opaque truncate length', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nPath("data.bin").write_text("fresh")\nos.truncate("other.bin", length)\nPath("data.bin").read_text()'
      )
    ).toMatchObject({ reads: ['data.bin'], writes: ['data.bin'], externalState: 'partial' })
  })

  it('restores truncate import identity after cache reload', async () => {
    const context = await fileContext('python', ['from os import truncate as resize'])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'resize("data.bin", 4)', context)
    ).toMatchObject({
      reads: ['data.bin'],
      writes: ['data.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not retain truncate identity after monkeypatching', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nos.truncate = lambda path, length: None\nos.truncate("data.bin", 4)'
      )
    ).toMatchObject({ reads: [], writes: [], externalState: 'partial' })
  })

  it.each([
    'from pathlib import Path\nPath("ready.flag").touch()',
    'from pathlib import Path\np = Path("ready.flag")\np.touch(exist_ok=False)',
    'import pathlib\npathlib.Path("ready.flag").touch(mode=0o600)',
    'from pathlib import Path\nPath("ready.flag").touch(0o600, True)',
    'from pathlib import Path\nPath("ready.flag").touch(0o600, exist_ok=False)'
  ])('retains concrete Path touch output candidates: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: ['ready.flag'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('does not treat touch as replacement of existing file contents', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from pathlib import Path\nPath("data.txt").touch()\nPath("data.txt").read_text()'
      )
    ).toMatchObject({ reads: ['data.txt'], writes: ['data.txt'], externalState: 'partial' })
  })

  it('preserves proven fresh contents across a checked touch', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from pathlib import Path\nPath("data.txt").write_text("fresh")\nPath("data.txt").touch()\nPath("data.txt").read_text()'
      )
    ).toMatchObject({ reads: [], writes: ['data.txt'], externalState: 'partial' })
  })

  it.each([
    'from pathlib import PurePath as Path\nPath("ready.flag").touch()',
    'from pathlib import Path\nPath.touch = lambda *args: None\nPath("ready.flag").touch()',
    'from pathlib import Path\np = Path("ready.flag")\np.touch = lambda: None\np.touch()',
    'from pathlib import Path\nopaque(Path)\nPath("ready.flag").touch()',
    'from pathlib import Path\np = Path("ready.flag")\nopaque(p)\np.touch()',
    'from pathlib import Path\nPath("ready.flag").touch(**options)',
    'from pathlib import Path\nPath("ready.flag").touch(exist_ok=condition)',
    'from pathlib import Path\nPath("ready.flag").touch(mode=mode)'
  ])('does not invent touch paths without a bounded call: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: [],
      externalState: 'partial'
    })
  })

  it.each([
    ['import shutil', 'shutil.rmtree("outputs")', 'outputs'],
    ['from shutil import rmtree as discard', 'discard(path="outputs")', 'outputs'],
    ['import shutil', 'shutil.rmtree("outputs", ignore_errors=True)', 'outputs'],
    ['import shutil', 'shutil.rmtree("outputs", onerror=handler)', 'outputs'],
    ['import os', 'os.removedirs(name="outputs/empty")', 'outputs/empty']
  ])(
    'retains directory deletion mutations and uncertainty: %s %s',
    async (imports, deletion, path) => {
      const source = `${imports}\n${deletion}`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: [],
        writes: [path],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['external-state'])
      })
    }
  )

  it('retains child input candidates after a recursive directory deletion', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nfrom pathlib import Path\nPath("outputs/a.txt").write_text("fresh")\nshutil.rmtree("outputs")\nPath("outputs/a.txt").read_text()'
      )
    ).toMatchObject({
      reads: [analyzedPythonPath('outputs/a.txt')],
      writes: expect.arrayContaining(['outputs']),
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'shutil.rmtree(dynamic_path)',
    'shutil.rmtree("outputs", dir_fd=directory_fd)',
    'shutil.rmtree(**options)'
  ])('does not invent directory deletion paths for %s', async (deletion) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', `import shutil\n${deletion}`)
    ).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('restores directory deletion import identity after cache reload', async () => {
    const context = await fileContext('python', ['from shutil import rmtree as discard'])
    expect(context?.pythonBindings).toEqual(
      expect.arrayContaining([{ name: 'discard', kind: 'import', qualifiedName: 'shutil.rmtree' }])
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'discard("outputs")', context)
    ).toMatchObject({
      writes: ['outputs'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not retain directory deletion identity after replacing shutil.rmtree', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nshutil.rmtree = lambda path: None\nshutil.rmtree("outputs")'
      )
    ).toMatchObject({ reads: [], writes: [], externalState: 'partial' })
  })

  it.each([
    'from pathlib import Path\nPath("seed.txt").replace("out.txt")',
    'from pathlib import Path\np = Path("seed.txt")\np.rename(target="out.txt")',
    'import pathlib\npathlib.Path("seed.txt").replace("out.txt")',
    'from pathlib import Path\nPath("seed.txt").replace(Path("out.txt"))'
  ])('retains concrete Path move candidates: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.txt'],
      writes: ['out.txt', 'seed.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts.state).toBe('unknown')
  })

  it.each([
    'from pathlib import Path\nPath("out.txt").unlink()',
    'from pathlib import Path\np = Path("out.txt")\np.unlink(missing_ok=True)',
    'from pathlib import Path\nPath("out.txt").rmdir()'
  ])('retains concrete Path deletion candidates: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: ['out.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('invalidates earlier write exclusions across a concrete Path move', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from pathlib import Path\nPath("out.txt").write_text("fresh")\nPath("seed.txt").replace("out.txt")\nPath("out.txt").read_text()'
      )
    ).toMatchObject({ reads: ['out.txt', 'seed.txt'], externalState: 'partial' })
  })

  it.each([
    'from pathlib import PurePath as Path\nPath("seed.txt").replace("out.txt")',
    'from pathlib import Path\nPath.replace = lambda *args: None\nPath("seed.txt").replace("out.txt")',
    'from pathlib import Path\np = Path("seed.txt")\np.replace = lambda *args: None\np.replace("out.txt")',
    'from pathlib import Path\np = Path("seed.txt")\nopaque(p)\np.replace("out.txt")',
    'from pathlib import Path\nopaque(Path)\nPath("seed.txt").replace("out.txt")',
    'import pathlib\nopaque(pathlib)\npathlib.Path("seed.txt").replace("out.txt")',
    'from pathlib import Path\nPath("seed.txt").replace(**options)'
  ])('does not invent Path mutation candidates without bounded identity: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it.each([
    ['import os', 'os.unlink("out.txt")'],
    ['import os', 'os.remove(path="out.txt")'],
    ['import os', 'os.rmdir("out.txt")'],
    ['from os import unlink as discard', 'discard("out.txt")'],
    ['from os import remove', 'remove("out.txt")']
  ])(
    'records Python deletion mutations without claiming a produced file: %s %s',
    async (imports, deletion) => {
      const source = `${imports}\n${deletion}`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: [],
        writes: ['out.txt'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['external-state'])
      })
    }
  )

  it('retains a later Python read candidate after deleting an earlier output', async () => {
    const source =
      'import os\nfrom pathlib import Path\nPath("out.txt").write_text("fresh")\nos.unlink("out.txt")\ntry:\n    result=Path("out.txt").read_text()\nexcept FileNotFoundError:\n    result="missing"'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['out.txt'],
      writes: ['out.txt'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('allows an explicit replacement write to establish a new value after deletion', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nos.unlink("out.txt")\nPath("out.txt").write_text("new")\nPath("out.txt").read_text()'
      )
    ).toMatchObject({ reads: [], writes: ['out.txt'], externalState: 'partial' })
  })

  it.each([
    'os.unlink(dynamic_path)',
    'os.unlink("out.txt", dir_fd=directory_fd)',
    'os.unlink(**options)'
  ])('does not invent a Python deletion path for %s', async (deletion) => {
    expect(await analyzeNotebookSourceFileAccess('python', `import os\n${deletion}`)).toMatchObject(
      {
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it('retains a deletion candidate with an explicit None directory descriptor', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nos.unlink("out.txt", dir_fd=None)'
      )
    ).toMatchObject({ writes: ['out.txt'], writeState: 'partial', externalState: 'partial' })
  })

  it('restores a Python deletion import after analysis cache reload', async () => {
    const context = await fileContext('python', ['from os import remove as discard'])
    expect(context?.pythonBindings).toEqual(
      expect.arrayContaining([{ name: 'discard', kind: 'import', qualifiedName: 'os.remove' }])
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'discard("out.txt")', context)
    ).toMatchObject({
      reads: [],
      writes: ['out.txt'],
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not retain deletion identity after replacing os.remove', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nos.remove = lambda path: None\nos.remove("out.txt")'
      )
    ).toMatchObject({ reads: [], writes: [], externalState: 'partial' })
  })

  it('does not confuse list.remove with a Python filesystem deletion', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'values = ["out.txt"]\nvalues.remove("out.txt")'
      )
    ).toMatchObject({ reads: [], writes: [], externalState: 'complete' })
  })

  it.each([
    ['import os', 'os.replace("seed.txt", "out.txt")'],
    ['import os', 'os.rename(src="seed.txt", dst="out.txt")'],
    ['from os import replace as publish', 'publish("seed.txt", "out.txt")'],
    ['import shutil as files', 'files.move("seed.txt", "out.txt")']
  ])('retains source and mutation candidates for Python moves: %s %s', async (imports, move) => {
    const source = `${imports}\nfrom pathlib import Path\nPath("out.txt").write_text("fresh")\n${move}\nPath("out.txt").read_text()`
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io).toMatchObject({
      reads: ['out.txt', 'seed.txt'],
      writes: ['out.txt', 'seed.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('does not count a locally generated move source as a prior input', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nPath("temp.txt").write_text("fresh")\nos.replace("temp.txt", "out.txt")'
      )
    ).toMatchObject({
      reads: [],
      writes: ['out.txt', 'temp.txt'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not claim complete move inputs when the temporary source is dynamic', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('python', 'import os\nos.replace(temporary, "out.txt")')
    ).toMatchObject({
      reads: [],
      writes: ['out.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('invalidates earlier child writes when a Python directory is moved', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nfrom pathlib import Path\nPath("old/value.txt").write_text("fresh")\nos.rename("old", "saved")\nos.rename("seed", "old")\nPath("old/value.txt").read_text()'
      )
    ).toMatchObject({
      reads: expect.arrayContaining([analyzedPythonPath('old/value.txt'), 'seed']),
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not treat an unrelated replace method as a file move', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = "seed.txt".replace("seed", "out")')
    ).toMatchObject({
      reads: [],
      writes: [],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not resolve descriptor-relative move paths against the notebook directory', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import os\nos.replace("seed.txt", "out.txt", src_dir_fd=source_fd, dst_dir_fd=target_fd)'
      )
    ).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'setwd("other")',
    'base::setwd("other")',
    'base::"setwd"("other")',
    'move <- setwd; move("other")',
    'move <- base::setwd; move("other")',
    'move <- function() setwd("other"); move()',
    'unused <- function() setwd("other")'
  ])('retains R input candidates across cwd-changing code: %s', async (change) => {
    const source = `base::writeLines("fresh", "out.txt"); ${change}; base::readLines("out.txt")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['out.txt'],
      writes: ['out.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.state).toBe('unknown')
  })

  it('retains R input candidates when a cached helper may change the namespace', async () => {
    const context = await fileContext('r', ['move <- function(path) base::setwd(path)'])
    expect(context?.rFunctions?.some(({ name }) => name === 'move')).toBe(true)
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeLines("fresh", "out.txt"); move("other"); base::readLines("out.txt")',
        context
      )
    ).toMatchObject({ reads: ['out.txt'], readState: 'partial', externalState: 'partial' })
  })

  it.each(['unused unknown', 'called pure'])(
    'preserves R file authority for a %s cached helper',
    async (kind) => {
      const context = await fileContext('r', [
        kind === 'unused unknown'
          ? 'move <- function(path) base::setwd(path)'
          : 'identity_value <- function(value) value'
      ])
      const call = kind === 'unused unknown' ? '' : 'identity_value(1);'
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `base::writeLines("fresh", "out.txt"); ${call} base::readLines("out.txt")`,
          context
        )
      ).toMatchObject({
        reads: [],
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  )

  it('does not interpret R cwd text or comments as a directory mutation', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        '# setwd("other")\nbase::writeLines("setwd(other)", "out.txt"); base::readLines("out.txt")'
      )
    ).toMatchObject({
      reads: [],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'import os\nos.chdir("other")',
    'from os import chdir as move\nmove("other")',
    'import os\nmove = os.chdir\nmove("other")',
    'import os\ndef move():\n    os.chdir("other")\nmove()',
    'from os import chdir as move\ndef relocate():\n    move("other")\nrelocate()',
    'import os\nos.fchdir(directory_fd)'
  ])('withholds Python file authority across cwd-changing code: %s', async (change) => {
    const source = `from pathlib import Path\nwith open("outputs/result.json", "w") as f: f.write("fresh")\n${change}\nPath("outputs/result.json").read_text()`
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io).toMatchObject({
      reads: [analyzedPythonPath('outputs/result.json')],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts.state).toBe('unknown')
  })

  it.each(['import', 'helper'])('withholds Python cwd authority from a cached %s', async (kind) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      ...(kind === 'import'
        ? { pythonBindings: [{ name: 'move', kind: 'import' as const, qualifiedName: 'os.chdir' }] }
        : {
            pythonHelperModules: [
              { source: 'import os\ndef move(path):\n    os.chdir(path)', exports: ['move'] }
            ]
          })
    }
    const source =
      'from pathlib import Path\nwith open("outputs/result.json","w") as f: f.write("fresh")\nmove("other")\nPath("outputs/result.json").read_text()'
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: [analyzedPythonPath('outputs/result.json')],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('keeps dormant Python cwd references conservative without executing them', async () => {
    const source =
      'import os\ndef unused():\n    os.chdir("other")\nwith open("out.txt","w") as f: f.write("fresh")\nwith open("out.txt") as f: data = f.read()'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['out.txt'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not treat a Python cwd spelling inside a string as mutation', async () => {
    const source =
      'note = "os.chdir(other)"\nwith open("out.txt","w") as f: f.write(note)\nwith open("out.txt") as f: data = f.read()'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'with open("outputs/result.json", "w") as f:\n    f.write("{}")\nPath("outputs/result.json").read_bytes()',
    'Path("outputs/result.json").write_text("{}")\nwith open("outputs/result.json") as f:\n    result = f.read()'
  ])(
    'does not invent an input from a Python separator alias after replacement: %s',
    async (body) => {
      expect(
        (await analyzeNotebookSourceFileAccess('python', `from pathlib import Path\n${body}`)).reads
      ).toEqual([])
    }
  )

  it('deduplicates Python local separator aliases while retaining the first spelling', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'from pathlib import Path',
        'with open("inputs/data.json") as f: data = f.read()',
        'Path("inputs/data.json").read_bytes()'
      ].join('\n')
    )
    expect(result.reads).toEqual(['inputs/data.json'])
  })

  it('deduplicates Python output separator aliases without rewriting the first spelling', async () => {
    const source =
      'from pathlib import Path\nwith open("outputs/result.json", "w") as f: f.write("{}")\nPath("outputs/result.json").write_text("{}")'
    expect((await analyzeNotebookSourceFileAccess('python', source)).writes).toEqual([
      'outputs/result.json'
    ])
  })

  it.each([
    'import os\nos.chdir("other")',
    'from os import chdir as move\nmove("other")',
    'import os\nos.fchdir(directory_fd)'
  ])(
    'keeps a Python separator-alias input after a working-directory change: %s',
    async (change) => {
      const source = `from pathlib import Path\nwith open("outputs/result.json", "w") as f: f.write("{}")\n${change}\nPath("outputs/result.json").read_bytes()`
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
        analyzedPythonPath('outputs/result.json')
      ])
    }
  )

  it('keeps a Python input read before a replacement through a separator alias', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'from pathlib import Path',
        'with open("outputs/result.json") as f: data = f.read()',
        'Path("outputs/result.json").write_text("{}")',
        'Path("outputs/result.json").read_bytes()'
      ].join('\n')
    )
    expect(result.reads).toEqual(['outputs/result.json'])
  })

  it.each(['if choose:', 'for unused in items:'])(
    'keeps Python reads after conditional separator-alias writes: %s',
    async (control) => {
      const source = `from pathlib import Path\n${control}\n    with open("outputs/result.json", "w") as f: f.write("{}")\nPath("outputs/result.json").read_bytes()`
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
        analyzedPythonPath('outputs/result.json')
      ])
    }
  )

  it.each(['a', 'a+', 'r+'])(
    'keeps the prior Python input for update mode %s before an alias read',
    async (mode) => {
      const source = `from pathlib import Path\nwith open("outputs/result.json", "${mode}") as f: f.write("{}")\nPath("outputs/result.json").read_bytes()`
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
        'outputs/result.json'
      ])
    }
  )

  it.each([
    ['inputs/data.json', 'inputs\\data.json', process.platform === 'win32'],
    ['inputs/data.json', 'inputs/./data.json', false],
    ['inputs/data.json', 'inputs/link/../data.json', false],
    ['inputs/data.json', 'inputs/DATA.json', false],
    ['C:data.json', 'C:/data.json', false],
    ['s3://bucket/data.json', 's3:\\\\bucket\\data.json', false],
    ['/vsimem/data.json', '\\vsimem\\data.json', false],
    ['\\\\?\\C:\\data.json', '//?/C:/data.json', false]
  ])(
    'preserves the Python identity boundary between %s and %s',
    async (written, read, equivalent) => {
      const source = `with open(${JSON.stringify(written)}, "w") as f: f.write("{}")\nwith open(${JSON.stringify(read)}) as f: data = f.read()`
      const result = await analyzeNotebookSourceFileAccess('python', source)
      if (String(written).startsWith('s3:') || String(written).startsWith('/vsi')) {
        expect(result.readState).toBe('partial')
      } else expect(result.reads).toEqual(equivalent ? [] : [read])
    }
  )

  it.each([
    'import os\nentries = list(os.walk("inputs"))',
    'from os import walk\nentries = list(walk("inputs"))',
    'import os\ndef listing():\n    return list(os.walk("inputs"))\nentries = listing()',
    'import os\ndef listing():\n    return list(os.walk("inputs", onerror=handler))\nentries = listing()'
  ])('retains uncertainty for data-producing directory walks: %s', async (source) => {
    const result = await analyzePythonNotebookSource(source)
    const fileAccess = await analyzeNotebookSourceFileAccess('python', source)
    const projection = projectNotebookDependencies([
      {
        run: {
          runId: 'walk-run',
          cellId: 'walk-cell',
          kernelKind: 'python',
          kernelEpochId: 'epoch-1',
          environment: 'default-python',
          script: source,
          status: 'completed',
          workingFiles: []
        },
        facts: result.facts,
        fileAccess
      }
    ])
    expect(projection.stalenessByRunId['walk-run'].state).toBe('unknown')
    expect(fileAccess).toMatchObject({
      readState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: []
    })
  })

  it('preserves the console-only directory diagnostic boundary', async () => {
    const source = 'import os\nfor root, dirs, files in os.walk("inputs"):\n    print(root, files)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: []
    })
  })

  it('reanalyzes facts cached under the earlier compact analyzer revision', async () => {
    const script = 'path = "inputs/current.json"'
    const parse = vi.spyOn(Parser.prototype, 'parse')
    const context = await fileContext(
      'python',
      [script],
      [],
      true,
      (json) => {
        const cache = JSON.parse(json)
        const previousRevision = 'scientific-lineage-hardening-20261013'
        cache.analyzerRevision = previousRevision
        cache.runs['run-0'].checksum = createHash('sha256')
          .update(
            JSON.stringify([
              1,
              previousRevision,
              'python',
              'default-python',
              'epoch-1',
              null,
              null,
              null,
              null,
              script,
              null,
              null,
              null
            ])
          )
          .digest('hex')
        cache.runs['run-0'].fileContext.staticStrings = [
          { name: 'path', value: 'inputs/stale.json' }
        ]
        return JSON.stringify(cache)
      },
      'epoch-1',
      undefined,
      () => parse.mockClear()
    )
    expect(parse).toHaveBeenCalled()
    expect(context?.staticStrings).toContainEqual({ name: 'path', value: 'inputs/current.json' })
    expect(context?.staticStrings).not.toContainEqual({ name: 'path', value: 'inputs/stale.json' })
  })
})

describe('partial notebook reader inputs after cache reload', () => {
  const bareLineReader = (reader = 'readLines'): string =>
    `read_header <- function(path) { lines <- ${reader}(path,n=1L,warn=FALSE); opaque(lines) }`

  it('retains the direct R header prefix before an opaque CSV tail', async () => {
    const source = [
      'read_csv_safe <- function(path) {',
      '  lines <- readLines(path, n = 1L, warn = FALSE)',
      '  hdr <- trimws(unlist(strsplit(lines, ",")))',
      '  utils::read.csv(path, header=TRUE, stringsAsFactors=FALSE, colClasses="numeric", check.names=FALSE)',
      '}',
      'obs <- read_csv_safe("inputs/observations.csv")'
    ].join('\n')
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([
      'inputs/observations.csv'
    ])
  })

  it.each(['readLines', 'base::readLines'])(
    'retains one direct R header prefix through %s',
    async (reader) => {
      const source = `${bareLineReader(reader)}\nread_header("inputs/first.csv")\nread_header("inputs/second.csv")`
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/first.csv'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const parsed = await analyzeRNotebookSource(source)
      expect(parsed.facts.state).toBe('unknown')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('read_header')
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'read_header("inputs/later.csv")', context))
          .reads
      ).toEqual([])
    }
  )

  it.each(['readLines', '<-', '{', 'function'])(
    'rejects a direct R header prefix after %s replacement',
    async (name) => {
      const replacement = `\`${name}\` <- function(...) NULL`
      const definition = bareLineReader()
      const call = 'read_header("inputs/phantom.csv")'
      const context = await fileContext('r', [replacement])
      for (const source of [
        `${replacement}\n${definition}\n${call}`,
        `${definition}\n${replacement}\n${call}`
      ])
        expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
      expect(
        (await analyzeNotebookSourceFileAccess('r', `${definition}\n${call}`, context)).reads
      ).toEqual([])
    }
  )

  it.each([
    [
      'formal reader',
      bareLineReader().replace('function(path)', 'function(path,readLines)'),
      'read_header("inputs/phantom.csv",NULL)'
    ],
    [
      'formal assignment',
      bareLineReader().replace('function(path)', 'function(path,`<-`)'),
      'read_header("inputs/phantom.csv",NULL)'
    ],
    [
      'formal brace',
      bareLineReader().replace('function(path)', 'function(path,`{`)'),
      'read_header("inputs/phantom.csv",NULL)'
    ],
    [
      'effectful option',
      bareLineReader().replace('n=1L', 'n=mutate()'),
      'read_header("inputs/phantom.csv")'
    ],
    ['zero lines', bareLineReader().replace('n=1L', 'n=0L'), 'read_header("inputs/phantom.csv")'],
    ['effectful argument', bareLineReader(), 'read_header(choose_path())'],
    [
      'package attachment',
      `suppressPackageStartupMessages(library(jsonlite))\n${bareLineReader()}`,
      'read_header("inputs/phantom.csv")'
    ],
    ['opaque predecessor', `mutate()\n${bareLineReader()}`, 'read_header("inputs/phantom.csv")'],
    ['stream', bareLineReader(), 'read_header("stdin")'],
    ['remote', bareLineReader(), 'read_header("https://example.test/data.csv")'],
    [
      'lazy wrapper',
      bareLineReader().replace(
        'lines <- readLines(path,n=1L,warn=FALSE)',
        'lines <- ignore(readLines(path,n=1L,warn=FALSE))'
      ),
      'read_header("inputs/phantom.csv")'
    ]
  ])('rejects an unproven direct R header prefix: %s', async (_, definition, call) => {
    expect((await analyzeNotebookSourceFileAccess('r', `${definition}\n${call}`)).reads).toEqual([])
  })

  const numericCsvReader = [
    'read_numeric <- function(path) {',
    '  hdr <- strsplit(readLines(path,n=1L,warn=FALSE),",")[[1]]',
    '  list(header=hdr,data=utils::read.csv(path,header=TRUE,stringsAsFactors=FALSE,colClasses="numeric"))',
    '}'
  ].join('\n')

  it.each([
    'read_numeric("inputs/second.csv")',
    'next_data <- read_numeric(path="inputs/second.csv")'
  ])('retains repeated numeric CSV helper inputs: %s', async (second) => {
    const source = `${numericCsvReader}\nfirst_data <- read_numeric("inputs/first.csv")\n${second}`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/first.csv', 'inputs/second.csv'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const parsed = await analyzeRNotebookSource(source)
    expect(parsed.facts.state).toBe('unknown')
    expect(parsed.facts.safeCallNames ?? []).not.toContain('read_numeric')
    const context = await fileContext('r', [source])
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'read_numeric("inputs/later.csv")', context))
        .reads
    ).toEqual([])
  })

  it.each([
    [
      'effectful tail option',
      (s: string) => s.replace('colClasses="numeric"', 'colClasses=mutate()')
    ],
    [
      'custom column class',
      (s: string) => s.replace('colClasses="numeric"', 'colClasses="custom"')
    ],
    ['missing column class', (s: string) => s.replace(',colClasses="numeric"', '')],
    ['bare CSV reader', (s: string) => s.replace('utils::read.csv', 'read.csv')],
    ['different tail path', (s: string) => s.replace('read.csv(path,', 'read.csv(other,')],
    [
      'tail return wrapper',
      (s: string) => s.replace('  list(', '  return(list(').replace('"numeric"))', '"numeric")))')
    ],
    ['opaque return constructor', (s: string) => s.replace('  list(', '  make_result(')],
    ['effectful header argument', (s: string) => s.replace('header=hdr', 'header=mutate(hdr)')],
    ['extra tail statement', (s: string) => s.replace('\n}', '\n  mutate()\n}')],
    ['extra list element', (s: string) => s.replace('list(header=', 'list(extra=mutate(),header=')],
    ['header shadows list', (s: string) => s.replaceAll('hdr', 'list')],
    ['namespace shadow formal', (s: string) => s.replace('function(path)', 'function(path,`::`)')]
  ])('does not repeat a CSV reader with %s', async (_, change) => {
    const source = `${change(numericCsvReader)}\nread_numeric("inputs/first.csv")\nread_numeric("inputs/second.csv")`
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).not.toContain(
      'inputs/second.csv'
    )
  })

  it.each([
    'mutate()',
    'read_numeric <- replacement',
    'alias <- read_numeric',
    'readLines <- replacement',
    '`::` <- replacement',
    'read_numeric <- read_numeric("inputs/replacement.csv")',
    'read_numeric(choose_path())'
  ])('consumes repeated CSV authority after %s', async (intervening) => {
    const source = `${numericCsvReader}\nread_numeric("inputs/first.csv")\n${intervening}\nread_numeric("inputs/second.csv")`
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).not.toContain(
      'inputs/second.csv'
    )
  })

  it('does not preserve other CSV helpers across a repeated-reader call', async () => {
    const source = `${numericCsvReader}\n${numericCsvReader.replace('read_numeric <-', 'other_reader <-')}\nread_numeric("inputs/first.csv")\nother_reader("inputs/second.csv")`
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['inputs/first.csv'])
  })

  it('retains only the next first read after the CSV return constructor is rebound', async () => {
    const source = `${numericCsvReader}\nread_numeric("inputs/first.csv")\nlist <- replacement\nread_numeric("inputs/second.csv")\nread_numeric("inputs/third.csv")`
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([
      'inputs/first.csv',
      'inputs/second.csv'
    ])
  })

  it('does not retain repeated CSV authority with a cached list replacement', async () => {
    const context = await fileContext('r', ['list <- replacement'])
    const source = `${numericCsvReader}\nread_numeric("inputs/first.csv")\nread_numeric("inputs/second.csv")`
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).reads).not.toContain(
      'inputs/second.csv'
    )
  })

  const headerReader = (reader = 'readLines', split = 'strsplit'): string =>
    `read_header <- function(path) { header <- ${split}(${reader}(path,n=1L,warn=FALSE),",")[[1]]; opaque(header) }`

  it.each([
    ['readLines', 'strsplit'],
    ['base::readLines', 'strsplit'],
    ['readLines', 'base::strsplit'],
    ['base::readLines', 'base::strsplit']
  ])('retains one nested R header read through %s and %s', async (reader, split) => {
    const source = `${headerReader(reader, split)}\nread_header("inputs/first.csv")\nread_header("inputs/later.csv")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/first.csv'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const parsed = await analyzeRNotebookSource(source)
    expect(parsed.facts.state).toBe('unknown')
    expect(parsed.facts.safeCallNames ?? []).not.toContain('read_header')
    const context = await fileContext('r', [source])
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'read_header("inputs/cached.csv")', context))
        .reads
    ).toEqual([])
  })

  it.each(['readLines', 'strsplit', '[[', '<-', '{', '::'])(
    'rejects nested R header reads after same-cell or cached %s replacement',
    async (name) => {
      const replacement = `\`${name}\` <- function(...) NULL`
      const source = `${headerReader()}\nread_header("inputs/phantom.csv")`
      expect(
        (await analyzeNotebookSourceFileAccess('r', `${replacement}\n${source}`)).reads
      ).toEqual([])
      const context = await fileContext('r', [replacement])
      expect((await analyzeNotebookSourceFileAccess('r', source, context)).reads).toEqual([])
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            'r',
            `${headerReader()}\n${replacement}\nread_header("inputs/phantom.csv")`
          )
        ).reads
      ).toEqual([])
    }
  )

  it.each([
    [
      'formal shadows wrapper',
      headerReader().replace('function(path)', 'function(path,strsplit)'),
      'read_header("inputs/phantom.csv",NULL)'
    ],
    [
      'formal shadows reader',
      headerReader().replace('function(path)', 'function(path,readLines)'),
      'read_header("inputs/phantom.csv",NULL)'
    ],
    [
      'formal shadows assignment',
      headerReader().replace('function(path)', 'function(path,`<-`)'),
      'read_header("inputs/phantom.csv",NULL)'
    ],
    ['lazy wrapper', headerReader('readLines', 'ignore'), 'read_header("inputs/phantom.csv")'],
    [
      'effectful split',
      headerReader().replace(',",")', ',mutate())'),
      'read_header("inputs/phantom.csv")'
    ],
    [
      'effectful index',
      headerReader().replace('[[1]]', '[[mutate()]]'),
      'read_header("inputs/phantom.csv")'
    ],
    [
      'effectful n',
      headerReader().replace('n=1L', 'n=mutate()'),
      'read_header("inputs/phantom.csv")'
    ],
    ['zero n', headerReader().replace('n=1L', 'n=0L'), 'read_header("inputs/phantom.csv")'],
    ['effectful argument', headerReader(), 'read_header(choose_path())'],
    ['non-file connection', headerReader(), 'read_header("stdin")'],
    ['remote connection', headerReader(), 'read_header("https://example.test/data.csv")'],
    [
      'opaque preceding statement',
      headerReader().replace('{ header', '{ mutate(); header'),
      'read_header("inputs/phantom.csv")'
    ]
  ])('rejects an unproven nested R header read: %s', async (_, definition, call) => {
    expect((await analyzeNotebookSourceFileAccess('r', `${definition}\n${call}`)).reads).toEqual([])
  })

  it.each(['path', 'base::gzfile(path)', 'base::gzfile(open="rb",description=path)'])(
    'retains one R local-path prefix input without exporting its candidate: %s',
    async (file) => {
      const definition = `read_events <- function(input_dir) { path <- base::file.path(input_dir,"events.csv.gz"); utils::read.csv(${file},stringsAsFactors=FALSE) }`
      const source = `${definition}\nread_events("inputs")\nread_events("later")`
      const prior = await fileContext('r', ['input_dir <- "decoy"', 'path <- "inputs/decoy.csv"'])
      expect(await analyzeNotebookSourceFileAccess('r', source, prior)).toMatchObject({
        reads: ['inputs/events.csv.gz'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const parsed = await analyzeRNotebookSource(source, prior)
      expect(parsed.facts.state).toBe('unknown')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('read_events')
      expect(parsed.fileAccess?.context.localFileWrappers).toEqual([])
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'read_events("other")', context)).reads
      ).toEqual([])
    }
  )

  it.each(['..0', '..1', '..01', '..20'])(
    'rejects an R local-path prefix using special dots formal %s',
    async (formal) => {
      const source = `read_events <- function(${formal}) { path <- base::file.path(${formal},"events.csv.gz"); utils::read.csv(path) }\nread_events("inputs")`
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each(['::', '<-', '=', '{', 'function'])(
    'rejects an R local-path prefix after cached primitive %s rebinding',
    async (name) => {
      const context = await fileContext('r', [`\`${name}\` <- replacement`])
      const source =
        'read_events <- function(input_dir) { path <- base::file.path(input_dir,"events.csv.gz"); utils::read.csv(base::gzfile(path)) }\nread_events("inputs")'
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('resolves a Python method-chain reader against a prior static path', async () => {
    const context = await fileContext('python', ['matrix_path = "outputs/weights.mtx"'])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from scipy.io import mmread\ndef reopen_matrix(path):\n    return mmread(path).tocsr()\nweights = reopen_matrix(matrix_path)',
        context
      )
    ).toMatchObject({
      reads: ['outputs/weights.mtx'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not propagate an R composed-reader candidate to a later cell', async () => {
    const definition =
      'read_events <- function(input_dir) { events <- utils::read.csv(base::gzfile(base::file.path(input_dir,"events.csv.gz"))); stopifnot(nrow(events)>0L); events }'
    const source = `${definition}\nread_events("inputs")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/events.csv.gz'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const context = await fileContext('r', [source])
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'read_events("later")', context)).reads
    ).toEqual([])
  })

  it('retains a statically named writer after a helper first read', async () => {
    const source = [
      'read_and_export <- function(input_dir) {',
      '  observations <- utils::read.csv(base::file.path(input_dir, "observations.csv"))',
      '  utils::write.csv(observations, base::file.path("outputs", "observations.csv"), row.names=FALSE)',
      '  observations',
      '}',
      'read_and_export("inputs")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/observations.csv'],
      writes: ['outputs/observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'replays a zero-argument jsonlite writer helper',
      'emit <- function() { jsonlite::write_json(list(value=1), "outputs/result.json") }; emit()',
      { reads: [], writes: ['outputs/result.json'] }
    ],
    [
      'replays a writer helper with an opaque dynamic payload and static file.path output',
      [
        'write_observations <- function() {',
        '  observations <- datasets::faithful',
        '  payload <- list(',
        '    eruptions = unname(observations[, "eruptions"]),',
        '    waiting = unname(observations[, "waiting"])',
        '  )',
        '  jsonlite::write_json(',
        '    payload,',
        '    path=base::file.path("outputs", "observations.json"),',
        '    auto_unbox=TRUE,',
        '    digits=8,',
        '    pretty=FALSE',
        '  )',
        '}',
        'write_observations()'
      ].join('\n'),
      { reads: [], writes: ['outputs/observations.json'] }
    ],
    [
      'replays a zero-argument jsonlite reader helper',
      'load <- function() { jsonlite::read_json("inputs/result.json") }; load()',
      { reads: ['inputs/result.json'], writes: [] }
    ],
    [
      'replays a zero-argument jsonlite fromJSON helper',
      'load <- function() { jsonlite::fromJSON("inputs/result.json") }; load()',
      { reads: ['inputs/result.json'], writes: [] }
    ]
  ])('%s', async (_label, source, expected) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      ...expected,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'does not replay a helper with arguments',
      'emit <- function(path) { jsonlite::write_json(list(value=1), path) }; emit()'
    ],
    [
      'does not replay a fromJSON helper with a dynamic path',
      'load <- function(path) { jsonlite::fromJSON(path) }; load()'
    ],
    [
      'does not treat inline JSON as a fromJSON file path',
      'load <- function() { jsonlite::fromJSON("{\\"value\\":1}") }; load()'
    ],
    [
      'does not replay a helper with a dynamic path',
      'emit <- function() { jsonlite::write_json(list(value=1), paste0("outputs", "/result.json")) }; emit()'
    ],
    [
      'does not replay a helper under control flow',
      'emit <- function() { if (TRUE) jsonlite::write_json(list(value=1), "outputs/result.json") }; emit()'
    ],
    [
      'does not replay a helper after rebinding',
      'emit <- function() { jsonlite::write_json(list(value=1), "outputs/result.json") }; emit <- function() NULL; emit()'
    ],
    [
      'does not replay a writer helper with an opaque local payload call',
      'emit <- function() { payload <- make_payload(); jsonlite::write_json(payload, "outputs/result.json") }; emit()'
    ]
  ])('%s', async (_label, source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it('retains file reads from Python assert messages', async () => {
    const source = 'assert True, open("inputs/assert-message.txt").read()'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['inputs/assert-message.txt'],
      readState: 'complete'
    })
  })

  it.each(['file.path', 'base::file.path'])(
    'retains a JSON helper local %s output without certifying a write',
    async (constructor) => {
      const source = [
        'observations <- datasets::faithful',
        'export_observations <- function() {',
        `  destination <- ${constructor}("outputs", "observations.json")`,
        '  payload <- list(values=observations)',
        '  jsonlite::write_json(payload, path=destination, auto_unbox=TRUE)',
        '  invisible(destination)',
        '}',
        'export_observations()',
        'jsonlite::read_json("outputs/observations.json")'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['outputs/observations.json'],
        writes: ['outputs/observations.json'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const parsed = await analyzeRNotebookSource(source)
      expect(parsed.facts.state).toBe('unknown')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('export_observations')
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'export_observations()', context)).writes
      ).toEqual([])
    }
  )

  it.each(['fromJSON', 'read_json'])(
    'resolves a stable outer JSON path when invoking %s',
    async (reader) => {
      const source = [
        'input_path <- file.path("inputs", "measurements.json")',
        `load_measurements <- function() { jsonlite::${reader}(input_path, simplifyVector=FALSE) }`,
        'measurements <- load_measurements()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/measurements.json'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'load_measurements()', context)).reads
      ).toEqual([])
    }
  )

  it.each([
    'input_path <- "inputs/old.json"; opaque(); load <- function() jsonlite::fromJSON(input_path); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); opaque(); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); input_path <- "inputs/new.json"; load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); input_path[1] <- "inputs/new.json"; load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); rm(load); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); assign("load", replacement); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); if (flag) load()',
    'input_path <- "inputs/old.json"; if (flag) load <- function() jsonlite::fromJSON(input_path); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); alias <- load; alias()',
    'input_path <- "{\\"n\\":1}"; load <- function() jsonlite::fromJSON(input_path); load()',
    'load <- function() { path <- file.path("inputs", "a.json"); path <- dynamic; jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); opaque(); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); jsonlite::read_json(path, simplifyVector={path <- "other"; TRUE}) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); jsonlite::read_json(path, ...) }; load()',
    'file.path <- replacement; load <- function() { path <- file.path("inputs", "a.json"); jsonlite::read_json(path) }; load()',
    'load <- function() { file.path <- replacement; path <- file.path("inputs", "a.json"); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- other::file.path("inputs", "a.json"); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("https://example.invalid", "a.json"); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", unknown); jsonlite::read_json(path) }; load()',
    'input_path <- "inputs/old.json"; load <- function() { info <- base::names(data); jsonlite::fromJSON(input_path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); info <- nrow(data); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); info <- data$value; jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); info <- c(data); jsonlite::read_json(path) }; load()',
    'load <- function() { ..1 <- "inputs/a.json"; jsonlite::read_json(..1) }; load()',
    'nrow <- replacement; emit <- function() { path <- file.path("outputs", "a.json"); payload <- list(n=nrow(data)); jsonlite::write_json(payload, path) }; emit()'
  ])('rejects uncertain JSON helper path authority: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it.each(['fromJSON', 'read_json'])(
    'retains only the first literal %s input before an opaque helper tail',
    async (reader) => {
      const source = [
        'load_centered <- function() {',
        '  obs <- jsonlite::' + reader + '("outputs/observations.json")',
        '  x <- as.numeric(obs$eruptions)',
        '  jsonlite::read_json("inputs/later.json")',
        '  jsonlite::write_json(x, "outputs/later.json")',
        '  x - mean(x)',
        '}',
        'centered <- load_centered()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['outputs/observations.json'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const parsed = await analyzeRNotebookSource(source)
      expect(parsed.facts.state).toBe('unknown')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('load_centered')
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'load_centered()', context)).reads
      ).toEqual([])
    }
  )

  it.each(['"inputs/a.json"', 'file.path("inputs", "a.json")'])(
    'retains a static local path prefix for a %s helper input before an opaque tail',
    async (pathExpression) => {
      const source = [
        'load <- function() {',
        `  path <- ${pathExpression}`,
        '  value <- jsonlite::fromJSON(path)',
        '  opaque(value)',
        '}',
        'load()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/a.json'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each(['TRUE', 'FALSE'])(
    'retains a literal JSON input with simplifyVector=%s before an opaque tail',
    async (simplifyVector) => {
      const source = [
        'load <- function() {',
        `  value <- jsonlite::fromJSON("inputs/a.json", simplifyVector=${simplifyVector})`,
        '  opaque(value)',
        '}',
        'load()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/a.json'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('retains multiple stable JSON helper inputs in one cell', async () => {
    const source = [
      'read_obs <- function() {',
      '  value <- jsonlite::fromJSON("outputs/observations.json", simplifyVector=TRUE)',
      '  list(eruptions = as.numeric(value$eruptions))',
      '}',
      'read_reg <- function() {',
      '  value <- jsonlite::fromJSON("outputs/regression.json", simplifyVector=FALSE)',
      '  list(slope = as.numeric(value$slope))',
      '}',
      'observations <- read_obs()',
      'regression <- read_reg()',
      'opaque(observations, regression)'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['outputs/observations.json', 'outputs/regression.json'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('retains JSON helper candidates across known scientific calls', async () => {
    const source = [
      'read_reg <- function() { path <- file.path("outputs", "regression.json"); jsonlite::read_json(path, simplifyVector=TRUE) }',
      'read_obs <- function() { path <- file.path("outputs", "observations.json"); jsonlite::read_json(path, simplifyVector=TRUE) }',
      'data(faithful, envir=environment())',
      'n_obs <- nrow(faithful)',
      'fit <- stats::lm(waiting ~ eruptions, data=faithful)',
      'slope <- unname(stats::coef(fit)["eruptions"])',
      'correlation <- stats::cor(faithful$eruptions, faithful$waiting)',
      'regression <- read_reg()',
      'observations <- read_obs()'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['outputs/observations.json', 'outputs/regression.json'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each(['stats::predict(model)', 'data <- replacement; data(faithful)', 'values["name"]'])(
    'clears JSON helper authority after an uncertain call: %s',
    async (call) => {
      const source = [
        'load <- function() { jsonlite::fromJSON("inputs/result.json") }',
        call,
        'load()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: [],
        writes: []
      })
    }
  )

  it.each(['jsonlite::fromJSON(txt="inputs/a.json")', 'jsonlite::read_json(path="inputs/a.json")'])(
    'retains an exactly named first JSON input: %s',
    async (reader) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          'load <- function() { ' + reader + '; opaque() }; load()'
        )
      ).toMatchObject({ reads: ['inputs/a.json'], writes: [], readState: 'partial' })
    }
  )

  it.each([
    'load <- function(p) { jsonlite::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function(p=opaque()) { jsonlite::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function() { opaque(); jsonlite::fromJSON("inputs/a.json") }; load()',
    'load <- function() { if (flag) jsonlite::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function() { path <- dynamic; jsonlite::fromJSON(path); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON(file.path("inputs", "a.json")); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("null"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("https://example.invalid/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON(t="inputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::read_json(p="inputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json", simplifyVector=opaque()); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json", simplifyVector=flag); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json", flatten=TRUE); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json", ...); opaque() }; load()',
    'load <- function() { jsonlite:::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::write_json(data,"outputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; load <- replacement; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; alias <- load; alias()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; opaque(); load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; if (flag) load()',
    'if (flag) load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; load(unexpected=1)'
  ])('rejects uncertain first JSON read authority: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it('consumes other JSON helper candidates after an opaque tail', async () => {
    const source = [
      'later <- function() { jsonlite::fromJSON("inputs/later.json"); opaque() }',
      'load <- function() { jsonlite::fromJSON("inputs/first.json"); opaque() }',
      'load()',
      'later()',
      'load()'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/first.json', 'inputs/later.json'],
      writes: [],
      readState: 'partial'
    })
  })

  it.each(['::', 'function', '{', '<-', '='])(
    'rejects a first JSON input with shadowed primitive %s',
    async (primitive) => {
      const source =
        'load <- function() { obs <- jsonlite::fromJSON("inputs/a.json"); as.numeric(obs$x) }; load()'
      const binding =
        String.fromCharCode(96) + primitive + String.fromCharCode(96) + ' <- replacement'
      expect((await analyzeNotebookSourceFileAccess('r', binding + '; ' + source)).reads).toEqual(
        []
      )
      const context = await fileContext('r', [binding])
      expect((await analyzeNotebookSourceFileAccess('r', source, context)).reads).toEqual([])
    }
  )

  it('consumes the old JSON helper before rebinding its result', async () => {
    const source =
      'path <- "inputs/result.json"; load <- function() jsonlite::fromJSON(path); load <- load(); load()'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/result.json'],
      readState: 'partial'
    })
  })

  it.each(['::', 'function', '{', '<-', '='])(
    'rejects a JSON helper after cached primitive %s shadowing',
    async (primitive) => {
      const context = await fileContext('r', [`\`${primitive}\` <- replacement`])
      const source =
        'input_path <- "inputs/a.json"; load <- function() jsonlite::fromJSON(input_path); load()'
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        reads: [],
        writes: []
      })
    }
  )

  it.each([
    [
      'does not promote an unreachable writer',
      'if (FALSE) utils::write.csv(observations, "outputs/observations.csv")',
      'read_and_export("inputs")',
      ['inputs/observations.csv']
    ],
    [
      'does not descend into an unforced call argument',
      '(function(unused) NULL)(utils::write.csv(observations, "outputs/observations.csv"))',
      'read_and_export("inputs")',
      ['inputs/observations.csv']
    ],
    [
      'does not retain output when helper arguments do not match',
      'utils::write.csv(observations, "outputs/observations.csv")',
      'read_and_export(unknown="inputs")',
      []
    ],
    [
      'does not trust a writer after a local namespace rebind',
      '`::` <- function(...) NULL; utils::write.csv(observations, "outputs/observations.csv")',
      'read_and_export("inputs")',
      ['inputs/observations.csv']
    ],
    [
      'does not scan writers after an intervening statement',
      'summary <- nrow(observations); utils::write.csv(observations, "outputs/observations.csv")',
      'read_and_export("inputs")',
      ['inputs/observations.csv']
    ]
  ])('%s', async (_label, statement, invocation, reads) => {
    const source = [
      'read_and_export <- function(input_dir) {',
      '  observations <- utils::read.csv(base::file.path(input_dir, "observations.csv"))',
      `  ${statement}`,
      '  observations',
      '}',
      invocation
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads,
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('rejects a composed R reader after a cached namespace operator rebind', async () => {
    const context = await fileContext('r', ['`::` <- function(...) NULL'])
    const source =
      'read_events <- function(input_dir) { events <- utils::read.table(base::file.path(input_dir,"events.csv")); events }\nread_events("inputs")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('R known-empty for semantics across cached cells', () => {
  it.each([
    ...['break', 'next', 'return(NULL)', ''].map((exit) => ({
      label: `unreachable path assignment with ${exit || 'no early exit'}`,
      loop: `for(unused in c()) { path <- "inputs/decoy.csv"; ${exit} }`,
      writes: []
    })),
    {
      label: 'unreachable writer with break',
      loop: 'for(unused in c()) { utils::write.table(1,"outputs/result.csv"); break }',
      writes: []
    },
    {
      label: 'unreachable constructor binding before another empty loop',
      loop: 'for(unused in c()) { c <- function(...) "x"; break }\nfor(other in c()) utils::write.table(1,"outputs/result.csv")',
      writes: []
    }
  ])('preserves $label in complete cold/warm four-cell facts', async ({ loop, writes }) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
    roots.push(storageRoot)
    // Handwritten repository records; the source enum is not model/native evidence.
    const scripts = ['marker <- 1', 'path <- "inputs/observations.csv"', loop, 'read.csv(path)']
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'r',
      kernelEpochId: 'epoch-1',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      executionCount: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = { projectId: 'default-project', sessionId: 'session-1' }
    const parse = vi.spyOn(Parser.prototype, 'parse')
    const coldProjection = await new NotebookDependencyAnalyzer({
      storageRoot,
      repository
    }).project(request)
    expect(parse).toHaveBeenCalledTimes(4)
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    const cold = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
    expect(cold.runs['run-2'].facts.definedNames).toContain('unused')
    expect(cold.runs['run-2'].facts.definedNames).not.toContain('path')
    expect(cold.runs['run-2'].facts.conditionallyDefinedNames ?? []).not.toContain('path')
    expect(cold.runs['run-3'].fileAccess).toMatchObject({
      reads: ['inputs/observations.csv'],
      writes: []
    })
    parse.mockClear()
    const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
    expect(await warm.project(request)).toEqual(coldProjection)
    expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
    const context = await warm.sourceFileAccessContext({
      ...request,
      currentRunId: 'run-3',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    })
    expect(parse).not.toHaveBeenCalled()
    expect(context?.staticStrings).toContainEqual({
      name: 'path',
      value: 'inputs/observations.csv'
    })
    expect(await analyzeNotebookSourceFileAccess('r', scripts[3], context)).toEqual(
      cold.runs['run-3'].fileAccess
    )
  })
})

describe('R loop target handle invalidation across cached cells', () => {
  const replacement = '`{` <- function(...) NULL'
  const writer = 'for (target in c("outputs/result.csv")) utils::write.table(1,target)'
  const reader = 'for (target in c("inputs/observations.csv")) read.csv(target)'
  const variants = [
    { label: 'trusted', prior: 'n <- 1', prefix: '' },
    { label: 'same-cell conditional', prior: 'n <- 1', prefix: replacement + '\n' },
    { label: 'restored conditional', prior: replacement, prefix: '' }
  ]

  it.each([
    ...variants.map(({ label, prior, prefix }) => ({
      label: `${label} connection target writer`,
      prior,
      source: `target <- file("inputs/observations.csv")\nold <- target\n${prefix}{ ${writer} }\nclose(old)\nread.csv("inputs/observations.csv")`,
      reads: ['inputs/observations.csv'],
      writes: ['outputs/result.csv'],
      partial: true
    })),
    ...variants.map(({ label, prior, prefix }) => ({
      label: `${label} in-memory target reader`,
      prior,
      source: `target <- textConnection("n\\n1")\nold <- target\n${prefix}{ ${reader} }\nclose(old)\nread.csv("inputs/phantom.csv")`,
      reads: ['inputs/observations.csv', 'inputs/phantom.csv'],
      writes: [],
      partial: true
    })),
    {
      label: 'early-exit fallback drops the unrelated old connection',
      prior: 'n <- 1',
      source:
        'target <- file("inputs/decoy.csv")\nold <- target\n' +
        'for (target in c("inputs/observations.csv")) { read.csv(target); break }\n' +
        'close(old)\nread.csv("inputs/phantom.csv")',
      reads: ['inputs/phantom.csv'],
      writes: [],
      partial: true
    },
    {
      label: 'empty loop preserves the other-symbol connection alias',
      prior: 'n <- 1',
      source:
        'target <- file("inputs/observations.csv")\nold <- target\n' +
        'for (target in c()) utils::write.table(1,target)\n' +
        'close(old)\nread.csv("inputs/observations.csv")',
      reads: ['inputs/observations.csv'],
      writes: [],
      partial: true
    },
    {
      label: 'ordinary string target keeps its body destination',
      prior: 'n <- 1',
      source: `target <- "inputs/observations.csv"\n{ ${writer} }\nread.csv("inputs/observations.csv")`,
      reads: ['inputs/observations.csv'],
      writes: ['outputs/result.csv'],
      partial: false
    },
    {
      label: 'next element replaces the connection created by the body',
      prior: 'n <- 1',
      source:
        'for (target in c("outputs/first.csv","outputs/second.csv")) { ' +
        'utils::write.table(1,target); target <- file("inputs/observations.csv") }\n' +
        'read.csv("inputs/observations.csv")',
      reads: ['inputs/observations.csv'],
      writes: ['outputs/first.csv', 'outputs/second.csv'],
      partial: false
    },
    {
      label: 'next element replaces the in-memory input created by the body',
      prior: 'n <- 1',
      source:
        'for (target in c("inputs/observations.csv","inputs/phantom.csv")) { ' +
        'read.csv(target); target <- textConnection("n\\n1") }',
      reads: ['inputs/observations.csv', 'inputs/phantom.csv'],
      writes: [],
      partial: false
    }
  ])(
    'preserves $label in cold and warm four-cell facts',
    async ({ prior, source, reads, writes, partial }) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      // Handwritten analysis records; the source enum does not imply model or native execution.
      const runs: NotebookRunRecord[] = ['marker <- 1', prior, source, 'marker <- 2'].map(
        (script, index) => ({
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          inputKind: 'cell',
          kernelKind: 'r',
          kernelEpochId: 'epoch-1',
          environment: 'default-r',
          script,
          status: 'completed',
          startedAt: index,
          endedAt: index,
          executionCount: index,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: [],
          inputFiles: []
        })
      )
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).toHaveBeenCalledTimes(4)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-2'].fileAccess).toMatchObject({
        reads,
        writes,
        readState: partial ? 'partial' : 'complete',
        writeState: partial ? 'partial' : 'complete',
        externalState: partial ? 'partial' : 'complete'
      })
      if (partial) expect(cold.runs['run-2'].facts.state).toBe('unknown')
      parse.mockClear()
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-2',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      if (prior === replacement) expect(context?.resolvedKernelNames).toContain('{')
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toEqual(
        cold.runs['run-2'].fileAccess
      )
    }
  )
})

describe('R loop target helper invalidation', () => {
  it.each([
    {
      label: 'namespace-after',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (`::` in list(function(pkg,name) function(...) NULL)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'namespace-before',
      definition: 'n <- 1',
      call: 'for (`::` in list(function(pkg,name) function(...) NULL)) {}\nemit <- function(x,file) utils::write.table(x,file)\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'bare-csv-namespace',
      definition: 'emit <- function(x,file) write.csv(x,file)',
      call: 'for (`::` in list(function(pkg,name) function(...) NULL)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'helper-loop-target',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (emit in list(function(...) NULL)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'bare-writer-loop-target',
      definition: 'emit <- function(x,file) write.table(x,file)',
      call: 'for (write.table in list(function(...) NULL)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'qualified-member-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (write.table in list(function(...) NULL)) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    },
    {
      label: 'unrelated-target-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (unused in list(function(...) NULL)) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    },
    {
      label: 'empty-sequence-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (`::` in c()) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    },
    {
      label: 'shadowed-names-empty-proof',
      definition:
        'emit <- function(x,file) utils::write.table(x,file)\nv <- list()\nnames <- function(x) list(function(pkg,name) function(...) NULL)',
      call: 'for (`::` in names(v)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'shadowed-namespace-empty-proof',
      definition:
        'emit <- function(x,file) utils::write.table(x,file)\n`:::` <- function(pkg,name) function(...) list(function(pkg,name) function(...) NULL)',
      call: 'for (`::` in base:::list()) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'trusted-empty-names-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'v <- list()\nfor (`::` in names(v)) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    },
    {
      label: 'loop-body-binding',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (`::` in list(function(pkg,name) function(...) NULL)) { emit(1,"inputs/observations.csv") }\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'stored-shadowed-names-empty-proof',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'v <- list()\nnames <- function(x) list(function(pkg,name) function(...) NULL)\nitems <- names(v)\nfor (`::` in items) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'stored-shadowed-namespace-empty-proof',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: '`:::` <- function(pkg,name) function(...) list(function(pkg,name) function(...) NULL)\nitems <- base:::list()\nfor (`::` in items) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'stored-trusted-empty-alias-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'items <- base:::list()\nitems_alias <- items\n`:::` <- function(pkg,name) function(...) list(function(pkg,name) function(...) NULL)\nfor (`::` in items_alias) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    }
  ])('preserves $label in cold and warm four-cell facts', async ({ definition, call, writes }) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
    roots.push(storageRoot)
    // Rebinding and invocation share a cell: prior-cell facts already revoke names.
    const scripts = ['marker <- 1', definition, call, 'n <- 2']
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'r',
      kernelEpochId: 'epoch-1',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      executionCount: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = { projectId: 'default-project', sessionId: 'session-1' }
    const parse = vi.spyOn(Parser.prototype, 'parse')
    const coldProjection = await new NotebookDependencyAnalyzer({
      storageRoot,
      repository
    }).project(request)
    expect(parse).toHaveBeenCalledTimes(4)
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    const cold = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(cold.runs['run-2'].fileAccess.reads).toEqual(['inputs/observations.csv'])
    expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
    parse.mockClear()
    const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
    expect(await warm.project(request)).toEqual(coldProjection)
    expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
    const context = await warm.sourceFileAccessContext({
      ...request,
      currentRunId: 'run-2',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    })
    expect(parse).not.toHaveBeenCalled()
    expect(await analyzeNotebookSourceFileAccess('r', call, context)).toEqual(
      cold.runs['run-2'].fileAccess
    )
  })
})

describe('R loop sequence helper candidates across cached cells', () => {
  const prefix = 'reader <- function(file) { data <- utils::read.csv(file); file }'
  const alias = 'reader <- function(file="") utils::read.csv(file=file)\nalias <- reader'
  const writer = 'emit <- function(x,file="") utils::write.table(x,file=file)\nalias <- emit'

  it.each([
    {
      label: 'prefix sequence before loop target rebinding',
      source: `${prefix}\nfor (reader in reader("inputs/first.csv")) {}`,
      reads: ['inputs/first.csv'],
      writes: []
    },
    {
      label: 'reader alias sequence before loop target rebinding',
      source: `${alias}\nfor (alias in alias(file="inputs/first.csv")) {}`,
      reads: ['inputs/first.csv'],
      writes: []
    },
    {
      label: 'possible writer sequence retains a later same-path read',
      source: `${writer}\nfor (unused in alias(1,file="outputs/result.csv")) {}\nread.csv("outputs/result.csv")`,
      reads: ['outputs/result.csv'],
      writes: ['outputs/result.csv']
    },
    {
      label: 'shadowed for does not force its prefix sequence',
      source: `\`for\` <- function(...) NULL\n${prefix}\nfor (unused in reader("inputs/decoy.csv")) {}`,
      reads: [],
      writes: []
    },
    {
      label: 'outer consume does not force its reader alias promise',
      source: `${alias}\nconsume <- function(...) NULL\nfor (unused in consume(alias(file="inputs/decoy.csv"))) {}`,
      reads: [],
      writes: []
    },
    {
      label: 'prefix sequence consumes authority before body and later calls',
      source: `${prefix}\nfor (unused in reader("inputs/first.csv")) { reader("inputs/body.csv") }\nreader("inputs/later.csv")`,
      reads: ['inputs/first.csv'],
      writes: []
    },
    {
      label: 'alias sequence consumes authority before body and later calls',
      source: `${alias}\nfor (unused in alias(file="inputs/first.csv")) { alias(file="inputs/body.csv") }\nalias(file="inputs/later.csv")`,
      reads: ['inputs/first.csv'],
      writes: []
    },
    {
      label: 'empty sequence does not restore prefix or alias candidates',
      source:
        'prefix_reader <- function(file) { data <- utils::read.csv(file); file }\n' +
        `${alias}\nfor (unused in NULL) {}\nprefix_reader("inputs/later.csv")\nalias(file="inputs/alias-later.csv")`,
      reads: [],
      writes: []
    }
  ])('preserves $label in cold and warm four-cell facts', async ({ source, reads, writes }) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
    roots.push(storageRoot)
    // Handwritten analysis history: declarations and the first sequence call share cell three.
    const scripts = ['marker <- 1', 'prior <- 2', source, 'n <- 3']
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'r',
      kernelEpochId: 'epoch-1',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      executionCount: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = { projectId: 'default-project', sessionId: 'session-1' }
    const parse = vi.spyOn(Parser.prototype, 'parse')
    const coldProjection = await new NotebookDependencyAnalyzer({
      storageRoot,
      repository
    }).project(request)
    expect(parse).toHaveBeenCalledTimes(4)
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    const cold = JSON.parse(await readFile(cachePath, 'utf8'))
    const runIds = runs.map(({ runId }) => runId).sort()
    expect(Object.keys(cold.runs).sort()).toEqual(runIds)
    expect(Object.keys(coldProjection.stalenessByRunId).sort()).toEqual(runIds)
    expect(cold.runs['run-2'].fileAccess).toMatchObject({
      reads,
      writes,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(cold.runs['run-2'].facts.state).toBe('unknown')
    expect(cold.runs['run-2'].fileContext.localFileWrappers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'alias' })])
    )
    parse.mockClear()
    const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
    expect(await warm.project(request)).toEqual(coldProjection)
    expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
    const context = await warm.sourceFileAccessContext({
      ...request,
      currentRunId: 'run-2',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    })
    const laterContext = await warm.sourceFileAccessContext({
      ...request,
      currentRunId: 'run-3',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    })
    expect(laterContext?.localFileWrappers ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'alias' })])
    )
    expect(parse).not.toHaveBeenCalled()
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toEqual(
      cold.runs['run-2'].fileAccess
    )
  })
})

describe('R untrusted for execution across cached cells', () => {
  const replacement = '`for` <- function(...) NULL'
  const write = 'utils::write.table(1,"inputs/observations.csv")'
  const read = 'read.csv("inputs/observations.csv")'
  const helper = 'emit <- function(x,file) utils::write.table(x,file)'

  it.each([
    {
      label: 'same-cell shadowed direct body retains possible write and input',
      prior: 'prior <- 2',
      source: `${replacement}\nfor (unused in c("x")) ${write}\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'same-cell shadowed helper body retains possible write and input',
      prior: 'prior <- 2',
      source: `${helper}\n${replacement}\nfor (unused in c("x")) emit(1,"inputs/observations.csv")\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'same-cell shadowed helper sequence retains possible write and input',
      prior: 'prior <- 2',
      source: `${helper}\n${replacement}\nfor (unused in emit(1,"inputs/observations.csv")) {}\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'for writer alias does not certify a write inside its complex sequence promise',
      prior: 'prior <- 2',
      source:
        'unused <- 1\nemit <- function(x,sequence,file) utils::write.table(x,file)\n' +
        '`for` <- emit\nfor (unused in utils::write.table(1,"inputs/observations.csv")) "outputs/real.csv"\n' +
        read,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'for writer alias retains its known destination with a literal sequence',
      prior: 'prior <- 2',
      source:
        'unused <- 1\nemit <- function(x,sequence,file) utils::write.table(x,file)\n' +
        '`for` <- emit\nfor (unused in NULL) "outputs/real.csv"\n' +
        read,
      reads: ['inputs/observations.csv'],
      writes: ['outputs/real.csv'],
      partial: true
    },
    {
      label: 'restored shadowed for does not certify its direct body',
      prior: replacement,
      source: `for (unused in c("x")) ${write}\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'restored shadowed for does not certify its direct sequence',
      prior: replacement,
      source: `for (unused in ${write}) {}\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'trusted builtin body still certifies a completed write',
      prior: 'prior <- 2',
      source: `for (unused in c("x")) ${write}\n${read}`,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: false
    },
    {
      label: 'completed write remains certified before an empty shadowed call',
      prior: 'prior <- 2',
      source: `${write}\n${replacement}\nfor (unused in NULL) {}\n${read}`,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'shadowed body does not publish a new variable path',
      prior: 'prior <- 2',
      source:
        `path <- "inputs/old.csv"\n${replacement}\n` +
        'for (unused in c("x")) { path <- "inputs/new.csv" }\nread.csv(path)',
      reads: [],
      writes: [],
      partial: true
    }
  ])(
    'preserves $label in cold and warm four-cell facts',
    async ({ prior, source, reads, writes, partial }) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      // Handwritten repository records exercise analysis; the enum is not provider evidence.
      const scripts = ['marker <- 1', prior, source, 'n <- 3']
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).toHaveBeenCalledTimes(4)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      const runIds = runs.map(({ runId }) => runId).sort()
      expect(Object.keys(cold.runs).sort()).toEqual(runIds)
      expect(Object.keys(coldProjection.stalenessByRunId).sort()).toEqual(runIds)
      expect(cold.runs['run-2'].fileAccess.reads).toEqual(reads)
      expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
      expect(cold.runs['run-2'].fileAccess).toMatchObject({
        readState: partial ? 'partial' : 'complete',
        writeState: partial ? 'partial' : 'complete',
        externalState: partial ? 'partial' : 'complete'
      })
      if (partial) expect(cold.runs['run-2'].facts.state).toBe('unknown')
      parse.mockClear()
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-2',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      if (prior === replacement) expect(context?.resolvedKernelNames).toContain('for')
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toEqual(
        cold.runs['run-2'].fileAccess
      )
    }
  )
})

describe('R untrusted brace execution across cached cells', () => {
  const replacement = '`{` <- function(...) NULL'
  const write = 'utils::write.table(1,"inputs/observations.csv")'
  const read = 'read.csv("inputs/observations.csv")'
  const helper = 'emit <- function(path) utils::write.table(1,path)'

  it.each([
    {
      label: 'same-cell shadowed direct write remains possible',
      prior: 'n <- 1',
      source: `${replacement}\n{ ${write} }\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'same-cell shadowed helper write remains possible',
      prior: 'n <- 1',
      source: `${helper}\n${replacement}\n{ emit("inputs/observations.csv") }\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'same-cell shadowed brace does not publish a path binding',
      prior: 'n <- 1',
      source:
        `path <- "inputs/decoy.csv"\n${replacement}\n` +
        '{ path <- "inputs/observations.csv" }\nread.csv(path)',
      reads: [],
      writes: [],
      partial: true
    },
    {
      label: 'trusted builtin brace still certifies its completed write',
      prior: 'n <- 1',
      source: `{ ${write} }\n${read}`,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: false
    },
    {
      label: 'same-cell shadowed brace does not publish a nested loop target',
      prior: 'n <- 1',
      next: 'read.csv(path)',
      source:
        `path <- "inputs/observations.csv"\n${replacement}\n` +
        '{ for (path in c("inputs/decoy.csv")) 1 }\nread.csv(path)',
      reads: [],
      writes: [],
      partial: true
    },
    {
      label: 'restored shadowed brace keeps a nested loop writer possible',
      prior: `path <- "inputs/observations.csv"\n${replacement}`,
      next: 'read.csv(path)',
      source: '{ for (path in c("inputs/decoy.csv")) utils::write.table(1,path) }\nread.csv(path)',
      reads: [],
      writes: ['inputs/decoy.csv'],
      partial: true
    },
    {
      label: 'completed write remains certified before brace replacement',
      prior: 'n <- 1',
      source:
        `${write}\n${replacement}\n` +
        '{ utils::write.table(2,"inputs/observations.csv") }\n' +
        read,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'builtin brace selected at entry survives a later replacement',
      prior: 'n <- 1',
      source: `{ ${replacement}; ${write} }\n${read}`,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: false
    },
    {
      label: 'restored shadowed brace does not certify a direct write',
      prior: replacement,
      source: `{ ${write} }\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'restored shadowed brace does not certify a helper write',
      prior: replacement,
      source: `${helper}\n{ emit("inputs/observations.csv") }\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'restored shadowed brace does not publish a new path binding',
      prior: `path <- "inputs/decoy.csv"\n${replacement}`,
      source: '{ path <- "inputs/observations.csv" }\nread.csv(path)',
      reads: [],
      writes: [],
      partial: true
    }
  ])(
    'preserves $label in cold and warm four-cell facts',
    async ({ prior, source, reads, writes, partial, next }) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      // Handwritten analysis records; their source enum does not imply model or native execution.
      const scripts = ['marker <- 1', prior, source, next ?? 'marker <- 2']
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).toHaveBeenCalledTimes(4)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      const runIds = runs.map(({ runId }) => runId).sort()
      expect(Object.keys(cold.runs).sort()).toEqual(runIds)
      expect(Object.keys(coldProjection.stalenessByRunId).sort()).toEqual(runIds)
      expect(cold.runs['run-2'].fileAccess.reads).toEqual(reads)
      expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
      if (next) {
        expect(cold.runs['run-3'].fileAccess).toMatchObject({ reads: [], readState: 'partial' })
      }
      if (partial) {
        expect(cold.runs['run-2'].fileAccess).toMatchObject({
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial'
        })
        expect(cold.runs['run-2'].facts.state).toBe('unknown')
      }
      parse.mockClear()
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-2',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      if (prior.includes(replacement)) expect(context?.resolvedKernelNames).toContain('{')
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toEqual(
        cold.runs['run-2'].fileAccess
      )
    }
  )
})

it('keeps trusted glue aliases in restored loop collections', async () => {
  const context = await fileContext('r', [
    'library(glue); g <- glue',
    'labels <- c("a","b")',
    'paths <- g("outputs/{labels}.txt")',
    'n <- 1'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('r', 'for (file in paths) writeLines("x",file)', context)
  ).toMatchObject({ writes: ['outputs/a.txt', 'outputs/b.txt'] })
})

describe('R file helper namespace dependencies', () => {
  it.each([
    [
      'secondary device namespace lookup replaced',
      'emit <- function(file) { if(FALSE) grDevices::png(file) else grDevices:::png(file) }',
      '`:::` <- function(pkg,name) function(...) NULL',
      'emit("inputs/observations.csv")',
      []
    ],
    [
      'qualified lookup replaced after declaration',
      'emit <- function(x,file) utils::write.csv(x,file)',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'qualified lookup replaced before declaration',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit <- function(x,file) utils::write.csv(x,file)',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'internal CSV lookup replaced',
      'emit <- function(x,file) write.csv(x,file)',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'internal CSV lookup replaced behind triple colon',
      'emit <- function(x,file) utils:::write.csv(x,file)',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'triple colon lookup replaced',
      'emit <- function(x,file) utils:::write.table(x,file)',
      '`:::` <- function(pkg,name) function(...) NULL',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'qualified member replacement control',
      'emit <- function(x,file) utils::write.csv(x,file)',
      'write.csv <- function(...) NULL',
      'emit(1,"outputs/summary.csv")',
      ['outputs/summary.csv']
    ],
    [
      'bare table control',
      'emit <- function(x,file) write.table(x,file)',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit(1,"outputs/summary.csv")',
      ['outputs/summary.csv']
    ]
  ])(
    'preserves %s through cold and warm four-cell facts',
    async (_label, first, second, call, writes) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const scripts = [first, second, `${call}\nread.csv("inputs/observations.csv")`, 'n <- 1']
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script: script as string,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).toHaveBeenCalledTimes(4)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-2'].fileAccess.reads).toEqual(['inputs/observations.csv'])
      expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
      parse.mockClear()
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-2',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', scripts[2] as string, context)).toEqual(
        cold.runs['run-2'].fileAccess
      )
    }
  )
})

describe('R writer option evaluation', () => {
  it.each([
    'emit <- function(file,x=read_one(file)) utils::write.csv(x,file)\nemit("inputs/observations.csv")',
    'emit <- function(x,file) utils::write.csv(read_one(file),file)\nemit(1,"inputs/observations.csv")',
    'emit <- function(x,file) utils::write.csv(x,file)\nemit(read_one("inputs/observations.csv"),"inputs/observations.csv")'
  ])('retains a restored reader helper inside writer promises: %s', async (source) => {
    const context = await fileContext('r', ['read_one <- function(file) utils::read.csv(file)'])
    const access = await analyzeNotebookSourceFileAccess(
      'r',
      source + '\nutils::read.csv("inputs/observations.csv")',
      context
    )
    expect(access.reads).toEqual(['inputs/observations.csv'])
    expect(access.readState).toBe('partial')
    expect(access.writeState).toBe('partial')
    expect(access.writes).toEqual(
      source.includes('emit(read_one(') ? ['inputs/observations.csv'] : []
    )
  })

  it.each(['write.csv', 'write.csv2'])(
    'does not certify positional %s options before they evaluate',
    async (writer) => {
      const access = await analyzeNotebookSourceFileAccess(
        'r',
        `utils::${writer}(1,"inputs/observations.csv",FALSE,FALSE,"\\n","NA",{utils::read.csv("inputs/observations.csv"); TRUE})`
      )
      expect(access.reads).toEqual(['inputs/observations.csv'])
      expect(access.writes).toEqual([])
      expect(access.writeState).toBe('partial')
    }
  )

  it.each([
    [
      'nested helper argument',
      'emit <- function(x,file) utils::write.csv(x,file)',
      'emit(utils::read.csv("inputs/observations.csv"),"inputs/observations.csv")',
      ['inputs/observations.csv'],
      ['inputs/observations.csv']
    ],
    [
      'hidden helper default',
      'emit <- function(file,x=utils::read.csv(file)) utils::write.csv(x,file)',
      'emit("inputs/observations.csv")\nutils::read.csv("inputs/observations.csv")',
      ['inputs/observations.csv'],
      []
    ],
    [
      'helper option rebinding',
      'emit <- function(x,file) utils::write.table(x,file,row.names={file <- "outputs/actual.csv"; FALSE})',
      'emit(1,"inputs/observations.csv")\nutils::read.csv("inputs/observations.csv")',
      ['inputs/observations.csv'],
      []
    ],
    [
      'pre-open table option',
      'label <- "observations"',
      'utils::write.table(1,"inputs/observations.csv",col.names={utils::read.csv("inputs/observations.csv"); TRUE})',
      ['inputs/observations.csv'],
      []
    ],
    [
      'ignored CSV option',
      'label <- "observations"',
      'utils::write.csv(1,"outputs/summary.csv",col.names=utils::write.csv(1,"inputs/observations.csv"))\nutils::read.csv("inputs/observations.csv")',
      ['inputs/observations.csv'],
      ['outputs/summary.csv']
    ]
  ])(
    'preserves %s through cold and warm persisted facts',
    async (_name, definition, script, reads, writes) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const runs: NotebookRunRecord[] = [definition, script, 'n <- 1', 'n'].map(
        (source, index) => ({
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          inputKind: 'cell',
          kernelKind: 'r',
          kernelEpochId: 'epoch-1',
          environment: 'default-r',
          script: source as string,
          status: 'completed',
          startedAt: index,
          endedAt: index,
          executionCount: index,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: [],
          inputFiles: []
        })
      )
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-1'].fileAccess.reads).toEqual(reads)
      expect(cold.runs['run-1'].fileAccess.writes).toEqual(writes)
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', script as string, context)).toMatchObject({
        reads,
        writes
      })
    }
  )
})

describe('Python helper module definition bindings', () => {
  const reader = `def read_inputs():
    return open("old-input.csv")
def replacement():
    return open("new-input.csv")`
  const reboundReaders = [
    [
      'positional default',
      `${reader}\ndef configure(value=(read_inputs := replacement)):\n    return value`
    ],
    [
      'keyword default',
      `${reader}\ndef configure(*, value=(read_inputs := replacement)):\n    return value`
    ],
    [
      'module block default',
      `${reader}\nif True:\n    def configure(value=(read_inputs := replacement)):\n        return value`
    ],
    [
      'async default',
      `${reader}\nasync def configure(value=(read_inputs := replacement)):\n    return value`
    ],
    [
      'nested lambda default',
      `${reader}\ndef configure(value=lambda nested=(read_inputs := replacement): nested):\n    return value`
    ],
    [
      'comprehension expression',
      `${reader}\ndef configure(value=[(read_inputs := replacement) for item in [1]]):\n    return value`
    ],
    [
      'function decorator',
      `${reader}\n@((read_inputs := replacement) and (lambda fn: fn))\ndef configure():\n    return None`
    ],
    [
      'class base',
      `${reader}\nclass Configure((read_inputs := replacement) and object):\n    pass`
    ],
    [
      'class keyword',
      `${reader}\nclass Configure(metaclass=((read_inputs := replacement) and type)):\n    pass`
    ],
    [
      'class decorator',
      `${reader}\n@((read_inputs := replacement) and (lambda cls: cls))\nclass Configure:\n    pass`
    ]
  ] as const
  const preservedReaders = [
    ['baseline', reader],
    [
      'deferred lambda body',
      `${reader}\ndef configure(value=lambda: (read_inputs := replacement)):\n    return value`
    ],
    [
      'comprehension target',
      `${reader}\ndef configure(value=[0 for read_inputs in [1, 2]]):\n    return value`
    ],
    [
      'unrelated default',
      `${reader}\ndef configure(value=(label := "control")):\n    return value`
    ],
    [
      'own final name',
      `${reader}\ndef read_inputs(value=(read_inputs := replacement)):\n    return open("old-input.csv")`
    ],
    [
      'own keyword final name',
      `${reader}\ndef read_inputs(*, value=(read_inputs := replacement)):\n    return open("old-input.csv")`
    ],
    [
      'later explicit definition',
      `${reader}\ndef configure(value=(read_inputs := replacement)):\n    return value\ndef read_inputs():\n    return open("old-input.csv")`
    ],
    ['class-local binding', `${reader}\nclass Configure:\n    read_inputs = replacement`]
  ] as const
  const accessFor = (source: string): ReturnType<typeof analyzeNotebookSourceFileAccess> =>
    analyzeNotebookSourceFileAccess('python', 'handle = read_inputs()', {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [{ source, exports: ['read_inputs'] }]
    })

  it.each(reboundReaders)(
    'does not borrow obsolete reader I/O after %s',
    async (_label, source) => {
      const access = await accessFor(source)
      expect(access.reads).not.toContain('old-input.csv')
      expect(access.reads).not.toContain('new-input.csv')
      expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
    }
  )

  it.each(preservedReaders)('retains stable reader I/O with %s', async (_label, source) => {
    const access = await accessFor(source)
    expect(access.reads).toContain('old-input.csv')
    expect(access.reads).not.toContain('new-input.csv')
  })

  it.each([
    [
      'private default',
      `${reader.replaceAll('read_inputs', '_read_inputs')}\ndef configure(value=(_read_inputs := replacement)):\n    return value\ndef read_inputs():\n    return _read_inputs()`
    ],
    [
      'decorated export',
      `${reader}\n@((read_inputs := replacement) and (lambda fn: fn))\ndef read_inputs():\n    return open("old-input.csv")`
    ],
    [
      'uncertain generator expression',
      `${reader}\ndef configure(value=((read_inputs := replacement) for item in [1])):\n    return value`
    ],
    ['wildcard import', `${reader}\nfrom custom_readers import *`],
    [
      'match capture',
      `${reader}\nmatch {"reader": replacement}:\n    case {"reader": read_inputs}:\n        pass`
    ]
  ])('keeps %s conservatively unresolved', async (_label, source) => {
    const access = await accessFor(source)
    expect(access.reads).not.toContain('old-input.csv')
    expect(access.reads).not.toContain('new-input.csv')
    expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
  })

  it.each([
    ...reboundReaders.map(([label, source]) => [label, source, false] as const),
    ...preservedReaders
      .filter(([label]) => ['baseline', 'own final name', 'deferred lambda body'].includes(label))
      .map(([label, source]) => [label, source, true] as const)
  ])('persists conservative four-cell reader I/O for %s', async (_label, source, preserved) => {
    const helper = {
      helperId: 'definition-reader',
      skillIdentity: 'skill://definition-reader',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source,
      sourceDigest: 'digest-definition-reader'
    }
    const scripts = [
      'label = "measurements"',
      'handle = read_inputs()',
      'artifact_path = "outputs/summary.csv"',
      'with open(artifact_path, "w") as report:\n    report.write(label)'
    ]
    for (const precompute of [false, true]) {
      await fileContext(
        'python',
        scripts,
        scripts.map(() => ({
          helperModules: [helper],
          helperEvidenceStatus: { state: 'complete' }
        })),
        precompute
      )
      const sidecar = JSON.parse(
        await readFile(
          join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
          'utf8'
        )
      )
      const access = sidecar.runs['run-1'].fileAccess
      if (preserved) expect(access.reads).toContain('old-input.csv')
      else {
        expect(access.reads).not.toContain('old-input.csv')
        expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
      }
      expect(access.reads).not.toContain('new-input.csv')
      expect(sidecar.runs['run-3'].fileAccess.writes).toContain('outputs/summary.csv')
    }
  })
})

describe('Python helper module annotation-only bindings', () => {
  const copySource = (name: string): string => `def ${name}(input_path, output_path):
    with open(input_path) as source:
        contents = source.read()
    with open(output_path, "w") as target:
        target.write(contents)
    return contents`
  const exported = copySource('summarize')
  const privateHelper = `${copySource('_copy')}
def summarize(input_path, output_path):
    return _copy(input_path, output_path)`
  const unchangedHelpers = [
    ['export', `${exported}\nsummarize: object`],
    ['module block', `${exported}\nif True:\n    summarize: object`],
    ['private helper', `${privateHelper}\n_copy: object`],
    ['both helpers', `${privateHelper}\n_copy: object\nsummarize: object`]
  ] as const

  it.each(unchangedHelpers)('retains known I/O after annotating %s', async (_label, source) => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'first = summarize("inputs/observations.csv", "outputs/summary.csv")',
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['summarize'] }]
      }
    )
    expect(access).toMatchObject({
      reads: ['inputs/observations.csv'],
      writes: ['outputs/summary.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(access.reasonCodes).toContain('source-analysis-unsupported-call')
  })

  it.each([
    'def read_inputs():\n    return open("input.csv")\nread_inputs: object',
    'def _read():\n    return open("input.csv")\n_read: object\ndef read_inputs():\n    return _read()'
  ])('preserves existing literal reader certainty with an annotation: %s', async (source) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', 'read_inputs()', {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      })
    ).toMatchObject({ reads: ['input.csv'], readState: 'complete', externalState: 'complete' })
  })

  it.each([
    ...['None', '0', 'False', 'lambda *args: "replacement"'].map(
      (rhs) => `${exported}\nsummarize: object = ${rhs}`
    ),
    ...['None', '0', 'False', 'lambda *args: "replacement"'].map(
      (rhs) => `${privateHelper}\n_copy: object = ${rhs}`
    ),
    `${exported}\nsummarize: (summarize := lambda *args: "replacement")`,
    `${privateHelper}\nmarker: (_copy := lambda *args: "replacement")`,
    `${privateHelper}\nif True:\n    marker: (_copy := lambda *args: "replacement")`,
    `${exported}\nsummarize = lambda *args: "replacement"\nsummarize: object`,
    `${privateHelper}\n_copy = lambda *args: "replacement"\n_copy: object`,
    `${copySource('_copy')}\ndef summarize(input_path, output_path):\n    _copy: object\n    return _copy(input_path, output_path)`
  ])('does not borrow obsolete or unbound annotation helper I/O: %s', async (source) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'summarize("inputs/observations.csv", "outputs/summary.csv")',
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonHelperModules: [{ source, exports: ['summarize'] }]
        }
      )
    ).toMatchObject({ reads: [], writes: [], readState: 'partial', externalState: 'partial' })
  })

  it.each(unchangedHelpers)(
    'retains four-cell I/O after annotating %s across cold analysis and cache reload',
    async (_label, source) => {
      const helper = {
        helperId: 'copy-observations',
        skillIdentity: 'skill://copy-observations',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['summarize'],
        source,
        sourceDigest: 'digest-copy-observations'
      }
      const scripts = [
        'label = "observations"',
        'first = summarize("inputs/observations.csv", "outputs/summary.csv")',
        'summarize: object',
        'second = summarize("outputs/summary.csv", "outputs/second.csv")'
      ]
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          scripts,
          scripts.map(() => ({
            helperModules: [helper],
            helperEvidenceStatus: { state: 'complete' }
          })),
          precompute
        )
        expect(context?.pythonHelperModules).toContainEqual({ source, exports: ['summarize'] })
        expect(await analyzeNotebookSourceFileAccess('python', scripts[3]!, context)).toMatchObject(
          {
            reads: ['outputs/summary.csv'],
            writes: ['outputs/second.csv'],
            readState: 'partial',
            writeState: 'partial',
            externalState: 'partial'
          }
        )
        if (precompute) {
          const sidecar = JSON.parse(
            await readFile(
              join(
                roots.at(-1)!,
                'notebooks/default-project/session-1/cache/dependency-analysis.json'
              ),
              'utf8'
            )
          )
          expect(sidecar.runs['run-1'].fileAccess).toMatchObject({
            reads: ['inputs/observations.csv'],
            writes: ['outputs/summary.csv'],
            externalState: 'partial'
          })
          expect(sidecar.runs['run-3'].fileAccess).toMatchObject({
            reads: ['outputs/summary.csv'],
            writes: ['outputs/second.csv'],
            externalState: 'partial'
          })
        }
      }
    }
  )
})

describe('Python private helper wildcard imports', () => {
  const privateReader = 'def _read_inputs():\n    return open("old.csv")'
  const exportedReader = 'def read_inputs():\n    return _read_inputs()'
  const wildcard = 'from reader_override import *'
  const revokedHelpers = [
    ['module wildcard', `${privateReader}\n${wildcard}\n${exportedReader}`],
    ['conditional wildcard', `${privateReader}\nif True:\n    ${wildcard}\n${exportedReader}`],
    [
      'second wildcard after restoration',
      `${privateReader}\n${wildcard}\n${privateReader}\n${wildcard}\n${exportedReader}`
    ],
    [
      'nested private call chain',
      `${privateReader}\n${wildcard}\ndef _middle():\n    return _read_inputs()\ndef read_inputs():\n    return _middle()`
    ],
    [
      'annotation after wildcard',
      `${privateReader}\n${wildcard}\n_read_inputs: object\n${exportedReader}`
    ],
    [
      'explicit private import',
      `${privateReader}\nfrom reader_override import _read_inputs\n${exportedReader}`
    ],
    ['wildcard after export', `${privateReader}\n${exportedReader}\n${wildcard}`]
  ] as const
  const stableHelpers = [
    ['wildcard before private definition', `${wildcard}\n${privateReader}\n${exportedReader}`],
    [
      'private redefinition after wildcard',
      `${privateReader}\n${wildcard}\n${privateReader}\n${exportedReader}`
    ]
  ] as const
  const accessFor = (source: string): ReturnType<typeof analyzeNotebookSourceFileAccess> =>
    analyzeNotebookSourceFileAccess('python', 'handle = read_inputs()', {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [{ source, exports: ['read_inputs'] }]
    })

  it.each(revokedHelpers)(
    'rejects obsolete private reader I/O after %s',
    async (_label, source) => {
      const access = await accessFor(source)
      expect(access.reads).not.toContain('old.csv')
      expect(access.reads).not.toContain('new.csv')
      expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
    }
  )

  it.each(stableHelpers)('retains stable private reader I/O after %s', async (_label, source) => {
    const access = await accessFor(source)
    expect(access.reads).toContain('old.csv')
    expect(access.reads).not.toContain('new.csv')
  })

  it.each([
    ...revokedHelpers.map(([label, source]) => [label, source, false] as const),
    ...stableHelpers.map(([label, source]) => [label, source, true] as const)
  ])('persists private helper wildcard boundaries for %s', async (_label, source, preserved) => {
    const helper = {
      helperId: 'private-wildcard-reader',
      skillIdentity: 'skill://private-wildcard-reader',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source,
      sourceDigest: 'digest-private-wildcard-reader'
    }
    const scripts = [
      'label = "measurements"',
      'handle = read_inputs()',
      'artifact_path = "outputs/summary.csv"',
      'with open(artifact_path, "w") as report:\n    report.write(label)'
    ]
    const parse = vi.spyOn(Parser.prototype, 'parse')
    for (const precompute of [false, true]) {
      await fileContext(
        'python',
        scripts,
        scripts.map(() => ({
          helperModules: [helper],
          helperEvidenceStatus: { state: 'complete' }
        })),
        precompute,
        undefined,
        'epoch-1',
        undefined,
        () => parse.mockClear()
      )
      if (precompute) expect(parse).not.toHaveBeenCalled()
      else expect(parse).toHaveBeenCalled()
      const sidecar = JSON.parse(
        await readFile(
          join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
          'utf8'
        )
      )
      expect(Object.keys(sidecar.runs)).toHaveLength(4)
      const access = sidecar.runs['run-1'].fileAccess
      if (preserved) expect(access.reads).toContain('old.csv')
      else {
        expect(access.reads).not.toContain('old.csv')
        expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
      }
      expect(access.reads).not.toContain('new.csv')
      expect(sidecar.runs['run-3'].fileAccess.writes).toContain('outputs/summary.csv')
    }
  })
})

describe('Python helper import-time path rebinding', () => {
  const reader = '\ndef read_inputs():\n    return open(INPUT_PATH)'
  const staleReaders = [
    ['opaque string', 'INPUT_PATH = "inputs/old.csv"\nINPUT_PATH = str("inputs/new.csv")' + reader],
    [
      'opaque sequence',
      'paths = ["inputs/old.csv"]\npaths = list(["inputs/new.csv"])\ndef read_inputs():\n    return open(paths[0])'
    ],
    [
      'opaque mapping',
      'paths = {"active": "inputs/old.csv"}\npaths = dict(active="inputs/new.csv")\ndef read_inputs():\n    return open(paths["active"])'
    ],
    [
      'starred unpack',
      'INPUT_PATH = "inputs/old.csv"\nINPUT_PATH, *rest = list(["inputs/new.csv", "extra"])' +
        reader
    ],
    [
      'positional eager default',
      'INPUT_PATH = "inputs/old.csv"\ndef configure(value=(INPUT_PATH := "inputs/new.csv")):\n    pass' +
        reader
    ],
    [
      'keyword eager default',
      'INPUT_PATH = "inputs/old.csv"\ndef configure(*, value=(INPUT_PATH := "inputs/new.csv")):\n    pass' +
        reader
    ],
    [
      'lambda eager default',
      'INPUT_PATH = "inputs/old.csv"\nconfigure = lambda value=(INPUT_PATH := str("inputs/new.csv")): None' +
        reader
    ],
    [
      'existing collection alias',
      'paths = ["inputs/old.csv"]\nalias = paths\npaths = list(["inputs/new.csv"])\ndef read_inputs():\n    return open(alias[0])'
    ],
    [
      'mapping receiver mutation',
      'config = {"input": "inputs/old.csv"}\nconfig.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'aliased mapping receiver mutation',
      'config = {"input": "inputs/old.csv"}\nalias = config\nalias.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'conditional mapping alias receiver mutation',
      'config = {"input": "inputs/old.csv"}\nif True:\n    alias = config\nalias.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'sequence receiver mutation',
      'paths = ["inputs/old.csv"]\npaths.__setitem__(0, "inputs/new.csv")\ndef read_inputs():\n    return open(paths[0])'
    ],
    [
      'opaque subscript mutation',
      'paths = ["inputs/old.csv"]\npaths[0] = str("inputs/new.csv")\ndef read_inputs():\n    return open(paths[0])'
    ],
    [
      'aliased opaque subscript mutation',
      'paths = ["inputs/old.csv"]\nalias = paths\nalias[0] = str("inputs/new.csv")\ndef read_inputs():\n    return open(paths[0])'
    ],
    [
      'eager default receiver mutation',
      'config = {"input": "inputs/old.csv"}\ndef configure(value=config.update(input="inputs/new.csv")):\n    pass\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'eager comprehension receiver mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = [config.update(input="inputs/new.csv") for _ in [0]]\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'generator first iterable mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = (item for item in config.pop("input"))\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'comprehension iterable before local target',
      'config = {"input": "inputs/old.csv"}\nconfigure = [config for config in [config.pop("input")]]\ndef read_inputs():\n    return open(config["input"])'
    ]
  ] as const
  const stableReaders = [
    [
      'unrelated opaque assignment',
      'INPUT_PATH = "inputs/old.csv"\nlabel = str("calibration")' + reader,
      'inputs/old.csv'
    ],
    [
      'later literal restoration',
      'INPUT_PATH = "inputs/old.csv"\nINPUT_PATH = str("inputs/new.csv")\nINPUT_PATH = "inputs/final.csv"' +
        reader,
      'inputs/final.csv'
    ],
    [
      'annotation without assignment',
      'INPUT_PATH = "inputs/old.csv"\nINPUT_PATH: str("annotation")' + reader,
      'inputs/old.csv'
    ],
    [
      'deferred lambda body',
      'INPUT_PATH = "inputs/old.csv"\ndef configure(value=lambda: (INPUT_PATH := str("inputs/new.csv"))):\n    pass' +
        reader,
      'inputs/old.csv'
    ],
    [
      'comprehension local target',
      'INPUT_PATH = "inputs/old.csv"\ndef configure(value=[0 for INPUT_PATH in ["inputs/new.csv"]]):\n    pass' +
        reader,
      'inputs/old.csv'
    ],
    [
      'stable mapping',
      'config = {"input": "inputs/old.csv"}\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'unrelated receiver mutation',
      'config = {"input": "inputs/old.csv"}\nunused = ["ignored"]\nunused.__setitem__(0, "updated")\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'deferred container mutation',
      'config = {"input": "inputs/old.csv"}\ndef configure():\n    config.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'existing literal sequence mutation',
      'paths = ["inputs/old.csv"]\npaths[0] = "inputs/new.csv"\ndef read_inputs():\n    return open(paths[0])',
      undefined
    ],
    [
      'existing literal mapping mutation',
      'config = {"input": "inputs/old.csv"}\nconfig["input"] = "inputs/new.csv"\ndef read_inputs():\n    return open(config["input"])',
      undefined
    ],
    [
      'deferred generator body mutation',
      'config = {"input": "inputs/old.csv"}\ndef configure(value=(config.update(input="inputs/new.csv") for _ in [0])):\n    pass\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'comprehension-local receiver mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = [config.update(input="inputs/new.csv") for config in [{"input": "ignored"}]]\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'deferred lambda container mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = lambda: config.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'deferred generator filter mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = (item for item in [0] if config.pop("input"))\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ]
  ] as const
  const helperContext = (
    source: string,
    exportedName = 'read_inputs'
  ): NotebookSourceFileAccessContext => ({
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonHelperModules: [{ source, exports: [exportedName] }]
  })

  it.each(staleReaders)(
    'revokes an import-time %s path without certifying its replacement',
    async (_label, source) => {
      const access = await analyzeNotebookSourceFileAccess(
        'python',
        'handle = read_inputs()',
        helperContext(source)
      )
      expect(access).toMatchObject({
        reads: [],
        writes: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each(stableReaders)(
    'preserves existing path resolution after %s',
    async (_label, source, path) => {
      const access = await analyzeNotebookSourceFileAccess(
        'python',
        'handle = read_inputs()',
        helperContext(source)
      )
      expect(access.reads).toEqual(path ? [path] : [])
      expect(access.writes).toEqual([])
      if (!path) expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
    }
  )

  it('revokes an opaque import-time writer path', async () => {
    const source =
      'OUTPUT_PATH = "outputs/old.csv"\nOUTPUT_PATH = str("outputs/new.csv")\ndef write_result():\n    return open(OUTPUT_PATH, "w")'
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'handle = write_result()',
        helperContext(source, 'write_result')
      )
    ).toMatchObject({
      reads: [],
      writes: [],
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('revokes a mutated import-time output container path', async () => {
    const source =
      'paths = ["outputs/old.csv"]\npaths.__setitem__(0, "outputs/new.csv")\ndef write_result():\n    return open(paths[0], "w")'
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'handle = write_result()',
        helperContext(source, 'write_result')
      )
    ).toMatchObject({
      reads: [],
      writes: [],
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ...staleReaders.map(([label, source]) => [label, source, undefined, 'partial'] as const),
    [...stableReaders[0], 'partial'] as const,
    [...stableReaders[1], 'partial'] as const,
    ...stableReaders
      .slice(5)
      .map(
        ([label, source, path]) =>
          [
            label,
            source,
            path,
            [
              'stable mapping',
              'deferred container mutation',
              'deferred lambda container mutation'
            ].includes(label)
              ? 'complete'
              : 'partial'
          ] as const
      )
  ])(
    'retains the %s boundary across four cells and warm cache reload',
    async (_label, source, expectedPath, expectedReadState) => {
      const helper = {
        helperId: 'import-time-reader',
        skillIdentity: 'skill://import-time-reader',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['read_inputs'],
        source,
        sourceDigest: 'digest-import-time-reader'
      }
      const scripts = [
        'label = "measurements"',
        'handle = read_inputs()',
        'artifact_path = "outputs/summary.csv"',
        'with open(artifact_path, "w") as report:\n    report.write(label)'
      ]
      const overrides = scripts.map(() => ({
        helperModules: [helper],
        helperEvidenceStatus: { state: 'complete' as const }
      }))
      await fileContext('python', scripts, overrides)
      const storageRoot = roots.at(-1)!
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-1'].fileAccess.reads).toEqual(expectedPath ? [expectedPath] : [])
      expect(cold.runs['run-1'].fileAccess).toMatchObject({
        readState: expectedReadState,
        ...(expectedReadState === 'partial' ? { externalState: 'partial' } : {})
      })
      expect(cold.runs['run-3'].fileAccess.writes).toEqual(['outputs/summary.csv'])
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'python',
        kernelEpochId: 'epoch-1',
        environment: 'default-python',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: [],
        ...overrides[index]
      }))
      const parse = vi.spyOn(Parser.prototype, 'parse')
      await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => runs }
      }).project({
        projectId: 'default-project',
        sessionId: 'session-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
    }
  )
})

describe('Python prior callable write coverage', () => {
  const writer = `config = {"prefix": "baseline"}
def emit(configuration):
    path = "outputs/" + configuration["prefix"] + ".csv"
    with open(path, "w") as target:
        target.write("value\\n1\\n")`
  // Handwritten historical-analysis fixtures, not provider or native execution evidence.
  const syntheticNotebookRunRecord = (script: string, index: number): NotebookRunRecord => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    inputKind: 'cell',
    kernelKind: 'python',
    kernelEpochId: 'epoch-1',
    environment: 'default-python',
    script,
    status: 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index,
    executionCount: index,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: []
  })

  it.each([
    ['named writer without mutation', '', 'emit(config)', []],
    [
      'prior alias after configuration mutation',
      '\nhandle = emit',
      'config["prefix"] = "hann"\nhandle(config)',
      []
    ],
    [
      'opaque alias with a visible literal write',
      '\nhandle = emit',
      'config["prefix"] = "hann"\nhandle(config)\nwith open("outputs/visible.csv", "w") as target:\n    target.write("value\\n1\\n")',
      ['outputs/visible.csv']
    ]
  ] as const)(
    'keeps %s write coverage partial across cold analysis and warm cache reload',
    async (_label, alias, call, expectedWrites) => {
      const scripts = [
        writer + alias,
        call,
        'audit_label = "handwritten-analysis"',
        'assert audit_label == "handwritten-analysis"'
      ]
      const runs = scripts.map(syntheticNotebookRunRecord)
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-callable-write-'))
      roots.push(storageRoot)
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      const runIds = runs.map(({ runId }) => runId)
      expect(Object.keys(cold.runs).sort()).toEqual(runIds)
      expect(Object.keys(coldProjection.stalenessByRunId).sort()).toEqual(runIds)
      const access = cold.runs['run-1'].fileAccess
      expect(access).toMatchObject({
        writeState: 'partial',
        externalState: 'partial',
        reads: [],
        writes: expectedWrites
      })
      expect(access.reasonCodes).toContain('source-analysis-unsupported-call')
      expect(access.writes).not.toContain('outputs/baseline.csv')
      expect(access.writes).not.toContain('outputs/hann.csv')
      const context = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language: 'python',
        environment: 'default-python',
        kernelEpochId: 'epoch-1'
      })
      expect(await analyzeNotebookSourceFileAccess('python', call, context)).toEqual(access)

      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warmProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).not.toHaveBeenCalled()
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      expect(warmProjection).toEqual(coldProjection)
    }
  )
})

describe('R wrapper identities across cached cells', () => {
  it.each([
    [
      'rebound-global',
      'write.csv <- base::list',
      'write.csv("payload", "inputs/observations.csv")',
      []
    ],
    [
      'formal-shadow',
      'emit <- function(x, file, write.csv) write.csv(x, file)',
      'emit("payload", "inputs/observations.csv", base::list)',
      []
    ],
    [
      'nested-input',
      'label <- "observations"',
      'utils::write.csv(utils::read.csv("inputs/observations.csv"), "inputs/observations.csv")',
      ['inputs/observations.csv']
    ]
  ])(
    'preserves corrected %s lineage through cold and warm caches',
    async (_name, setup, call, writes) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const scripts = [setup, `${call}\nutils::read.csv("inputs/observations.csv")`]
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-0'].fileContext.localFileWrappers).not.toContainEqual(
        expect.objectContaining({ name: 'emit' })
      )
      expect(cold.runs['run-1'].fileAccess.reads).toEqual(['inputs/observations.csv'])
      expect(cold.runs['run-1'].fileAccess.writes).toEqual(writes)
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warmAnalyzer = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warmAnalyzer.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warmAnalyzer.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', scripts[1], context)).toMatchObject({
        reads: ['inputs/observations.csv'],
        writes
      })
    }
  )

  it.each(['write.csv', 'write.csv2', 'write.table'])(
    'preserves reordered %s helper destinations through cold and warm caches',
    async (writer) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const scripts = [
        `emit <- function(x,file) utils::${writer}(row.names=FALSE,x,file)`,
        'emit("inputs/decoy.csv","outputs/actual.csv")',
        'utils::read.csv("inputs/decoy.csv")',
        'utils::read.csv("outputs/actual.csv")'
      ]
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-0'].fileContext.localFileWrappers).toContainEqual(
        expect.objectContaining({ name: 'emit', position: 1, keywords: ['file'] })
      )
      expect(cold.runs['run-1'].fileAccess.writes).toEqual(['outputs/actual.csv'])
      expect(cold.runs['run-2'].fileAccess.reads).toEqual(['inputs/decoy.csv'])
      expect(cold.runs['run-3'].fileAccess.reads).toEqual(['outputs/actual.csv'])
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warmAnalyzer = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warmAnalyzer.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warmAnalyzer.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', scripts[1], context)).toMatchObject({
        writes: ['outputs/actual.csv']
      })
    }
  )

  it.each([
    [
      'reader <- function(file="") utils::read.csv(file=file)\nalias <- reader\nalias(file="inputs/observations.csv")',
      ['inputs/observations.csv'],
      []
    ],
    [
      'writer <- function(x,file="") utils::write.csv(x,file=file,row.names=FALSE)\nalias <- writer\nalias(1,file="outputs/summary.csv")',
      [],
      ['outputs/summary.csv']
    ]
  ])(
    'retains same-cell alias paths in a warm cache without exporting their authority: %s',
    async (source, reads, writes) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const scripts = [source, 'alias(file="unproved.csv")']
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-0'].fileAccess).toMatchObject({
        reads,
        writes,
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect(cold.runs['run-0'].facts.state).toBe('unknown')
      expect(cold.runs['run-0'].fileContext.localFileWrappers).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'alias' })])
      )
      expect(cold.runs['run-1'].fileAccess).toMatchObject({
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial'
      })
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warmAnalyzer = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warmAnalyzer.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warmAnalyzer.sourceFileAccessContext({
        ...request,
        currentRunId: 'next-run',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(context?.localFileWrappers ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'alias' })])
      )
      expect(parse).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['function redefinition', 'reader <- function(path) NULL', 'complete'],
    ['ordinary assignment', 'reader <- identity', 'partial'],
    ['body replacement', 'body(reader) <- quote(NULL)', 'partial'],
    ['formals replacement', 'formals(reader) <- pairlist(path=NULL)', 'partial']
  ])('does not replay a prior reader after %s', async (_label, replacement, readState) => {
    const scripts = [
      'reader <- function(path) utils::read.csv(path)',
      'before <- reader("inputs/obsolete.csv")\n' + replacement,
      'after <- reader("inputs/actual.csv")',
      'base::writeLines("verified", con="outputs/summary.txt")'
    ]
    const context = await fileContext('r', scripts)
    const storageRoot = roots.at(-1)!
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    const cold = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(cold.runs['run-1'].fileAccess.reads).toEqual(['inputs/obsolete.csv'])
    expect(cold.runs['run-2'].fileAccess.reads).toEqual([])
    expect(cold.runs['run-2'].fileAccess.readState).toBe(readState)
    expect(cold.runs['run-3'].fileAccess.writes).toEqual(['outputs/summary.txt'])
    expect(context?.localFileWrappers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'reader' })])
    )
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: 'run-' + index,
      cellId: 'cell-' + index,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'r',
      kernelEpochId: 'epoch-1',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      executionCount: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const parse = vi.spyOn(Parser.prototype, 'parse')
    await new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: async () => runs }
    }).project({
      projectId: 'default-project',
      sessionId: 'session-1'
    })
    expect(parse).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
  })

  it('keeps ambiguous cached wrapper arguments partial while retaining exact names', async () => {
    const scripts = [
      'reader <- function(unused, path, last) utils::read.csv(path)',
      'result <- reader(last=0, "inputs/decoy.csv", "inputs/actual.csv")',
      'result <- reader(path="inputs/actual.csv", last=0, unused=0)',
      'base::writeLines("verified", con="outputs/summary.txt")'
    ]
    await fileContext('r', scripts)
    const sidecar = JSON.parse(
      await readFile(
        join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
        'utf8'
      )
    )
    expect(sidecar.runs['run-1'].fileAccess).toMatchObject({ reads: [], readState: 'partial' })
    expect(sidecar.runs['run-2'].fileAccess.reads).toEqual(['inputs/actual.csv'])
    expect(sidecar.runs['run-3'].fileAccess.writes).toEqual(['outputs/summary.txt'])
  })

  it('exports a later stable wrapper after replacement', async () => {
    const context = await fileContext('r', [
      'reader <- function(path) utils::read.csv(path)',
      'reader <- identity',
      'reader <- function(path) utils::read.csv(path)',
      'label <- "measurements"'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'reader("inputs/restored.csv")', context)
    ).toMatchObject({
      reads: ['inputs/restored.csv']
    })
  })
})

describe('Python lambda creation file access', () => {
  it.each([
    'reader = lambda value, calibration=open("calibration.txt").read(): value',
    'reader = lambda value, *, required, calibration=open("calibration.txt").read(): value',
    'reader = lambda open=open("calibration.txt").read(): open',
    'reader = lambda nested=(lambda value=open("calibration.txt").read(): open("inner-body.csv")): open("outer-body.csv")',
    'from numpy import genfromtxt as reader\nreader = lambda value=reader("calibration.txt"): value',
    'path = "calibration.txt"\npath = lambda value=open(path).read(): value'
  ])('captures ordinary eager defaults before binding lambda parameters: %s', async (source) => {
    const access = await analyzeNotebookSourceFileAccess('python', source)
    expect(access.reads).toEqual(['calibration.txt'])
    expect(access.writes).toEqual([])
  })

  it('does not capture I/O from a lambda body that has not been called', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'reader = lambda value: open("deferred-input.csv").read() + open("deferred-output.csv", "w").write(value)'
    )
    expect(access.reads).toEqual([])
    expect(access.writes).toEqual([])
  })

  it('retains eager inputs without certifying an invoked reader callback body', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'import numpy as np\ndata = np.genfromtxt("observations.csv", converters={4: lambda value, calibration=open("calibration.txt").read(): float(open("callback-private.txt").read())})'
    )
    expect(access).toMatchObject({
      reads: ['calibration.txt', 'observations.csv'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    '[open("comprehension.csv") for index in range(2)]',
    '{open("comprehension.csv") for index in range(2)}',
    '{index: open("comprehension.csv") for index in range(2)}',
    '(open("comprehension.csv") for index in range(2))'
  ])('keeps comprehension and generator defaults conservatively partial: %s', async (value) => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      `reader = lambda value=${value}: open("deferred-input.csv")`
    )
    expect(access).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('uses restored outer path bindings for an eager default without capturing its body', async () => {
    const context = await fileContext('python', ['calibration_path = "calibration.txt"'])
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'reader = lambda calibration_path=open(calibration_path).read(): open("deferred-input.csv")',
      context
    )
    expect(access.reads).toEqual(['calibration.txt'])
    expect(access.writes).toEqual([])
  })
})

describe('Python function definition defaults in persisted file context', () => {
  it('retains an eager default input without replaying the function body', async () => {
    const context = await fileContext('python', [
      'def reader(value, calibration=open("calibration.txt").read()):\n    return value'
    ])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'def later(value):\n    return open("deferred.csv").read()\nresult = 1',
      context
    )
    expect(result.reads).toEqual([])
    expect(result.writes).toEqual([])
  })
})

describe('BFGS same-cell authority after cache reload', () => {
  it.each([
    'objective <- function(beta) beta - FN_ONLY\ngradient <- function(beta) beta - GR_ONLY',
    'objective <- function(beta) { n <<- n + 1L; sum(X %*% beta) + FN_ONLY }\n' +
      'gradient <- function(beta) { m <<- m + 1L; t(X) %*% beta + GR_ONLY }\n' +
      'fit <- stats::optim(0, objective, gradient, method="BFGS")'
  ])('does not restore invocation-local captures from stored summaries: %s', async (producer) => {
    const context = await fileContext('r', [producer])
    const result = await analyzeRNotebookSource(
      'data <- utils::read.csv("inputs/observations.csv")\n' +
        'fit <- stats::optim(0, objective, gradient, method="BFGS")',
      context
    )
    for (const name of ['FN_ONLY', 'GR_ONLY', 'X'])
      expect(result.facts.usedNames ?? []).not.toContain(name)
    expect(result.facts.state).toBe('unknown')
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'data <- utils::read.csv("inputs/observations.csv")\n' +
          'fit <- stats::optim(0, objective, gradient, method="BFGS")',
        context
      )
    ).toMatchObject({
      reads: ['inputs/observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('minimize callback file certainty after cache reload', () => {
  it.each([
    ['from scipy.optimize import minimize as solve', 'solve(fun=objective, x0=p0, jac=gradient)'],
    ['import scipy.optimize as opt', 'opt.minimize(objective, p0, (), "BFGS", gradient)']
  ])(
    'retains direct file candidates without certifying callback I/O: %s',
    async (imports, call) => {
      const context = await fileContext('python', [
        `${imports}\np0 = [0.]\nobjective_gain = 0.2\ngradient_gain = 0.4`,
        'def objective(beta):\n    return beta[0] * objective_gain + float(open("callback-input.txt").read())\ndef gradient(beta):\n    open("callback-trace.txt", "w").write(str(beta))\n    return [gradient_gain]'
      ])
      const access = await analyzeNotebookSourceFileAccess(
        'python',
        `with open("direct-input.csv", "r") as handle:\n    observed = handle.read()\nfit = ${call}`,
        context
      )
      expect(access.reads).toContain('direct-input.csv')
      expect(access).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
      })
    }
  )
})

describe('NumPy text converters after cache reload', () => {
  it.each([
    'np.loadtxt("observations.csv", converters=convert)',
    'np.loadtxt("observations.csv", converters={1: convert})',
    'np.loadtxt("observations.csv", float, "#", ",", {1: convert})',
    'np.genfromtxt("observations.csv", converters={1: convert})',
    'np.genfromtxt("observations.csv", float, "#", ",", 0, 0, {1: convert})'
  ])('retains the reader input without certifying converter I/O: %s', async (call) => {
    const context = await fileContext('python', [
      'import numpy as np\ncalibration = 1.0',
      'def convert(value):\n    with open("callback-input.txt") as handle:\n        return float(value) * calibration * float(handle.read())'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', `rows = ${call}`, context)
    ).toMatchObject({
      reads: ['observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it.each([
    'np.loadtxt("observations.csv")',
    'np.loadtxt("observations.csv", converters=None)',
    'np.loadtxt("observations.csv", converters={})',
    'np.loadtxt("observations.csv", float, "#", ",", None)',
    'np.genfromtxt("observations.csv")',
    'np.genfromtxt("observations.csv", converters=None)',
    'np.genfromtxt("observations.csv", converters={})',
    'np.genfromtxt("observations.csv", float, "#", ",", 0, 0, {})'
  ])('preserves complete ordinary reader coverage: %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', `import numpy as np\nrows = ${call}`)
    ).toMatchObject({
      reads: ['observations.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'np.loadtxt("observations.csv", converters=callbacks)',
    'np.loadtxt("observations.csv", converters={**options})',
    'np.loadtxt("observations.csv", converters=None, **options)',
    'np.loadtxt("observations.csv", float, "#", ",", convert, converters=None)',
    'np.loadtxt("observations.csv", *args)',
    'np.genfromtxt("observations.csv", **options)'
  ])('does not certify unresolved or expanded converters: %s', async (call) => {
    const context = await fileContext('python', [
      'import numpy as np\ndef convert(value):\n    return float(value)',
      'callbacks = {1: convert}\noptions = {}\nargs = []'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', `rows = ${call}`, context)
    ).toMatchObject({
      reads: ['observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('recognizes an imported reader alias without borrowing complete callback coverage', async () => {
    const context = await fileContext('python', [
      'from numpy import loadtxt as reader',
      'def convert(value):\n    return float(value) * calibration'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'rows = reader("observations.csv", converters={1: convert})',
        context
      )
    ).toMatchObject({
      reads: ['observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['from numpy import loadtxt as reader', 'reader = replacement', 'reader'],
    ['import numpy as np', 'np.loadtxt = replacement', 'np.loadtxt']
  ])('does not borrow a rebound reader identity: %s', async (imports, rebind, reader) => {
    const context = await fileContext('python', [
      imports,
      'def replacement(*args, **kwargs):\n    return None\ndef convert(value):\n    return float(value) * calibration',
      rebind
    ])
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      `rows = ${reader}("observations.csv", converters={1: convert})`,
      context
    )
    expect(access.reads).not.toContain('observations.csv')
    // The replacement is a closed helper returning None. Its own evidence can
    // be complete; the displaced NumPy reader must not contribute a file path.
    expect(access.writes).toEqual([])
  })
})

describe('SQLite readonly historical file context', () => {
  const setup = [
    'import sqlite3',
    'conn = sqlite3.connect("file:inputs/co2.sqlite?mode=ro", uri=True)',
    'cur = conn.cursor()'
  ].join('\n')
  const select =
    'cur.execute("SELECT row_id, uptake FROM observations WHERE conc >= ? ORDER BY row_id", (500,))\nrows = cur.fetchall()'
  const cwd = join(tmpdir(), 'sqlite-readonly-owner')

  it('retains the SQLite database input through three trustworthy cells and cache reload', async () => {
    const context = await fileContext(
      'python',
      [setup, select, select],
      Array.from({ length: 3 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      undefined,
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(context?.pythonBindings).toEqual(
      expect.arrayContaining([
        {
          name: 'conn',
          qualifiedName: 'sqlite3.Connection',
          kind: 'object',
          filePath: 'inputs/co2.sqlite'
        },
        {
          name: 'cur',
          qualifiedName: 'sqlite3.Cursor',
          kind: 'object',
          filePath: 'inputs/co2.sqlite'
        }
      ])
    )
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: ['inputs/co2.sqlite'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('establishes a literal SQLite connection from a still-trusted earlier import', async () => {
    const context = await fileContext(
      'python',
      ['import sqlite3', setup.replace('import sqlite3\n', '')],
      Array.from({ length: 2 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      undefined,
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: ['inputs/co2.sqlite'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not retain a SQLite input after a converter rebinds its cursor across cache reload', async () => {
    const converter = [
      'import pandas as pd',
      'def convert(value):',
      '    global cur',
      '    cur = sqlite3.connect("file:inputs/replacement.sqlite?mode=ro", uri=True).cursor()',
      '    return value',
      'pd.read_csv("inputs/values.csv", converters={"value": convert})'
    ].join('\n')
    const context = await fileContext(
      'python',
      [setup, converter, select],
      Array.from({ length: 3 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      undefined,
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['missing current cwd', {}, { cwdBefore: undefined, cwdAfter: undefined }],
    ['missing current run', {}, undefined],
    ['changed current cwd', {}, { cwdBefore: `${cwd}-other`, cwdAfter: `${cwd}-other` }],
    ['missing historical cwd', { cwdBefore: undefined }, { cwdBefore: cwd, cwdAfter: cwd }],
    [
      'changed then restored cwd',
      { script: 'import os\nos.chdir("elsewhere")\nos.chdir("..")' },
      { cwdBefore: cwd, cwdAfter: cwd }
    ],
    [
      'current cwd mutation',
      {},
      { cwdBefore: cwd, cwdAfter: cwd, script: 'import os\nos.chdir("elsewhere")\nos.chdir("..")' }
    ]
  ] as Array<[string, Partial<NotebookRunRecord>, Partial<NotebookRunRecord> | undefined]>)(
    'discards relative SQLite authority after %s',
    async (_label, historical, current) => {
      const context = await fileContext(
        'python',
        [setup, select],
        [
          { cwdBefore: cwd, cwdAfter: cwd },
          { cwdBefore: cwd, cwdAfter: cwd, ...historical }
        ],
        true,
        undefined,
        'epoch-1',
        current
      )
      expect(context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)).toEqual([])
      expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('does not recover SQLite authority across an opaque historical call', async () => {
    const context = await fileContext(
      'python',
      [setup, 'unknown(conn)', select],
      Array.from({ length: 3 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      undefined,
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(context?.pythonBindings?.some(({ filePath }) => filePath !== undefined)).toBeFalsy()
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: [],
      readState: 'partial'
    })
  })

  it.each([
    'duplicate identity',
    'oversized path',
    'import path',
    'NUL path',
    'backslash path'
  ] as const)('rebuilds a malformed SQLite cache entry with %s', async (kind) => {
    const context = await fileContext(
      'python',
      [setup, select],
      Array.from({ length: 2 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      (json) => {
        const cache = JSON.parse(json)
        let corruptedEntries = 0
        for (const run of Object.values(cache.runs) as Array<{
          fileContext?: NotebookSourceFileAccessContext
        }>) {
          const bindings = run.fileContext?.pythonBindings
          const binding = bindings?.find(({ name }) => name === 'cur')
          if (!binding) continue
          corruptedEntries++
          if (kind === 'duplicate identity') bindings!.push({ ...binding })
          if (kind === 'oversized path') binding.filePath = 'x'.repeat(4097)
          if (kind === 'import path') {
            binding.kind = 'import'
            binding.filePath = 'inputs/co2.sqlite'
          }
          if (kind === 'NUL path') binding.filePath = 'inputs/invalid\0.sqlite'
          if (kind === 'backslash path') binding.filePath = 'inputs\\co2.sqlite'
        }
        expect(corruptedEntries).toBeGreaterThan(0)
        return JSON.stringify(cache)
      },
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: ['inputs/co2.sqlite'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  const literalConnection = (path = 'inputs/co2.sqlite'): FileContextEntry => ({
    facts: {
      state: 'available',
      definedNames: ['sqlite3', 'conn'],
      usedNames: ['sqlite3'],
      mutatedNames: [],
      typeBindings: [{ target: 'conn', typeName: 'sqlite3.Connection' }],
      receiverCalls: [
        {
          receiver: 'sqlite3',
          member: 'connect',
          kind: 'receiver',
          argumentNames: [],
          positionalArgumentNames: [[]],
          receiverChain: [],
          keywordArguments: [{ name: 'uri', argumentNames: [], staticBoolean: true }],
          resultNames: ['conn']
        }
      ]
    },
    fileContext: {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonBindings: [
        { name: 'sqlite3', qualifiedName: 'sqlite3', kind: 'import' },
        { name: 'conn', qualifiedName: 'sqlite3.Connection', kind: 'object', filePath: path }
      ]
    }
  })

  it('rejects a cached fresh SQLite cursor whose actual receiver lost its path', () => {
    const initial = literalConnection()
    const barrier: FileContextEntry = {
      ...initial,
      facts: { state: 'available', definedNames: [], usedNames: [], mutatedNames: [] },
      sqliteRelativePathBarrier: true
    }
    const cursor: FileContextEntry = {
      facts: {
        state: 'available',
        definedNames: ['cur2'],
        usedNames: ['conn'],
        mutatedNames: [],
        typeBindings: [{ target: 'cur2', typeName: 'sqlite3.Cursor' }],
        receiverCalls: [
          {
            receiver: 'conn',
            member: 'cursor',
            kind: 'receiver',
            argumentNames: [],
            positionalArgumentNames: [],
            keywordArguments: [],
            receiverChain: [],
            resultNames: ['cur2']
          }
        ]
      },
      fileContext: {
        ...initial.fileContext,
        pythonBindings: [
          ...initial.fileContext.pythonBindings!,
          {
            name: 'cur2',
            qualifiedName: 'sqlite3.Cursor',
            kind: 'object',
            filePath: 'inputs/co2.sqlite'
          }
        ]
      }
    }
    const context = projectNotebookFileContext('python', [initial, barrier, cursor])
    expect(context?.pythonBindings?.find(({ name }) => name === 'cur2')).toEqual({
      name: 'cur2',
      qualifiedName: 'sqlite3.Cursor',
      kind: 'object'
    })
  })

  it('rejects a cached fresh SQLite constructor derived from an inherited URI', () => {
    const constructor = literalConnection()
    constructor.facts.receiverCalls![0]!.argumentNames = ['uri']
    constructor.facts.receiverCalls![0]!.positionalArgumentNames = [['uri']]
    const context = projectNotebookFileContext('python', [
      {
        facts: { state: 'available', definedNames: ['uri'], usedNames: [], mutatedNames: [] },
        fileContext: {
          staticStrings: [{ name: 'uri', value: 'file:inputs/changed.sqlite?mode=ro' }],
          staticCollections: [],
          localFileWrappers: []
        }
      },
      constructor
    ])
    expect(context?.pythonBindings?.find(({ name }) => name === 'conn')).toEqual({
      name: 'conn',
      qualifiedName: 'sqlite3.Connection',
      kind: 'object'
    })
  })

  it.each(['cursor after cwd restoration', 'constructor after URI replacement'] as const)(
    'rejects cached fresh SQLite authority through the public owner: %s',
    async (kind) => {
      const scripts =
        kind === 'cursor after cwd restoration'
          ? [setup, 'print(1)', 'cur2 = conn.cursor()']
          : [
              'import sqlite3\nuri = "file:inputs/co2.sqlite?mode=ro"',
              'conn = sqlite3.connect(uri, uri=True)\ncur = conn.cursor()'
            ]
      const context = await fileContext(
        'python',
        scripts,
        scripts.map(() => ({ cwdBefore: cwd, cwdAfter: cwd })),
        true,
        (json) => {
          const cached = JSON.parse(json).runs[`run-${scripts.length - 1}`]
          expect(cached.fileContext.pythonBindings).toEqual(
            expect.arrayContaining([
              {
                name: kind === 'cursor after cwd restoration' ? 'cur2' : 'conn',
                qualifiedName:
                  kind === 'cursor after cwd restoration' ? 'sqlite3.Cursor' : 'sqlite3.Connection',
                kind: 'object',
                filePath: 'inputs/co2.sqlite'
              }
            ])
          )
          return json
        },
        'epoch-1',
        { cwdBefore: cwd, cwdAfter: cwd },
        (runs) => {
          if (kind === 'cursor after cwd restoration')
            runs[1]!.script = 'import os\nos.chdir("elsewhere")\nos.chdir("..")'
          else runs[0]!.script = 'import sqlite3\nuri = "file:inputs/changed.sqlite?mode=ro"'
        }
      )
      expect(context?.pythonBindings?.some(({ filePath }) => filePath !== undefined)).toBe(false)
      const query =
        kind === 'cursor after cwd restoration' ? select.replaceAll('cur.', 'cur2.') : select
      expect(await analyzeNotebookSourceFileAccess('python', query, context)).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  const entry = (path?: string, definedNames = ['sqlite3', 'conn']): FileContextEntry => {
    const value = literalConnection(path)
    value.facts.definedNames = definedNames
    if (path === undefined) delete value.fileContext.pythonBindings![1]!.filePath
    return value
  }

  it('cannot restore a revoked SQLite path from an old binding or type overlay', () => {
    const revoked = entry()
    const context = projectNotebookFileContext('python', [entry('inputs/co2.sqlite'), revoked])
    expect(context?.pythonBindings?.find(({ name }) => name === 'conn')).toEqual({
      name: 'conn',
      qualifiedName: 'sqlite3.Connection',
      kind: 'object'
    })
    expect(revoked.fileContext.pythonBindings?.[1]).not.toHaveProperty('filePath')
  })

  it('does not revive relative SQLite authority from later cached outgoing candidates', () => {
    const barrier = entry('inputs/co2.sqlite')
    barrier.sqliteRelativePathBarrier = true
    const later = entry('inputs/co2.sqlite', [])
    const context = projectNotebookFileContext('python', [
      entry('inputs/co2.sqlite'),
      barrier,
      later
    ])
    expect(context?.pythonBindings?.find(({ name }) => name === 'conn')).toEqual({
      name: 'conn',
      qualifiedName: 'sqlite3.Connection',
      kind: 'object'
    })
  })

  it.each(['entry', 'final'] as const)(
    'keeps absolute SQLite candidates and identities behind a %s cwd barrier',
    (barrier) => {
      const absolute = entry('/science/co2.sqlite')
      const relative = entry('inputs/co2.sqlite')
      relative.fileContext.pythonBindings![1]!.name = 'relative'
      relative.facts.definedNames = ['relative']
      relative.facts.typeBindings = [{ target: 'relative', typeName: 'sqlite3.Connection' }]
      relative.facts.receiverCalls![0]!.resultNames = ['relative']
      if (barrier === 'entry') {
        relative.sqliteRelativePathBarrier = true
      }
      // Each outgoing snapshot carries the still-live candidates, not just new definitions.
      const context = projectNotebookFileContext(
        'python',
        [
          absolute,
          {
            ...relative,
            fileContext: {
              ...relative.fileContext,
              pythonBindings: [
                absolute.fileContext.pythonBindings![1]!,
                ...relative.fileContext.pythonBindings!
              ]
            }
          }
        ],
        { sqliteRelativePathBarrier: barrier === 'final' }
      )
      expect(context?.pythonBindings).toEqual(
        expect.arrayContaining([
          {
            name: 'conn',
            qualifiedName: 'sqlite3.Connection',
            kind: 'object',
            filePath: '/science/co2.sqlite'
          },
          { name: 'relative', qualifiedName: 'sqlite3.Connection', kind: 'object' }
        ])
      )
      expect(absolute.fileContext.pythonBindings?.[1]?.filePath).toBe('/science/co2.sqlite')
      expect(relative.fileContext.pythonBindings?.[1]?.filePath).toBe('inputs/co2.sqlite')
    }
  )

  it.each(['alias', 'close', 'mutation', 'conditional', 'taint'] as const)(
    'does not restore SQLite candidates after %s facts',
    (kind) => {
      const invalid = entry('inputs/co2.sqlite')
      if (kind === 'alias')
        invalid.facts.aliases = [{ target: 'other', source: 'conn', kind: 'reference' }]
      if (kind === 'close') invalid.facts.receiverCalls = [{ receiver: 'conn', member: 'close' }]
      if (kind === 'mutation') invalid.facts.possiblyMutatedNames = ['conn']
      if (kind === 'conditional') invalid.facts.conditionallyDefinedNames = ['conn']
      if (kind === 'taint') invalid.fileContext.pythonTaintedNamespaces = ['sqlite3']
      const context = projectNotebookFileContext('python', [entry('inputs/co2.sqlite'), invalid])
      expect(context?.pythonBindings?.some(({ filePath }) => filePath !== undefined)).toBeFalsy()
    }
  )
})

describe('file context after mutable path collections', () => {
  const withHelper = [
    'import csv',
    'def read_rows(path):',
    '    with open(path, "r", newline="", encoding="utf-8") as handle:',
    '        return list(csv.DictReader(handle))'
  ].join('\n')

  it('captures all literal inputs of a same-cell sole-With helper', async () => {
    const paths = ['inputs/raw.csv', 'inputs/settings.csv', 'outputs/fit.csv', 'outputs/pred.csv']
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [withHelper, ...paths.map((path) => `rows = read_rows("${path}")`)].join('\n')
    )
    expect(result).toMatchObject({
      reads: [...paths].sort(),
      writes: [],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('binds keyword paths of a same-cell sole-With helper', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `${withHelper}\nrows = read_rows(path="input.csv")`
      )
    ).toMatchObject({ reads: ['input.csv'] })
  })

  it('retains sole-With inputs beside an unrelated deferred global callback', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        [
          withHelper,
          'rows = read_rows("input.csv")',
          'count = 0',
          'def objective(rate):',
          '    global count',
          '    count += 1',
          '    return rate * rate'
        ].join('\n')
      )
    ).toMatchObject({
      reads: ['input.csv'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not replay a sole-With helper with its own cross-scope write', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        [
          'def read_rows(path):',
          '    with open(path) as handle:',
          '        global data',
          '        data = handle.read()',
          'read_rows("decoy.csv")'
        ].join('\n')
      )
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it.each([
    ['path argument', 'PATH', '"new.csv"', withHelper, 'read_rows(PATH)'],
    [
      'captured path',
      'PATH',
      '"new.csv"',
      withHelper.replace('read_rows(path)', 'read_rows()').replace('open(path,', 'open(PATH,'),
      'read_rows()'
    ],
    ['open identity', 'open', 'replacement', withHelper, 'read_rows("old.csv")'],
    ['helper identity', 'read_rows', 'replacement', withHelper, 'read_rows("old.csv")']
  ])(
    'does not retain an old %s after an opaque sibling namespace write',
    async (_label, target, value, helper, call) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          'PATH = "old.csv"',
          helper,
          'def change_binding():',
          `    global ${target}`,
          `    ${target} = ${value}`,
          'writer = change_binding',
          'writer()',
          call
        ].join('\n')
      )
      expect(result).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it.each([
    ['uncalled', withHelper],
    ['rebound helper', `${withHelper}\nread_rows = replacement\nread_rows("decoy.csv")`],
    ['aliased helper', `${withHelper}\nreader = read_rows\nreader("decoy.csv")`],
    ['shadowed open', `${withHelper}\nopen = replacement\nread_rows("decoy.csv")`],
    [
      'parameter shadowing',
      `${withHelper.replace('read_rows(path)', 'read_rows(path, open)')}\nread_rows("decoy.csv", replacement)`
    ],
    [
      'decorated',
      `${withHelper.replace('def read_rows', '@decorate\ndef read_rows')}\nread_rows("decoy.csv")`
    ],
    [
      'unawaited async',
      `${withHelper.replace('def read_rows', 'async def read_rows')}\nread_rows("decoy.csv")`
    ],
    [
      'uniterated generator',
      `${withHelper.replace('return list', 'yield list')}\nread_rows("decoy.csv")`
    ],
    [
      'conditional definition',
      `if condition:\n${withHelper
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')}\nread_rows("decoy.csv")`
    ]
  ])('does not infer inputs from a %s sole-With helper', async (_label, source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({ reads: [] })
  })

  it('keeps module pattern captures outside sole-With helper replay', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        withHelper,
        'source_path = "old.csv"',
        'match value:',
        '    case {"path": source_path}:',
        '        pass',
        'read_rows(source_path)'
      ].join('\n')
    )
    expect(result).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it.each(['read_rows', 'open', '(read_rows, other)', '(other, *read_rows)'])(
    'revokes a sole-With helper after a context manager binds %s',
    async (target) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `${withHelper}\nwith open("live.csv") as ${target}:\n    read_rows("decoy.csv")`
      )
      expect(result).toMatchObject({ reads: ['live.csv'], readState: 'partial' })
    }
  )

  it('does not replay a later sole-With definition at an earlier call', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'def read_rows():',
        '    with open("first.csv") as handle:',
        '        return handle.read()',
        'read_rows()',
        'def read_rows():',
        '    with open("future.csv") as handle:',
        '        return handle.read()'
      ].join('\n')
    )
    expect(result.reads).not.toContain('future.csv')
    expect(result.readState).toBe('partial')
  })

  it.each([
    ['', '', []],
    ['with open("retained.csv") as handle:\n    prior = handle.read()', '', ['retained.csv']],
    ['', 'read_rows("actual.csv")', ['actual.csv']]
  ] as const)(
    'activates a sole-With helper only at its definition: %s / %s',
    async (prior, later, reads) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          prior,
          'try:',
          '    read_rows("future.csv")',
          'except NameError:',
          '    pass',
          withHelper,
          later
        ]
          .filter(Boolean)
          .join('\n')
      )
      expect(result).toMatchObject({ reads, readState: 'partial', externalState: 'partial' })
    }
  )

  it.each(['numpy import loadtxt', 'pandas import read_csv'])(
    'retains the imported %s reader until a sole-With definition replaces it',
    async (imported) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          `from ${imported} as read_rows`,
          'read_rows("imported.csv")',
          'def read_rows(path):',
          '    with open("helper.csv") as handle:',
          '        return handle.read()',
          'read_rows("unused.csv")'
        ].join('\n')
      )
      expect(result).toMatchObject({
        reads: ['helper.csv', 'imported.csv'],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('does not infer empty complete I/O from an imported reader before a future helper', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'from numpy import loadtxt as read_rows',
        'read_rows("actual.csv")',
        'def read_rows(path):',
        '    with open("future-internal.csv") as handle:',
        '        return handle.read()'
      ].join('\n')
    )
    expect(result.reads).toEqual(['actual.csv'])
    expect(result.reads).not.toContain('future-internal.csv')
  })

  it.each([
    ['read_rows = replacement', []],
    ['with open("retained.csv") as read_rows:\n    pass', ['retained.csv']]
  ] as const)(
    'keeps a helper revoked before its definition conservative: %s',
    async (earlier, reads) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `${earlier}\n${withHelper}\nread_rows("decoy.csv")`
      )
      expect(result).toMatchObject({ reads, readState: 'partial', externalState: 'partial' })
    }
  )

  it.each([
    ['emit = replacement', '', []],
    ['', 'emit = replacement', []],
    ['with open("retained.csv") as emit:\n    pass', '', ['retained.csv']],
    ['try:\n    emit("future.txt")\nexcept NameError:\n    pass', '', []]
  ] as const)(
    'keeps unproven writer helper I/O partial: %s / %s',
    async (earlier, later, reads) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          earlier,
          'def emit(path):',
          '    payload = "value"',
          '    with open(path, "w") as handle:',
          '        handle.write(payload)',
          later,
          ...(earlier.startsWith('try:') ? [] : ['emit("unproven.txt")'])
        ]
          .filter(Boolean)
          .join('\n')
      )
      expect(result).toMatchObject({
        reads,
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each([
    'class read_rows:\n    pass',
    'if condition:\n    def read_rows(path):\n        return []'
  ])(
    'does not replay a sole-With helper replaced by another declaration: %s',
    async (declaration) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `${withHelper}\n${declaration}\nread_rows("decoy.csv")`
        )
      ).toMatchObject({ reads: [], readState: 'partial' })
    }
  )

  it('forgets a sole-With helper argument rebound by tuple unpacking', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `${withHelper}\nsource_path = "decoy.csv"\nwith opaque_manager as (source_path, other):\n    read_rows(source_path)`
    )
    expect(result).toMatchObject({ reads: [], readState: 'partial' })
  })

  it.each(['np', '(np, other)', '(other, *np)'])(
    'does not recover a reader after a With target rebinds %s',
    async (target) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import numpy as np\nwith open("live.csv") as ${target}:\n    pass\nnp.loadtxt("decoy.csv")`
      )
      expect(result).toMatchObject({ reads: ['live.csv'], readState: 'partial' })
    }
  )

  it.each(['np.loadtxt', 'np.__dict__["loadtxt"]', '(np.loadtxt, other)'])(
    'revokes a reader mutated by a With target %s',
    async (target) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import numpy as np\nwith open("live.csv") as ${target}:\n    pass\nnp.loadtxt("decoy.csv")`
      )
      expect(result).toMatchObject({ reads: ['live.csv'], readState: 'partial' })
    }
  )

  it.each(['np.loadtxt', 'np.__dict__["loadtxt"]', '(np.loadtxt, other)'])(
    'retains With target mutation %s after helper scope restoration',
    async (target) => {
      const source = [
        'import numpy as np',
        'def read_rows(path):',
        `    with open("live.csv") as ${target}:`,
        '        return np.loadtxt(path)',
        'read_rows("decoy.csv")',
        'import numpy as again',
        'again.loadtxt("after.csv")'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['live.csv'],
        readState: 'partial',
        externalState: 'partial'
      })
      const context = await fileContext('python', [source])
      expect(context?.pythonTaintedNamespaces).toContain('numpy')
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import numpy as restored\nrestored.loadtxt("cached-decoy.csv")',
          context
        )
      ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it('keeps a separate module import after a local With name rebind', async () => {
    const source = [
      'import numpy as np',
      'import numpy as original',
      'with open("live.csv") as np:',
      '    pass',
      'np.loadtxt("decoy.csv")',
      'original.loadtxt("retained.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['live.csv', 'retained.csv'],
      readState: 'partial'
    })
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces ?? []).not.toContain('numpy')
    expect(
      await analyzeNotebookSourceFileAccess('python', 'original.loadtxt("next.csv")', context)
    ).toMatchObject({ reads: ['next.csv'] })
  })

  it.each([
    ['np.loadtxt', '    np = None'],
    ['np.__dict__["loadtxt"]', '    np = None'],
    ['(np.loadtxt, np)', ''],
    ['np.loadtxt', '    def inner(arg=(np := None)):\n        pass'],
    ['np.loadtxt', '    def inner(*, arg=(np := None)):\n        pass'],
    ['np.loadtxt', '    @((np := None))\n    def inner():\n        pass'],
    ['np.loadtxt', '    class Inner((np := object)):\n        pass'],
    ['np.loadtxt', '    deferred = lambda arg=(np := None): arg']
  ])('does not taint a module borrowed for an unbound helper local: %s', async (target, tail) => {
    const source = [
      'import numpy as np',
      'import numpy as original',
      'def read_rows():',
      `    with open("live.csv") as ${target}:`,
      '        pass',
      tail,
      'try:',
      '    read_rows()',
      'except UnboundLocalError:',
      '    pass',
      'original.loadtxt("retained.csv")'
    ]
      .filter(Boolean)
      .join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['live.csv', 'retained.csv'],
      readState: 'partial'
    })
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces ?? []).not.toContain('numpy')
    expect(
      await analyzeNotebookSourceFileAccess('python', 'original.loadtxt("next.csv")', context)
    ).toMatchObject({ reads: ['next.csv'] })
  })

  it.each([
    '    values = [np for np in (1,)]',
    '    deferred = lambda np: np',
    '    def deferred(np):\n        return np'
  ])('does not borrow comprehension or nested parameters as helper locals: %s', async (tail) => {
    const source = [
      'import numpy as np',
      'import numpy as original',
      'def read_rows():',
      '    with open("live.csv") as np.loadtxt:',
      '        pass',
      tail,
      'read_rows()',
      'original.loadtxt("decoy.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['live.csv'],
      readState: 'partial'
    })
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces).toContain('numpy')
  })

  it('applies With target rebinding before the next context expression', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import numpy as np\nwith open("live.csv") as np, np.loadtxt("decoy.csv") as handle:\n    pass'
      )
    ).toMatchObject({ reads: ['live.csv'], readState: 'partial' })
  })

  it.each([
    ['before', '    with open("live.csv") as handle:\n        pass', []],
    ['after', '', ['future.csv']]
  ] as const)(
    'checks a nested reader invocation %s its definition statement',
    async (_order, early, reads) => {
      const source = [
        'import pandas as pd',
        'def read_rows():',
        early,
        '    def open(path):',
        '        return pd.read_csv("future.csv")',
        ...(early ? [] : ['    with open("live.csv") as handle:', '        pass']),
        'try:',
        '    read_rows()',
        'except UnboundLocalError:',
        '    pass'
      ]
        .filter(Boolean)
        .join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({ reads })
    }
  )

  it.each(['numpy import loadtxt', 'pandas import read_csv'])(
    'uses the actual local reader identity after from %s',
    async (imported) => {
      const source = [
        'def read_rows(path):',
        `    from ${imported} as read_input`,
        '    return read_input(path)',
        'read_rows("input.csv")'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['input.csv']
      })
    }
  )

  it.each([
    ['    read_input = None', []],
    ['    with open("live.csv") as read_input:\n        pass', ['live.csv']]
  ] as const)('revokes a local imported reader after %s', async (replacement, reads) => {
    const source = [
      'def read_rows(path):',
      '    from numpy import loadtxt as read_input',
      replacement,
      '    return read_input(path)',
      'read_rows("decoy.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads,
      readState: 'partial'
    })
  })

  it.each([
    ['(np.loadtxt, np)', ['live.csv'], true],
    ['(np, np.loadtxt)', ['live.csv', 'retained.csv'], false]
  ] as const)('applies mixed With target stores in order: %s', async (target, reads, tainted) => {
    const source = [
      'import numpy as np',
      'import numpy as original',
      `with open("live.csv") as ${target}:`,
      '    pass',
      'original.loadtxt("retained.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({ reads })
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces?.includes('numpy') ?? false).toBe(tainted)
  })

  it('keeps unknown context manager effects partial around known helper inputs', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pandas as pd',
        'def read_rows(path, manager):',
        '    with manager:',
        '        frame = pd.read_csv(path)',
        'read_rows("input.csv", opaque_manager)'
      ].join('\n')
    )
    expect(result).toMatchObject({
      reads: ['input.csv'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('captures parameterized I/O from multi-statement local file helpers', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'def summarize(input_path, output_path):',
        '    frame = pd.read_csv(input_path)',
        '    frame.groupby("group")["value"].mean().to_csv(output_path, index=False)',
        'summarize("input.csv", "output.csv")'
      ].join('\n'),
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonBindings: [{ name: 'pd', qualifiedName: 'pandas', kind: 'import' }]
      }
    )
    expect(result).toMatchObject({
      reads: ['input.csv'],
      writes: ['output.csv'],
      readState: 'complete',
      writeState: 'complete'
    })
    expect(result.externalState).toBe('complete')
  })

  it('replays a stable outer helper that delegates to a sole-return reader helper', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pandas as pd',
        'def load_coordinates(path):',
        '    return pd.read_csv(path)',
        'def main(input_csv):',
        '    frame = load_coordinates(input_csv)',
        '    return frame.shape',
        'main("outputs/coordinates.csv")'
      ].join('\n')
    )
    expect(result).toMatchObject({
      reads: ['outputs/coordinates.csv'],
      readState: 'partial'
    })
  })

  it.each([
    ['an alias', '    reader = load_coordinates\n    frame = reader(input_csv)'],
    [
      'a rebound reader',
      '    load_coordinates = replacement\n    frame = load_coordinates(input_csv)'
    ],
    [
      'a shadowing parameter',
      'def main(load_coordinates):\n    frame = load_coordinates("outputs/coordinates.csv")'
    ]
  ])('does not replay a nested reader helper through %s', async (_label, body) => {
    const source = [
      'import pandas as pd',
      'def load_coordinates(path):',
      '    return pd.read_csv(path)',
      body,
      'main("outputs/coordinates.csv")'
    ].join('\n')
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).not.toContain('outputs/coordinates.csv')
    expect(result.readState).toBe('partial')
  })

  it('retains streaming SHA256 inputs through a bounded tuple loop', async () => {
    const source =
      'import hashlib\ndef digest(p):\n    h = hashlib.sha256()\n    with open(p, "rb") as fh:\n        for chunk in iter(lambda: fh.read(65536), b""):\n            h.update(chunk)\n    return h.hexdigest()\nhashes = {}\nfor label, p in [("faithful", "outputs/faithful.csv"), ("converted", "outputs/converted.csv")]:\n    hashes[label] = digest(p)'
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
      'outputs/converted.csv',
      'outputs/faithful.csv'
    ])
  })

  const streamingDigestSource =
    'import hashlib\ndef digest(p):\n    h = hashlib.sha256()\n    with open(p, "rb") as fh:\n        for chunk in iter(lambda: fh.read(65536), b""):\n            h.update(chunk)\n    return h.hexdigest()'
  const streamingDigestLoop =
    'hashes = {}\nfor label, p in [("faithful", "outputs/faithful.csv"), ("converted", "outputs/converted.csv")]:\n    hashes[label] = digest(p)'
  it('retains streaming SHA256 inputs using paths from preceding cells', async () => {
    const context = await fileContext('python', [
      'SOURCE = "outputs/faithful.csv"',
      'CONVERTED = "outputs/converted.csv"'
    ])
    const source =
      streamingDigestSource +
      '\n' +
      streamingDigestLoop
        .replace('"outputs/faithful.csv"', 'SOURCE')
        .replace('"outputs/converted.csv"', 'CONVERTED')
    expect((await analyzeNotebookSourceFileAccess('python', source, context)).reads).toEqual([
      'outputs/converted.csv',
      'outputs/faithful.csv'
    ])
  })
  it.each([
    'open = replacement',
    'iter = replacement',
    'hashlib.sha256 = replacement',
    'opaque(hashlib)',
    'import builtins; builtins.open = replacement',
    'import builtins; builtins.iter = replacement',
    'digest = replacement',
    'hashlib.sha256 = replacement\nimport hashlib'
  ])('does not certify streaming SHA256 loop inputs after %s', async (mutation) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      streamingDigestSource + '\n' + mutation + '\n' + streamingDigestLoop
    )
    expect(result.reads).toEqual([])
    expect(result.readState).toBe('partial')
  })
  it.each([
    ['empty read', 'fh.read(65536)', 'fh.read(0)'],
    ['dynamic read size', 'fh.read(65536)', 'fh.read(choose_size())'],
    ['side effect before open', 'hashlib.sha256()', 'hashlib.sha256(mutate())'],
    ['effectful update', 'h.update(chunk)', 'h.update(transform(chunk))'],
    ['text sentinel', 'b""', '""'],
    ['nonempty sentinel', 'b""', 'b"stop"'],
    ['lambda default', 'lambda:', 'lambda x=mutate():'],
    ['callback instead of lambda', 'lambda: fh.read(65536)', 'read_chunk'],
    ['extra loop effect', 'h.update(chunk)', 'h.update(chunk)\n            mutate()'],
    ['return effect', 'h.hexdigest()', 'h.hexdigest(mutate())'],
    ['write mode', '"rb"', '"wb"'],
    ['keyword expansion', 'open(p, "rb")', 'open(p, "rb", **options)'],
    ['shadowed iterator local', 'h = hashlib.sha256()', 'iter = hashlib.sha256()'],
    ['duplicate binding', 'as fh:', 'as h:']
  ])('does not certify streaming SHA256 with %s', async (_label, from, to) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      streamingDigestSource.replace(from, to) + '\n' + streamingDigestLoop
    )
    expect(result.reads).toEqual([])
    expect(result.readState).toBe('partial')
  })
  it.each(['open', 'iter'])(
    'rejects streaming SHA256 with inherited %s shadowing',
    async (name) => {
      const context = await fileContext('python', [name + ' = replacement'])
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        streamingDigestSource + '\n' + streamingDigestLoop,
        context
      )
      expect(result.reads).toEqual([])
    }
  )
  it.each(['hashlib', 'builtins', '*'])(
    'rejects streaming SHA256 with inherited %s taint',
    async (namespace) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        streamingDigestSource + '\n' + streamingDigestLoop,
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonTaintedNamespaces: [namespace]
        }
      )
      expect(result.reads).toEqual([])
    }
  )

  it.each([false, true])('retains streaming MD5 with helper in prior cell=%s', async (prior) => {
    const helper = streamingDigestSource.replace('hashlib.sha256()', 'hashlib.md5()')
    const context = prior ? await fileContext('python', [helper]) : undefined
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      (prior ? '' : helper + '\n') + streamingDigestLoop,
      context
    )
    expect(result).toMatchObject({
      reads: ['outputs/converted.csv', 'outputs/faithful.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    if (prior) expect(context?.localFileWrappers[0]?.pythonStreamingChecksum).toBe('md5')
  })
  it.each([
    'tools::md5sum("faithful.csv")',
    'tools::md5sum(files=c("faithful.csv","residuals.csv"))'
  ])('retains qualified R MD5 input: %s', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result).toMatchObject({
      reads: source.includes('residuals') ? ['faithful.csv', 'residuals.csv'] : ['faithful.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([false, true])(
    'retains streaming MD5 through cache precompute=%s',
    async (precompute) => {
      const helper = streamingDigestSource.replace('hashlib.sha256()', 'hashlib.md5()')
      const context = await fileContext('python', [helper], [], precompute)
      expect(
        (await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)).reads
      ).toEqual(['outputs/converted.csv', 'outputs/faithful.csv'])
    }
  )
  it.each([
    'hashlib.md5 = replacement',
    'open = replacement',
    'iter = replacement',
    'opaque(hashlib)',
    'opaque(digest)',
    'alias = digest\nopaque(alias)',
    'box = [digest]\nopaque(box)',
    'digest.__code__ = replacement.__code__',
    'import builtins; builtins.open = replacement'
  ])('revokes streaming MD5 after %s', async (mutation) => {
    const helper = streamingDigestSource.replace('hashlib.sha256()', 'hashlib.md5()')
    const context = await fileContext('python', [helper, mutation])
    expect(
      (await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)).reads
    ).toEqual([])
  })
  it.each([
    ['hashlib.md5()', 'hashlib.sha1()'],
    ['hashlib.md5()', 'hashlib.md5(usedforsecurity=False)'],
    ['fh.read(65536)', 'fh.read(choose_size())'],
    ['h.update(chunk)', 'h.update(transform(chunk))'],
    ['"rb"', '"wb"'],
    ['b""', 'b"done"']
  ])('rejects unsupported streaming MD5 shape %s => %s', async (from, to) => {
    const helper = streamingDigestSource
      .replace('hashlib.sha256()', 'hashlib.md5()')
      .replace(from, to)
    const context = await fileContext('python', [helper])
    expect(context?.localFileWrappers.some((w) => w.pythonStreamingChecksum) ?? false).toBe(false)
  })
  it.each([false, true])(
    'retains qualified R MD5 earlier-cell paths with precompute=%s',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['paths <- c("faithful.csv","residuals.csv")'],
        [],
        precompute
      )
      expect(
        await analyzeNotebookSourceFileAccess('r', 'hashes <- tools::md5sum(files=paths)', context)
      ).toMatchObject({
        reads: ['faithful.csv', 'residuals.csv'],
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  )
  it.each([
    'tools:::md5sum("faithful.csv")',
    'tools::md5sum(c("faithful.csv"))',
    'tools::md5sum(files="faithful.csv")'
  ])('retains qualified R MD5 equivalent call %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['faithful.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([
    'md5sum("faithful.csv")',
    'custom::md5sum("faithful.csv")',
    'tools::md5sum(files=choose_path())',
    'tools::md5sum(files="faithful.csv",extra=1)',
    'tools::md5sum(file="faithful.csv")',
    'tools::md5sum()',
    'tools::md5sum(files=structure("faithful.csv",class="custom"))',
    'tools::md5sum(files=c("faithful.csv",unknown))',
    'tools::md5sum(files="https://example.test/data.csv")'
  ])('keeps unsupported qualified R MD5 conservative: %s', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.reads).toEqual([])
    expect(result.externalState).toBe('partial')
  })
  it.each(['::', ':::'])('rejects qualified R MD5 after replacing %s', async (operator) => {
    const mutation = '\u0060' + operator + '\u0060 <- function(...) function(...) "memory"'
    const call = 'tools' + operator + 'md5sum("faithful.csv")'
    expect((await analyzeNotebookSourceFileAccess('r', mutation + '\n' + call)).reads).toEqual([])
    const context = await fileContext('r', [mutation])
    expect((await analyzeNotebookSourceFileAccess('r', call, context)).reads).toEqual([])
  })
  it('excludes qualified R MD5 rereads of same-cell outputs', async () => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'writeLines("x","faithful.csv")\nhash <- tools::md5sum("faithful.csv")'
        )
      ).reads
    ).toEqual([])
  })

  it('retains cross-cell checksum inputs in dictionary comprehensions', async () => {
    const context = await fileContext('python', [streamingDigestSource])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'hashes = {label: digest(p) for label,p in [("faithful","outputs/faithful.csv"),("converted","outputs/converted.csv")]}',
      context
    )
    expect(result).toMatchObject({
      reads: ['outputs/converted.csv', 'outputs/faithful.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each(['sha256', 'md5'])(
    'retains %s checksum comprehension with local and cached helpers',
    async (algorithm) => {
      const helper = streamingDigestSource.replace(
        'hashlib.sha256()',
        'hashlib.' + algorithm + '()'
      )
      for (const prior of [false, true]) {
        const context = prior ? await fileContext('python', [helper]) : undefined
        for (const expr of [
          '{label:digest(p) for label,p in [("data","faithful.csv")]}',
          '[digest(p) for p in ["faithful.csv"]]',
          '{p:digest(p) for p in ["faithful.csv"]}'
        ]) {
          expect(
            await analyzeNotebookSourceFileAccess(
              'python',
              (prior ? '' : helper + '\n') + 'values=' + expr,
              context
            )
          ).toMatchObject({
            reads: ['faithful.csv'],
            readState: 'complete',
            writeState: 'complete',
            externalState: 'complete'
          })
        }
      }
    }
  )
  it.each([false, true])(
    'retains checksum comprehension paths through cache precompute=%s',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [streamingDigestSource, 'paths=["faithful.csv","residuals.csv"]'],
        [],
        precompute
      )
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            'python',
            'values={p:digest(p) for p in paths}',
            context
          )
        ).reads
      ).toEqual(['faithful.csv', 'residuals.csv'])
    }
  )
  it.each([false, true])(
    'retains immutable checksum tuple rows across cells precompute=%s',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [
          streamingDigestSource,
          'targets=(("source","faithful.csv"),("residual","residuals.csv"))',
          'marker=1'
        ],
        [],
        precompute
      )
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'hashes={label:digest(p) for label,p in targets}',
          context
        )
      ).toMatchObject({
        reads: ['faithful.csv', 'residuals.csv'],
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  )

  it.each([false, true])(
    'retains immutable tuple row aliases, duplicate labels and loops precompute=%s',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [
          streamingDigestSource,
          'targets=(("same","a.csv"),("same","b.csv"))\nalias=targets',
          'targets=(("new","c.csv"),)'
        ],
        [],
        precompute
      )
      for (const source of [
        'hashes={label:digest(p) for label,p in alias}',
        'for label,p in alias:\n    value=digest(p)'
      ]) {
        expect((await analyzeNotebookSourceFileAccess('python', source, context)).reads).toEqual([
          'a.csv',
          'b.csv'
        ])
      }
    }
  )
  it.each(['[("source","old.csv")]', '(["source","old.csv"],)', '[["source","old.csv"]]'])(
    'does not persist mutable nested checksum rows: %s',
    async (value) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          [streamingDigestSource, 'targets=' + value],
          [],
          precompute
        )
        expect(context?.staticCollections.find((c) => c.name === 'targets')).toBeUndefined()
        expect(
          (
            await analyzeNotebookSourceFileAccess(
              'python',
              'hashes={label:digest(p) for label,p in targets}',
              context
            )
          ).reads
        ).toEqual([])
      }
    }
  )
  it.each(['targets=choose()', 'del targets', 'if condition:\n    targets=(("other","new.csv"),)'])(
    'revokes immutable tuple rows after uncertain state: %s',
    async (mutation) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          [streamingDigestSource, 'targets=(("source","old.csv"),)', mutation],
          [],
          precompute
        )
        expect(
          (
            await analyzeNotebookSourceFileAccess(
              'python',
              'hashes={label:digest(p) for label,p in targets}',
              context
            )
          ).reads
        ).not.toContain('old.csv')
      }
    }
  )
  it.each([false, true])('uses rebound immutable tuple rows precompute=%s', async (precompute) => {
    const context = await fileContext(
      'python',
      [streamingDigestSource, 'targets=(("source","old.csv"),)', 'targets=(("source","new.csv"),)'],
      [],
      precompute
    )
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'python',
          'hashes={label:digest(p) for label,p in targets}',
          context
        )
      ).reads
    ).toEqual(['new.csv'])
  })
  it('does not persist oversized immutable tuple rows', async () => {
    const values = Array.from({ length: 65 }, (_, i) => '("label","file' + i + '.csv")').join(',')
    const context = await fileContext('python', [
      streamingDigestSource,
      'targets=(' + values + ',)'
    ])
    expect(context?.staticCollections.find((c) => c.name === 'targets')).toBeUndefined()
  })

  it.each(['mismatch', 'empty', 'empty-row', 'non-string', 'too-wide', 'mapping', 'r-kind'])(
    'rejects malformed cached immutable tuple rows: %s',
    async (kind) => {
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const context = await fileContext(
        'python',
        [streamingDigestSource, 'targets=(("source","faithful.csv"),)'],
        [],
        true,
        (json) => {
          const cache = JSON.parse(json)
          const collection = cache.runs['run-1'].fileContext.staticCollections.find(
            (c: { name: string }) => c.name === 'targets'
          )
          if (kind === 'mismatch') collection.tupleRows = [['source', 'wrong.csv']]
          if (kind === 'empty') collection.tupleRows = []
          if (kind === 'empty-row') collection.tupleRows = [[], ['source', 'faithful.csv']]
          if (kind === 'non-string') collection.tupleRows = [['source', 42]]
          if (kind === 'too-wide') collection.tupleRows = [Array(129).fill('x')]
          if (kind === 'mapping')
            collection.entries = [
              { key: 'a', value: 'source' },
              { key: 'b', value: 'faithful.csv' }
            ]
          if (kind === 'r-kind') collection.rKind = 'list'
          return JSON.stringify(cache)
        },
        'epoch-1',
        undefined,
        () => parse.mockClear()
      )
      expect(parse).toHaveBeenCalled()
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            'python',
            'hashes={label:digest(p) for label,p in targets}',
            context
          )
        ).reads
      ).toEqual(['faithful.csv'])
    }
  )
  it('reloads valid immutable tuple rows without reparsing', async () => {
    const parse = vi.spyOn(Parser.prototype, 'parse')
    const context = await fileContext(
      'python',
      [streamingDigestSource, 'targets=(("source","faithful.csv"),)'],
      [],
      true,
      undefined,
      'epoch-1',
      undefined,
      () => parse.mockClear()
    )
    expect(parse).not.toHaveBeenCalled()
    expect(context?.staticCollections.find((c) => c.name === 'targets')?.tupleRows).toEqual([
      ['source', 'faithful.csv']
    ])
  })
  it.each([false, true])(
    'revokes immutable tuple rows after dispatched failure precompute=%s',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [
          streamingDigestSource,
          'targets=(("source","old.csv"),)',
          'targets=choose()\nraise RuntimeError()'
        ],
        [{}, {}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            'python',
            'hashes={label:digest(p) for label,p in targets}',
            context
          )
        ).reads
      ).not.toContain('old.csv')
    }
  )

  it('keeps checksum comprehension targets out of outer path bindings', async () => {
    const context = await fileContext('python', [streamingDigestSource, 'p="outer.csv"'])
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'python',
          'values={p:digest(p) for p in ["inner.csv"]}\nafter=open(p).read()',
          context
        )
      ).reads
    ).toEqual(['inner.csv', 'outer.csv'])
  })
  it.each([
    'hashlib.sha256=replacement',
    'open=replacement',
    'iter=replacement',
    'opaque(hashlib)',
    'opaque(digest)',
    'digest.__code__=replacement.__code__',
    'box=[digest]\nopaque(box)'
  ])('revokes checksum comprehension after %s', async (mutation) => {
    const context = await fileContext('python', [streamingDigestSource, mutation])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'values={label:digest(p) for label,p in [("data","faithful.csv")]}',
      context
    )
    expect(result.reads).toEqual([])
  })
  it.each([
    '{change(label):digest(p) for label,p in [("data","faithful.csv")]}',
    '{label:digest(p) for label,p in [("data","faithful.csv")] if predicate(p)}',
    '{label:digest(p) for label,p in choose_paths()}',
    '{label:digest(p) for label,p in [("data","faithful.csv")] for q in [1]}',
    '{digest:digest(p) for digest,p in [("data","faithful.csv")]}',
    '{label:digest(p=p) for label,p in [("data","faithful.csv")]}',
    '{label:digest(p) for label,p in [("data",unknown)]}',
    '{label:digest(p) for label,p in [("data","faithful.csv","extra")]}'
  ])('keeps unsupported checksum comprehension conservative: %s', async (expr) => {
    const context = await fileContext('python', [streamingDigestSource, 'p="outer.csv"'])
    const result = await analyzeNotebookSourceFileAccess('python', 'values=' + expr, context)
    expect(result.reads).toEqual([])
    expect(result.externalState).toBe('partial')
  })
  it('does not read files for an empty checksum comprehension', async () => {
    const context = await fileContext('python', [streamingDigestSource])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'values={p:digest(p) for p in []}', context)
    ).toMatchObject({ reads: [], externalState: 'complete' })
  })

  it.each([
    '{label:digest(p) for label,p in [("same","a.csv"),("same","b.csv")]}',
    '{ "same":digest(p) for p in ["a.csv","b.csv"] }'
  ])('retains all checksum comprehension reads with duplicate keys: %s', async (expr) => {
    const context = await fileContext('python', [streamingDigestSource])
    expect(
      (await analyzeNotebookSourceFileAccess('python', 'values=' + expr, context)).reads
    ).toEqual(['a.csv', 'b.csv'])
  })
  it.each(['hashlib.sha256=replacement', 'open=replacement', 'opaque(hashlib)'])(
    'does not reuse outer comprehension path after local checksum mutation: %s',
    async (mutation) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        streamingDigestSource +
          '\np="outer.csv"\n' +
          mutation +
          '\nvalues={p:digest(p) for p in ["inner.csv"]}'
      )
      expect(result.reads).not.toContain('outer.csv')
      expect(result.externalState).toBe('partial')
    }
  )

  it('retains streaming SHA256 inputs with a literal docstring', async () => {
    const source =
      streamingDigestSource.replace(
        'def digest(p):',
        'def digest(p):\n    """Compute a file digest."""'
      ) +
      '\n' +
      streamingDigestLoop
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
      'outputs/converted.csv',
      'outputs/faithful.csv'
    ])
  })
  it('preserves streaming SHA256 namespace escape across cells', async () => {
    const context = await fileContext('python', ['import hashlib\nopaque(hashlib)'])
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'python',
          streamingDigestSource + '\n' + streamingDigestLoop,
          context
        )
      ).reads
    ).toEqual([])
  })

  it.each([
    'open = replacement',
    'iter = replacement',
    'hashlib.sha256 = replacement',
    'import builtins; builtins.open = replacement',
    'import builtins; builtins.iter = replacement',
    'opaque(hashlib)',
    'digest = replacement',
    'digest.__code__ = replacement.__code__',
    'opaque(digest)',
    'alias = digest\nopaque(alias)',
    'box = [digest]\nopaque(box)',
    'del digest',
    'from custom import digest',
    'def digest(p): return replacement(p)',
    'hashlib = replacement',
    'hashlib.sha256 = replacement\nimport hashlib'
  ])('rejects cross-cell streaming checksum after same-cell %s', async (mutation) => {
    const context = await fileContext('python', [streamingDigestSource])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      mutation + '\n' + streamingDigestLoop,
      context
    )
    expect(result.reads).toEqual([])
  })
  it.each([
    'open = replacement',
    'iter = replacement',
    'hashlib.sha256 = replacement',
    'opaque(hashlib)',
    'digest = replacement',
    'digest.__code__ = replacement.__code__',
    'opaque(digest)',
    'alias = digest\nopaque(alias)',
    'box = [digest]\nopaque(box)',
    'import builtins; builtins.iter = replacement'
  ])('rejects cross-cell streaming checksum after prior-cell %s', async (mutation) => {
    const context = await fileContext('python', [streamingDigestSource, mutation])
    expect(
      (await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)).reads
    ).toEqual([])
  })
  it.each([
    'digest(p, ignored)',
    'digest(*args)',
    'digest(p, **options)',
    'digest(p=p)',
    'digest(choose_path())'
  ])('keeps unsupported cross-cell streaming checksum arguments conservative: %s', async (call) => {
    const context = await fileContext('python', [streamingDigestSource])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      streamingDigestLoop.replace('digest(p)', call),
      context
    )
    expect(result.reads).toEqual([])
    expect(result.externalState).toBe('partial')
  })
  it.each([
    'opaque(digest)',
    'alias = digest\nopaque(alias)',
    'box = [digest]\nopaque(box)',
    'digest.__code__ = replacement.__code__'
  ])('does not export escaped cross-cell streaming checksum identities: %s', async (mutation) => {
    const context = await fileContext('python', [streamingDigestSource + '\n' + mutation])
    expect(
      context?.localFileWrappers.some((wrapper) => wrapper.pythonStreamingChecksum) ?? false
    ).toBe(false)
  })
  it('does not carry cross-cell streaming checksum authority into another kernel epoch', async () => {
    const context = await fileContext(
      'python',
      [streamingDigestSource],
      [],
      true,
      undefined,
      'epoch-2'
    )
    expect(
      (await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)).reads
    ).toEqual([])
  })

  it.each([false, true])(
    'retains cross-cell streaming checksum with precompute=%s',
    async (precompute) => {
      const context = await fileContext('python', [streamingDigestSource], [], precompute)
      expect(
        (await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)).reads
      ).toEqual(['outputs/converted.csv', 'outputs/faithful.csv'])
    }
  )
  it.each([true, 'sha1', {}])(
    'rebuilds invalid cross-cell streaming checksum metadata: %j',
    async (tag) => {
      const context = await fileContext('python', [streamingDigestSource], [], true, (json) => {
        const cache = JSON.parse(json)
        cache.runs['run-0'].fileContext.localFileWrappers[0].pythonStreamingChecksum = tag
        return JSON.stringify(cache)
      })
      expect(context?.localFileWrappers[0]?.pythonStreamingChecksum).toBe('sha256')
      expect(
        (await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)).reads
      ).toHaveLength(2)
    }
  )
  it.each([true, 'digest', [42]])(
    'rebuilds invalid cross-cell streaming checksum revocations: %j',
    async (value) => {
      const context = await fileContext(
        'python',
        [streamingDigestSource, 'opaque(digest)'],
        [],
        true,
        (json) => {
          const cache = JSON.parse(json)
          cache.runs['run-1'].fileContext.pythonInvalidatedChecksumNames = value
          return JSON.stringify(cache)
        }
      )
      expect(
        (await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)).reads
      ).toEqual([])
    }
  )

  it('retains cross-cell streaming checksum inputs through cache reloads', async () => {
    const context = await fileContext('python', [streamingDigestSource])
    const result = await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)
    expect(result.reads).toEqual(['outputs/converted.csv', 'outputs/faithful.csv'])
  })

  it('exports only a guarded streaming SHA256 summary across cells', async () => {
    const context = await fileContext('python', [streamingDigestSource])
    expect(context?.localFileWrappers.find((wrapper) => wrapper.name === 'digest')).toMatchObject({
      pythonStreamingChecksum: 'sha256',
      dependencyNames: expect.arrayContaining(['hashlib', 'open', 'iter'])
    })
    const result = await analyzeNotebookSourceFileAccess('python', streamingDigestLoop, context)
    expect(result.reads).toEqual(['outputs/converted.csv', 'outputs/faithful.csv'])
    expect(result.readState).toBe('complete')
  })
  it('does not mark a streaming SHA256 read of its own output as an external input', async () => {
    const source =
      streamingDigestSource +
      '\nopen("outputs/faithful.csv", "wb").write(b"content")\nvalue = digest("outputs/faithful.csv")'
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })

  it.each([false, true])(
    'projects verified streaming SHA256 lineage with separate helper cell=%s',
    async (separateHelper) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'streaming-sha256-lineage-'))
      roots.push(storageRoot)
      const checksum = createHash('sha256').update('faithful').digest('hex')
      const scripts = [
        'open("faithful.csv", "wb").write(b"faithful")',
        ...(separateHelper
          ? [streamingDigestSource, 'for p in ["faithful.csv"]:\n    value = digest(p)']
          : [streamingDigestSource + '\nfor p in ["faithful.csv"]:\n    value = digest(p)'])
      ]
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'python',
        kernelEpochId: 'epoch-1',
        environment: 'default-python',
        script,
        status: 'completed',
        kernelDispatched: true,
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        inputFiles: [],
        cwdBefore: storageRoot,
        cwdAfter: storageRoot,
        workingFiles:
          index === 0
            ? [
                {
                  path: join(storageRoot, 'faithful.csv'),
                  relativePath: 'faithful.csv',
                  createdByRunId: 'run-0',
                  generationId: 'faithful-generation',
                  checksum,
                  change: 'created'
                }
              ]
            : []
      }))
      for (let pass = 0; pass < 2; pass++) {
        const projection = await new NotebookDependencyAnalyzer({
          storageRoot,
          repository: { readSessionRuns: async () => runs }
        }).project({ projectId: 'project', sessionId: 'streaming' })
        expect(projection.fileDependenciesByRunId?.['run-' + (scripts.length - 1)]).toEqual([
          {
            producerRunId: 'run-0',
            path: 'faithful.csv',
            generationId: 'faithful-generation',
            checksum,
            confidence: 'verified'
          }
        ])
      }
    }
  )

  it.each([false, true])(
    'replays a fresh local Path checksum with cached paths=%s',
    async (cached) => {
      const declaration =
        'paths = ["outputs/variance-check.json", "outputs/centered-fit.json", "outputs/residual-audit.json"]'
      const context = cached ? await fileContext('python', [declaration]) : undefined
      const source = [
        'import pathlib, hashlib',
        ...(cached ? [] : [declaration]),
        'def file_meta(p):',
        '    pp = pathlib.Path(p)',
        '    data = pp.read_bytes()',
        '    return {"path": str(pp), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}',
        'files = [file_meta(p) for p in paths]'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        reads: [
          'outputs/centered-fit.json',
          'outputs/residual-audit.json',
          'outputs/variance-check.json'
        ],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const after = await fileContext('python', [source])
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            'python',
            'files = [file_meta(p) for p in ["later.json"]]',
            after
          )
        ).reads
      ).toEqual([])
    }
  )

  it.each([
    'def str(value): return mutate(value)',
    'str = replacement',
    'from custom import str',
    'import builtins; builtins.str = replacement',
    'def len(value): return mutate(value)',
    'pathlib.Path.open = replacement',
    'pathlib.Path.__str__ = replacement',
    'hashlib.sha256 = replacement'
  ])('rejects local Path checksums after behavior shadowing: %s', async (binding) => {
    const source = [
      'import pathlib, hashlib',
      binding,
      'def file_meta(p):',
      '    pp = pathlib.Path(p)',
      '    data = pp.read_bytes()',
      '    return {"path": str(pp), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}',
      'files = [file_meta(p) for p in ["inputs/first.csv", "inputs/later.csv"]]'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      readState: 'partial'
    })
  })

  it.each([
    ['parameter overwrite', 'p = pathlib.Path(p)', 'data = p.read_bytes()', '{"bytes": len(data)}'],
    ['data overwrites Path', 'pp = pathlib.Path(p)', 'pp = pp.read_bytes()', '{"bytes": len(pp)}'],
    [
      'unknown constructor alias',
      'pp = Factory(p)',
      'data = pp.read_bytes()',
      '{"bytes": len(data)}'
    ],
    [
      'dynamic constructor',
      'pp = pathlib.Path(select(p))',
      'data = pp.read_bytes()',
      '{"bytes": len(data)}'
    ],
    [
      'read arguments',
      'pp = pathlib.Path(p)',
      'data = pp.read_bytes(*mutate())',
      '{"bytes": len(data)}'
    ],
    ['alternate reader', 'pp = pathlib.Path(p)', 'data = pp.read_text()', '{"bytes": len(data)}'],
    ['Path escapes', 'pp = pathlib.Path(p)', 'data = pp.read_bytes()', '{"path": pp}'],
    [
      'opaque str argument',
      'pp = pathlib.Path(p)',
      'data = pp.read_bytes()',
      '{"path": str(pp, *mutate())}'
    ],
    [
      'opaque hash arguments',
      'pp = pathlib.Path(p)',
      'data = pp.read_bytes()',
      '{"sha": hashlib.sha256(data).hexdigest(**mutate())}'
    ],
    ['opaque tail', 'pp = pathlib.Path(p)', 'data = pp.read_bytes()', '{"value": opaque(data)}'],
    [
      'reserved Path name',
      'str = pathlib.Path(p)',
      'data = str.read_bytes()',
      '{"bytes": len(data)}'
    ],
    [
      'reserved data name',
      'pp = pathlib.Path(p)',
      'hashlib = pp.read_bytes()',
      '{"bytes": len(hashlib)}'
    ],
    [
      'multiple targets',
      'pp = alias = pathlib.Path(p)',
      'data = pp.read_bytes()',
      '{"bytes": len(data)}'
    ],
    ['non-dictionary return', 'pp = pathlib.Path(p)', 'data = pp.read_bytes()', 'len(data)']
  ])(
    'rejects unsupported local Path checksum shape: %s',
    async (_label, construct, read, returned) => {
      const source = [
        'import pathlib, hashlib',
        'from pathlib import Path',
        'def file_meta(p):',
        '    ' + construct,
        '    ' + read,
        '    return ' + returned,
        'files = [file_meta(p) for p in ["inputs/first.csv", "inputs/later.csv"]]'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: [],
        readState: 'partial'
      })
    }
  )

  it.each(['    opaque()\n', '    pp = replacement\n', '    alias = pp\n', '    assert data\n'])(
    'rejects extra local Path helper statements: %s',
    async (extra) => {
      const source =
        'import pathlib, hashlib\ndef file_meta(p):\n    pp = pathlib.Path(p)\n    data = pp.read_bytes()\n' +
        extra +
        '    return {"path": str(pp), "bytes": len(data)}\nfiles = [file_meta(p) for p in ["inputs/a.csv"]]'
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
    }
  )

  it.each(['str', 'len'])(
    'rejects inherited %s bindings for local Path checksums',
    async (builtin) => {
      const source = [
        'import pathlib, hashlib',
        'def file_meta(p):',
        '    pp = pathlib.Path(p)',
        '    data = pp.read_bytes()',
        '    return {"path": str(pp), "bytes": len(data)}',
        'files = [file_meta(p) for p in ["inputs/a.csv"]]'
      ].join('\n')
      const context = await fileContext('python', [builtin + ' = replacement'])
      expect((await analyzeNotebookSourceFileAccess('python', source, context)).reads).toEqual([])
    }
  )

  it.each(['pathlib', 'hashlib', 'builtins', '*'])(
    'rejects inherited %s taint for local Path checksums',
    async (namespace) => {
      const source = [
        'import pathlib, hashlib',
        'def file_meta(p):',
        '    pp = pathlib.Path(p)',
        '    data = pp.read_bytes()',
        '    return {"path": str(pp), "bytes": len(data)}',
        'files = [file_meta(p) for p in ["inputs/a.csv"]]'
      ].join('\n')
      expect(
        (
          await analyzeNotebookSourceFileAccess('python', source, {
            staticStrings: [],
            staticCollections: [],
            localFileWrappers: [],
            pythonTaintedNamespaces: [namespace]
          })
        ).reads
      ).toEqual([])
    }
  )

  it('replays bounded checksum helper inputs from a persisted static path collection', async () => {
    const context = await fileContext('python', [
      'paths = ["inputs/quakes.csv", "outputs/shallow.csv", "outputs/deep.csv"]'
    ])
    const source = [
      'import hashlib',
      'import pathlib',
      'def file_meta(p):',
      '    data = pathlib.Path(p).read_bytes()',
      '    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": pathlib.Path(p).stat().st_size}',
      'files = [file_meta(p) for p in paths]'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: ['inputs/quakes.csv', 'outputs/deep.csv', 'outputs/shallow.csv'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('replays bounded open/stat metadata helper inputs from a static path collection', async () => {
    const source = [
      'import hashlib, os',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    digest = hashlib.sha256(data).hexdigest()',
      '    return {"path": p, "size_bytes": int(stat.st_size), "sha256": digest,',
      '            "read_bytes": len(data), "size_match": stat.st_size == len(data),',
      '            "mtime_utc": int(stat.st_mtime)}',
      'paths = (os.path.join("outputs", "observations.json"),',
      '         os.path.join("outputs", "regression.json"),',
      '         os.path.join("outputs", "crosscheck.json"))',
      'meta = [file_meta(p) for p in paths]'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [
        analyzedPythonPath('outputs/crosscheck.json'),
        analyzedPythonPath('outputs/observations.json'),
        analyzedPythonPath('outputs/regression.json')
      ],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('replays a real metadata helper with an inline digest in a manifest comprehension', async () => {
    const source = [
      'import hashlib, json, os, sys',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    return {"path": p, "size_bytes": int(stat.st_size),',
      '            "sha256": hashlib.sha256(data).hexdigest(),',
      '            "read_bytes": len(data), "size_match": stat.st_size == len(data),',
      '            "mtime_utc": int(stat.st_mtime)}',
      'paths = (os.path.join("outputs", "observations.json"),',
      '         os.path.join("outputs", "regression.json"),',
      '         os.path.join("outputs", "crosscheck.json"))',
      'manifest = {"files": [file_meta(p) for p in paths],',
      '            "tolerance_notes": "metadata-only"}',
      'out_path = os.path.join("outputs", "manifest.json")',
      'with open(out_path, "w", encoding="utf-8") as fh:',
      '    json.dump(manifest, fh)',
      'print(sys.version.split()[0])'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [
        analyzedPythonPath('outputs/crosscheck.json'),
        analyzedPythonPath('outputs/observations.json'),
        analyzedPythonPath('outputs/regression.json')
      ],
      writes: [analyzedPythonPath('outputs/manifest.json')],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('rejects metadata helpers with effectful inline hexdigest arguments', async () => {
    const source = [
      'import hashlib, os',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    return {"path": p, "sha256": hashlib.sha256(data).hexdigest(**mutate())}',
      'paths = ("outputs/never-created.json",)',
      'meta = [file_meta(p) for p in paths]'
    ].join('\n')
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).not.toContain(
      analyzedPythonPath('outputs/never-created.json')
    )
  })

  it('replays the same metadata helper through a bounded for loop', async () => {
    const source = [
      'import hashlib, os',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    digest = hashlib.sha256(data).hexdigest()',
      '    return {"path": p, "bytes": len(data), "sha256": digest}',
      'paths = ("outputs/observations.json", "outputs/regression.json")',
      'for p in paths:',
      '    metadata = file_meta(p)'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['outputs/observations.json', 'outputs/regression.json'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('replays a Path-rebinding metadata helper with guarded for-loop bookkeeping', async () => {
    const source = [
      'import json, hashlib',
      'from pathlib import Path',
      'INPUTS = [Path("outputs/observations.json"), Path("outputs/regression.json")]',
      'def file_meta(p):',
      '    p = Path(p)',
      '    data = p.read_bytes()',
      '    h = hashlib.sha256(data).hexdigest()',
      '    st_size = p.stat().st_size',
      '    assert len(data) == st_size',
      '    assert len(h) == 64 and all(c in "0123456789abcdef" for c in h)',
      '    return {"path": str(p), "size_bytes": st_size, "sha256": h}',
      'entries = []',
      'for p in INPUTS:',
      '    assert p.exists()',
      '    m = file_meta(p)',
      '    assert m["size_bytes"] > 0',
      '    entries.append(m)',
      'with open("outputs/manifest.json", "w", encoding="utf-8") as fh:',
      '    json.dump({"files": entries}, fh)'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [
        analyzedPythonPath('outputs/observations.json'),
        analyzedPythonPath('outputs/regression.json')
      ],
      writes: ['outputs/manifest.json'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  const metadataDiagnosticSource = (
    helperMessage = 'f"size mismatch for {p}: read={len(data)} stat={st_size}"',
    loopMessage = 'f"missing input: {p}"'
  ): string =>
    [
      'import hashlib',
      'from pathlib import Path',
      'INPUTS = [Path("outputs/observations.json"), Path("outputs/regression.json")]',
      'def file_meta(p):',
      '    p = Path(p)',
      '    data = p.read_bytes()',
      '    h = hashlib.sha256(data).hexdigest()',
      '    st_size = p.stat().st_size',
      `    assert len(data) == st_size${helperMessage ? `, ${helperMessage}` : ''}`,
      '    return {"path": str(p), "size_bytes": st_size, "sha256": h}',
      'entries = []',
      'for p in INPUTS:',
      `    assert p.exists()${loopMessage ? `, ${loopMessage}` : ''}`,
      '    m = file_meta(p)',
      `    assert m["size_bytes"] > 0${loopMessage ? `, ${loopMessage}` : ''}`,
      '    entries.append(m)'
    ].join('\n')

  it.each([
    ['custom append receiver', (source: string) => source.replace('entries = []\n', '')],
    [
      'replaced append receiver',
      (source: string) =>
        source.replace('entries = []', 'entries = []\nentries = replace_sink(entries)')
    ],
    [
      'loop target shadows Path',
      (source: string) =>
        source
          .replace('for p in INPUTS:', 'for Path in INPUTS:')
          .replaceAll('p.exists()', 'Path.exists()')
          .replace('m = file_meta(p)', 'm = file_meta(Path)')
    ],
    [
      'result shadows Path',
      (source: string) =>
        source
          .replaceAll('m =', 'Path =')
          .replaceAll('m[', 'Path[')
          .replace('append(m)', 'append(Path)')
    ],
    [
      'result shadows helper',
      (source: string) =>
        source
          .replaceAll('m =', 'file_meta =')
          .replaceAll('m[', 'file_meta[')
          .replace('append(m)', 'append(file_meta)')
    ],
    [
      'local shadows Path',
      (source: string) =>
        source
          .replace('data =', 'Path =')
          .replaceAll('sha256(data)', 'sha256(Path)')
          .replaceAll('len(data)', 'len(Path)')
    ],
    [
      'local shadows len without message',
      (source: string) => source.replace('h =', 'len =').replace('"sha256": h', '"sha256": len')
    ],
    [
      'loop before helper definition',
      (source: string) => {
        const start = source.indexOf('def file_meta')
        const end = source.indexOf('entries = []')
        return source.slice(0, start) + source.slice(end) + '\n' + source.slice(start, end)
      }
    ]
  ])('does not infer later metadata inputs through %s', async (_, change) => {
    const source = change(metadataDiagnosticSource('', ''))
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io.reads).not.toContain(analyzedPythonPath('outputs/regression.json'))
    expect(io.readState).toBe('partial')
  })

  it('retains metadata inputs through an alias of a fresh append list', async () => {
    const source = metadataDiagnosticSource().replace(
      'entries = []',
      'original = []\nentries = original'
    )
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
      analyzedPythonPath('outputs/observations.json'),
      analyzedPythonPath('outputs/regression.json')
    ])
  })

  const nestedMetadataSource = (): string =>
    metadataDiagnosticSource().replace(
      '    m = file_meta(p)\n    assert m["size_bytes"] > 0, f"missing input: {p}"\n    entries.append(m)',
      '    entries.append(file_meta(p))'
    )

  const directPathMetadataSource = (): string =>
    [
      'import hashlib, os',
      'from pathlib import Path',
      'OUT = Path("outputs")',
      'def file_meta(p: Path):',
      '    data = p.read_bytes()',
      '    digest = hashlib.sha256(data).hexdigest()',
      '    st = os.stat(p)',
      '    assert len(data) == st.st_size, f"{p}: {len(data)} != {st.st_size}"',
      '    return {"path": str(p).replace(os.sep, "/"), "size_bytes": len(data), "sha256": digest}',
      'paths = [OUT / "observations.json", OUT / "regression.json"]',
      'entries = []',
      'for p in paths:',
      '    assert p.exists(), f"missing: {p}"',
      '    entries.append(file_meta(p))'
    ].join('\n')

  it.each(['typed', 'untyped', 'alias', 'inline', 'comprehension', 'dictionary', 'qualified base'])(
    'retains direct Path metadata inputs with %s provenance',
    async (form) => {
      let source = directPathMetadataSource()
      if (form === 'untyped') source = source.replace('p: Path', 'p')
      if (form === 'alias')
        source = source.replace('entries = []', 'original = paths\npaths = original\nentries = []')
      if (form === 'inline')
        source = source.replace(
          'for p in paths:',
          'for p in [Path("outputs/observations.json"), Path("outputs/regression.json")]:'
        )
      if (form === 'comprehension')
        source = source.replace(
          /entries = \[\][\s\S]*$/u,
          'entries = [file_meta(p) for p in paths]'
        )
      if (form === 'dictionary')
        source = source.replace(
          /entries = \[\][\s\S]*$/u,
          'entries = {p: file_meta(p) for p in paths}'
        )
      if (form === 'qualified base')
        source = source.replace(
          'OUT = Path("outputs")',
          'import pathlib\nOUT = pathlib.Path("outputs")'
        )
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: [
          analyzedPythonPath('outputs/observations.json'),
          analyzedPythonPath('outputs/regression.json')
        ],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each([
    ['string base', (s: string) => s.replace('OUT = Path("outputs")', 'OUT = "outputs"')],
    [
      'string collection',
      (s: string) =>
        s.replace(
          'OUT / "observations.json", OUT / "regression.json"',
          '"outputs/observations.json", "outputs/regression.json"'
        )
    ],
    [
      'mixed collection',
      (s: string) => s.replace('OUT / "regression.json"', '"outputs/regression.json"')
    ],
    [
      'PurePath base',
      (s: string) => s.replace('from pathlib import Path', 'from pathlib import PurePath as Path')
    ],
    [
      'custom factory',
      (s: string) => s.replace('OUT = Path("outputs")', 'OUT = factory("outputs")')
    ],
    ['base rebound', (s: string) => s.replace('paths = [', 'OUT = "outputs"\npaths = [')],
    [
      'collection replaced by import',
      (s: string) => s.replace('entries = []', 'import os as paths\nentries = []')
    ],
    ['escaped scalar', (s: string) => s.replace('paths = [', 'mutate(OUT)\npaths = [')],
    [
      'escaped scalar then reconstructed',
      (s: string) => s.replace('paths = [', 'mutate(OUT)\nOUT = Path("outputs")\npaths = [')
    ],
    [
      'conditional base',
      (s: string) => s.replace('OUT = Path("outputs")', 'if choose:\n    OUT = Path("outputs")')
    ],
    [
      'base overwritten by loop',
      (s: string) => s.replace('paths = [', 'for OUT in ["outputs"]:\n    pass\npaths = [')
    ],
    [
      'collection mutation',
      (s: string) => s.replace('entries = []', 'paths[1] = "outputs/regression.json"\nentries = []')
    ],
    [
      'opaque collection escape',
      (s: string) => s.replace('entries = []', 'mutate(paths)\nentries = []')
    ],
    [
      'os.stat mutation',
      (s: string) => s.replace('entries = []', 'os.stat = replacement\nentries = []')
    ],
    [
      'os.sep mutation',
      (s: string) => s.replace('entries = []', 'os.sep = replacement\nentries = []')
    ],
    [
      'constructor mutation',
      (s: string) => s.replace('entries = []', 'Path.read_bytes = replacement\nentries = []')
    ],
    ['effectful annotation', (s: string) => s.replace('p: Path', 'p: factory()')],
    [
      'annotation before import',
      (s: string) =>
        s
          .replace('from pathlib import Path\nOUT = Path("outputs")\n', '')
          .replace('paths = [', 'from pathlib import Path\nOUT = Path("outputs")\npaths = [')
    ],
    ['effectful separator', (s: string) => s.replace('os.sep, "/"', 'choose_separator(), "/"')],
    ['effectful formatting', (s: string) => s.replace('{st.st_size}', '{st.st_size:{mutate()}}')],
    ['extra helper statement', (s: string) => s.replace('    return', '    mutate()\n    return')],
    [
      'helper redefinition',
      (s: string) => s.replace('entries = []', 'def file_meta(p):\n    return None\nentries = []')
    ]
  ])('does not infer direct Path reads from %s', async (_, change) => {
    expect(
      (await analyzeNotebookSourceFileAccess('python', change(directPathMetadataSource()))).reads
    ).not.toContain(analyzedPythonPath('outputs/regression.json'))
  })

  it('does not borrow concrete Path provenance from a cached scalar collection', async () => {
    const context = await fileContext('python', [
      'paths = ["outputs/observations.json", "outputs/regression.json"]'
    ])
    const source = directPathMetadataSource().replace(
      'paths = [OUT / "observations.json", OUT / "regression.json"]\n',
      ''
    )
    expect((await analyzeNotebookSourceFileAccess('python', source, context)).reads).toEqual([])
  })

  it('rejects metadata replay after int is rebound', async () => {
    const source = metadataDiagnosticSource('', '')
      .replace('"size_bytes": st_size', '"size_bytes": int(st_size)')
      .replace('entries = []', 'int = replacement\nentries = []')
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })

  const checksumMappingSource = (
    constructor = 'Path',
    expression = '{p: file_meta(p) for p in INPUTS}'
  ): string =>
    [
      'import hashlib, pathlib',
      'from pathlib import Path',
      'def file_meta(p):',
      `    data = ${constructor}(p).read_bytes()`,
      '    return {"path": p, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}',
      'INPUTS = ["outputs/observations.json", "outputs/regression.json"]',
      `meta = ${expression}`
    ].join('\n')

  it.each(['Path', 'pathlib.Path'])(
    'retains metadata dictionary inputs with %s',
    async (constructor) => {
      expect(
        await analyzeNotebookSourceFileAccess('python', checksumMappingSource(constructor))
      ).toMatchObject({
        reads: ['outputs/observations.json', 'outputs/regression.json'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('retains bounded metadata dictionary inputs', async () => {
    const source = metadataDiagnosticSource('', '').replace(
      /entries = \[\][\s\S]*$/u,
      'meta = {p: file_meta(p) for p in INPUTS}'
    )
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
      analyzedPythonPath('outputs/observations.json'),
      analyzedPythonPath('outputs/regression.json')
    ])
  })

  it.each(['[file_meta(Path) for Path in INPUTS]', '{Path: file_meta(Path) for Path in INPUTS}'])(
    'keeps a local constructor alias in the helper global scope: %s',
    async (expression) => {
      const source = checksumMappingSource('Path', expression).replace(
        '    data = Path(p).read_bytes()',
        '    local = Path(p)\n    data = local.read_bytes()'
      )
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
        'outputs/observations.json',
        'outputs/regression.json'
      ])
    }
  )

  it('preserves dictionary key and value dependencies without leaking comprehension locals', async () => {
    const result = await analyzePythonNotebookSource(
      'mapping = {key(k): value(v + offset) for k, v in rows if accept(v)}'
    )
    expect(result.facts).toMatchObject({
      state: 'available',
      definedNames: ['mapping'],
      usedNames: ['accept', 'key', 'offset', 'rows', 'value']
    })
    if (result.facts.state === 'available') {
      expect(result.facts.receiverCalls?.map((call) => call.receiver)).toEqual([
        'accept',
        'key',
        'value'
      ])
    }
  })

  it('rejects a comprehension target that replaces the metadata callable', async () => {
    const source = metadataDiagnosticSource('', '').replace(
      /entries = \[\][\s\S]*$/u,
      'meta = [file_meta(file_meta) for file_meta in INPUTS]'
    )
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })

  it('does not replay later checksums after a local hashlib shadow', async () => {
    const source = checksumMappingSource('pathlib.Path', '[file_meta(p) for p in INPUTS]')
      .replace('data =', 'hashlib =')
      .replaceAll('len(data)', 'len(hashlib)')
      .replaceAll('sha256(data)', 'sha256(hashlib)')
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).not.toContain(
      'outputs/regression.json'
    )
  })

  it.each(['[file_meta(p) async for p in INPUTS]', '{p: file_meta(p) async for p in INPUTS}'])(
    'does not replay a synchronous collection as an async iterable: %s',
    async (expression) => {
      const source = checksumMappingSource('pathlib.Path', expression)
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
    }
  )

  it.each([
    ['effectful key', (s: string) => s.replace('{p: file_meta(p)', '{mutate(p): file_meta(p)')],
    ['unknown key', (s: string) => s.replace('{p: file_meta(p)', '{key: file_meta(p)')],
    [
      'filtered inputs',
      (s: string) => s.replace('for p in INPUTS}', 'for p in INPUTS if choose(p)}')
    ],
    [
      'nested generators',
      (s: string) => s.replace('for p in INPUTS}', 'for p in INPUTS for q in INPUTS}')
    ],
    ['keyword helper argument', (s: string) => s.replace('{p: file_meta(p)', '{p: file_meta(p=p)')],
    ['rebound constructor', (s: string) => s.replace('meta =', 'Path = replacement\nmeta =')],
    ['rebound hashing', (s: string) => s.replace('meta =', 'hashlib.sha256 = replacement\nmeta =')],
    [
      'local constructor binding',
      (s: string) =>
        s
          .replace('data =', 'Path =')
          .replaceAll('len(data)', 'len(Path)')
          .replaceAll('sha256(data)', 'sha256(Path)')
    ],
    [
      'local hashlib binding',
      (s: string) =>
        s
          .replace('data =', 'hashlib =')
          .replaceAll('len(data)', 'len(hashlib)')
          .replaceAll('sha256(data)', 'sha256(hashlib)')
    ],
    [
      'parameter overwritten by read',
      (s: string) =>
        s
          .replace('data =', 'p =')
          .replaceAll('len(data)', 'len(p)')
          .replaceAll('sha256(data)', 'sha256(p)')
    ],
    ['custom helper tail', (s: string) => s.replace('    return', '    mutate()\n    return')],
    [
      'callable target shadow',
      (s: string) =>
        s.replace(
          '{p: file_meta(p) for p in INPUTS}',
          '{file_meta: file_meta(file_meta) for file_meta in INPUTS}'
        )
    ]
  ])('rejects checksum mapping replay with %s', async (_, change) => {
    expect(
      (await analyzeNotebookSourceFileAccess('python', change(checksumMappingSource()))).reads
    ).not.toContain('outputs/regression.json')
  })

  it.each(['entries = []', 'original = []\nentries = original'])(
    'retains inputs of metadata calls nested in a fresh append: %s',
    async (initialization) => {
      const source = nestedMetadataSource().replace('entries = []', initialization)
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: [
          analyzedPythonPath('outputs/observations.json'),
          analyzedPythonPath('outputs/regression.json')
        ],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each([
    [
      'result check before assignment',
      (source: string) =>
        source.replace(
          '    m = file_meta(p)\n    assert m["size_bytes"] > 0',
          '    assert m["size_bytes"] > 0\n    m = file_meta(p)'
        )
    ],
    [
      'result replaces loop target before path check',
      (source: string) =>
        source
          .replace(
            '    assert p.exists()\n    m = file_meta(p)',
            '    m = file_meta(p)\n    assert p.exists()'
          )
          .replaceAll('m =', 'p =')
          .replaceAll('m[', 'p[')
          .replace('append(m)', 'append(p)')
    ]
  ])('does not replay metadata through %s', async (_, change) => {
    const source = change(metadataDiagnosticSource('', ''))
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).not.toContain(
      analyzedPythonPath('outputs/regression.json')
    )
  })

  it.each([
    ['unknown receiver', (source: string) => source.replace('entries = []\n', '')],
    [
      'replaced receiver',
      (source: string) => source.replace('entries = []', 'entries = make_sink()')
    ],
    ['live input receiver', (source: string) => source.replace('entries = []', 'entries = INPUTS')],
    ['loop target receiver', (source: string) => source.replace('entries.append', 'p.append')],
    [
      'keyword append argument',
      (source: string) => source.replace('append(file_meta(p))', 'append(value=file_meta(p))')
    ],
    [
      'keyword helper argument',
      (source: string) => source.replace('append(file_meta(p))', 'append(file_meta(p=p))')
    ],
    ['opaque loop tail', (source: string) => source + '\n    mutate()'],
    [
      'helper rebinding',
      (source: string) => source.replace('entries = []', 'file_meta = replacement\nentries = []')
    ],
    [
      'namespace mutation',
      (source: string) =>
        source.replace('entries = []', 'Path.read_bytes = replacement\nentries = []')
    ],
    [
      'loop before helper',
      (source: string) => {
        const start = source.indexOf('def file_meta')
        const end = source.indexOf('entries = []')
        return source.slice(0, start) + source.slice(end) + '\n' + source.slice(start, end)
      }
    ]
  ])('rejects nested metadata replay with %s', async (_, change) => {
    expect(
      (await analyzeNotebookSourceFileAccess('python', change(nestedMetadataSource()))).reads
    ).not.toContain(analyzedPythonPath('outputs/regression.json'))
  })

  it.each([
    ['helper', 'f"{p}: {len(data)} != {st_size}, digest={h}"', ''],
    ['loop', '', 'f"missing input: {p}"'],
    ['both', undefined, undefined],
    ['literal', '"size mismatch"', '"missing input"']
  ])('retains metadata inputs with bounded %s diagnostic messages', async (_, helper, loop) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', metadataDiagnosticSource(helper, loop))
    ).toMatchObject({
      reads: [
        analyzedPythonPath('outputs/observations.json'),
        analyzedPythonPath('outputs/regression.json')
      ],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'f"{unknown}"',
    'f"{mutate()}"',
    'f"{p:{mutate()}}"',
    'f"{p!r}"',
    'f"{p:>20}"',
    'f"{p=}"',
    'f"{len(p)}"'
  ])('rejects unsafe metadata diagnostic messages: %s', async (message) => {
    for (const source of [
      metadataDiagnosticSource(message, ''),
      metadataDiagnosticSource('', message)
    ]) {
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
    }
  })

  it.each(['len = replacement', 'Path = replacement', 'Path.__format__ = replacement'])(
    'rejects metadata diagnostics after binding changes: %s',
    async (mutation) => {
      const source = metadataDiagnosticSource().replace('entries = []', `${mutation}\nentries = []`)
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
    }
  )

  it('rejects metadata diagnostics with a locally shadowed len', async () => {
    const source = metadataDiagnosticSource()
      .replaceAll('h =', 'len =')
      .replace('"sha256": h', '"sha256": len')
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })

  it('rejects metadata diagnostics when the loop target shadows len', async () => {
    const source = metadataDiagnosticSource().replace(
      /for p in INPUTS:[\s\S]*$/u,
      [
        'for len in INPUTS:',
        '    assert len.exists(), f"missing input: {len}"',
        '    m = file_meta(len)',
        '    entries.append(m)'
      ].join('\n')
    )
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })

  it('rejects metadata diagnostics with a supplied builtin shadow', async () => {
    const context = await fileContext('python', ['len = replacement'])
    expect(
      (await analyzeNotebookSourceFileAccess('python', metadataDiagnosticSource(), context)).reads
    ).toEqual([])
  })

  it('retains metadata diagnostic inputs from a supplied path context', async () => {
    const context = await fileContext('python', [
      'paths = ["outputs/observations.json", "outputs/regression.json"]'
    ])
    const source = metadataDiagnosticSource().replace(
      'INPUTS = [Path("outputs/observations.json"), Path("outputs/regression.json")]',
      'INPUTS = paths'
    )
    expect((await analyzeNotebookSourceFileAccess('python', source, context)).reads).toEqual([
      'outputs/observations.json',
      'outputs/regression.json'
    ])
  })

  it.each([
    'open = replacement',
    'os.stat = replacement',
    'hashlib.sha256 = replacement',
    'paths = build_paths()'
  ])('rejects metadata helper inputs after unsafe binding changes: %s', async (mutation) => {
    const source = [
      'import hashlib, os',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    digest = hashlib.sha256(data).hexdigest()',
      '    return {"path": p, "bytes": len(data), "sha256": digest}',
      mutation,
      ...(mutation === 'paths = build_paths()' ? [] : ['paths = ("outputs/never-created.json",)']),
      'meta = [file_meta(p) for p in paths]'
    ].join('\n')
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).not.toContain(
      'outputs/never-created.json'
    )
  })

  it.each([
    'pathlib.Path = replacement',
    'pathlib.Path.read_bytes = replacement',
    'hashlib.sha256 = replacement',
    'opaque(pathlib)',
    'pathlib.Path = replacement\nimport pathlib'
  ])('rejects checksum inputs after namespace mutation or escape: %s', async (mutation) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import hashlib, pathlib',
        'def file_meta(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}',
        mutation,
        'files = [file_meta(p) for p in ["outputs/never-created.json"]]'
      ].join('\n')
    )
    expect(result.reads).not.toContain('outputs/never-created.json')
    expect(result.readState).toBe('partial')
  })

  it.each(['pathlib', 'hashlib', '*'])(
    'rejects checksum inputs with inherited %s namespace taint',
    async (namespace) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          'import hashlib, pathlib',
          'def file_meta(p):',
          '    data = pathlib.Path(p).read_bytes()',
          '    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}',
          'files = [file_meta(p) for p in ["outputs/never-created.json"]]'
        ].join('\n'),
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonTaintedNamespaces: [namespace]
        }
      )
      expect(result.reads).not.toContain('outputs/never-created.json')
      expect(result.readState).toBe('partial')
    }
  )

  it.each([
    [
      'pre-read argument effects',
      'def digest(p):\n    data = pathlib.Path(p).read_text(encoding=choose_encoding())\n    return len(data)',
      'files = [digest(p) for p in ["outputs/absent.csv"]]'
    ],
    [
      'unsupported positional read arguments',
      'def digest(p):\n    data = pathlib.Path(p).read_bytes(choose_encoding())\n    return len(data)',
      'files = [digest(p) for p in ["outputs/absent.csv"]]'
    ],
    [
      'a namespace parameter',
      'def digest(pathlib):\n    data = pathlib.Path(pathlib).read_bytes()\n    return len(data)',
      'files = [digest(p) for p in ["outputs/absent.csv"]]'
    ],
    [
      'a local namespace binding',
      'def digest(p):\n    pathlib = pathlib.Path(p).read_bytes()\n    return len(pathlib)',
      'files = [digest(p) for p in ["outputs/absent.csv"]]'
    ],
    [
      'a shadowed comprehension callable',
      'def digest(p):\n    data = pathlib.Path(p).read_bytes()\n    return len(data)',
      'files = [digest(digest) for digest in ["outputs/absent.csv"]]'
    ]
  ])('does not certify checksum inputs with %s', async (_label, helper, invocation) => {
    const source = [
      'import pathlib, hashlib, io',
      'def fake_open(*args, **kwargs):',
      '    return io.StringIO("memory")',
      'def choose_encoding():',
      '    pathlib.Path.open = fake_open',
      '    return "utf-8"',
      helper,
      invocation
    ].join('\n')
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).not.toContain('outputs/absent.csv')
    expect(result.readState).toBe('partial')
  })

  it('does not use a later checksum definition for an earlier invocation', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'files = [digest(p) for p in ["outputs/absent.csv"]]',
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return len(data)'
      ].join('\n')
    )
    expect(result.reads).not.toContain('outputs/absent.csv')
    expect(result.readState).toBe('partial')
  })

  it('keeps checksum globals separate from the comprehension target scope', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return len(data)',
        'files = [digest(pathlib) for pathlib in ["outputs/observations.json"]]'
      ].join('\n')
    )
    expect(result.reads).toEqual(['outputs/observations.json'])
    expect(result.readState).toBe('partial')
  })

  it.each(['*mutate()', '**mutate_keywords()'])(
    'rejects effectful hexdigest arguments before subsequent checksum iterations: %s',
    async (argumentsSource) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          'import pathlib, hashlib, io',
          'def memory_open(*args, **kwargs):',
          '    return io.BytesIO(b"memory")',
          'def mutate():',
          '    pathlib.Path.open = memory_open',
          '    return ()',
          'def mutate_keywords():',
          '    pathlib.Path.open = memory_open',
          '    return {}',
          'def digest(p):',
          '    data = pathlib.Path(p).read_bytes()',
          '    return hashlib.sha256(data).hexdigest(' + argumentsSource + ')',
          'files = [digest(p) for p in ["first.csv", "later.csv"]]'
        ].join('\n')
      )
      expect(result.reads).not.toContain('later.csv')
      expect(result.readState).toBe('partial')
    }
  )

  it.each([
    'def len(data):\n    pathlib.Path.open = memory_open\n    return data.__len__()',
    'len = replacement',
    'from custom import len',
    'import builtins\nbuiltins.len = replacement'
  ])('does not certify later checksum reads with an untrusted len: %s', async (binding) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib, io',
        'def memory_open(*args, **kwargs):',
        '    return io.BytesIO(b"memory")',
        binding,
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n')
    )
    expect(result.reads).not.toContain('later.csv')
    expect(result.readState).toBe('partial')
  })

  it('rejects a checksum helper that resolves len from its local parameter', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'def digest(len):',
        '    data = pathlib.Path(len).read_bytes()',
        '    return len(data)',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n')
    )
    expect(result.reads).not.toContain('later.csv')
    expect(result.readState).toBe('partial')
  })

  it('retains checksum reads when a shadowed len is never called', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'len = replacement',
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return hashlib.sha256(data).hexdigest()',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n')
    )
    expect(result.reads).toEqual(['first.csv', 'later.csv'])
    expect(result.readState).toBe('partial')
  })

  it('rejects a prior kernel binding for len in checksum helpers', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return len(data)',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n'),
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: ['len']
      }
    )
    expect(result.reads).not.toContain('later.csv')
    expect(result.readState).toBe('partial')
  })

  it('rejects checksum definitions with effectful return annotations', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib, io',
        'def memory_open(*args, **kwargs):',
        '    return io.BytesIO(b"memory")',
        'def mutate():',
        '    pathlib.Path.open = memory_open',
        '    return bytes',
        'def digest(p) -> mutate():',
        '    data = pathlib.Path(p).read_bytes()',
        '    return hashlib.sha256(data).hexdigest()',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n')
    )
    expect(result.reads).toEqual([])
    expect(result.readState).toBe('partial')
  })

  it('captures a single-cell MEX helper while retaining companion uncertainty', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'from pathlib import Path',
        'import scanpy as sc',
        'matrix_dir = Path("inputs/pbmc3k/filtered_feature_bc_matrix")',
        'output_dir = Path("outputs/pbmc3k")',
        'def preprocess(matrix_dir, output_dir):',
        '    data = sc.read_10x_mtx(matrix_dir, var_names="gene_symbols")',
        '    sc.pp.normalize_total(data)',
        '    sc.pp.log1p(data)',
        '    data.write_h5ad(output_dir / "processed.h5ad")',
        '    return data',
        'preprocess(matrix_dir, output_dir)'
      ].join('\n')
    )

    expect(result).toMatchObject({
      reads: [analyzedPythonPath('inputs/pbmc3k/filtered_feature_bc_matrix')],
      writes: [analyzedPythonPath('outputs/pbmc3k/processed.h5ad')],
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial'
    })
  })

  it.each([
    'reader = lambda: None',
    'for reader in [None]:\n        pass',
    'del reader',
    'from custom_reader import read as reader'
  ])('invalidates module helper bindings shadowed inside a callable: %s', async (binding) => {
    const source = `def reader():\n    return open("old.csv")\ndef read_inputs():\n    ${binding}\n    return reader()`
    expect(
      await analyzeNotebookSourceFileAccess('python', 'read_inputs()', {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      })
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it.each(['failed', 'timeout', 'cancelled'] as const)(
    'keeps invalidated helpers unavailable across intervening cells after %s',
    async (status) => {
      const helper = {
        helperId: 'csv-helper',
        skillIdentity: 'skill://csv-helper',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['read_inputs'],
        source: 'def read_inputs():\n    return open("old.csv")',
        sourceDigest: 'digest-csv-helper'
      }
      const context = await fileContext(
        'python',
        ['read_inputs = lambda: None\nraise RuntimeError()', 'value = 1', 'read_inputs()'],
        [
          {
            status,
            kernelDispatched: true,
            helperModules: [helper],
            helperEvidenceStatus: { state: 'complete' }
          },
          {},
          { helperModules: [helper], helperEvidenceStatus: { state: 'complete' } }
        ]
      )
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it.each([
    'def _read():\n    return open("old.csv")\n_read = lambda: open("new.csv")\ndef read_inputs():\n    return _read()',
    'def read_inputs():\n    def _read():\n        return open("old.csv")\n    _read = lambda: None\n    return _read()'
  ])('does not replay rebound private or nested helper functions: %s', async (source) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', 'read_inputs()', {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      })
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it('resolves a captured helper function before a same-named module function', async () => {
    const source =
      'def reader():\n    return open("global.csv")\ndef read_inputs():\n    def reader():\n        return open("local.csv")\n    def invoke():\n        return reader()\n    return invoke()'
    expect(
      await analyzeNotebookSourceFileAccess('python', 'read_inputs()', {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      })
    ).toMatchObject({ reads: ['local.csv'], readState: 'complete', externalState: 'complete' })
  })

  it.each([true, false])(
    'does not restore a helper rebound in a failed run (precompute=%s)',
    async (precompute) => {
      const helper = {
        helperId: 'csv-helper',
        skillIdentity: 'skill://csv-helper',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['read_inputs'],
        source: 'def read_inputs():\n    return open("old.csv")',
        sourceDigest: 'digest-csv-helper'
      }
      const context = await fileContext(
        'python',
        ['read_inputs = lambda: None\nraise RuntimeError()', 'read_inputs()'],
        [
          {
            status: 'failed',
            kernelDispatched: true,
            helperModules: [helper],
            helperEvidenceStatus: { state: 'complete' }
          },
          { helperModules: [helper], helperEvidenceStatus: { state: 'complete' } }
        ],
        precompute
      )
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it('keeps helper analysis partial when the runtime records more modules than the replay budget', async () => {
    const helperModules = Array.from({ length: 33 }, (_, index) => ({
      helperId: `helper-${index}`,
      skillIdentity: 'skill://readers',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: [`reader_${index}`],
      source: `def reader_${index}():\n    return open("input-${index}.csv")`,
      sourceDigest: `digest-${index}`
    }))
    const context = await fileContext(
      'python',
      ['reader_0()'],
      [{ helperModules, helperEvidenceStatus: { state: 'complete' } }]
    )
    expect(await analyzeNotebookSourceFileAccess('python', 'reader_0()', context)).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'unreachable statements after return',
      'def read_inputs():\n    return 1\n    open("dead.csv")'
    ],
    ['lazy generator bodies', 'def read_inputs():\n    yield open("lazy.csv")']
  ])('keeps helper replay partial for %s', async (_label, source) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [{ source, exports: ['read_inputs'] }]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it('does not attribute top-level helper import I/O to a later call', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'open("import.csv")\ndef read_inputs():\n    return 1',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    'try:\n    raise Exception()\nexcept Exception as read_inputs:\n    pass',
    'match replacement:\n    case read_inputs:\n        pass'
  ])('does not replay helper exports overwritten by capture bindings: %s', async (suffix) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `def read_inputs():\n    return open("old.csv")\ndef replacement():\n    return open("new.csv")\n${suffix}`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each(['nonlocal', 'global'])(
    'does not certify stale helper reads after %s rebinding',
    async (scope) => {
      const reader = 'def read():\n    return open("old.csv")'
      const source =
        scope === 'global'
          ? `${reader}\ndef read_inputs():\n    def mutate():\n        global read\n        read = lambda: None\n    mutate()\n    return read()`
          : `def read_inputs():\n    ${reader.replaceAll('\n', '\n    ')}\n    def mutate():\n        nonlocal read\n        read = lambda: None\n    mutate()\n    return read()`
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('invalidates an exception alias before replaying a later notebook call', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        { source: 'def read_inputs():\n    return open("old.csv")', exports: ['read_inputs'] }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'try:\n    raise Exception()\nexcept Exception as read_inputs:\n    pass\nread_inputs()',
        context
      )
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it('does not restore module globals on a later exported helper call', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'path = "old.csv"\ndef mutate():\n    global path\n    path = "new.csv"\ndef read_inputs():\n    return open(path)',
          exports: ['mutate', 'read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'mutate()\nread_inputs()', context)
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it('keeps ordinary exception handling without rebinding a helper analyzable', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    try:\n        return open("input.csv")\n    except Exception:\n        pass',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: ['input.csv'], readState: 'complete' }
    )
  })

  it('keeps private functions in their defining helper module', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def _read():\n    return open("first.csv")\ndef first():\n    return _read()',
          exports: ['first']
        },
        {
          source: 'def _read():\n    return open("second.csv")\ndef second():\n    return _read()',
          exports: ['second']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'first()', context)).toMatchObject({
      reads: ['first.csv']
    })
  })

  it('resolves a nested helper reader against its enclosing local bindings', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    path = "nested.csv"\n    def read():\n        return open(path)\n    return read()',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: ['nested.csv'], readState: 'complete' }
    )
  })

  it('keeps conditional nested helper definitions partial', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    if enabled:\n        def read():\n            return open("first.csv")\n    else:\n        def read():\n            return open("second.csv")\n    return read()',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: [], readState: 'partial', externalState: 'partial' }
    )
  })

  it.each([
    ['path = "global.csv"', 'path = "local.csv"', 'return open(path)', ['local.csv']],
    [
      'paths = ["global.csv"]',
      'paths = ["local.csv"]',
      'for path in paths:\n            open(path)',
      ['local.csv']
    ]
  ])(
    'preserves captured locals over same-named module bindings: %s',
    async (global, local, body, reads) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [
          {
            source: `${global}\ndef read_inputs():\n    ${local}\n    def read():\n        ${body}\n    return read()`,
            exports: ['read_inputs']
          }
        ]
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({
        reads,
        readState: 'complete'
      })
    }
  )

  it('loads globals from a separately recorded helper module during nested calls', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def first():\n    return second()',
          exports: ['first']
        },
        {
          source: 'INPUT_PATH = "second.csv"\ndef second():\n    return open(INPUT_PATH)',
          exports: ['second']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'first()', context)).toMatchObject({
      reads: ['second.csv'],
      readState: 'complete'
    })
  })

  it('keeps caller namespace taints while replaying recorded helpers', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['pandas'],
      pythonHelperModules: [
        {
          source: 'import pandas as pd\ndef read_inputs():\n    return pd.read_csv("input.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it('does not expand a helper after a loop target rebinds its export', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def read_inputs():\n    return open("input.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'for read_inputs in [None]:\n    pass\nvalue = read_inputs()',
        context
      )
    ).toMatchObject({ reads: [] })
  })

  it('does not certify an export without a matching callable body', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [{ source: 'value = 1', exports: ['read_inputs'] }]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { readState: 'partial', externalState: 'partial' }
    )
  })

  it('drops recorded helper evidence after an unsafe entry', () => {
    const context = projectNotebookFileContext('python', [
      {
        facts: { state: 'available', definedNames: [], usedNames: [], mutatedNames: [] },
        fileContext: {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonHelperModules: [{ source: 'def read_inputs(): pass', exports: ['read_inputs'] }]
        }
      },
      {
        facts: { state: 'unknown', reasons: ['opaque-mutation'] },
        fileContext: { staticStrings: [], staticCollections: [], localFileWrappers: [] }
      }
    ])
    expect(context?.pythonHelperModules).toBeUndefined()
  })

  it('keeps prior Python value resolution without certifying pure helper file effects', async () => {
    const context = await fileContext('python', [
      'scale = 2\ndef label(value):\n    return str(value * scale)'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'text = label(3)', context)
    ).toMatchObject({
      readState: 'complete',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not replay an async helper before it is awaited', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'async def read_inputs():\n    return open("async.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it('keeps helper aliases unresolved when the alias is not replayed', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def read_inputs():\n    return open("aliased.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'reader = read_inputs\nvalue = reader()',
        context
      )
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it('does not certify decorated helper exports from their raw function body', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def decorate(fn):\n    return fn\n@decorate\ndef read_inputs():\n    return open("decorated.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it('keeps helper delegation to opaque callables partial', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def read_inputs():\n    return transform("input.dat")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['path="input.csv"', '', ['input.csv']],
    ['unused, path="input.csv"', '1', ['input.csv']],
    ['path="input.csv", /', '', ['input.csv']],
    ['*, path="input.csv"', '', ['input.csv']],
    ['path="input.csv"', '"override.csv"', ['override.csv']],
    ['*, path="input.csv"', 'path="override.csv"', ['override.csv']]
  ])('binds literal helper defaults: %s (%s)', async (parameters, arguments_, reads) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `def read_inputs(${parameters}):\n    return open(path)`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', `read_inputs(${arguments_})`, context)
    ).toMatchObject({
      reads,
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not resolve helper defaults against caller bindings', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [{ name: 'DEFAULT_PATH', value: 'caller.csv' }],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'DEFAULT_PATH = "module.csv"\ndef read_inputs(path=DEFAULT_PATH):\n    return open(path)',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    'import custom_loader',
    'from custom_loader import value',
    'import pandas.custom_plugin',
    'from . import custom_loader',
    'if enabled:\n    import custom_loader'
  ])('keeps unknown helper imports partial: %s', async (imports) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `${imports}\ndef read_inputs():\n    return open("input.csv")`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: ['input.csv'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    ['path', '"a.csv", "b.csv"'],
    ['path', 'path="a.csv", extra=1'],
    ['path', '"a.csv", path="b.csv"'],
    ['path', 'path="a.csv", path="b.csv"'],
    ['path', ''],
    ['*, path', '"a.csv"'],
    ['path, /', 'path="a.csv"'],
    ['path', '*["a.csv"]'],
    ['path', '**{"path": "a.csv"}'],
    ['path, *, required', '"a.csv"']
  ])(
    'does not replay invalid or ambiguous helper arguments: %s (%s)',
    async (parameters, arguments_) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [
          {
            source: `def read_inputs(${parameters}):\n    return open("body.csv")`,
            exports: ['read_inputs']
          }
        ]
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', `read_inputs(${arguments_})`, context)
      ).toMatchObject({
        reads: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each([
    ['path, *args', '"input.csv", 1'],
    ['path, **kwargs', 'path="input.csv", extra=1'],
    ['path, /, **kwargs', '"input.csv", path="other.csv"'],
    ['path="input.csv", /, **kwargs', 'path="other.csv"']
  ])('accepts supported variadic helper arguments: %s (%s)', async (parameters, arguments_) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `def read_inputs(${parameters}):\n    return open(path)`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', `read_inputs(${arguments_})`, context)
    ).toMatchObject({
      reads: ['input.csv'],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('keeps recursive helper replay partial', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs(path):\n    if path == "done":\n        return open(path)\n    return read_inputs("done")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs("start")', context)
    ).toMatchObject({ readState: 'partial', externalState: 'partial' })
  })

  it('does not leak helper-local possible aliases into caller analysis', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [
        { name: 'paths', values: ['old.txt'] },
        { name: 'alias', values: ['alias.txt'] }
      ],
      staticCollectionAliases: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    if enabled:\n        alias = paths\n    return open("input.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'value = read_inputs()\nalias.append("new.txt")\nfor path in paths:\n    open(path, "w").close()',
        context
      )
    ).toMatchObject({
      reads: ['input.csv'],
      writes: ['old.txt'],
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'class Loader:\n    source = open("class.csv")',
    'def decorate(fn):\n    open("decorator.csv")\n    return fn\n@decorate\ndef registered():\n    pass',
    'def registered(value=open("default.csv")):\n    pass',
    'def registered(value: factory()):\n    pass',
    'def registered() -> factory():\n    pass'
  ])('keeps unmodeled helper import effects partial: %s', async (definition) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `${definition}\ndef read_inputs():\n    return open("input.csv")`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: ['input.csv'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['reader', 'reader', 'lambda: open("callback.csv")'],
    ['*, reader', 'reader', 'reader=lambda: open("callback.csv")'],
    ['open', 'open', 'lambda: open("callback.csv")']
  ])(
    'does not dispatch a callable helper parameter to a same-named binding: %s',
    async (signature, name, argument) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [
          {
            source: `def reader():\n    return open("private.csv")\ndef read_inputs(${signature}):\n    return ${name}()`,
            exports: ['read_inputs']
          }
        ]
      }
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `value = read_inputs(${argument})`,
        context
      )
      expect(result).toMatchObject({ readState: 'partial', externalState: 'partial' })
      expect(result?.reads).not.toContain('private.csv')
    }
  )

  it('replays an async helper when its call is awaited', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'async def read_inputs():\n    return open("async.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = await read_inputs()', context)
    ).toMatchObject({ reads: ['async.csv'], readState: 'complete', externalState: 'complete' })
  })

  it('does not inherit await status inside an async helper body', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'async def outer():\n    return inner()\nasync def inner():\n    return open("inner.csv")',
          exports: ['outer', 'inner']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = await outer()', context)
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it('captures fixed input paths inside a recorded Python helper called in a later cell', async () => {
    const helperSource =
      'import pandas as pd\ndef read_inputs():\n    left = pd.read_csv("left.csv")\n    right = pd.read_csv("right.csv")\n    return left'
    const context = await fileContext(
      'python',
      ['data = read_inputs()'],
      [
        {
          helperModules: [
            {
              helperId: 'csv-helper',
              skillIdentity: 'skill://csv-helper',
              packageOrigin: 'test',
              interfaceRevision: '1',
              registeredGeneration: 'generation-1',
              exports: ['read_inputs'],
              source: helperSource,
              sourceDigest: 'digest-csv-helper'
            }
          ],
          helperEvidenceStatus: { state: 'complete' }
        }
      ]
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'data = read_inputs()', context)
    ).toMatchObject({
      reads: ['left.csv', 'right.csv'],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('keeps pandas groupby input/output complete inside a recorded helper', async () => {
    const helperSource = `import pandas as pd
def summarize(input_path, output_path):
    frame = pd.read_csv(input_path)
    frame.groupby("group", as_index=False)["value"].mean().to_csv(output_path, index=False)`
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'summarize("inputs/patients.csv", "outputs/summary.csv")',
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonHelperModules: [{ source: helperSource, exports: ['summarize'] }]
        }
      )
    ).toMatchObject({
      reads: ['inputs/patients.csv'],
      writes: ['outputs/summary.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reasonCodes: []
    })
  })

  it('does not reuse prior helper evidence after an incomplete helper load', async () => {
    const helper = {
      helperId: 'csv-helper',
      skillIdentity: 'skill://csv-helper',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source: 'def read_inputs():\n    return open("left.csv")',
      sourceDigest: 'digest-csv-helper'
    }
    const context = await fileContext(
      'python',
      ['value = read_inputs()', 'value = read_inputs()\nlabel = "retained"'],
      [
        { helperModules: [helper], helperEvidenceStatus: { state: 'complete' } },
        {
          helperModules: [helper],
          helperEvidenceStatus: { state: 'incomplete', reasons: ['payload-limit'] }
        }
      ]
    )
    const sidecar = JSON.parse(
      await readFile(
        join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
        'utf8'
      )
    )
    expect(sidecar.runs['run-1'].fileContext.pythonHelperModules).toBeUndefined()
    expect(sidecar.runs['run-1'].fileContext.staticStrings).toContainEqual({
      name: 'label',
      value: 'retained'
    })
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not suppress helper evidence recorded by an unsuccessful run', async () => {
    const helper = {
      helperId: 'csv-helper',
      skillIdentity: 'skill://csv-helper',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source: 'def read_inputs():\n    return open("left.csv")',
      sourceDigest: 'digest-csv-helper'
    }
    const context = await fileContext(
      'python',
      ['value = 1', 'value = read_inputs()'],
      [
        {
          status: 'failed',
          kernelDispatched: true,
          helperModules: [helper],
          helperEvidenceStatus: { state: 'complete' }
        },
        { helperModules: [helper], helperEvidenceStatus: { state: 'complete' } }
      ]
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: ['left.csv'],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('replays helper module constants and private reader functions', async () => {
    const helperSource = `import pandas as pd
INPUT_PATH = "left.csv"
def _read(path):
    return pd.read_csv(path)
def read_inputs():
    return _read(INPUT_PATH)`
    const context = await fileContext(
      'python',
      ['data = read_inputs()'],
      [
        {
          helperModules: [
            {
              helperId: 'csv-helper',
              skillIdentity: 'skill://csv-helper',
              packageOrigin: 'test',
              interfaceRevision: '1',
              registeredGeneration: 'generation-1',
              exports: ['read_inputs'],
              source: helperSource,
              sourceDigest: 'digest-csv-helper'
            }
          ],
          helperEvidenceStatus: { state: 'complete' }
        }
      ]
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'data = read_inputs()', context)
    ).toMatchObject({
      reads: ['left.csv'],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not expand a recorded helper after its exported name is rebound', async () => {
    const context = await fileContext(
      'python',
      ['read_inputs = lambda: None\nvalue = read_inputs()'],
      [
        {
          helperModules: [
            {
              helperId: 'csv-helper',
              skillIdentity: 'skill://csv-helper',
              packageOrigin: 'test',
              interfaceRevision: '1',
              registeredGeneration: 'generation-1',
              exports: ['read_inputs'],
              source: 'import pandas as pd\ndef read_inputs():\n    return pd.read_csv("left.csv")',
              sourceDigest: 'digest-csv-helper'
            }
          ],
          helperEvidenceStatus: { state: 'complete' }
        }
      ]
    )
    expect(context?.pythonHelperModules).toBeUndefined()
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: [] }
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'read_inputs = lambda: None\nvalue = read_inputs()',
        context
      )
    ).toMatchObject({ reads: [], writeState: 'complete' })
  })

  it('does not replay a helper whose export is rebound to another callable', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    return open("old.csv")\ndef replacement():\n    return open("new.csv")\nread_inputs = replacement',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it('does not replay an exported helper after a class rebind', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def read_inputs():\n    return open("old.csv")\nclass read_inputs:\n    pass',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: [], readState: 'partial', externalState: 'partial' }
    )
  })

  it.each([
    'if True:\n    read_inputs = replacement',
    'if enabled:\n    def read_inputs():\n        return open("new.csv")',
    'try:\n    read_inputs = replacement\nexcept Exception:\n    pass',
    'try:\n    pass\nfinally:\n    read_inputs = replacement',
    'while enabled:\n    read_inputs = replacement\n    break',
    'with manager() as resource:\n    read_inputs = replacement',
    'with manager() as read_inputs:\n    pass',
    'match value:\n    case 1:\n        read_inputs = replacement',
    'for item in items:\n    read_inputs = replacement',
    'if enabled:\n    read_inputs, other = replacement, None',
    'if enabled:\n    import custom_reader as read_inputs',
    'if enabled:\n    from custom_reader import reader as read_inputs',
    'if enabled:\n    del read_inputs',
    '@decorate\ndef read_inputs():\n    return open("new.csv")'
  ])('does not replay an export that may be rebound in module control flow: %s', async (rebind) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `def read_inputs():\n    return open("old.csv")\ndef replacement():\n    return open("new.csv")\n${rebind}`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    'def unrelated():\n    read_inputs = None',
    'if enabled:\n    unrelated = None',
    'if enabled:\n    read_inputs = None\ndef read_inputs():\n    return open("old.csv")'
  ])(
    'preserves a proven final export after unrelated or overwritten bindings: %s',
    async (suffix) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [
          {
            source: `def read_inputs():\n    return open("old.csv")\n${suffix}`,
            exports: ['read_inputs']
          }
        ]
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({
        reads: ['old.csv'],
        readState: 'complete'
      })
    }
  )

  it('drops helper evidence after a cross-cell export rebind', async () => {
    const context = await fileContext(
      'python',
      ['value = 1', 'read_inputs = lambda: None'],
      [
        {
          helperModules: [
            {
              helperId: 'csv-helper',
              skillIdentity: 'skill://csv-helper',
              packageOrigin: 'test',
              interfaceRevision: '1',
              registeredGeneration: 'generation-1',
              exports: ['read_inputs'],
              source: 'import pandas as pd\ndef read_inputs():\n    return pd.read_csv("left.csv")',
              sourceDigest: 'digest-csv-helper'
            }
          ],
          helperEvidenceStatus: { state: 'complete' }
        },
        {}
      ]
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({ reads: [] })
  })

  it('does not restore invalidated helper evidence from sticky run metadata', async () => {
    const helperModules = [
      {
        helperId: 'csv-helper',
        skillIdentity: 'skill://csv-helper',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['read_inputs'],
        source: 'import pandas as pd\ndef read_inputs():\n    return pd.read_csv("left.csv")',
        sourceDigest: 'digest-csv-helper'
      }
    ]
    const context = await fileContext(
      'python',
      ['value = 1', 'read_inputs = lambda: None', 'value = read_inputs()'],
      [
        { helperModules, helperEvidenceStatus: { state: 'complete' } },
        { helperModules, helperEvidenceStatus: { state: 'complete' } },
        { helperModules, helperEvidenceStatus: { state: 'complete' } }
      ]
    )
    expect(context?.pythonHelperModules).toBeUndefined()
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: []
    })
  })

  it.each(['python', 'r'] as const)(
    'restores %s diagnostic path bindings after cache reload',
    async (language) => {
      const context = await fileContext(language, [
        language === 'python'
          ? 'import os\nfrom pathlib import Path\nfolder="out"\npath=Path(folder)/"plot.png"'
          : 'folder <- "out"; path <- file.path(folder,"plot.png")'
      ])
      const diagnostic =
        language === 'python'
          ? 'print(f"Saved: {path} ({os.path.getsize(path)} bytes)")'
          : 'cat(sprintf("Saved: %s (%s bytes)",path,file.size(path)))'
      expect(await analyzeNotebookSourceFileAccess(language, diagnostic, context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
      const rebind = language === 'python' ? 'path=custom_path()\n' : 'path <- custom_path(); '
      expect(
        (await analyzeNotebookSourceFileAccess(language, rebind + diagnostic, context))
          .externalState
      ).toBe('partial')
    }
  )

  it('retains Python console observation identities after cache reload', async () => {
    const context = await fileContext('python', ['import os as fs\nfrom pathlib import Path'])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'print(fs.getcwd())\nprint(Path("plot.png").stat().st_size)',
        context
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'open("report.txt","w").write(fs.getcwd())',
        context
      )
    ).toMatchObject({ externalState: 'partial' })
  })

  it('retains R logical subsets across blocks and cache reloads', async () => {
    const context = await fileContext('r', [
      'paths <- c("keep.txt", "skip.txt", "last.txt")',
      'selected <- paths[c(TRUE,FALSE)]',
      'paths <- c("replacement.txt")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'for (path in selected) readLines(path)', context)
    ).toMatchObject({
      reads: ['keep.txt', 'last.txt'],
      readState: 'complete'
    })
  })

  it('retains shadowed R sequence identity across cache reloads', async () => {
    const context = await fileContext('r', [
      'paths <- c("keep.txt", "skip.txt")',
      'seq_along <- function(x) c(2L)'
    ])
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'for (path in paths[seq_along(paths)]) readLines(path)',
          context
        )
      ).readState
    ).toBe('partial')
  })

  it.each(['python', 'r'] as const)(
    'retains independent %s subsets after the original changes and the cache reopens',
    async (language) => {
      const scripts =
        language === 'python'
          ? ['paths = ["keep.txt", "other.txt"]', 'selected = paths[:]', 'paths[0] = "changed.txt"']
          : [
              'paths <- c("keep.txt", "other.txt")',
              'selected <- paths[c(1,2)]',
              'paths[1] <- "changed.txt"'
            ]
      const context = await fileContext(language, scripts)
      const code = language === 'python' ? 'open(selected[0]).read()' : 'readLines(selected[[1]])'
      expect(await analyzeNotebookSourceFileAccess(language, code, context)).toMatchObject({
        reads: ['keep.txt'],
        readState: 'complete'
      })
      expect(context?.staticCollections.some(({ name }) => name === 'paths')).toBe(false)
    }
  )
  it.each(['python', 'r'] as const)(
    'shares parsing when projecting %s dependency and path context',
    async (language) => {
      const source =
        language === 'python' ? 'path = "inputs/counts.csv"' : 'path <- "inputs/counts.csv"'
      await analyzeNotebookSourceFileAccess(language, source)
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const context = await fileContext(language, [source])
      expect(context?.staticStrings).toContainEqual({ name: 'path', value: 'inputs/counts.csv' })
      expect(parse).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    [
      'python',
      'import xarray as xr\ndef read_inputs(paths):\n    return xr.open_mfdataset(paths)',
      'read_inputs(["inputs/a.nc", "inputs/b.nc"])',
      'paths',
      ['inputs/a.nc', 'inputs/b.nc']
    ],
    [
      'python',
      'import numpy as np\ndef read_inputs(lines):\n    return np.loadtxt(lines)',
      'read_inputs(["1 2", "3 4"])',
      'lines',
      []
    ],
    [
      'r',
      'read_inputs <- function(paths) Biostrings::readDNAStringSet(paths)',
      'read_inputs(c("inputs/a.fa", "inputs/b.fa"))',
      'paths',
      ['inputs/a.fa', 'inputs/b.fa']
    ]
  ] as const)(
    'retains %s wrapper input forms after cache reload',
    async (language, setup, call, inputForm, reads) => {
      const context = await fileContext(language, [setup])
      expect(context?.localFileWrappers).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'read_inputs', inputForm })])
      )
      expect(await analyzeNotebookSourceFileAccess(language, call, context)).toMatchObject({
        readState: 'complete',
        reads
      })
    }
  )

  it('does not reuse a builtin callback after same-run replacement and reopening', async () => {
    const context = await fileContext('r', [
      'formatter <- function(x) round(x)\nround <- function(x) readRDS("hidden.rds")'
    ])
    expect(context?.rFunctions?.map(({ name }) => name) ?? []).not.toContain('formatter')
    for (const fn of ['formatter', 'round', 'function(x) round(x)']) {
      expect(
        await analyzeNotebookSourceFileAccess('r', `result <- lapply(1:3, ${fn})`, context)
      ).toMatchObject({ readState: 'partial' })
    }
  })

  it('rebuilds R callable summaries after reopening and records invocation-time closure reads', async () => {
    const context = await fileContext('r', [
      'factor <- 2\nformatter <- function(x) round(x * factor)',
      'factor <- 3'
    ])
    expect(context?.rFunctions?.map(({ name }) => name)).toContain('formatter')
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'result <- lapply(1:3, formatter)\nwrite.csv(result, "result.csv")',
        context
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', writes: ['result.csv'] })
    const sidecar = await readFile(
      join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
      'utf8'
    )
    expect(sidecar).toContain('r-function')
    expect(sidecar).not.toContain('"rFunctions"')
  })

  it.each([
    ['formatter <- function(x) round(x)', 'formatter <- function(x) readRDS("hidden.rds")'],
    ['formatter <- function(x) round(x)', 'round <- function(x) readRDS("hidden.rds")']
  ])('discards unsafe R callable knowledge after replacement: %s', async (...scripts) => {
    const context = await fileContext('r', scripts)
    // An opaque replacement can retain its identity, but never the old read-only contract.
    expect(
      context?.rFunctions
        ?.filter(({ summary }) => summary.methods.every((method) => method.effect === 'read'))
        .map(({ name }) => name) ?? []
    ).not.toContain('formatter')
    expect(
      await analyzeNotebookSourceFileAccess('r', 'result <- lapply(1:3, formatter)', context)
    ).toMatchObject({ readState: 'partial' })
  })

  const cases = [
    {
      language: 'python',
      name: 'append',
      scripts: ["paths = ['old.txt']", "paths.append('new.txt')"]
    },
    {
      language: 'python',
      name: 'subscript',
      scripts: ["paths = ['old.txt']", "paths[0] = 'new.txt'"]
    },
    {
      language: 'python',
      name: 'alias',
      scripts: ["paths = ['old.txt']", 'alias = paths', "alias[0] = 'new.txt'"]
    },
    {
      language: 'python',
      name: 'conditional alias',
      scripts: ["paths = ['old.txt']", 'if enabled:\n    alias = paths', "alias.append('new.txt')"]
    },
    {
      language: 'python',
      name: 'augmented assignment',
      scripts: ["paths = ['old.txt']", "paths += ['new.txt']"]
    },
    { language: 'python', name: 'deletion', scripts: ["paths = ['old.txt']", 'del paths[0]'] },
    {
      language: 'python',
      name: 'explicit setitem',
      scripts: ["paths = ['old.txt']", "paths.__setitem__(0, 'new.txt')"]
    },
    {
      language: 'python',
      name: 'explicit in-place addition',
      scripts: ["paths = ['old.txt']", "paths.__iadd__(['new.txt'])"]
    },
    {
      language: 'python',
      name: 'conditional rebind',
      scripts: [
        "paths = ['old.txt']",
        'alias = paths',
        "if enabled:\n    alias = ['other.txt']",
        "alias.append('new.txt')"
      ]
    },
    {
      language: 'r',
      name: 'replacement',
      scripts: ["paths <- c('old.txt', 'other.txt')", "paths[1] <- 'new.txt'"]
    }
  ] as const

  it.each(cases)(
    'does not reuse stale $language paths after $name across runs',
    async ({ language, scripts }) => {
      const context = await fileContext(language, [...scripts])
      const result = await analyzeNotebookSourceFileAccess(
        language,
        language === 'python'
          ? "for path in paths:\n    open(path, 'w').close()"
          : "for (path in paths) writeLines('data', path)",
        context
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it.each(cases)(
    'does not enumerate stale $language paths after $name in one run',
    async ({ language, scripts }) => {
      const result = await analyzeNotebookSourceFileAccess(
        language,
        [
          ...scripts,
          language === 'python'
            ? "for path in paths:\n    open(path, 'w').close()"
            : "for (path in paths) writeLines('data', path)"
        ].join('\n')
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it('invalidates persisted Python aliases during the current run', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", 'alias = paths'])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      ["alias.append('new.txt')", 'for path in paths:', "    open(path, 'w').close()"].join('\n'),
      context
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it('rebuilds alias identities without persisting transient context fields', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", 'alias = paths'])
    expect(context?.staticCollectionAliases).toHaveLength(1)
    const sidecar = await readFile(
      join(
        roots.at(-1)!,
        'notebooks',
        'default-project',
        'session-1',
        'cache',
        'dependency-analysis.json'
      ),
      'utf8'
    )
    expect(sidecar).not.toContain('staticCollectionAliases')
    expect(sidecar).not.toContain('resolvedKernelNames')
  })

  it('invalidates stale read paths as well as writes', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", "paths.append('new.txt')"])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'for path in paths:\n    open(path).read()',
      context
    )
    expect(result.readState).toBe('partial')
    expect(result.reads).toEqual([])
  })

  it('does not enumerate a Python iterable that the loop body mutates', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        "paths = ['old.txt']",
        'for path in paths:',
        "    if path == 'old.txt':",
        "        paths.append('new.txt')",
        "    open(path, 'w').close()"
      ].join('\n')
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it.each([false, true])(
    'invalidates live Python iteration through an alias (%s)',
    async (viaAlias) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          "paths = ['first.txt', 'old.txt']",
          'alias = paths',
          'for path in paths:',
          `    ${viaAlias ? 'alias' : 'paths'}[1] = 'new.txt'`,
          "    open(path, 'w').close()"
        ].join('\n')
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it('updates a static Python collection after a walrus assignment', async () => {
    const source = [
      "paths = ['old.txt']",
      "(paths := ['new.txt'])",
      "for path in paths:\n    open(path, 'w').close()"
    ].join('\n')
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.writeState).toBe('complete')
    expect(result.writes).toEqual(['new.txt'])
  })

  it('does not persist values derived from invalidated Python iteration', async () => {
    const context = await fileContext('python', [
      "paths = ['first.txt', 'old.txt']",
      "for path in paths:\n    paths[1] = 'new.txt'\n    last = path"
    ])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      "open(last, 'w').close()",
      context
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it('preserves independent collections after a mutation', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']\nindependent = ['keep.txt']",
      "paths.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'independent', values: ['keep.txt'] }])
  })

  it('detaches a rebound Python alias before later mutation', async () => {
    const context = await fileContext('python', [
      "paths = ['keep.txt']",
      'alias = paths',
      "alias = ['other.txt']",
      "alias.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'paths', values: ['keep.txt'] }])
  })

  it('retains possible references through a conditional alias rebind', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']",
      'alias = paths',
      "if enabled:\n    alias = ['other.txt']",
      "alias.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([])
  })

  it('preserves an R copy when its source vector is replaced', async () => {
    const context = await fileContext('r', [
      "paths <- c('keep.txt', 'other.txt')",
      'copied <- paths',
      "paths[1] <- 'new.txt'"
    ])
    expect(context?.staticCollections).toEqual([
      { name: 'copied', values: ['keep.txt', 'other.txt'], rKind: 'vector' }
    ])
  })

  it('preserves the R iteration snapshot when its original vector is replaced', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        "paths <- c('first.txt', 'old.txt')",
        'for (path in paths) {',
        "  paths[2] <- 'new.txt'",
        "  writeLines('data', path)",
        '}'
      ].join('\n')
    )
    expect(result.writeState).toBe('complete')
    expect(result.writes).toEqual(['first.txt', 'old.txt'])
  })

  it.each(['python', 'r'] as const)(
    'recovers %s paths defined after a failed run without reviving prior values',
    async (language) => {
      const scripts =
        language === 'python'
          ? ["old_path = 'old.txt'", "raise RuntimeError('failed')", "new_path = 'new.txt'"]
          : ["old_path <- 'old.txt'", "stop('failed')", "new_path <- 'new.txt'"]
      const context = await fileContext(
        language,
        scripts,
        [{}, { status: 'failed', kernelDispatched: true }],
        false
      )
      expect(context?.staticStrings).toEqual([{ name: 'new_path', value: 'new.txt' }])
      expect(context?.staticStrings).not.toContainEqual({ name: 'old_path', value: 'old.txt' })
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            language,
            language === 'python' ? 'open(old_path).read()' : 'readLines(old_path)',
            context
          )
        ).readState
      ).toBe('partial')
    }
  )

  it('retains prior values when the failed run never reached the kernel', async () => {
    const context = await fileContext(
      'python',
      ["path = 'keep.txt'", "path = 'other.txt'"],
      [{}, { status: 'failed', kernelDispatched: false }]
    )
    expect(context?.staticStrings).toEqual([{ name: 'path', value: 'keep.txt' }])
  })

  it('recovers a fresh collection after mutation and explicit reassignment', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']",
      "paths.append('extra.txt')\npaths = ['fresh.txt']"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'paths', values: ['fresh.txt'] }])
  })
})

describe('cross-cell biomedical readers', () => {
  it('retains a static MGF writer mode through persisted context', async () => {
    const context = await fileContext('python', ['from pyteomics import mgf', 'mode = "a"'])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'mgf.write([], output="out.mgf", file_mode=mode)',
        context
      )
    ).toMatchObject({ reads: ['out.mgf'], writes: ['out.mgf'], externalState: 'complete' })
  })

  it('retains a proteomics reader alias through persisted context', async () => {
    const context = await fileContext('python', [
      'from pyteomics.mgf import MGF as read_spectra',
      'path = "inputs/spectra.mgf"'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'reader = read_spectra(path)', context)
    ).toMatchObject({ reads: ['inputs/spectra.mgf'], externalState: 'complete' })
  })

  it('retains a named sample file vector across R cells and cache reload', async () => {
    const context = await fileContext('r', [
      'library(tximport)',
      'files <- c(A="inputs/A/quant.sf", B="inputs/B/quant.sf")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'txi <- tximport(files, type="salmon", txOut=TRUE, dropInfReps=TRUE)',
        context
      )
    ).toMatchObject({
      reads: ['inputs/A/quant.sf', 'inputs/B/quant.sf'],
      externalState: 'complete'
    })
  })
  it.each([
    [
      'import SimpleITK as sitk',
      'image = sitk.ReadImage("inputs/ct.nii.gz")',
      ['inputs/ct.nii.gz'],
      'complete'
    ],
    [
      'from SimpleITK import ReadImage as read_image',
      'image = read_image("inputs/ct.nii.gz")',
      ['inputs/ct.nii.gz'],
      'complete'
    ],
    [
      'from radiomics import featureextractor\nextractor = featureextractor.RadiomicsFeatureExtractor()',
      'features = extractor.execute("inputs/ct.nii.gz", "inputs/mask.nii.gz")',
      ['inputs/ct.nii.gz', 'inputs/mask.nii.gz'],
      'partial'
    ]
  ])(
    'retains the reader identity after cache reload: %s',
    async (setup, source, reads, externalState) => {
      const context = await fileContext('python', [setup])
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        reads,
        externalState
      })
    }
  )
})

it('retains a file object constructed in a later cell and then aliased', async () => {
  const context = await fileContext('python', [
    'from radiomics import featureextractor',
    'extractor = featureextractor.RadiomicsFeatureExtractor()',
    'alias = extractor'
  ])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'alias.loadParams("inputs/settings.yaml")',
      context
    )
  ).toMatchObject({ reads: ['inputs/settings.yaml'], externalState: 'partial' })
})

it.each([
  'sitk = object()',
  'if flag:\n    sitk = object()',
  'del sitk',
  'def sitk():\n    return 1'
])('forgets a previous reader after rebinding or mutation: %s', async (replacement) => {
  const context = await fileContext('python', ['import SimpleITK as sitk', replacement])
  expect(context?.pythonBindings?.some((binding) => binding.name === 'sitk') ?? false).toBe(false)
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [] })
})

it('rebuilds helper evidence after a kernel epoch restart', async () => {
  const helperModules = [
    {
      helperId: 'csv-helper',
      skillIdentity: 'skill://csv-helper',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source: 'def read_inputs():\n    return open("restarted.csv")',
      sourceDigest: 'digest-csv-helper'
    }
  ]
  const context = await fileContext(
    'python',
    ['value = 1', 'value = read_inputs()'],
    [
      {
        kernelEpochId: 'epoch-old',
        helperModules,
        helperEvidenceStatus: { state: 'complete' }
      },
      {
        kernelEpochId: 'epoch-new',
        helperModules,
        helperEvidenceStatus: { state: 'complete' }
      }
    ],
    true,
    undefined,
    'epoch-new'
  )
  expect(context?.pythonHelperModules).toEqual([
    { source: helperModules[0]!.source, exports: ['read_inputs'] }
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
  ).toMatchObject({ reads: ['restarted.csv'], readState: 'complete' })
})

it('keeps a read before same-cell reassignment, but does not apply it after reassignment', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk'])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'first = sitk.ReadImage("inputs/first.nii.gz")\nsitk = object()\nsecond = sitk.ReadImage("unused.nii.gz")',
      context
    )
  ).toMatchObject({ reads: ['inputs/first.nii.gz'] })
})

it('invalidates a mutated library through an alias', async () => {
  const context = await fileContext('python', [
    'import SimpleITK as sitk\nalias = sitk',
    'alias.ReadImage = replacement'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it.each([
  { status: 'failed' as const },
  { kernelEpochId: 'other-epoch' },
  { environment: 'other-python' }
])('does not borrow identities from an invalid execution boundary: %j', async (override) => {
  const context = await fileContext('python', ['import SimpleITK as sitk'], [override])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [] })
})

it('preserves imported readers after an operation rejected before kernel dispatch', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk', 'sitk = object()'],
    [{}, { status: 'failed', kernelDispatched: false }]
  )
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['sitk.ReadImage = replacement', 'alias = sitk\nalias.ReadImage = replacement'])(
  'does not certify a patched library in the current cell: %s',
  async (patch) => {
    const context = await fileContext('python', [
      'import SimpleITK as sitk\nreplacement = lambda path: 1'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `${patch}\nsitk.ReadImage("unused.nii.gz")`,
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('does not treat re-importing a monkeypatched module as recovery', async () => {
  const context = await fileContext('python', [
    'import SimpleITK as sitk\nreplacement = lambda path: 1',
    'sitk.ReadImage = replacement',
    'import SimpleITK as recovered'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'recovered.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it.each([true, false])(
  'retains module modifications before a dispatched failure (precompute=%s)',
  async (precompute) => {
    const context = await fileContext(
      'python',
      [
        'import SimpleITK as sitk\nreplacement = lambda path: 1',
        'sitk.ReadImage = replacement\nraise RuntimeError()',
        'import SimpleITK as recovered'
      ],
      [{}, { status: 'failed', kernelDispatched: true }, {}],
      precompute
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'recovered.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('can re-import an unmodified reader after an ordinary execution failure', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk', 'import missing_package', 'import SimpleITK as recovered'],
    [{}, { status: 'failed', kernelDispatched: true }, {}]
  )
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'recovered.ReadImage("inputs/ct.nii.gz")',
      context
    )
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['mutate(sitk)', 'mutate(module=sitk)', 'setattr(sitk, "ReadImage", replacement)'])(
  'does not revive a module exposed to an opaque mutation: %s',
  async (mutation) => {
    const context = await fileContext('python', [
      'import SimpleITK as sitk',
      mutation,
      'import SimpleITK as recovered'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'recovered.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('clears observed module modifications at the kernel epoch boundary', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk\nsitk.ReadImage = replacement', 'import SimpleITK as sitk'],
    [{ kernelEpochId: 'old-epoch' }, {}]
  )
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it('rebuilds malformed cached reader identities from saved code', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk'], [], true, (json) => {
    expect(json).toMatch(/"kind":\s*"import"/)
    return json.replace(/"kind":\s*"import"/g, '"kind":"invalid"')
  })
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['bindings', 'taints'] as const)(
  'bounds accumulated Python %s without reviving trusted effects',
  async (kind) => {
    const entries: FileContextEntry[] = Array.from({ length: 514 }, (_, index) => ({
      facts: { state: 'available', definedNames: [`lib${index}`], usedNames: [], mutatedNames: [] },
      fileContext: {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        ...(kind === 'bindings'
          ? {
              pythonBindings: [
                { name: `lib${index}`, qualifiedName: `module${index}`, kind: 'import' as const }
              ]
            }
          : { pythonTaintedNamespaces: [`module${index}`] })
      }
    }))
    const context = projectNotebookFileContext('python', entries)
    expect(context?.pythonTaintedNamespaces).toEqual(['*'])
    expect(context?.pythonBindings ?? []).toEqual([])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import SimpleITK as sitk\nsitk.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('keeps network readers external when imported in an earlier cell', async () => {
  const context = await fileContext('python', ['import requests as client'])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'response = client.get("https://example.org/data")',
      context
    )
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it('does not invalidate a module merely printed for inspection', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk', 'print(sitk)'])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it('restores sliced R map inputs after loading the dependency cache', async () => {
  const context = await fileContext('r', [
    'paths <- c("a.csv","skip.csv","b.csv")',
    'selected <- paths[-2]',
    'paths <- c("replacement.csv")'
  ])
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'result <- purrr::map(selected,readr::read_csv)',
      context
    )
  ).toMatchObject({ reads: ['a.csv', 'b.csv'], readState: 'complete', externalState: 'complete' })
})

it('does not reuse static R paths constructed by a replaced builtin', async () => {
  const context = await fileContext('r', ['c <- custom_builder', 'paths <- c("wrong.csv")'])
  const result = await analyzeNotebookSourceFileAccess(
    'r',
    'result <- purrr::map(paths,utils::read.csv)',
    context
  )
  expect(result.readState).toBe('partial')
  expect(result.reads).not.toContain('wrong.csv')
})

it('captures matrix chord output while its input remains on the prior DataFrame run', async () => {
  const source = await readFile(join(__dirname, 'reported-python-matrix-chord.fixture.py'), 'utf8')
  const context = await fileContext('python', [
    "import pandas as pd\ndf = pd.read_excel('inputs/edge-weights-222222222222.xlsx')"
  ])
  const access = await analyzeNotebookSourceFileAccess('python', source, context)
  expect(access).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    writes: ['chord_diagram.png']
  })
})

it('reports missing DataFrame context for the matrix chord rather than inventing an input file', async () => {
  const source = await readFile(join(__dirname, 'reported-python-matrix-chord.fixture.py'), 'utf8')
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access.readState).toBe('partial')
  expect(access.reads).toEqual([])
})

it('restores bounded R atomic value knowledge from the analysis cache', async () => {
  const context = await fileContext('r', ['source <- 0.5'])
  expect(context?.rAtomicValueNames).toContain('source')
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'value <- sin(source); if (value > 0) value <- value - 1; write.csv(data.frame(value), "out.csv")',
      context
    )
  ).toMatchObject({ readState: 'complete', writeState: 'complete', writes: ['out.csv'] })
})

it('drops R atomic knowledge across an interrupted kernel operation', async () => {
  const context = await fileContext(
    'r',
    ['source <- 0.5', 'stop("interrupted")'],
    [{}, { status: 'failed' }]
  )
  expect(context?.rAtomicValueNames ?? []).not.toContain('source')
})

describe('pandas CSV converter content proof', () => {
  const setup =
    'import numpy as np\nimport pandas as pd\nnp.save("cache.npy",np.array([1,2]))\ndef convert(value):\n    open("cache.npy","w").write("changed")\n    return float(value)\n'
  it.each([
    'pd.read_csv("observations.csv",None,None,None,None,None,convert)',
    'pd.read_csv("observations.csv",' + Array(11).fill('None').join(',') + ',{"x":convert})',
    'pd.read_csv("observations.csv",' + Array(15).fill('None').join(',') + ',convert)',
    'pd.read_csv("observations.csv",' + Array(45).fill('None').join(',') + ',convert)',
    'read("observations.csv",None,None,None,None,None,convert)',
    'load("observations.csv")'
  ])('does not certify unproven positional CSV options: %s', async (call) => {
    const source =
      setup +
      'from pandas import read_csv as read\ndef load(path):\n    return pd.read_csv(path,None,None,None,None,None,convert)\n' +
      'frame=' +
      call +
      '\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: expect.arrayContaining(['observations.csv']),
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'frame=pd.read_csv("observations.csv",converters={"eruptions":convert})',
    'converters={"eruptions":convert}\nframe=pd.read_csv("observations.csv",converters=converters)',
    'from pandas import read_csv as read\nframe=read("observations.csv",converters={"eruptions":convert})',
    'def load(path):\n    return pd.read_csv(path,converters={"eruptions":convert})\nframe=load("observations.csv")',
    'frame=pd.read_csv("observations.csv",**options)',
    'frame=pd.read_csv("observations.csv",converters={"eruptions":lambda v:float(v)+float(open("offset.txt").read())})',
    'frame=pd.read_csv("observations.csv",converters={"eruptions":convert},sep=(np.save("nested.npy",np.array([3,4])) or ","))'
  ])('revokes serialized proof after a CSV converter runs: %s', async (invocation) => {
    const result = await analyzePythonNotebookSource(
      setup + invocation + '\nafter=np.load("cache.npy")'
    )
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })
})

describe('pandas CSV converter proof boundaries', () => {
  const setup =
    'import numpy as np\nimport pandas as pd\nnp.save("cache.npy",np.array([1,2]))\ndef convert(value):\n    open("cache.npy","w").write("changed")\n    return float(value)\n'
  it.each(['', 'converters=None', 'converters={}'])(
    'preserves proof without active converters: %s',
    async (option) => {
      const result = await analyzePythonNotebookSource(
        setup + 'frame=pd.read_csv("observations.csv",' + option + ')\nafter=np.load("cache.npy")'
      )
      expect(result.facts.serializedValueWrites).toHaveLength(1)
      expect(result.facts.typeBindings).toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
    }
  )
  it.each([false, true])('revokes proof through sidecar reload: %s', async (precompute) => {
    const context = await fileContext(
      'python',
      [setup + 'frame=pd.read_csv("observations.csv",converters={"eruptions":convert})'],
      [],
      precompute
    )
    expect(context?.verifiedSerializedValues ?? []).toEqual([])
    const result = await analyzePythonNotebookSource('after=np.load("cache.npy")', context)
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
  it('retains earlier reads and fresh saves', async () => {
    const result = await analyzePythonNotebookSource(
      setup +
        'before=np.load("cache.npy")\nframe=pd.read_csv("observations.csv",converters={"eruptions":convert})\nnp.save("fresh.npy",np.array([3,4]))\nafter=np.load("fresh.npy")'
    )
    expect(result.facts.serializedValueWrites).toEqual([
      { path: 'fresh.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
    for (const target of ['before', 'after'])
      expect(result.facts.typeBindings).toContainEqual(
        expect.objectContaining({ target, typeName: 'numpy.ndarray' })
      )
  })
  it('keeps callback IO partial while retaining the explicit CSV input', async () => {
    const io = await analyzeNotebookSourceFileAccess(
      'python',
      setup +
        'frame=pd.read_csv("observations.csv",converters={"eruptions":convert})\nafter=np.load("cache.npy")'
    )
    expect(io).toMatchObject({
      reads: ['cache.npy', 'observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('pandas CSV selection callback proof', () => {
  const setup =
    'import numpy as np\nimport pandas as pd\nnp.save("cache.npy",np.array([1,2]))\ndef select(value):\n    open("cache.npy","w").write("changed")\n    return False\n'
  it.each(['usecols', 'skiprows'])('revokes serialized proof through %s', async (option) => {
    const source =
      setup +
      'frame=pd.read_csv("observations.csv",' +
      option +
      '=select)\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy', 'observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('pandas CSV selection callback boundaries', () => {
  const setup =
    'import numpy as np\nimport pandas as pd\nnp.save("cache.npy",np.array([1,2]))\ndef select(value):\n    open("cache.npy","w").write("changed")\n    return False\n'
  it.each([
    'usecols=None',
    'usecols=[]',
    'usecols=["eruptions"]',
    'usecols=(0,1)',
    'skiprows=None',
    'skiprows=0',
    'skiprows=1',
    'skiprows=[]',
    'skiprows=[1,3]',
    'skiprows=(1,3)'
  ])('preserves proof for closed selection: %s', async (option) => {
    const result = await analyzePythonNotebookSource(
      setup + 'frame=pd.read_csv("observations.csv",' + option + ')\nafter=np.load("cache.npy")'
    )
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites).toHaveLength(1)
  })
  it.each([
    'from pandas import read_csv as read\nframe=read("observations.csv",skiprows=select)',
    'def load(path):\n    return pd.read_csv(path,usecols=select)\nframe=load("observations.csv")',
    'def load(path):\n    return pd.read_csv(path,skiprows=select)\nframe=load("observations.csv")',
    'frame=pd.read_csv("observations.csv",usecols=select,converters={})',
    'frame=pd.read_csv("observations.csv",skiprows=select,converters=None)',
    'frame=pd.read_csv("observations.csv",skiprows=select,sep=(np.save("nested.npy",np.array([3,4])) or ","))',
    'frame=pd.read_csv("observations.csv",usecols=lambda name:name in open("selection.txt").read())',
    'frame=pd.read_csv("observations.csv",**options)'
  ])('revokes proof across callback invocation variants: %s', async (invocation) => {
    const result = await analyzePythonNotebookSource(
      setup + invocation + '\nafter=np.load("cache.npy")'
    )
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each(['usecols', 'skiprows'])('revokes proof across sidecar reload for %s', async (option) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        [setup + 'frame=pd.read_csv("observations.csv",' + option + '=select)'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      const result = await analyzePythonNotebookSource('after=np.load("cache.npy")', context)
      expect(result.facts.typeBindings).not.toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
    }
  })
  it('preserves earlier reads and fresh saves after selection', async () => {
    const result = await analyzePythonNotebookSource(
      setup +
        'before=np.load("cache.npy")\nframe=pd.read_csv("observations.csv",skiprows=select)\nnp.save("fresh.npy",np.array([3,4]))\nafter=np.load("fresh.npy")'
    )
    for (const target of ['before', 'after'])
      expect(result.facts.typeBindings).toContainEqual(
        expect.objectContaining({ target, typeName: 'numpy.ndarray' })
      )
    expect(result.facts.serializedValueWrites).toEqual([
      { path: 'fresh.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })
})

describe('pandas bad-line callback proof', () => {
  const setup =
    'import numpy as np\nimport pandas as pd\nnp.save("cache.npy",np.array([1,2]))\ndef repair(fields):\n    open("cache.npy","w").write("changed")\n    return fields[:2]\n'
  it('revokes stale content proof after malformed-row repair', async () => {
    const source =
      setup +
      'frame=pd.read_csv("observations.csv",engine="python",on_bad_lines=repair)\nafter=np.load("cache.npy")'
    const result = await analyzePythonNotebookSource(source)
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['cache.npy', 'observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('pandas bad-line callback boundaries', () => {
  const setup =
    'import numpy as np\nimport pandas as pd\nnp.save("cache.npy",np.array([1,2]))\ndef repair(fields):\n    open("cache.npy","w").write("changed")\n    return fields[:2]\n'
  it.each(['error', 'warn', 'skip'])(
    'preserves content proof for built-in %s policy',
    async (policy) => {
      const result = await analyzePythonNotebookSource(
        setup +
          'frame=pd.read_csv("observations.csv",engine="python",on_bad_lines="' +
          policy +
          '")\nafter=np.load("cache.npy")'
      )
      expect(result.facts.typeBindings).toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
      expect(result.facts.serializedValueWrites).toHaveLength(1)
    }
  )
  it.each([
    'from pandas import read_csv as read\nframe=read("observations.csv",engine="python",on_bad_lines=repair)',
    'def load(path):\n    return pd.read_csv(path,engine="python",on_bad_lines=repair)\nframe=load("observations.csv")',
    'frame=pd.read_csv("observations.csv",engine=engine,on_bad_lines=repair)',
    'frame=pd.read_csv("observations.csv",engine="python",on_bad_lines=repair,converters={},usecols=None,skiprows=0)',
    'frame=pd.read_csv("observations.csv",engine="python",on_bad_lines=repair,sep=(np.save("nested.npy",np.array([3,4])) or ","))',
    'frame=pd.read_csv("observations.csv",engine="python",on_bad_lines=lambda fields:fields[:int(open("field-count.txt").read())])',
    'frame=pd.read_csv("observations.csv",engine="python",**options)'
  ])('revokes proof through repair variants: %s', async (invocation) => {
    const result = await analyzePythonNotebookSource(
      setup + invocation + '\nafter=np.load("cache.npy")'
    )
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])('revokes proof across sidecar reload: %s', async (precompute) => {
    const context = await fileContext(
      'python',
      [setup + 'frame=pd.read_csv("observations.csv",engine="python",on_bad_lines=repair)'],
      [],
      precompute
    )
    expect(context?.verifiedSerializedValues ?? []).toEqual([])
    const result = await analyzePythonNotebookSource('after=np.load("cache.npy")', context)
    expect(result.facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
  it('retains proof before repair and from a fresh later save', async () => {
    const result = await analyzePythonNotebookSource(
      setup +
        'before=np.load("cache.npy")\nframe=pd.read_csv("observations.csv",engine="python",on_bad_lines=repair)\nnp.save("fresh.npy",np.array([3,4]))\nafter=np.load("fresh.npy")'
    )
    for (const target of ['before', 'after'])
      expect(result.facts.typeBindings).toContainEqual(
        expect.objectContaining({ target, typeName: 'numpy.ndarray' })
      )
    expect(result.facts.serializedValueWrites).toEqual([
      { path: 'fresh.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })
  it('does not invoke an unused repair helper', async () => {
    const result = await analyzePythonNotebookSource(
      setup +
        'def load(path):\n    return pd.read_csv(path,engine="python",on_bad_lines=repair)\nafter=np.load("cache.npy")'
    )
    expect(result.facts.serializedValueWrites).toHaveLength(1)
    expect(result.facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
})

describe('R directory creation context', () => {
  it.each([false, true])(
    'preserves paths across primitive dir.create precompute=%s',
    async (precompute) => {
      const context = await fileContext(
        'r',
        [
          'source_path <- "outputs/faithful.csv"\noutput_path <- "outputs/result.csv"',
          'dir.create("outputs",showWarnings=FALSE,recursive=TRUE)'
        ],
        [],
        precompute
      )
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          'df <- read.csv(source_path)\nwrite.csv(df,output_path,row.names=FALSE)',
          context
        )
      ).toMatchObject({
        reads: ['outputs/faithful.csv'],
        writes: ['outputs/result.csv'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )

  it.each([
    'dir.create("outputs")',
    'base::dir.create("outputs",recursive=TRUE,showWarnings=FALSE)',
    'base:::dir.create(path="outputs",mode="0777")'
  ])(
    'keeps primitive directory effects partial without inventing file outputs: %s',
    async (source) => {
      const result = await analyzeRNotebookSource(source)
      expect(result.facts).toMatchObject({ state: 'unknown', reasons: ['external-state'] })
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )
  it.each([
    'dir.create("outputs",recursive=TRUE,showWarnings=FALSE)',
    'base::dir.create("outputs",recursive=TRUE,showWarnings=FALSE)'
  ])('retains same-cell path definitions after %s', async (call) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'r',
        [call + '\npath <- "outputs/faithful.csv"'],
        [],
        precompute
      )
      expect((await analyzeNotebookSourceFileAccess('r', 'read.csv(path)', context)).reads).toEqual(
        ['outputs/faithful.csv']
      )
    }
  })
  it.each([
    'dir.create(path_object)',
    'dir.create("outputs",mode=choose_mode())',
    'dir.create({ mutate(); "outputs" })',
    'other::dir.create("outputs")'
  ])('does not preserve context through unknown directory behavior: %s', async (call) => {
    const context = await fileContext('r', ['path <- "old.csv"', call])
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'read.csv(path)', context)).reads
    ).not.toContain('old.csv')
  })
  it('does not trust a replacement directory function from an earlier cell', async () => {
    const context = await fileContext('r', [
      'path <- "old.csv"',
      'dir.create <- function(...) { path <<- "new.csv" }',
      'dir.create("outputs")'
    ])
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'read.csv(path)', context)).reads
    ).not.toContain('old.csv')
  })
  it('does not trust a same-cell replacement directory function', async () => {
    const facts = (
      await analyzeRNotebookSource(
        'dir.create <- function(...) { path <<- "new.csv" }\ndir.create("outputs")'
      )
    ).facts
    expect(facts.state).toBe('unknown')
    expect(facts).not.toMatchObject({ reasons: ['external-state'] })
  })
  it.each([false, true])(
    'does not retain paths after a failed directory setup precompute=%s',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.csv"', 'dir.create("outputs")\npath <- choose_path()'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'read.csv(path)', context)).reads
      ).not.toContain('old.csv')
    }
  )

  it.each(['::', ':::'])('rejects a replaced directory namespace operator %s', async (operator) => {
    const mutation =
      String.fromCharCode(96) +
      operator +
      String.fromCharCode(96) +
      ' <- function(...) function(...) { path <<- "new.csv" }'
    const context = await fileContext('r', [
      'path <- "old.csv"',
      mutation,
      'base' + operator + 'dir.create("outputs")'
    ])
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'read.csv(path)', context)).reads
    ).not.toContain('old.csv')
  })
  it('retains qualified directory setup when only the bare function is replaced', async () => {
    const context = await fileContext('r', [
      'path <- "old.csv"',
      'dir.create <- function(...) { path <<- "new.csv" }',
      'base::dir.create("outputs",showWarnings=FALSE)'
    ])
    expect((await analyzeNotebookSourceFileAccess('r', 'read.csv(path)', context)).reads).toEqual([
      'old.csv'
    ])
  })
})

describe('R direct Gaussian family path context', () => {
  it.each([false, true])(
    'retains paths across the model cell with cache=%s',
    async (precompute) => {
      const context = await fileContext(
        'r',
        [
          'path <- "outputs/faithful.csv"; out <- "outputs/check.csv"',
          'observed <- read.csv(path)',
          'fit <- glm(waiting~eruptions,data=observed,family=stats::gaussian())'
        ],
        [],
        precompute
      )
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          'value <- read.csv(path); write.csv(value,out,row.names=FALSE)',
          context
        )
      ).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        reads: ['outputs/faithful.csv'],
        writes: ['outputs/check.csv']
      })
    }
  )
  it.each(['family_spec', 'stats::gaussian(link=link_spec)', 'gaussian()'])(
    'does not retain stale paths through unproved family %s',
    async (family) => {
      const context = await fileContext('r', [
        'path <- "outputs/old.csv"; gaussian <- replacement',
        'fit <- glm(waiting~eruptions,data=observed,family=' + family + ')'
      ])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'read.csv(path)', context)).reads
      ).not.toContain('outputs/old.csv')
    }
  )
})

describe('failed-run shadow barriers', () => {
  it.each([
    'import pandas as pd\nframe=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("export.csv",index=False)',
    'from pandas import DataFrame as Frame\nframe=Frame({"x":[1.,2.]})\nframe.to_csv(path_or_buf="export.csv",index=False,float_format="%.17g")',
    'import pandas as pd\nframe=pd.DataFrame({"x":[1.,2.]})\nframe.to_json("export.json",orient="records")',
    'from pandas import DataFrame as Frame\nframe=Frame({"x":[1.,2.]})\nframe.to_json(path_or_buf="export.json",orient="records")',
    'import pandas as pd\nseries=pd.Series([1.,2.])\nseries.to_csv("export.csv",index=False)'
  ])('withdraws pandas export opener authority after failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import builtins', 'builtins.open=replacement\nraise RuntimeError()'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each(['to_csv', 'to_json'])(
    'withdraws prior content proof through pandas export %s',
    async (method) => {
      const prefix =
        'import numpy as np,pandas as pd,builtins\nnp.save("cache.npy",np.array([1.,2.]))\nbuiltins.open=replacement\nframe=pd.DataFrame({"x":[1.,2.]})\n'
      expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toHaveLength(
        1
      )
      expect(
        (await analyzePythonNotebookSource(prefix + `frame.${method}("export.txt")`)).facts
          .serializedValueWrites ?? []
      ).toEqual([])
    }
  )

  it.each(['to_csv', 'to_json'])(
    'withdraws pandas export %s paths across cache and isolates epochs',
    async (method) => {
      const source = `import pandas as pd\nframe=pd.DataFrame({"x":[1.,2.]})\nframe.${method}("export.txt")`
      for (const precompute of [false, true]) {
        const scripts = [
          'import builtins',
          'builtins.open=replacement\nraise RuntimeError()',
          'path="old.txt"',
          source
        ]
        const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
        const context = await fileContext('python', scripts, overrides, precompute)
        expect(
          (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context))
            .reads
        ).not.toContain('old.txt')
        const fresh = await fileContext(
          'python',
          scripts,
          overrides,
          precompute,
          undefined,
          'epoch-2'
        )
        expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
          writeState: 'complete',
          externalState: 'complete'
        })
      }
    }
  )

  it.each([
    'frame=pd.DataFrame({"x":[1.,2.]})\ntext=frame.to_csv(index=False,float_format="%.17g")',
    'frame=pd.DataFrame({"x":[1.,2.]})\ntext=frame.to_json(None,orient="records")',
    'frame=pd.Series([1.,2.])\ntext=frame.to_csv(path_or_buf=None,index=False)'
  ])(
    'retains existing pandas text-return uncertainty without tainting facts: %s',
    async (source) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: ['builtins']
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', 'import pandas as pd\n' + source, context)
      ).toMatchObject({
        readState: 'complete',
        writeState: 'partial',
        externalState: 'partial',
        writes: []
      })
      expect(
        (await analyzePythonNotebookSource('import pandas as pd\n' + source, context)).facts.state
      ).toBe('available')
    }
  )

  it('keeps unresolved pandas export arguments conservative', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['builtins']
    }
    for (const call of [
      'frame.to_csv(path,index=False)',
      'frame.to_json(None,**options)',
      'frame.to_csv(*args)',
      'frame.to_csv(None,path_or_buf="export.csv")'
    ])
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import pandas as pd\nframe=pd.DataFrame({"x":[1.,2.]})\n' + call,
          context
        )
      ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
  })

  it('preserves healthy pandas exports and unrelated io precision', async () => {
    for (const pythonTaintedNamespaces of [[], ['io'], ['gzip']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import pandas as pd\nframe=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("export.csv",index=False)',
          context
        )
      ).toMatchObject({ writeState: 'complete', externalState: 'complete', writes: ['export.csv'] })
    }
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['builtins']
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import io\nwith io.open("plain.txt","w") as f:\n    f.write("plain")',
        context
      )
    ).toMatchObject({ writeState: 'complete', externalState: 'complete', writes: ['plain.txt'] })
  })

  it('retains pandas compression uncertainty for HTTP content encoding overrides', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    for (const input of ['"https://example.org/pairs.csv"', 'path'])
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `import pandas as pd\ntable=pd.read_csv(${input},compression=None,converters=None)`,
          context
        )
      ).toMatchObject({ writeState: 'partial' })
  })

  it.each([
    ['gzip', 'GzipFile', 'import pandas as pd\ntable=pd.read_csv("pairs.CSV.GZ",converters=None)'],
    [
      'gzip',
      'GzipFile',
      'from pandas import read_csv as read\ntable=read("pairs.csv",compression="gzip",converters=None)'
    ],
    [
      'gzip',
      'GzipFile',
      'from pandas import read_csv as read\ntable=read(filepath_or_buffer="pairs.csv",compression={"method":"gzip","mtime":0},converters=None)'
    ],
    ['zipfile', 'ZipFile', 'import pandas as pd\ntable=pd.read_csv("pairs.zip",converters=None)'],
    [
      'zipfile',
      'ZipFile',
      'from pandas import read_csv as read\ntable=read("pairs.csv",compression={"method":"zip"},converters=None)'
    ],
    [
      'bz2',
      'BZ2File',
      'from pandas import read_csv as read\ntable=read("pairs.csv.bz2",converters=None)'
    ],
    [
      'lzma',
      'LZMAFile',
      'from pandas import read_csv as read\ntable=read("pairs.csv.xz",converters=None)'
    ],
    [
      'tarfile',
      'TarFile',
      'from pandas import read_csv as read\ntable=read("pairs.tar.gz",converters=None)'
    ],
    [
      'gzip',
      'GzipFile',
      'from pandas import read_csv as read\ndef reopen(path):\n    return read(path,compression="gzip",converters=None)\ntable=reopen("pairs.csv.gz")'
    ]
  ])(
    'withdraws pandas compression authority after %s.%s failure: %s',
    async (module, member, source) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          [`import ${module}`, `${module}.${member}=replacement\nraise RuntimeError()`],
          [{}, { status: 'failed', kernelDispatched: true }],
          precompute
        )
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial'
        })
        expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
      }
    }
  )

  it.each([
    ['gzip', 'GzipFile', 'gzip'],
    ['zipfile', 'ZipFile', 'zip']
  ])('withdraws pandas compression %s content proof', async (module, member, method) => {
    const prefix = `import numpy as np,pandas as pd,${module}\nnp.save("cache.npy",np.array([1.,2.]))\n${module}.${member}=replacement\n`
    expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toHaveLength(1)
    expect(
      (
        await analyzePythonNotebookSource(
          prefix + `pd.read_csv("pairs.csv",compression="${method}",converters=None)`
        )
      ).facts.serializedValueWrites ?? []
    ).toEqual([])
  })

  it.each([
    ['gzip', 'GzipFile', 'gzip'],
    ['zipfile', 'ZipFile', 'zip']
  ])(
    'withdraws pandas compression %s paths and isolates epochs',
    async (module, member, method) => {
      const source = `from pandas import read_csv as read\ntable=read("pairs.csv",compression="${method}",converters=None)`
      for (const precompute of [false, true]) {
        const scripts = [
          `import ${module}`,
          `${module}.${member}=replacement\nraise RuntimeError()`,
          'path="old.txt"',
          source
        ]
        const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
        const context = await fileContext('python', scripts, overrides, precompute)
        expect(
          (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context))
            .reads
        ).not.toContain('old.txt')
        const fresh = await fileContext(
          'python',
          scripts,
          overrides,
          precompute,
          undefined,
          'epoch-2'
        )
        expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
          writeState: 'complete',
          externalState: 'complete'
        })
      }
    }
  )

  it('preserves pandas compression None and unrelated inferred codecs', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip', 'zipfile', 'bz2', 'lzma', 'tarfile']
    }
    for (const options of [',compression=None', ',compression={"method":None}', ''])
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `import pandas as pd\ntable=pd.read_csv("pairs.csv"${options},converters=None)`,
          context
        )
      ).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: ['pairs.csv']
      })
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import pandas as pd\ntable=pd.read_csv("pairs.GZ",compression=None,converters=None)',
        context
      )
    ).toMatchObject({ writeState: 'complete', externalState: 'complete', reads: ['pairs.GZ'] })
    const gzipOnly = { ...context, pythonTaintedNamespaces: ['gzip'] }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import pandas as pd\ntable=pd.read_csv("pairs.zip",converters=None)',
        gzipOnly
      )
    ).toMatchObject({ writeState: 'complete', externalState: 'complete', reads: ['pairs.zip'] })
  })

  it('keeps unresolved pandas compression arguments conservative', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    for (const source of [
      'pd.read_csv(path,converters=None)',
      'pd.read_csv("pairs.csv",compression=method,converters=None)',
      'pd.read_csv("pairs.csv",compression={"method":method},converters=None)',
      'pd.read_csv("pairs.csv",compression=None,**options)',
      'pd.read_csv("pairs.csv",compression="tar",converters=None)',
      'pd.read_csv("pairs.csv",compression={**options},converters=None)'
    ])
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import pandas as pd\ntable=' + source,
          context
        )
      ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
  })

  it.each([
    [
      'bz2',
      'BZ2File',
      'from numpy import loadtxt as read\nvalues=read("pairs.bz2",delimiter=",",dtype=float,ndmin=2)'
    ],
    [
      'bz2',
      'BZ2File',
      'import numpy as np\nvalues=np.genfromtxt(fname="pairs.csv",delimiter=",",dtype=float,ndmin=2)'
    ],
    [
      'lzma',
      'LZMAFile',
      'from numpy import genfromtxt as read\nvalues=read("pairs",delimiter=",",dtype=float,ndmin=2)'
    ],
    [
      'lzma',
      'LZMAFile',
      'import numpy as np\nvalues=np.loadtxt(fname="pairs.xz",delimiter=",",dtype=float,ndmin=2)'
    ],
    [
      'bz2',
      'BZ2File',
      'from numpy import genfromtxt as read\ndef reopen(path):\n    return read(path,delimiter=",",dtype=float,ndmin=2)\nvalues=reopen("pairs.bz2")'
    ],
    [
      'lzma',
      'LZMAFile',
      'from numpy import loadtxt as read\ndef reopen(path):\n    return read(path,delimiter=",",dtype=float,ndmin=2)\nvalues=reopen("pairs.xz")'
    ]
  ])(
    'withdraws cached codec reader authority after %s.%s failure: %s',
    async (module, member, source) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          [`import ${module}`, `${module}.${member}=replacement\nraise RuntimeError()`],
          [{}, { status: 'failed', kernelDispatched: true }],
          precompute
        )
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial'
        })
        expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
      }
    }
  )

  it.each([
    ['bz2', 'BZ2File'],
    ['lzma', 'LZMAFile']
  ])('withdraws prior content proof through cached codec %s.%s', async (module, member) => {
    const prefix = `import numpy as np,${module}\nnp.save("cache.npy",np.array([1.,2.]))\n${module}.${member}=replacement\n`
    expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toHaveLength(1)
    for (const reader of ['loadtxt', 'genfromtxt'])
      expect(
        (
          await analyzePythonNotebookSource(
            prefix + `np.${reader}("pairs",delimiter=",",dtype=float,ndmin=2)`
          )
        ).facts.serializedValueWrites ?? []
      ).toEqual([])
  })

  it.each([
    ['bz2', 'BZ2File'],
    ['lzma', 'LZMAFile']
  ])('withdraws cached codec %s.%s paths and isolates epochs', async (module, member) => {
    const source =
      'from numpy import genfromtxt as read\nvalues=read("pairs",delimiter=",",dtype=float,ndmin=2)'
    for (const precompute of [false, true]) {
      const scripts = [
        `import ${module}`,
        `${module}.${member}=replacement\nraise RuntimeError()`,
        'path="old.txt"',
        source
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'epoch-2'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  })

  it.each(['bz2', 'lzma'])(
    'preserves closed literal lines under cached codec %s uncertainty',
    async (module) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: [module]
      }
      for (const reader of ['loadtxt', 'genfromtxt'])
        for (const lines of ['["1,2","3,4"]', '("1,2","3,4")'])
          expect(
            await analyzeNotebookSourceFileAccess(
              'python',
              `from numpy import ${reader} as read\nvalues=read(${lines},delimiter=",",dtype=float,ndmin=2)`,
              context
            )
          ).toMatchObject({
            readState: 'complete',
            writeState: 'complete',
            externalState: 'complete',
            reads: [],
            writes: []
          })
    }
  )

  it.each(['bz2', 'lzma'])(
    'keeps nonliteral line inputs conservative under cached codec %s uncertainty',
    async (module) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: [module]
      }
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'from numpy import loadtxt as read\nvalues=read(lines,delimiter=",",dtype=float,ndmin=2)',
          context
        )
      ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
    }
  )

  it('preserves unrelated plain IO and healthy cached codec readers', async () => {
    for (const pythonTaintedNamespaces of [[], ['zipfile']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      for (const [reader, path] of [
        ['loadtxt', 'pairs.bz2'],
        ['genfromtxt', 'pairs.xz']
      ])
        expect(
          await analyzeNotebookSourceFileAccess(
            'python',
            `from numpy import ${reader} as read\nvalues=read("${path}",delimiter=",",dtype=float,ndmin=2,converters=None)`,
            context
          )
        ).toMatchObject({ writeState: 'complete', externalState: 'complete', reads: [path] })
    }
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['bz2', 'lzma']
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import io\nwith io.open("pairs.csv") as f:\n    text=f.read()',
        context
      )
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['pairs.csv']
    })
  })

  it.each([
    'import numpy as np\narchive=np.load("samples.npz",allow_pickle=False)',
    'from numpy import load as read\narchive=read(file="renamed.npy",allow_pickle=False)',
    'import numpy as np\nnp.savez("samples.npz",x=[1,2])',
    'from numpy import savez_compressed as save\nsave("samples.npz",x=[1,2])',
    'from scipy.sparse import load_npz as read\nmatrix=read("sparse.npz")',
    'from scipy.sparse import save_npz as save\nsave("sparse.npz",matrix)',
    'from numpy import savez as save\ndef export(path):\n    return save(path,x=[1,2])\nexport("samples.npz")'
  ])('withdraws NumPy archive authority after ZipFile failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        [
          'import zipfile',
          'zipfile.ZipFile=replacement\nraise RuntimeError()',
          'path="samples.npz"'
        ],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each([
    'np.load("samples.npz",allow_pickle=False)',
    'np.savez_compressed("samples.npz",x=[1,2])'
  ])('withdraws prior array content proof through uncertain archive: %s', async (call) => {
    const prefix =
      'import numpy as np,zipfile\nnp.save("cache.npy",np.array([1.,2.]))\nzipfile.ZipFile=replacement\n'
    expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toHaveLength(1)
    expect(
      (await analyzePythonNotebookSource(prefix + call)).facts.serializedValueWrites ?? []
    ).toEqual([])
  })

  it('withdraws archive callback paths across cache reload and isolates epochs', async () => {
    const source = 'from numpy import savez_compressed as save\nsave("samples.npz",x=[1,2])'
    for (const precompute of [false, true]) {
      const scripts = [
        'import zipfile',
        'zipfile.ZipFile=replacement\nraise RuntimeError()',
        'path="old.txt"',
        source
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'epoch-2'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  })

  it('preserves healthy archives and unrelated plain NumPy writers under ZipFile uncertainty', async () => {
    for (const pythonTaintedNamespaces of [[], ['gzip']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'from numpy import savez_compressed as save\nsave("samples.npz",x=[1,2])',
          context
        )
      ).toMatchObject({
        writeState: 'complete',
        externalState: 'complete',
        writes: ['samples.npz']
      })
    }
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['zipfile']
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import numpy as np\nnp.save("plain.npy",[1,2],allow_pickle=False)',
        context
      )
    ).toMatchObject({ writeState: 'complete', externalState: 'complete', writes: ['plain.npy'] })
  })

  it.each(['loadtxt', 'genfromtxt'])(
    'preserves literal text lines under gzip uncertainty: %s',
    async (name) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: ['gzip']
      }
      for (const lines of ['["1,2","3,4"]', '("1,2","3,4")']) {
        expect(
          await analyzeNotebookSourceFileAccess(
            'python',
            `from numpy import ${name} as read\nvalues=read(${lines},delimiter=",",dtype=float,ndmin=2)`,
            context
          )
        ).toMatchObject({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete',
          reads: [],
          writes: []
        })
      }
    }
  )

  it.each([
    'import numpy as np\nvalues=np.loadtxt("groups.gz",delimiter=",",dtype=float,ndmin=2)',
    'from numpy import loadtxt as read\nvalues=read(fname="groups.csv",delimiter=",",dtype=float,ndmin=2)',
    'from numpy import genfromtxt as read\nvalues=read("groups",delimiter=",",dtype=float,ndmin=2)',
    'from numpy import genfromtxt as read\nvalues=read(fname="groups.gz",delimiter=",",dtype=float,ndmin=2)',
    'from numpy import loadtxt as read\ndef reopen(path):\n    return read(path,delimiter=",",dtype=float,ndmin=2)\nvalues=reopen("groups.gz")'
  ])('withdraws cached NumPy text-reader authority after gzip failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import gzip', 'gzip.GzipFile=replacement\nraise RuntimeError()', 'path="groups.gz"'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each(['loadtxt', 'genfromtxt'])(
    'withdraws prior array proof through cached gzip %s',
    async (name) => {
      const prefix =
        'import numpy as np,gzip\nnp.save("cache.npy",np.array([1.,2.]))\ngzip.GzipFile=replacement\n'
      expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toEqual([
        { path: 'cache.npy', format: 'npy', valueType: 'numpy.ndarray' }
      ])
      expect(
        (
          await analyzePythonNotebookSource(
            prefix + `np.${name}("groups",delimiter=",",dtype=float,ndmin=2)`
          )
        ).facts.serializedValueWrites ?? []
      ).toEqual([])
    }
  )

  it('withdraws cached gzip text-reader downstream paths and isolates fresh epochs', async () => {
    const source =
      'from numpy import genfromtxt as read\nvalues=read("groups",delimiter=",",dtype=float,ndmin=2)'
    for (const precompute of [false, true]) {
      const scripts = [
        'import gzip',
        'gzip.GzipFile=replacement\nraise RuntimeError()',
        'path="old.txt"',
        source
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'epoch-2'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  })

  it('preserves healthy NumPy text readers and unrelated io namespace precision', async () => {
    for (const pythonTaintedNamespaces of [[], ['io']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      for (const name of ['loadtxt', 'genfromtxt']) {
        const source = `from numpy import ${name} as read\nvalues=read("groups.gz",delimiter=",",dtype=float,ndmin=2,converters=None)`
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          writeState: 'complete',
          externalState: 'complete',
          reads: ['groups.gz']
        })
      }
    }
  })

  it('preserves unrelated native Matrix Market reads under cached gzip uncertainty', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    const source = 'from scipy.io import mminfo as inspect\ninfo=inspect("transition.mtx")'
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      writeState: 'complete',
      externalState: 'complete',
      reads: ['transition.mtx']
    })
    expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('available')
  })

  it.each([
    'from scipy import io as sio\nmatrix=sio.mmread("transition.mtx.gz")',
    'from scipy.io import mmread as read\nmatrix=read("transition.mtx.gz")',
    'from scipy import io as sio\ninfo=sio.mminfo(source="transition.mtx.gz")',
    'from scipy.io import mminfo as inspect\ninfo=inspect("transition.mtx.gz")',
    'from scipy.io import mmread as read\ndef reopen(path):\n    return read(path).tocsr()\nmatrix=reopen("transition.mtx.gz")'
  ])('withdraws compressed Matrix Market authority after gzip failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        [
          'import gzip',
          'gzip.GzipFile=replacement\nraise RuntimeError()',
          'path="transition.mtx.gz"'
        ],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each(['mmread', 'mminfo'])(
    'withdraws prior array proof through compressed Matrix Market %s',
    async (name) => {
      const prefix =
        'import numpy as np,gzip\nfrom scipy import io as sio\nnp.save("cache.npy",np.array([1.,2.]))\ngzip.GzipFile=replacement\n'
      expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toEqual([
        { path: 'cache.npy', format: 'npy', valueType: 'numpy.ndarray' }
      ])
      expect(
        (await analyzePythonNotebookSource(prefix + `sio.${name}("transition.mtx.gz")`)).facts
          .serializedValueWrites ?? []
      ).toEqual([])
    }
  )

  it('withdraws compressed Matrix Market downstream paths and isolates epochs', async () => {
    const source = 'from scipy.io import mmread as read\nmatrix=read("transition.mtx.gz")'
    for (const precompute of [false, true]) {
      const scripts = [
        'import gzip',
        'gzip.GzipFile=replacement\nraise RuntimeError()',
        'path="old.txt"',
        source
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'epoch-2'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete',
        reads: ['transition.mtx.gz']
      })
    }
  })

  it('preserves literal native Matrix Market paths under gzip uncertainty', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    for (const name of ['mmread', 'mminfo']) {
      const source = `from scipy.io import ${name} as read\nvalue=read("transition.mtx")`
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete',
        reads: ['transition.mtx']
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('available')
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `from scipy.io import ${name} as read\nvalue=read(path)`,
          context
        )
      ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
    }
  })

  it.each([
    'from scipy.io import mminfo as inspect\ninfo=inspect("transition.mtx")',
    'from scipy import io as sio\ninfo=sio.mminfo(source="transition.mtx")',
    'from scipy.io import mminfo\ndef inspect(path):\n    return mminfo(path)\ninfo=inspect("transition.mtx")'
  ])('records Matrix Market metadata inputs: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
      'transition.mtx'
    ])
  })

  it('rejects ambiguous metadata reader signatures and shadowed identities', async () => {
    for (const source of [
      'from scipy.io import mminfo\nmminfo("transition.mtx",source="other.mtx")',
      'from scipy.io import mminfo\nmminfo("transition.mtx",**options)'
    ])
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        readState: 'partial'
      })
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'python',
          'def mminfo(path):\n    return 1\nmminfo("transition.mtx")'
        )
      ).reads
    ).not.toContain('transition.mtx')
  })

  it.each([
    'import numpy as np\nvalues=np.memmap("matrix.bin",dtype="float64",mode="r",shape=(64,2))',
    'from numpy import memmap as mapping\nvalues=mapping("matrix.bin",dtype="float64",mode="c",shape=(64,2))',
    'import numpy as np\nvalues=np.memmap("matrix.bin",dtype="float64",mode="r+",shape=(64,2))',
    'import numpy as np\nvalues=np.memmap("matrix.bin",dtype="float64",mode="w+",shape=(64,2))',
    'from numpy.lib.format import open_memmap as mapping\nvalues=mapping("matrix.npy",mode="r")',
    'from numpy.lib.format import open_memmap as mapping\nvalues=mapping("matrix.npy",mode="c")',
    'from numpy import memmap as mapping\ndef reopen(path):\n    return mapping(path,dtype="float64",mode="r",shape=(64,2))\nvalues=reopen("matrix.bin")'
  ])('withdraws mapped-file authority after builtin opener failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import builtins', 'builtins.open=replacement\nraise RuntimeError()', 'path="matrix.bin"'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each([
    'np.memmap("matrix.bin",dtype="float64",mode="c",shape=(64,2))',
    'np.lib.format.open_memmap("matrix.npy",mode="r")'
  ])('withdraws prior array proof through mapped-file opener callbacks: %s', async (call) => {
    const prefix =
      'import numpy as np,builtins\n' +
      'np.save("cache.npy",np.array([1.,2.]))\nbuiltins.open=replacement\n'
    expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toEqual([
      { path: 'cache.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
    expect(
      (await analyzePythonNotebookSource(prefix + call)).facts.serializedValueWrites ?? []
    ).toEqual([])
  })

  it('withdraws downstream mapped-file paths and isolates fresh epochs', async () => {
    const source =
      'from numpy.lib.format import open_memmap as mapping\nvalues=mapping("matrix.npy",mode="c")'
    for (const precompute of [false, true]) {
      const scripts = [
        'import builtins',
        'builtins.open=replacement\nraise RuntimeError()',
        'path="old.txt"',
        source
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'epoch-2'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete'
      })
      expect((await analyzePythonNotebookSource(source, fresh)).facts.state).toBe('available')
    }
  })

  it('preserves private mappings under healthy or unrelated io openers', async () => {
    for (const pythonTaintedNamespaces of [[], ['io']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      for (const source of [
        'from numpy import memmap as mapping\nvalues=mapping("matrix.bin",dtype="float64",mode="c",shape=(64,2))\nvalues[0,0]=1\nvalues.flush()',
        'from numpy.lib.format import open_memmap as mapping\nvalues=mapping("matrix.npy",mode="r")'
      ]) {
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          writeState: 'complete',
          externalState: 'complete',
          writes: []
        })
      }
    }
  })

  it.each([
    'from scipy.io import wavfile\nrate,data=wavfile.read("signal.wav")',
    'from scipy.io.wavfile import read as read_signal\nrate,data=read_signal("signal.wav")',
    'from scipy.io import wavfile\nwavfile.write("signal.wav",8000,data)',
    'from scipy.io.wavfile import write as store_signal\nstore_signal("signal.wav",8000,data)',
    'from scipy.io.wavfile import write as store_signal\ndef export(path):\n    store_signal(path,8000,data)\nexport("signal.wav")'
  ])('withdraws WAV authority after builtin opener failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import builtins', 'builtins.open=replacement\nraise RuntimeError()', 'path="signal.wav"'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each(['wavfile.read("signal.wav")', 'wavfile.write("signal.wav",8000,data)'])(
    'withdraws prior array content proof through WAV opener delegates: %s',
    async (call) => {
      const prefix =
        'import numpy as np,builtins\nfrom scipy.io import wavfile\n' +
        'np.save("cache.npy",np.array([1.,2.]))\nbuiltins.open=replacement\n'
      expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toEqual([
        { path: 'cache.npy', format: 'npy', valueType: 'numpy.ndarray' }
      ])
      expect(
        (await analyzePythonNotebookSource(prefix + call)).facts.serializedValueWrites ?? []
      ).toEqual([])
    }
  )

  it('withdraws downstream WAV paths and isolates fresh epochs', async () => {
    const source =
      'from scipy.io.wavfile import read as read_signal\nrate,data=read_signal("signal.wav")'
    for (const precompute of [false, true]) {
      const scripts = [
        'import builtins',
        'builtins.open=replacement\nraise RuntimeError()',
        'path="old.txt"',
        source
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'epoch-2'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete'
      })
      expect((await analyzePythonNotebookSource(source, fresh)).facts.state).toBe('available')
    }
  })

  it('preserves WAV contracts under unrelated io namespace uncertainty', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['io']
    }
    for (const source of [
      'from scipy.io.wavfile import read\nrate,data=read("signal.wav")',
      'from scipy.io.wavfile import write\nwrite("signal.wav",8000,data)'
    ]) {
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('available')
    }
  })

  it.each([
    'from scipy import sparse\nmatrix=sparse.load_npz("poisson.npz")',
    'from scipy.sparse import load_npz as read\nmatrix=read("poisson.npz")',
    'from scipy import sparse\nsparse.save_npz("poisson.npz",matrix)',
    'from scipy.sparse import save_npz as store\nstore("poisson.npz",matrix,compressed=False)',
    'from scipy.sparse import save_npz as store\ndef export(path):\n    store(path,matrix)\nexport("poisson.npz")'
  ])('withdraws sparse NPZ authority after failed NumPy replacement: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import numpy as np', 'np.load=replacement\nraise RuntimeError()', 'path="poisson.npz"'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.pythonTaintedNamespaces).toContain('numpy')
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each(['sparse.load_npz("poisson.npz")', 'sparse.save_npz("poisson.npz",matrix)'])(
    'withdraws stored array proof through replaced NumPy delegates: %s',
    async (call) => {
      const prefix =
        'import numpy as np\nfrom scipy import sparse\n' +
        'np.save("cache.npy",np.array([1.,2.]))\nnp.load=replacement\n'
      expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toEqual([
        { path: 'cache.npy', format: 'npy', valueType: 'numpy.ndarray' }
      ])
      expect(
        (await analyzePythonNotebookSource(prefix + call)).facts.serializedValueWrites ?? []
      ).toEqual([])
    }
  )

  it('withdraws downstream paths through NumPy delegates and isolates fresh epochs', async () => {
    const source = 'from scipy.sparse import load_npz as read\nmatrix=read("poisson.npz")'
    for (const precompute of [false, true]) {
      const scripts = [
        'import numpy as np',
        'np.load=replacement\nraise RuntimeError()',
        'path="old.txt"',
        source
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'epoch-2'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete'
      })
      expect((await analyzePythonNotebookSource(source, fresh)).facts.state).toBe('available')
    }
  })

  it('preserves unrelated SciPy contracts under NumPy namespace uncertainty', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['numpy']
    }
    const source = 'from scipy.io import whosmat\nmetadata=whosmat("model.mat")'
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      writeState: 'complete',
      externalState: 'complete'
    })
    expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('available')
  })

  it.each([
    ['io', 'from scipy import sparse\nsparse.save_npz("chain.npz",matrix)'],
    ['io', 'from scipy.sparse import save_npz as store\nstore("chain.npz",matrix)'],
    [
      'io',
      'from scipy import sparse\ndef export(path):\n    sparse.save_npz(path,matrix)\nexport("chain.npz")'
    ],
    ['builtins', 'from scipy import sparse\nmatrix=sparse.load_npz("chain.npz")'],
    ['builtins', 'from scipy.sparse import load_npz as read\nmatrix=read("chain.npz")']
  ])(
    'withdraws sparse graph NPZ authority after %s opener failure: %s',
    async (namespace, source) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          [
            `import ${namespace}`,
            `${namespace}.open=replacement\nraise RuntimeError()`,
            'path="chain.npz"'
          ],
          [{}, { status: 'failed', kernelDispatched: true }],
          precompute
        )
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial'
        })
        expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
      }
    }
  )

  it.each([
    ['io', 'sparse.save_npz("chain.npz",matrix)'],
    ['builtins', 'sparse.load_npz("chain.npz")']
  ])('withdraws old content proof through sparse graph %s delegates', async (namespace, call) => {
    const prefix =
      `import numpy as np,${namespace}\nfrom scipy import sparse\n` +
      'np.save("cache.npy",np.array([1.,2.]))\n' +
      `${namespace}.open=replacement\n`
    expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toEqual([
      { path: 'cache.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
    expect(
      (await analyzePythonNotebookSource(prefix + call)).facts.serializedValueWrites ?? []
    ).toEqual([])
  })

  it('preserves sparse graph contracts under unrelated opener uncertainty', async () => {
    for (const [source, namespace] of [
      ['from scipy.sparse import save_npz as store\nstore("chain.npz",matrix)', 'builtins'],
      ['from scipy.sparse import load_npz as read\nmatrix=read("chain.npz")', 'io']
    ]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: [namespace!]
      }
      expect(await analyzeNotebookSourceFileAccess('python', source!, context)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete'
      })
      expect((await analyzePythonNotebookSource(source!, context)).facts.state).toBe('available')
    }
  })

  it('withdraws downstream paths after tainted sparse graph loading', async () => {
    for (const precompute of [false, true]) {
      const scripts = [
        'import builtins',
        'builtins.open=replacement\nraise RuntimeError()',
        'path="old.txt"',
        'from scipy.sparse import load_npz as read\nmatrix=read("chain.npz")'
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'epoch-2'
      )
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'from scipy.sparse import load_npz as read\nmatrix=read("chain.npz")',
          fresh
        )
      ).toMatchObject({ writeState: 'complete', externalState: 'complete' })
    }
  })

  it.each([
    'from scipy import io as sio\nmodel=sio.loadmat("pca.mat")',
    'from scipy.io import loadmat as read_model\nmodel=read_model("pca.mat")',
    'from scipy import io as sio\nsio.savemat("pca.mat",{"v":[1.,2.]},format="4")',
    'from scipy.io import savemat as write_model\nwrite_model("pca.mat",{"v":[1.,2.]},format="4")',
    'from scipy.io import whosmat as inspect_model\nmetadata=inspect_model("pca.mat")',
    'from scipy import io as sio\ndef export(path):\n    sio.savemat(path,{"v":[1.,2.]},format="4")\nexport("pca.mat")'
  ])('withdraws PCA MAT call authority after builtin opener failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import builtins', 'builtins.open=replacement\nraise RuntimeError()', 'path="pca.mat"'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each(['loadmat("pca.mat")', 'whosmat("pca.mat")', 'savemat("pca.mat",{"v":[1.,2.]})'])(
    'withdraws downstream content proof through a tainted PCA MAT %s',
    async (call) => {
      const prefix =
        'import numpy as np,builtins\nfrom scipy import io as sio\n' +
        'np.save("cache.npy",np.array([1.,2.]))\nbuiltins.open=replacement\n'
      expect((await analyzePythonNotebookSource(prefix)).facts.serializedValueWrites).toEqual([
        { path: 'cache.npy', format: 'npy', valueType: 'numpy.ndarray' }
      ])
      const source = prefix + `sio.${call}\n`
      const facts = (await analyzePythonNotebookSource(source)).facts
      expect(facts.serializedValueWrites ?? []).toEqual([])
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('preserves intact PCA MAT calls with unrelated io taint and fresh epochs', async () => {
    for (const pythonTaintedNamespaces of [[], ['io']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      for (const source of [
        'from scipy.io import loadmat as read_model\nmodel=read_model("pca.mat")',
        'from scipy.io import whosmat as inspect_model\nmetadata=inspect_model("pca.mat")',
        'from scipy.io import savemat as write_model\nwrite_model("pca.mat",{"v":[1.,2.]},format="4")'
      ])
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete'
        })
    }
    const fresh = await fileContext(
      'python',
      ['import builtins', 'builtins.open=replacement\nraise RuntimeError()'],
      [{}, { status: 'failed', kernelDispatched: true }],
      true,
      undefined,
      'epoch-2'
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from scipy.io import savemat as write_model\nwrite_model("pca.mat",{"v":[1.,2.]},format="4")',
        fresh
      )
    ).toMatchObject({ writeState: 'complete', externalState: 'complete' })
  })

  it('withdraws downstream paths after a tainted PCA MAT metadata read', async () => {
    for (const precompute of [false, true]) {
      const scripts = [
        'import builtins',
        'builtins.open=replacement\nraise RuntimeError()',
        'path="old.txt"',
        'from scipy.io import whosmat as inspect_model\nmetadata=inspect_model("pca.mat")'
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const recovered = await fileContext(
        'python',
        [...scripts, 'path="fresh.txt"'],
        overrides,
        precompute
      )
      expect(
        await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', recovered)
      ).toMatchObject({ reads: ['fresh.txt'], readState: 'complete' })
    }
  })

  it.each([
    ['import io,builtins', 'builtins.open', 'io.open'],
    ['import io as stream,builtins as native', 'native.open', 'stream.open']
  ])(
    'retains opener mutation after a literal builtin-file recovery: %s',
    async (imports, open, patch) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          [
            `${imports}\nwith ${open}("missing.csv") as handle:\n    pass`,
            `${imports}\nwith ${open}("input.csv",encoding="utf-8") as handle:\n    pass`,
            `${patch}=replacement\nraise RuntimeError()`,
            'path="bootstrap.npz"'
          ],
          [
            { status: 'failed', kernelDispatched: true },
            {},
            { status: 'failed', kernelDispatched: true }
          ],
          precompute
        )
        expect(context?.pythonTaintedNamespaces).toContain('io')
        expect(
          await analyzeNotebookSourceFileAccess(
            'python',
            'import numpy as np\nnp.savez("bootstrap.npz",means=[1.,2.])',
            context
          )
        ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
      }
    }
  )

  it.each([
    'import builtins\nwith builtins.open("input.csv",encoding="utf-8") as handle:\n    pass',
    'import builtins as native\nwith native.open(file="output.txt",mode="w",opener=None) as handle:\n    pass'
  ])(
    'keeps closed literal builtin file calls external instead of namespace mutation: %s',
    async (source) => {
      const { facts } = await analyzePythonNotebookSource(source)
      expect(facts).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['external-state'])
      })
      expect(facts.state === 'unknown' ? facts.reasons : []).not.toContain('dynamic-namespace')
    }
  )

  it.each([
    'import builtins\nbuiltins.open(path)',
    'import builtins\nbuiltins.open("input.csv",**options)',
    'import builtins\nbuiltins.open=replacement\nbuiltins.open("input.csv")',
    'import builtins\nbuiltins=replacement\nbuiltins.open("input.csv")'
  ])('retains namespace uncertainty for unproved builtin file calls: %s', async (source) => {
    expect((await analyzePythonNotebookSource(source)).facts.state).toBe('unknown')
  })

  it.each([
    'import numpy as np\nnp.savez("bootstrap.npz",means=np.array([1.,2.]))',
    'import numpy as np\nnp.savez_compressed("bootstrap.npz",means=np.array([1.,2.]))',
    'from numpy import savez as pack\npack("bootstrap.npz",means=[1.,2.])',
    'from numpy import savez_compressed as pack\npack("bootstrap.npz",means=[1.,2.])',
    'import numpy as np\ndef export(path):\n    np.savez(path,means=[1.,2.])\nexport("bootstrap.npz")'
  ])('withdraws bootstrap archive authority after io opener failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import io', 'io.open=replacement\nraise RuntimeError()', 'path="fresh.txt"'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it.each(['savez', 'savez_compressed'])(
    'withdraws serialized content proof through a tainted bootstrap %s call',
    async (member) => {
      const context = await fileContext(
        'python',
        ['import io', 'io.open=replacement\nraise RuntimeError()'],
        [{}, { status: 'failed', kernelDispatched: true }]
      )
      const source =
        'import numpy as np\nnp.save("cache.npy",np.array([1.,2.]))\n' +
        `np.${member}("bootstrap.npz",means=[1.,2.])\nafter=np.load("cache.npy",allow_pickle=False)`
      const { facts } = await analyzePythonNotebookSource(source, context)
      expect(facts.serializedValueWrites ?? []).toEqual([])
      expect(facts.typeBindings ?? []).not.toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        reads: ['cache.npy'],
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('preserves intact bootstrap archive writers under unrelated builtin taint', async () => {
    for (const pythonTaintedNamespaces of [[], ['builtins']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      for (const member of ['savez', 'savez_compressed']) {
        const source = `import numpy as np\nnp.${member}("bootstrap.npz",means=[1.,2.])`
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          writes: ['bootstrap.npz'],
          writeState: 'complete',
          externalState: 'complete'
        })
        expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('available')
      }
    }
  })

  it('withdraws downstream paths through a tainted bootstrap archive export', async () => {
    for (const precompute of [false, true]) {
      const scripts = [
        'import io',
        'io.open=replacement\nraise RuntimeError()',
        'path="old.txt"',
        'import numpy as np\nnp.savez("bootstrap.npz",means=[1.,2.])'
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'open(path)', context)).reads
      ).not.toContain('old.txt')
      const recovered = await fileContext(
        'python',
        [...scripts, 'path="fresh.txt"'],
        overrides,
        precompute
      )
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'open(path)', recovered)).reads
      ).toEqual(['fresh.txt'])
    }
  })

  it('clears bootstrap opener uncertainty only for a fresh kernel epoch', async () => {
    const context = await fileContext(
      'python',
      ['import io', 'io.open=replacement\nraise RuntimeError()'],
      [{}, { status: 'failed', kernelDispatched: true }],
      true,
      undefined,
      'epoch-2'
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from numpy import savez_compressed as pack\npack("bootstrap.npz",means=[1.,2.])',
        context
      )
    ).toMatchObject({
      writes: ['bootstrap.npz'],
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'import numpy as np\nnp.savetxt("spectrum.txt",np.array([1.,2.]))',
    'from numpy import savetxt as emit\nemit("spectrum.txt",[1.,2.])',
    'import numpy as np\ndef export(path):\n    np.savetxt(path,[1.,2.])\nexport("spectrum.txt")'
  ])('withdraws NumPy spectral text writer authority after opener failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import builtins', 'builtins.open=replacement\nraise RuntimeError()', 'path="fresh.txt"'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining([
          source.includes('def export') ? 'external-state' : 'opaque-call'
        ])
      })
    }
  })

  it('revokes same-cell spectral text writer authority after opener mutation', async () => {
    const source =
      'import numpy as np,builtins\nbuiltins.open=replacement\nnp.savetxt("spectrum.txt",[1.,2.])'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('withdraws downstream path authority after a tainted spectral export', async () => {
    for (const precompute of [false, true]) {
      const scripts = [
        'import builtins',
        'builtins.open=replacement\nraise RuntimeError()',
        'path="old.txt"',
        'import numpy as np\nnp.savetxt("spectrum.txt",[1.,2.])'
      ]
      const context = await fileContext(
        'python',
        scripts,
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', context)).reads
      ).not.toContain('old.txt')
      const recovered = await fileContext(
        'python',
        [...scripts, 'path="fresh.txt"'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(
        await analyzeNotebookSourceFileAccess('python', 'import io\nio.open(path)', recovered)
      ).toMatchObject({ reads: ['fresh.txt'], readState: 'complete' })
    }
  })

  it('preserves intact spectral writers and independent io handles', async () => {
    for (const pythonTaintedNamespaces of [[], ['io']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      const source = 'from numpy import savetxt as emit\nemit("spectrum.txt",[1.,2.])'
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        writeState: 'complete',
        writes: ['spectrum.txt'],
        externalState: 'complete'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('available')
    }
    const context = await fileContext(
      'python',
      ['import builtins', 'builtins.open=replacement\nraise RuntimeError()'],
      [{}, { status: 'failed', kernelDispatched: true }]
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import io\nwith io.open("summary.txt","w") as handle:\n    handle.write("validated")',
        context
      )
    ).toMatchObject({ writeState: 'complete', writes: ['summary.txt'] })
    const fresh = await fileContext(
      'python',
      ['import builtins', 'builtins.open=replacement\nraise RuntimeError()'],
      [{}, { status: 'failed', kernelDispatched: true }],
      true,
      undefined,
      'epoch-2'
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import numpy as np\nnp.savetxt("spectrum.txt",[1.,2.])',
        fresh
      )
    ).toMatchObject({ writeState: 'complete', externalState: 'complete' })
  })

  it.each([
    'import numpy as np\ncoef=np.load("coef.npy",allow_pickle=False)',
    'from numpy import load as reader\ncoef=reader("coef.npy",allow_pickle=False)',
    'import numpy as np\nnp.save("coef.npy",np.array([1.,2.]),allow_pickle=False)',
    'from numpy import save as writer\nimport numpy as np\nwriter("coef.npy",np.array([1.,2.]),allow_pickle=False)'
  ])('withdraws NumPy model-file authority after a failed opener patch: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        [
          'import builtins',
          'builtins.open=replacement\nraise RuntimeError("failed")',
          'path="coef.npy"'
        ],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        writeState: 'partial',
        externalState: 'partial'
      })
      const { facts } = await analyzePythonNotebookSource(source, context)
      expect(facts).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['opaque-call'])
      })
      expect(facts.serializedValueWrites ?? []).toEqual([])
      expect(facts.serializedValueReads ?? []).not.toContain('coef.npy')
      expect(facts.typeBindings ?? []).not.toContainEqual(
        expect.objectContaining({ target: 'coef', typeName: 'numpy.ndarray' })
      )
    }
  })

  it.each(['load', 'save'])(
    'revokes same-cell NumPy %s authority after builtin opener mutation',
    async (member) => {
      const source =
        'import builtins,numpy as np\nbuiltins.open=replacement\n' +
        (member === 'load'
          ? 'coef=np.load("coef.npy",allow_pickle=False)'
          : 'np.save("coef.npy",np.array([1.,2.]),allow_pickle=False)')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        writeState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual(
        []
      )
    }
  )

  it('preserves intact NumPy model-file contracts under unrelated io taint', async () => {
    for (const pythonTaintedNamespaces of [[], ['io']]) {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces
      }
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import numpy as np\ncoef=np.load("coef.npy",allow_pickle=False)',
          context
        )
      ).toMatchObject({ readState: 'complete', writeState: 'complete', reads: ['coef.npy'] })
      const source = 'import numpy as np\nnp.save("coef.npy",np.array([1.,2.]),allow_pickle=False)'
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        writeState: 'complete',
        writes: ['coef.npy']
      })
      expect(
        (await analyzePythonNotebookSource(source, context)).facts.serializedValueWrites
      ).toEqual([{ path: 'coef.npy', format: 'npy', valueType: 'numpy.ndarray' }])
    }
  })

  it.each(['allow_pickle=True', 'allow_pickle=setting', '**options'])(
    'keeps unproved NumPy pickle options conservative: %s',
    async (options) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import numpy as np\ncoef=np.load("coef.npy",' + options + ')'
        )
      ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
    }
  )

  it.each([
    'base::lapply(base::list(masked),enable_mask)',
    'lapply(list(masked),function(x) base::attach(x))',
    'lapply(X=list(masked),FUN=enable_mask)',
    'sapply(list(masked),enable_mask)',
    'lapply(list(masked),base::attach)',
    'lapply(list(masked),function(x) base::detach("mask"))'
  ])('retains immediate R callback search-path effects after failure: %s', async (call) => {
    for (const failed of [false, true])
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'r',
          [
            'enable_mask<-function(x) base::attach(x)',
            call + (failed ? ';stop("failed")' : ''),
            'path<-"recovered.txt"'
          ],
          [{}, { status: failed ? 'failed' : 'completed', kernelDispatched: true }],
          precompute
        )
        expect(context?.rSearchPathUncertain).toBe(true)
        expect(
          await analyzeNotebookSourceFileAccess(
            'r',
            'resolved<-file.path("outputs","claimed.txt")',
            context
          )
        ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
        const prior = await fileContext('r', ['enable_mask<-function(x) base::attach(x)'])
        const facts = (await analyzeRNotebookSource(call, prior)).facts
        expect(facts).toMatchObject({
          state: 'unknown',
          reasons: expect.arrayContaining(['opaque-call', 'dynamic-namespace'])
        })
        expect(facts.safeCallNames ?? []).not.toContain(
          call.startsWith('base::')
            ? 'base::lapply'
            : call.startsWith('sapply')
              ? 'sapply'
              : 'lapply'
        )
      }
  })

  it.each([
    'ggplot2::geom_point(data=enable_mask)',
    'ggplot2::scale_x_continuous(labels=enable_mask)',
    'saved<-function(x) base::attach(x)',
    'lapply(list(masked),function(x) quote(base::attach(x)))',
    'lapply<-function(...) NULL;lapply(list(masked),enable_mask)'
  ])('does not invent immediate R callback invocation: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'r',
        ['enable_mask<-function(x) base::attach(x)', source, 'path<-"out.txt"'],
        [],
        precompute
      )
      expect(context?.rSearchPathUncertain).toBeUndefined()
      expect(
        await analyzeNotebookSourceFileAccess('r', 'writeLines("value",path)', context)
      ).toMatchObject({ writeState: 'complete', writes: ['out.txt'] })
    }
  })

  it.each([
    'enable_mask<-function(x) base::attach(x)',
    'enable_mask<-function(x) {attach(x);invisible(NULL)}',
    'enable_mask<-function(x) {attach(x);attach<-identity}',
    'enable_mask<-function(x) base::detach("mask")',
    'original<-function(x) base::attach(x);enable_mask<-original',
    'enable_mask<-base::attach',
    'enable_mask<-attach',
    'enable_mask<-base::detach',
    'original<-base::attach;enable_mask<-original'
  ])('retains invoked R search-path helper effects after failure: %s', async (definition) => {
    for (const failed of [false, true])
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'r',
          [
            'masked<-list(file.path=function(...) "actual.txt");' + definition,
            'enable_mask(masked)' + (failed ? ';stop("failed")' : ''),
            'path<-"recovered.txt"'
          ],
          [{}, { status: failed ? 'failed' : 'completed', kernelDispatched: true }],
          precompute
        )
        expect(context?.rSearchPathUncertain).toBe(true)
        const source = 'target<-file.path("outputs","claimed.txt")'
        expect((await analyzeRNotebookSource(source, context)).facts).toMatchObject({
          state: 'unknown',
          reasons: expect.arrayContaining(['opaque-call'])
        })
        expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial'
        })
        expect(
          await analyzeNotebookSourceFileAccess(
            'r',
            'base::writeLines("value","qualified.txt")',
            context
          )
        ).toMatchObject({ writeState: 'complete', writes: ['qualified.txt'] })
      }
  })

  it.each([
    'saved<-base::attach',
    'saved<-base::detach',
    'saved<-attach',
    'saved<-function() base::attach(masked)',
    'saved<-function() quote(base::attach(masked));saved()',
    'saved<-function() function() base::attach(masked);saved()'
  ])('keeps unexecuted R search-path references inert: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext('r', [source, 'path<-"recovered.txt"'], [], precompute)
      expect(context?.rSearchPathUncertain).toBeUndefined()
      expect(
        await analyzeNotebookSourceFileAccess('r', 'writeLines("value",path)', context)
      ).toMatchObject({ writeState: 'complete', writes: ['recovered.txt'] })
    }
  })

  it.each([
    'enable_mask<-function(x) base::attach(x)',
    'original<-function(x) base::attach(x);enable_mask<-original',
    'enable_mask<-base::attach'
  ])(
    'retains only negative R search-path helper evidence across an opaque definition: %s',
    async (definition) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'r',
          [
            definition + ';invisible(stats::t.test(1:5))',
            'enable_mask(masked);stop("failed")',
            'path<-"recovered.txt"'
          ],
          [{}, { status: 'failed', kernelDispatched: true }],
          precompute
        )
        expect(context?.rSearchPathUncertain).toBe(true)
        expect(
          await analyzeNotebookSourceFileAccess(
            'r',
            'resolved<-file.path("outputs","claimed.txt")',
            context
          )
        ).toMatchObject({ writeState: 'partial' })
        const dormant = await fileContext(
          'r',
          [definition + ';invisible(stats::t.test(1:5))'],
          [],
          precompute
        )
        expect(dormant?.rSearchPathUncertain).toBeUndefined()
        for (const { summary } of dormant?.rFunctions ?? []) {
          expect(summary.methods).toEqual([
            {
              name: '__call__',
              effect: 'unknown',
              unknownScope: 'namespace',
              usedNames: ['base::attach']
            }
          ])
        }
      }
    }
  )

  it.each(['attach(masked)', 'base::attach(masked)', 'detach("mask")', 'base::detach("mask")'])(
    'retains R search-path uncertainty across failure and recovery: %s',
    async (call) => {
      for (const failed of [false, true]) {
        for (const precompute of [false, true]) {
          const context = await fileContext(
            'r',
            [
              'masked<-list(file.path=function(...) "actual.txt")',
              call + (failed ? ';stop("failed")' : ''),
              'path<-"recovered.txt"'
            ],
            [{}, { status: failed ? 'failed' : 'completed', kernelDispatched: true }],
            precompute,
            precompute
              ? (cache) => {
                  expect(cache).not.toContain('rSearchPathUncertain')
                  return cache
                }
              : undefined
          )
          expect(context).toMatchObject({ rSearchPathUncertain: true })
          const source = 'writeLines("value",file.path("outputs","claimed.txt"))'
          const io = await analyzeNotebookSourceFileAccess('r', source, context)
          expect(io).toMatchObject({
            readState: 'partial',
            writeState: 'partial',
            externalState: 'partial'
          })
          expect(io.writes).not.toContain('outputs/claimed.txt')
          expect(
            (
              await analyzeRNotebookSource(
                'resolved_path<-file.path("outputs","claimed.txt")',
                context
              )
            ).facts
          ).toMatchObject({
            state: 'unknown',
            reasons: expect.arrayContaining(['opaque-call'])
          })
          expect(
            await analyzeNotebookSourceFileAccess(
              'r',
              'base::writeLines("value","qualified.txt")',
              context
            )
          ).toMatchObject({
            writeState: 'complete',
            writes: ['qualified.txt']
          })
        }
      }
    }
  )

  it('keeps R search-path uncertainty without any surviving binding', async () => {
    const context = await fileContext(
      'r',
      ['base::attach(list())', 'stop("failed")'],
      [{}, { status: 'failed', kernelDispatched: true }]
    )
    expect(context).toMatchObject({ rSearchPathUncertain: true })
    expect(
      await analyzeNotebookSourceFileAccess('r', 'writeLines("value","out.txt")', context)
    ).toMatchObject({ writeState: 'partial' })
  })

  it.each([
    {
      source: 'base::attach(masked)',
      overrides: [{ status: 'failed' as const, kernelDispatched: false }],
      epoch: 'epoch-1'
    },
    { source: 'base::attach(masked)', overrides: [{ kernelDispatched: true }], epoch: 'epoch-2' },
    { source: 'f<-function() base::attach(masked)', overrides: [], epoch: 'epoch-1' },
    { source: 'x<-attach', overrides: [], epoch: 'epoch-1' }
  ])(
    'does not invent R search-path changes for $source ($epoch)',
    async ({ source, overrides, epoch }) => {
      const context = await fileContext('r', [source], overrides, true, undefined, epoch)
      expect(context?.rSearchPathUncertain).toBeUndefined()
      expect(
        await analyzeNotebookSourceFileAccess('r', 'base::writeLines("value","out.txt")', context)
      ).toMatchObject({ writeState: 'complete', writes: ['out.txt'] })
    }
  )

  it.each([
    'import pandas as pd\nframe=pd.read_csv("in.csv")',
    'from pandas import read_csv as read\nframe=read("in.csv")',
    'import pandas as pd\nframe=pd.read_table("in.csv",sep=",")',
    'from pandas import read_table as read\nframe=read("in.csv",sep=",")'
  ])('does not trust pandas readers after a failed builtin opener patch: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import builtins', 'builtins.open=replacement\nraise RuntimeError("failed")'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const { facts } = await analyzePythonNotebookSource(source, context)
      expect(facts).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['opaque-call'])
      })
      expect(facts.typeBindings ?? []).not.toContainEqual(
        expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' })
      )
    }
  })

  it('does not retain pandas effects after a same-cell builtin opener mutation', async () => {
    const source =
      'import builtins,pandas as pd\nbuiltins.open=replacement\nframe=pd.read_csv("in.csv")'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writeState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('preserves intact local CSV reader contracts', async () => {
    for (const taints of [[], ['io']])
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import pandas as pd\nframe=pd.read_csv("in.csv")',
          {
            staticStrings: [],
            staticCollections: [],
            localFileWrappers: [],
            pythonTaintedNamespaces: taints
          }
        )
      ).toMatchObject({ reads: ['in.csv'], writeState: 'complete' })
  })

  it.each([
    [
      'builtins',
      'builtins.open=replacement',
      'import lzma\nwith lzma.open("in.csv.xz","rt") as handle:\n    content=handle.read()'
    ],
    [
      'builtins',
      'builtins.open=replacement',
      'from lzma import open as reader\nwith reader("in.csv.xz","rt") as handle:\n    content=handle.read()'
    ],
    [
      'io',
      'io.open=replacement',
      'import zipfile\nwith zipfile.ZipFile("in.zip","r") as archive:\n    content=archive.read("faithful.csv")'
    ],
    [
      'io',
      'io.open=replacement',
      'from zipfile import ZipFile as Archive\nwith Archive("in.zip","r") as archive:\n    content=archive.read("faithful.csv")'
    ]
  ])(
    'keeps archive effects opaque after failed %s mutation: %s (%s)',
    async (module, patch, source) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          ['import ' + module, patch + '\nraise RuntimeError("failed")'],
          [{}, { status: 'failed', kernelDispatched: true }],
          precompute
        )
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial'
        })
        expect((await analyzePythonNotebookSource(source, context)).facts).toMatchObject({
          state: 'unknown',
          reasons: expect.arrayContaining(['opaque-call'])
        })
      }
    }
  )

  it('revokes saved value proof across a ZIP factory using a patched io opener', async () => {
    const { facts } = await analyzePythonNotebookSource(
      'import numpy as np,zipfile\nnp.save("cache.npy",np.array([1,2]))\narchive=zipfile.ZipFile("in.zip","r")\nafter=np.load("cache.npy")',
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: ['io']
      }
    )
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })

  it('keeps intact archive filename contracts and unrelated opener identities separate', async () => {
    for (const taints of [[], ['io']])
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import lzma\nwith lzma.open("in.csv.xz","rt") as handle:\n    content=handle.read()',
          {
            staticStrings: [],
            staticCollections: [],
            localFileWrappers: [],
            pythonTaintedNamespaces: taints
          }
        )
      ).toMatchObject({ reads: ['in.csv.xz'], writeState: 'complete' })
    for (const taints of [[], ['builtins']])
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import zipfile\narchive=zipfile.ZipFile("in.zip","r")',
          {
            staticStrings: [],
            staticCollections: [],
            localFileWrappers: [],
            pythonTaintedNamespaces: taints
          }
        )
      ).toMatchObject({ reads: ['in.zip'], writeState: 'complete' })
  })

  it.each([
    'import shutil\nshutil.copyfile("in.csv","out.csv")',
    'from shutil import copyfile as copy\ncopy("in.csv","out.csv")',
    'import shutil\nshutil.copy("in.csv","out.csv")',
    'from shutil import copy2 as copy\ncopy("in.csv","out.csv")'
  ])('keeps copy effects opaque after a failed builtin opener patch: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import builtins,shutil', 'builtins.open=replacement\nraise RuntimeError("failed")'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const { facts } = await analyzePythonNotebookSource(source, context)
      expect(facts).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['opaque-call'])
      })
    }
  })

  it('revokes copied value proof through a patched builtin copy opener', async () => {
    const { facts } = await analyzePythonNotebookSource(
      'import numpy as np,shutil\nnp.save("cache.npy",np.array([1,2]))\nshutil.copyfile("cache.npy","copy.npy")\nafter=np.load("copy.npy")',
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: ['builtins']
      }
    )
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })

  it('keeps intact copyfile and freshly imported io.open contracts independent', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['builtins']
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import io\nwith io.open("out.txt","w") as handle:\n    handle.write("value")',
        context
      )
    ).toMatchObject({ writes: ['out.txt'], writeState: 'complete' })
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import shutil\nshutil.copyfile("in.csv","out.csv")'
      )
    ).toMatchObject({ reads: ['in.csv'], writes: ['out.csv'], writeState: 'complete' })
  })

  it.each([
    'import gzip\nwith gzip.open("in.csv.gz","rt") as handle:\n    content=handle.read()',
    'import gzip\nwith gzip.open("out.csv.gz","wt") as handle:\n    handle.write("value")',
    'from gzip import open as compressed_open\nwith compressed_open("in.csv.gz","rt") as handle:\n    content=handle.read()',
    'import gzip\nhandle=gzip.open("in.csv.gz","rt")\ncontent=handle.read()'
  ])('does not trust gzip IO after a failed builtin opener patch: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import builtins,gzip', 'builtins.open=replacement\nraise RuntimeError("failed")'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.pythonTaintedNamespaces).toContain('builtins')
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    }
  })

  it('revokes serialized proof across gzip delegated to a replaced builtin opener', async () => {
    const { facts } = await analyzePythonNotebookSource(
      'import numpy as np,gzip\nnp.save("cache.npy",np.array([1,2]))\nhandle=gzip.open("in.csv.gz","rt")\nafter=np.load("cache.npy")',
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: ['builtins']
      }
    )
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })

  it('keeps io.open and intact gzip effects usable after unrelated namespace taint', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['builtins']
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import io\nwith io.open("out.txt","w") as handle:\n    handle.write("value")',
        context
      )
    ).toMatchObject({ writes: ['out.txt'], writeState: 'complete' })
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import gzip\nwith gzip.open("out.csv.gz","wt") as handle:\n    handle.write("value")'
      )
    ).toMatchObject({ writes: ['out.csv.gz'], writeState: 'complete' })
  })

  it.each([
    'import os\nwith open(os.path.join("inputs","claimed.csv")) as handle:\n    content=handle.read()',
    'from os.path import join as make_path\npath=make_path("outputs","claimed.csv")\nwith open(path,"w") as handle:\n    handle.write("value")',
    'import os\npaths=[os.path.join("outputs","claimed.csv")]\nfor path in paths:\n    with open(path,"w") as handle:\n        handle.write("value")',
    'import os\npaths=[os.path.join("outputs",name) for name in ["claimed.csv"]]\nfor path in paths:\n    with open(path,"w") as handle:\n        handle.write("value")',
    'import os\nfor key,path in [("key",os.path.join("outputs","claimed.csv"))]:\n    with open(path,"w") as handle:\n        handle.write("value")'
  ])('does not invent a path from a constructor patched before failure: %s', async (source) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        'python',
        ['import os', 'os.path.join=replacement\nraise RuntimeError("failed")'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.pythonTaintedNamespaces).toContain('os')
      const io = await analyzeNotebookSourceFileAccess('python', source, context)
      expect(io).toMatchObject({
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial'
      })
    }
  })

  it('does not invent paths after a same-cell path namespace mutation', async () => {
    const io = await analyzeNotebookSourceFileAccess(
      'python',
      'import os\nos.path.join=replacement\nwith open(os.path.join("outputs","claimed.csv"),"w") as handle:\n    handle.write("value")'
    )
    expect(io).toMatchObject({ writes: [], writeState: 'partial' })
  })

  it('keeps literal output paths and intact path constructors after unrelated failure taint', async () => {
    const context = await fileContext(
      'python',
      ['import os', 'os.path.join=replacement\nraise RuntimeError("failed")'],
      [{}, { status: 'failed', kernelDispatched: true }]
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'path="outputs/fresh.csv"\nwith open(path,"w") as handle:\n    handle.write("value")',
        context
      )
    ).toMatchObject({ writes: ['outputs/fresh.csv'], writeState: 'complete' })
    const source =
      'import os\nwith open(os.path.join("outputs","fresh.csv"),"w") as handle:\n    handle.write("value")'
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io.writes.map((path) => path.replaceAll('\\', '/'))).toEqual(['outputs/fresh.csv'])
    expect(io.writeState).toBe('complete')
  })

  const pathDelegateCalls = [
    'from pathlib import Path\ncontent=Path("in.txt").read_text()',
    'from pathlib import Path\ncontent=Path("in.txt").read_bytes()',
    'from pathlib import Path\nPath("out.txt").write_text("text")',
    'from pathlib import Path\nPath("out.bin").write_bytes(b"bytes")',
    'from pathlib import Path\nwith (Path("inputs")/"in.txt").open("r") as handle:\n    content=handle.read()',
    'from pathlib import Path\nsource=Path("in.txt")\nwith source.open("r") as handle:\n    content=handle.read()',
    'from pathlib import Path\ndef read(path):\n    return Path(path).read_text()\ncontent=read("in.txt")',
    'from pathlib import Path\nimport hashlib\ndef digest(path):\n    return hashlib.sha256(Path(path).read_bytes()).hexdigest()\npaths=["in.txt"]\ndigests={path:digest(path) for path in paths}'
  ]
  it.each(pathDelegateCalls)(
    'does not trust pathlib IO after a failed io.open patch: %s',
    async (source) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          [
            'import io',
            'io.open=replacement\nraise RuntimeError("failed")',
            'from pathlib import Path'
          ],
          [{}, { status: 'failed', kernelDispatched: true }],
          precompute
        )
        expect(context?.pythonTaintedNamespaces).toContain('io')
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial'
        })
        if (!source.includes('def '))
          expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
      }
    }
  )

  it('revokes serialized value proof across a patched Path file delegate', async () => {
    const { facts } = await analyzePythonNotebookSource(
      'import numpy as np\nfrom pathlib import Path\nnp.save("cache.npy",np.array([1,2]))\nPath("in.txt").read_bytes()\nafter=np.load("cache.npy")',
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: ['io']
      }
    )
    expect(facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })

  it('keeps Path construction and builtin open usable under unrelated io taint', async () => {
    const context = await fileContext(
      'python',
      ['import io', 'io.open=replacement\nraise RuntimeError("failed")'],
      [{}, { status: 'failed', kernelDispatched: true }]
    )
    const construction = await analyzePythonNotebookSource(
      'from pathlib import Path\npath=Path("outputs")/"fresh.txt"',
      context
    )
    expect(construction.facts.state).toBe('available')
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'path="out.txt"\nwith open(path,"w") as handle:\n    handle.write("fresh")',
        context
      )
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.txt']
    })
  })

  it.each(['as.data.frame.double<-hook', 'z<-hook;as.data.frame.double<-z'])(
    'retains a failed R function alias as a shadow without reviving its body: %s',
    async (alias) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'r',
          [
            'hook<-function(x,...) {writeLines("hook","hook.txt");base::as.data.frame.vector(x,...)}',
            'stop("failed")',
            alias + ';invisible(stats::t.test(1:5))',
            'path<-"out.csv"'
          ],
          [{}, { status: 'failed', kernelDispatched: true }],
          precompute
        )
        expect(context?.resolvedKernelNames).toContain('as.data.frame.double')
        expect(context?.rFunctions ?? []).toEqual([])
        expect(
          await analyzeNotebookSourceFileAccess(
            'r',
            'out<-data.frame(x=c(1,2));write.csv(out,path)',
            context
          )
        ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
      }
    }
  )

  it('does not revive ordinary values after a definite R function rebind', async () => {
    const context = await fileContext(
      'r',
      [
        'hook<-function(x) x',
        'stop("failed")',
        'hook<-1',
        'value<-hook;invisible(stats::t.test(1:5))'
      ],
      [{}, { status: 'failed', kernelDispatched: true }]
    )
    expect(context?.resolvedKernelNames ?? []).not.toContain('value')
    expect(context?.rAtomicValueNames ?? []).not.toContain('value')
  })

  it.each(['rm(path)', 'base::remove(path)', 'rm(list="path")', 'base::rm(list=c("path"))'])(
    'does not publish a removed R path after failure: %s',
    async (remove) => {
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'r',
          ['path<-"old.csv"', 'stop("failed")', 'path<-"new.csv";' + remove],
          [{}, { status: 'failed', kernelDispatched: true }],
          precompute
        )
        expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'new.csv' })
        const io = await analyzeNotebookSourceFileAccess('r', 'read.csv(path)', context)
        expect(io.readState).toBe('partial')
        expect(io.reads).not.toContain('new.csv')
        expect((await analyzeRNotebookSource('path<-"new.csv";' + remove)).facts).toMatchObject({
          state: 'unknown',
          reasons: expect.arrayContaining(['dynamic-namespace'])
        })
      }
      const repaired = await fileContext(
        'r',
        ['path<-"old.csv"', 'stop("failed")', 'path<-"new.csv";' + remove, 'path<-"recovered.txt"'],
        [{}, { status: 'failed', kernelDispatched: true }]
      )
      expect(
        await analyzeNotebookSourceFileAccess('r', 'writeLines("fresh",path)', repaired)
      ).toMatchObject({ writeState: 'complete', writes: ['recovered.txt'] })
    }
  )

  it.each(['rm(path)', 'base::remove(list="path")'])(
    'invalidates same-cell R path lookups after %s',
    async (remove) => {
      const io = await analyzeNotebookSourceFileAccess(
        'r',
        'path<-"in.csv";' + remove + ';read.csv(path)'
      )
      expect(io).toMatchObject({ readState: 'partial', reads: [] })
      const prefix = await analyzeNotebookSourceFileAccess(
        'r',
        'path<-"in.csv";read.csv(path);' + remove + ';read.csv(path)'
      )
      expect(prefix).toMatchObject({ readState: 'partial', reads: ['in.csv'] })
    }
  )

  it.each([
    {
      language: 'r' as const,
      name: 'as.data.frame.double',
      failure: 'stop("failed")',
      setup:
        'as.data.frame.double<-function(x,...) {writeLines("hook","hook.txt");base::as.data.frame.vector(x,...)};invisible(stats::t.test(1:5))',
      path: 'path<-"out.csv"',
      consumer: 'out<-data.frame(x=c(1,2));write.csv(out,path)'
    },
    {
      language: 'python' as const,
      name: 'open',
      failure: 'raise RuntimeError("failed")',
      setup:
        'import io,statistics\ndef open(file,*args,**kwargs):\n    io.open("hook.txt","w").write("hook")\n    return io.open(file,*args,**kwargs)\nprobe=getattr(statistics,"pstdev")([1.,2.,3.])',
      path: 'path="in.csv"',
      consumer: 'open(path).read()'
    }
  ])('retains a new $language default shadow from a completed opaque repair', async (c) => {
    for (const precompute of [false, true]) {
      const context = await fileContext(
        c.language,
        [c.failure, c.setup, c.path],
        [{ status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.resolvedKernelNames).toContain(c.name)
      expect(context?.rFunctions ?? []).toEqual([])
      expect(context?.localFileWrappers).toEqual([])
      expect(await analyzeNotebookSourceFileAccess(c.language, c.consumer, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  })

  it.each(['invisible(stats::t.test(1:5))', 'eval(parse(text="1+1"))'])(
    'retains a live R method through a successful opaque boundary: %s',
    async (opaque) => {
      for (const precompute of [false, true]) {
        for (const afterFailure of [false, true]) {
          const setup =
            'as.data.frame.double <- function(x,...) {writeLines("hook","hook.txt");base::as.data.frame.vector(x,...)}'
          const middle = afterFailure ? ['stop("failed")', opaque] : [opaque, 'stop("failed")']
          const context = await fileContext(
            'r',
            [setup, ...middle, 'path <- "out.csv"'],
            [
              {},
              ...middle.map((_, index) =>
                index === (afterFailure ? 0 : 1)
                  ? { status: 'failed' as const, kernelDispatched: true }
                  : {}
              )
            ],
            precompute
          )
          expect(context?.resolvedKernelNames).toContain('as.data.frame.double')
          expect(context?.rFunctions ?? []).toEqual([])
          const { facts } = await analyzeRNotebookSource('out<-data.frame(x=c(1,2))', context)
          expect(facts).toMatchObject({
            state: 'unknown',
            reasons: expect.arrayContaining(['opaque-call'])
          })
          expect(facts.copyOnModifyNames ?? []).not.toContain('out')
          expect(
            await analyzeNotebookSourceFileAccess(
              'r',
              'out<-data.frame(x=c(1,2));write.csv(out,path)',
              context
            )
          ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
          expect(
            await analyzeNotebookSourceFileAccess('r', 'writeLines("fresh",path)', context)
          ).toMatchObject({ writeState: 'complete', writes: ['out.csv'] })
        }
      }
    }
  )

  it.each([
    'open("in.txt",opener=callback)',
    'open("in.txt","r",-1,None,None,None,True,callback)',
    'open("in.txt",**options)',
    'import builtins\nbuiltins.open("in.txt",opener=callback)',
    'from builtins import open as native_open\nnative_open("in.txt",opener=callback)'
  ])('does not certify hidden opener callback writes: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'open("in.txt",opener=callback)',
    'open("in.txt",**options)',
    'from builtins import open as native_open\nnative_open("in.txt",opener=callback)'
  ])('does not preserve old path values through an opaque opener: %s', async (source) => {
    const context = await fileContext('python', ['path="old.txt"', source])
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
  })

  it.each([
    'open("in.txt",opener=None)',
    'open("in.txt","r",-1,None,None,None,True,None)',
    'from builtins import open as native_open\nnative_open("in.txt",opener=None)'
  ])('retains the builtin file contract without an opener callback: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['in.txt'],
      writes: []
    })
  })

  const cases = [
    {
      language: 'r',
      name: 'as.data.frame.double',
      setup:
        'as.data.frame.double <- function(x,...) {writeLines("hook","hook.txt");base::as.data.frame.vector(x,...)}',
      failure: 'stop("failed")',
      repair: 'path <- "out.csv"',
      consumer: 'out <- data.frame(x=c(1,2));write.csv(out,path)'
    },
    {
      language: 'python',
      name: 'open',
      setup:
        'import io\ndef open(file,*args,**kwargs):\n    io.open("hook.txt","w").write("hook")\n    return io.open(file,*args,**kwargs)',
      failure: 'raise RuntimeError("failed")',
      repair: 'path = "in.csv"',
      consumer: 'with open(path) as handle:\n    text = handle.read()'
    }
  ] as const

  it.each(cases)(
    'retains $language shadows across cold and restored failures',
    async (scenario) => {
      for (const precompute of [false, true]) {
        for (const status of ['failed', 'timeout', 'interrupted', 'cancelled'] as const) {
          const context = await fileContext(
            scenario.language,
            [scenario.setup, scenario.failure, scenario.repair],
            [{}, { status, kernelDispatched: true }],
            precompute
          )
          expect(context?.resolvedKernelNames).toContain(scenario.name)
          expect(context?.localFileWrappers).toEqual([])
          expect(context?.rFunctions ?? []).toEqual([])
          expect(
            await analyzeNotebookSourceFileAccess(scenario.language, scenario.consumer, context)
          ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
        }
      }
    }
  )

  it.each(cases)('retains $language names possibly assigned before a failure', async (scenario) => {
    const context = await fileContext(
      scenario.language,
      [scenario.setup + '\n' + scenario.failure],
      [{ status: 'failed', kernelDispatched: true }],
      false
    )
    expect(context?.resolvedKernelNames).toContain(scenario.name)
    expect(context?.staticStrings).toEqual([])
    expect(context?.rAtomicValueNames ?? []).toEqual([])
  })

  it.each(cases)('does not carry $language shadow barriers into a new epoch', async (scenario) => {
    const context = await fileContext(
      scenario.language,
      [scenario.setup, scenario.failure, scenario.repair],
      [{}, { status: 'failed', kernelDispatched: true }],
      true,
      undefined,
      'epoch-2'
    )
    expect(context?.resolvedKernelNames ?? []).not.toContain(scenario.name)
  })

  it.each(cases)(
    'recovers a new $language literal without reviving failed path values',
    async (scenario) => {
      const assignments =
        scenario.language === 'r'
          ? 'path <- "old.txt";other <- "uncertain.txt"'
          : 'path = "old.txt"\nother = "uncertain.txt"'
      const context = await fileContext(
        scenario.language,
        [assignments, scenario.failure, scenario.repair],
        [{}, { status: 'failed', kernelDispatched: true }]
      )
      expect(context?.staticStrings).toEqual([
        { name: 'path', value: scenario.language === 'r' ? 'out.csv' : 'in.csv' }
      ])
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            scenario.language,
            scenario.language === 'r' ? 'writeLines("new",path)' : 'open(path,"w").close()',
            context
          )
        ).writeState
      ).toBe('complete')
    }
  )

  it('does not certify unknown open writes merely because its argument is a read path', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['open']
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'open("in.csv").read()', context)
    ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from builtins import open\nopen("in.csv").read()',
        context
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
  })

  it.each([
    ['import io\nwith io.open("out.txt","w") as handle:\n    handle.write("data")', 'write'],
    ['from io import open as native_open\nnative_open("out.txt","w").close()', 'write'],
    ['import io\nio.open("in.txt").read()', 'read']
  ] as const)('recovers intact io.open modes: %s', async (source, mode) => {
    const result = await analyzeNotebookSourceFileAccess('python', source, {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['open']
    })
    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect(mode === 'write' ? result.writes : result.reads).toContain(
      mode === 'write' ? 'out.txt' : 'in.txt'
    )
  })

  it('keeps patched io.open uncertain across a failed run and re-import', async () => {
    for (const source of [
      'import io\nio.open=replacement\nio.open("in.txt")',
      'import io\nio.open("in.txt")'
    ]) {
      const result = await analyzeNotebookSourceFileAccess('python', source, {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: ['io']
      })
      expect(result).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
    const context = await fileContext(
      'python',
      ['import io', 'io.open=replacement\nraise RuntimeError()', 'import io'],
      [{}, { status: 'failed', kernelDispatched: true }]
    )
    expect(context?.pythonTaintedNamespaces).toContain('io')
    expect(
      await analyzeNotebookSourceFileAccess('python', 'io.open("in.txt")', context)
    ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
  })

  it.each([
    'io.open("in.txt",**options)',
    'io.open(*arguments)',
    'io.open("in.txt",opener=callback)',
    'io.open("in.txt","r",-1,None,None,None,True,callback)'
  ])('keeps unresolved io.open options uncertain: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('python', 'import io\n' + call)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('pandas export formatter callback boundaries', () => {
  const prefix =
    'import numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\n'
  it.each([
    'frame.to_csv("export.csv",float_format=formatter)',
    'frame.to_json("export.json",default_handler=formatter)',
    'frame.to_csv("export.csv",**options)',
    'frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("export.csv",float_format=formatter)',
    'frame=pd.Series([1.,2.])\nframe.to_csv("export.csv",float_format=formatter)',
    'frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("export.csv",float_format=lambda value: str(value))',
    'frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_json("export.json",default_handler=formatter)',
    'frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv(float_format=formatter)',
    'frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("export.csv",**options)'
  ])('withdraws content and file authority through formatter: %s', async (exporter) => {
    const source = prefix + exporter + '\nafter=np.load("cache.npy")\nopen(path)'
    const { facts } = await analyzePythonNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).not.toContain('old.txt')
  })
  it.each(['pd.DataFrame({"x":[1.,2.]})', 'pd.Series([1.,2.])'])(
    'withdraws formatter paths through warm and cold replay: %s',
    async (receiver) => {
      for (const precompute of [false, true]) {
        const scripts = [
          prefix,
          `frame=${receiver}\ndef formatter(x):\n    global path\n    path="new.txt"\n    return str(x)\nraise RuntimeError()`,
          'frame.to_csv("export.csv",float_format=formatter)'
        ]
        const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
        const context = await fileContext('python', scripts, overrides, precompute)
        expect(
          (await analyzeNotebookSourceFileAccess('python', 'open(path)', context)).reads
        ).not.toContain('old.txt')
        expect(context?.verifiedSerializedValues ?? []).toEqual([])
      }
    }
  )
  it.each(['', 'float_format=None', 'float_format="%.17g"'])(
    'preserves literal CSV formatting proof: %s',
    async (option) => {
      const source =
        prefix +
        `frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("export.csv"${option ? ',' + option : ''})\nafter=np.load("cache.npy")\nopen(path)`
      expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toHaveLength(
        1
      )
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: ['old.txt']
      })
    }
  )
})

describe('pandas export closed formatter controls', () => {
  it.each([
    'pd.Series([1.,2.]).to_csv("export.csv",float_format="%.17g")',
    'pd.Series([1.,2.]).to_csv("export.csv",float_format=None)',
    'pd.DataFrame({"x":[1.,2.]}).to_json("export.json",default_handler=None)'
  ])('retains file and serialization proof for %s', async (call) => {
    const source =
      'import numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\n' +
      call +
      '\nafter=np.load("cache.npy")'
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writeState: 'complete',
      externalState: 'complete'
    })
  })
})

describe('pandas compressed export delegate boundaries', () => {
  it.each([
    ['gzip', 'gz'],
    ['bz2', 'bz2'],
    ['lzma', 'xz'],
    ['zipfile', 'zip'],
    ['tarfile', 'tar']
  ])('withdraws inferred %s export authority', async (namespace, suffix) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: [namespace]
    }
    const source = `import numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\nframe=pd.DataFrame({"x":[1.,2.]})\npath="old.txt"\nframe.to_csv("export.csv.${suffix}",index=False)\nafter=np.load("cache.npy")\nopen(path)`
    const facts = (await analyzePythonNotebookSource(source, context)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source, context)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    'frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("out.bin",compression={"method":"gzip","mtime":0})',
    'frame=pd.Series([1.,2.])\nframe.to_csv("out.bin",compression="gzip")',
    'frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_json("out.json.gz")',
    'frame.to_csv("out.csv.gz")',
    'frame.to_json("out.json.gz")',
    'frame.to_csv("out.bin",compression=codec)',
    'frame.to_csv("out.bin",**options)'
  ])('keeps known and unresolved compressed receivers conservative: %s', async (exporter) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    const source = 'import pandas as pd\n' + exporter
    expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([false, true])(
    'keeps failed codec export paths uncertain through replay (%s)',
    async (precompute) => {
      const scripts = [
        'import gzip,pandas as pd\npath="old.txt"',
        'gzip.GzipFile=replacement\nraise RuntimeError()',
        'frame=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("out.csv.gz")'
      ]
      const context = await fileContext(
        'python',
        scripts,
        [{}, { status: 'failed' as const, kernelDispatched: true }],
        precompute
      )
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'open(path)', context)).reads
      ).not.toContain('old.txt')
    }
  )
  it.each([
    'frame.to_csv("out.csv")',
    'frame.to_csv("out.csv.gz",compression=None)',
    'frame.to_csv("out.csv.gz",compression={"method":None})',
    'frame.to_csv("out.csv.bz2")',
    'frame.to_csv("out.csv.xz")',
    'frame.to_json("out.json.gz",compression=None)'
  ])('preserves closed unrelated export precision: %s', async (call) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    const source =
      'import numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\nframe=pd.DataFrame({"x":[1.,2.]})\n' +
      call
    expect(
      (await analyzePythonNotebookSource(source, context)).facts.serializedValueWrites
    ).toHaveLength(1)
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      writeState: 'complete',
      externalState: 'complete'
    })
  })
})

describe('pandas compression text-return controls', () => {
  it.each([
    'frame.to_csv(compression="gzip")',
    'frame.to_csv(None,compression="gzip")',
    'frame.to_json(path_or_buf=None,compression="gzip")'
  ])('does not infer an opener when returning text: %s', async (call) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    const source =
      'import numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\nframe=pd.DataFrame({"x":[1.,2.]})\n' +
      call
    const facts = (await analyzePythonNotebookSource(source, context)).facts
    expect(facts.state).toBe('available')
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      writeState: 'partial',
      externalState: 'partial',
      writes: ['cache.npy']
    })
  })
})

describe('compression constructor writes after lost import proof', () => {
  it.each([
    ['gzip', 'GzipFile', 'gz'],
    ['bz2', 'BZ2File', 'bz2'],
    ['lzma', 'LZMAFile', 'xz'],
    ['zipfile', 'ZipFile', 'zip'],
    ['tarfile', 'TarFile', 'tar']
  ])(
    'retains negative %s namespace proof across a prior failure',
    async (namespace, member, suffix) => {
      for (const precompute of [false, true]) {
        const scripts = [
          `import ${namespace} as codec`,
          'raise RuntimeError()',
          `codec.${member}=replacement\nraise RuntimeError()`
        ]
        const context = await fileContext(
          'python',
          scripts,
          [
            {},
            { status: 'failed' as const, kernelDispatched: true },
            { status: 'failed' as const, kernelDispatched: true }
          ],
          precompute
        )
        expect(context?.pythonTaintedNamespaces).toContain(namespace)
        const source = `import pandas as pd\nframe=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("out.csv.${suffix}")`
        expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
        expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
          writeState: 'partial',
          externalState: 'partial'
        })
      }
    }
  )
  it.each(['native=unknown.GzipFile', 'def later():\n    unknown.GzipFile=replacement'])(
    'does not treat a read or deferred write as a constructor replacement: %s',
    async (source) => {
      const context = await fileContext('python', [source])
      expect(context?.pythonTaintedNamespaces ?? []).not.toContain('gzip')
    }
  )
})

describe('reflective compression constructor writes', () => {
  it.each([
    ['gzip', 'GzipFile', 'gz'],
    ['bz2', 'BZ2File', 'bz2'],
    ['lzma', 'LZMAFile', 'xz'],
    ['zipfile', 'ZipFile', 'zip'],
    ['tarfile', 'TarFile', 'tar']
  ])(
    'retains possible %s mutations after import proof is lost',
    async (namespace, member, suffix) => {
      for (const operation of ['setattr', 'delattr'])
        for (const precompute of [false, true]) {
          const mutation = `${operation}(codec,"${member}"${operation === 'setattr' ? ',replacement' : ''})`
          const scripts = [
            `import ${namespace} as codec`,
            'raise RuntimeError()',
            mutation + '\nraise RuntimeError()'
          ]
          const overrides = [
            {},
            { status: 'failed' as const, kernelDispatched: true },
            { status: 'failed' as const, kernelDispatched: true }
          ]
          const context = await fileContext('python', scripts, overrides, precompute)
          expect(context?.pythonTaintedNamespaces).toContain(namespace)
          const source = `import pandas as pd\nframe=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("out.csv.${suffix}")`
          expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
          expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
            writeState: 'partial',
            externalState: 'partial'
          })
        }
    }
  )
  it.each([
    'setattr(codec,"GzipFile",replacement)',
    'delattr(codec,"GzipFile")',
    'builtins.setattr(codec,"GzipFile",replacement)'
  ])('withdraws same-source content and paths after %s', async (mutation) => {
    const source =
      'import builtins,numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\n' +
      mutation +
      '\nframe=pd.DataFrame({"x":[1.,2.]})\nframe.to_csv("out.csv.gz")\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    'getattr(codec,"GzipFile")',
    'hasattr(codec,"GzipFile")',
    'setattr(codec,"unrelated",replacement)',
    'def later():\n    setattr(codec,"GzipFile",replacement)'
  ])('does not infer a constructor replacement for %s', async (source) => {
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces ?? []).not.toContain('gzip')
  })
})

describe('pandas JSON reader delegation and input contract', () => {
  it.each([
    ['gzip', 'gz'],
    ['bz2', 'bz2'],
    ['lzma', 'xz'],
    ['zipfile', 'zip'],
    ['tarfile', 'tar'],
    ['builtins', 'json']
  ])('withdraws JSON codec/opener proof for %s', async (namespace, suffix) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: [namespace]
    }
    const source = `import numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\nframe=pd.read_json("input.${suffix}",orient="records")\nafter=np.load("cache.npy")\nopen(path)`
    const facts = (await analyzePythonNotebookSource(source, context)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' })
    )
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source, context)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    'import pandas as pd\nframe=pd.read_json(path_or_buf="input.json",orient="records")',
    'from pandas import read_json as load_json\nframe=load_json(path_or_buf="input.json",orient="records")'
  ])('records the canonical JSON keyword input: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['input.json']
    })
  })
  it.each([
    'pd.read_json(path_or_buf="input.gz",compression={"method":"gzip"})',
    'pd.read_json("input.json",compression="gzip")',
    'pd.read_json("input.json",**options)',
    'pd.read_json(path_or_buf=path,compression=None)',
    'pd.read_json(path_or_buf="https://example.test/data",compression=None)'
  ])('does not certify unresolved or overridden JSON compression: %s', async (call) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'import pandas as pd\n' + call, context)
    ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
  })
  it.each([
    'pd.read_json(path_or_buf="input.json")',
    'pd.read_json(path_or_buf="input.json.gz",compression=None)',
    'pd.read_json(path_or_buf="input.json.gz",compression={"method":None})',
    'pd.read_json(path_or_buf="input.json.bz2")'
  ])('preserves closed unrelated JSON reader inputs: %s', async (call) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    const io = await analyzeNotebookSourceFileAccess(
      'python',
      'import pandas as pd\n' + call,
      context
    )
    expect(io).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect(io.reads).toHaveLength(1)
  })
  it.each([false, true])(
    'keeps failed JSON codec mutations through replay (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [
          'import gzip as codec',
          'raise RuntimeError()',
          'setattr(codec,"GzipFile",replacement)\nraise RuntimeError()'
        ],
        [
          {},
          { status: 'failed' as const, kernelDispatched: true },
          { status: 'failed' as const, kernelDispatched: true }
        ],
        precompute
      )
      const source = 'import pandas as pd\nframe=pd.read_json(path_or_buf="input.json.gz")'
      expect(
        (await analyzePythonNotebookSource(source, context)).facts.typeBindings
      ).not.toContainEqual(
        expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' })
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )
})

describe('fixed-width parser callback and delegate boundaries', () => {
  const setup =
    'import numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\n'
  it.each([
    'pd.read_fwf("input.fwf",converters={"waiting":convert})',
    'pd.read_fwf(filepath_or_buffer="input.fwf",converters=converters)',
    'pd.read_fwf("input.fwf",usecols=select)',
    'pd.read_fwf("input.fwf",skiprows=skip)',
    'pd.read_fwf("input.fwf",on_bad_lines=repair)',
    'pd.read_fwf("input.fwf",**options)',
    'pd.read_fwf("input.fwf",None,convert)',
    'read("input.fwf",converters={"waiting":convert})'
  ])('withdraws old content and paths after parser callbacks: %s', async (call) => {
    const source =
      setup +
      'from pandas import read_fwf as read\nframe=' +
      call +
      '\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: expect.arrayContaining(['input.fwf'])
    })
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    '',
    ',converters=None',
    ',converters={}',
    ',usecols=[0,1],skiprows=0,on_bad_lines="error"'
  ])('preserves closed fixed-width reads: %s', async (options) => {
    const source =
      setup +
      'frame=pd.read_fwf(filepath_or_buffer="input.fwf",widths=[12,12]' +
      options +
      ')\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites).toHaveLength(1)
    expect(facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: expect.arrayContaining(['input.fwf', 'old.txt'])
    })
  })
  it.each([
    ['gzip', 'gz'],
    ['bz2', 'bz2'],
    ['lzma', 'xz'],
    ['zipfile', 'zip'],
    ['tarfile', 'tar'],
    ['builtins', 'txt']
  ])('withdraws fixed-width delegated proof for %s', async (namespace, suffix) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: [namespace]
    }
    const source =
      setup +
      `frame=pd.read_fwf("input.${suffix}",widths=[12,12])\nafter=np.load("cache.npy")\nopen(path)`
    const facts = (await analyzePythonNotebookSource(source, context)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    for (const target of ['frame', 'after'])
      expect(facts.typeBindings).not.toContainEqual(
        expect.objectContaining({
          target,
          typeName: target === 'frame' ? 'pandas.DataFrame' : 'numpy.ndarray'
        })
      )
    const io = await analyzeNotebookSourceFileAccess('python', source, context)
    expect(io).toMatchObject({ writeState: 'partial', externalState: 'partial' })
    expect(io.reads).not.toContain('old.txt')
  })
  it.each(['pd.read_fwf("input.gz",compression=None)', 'pd.read_fwf("input.bz2")'])(
    'preserves unrelated compression: %s',
    async (call) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonTaintedNamespaces: ['gzip']
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', 'import pandas as pd\n' + call, context)
      ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
    }
  )
  it.each([false, true])(
    'revokes file proof through cross-cell replay (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [setup + 'frame=pd.read_fwf("input.fwf",converters={"waiting":convert})'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      expect(
        (await analyzePythonNotebookSource('after=np.load("cache.npy")', context)).facts
          .typeBindings
      ).not.toContainEqual(expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' }))
    }
  )
  it('does not retain a CSV path that the shared parser callback can rebind', async () => {
    const source =
      'import pandas as pd\npath="old.txt"\nframe=pd.read_csv("input.csv",converters={"x":convert})\nopen(path)'
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io.reads).toContain('input.csv')
    expect(io.reads).not.toContain('old.txt')
    expect(io).toMatchObject({ writeState: 'partial', externalState: 'partial' })
  })
})

describe('table parser callback proof boundaries', () => {
  const setup =
    'import numpy as np,pandas as pd\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\n'
  it.each([
    'pd.read_table("input.tsv",skiprows=choose)',
    'pd.read_table(filepath_or_buffer="input.tsv",converters={"waiting":convert})',
    'pd.read_table("input.tsv",converters=converters)',
    'pd.read_table("input.tsv",usecols=choose)',
    'pd.read_table("input.tsv",on_bad_lines=repair)',
    'pd.read_table("input.tsv",**options)',
    'pd.read_table("input.tsv",None,choose)',
    'load("input.tsv",skiprows=choose)'
  ])('withdraws content/path proof at table parser callbacks: %s', async (call) => {
    const source =
      setup +
      'from pandas import read_table as load\nframe=' +
      call +
      '\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: expect.arrayContaining(['input.tsv'])
    })
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    '',
    ',skiprows=0,usecols=["eruptions","waiting"]',
    ',converters=None',
    ',converters={},on_bad_lines="skip"'
  ])('keeps closed table parser options precise: %s', async (options) => {
    const source =
      setup +
      'frame=pd.read_table(filepath_or_buffer="input.tsv"' +
      options +
      ')\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites).toHaveLength(1)
    expect(facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: expect.arrayContaining(['input.tsv', 'old.txt'])
    })
  })
  it.each([false, true])(
    'does not revive table-callback cache content on replay (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [setup + 'frame=pd.read_table("input.tsv",skiprows=choose)'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      expect(
        (await analyzePythonNotebookSource('after=np.load("cache.npy")', context)).facts
          .typeBindings
      ).not.toContainEqual(expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' }))
    }
  )
})

describe('XML stylesheet input and effect boundaries', () => {
  const setup =
    'import pandas as pd,numpy as np\nfrom pandas import read_xml as load\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\nsheet="transform.xsl"\n'
  it.each([
    ['pd.read_xml("input.xml",stylesheet="transform.xsl")', true],
    ['pd.read_xml(path_or_buffer="input.xml",stylesheet="transform.xsl")', true],
    ['load("input.xml",stylesheet=sheet)', true],
    ['pd.read_xml("input.xml",**options)', false],
    ['pd.read_xml("input.xml",None,sheet)', false],
    ['pd.read_xml("input.xml",stylesheet=unknown_sheet)', false]
  ])('withdraws content/path proof at XSLT execution: %s', async (call, knownSheet) => {
    const source = setup + 'frame=' + call + '\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: expect.arrayContaining(['input.xml'])
    })
    expect(io.reads).not.toContain('old.txt')
    if (knownSheet) expect(io.reads).toContain('transform.xsl')
  })
  it.each(['', ',stylesheet=None', ',parser="etree",stylesheet=None'])(
    'preserves plain XML reads: %s',
    async (options) => {
      const source =
        setup +
        'frame=pd.read_xml("input.xml"' +
        options +
        ')\nafter=np.load("cache.npy")\nopen(path)'
      const facts = (await analyzePythonNotebookSource(source)).facts
      expect(facts.serializedValueWrites).toHaveLength(1)
      expect(facts.typeBindings).toContainEqual(
        expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
      )
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: expect.arrayContaining(['input.xml', 'old.txt'])
      })
    }
  )
  it.each(['StringIO("<xsl:stylesheet/>")', 'BytesIO(b"<xsl:stylesheet/>")'])(
    'does not invent a filename from an in-memory stylesheet: %s',
    async (buffer) => {
      const source =
        'import pandas as pd\nfrom io import StringIO,BytesIO\nframe=pd.read_xml("input.xml",stylesheet=' +
        buffer +
        ')'
      const io = await analyzeNotebookSourceFileAccess('python', source)
      expect(io).toMatchObject({ writeState: 'partial', externalState: 'partial' })
      expect(io.reads).toContain('input.xml')
      expect(io.reads).not.toContain('<xsl:stylesheet/>')
    }
  )
  it.each([false, true])(
    'does not revive array proof after stylesheet execution (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [setup + 'frame=pd.read_xml("input.xml",stylesheet="transform.xsl")'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      expect(
        (await analyzePythonNotebookSource('after=np.load("cache.npy")', context)).facts
          .typeBindings
      ).not.toContainEqual(expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' }))
    }
  )
})

describe('R default table conversion method boundaries', () => {
  const setup = 'base::saveRDS(c(1,2),"cache.rds")\npath<-"old.txt"\n'
  const method =
    'type.convert.character <- function(x,...) { path<<-"new.txt";base::saveRDS(c(9,8),"cache.rds");stop("conversion failed") }\n'
  it.each([
    'utils::read.csv("input.csv")',
    'read.csv("input.csv")',
    'utils::read.csv2("input.csv")',
    'utils::read.delim("input.csv")',
    'utils::read.delim2("input.csv")',
    'utils::read.table("input.csv",header=TRUE)',
    'utils::read.csv("input.csv",colClasses=NA)',
    'utils::read.csv("input.csv",colClasses=c("numeric",NA))'
  ])('withdraws file/path proof through default S3 dispatch: %s', async (call) => {
    const source =
      setup +
      method +
      'paired<-' +
      call +
      '\nafter<-base::readRDS("cache.rds")\nbase::readLines(path)'
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
    const io = await analyzeNotebookSourceFileAccess('r', source)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(io.reads).toContain('cache.rds')
    expect(io.reads).toContain('input.csv')
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    ',colClasses="numeric"',
    ',colClasses=c("numeric","numeric")',
    ',colClasses=c(a="integer",b="double")'
  ])('keeps explicit primitive conversion proof despite an unused method: %s', async (options) => {
    const source =
      setup + method + 'paired<-utils::read.csv("input.csv"' + options + ')\nbase::readLines(path)'
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    const io = await analyzeNotebookSourceFileAccess('r', source)
    expect(io).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect(io.reads).toContain('old.txt')
  })
  it.each([false, true])(
    'retains failed default conversion bindings across replay (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        [method + 'stop("after definition")', setup],
        [{ status: 'failed' as const, kernelDispatched: true }, {}],
        precompute
      )
      const source =
        'paired<-utils::read.csv("input.csv")\nbase::readRDS("cache.rds")\nbase::readLines(path)'
      expect(
        (await analyzeRNotebookSource(source, context)).facts.serializedValueWrites ?? []
      ).toEqual([])
      const io = await analyzeNotebookSourceFileAccess('r', source, context)
      expect(io).toMatchObject({ writeState: 'partial', externalState: 'partial' })
      expect(io.reads).toContain('cache.rds')
      expect(io.reads).not.toContain('old.txt')
      const control = await analyzeNotebookSourceFileAccess(
        'r',
        'paired<-utils::read.csv("input.csv",colClasses="numeric")',
        context
      )
      expect(control).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: ['input.csv']
      })
    }
  )
})

describe('R table column coercion proof boundaries', () => {
  const setup = 'base::saveRDS(c(1,2),"cache.rds")\npath<-"old.txt"\n'
  it.each([
    'utils::read.csv("input.csv",colClasses="AuditWaiting")',
    'utils::read.csv("input.csv",colClasses=c("numeric","AuditWaiting"))',
    'utils::read.csv(file="input.csv",colC="AuditWaiting")',
    'utils::read.csv2("input.csv",colClasses=classes)',
    'utils::read.delim("input.csv",colClasses="AuditWaiting")',
    'utils::read.delim2("input.csv",colClasses="AuditWaiting")',
    'utils::read.table("input.csv",colClasses="AuditWaiting")',
    'read.csv("input.csv",colClasses="AuditWaiting")',
    'utils::read.table("input.csv",TRUE,",","",".","allow.loss",NULL,NULL,FALSE,TRUE,"NA","AuditWaiting")',
    'utils::read.csv("input.csv",colClasses="numeric",colClasses="AuditWaiting")',
    'utils::read.csv("input.csv",...)'
  ])('withdraws serialized/path proof at class coercion: %s', async (call) => {
    const source =
      setup + 'frame<-' + call + '\nafter<-base::readRDS("cache.rds")\nbase::readLines(path)'
    const facts = (await analyzeRNotebookSource(source)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    const io = await analyzeNotebookSourceFileAccess('r', source)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(io.reads).toContain('cache.rds')
    expect(io.reads).not.toContain('old.txt')
    if (!call.endsWith('...)')) expect(io.reads).toContain('input.csv')
  })
  it.each([
    '',
    ',colClasses="numeric"',
    ',colClasses=c("numeric","integer")',
    ',colClasses=NA',
    ',colClasses=c(waiting="numeric",eruptions=NA)',
    ',colClasses="real"'
  ])('preserves closed primitive column options: %s', async (options) => {
    const source =
      setup +
      'frame<-utils::read.csv("input.csv"' +
      options +
      ')\nafter<-base::readRDS("cache.rds")\nbase::readLines(path)'
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: expect.arrayContaining(['input.csv', 'old.txt'])
    })
  })
  it.each([false, true])(
    'does not revive coerced RDS proof across cells (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        [setup + 'frame<-utils::read.csv("input.csv",colClasses="AuditWaiting")'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      const io = await analyzeNotebookSourceFileAccess(
        'r',
        'base::readRDS("cache.rds")\nbase::readLines(path)',
        context
      )
      expect(io.reads).toContain('cache.rds')
      expect(io.reads).not.toContain('old.txt')
    }
  )
})

describe('XML reader delegated codec boundaries', () => {
  const context = (namespace: string): NotebookSourceFileAccessContext => ({
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonTaintedNamespaces: [namespace]
  })
  it.each([
    ['gzip', 'gz'],
    ['bz2', 'bz2'],
    ['lzma', 'xz'],
    ['zipfile', 'zip'],
    ['tarfile', 'tar']
  ])('withdraws content and paths through replaced %s', async (namespace, suffix) => {
    const source =
      'import pandas as pd,numpy as np\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\nframe=pd.read_xml(path_or_buffer="input.xml.' +
      suffix +
      '",parser="etree",stylesheet=None)\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source, context(namespace))).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    for (const target of ['frame', 'after'])
      expect(facts.typeBindings).not.toContainEqual(
        expect.objectContaining({
          target,
          typeName: target === 'frame' ? 'pandas.DataFrame' : 'numpy.ndarray'
        })
      )
    const io = await analyzeNotebookSourceFileAccess('python', source, context(namespace))
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(io.reads).toContain('input.xml.' + suffix)
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    'pd.read_xml("input.xml",compression="gzip")',
    'pd.read_xml(path_or_buffer="input.xml",compression={"method":"gzip"})',
    'pd.read_xml(path_or_buffer=path,compression=None)',
    'pd.read_xml("input.xml",**options)',
    'pd.read_xml("input.xml",compression="gzip",compression=None)'
  ])('keeps explicit/ambiguous codec calls conservative: %s', async (call) => {
    const source = 'import pandas as pd\nframe=' + call
    expect(
      (await analyzePythonNotebookSource(source, context('gzip'))).facts.typeBindings
    ).not.toContainEqual(expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' }))
    expect(await analyzeNotebookSourceFileAccess('python', source, context('gzip'))).toMatchObject({
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'pd.read_xml("input.xml")',
    'pd.read_xml(path_or_buffer="input.xml.gz",compression=None)',
    'pd.read_xml("input.xml.gz",compression={"method":None})',
    'pd.read_xml(path_or_buffer="input.xml.bz2")'
  ])('preserves closed codec precision: %s', async (call) => {
    const source = 'import pandas as pd\nframe=' + call
    expect(
      (await analyzePythonNotebookSource(source, context('gzip'))).facts.typeBindings
    ).toContainEqual(expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' }))
    expect(await analyzeNotebookSourceFileAccess('python', source, context('gzip'))).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it('does not certify an XML reader with a replaced builtin opener', async () => {
    const source =
      'import pandas as pd\nframe=pd.read_xml(path_or_buffer="input.xml",parser="etree")'
    expect(
      (await analyzePythonNotebookSource(source, context('builtins'))).facts.typeBindings
    ).not.toContainEqual(expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' }))
    expect(
      await analyzeNotebookSourceFileAccess('python', source, context('builtins'))
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['input.xml']
    })
  })
  it.each([false, true])(
    'retains failed XML codec mutation through replay (%s)',
    async (precompute) => {
      const ctx = await fileContext(
        'python',
        [
          'import gzip as codec',
          'raise RuntimeError()',
          'setattr(codec,"GzipFile",replacement)\nraise RuntimeError()'
        ],
        [
          {},
          { status: 'failed' as const, kernelDispatched: true },
          { status: 'failed' as const, kernelDispatched: true }
        ],
        precompute
      )
      const source =
        'import pandas as pd\nframe=pd.read_xml(path_or_buffer="input.xml.gz",stylesheet=None)'
      expect(
        (await analyzePythonNotebookSource(source, ctx)).facts.typeBindings
      ).not.toContainEqual(
        expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' })
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, ctx)).toMatchObject({
        writeState: 'partial',
        externalState: 'partial',
        reads: ['input.xml.gz']
      })
    }
  )
})

describe('XML converter proof boundaries', () => {
  const setup =
    'import numpy as np,pandas as pd\nfrom pandas import read_xml as load\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\n'
  it.each([
    'pd.read_xml("input.xml",converters={"waiting":convert})',
    'pd.read_xml(path_or_buffer="input.xml",stylesheet=None,converters={"waiting":convert})',
    'pd.read_xml("input.xml",parser="etree",converters={"waiting":convert})',
    'pd.read_xml("input.xml",converters=converters)',
    'load("input.xml",converters={"waiting":convert})',
    'pd.read_xml("input.xml",converters={"waiting":convert},converters={})',
    'pd.read_xml("input.xml",**options)',
    'pd.read_xml("input.xml",None,convert)'
  ])('withdraws content/path proof at XML conversion: %s', async (call) => {
    const source = setup + 'frame=' + call + '\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: expect.arrayContaining(['input.xml'])
    })
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    '',
    ',converters=None',
    ',converters={}',
    ',stylesheet=None,converters=None',
    ',parser="etree",stylesheet=None,converters={}'
  ])('keeps closed XML conversion precise: %s', async (options) => {
    const source =
      setup +
      'frame=pd.read_xml("input.xml"' +
      options +
      ')\nafter=np.load("cache.npy")\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites).toHaveLength(1)
    expect(facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: expect.arrayContaining(['input.xml', 'old.txt'])
    })
  })
  it.each([false, true])(
    'does not revive XML-converter cache content on replay (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [setup + 'frame=pd.read_xml("input.xml",stylesheet=None,converters={"waiting":convert})'],
        [],
        precompute
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      expect(
        (await analyzePythonNotebookSource('after=np.load("cache.npy")', context)).facts
          .typeBindings
      ).not.toContainEqual(expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' }))
    }
  )
  it.each(['None', '{}'])(
    'does not close XSLT through empty converters: %s',
    async (converters) => {
      const source =
        setup +
        'frame=pd.read_xml("input.xml",stylesheet="transform.xsl",converters=' +
        converters +
        ')'
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        writeState: 'partial',
        externalState: 'partial',
        reads: expect.arrayContaining(['input.xml', 'transform.xsl'])
      })
    }
  )
})

describe('R optimization callback file authority', () => {
  it.each([
    'stats::optim(70,objective,method="BFGS")',
    'stats::optim(par=70,fn=objective,method="BFGS")',
    'optim(70,objective,method="BFGS")',
    'stats::optim(fn=objective,par=70)',
    'stats::optim(70,function(x) { path <<- "new.txt"; x*x })',
    'stats::optim(70,"objective")',
    'stats::optim(70,objective,method="Nelder-Mead")',
    'stats::optim(70,function(x) sum(x*x),gr=gradient,method="BFGS")'
  ])('withdraws old caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('does not suppress a cache read using a pre-objective producer', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- stats::optim(70,objective)\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive a producer from a lazy optimization argument', async () => {
    const source =
      'result <- stats::optim(70,objective,extra=base::saveRDS(c(1,2),"cache.rds"))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('preserves cache proof when the optimization closure is not called', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\npath <- "old.txt"\nlater <- function() stats::optim(70,objective)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves caller paths for a local pure replacement', async () => {
    const source =
      'optim <- function(...) 1\npath <- "old.txt"\nresult <- optim(70,objective)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
  })
  it('preserves a literal path assigned after optimization', async () => {
    const source =
      'result <- stats::optim(70,objective)\npath <- "after.txt"\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('after.txt')
  })
  it('withdraws caller collection paths after optimization', async () => {
    const source =
      'paths <- c("old.txt","other.txt")\nresult <- stats::optim(70,objective)\nbase::readLines(paths[1])'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it.each([false, true])('keeps failed objective history uncertain (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path <- "old.txt"', 'result <- stats::optim(70,objective)'],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
})

describe('R scalar optimization callback file authority', () => {
  it.each([
    'stats::optimize(objective,c(.1,5))',
    'stats::optimize(f=objective,interval=c(.1,5))',
    'optimize(objective,c(.1,5))',
    'stats::optimize(upper=5,f=objective,lower=.1)',
    'stats::optimize(function(x) { path <<- "new.txt"; x*x },c(-1,1))',
    'stats::optimize(objective,c(.1,5),maximum=TRUE)'
  ])('withdraws old caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('does not suppress a cache read using a pre-callback producer', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- stats::optimize(objective,c(.1,5))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive a producer from a lazy scalar optimization argument', async () => {
    const source =
      'result <- stats::optimize(objective,c(.1,5),extra=base::saveRDS(c(1,2),"cache.rds"))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('preserves cache proof when the scalar optimization closure is not called', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\npath <- "old.txt"\nlater <- function() stats::optimize(objective,c(.1,5))\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves caller paths for a local pure replacement', async () => {
    const source =
      'optimize <- function(...) 1\npath <- "old.txt"\nresult <- optimize(objective,c(.1,5))\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
  })
  it('preserves a literal path assigned after scalar optimization', async () => {
    const source =
      'result <- stats::optimize(objective,c(.1,5))\npath <- "after.txt"\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('after.txt')
  })
  it('withdraws caller collection paths after scalar optimization', async () => {
    const source =
      'paths <- c("old.txt","other.txt")\nresult <- stats::optimize(objective,c(.1,5))\nbase::readLines(paths[1])'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it.each([false, true])('keeps failed objective history uncertain (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path <- "old.txt"', 'result <- stats::optimize(objective,c(.1,5))'],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
})

describe('R root-finding callback file authority', () => {
  it.each([
    'stats::uniroot(score,c(20,120))',
    'stats::uniroot(f=score,interval=c(20,120))',
    'uniroot(score,c(20,120))',
    'stats::uniroot(upper=120,f=score,lower=20)',
    'stats::uniroot(function(x) { path <<- "new.txt"; x },c(-1,1))',
    'stats::uniroot(score,c(20,120),f.lower=-1,f.upper=1)'
  ])('withdraws old caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('does not suppress a cache read using a pre-callback producer', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- stats::uniroot(score,c(20,120))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive a producer from a lazy root-finding argument', async () => {
    const source =
      'result <- stats::uniroot(score,c(20,120),extra=base::saveRDS(c(1,2),"cache.rds"))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('preserves cache proof when the root-finding closure is not called', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\npath <- "old.txt"\nlater <- function() stats::uniroot(score,c(20,120))\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves caller paths for a local pure replacement', async () => {
    const source =
      'uniroot <- function(...) 1\npath <- "old.txt"\nresult <- uniroot(score,c(20,120))\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
  })
  it('preserves a literal path assigned after root-finding', async () => {
    const source =
      'result <- stats::uniroot(score,c(20,120))\npath <- "after.txt"\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('after.txt')
  })
  it('withdraws caller collection paths after root-finding', async () => {
    const source =
      'paths <- c("old.txt","other.txt")\nresult <- stats::uniroot(score,c(20,120))\nbase::readLines(paths[1])'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it.each([false, true])(
    'keeps failed root callback history uncertain (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'result <- stats::uniroot(score,c(20,120))'],
        [{}, { status: 'failed' as const, kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
})

describe('R ave grouped callback authority', () => {
  it.each([
    'stats::ave(values,group,FUN=center_group)',
    'stats::ave(values)',
    'ave(x=values,group,FUN=center_group)',
    'stats::ave(values,group,FUN="center_group")',
    'stats::ave(values,group,FUN=function(z) {path <<- "new.txt";z})'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nstats::ave(values,group,FUN=center_group)',
    'stats::ave(x={base::saveRDS(c(1,2),"cache.rds");values},group,FUN=center_group)'
  ])('withdraws producer proof around grouped evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(z) {offset;z}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- stats::ave(values,group,FUN=visit)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- stats::ave(values,group,FUN=function(z) {local_only <- offset;z})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('z')
  })
  it.each([false, true])(
    'keeps failed grouped evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'stats::ave(values,group,FUN=center_group)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() stats::ave(values,group,FUN=center_group)',
      'factory <- stats::ave',
      'ave <- function(...) 1\nave(values,group,FUN=center_group)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'stats::ave(values,group,FUN=center_group)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })

  it.each(['stats::ave(values,group,visit)', 'stats::ave(values,group,FU=visit)'])(
    'does not invoke a grouping argument as FUN: %s',
    async (call) => {
      const { facts } = await analyzeRNotebookSource(
        'offset <- 3\nvisit <- function(z) {offset;z}\nresult <- ' + call
      )
      expect(facts.usedNames).toContain('visit')
      expect(facts.usedNames).not.toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    }
  )
})

describe('R eapply environment callback authority', () => {
  it.each([
    'base::eapply(configs,winsor_fit)',
    'base::eapply(bindings,base::sum,all.names=FALSE,USE.NAMES=FALSE)',
    'base::eapply(bindings,base::sum)',
    'eapply(env=configs,FUN=winsor_fit)',
    'base::eapply(configs,"winsor_fit")',
    'base::eapply(configs,function(alpha) {path <<- "new.txt";alpha})'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::eapply(configs,winsor_fit)',
    'base::eapply(env={base::saveRDS(c(1,2),"cache.rds");configs},FUN=winsor_fit)'
  ])('withdraws producer proof around environment traversal: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting environment result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(alpha) {offset;alpha}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- base::eapply(configs,visit)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- base::eapply(configs,function(alpha) {local_only <- offset;alpha})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('alpha')
  })
  it.each([false, true])(
    'keeps failed environment traversal history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::eapply(configs,winsor_fit)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() base::eapply(configs,winsor_fit)',
      'factory <- base::eapply',
      'eapply <- function(...) 1\neapply(configs,winsor_fit)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::eapply(configs,winsor_fit)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R Position short circuit callback authority', () => {
  it.each([
    'base::Position(crossed,records)',
    'base::Position(base::is.list,records)',
    'Position(f=crossed,x=records)',
    'base::Position("crossed",records)',
    'base::Position(function(record) {path <<- "new.txt";TRUE},records)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::Position(crossed,records)',
    'base::Position(f=crossed,x={base::saveRDS(c(1,2),"cache.rds");records})'
  ])('withdraws producer proof around short circuit scan: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(record) {record$cumulative>=offset}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- base::Position(visit,records)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- base::Position(function(record) {local_only <- offset;TRUE},records)'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('record')
  })
  it.each([false, true])(
    'keeps failed short circuit scan history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::Position(crossed,records)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() base::Position(crossed,records)',
      'factory <- base::Position',
      'Position <- function(...) 1\nPosition(crossed,records)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::Position(crossed,records)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R Find short circuit callback authority', () => {
  it.each([
    'base::Find(crossed,records)',
    'base::Find(base::is.list,records)',
    'Find(f=crossed,x=records)',
    'base::Find("crossed",records)',
    'base::Find(function(record) {path <<- "new.txt";TRUE},records)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::Find(crossed,records)',
    'base::Find(f=crossed,x={base::saveRDS(c(1,2),"cache.rds");records})'
  ])('withdraws producer proof around short circuit scan: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(record) {record$cumulative>=offset}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- base::Find(visit,records)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- base::Find(function(record) {local_only <- offset;TRUE},records)'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('record')
  })
  it.each([false, true])(
    'keeps failed short circuit scan history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::Find(crossed,records)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() base::Find(crossed,records)',
      'factory <- base::Find',
      'Find <- function(...) 1\nFind(crossed,records)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::Find(crossed,records)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R mclapply worker callback authority', () => {
  it.each([
    'parallel::mclapply(lambdas,fit_ridge,mc.cores=1)',
    'parallel::mclapply(inputs,base::sum,mc.cores=1)',
    'mclapply(X=lambdas,FUN=fit_ridge,mc.cores=1)',
    'parallel::mclapply(lambdas,"fit_ridge",mc.cores=1)',
    'parallel::mclapply(lambdas,function(lambda) {path <<- "new.txt";lambda},mc.cores=1)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nparallel::mclapply(lambdas,fit_ridge,mc.cores=1)',
    'parallel::mclapply(X={base::saveRDS(c(1,2),"cache.rds");lambdas},FUN=fit_ridge,mc.cores=1)'
  ])('withdraws producer proof around worker evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting worker result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(lambda) {offset;lambda}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- parallel::mclapply(lambdas,visit,mc.cores=1)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- parallel::mclapply(lambdas,function(lambda) {local_only <- offset;lambda},mc.cores=1)'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('lambda')
  })
  it.each([false, true])(
    'keeps failed worker evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'parallel::mclapply(lambdas,fit_ridge,mc.cores=1)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() parallel::mclapply(lambdas,fit_ridge,mc.cores=1)',
      'factory <- parallel::mclapply',
      'mclapply <- function(...) 1\nmclapply(lambdas,fit_ridge,mc.cores=1)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'parallel::mclapply(lambdas,fit_ridge,mc.cores=1)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R mcmapply paired worker authority', () => {
  it.each([
    'parallel::mcmapply(fit_worker,taus,shifts,mc.cores=1)',
    'parallel::mcmapply(base::sum,inputs,offsets,mc.cores=1)',
    'mcmapply(FUN=fit_worker,tau=taus,shift=shifts,mc.cores=1)',
    'parallel::mcmapply("fit_worker",taus,shifts,mc.cores=1)',
    'parallel::mcmapply(function(a,b) {path <<- "new.txt";a+b},taus,shifts,mc.cores=1)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nparallel::mcmapply(fit_worker,taus,shifts,mc.cores=1)',
    'parallel::mcmapply(FUN=fit_worker,tau={base::saveRDS(c(1,2),"cache.rds");taus},shift=shifts,mc.cores=1)'
  ])('withdraws producer proof around paired worker evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting paired result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(a,b) {a+b+offset}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') +
          'result <- parallel::mcmapply(visit,taus,shifts,mc.cores=1)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- parallel::mcmapply(function(a,b) {local_only <- offset;a+b},taus,shifts,mc.cores=1)'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('a')
  })
  it.each([false, true])(
    'keeps failed paired worker evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'parallel::mcmapply(fit_worker,taus,shifts,mc.cores=1)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() parallel::mcmapply(fit_worker,taus,shifts,mc.cores=1)',
      'factory <- parallel::mcmapply',
      'mcmapply <- function(...) 1\nmcmapply(fit_worker,taus,shifts,mc.cores=1)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'parallel::mcmapply(fit_worker,taus,shifts,mc.cores=1)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R mcMap paired worker authority', () => {
  it.each([
    'parallel::mcMap(fit_worker,taus,shifts,mc.cores=1)',
    'parallel::mcMap(base::sum,inputs,offsets,mc.cores=1)',
    'mcMap(f=fit_worker,tau=taus,shift=shifts,mc.cores=1)',
    'parallel::mcMap("fit_worker",taus,shifts,mc.cores=1)',
    'parallel::mcMap(function(a,b) {path <<- "new.txt";a+b},taus,shifts,mc.cores=1)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nparallel::mcMap(fit_worker,taus,shifts,mc.cores=1)',
    'parallel::mcMap(f=fit_worker,tau={base::saveRDS(c(1,2),"cache.rds");taus},shift=shifts,mc.cores=1)'
  ])('withdraws producer proof around paired worker evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting paired result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(a,b) {a+b+offset}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- parallel::mcMap(visit,taus,shifts,mc.cores=1)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- parallel::mcMap(function(a,b) {local_only <- offset;a+b},taus,shifts,mc.cores=1)'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('a')
  })
  it.each([false, true])(
    'keeps failed paired worker evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'parallel::mcMap(fit_worker,taus,shifts,mc.cores=1)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() parallel::mcMap(fit_worker,taus,shifts,mc.cores=1)',
      'factory <- parallel::mcMap',
      'mcMap <- function(...) 1\nmcMap(fit_worker,taus,shifts,mc.cores=1)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'parallel::mcMap(fit_worker,taus,shifts,mc.cores=1)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R kronecker tensor callback authority', () => {
  it.each([
    'base::kronecker(A,B,scaled_product)',
    'base::kronecker(A,B)',
    'kronecker(X=A,Y=B,FUN=scaled_product)',
    'base::kronecker(A,B,"scaled_product")',
    'base::kronecker(A,B,function(x,y) {path <<- "new.txt";x*y})'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::kronecker(A,B,scaled_product)',
    'base::kronecker(X={base::saveRDS(c(1,2),"cache.rds");A},Y=B,FUN=scaled_product)'
  ])('withdraws producer proof around tensor construction: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting tensor ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(x,y) {offset;x*y}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- base::kronecker(A,B,visit)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- base::kronecker(A,B,function(x,y) {local_only <- offset;x*y})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('x')
  })
  it.each([false, true])(
    'keeps failed tensor construction history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::kronecker(A,B,scaled_product)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() base::kronecker(A,B,scaled_product)',
      'factory <- base::kronecker',
      'kronecker <- function(...) 1\nkronecker(A,B,scaled_product)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::kronecker(A,B,scaled_product)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R dendrapply node callback authority', () => {
  it.each([
    'stats::dendrapply(tree,annotate_node)',
    'dendrapply(X=tree,FUN=annotate_node)',
    'stats::dendrapply(tree,"annotate_node")',
    'stats::dendrapply(tree,function(node) {path <<- "new.txt";node})'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nstats::dendrapply(tree,annotate_node)',
    'stats::dendrapply(X={base::saveRDS(c(1,2),"cache.rds");tree},FUN=annotate_node)'
  ])('withdraws producer proof around node traversal: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting node ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(node) {offset;node}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- stats::dendrapply(tree,visit)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- stats::dendrapply(tree,function(node) {local_only <- offset;node})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('node')
  })
  it.each([false, true])(
    'keeps failed node traversal history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'stats::dendrapply(tree,annotate_node)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() stats::dendrapply(tree,annotate_node)',
      'factory <- stats::dendrapply',
      'dendrapply <- function(...) 1\ndendrapply(tree,annotate_node)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'stats::dendrapply(tree,annotate_node)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R combn callback and subset file authority', () => {
  it.each([
    'utils::combn(xs,2,FUN=pair_slope)',
    'combn(x=xs,m=2,FUN=pair_slope,simplify=FALSE)',
    'utils::combn(FUN=pair_slope,m=2,x=xs)',
    'utils::combn(xs,2,FUN=function(ij) {path <<- "new.txt";ij+offset})',
    'utils::combn(xs,0,FUN=pair_slope)',
    'utils::combn(xs,2,FUN=NULL)',
    'utils::combn(xs,2)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nutils::combn(xs,2,FUN=pair_slope)',
    'utils::combn(x={base::saveRDS(c(1,2),"cache.rds");xs},m=2,FUN=pair_slope)'
  ])('withdraws producer proof around argument traversal: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains lexical captures without certifying callback result ownership', async () => {
    const { facts } = await analyzeRNotebookSource(
      'offset <- 3\npair_slope <- function(ij) ij-offset\nresult <- utils::combn(xs,2,FUN=pair_slope)'
    )
    expect(facts.usedNames).toContain('offset')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.state).toBe('unknown')
  })
  it('keeps inline callback locals out of caller definitions', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- utils::combn(xs,2,FUN=function(ij) {local_only <- ij-offset;local_only})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('ij')
  })
  it.each([false, true])(
    'keeps failed combination history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'utils::combn(xs,2,FUN=pair_slope)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('does not recover captures from a failed helper definition', async () => {
    const context = await fileContext(
      'r',
      ['pair_slope <- function(ij) ij-offset\nstop("after definition")'],
      [{ status: 'failed', kernelDispatched: true }]
    )
    const { facts } = await analyzeRNotebookSource('utils::combn(xs,2,FUN=pair_slope)', context)
    expect(facts.usedNames).toContain('pair_slope')
    expect(facts.usedNames).not.toContain('offset')
    expect(facts.state).toBe('unknown')
  })
  it('retains captures from a completed prior helper definition', async () => {
    const context = await fileContext('r', ['offset <- 3\npair_slope <- function(ij) ij-offset'])
    const { facts } = await analyzeRNotebookSource(
      'result <- utils::combn(xs,2,FUN=pair_slope)',
      context
    )
    expect(facts.usedNames).toContain('offset')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.state).toBe('unknown')
  })
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() utils::combn(xs,2,FUN=pair_slope)',
      'factory <- utils::combn',
      'combn <- function(...) 1\ncombn(xs,2,FUN=pair_slope)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'utils::combn(xs,2,FUN=pair_slope)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R rapply recursive callback file authority', () => {
  it.each([
    'base::rapply(tree,shrink_leaf,how="replace")',
    'rapply(object=tree,f=shrink_leaf,classes="numeric",how="list")',
    'base::rapply(f=shrink_leaf,object=tree,how="unlist")',
    'base::rapply(tree,shrink_leaf)',
    'base::rapply(tree,function(x) {path <<- "new.txt";x+offset},how="replace")'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::rapply(tree,shrink_leaf)',
    'base::rapply(tree,shrink_leaf,deflt={base::saveRDS(c(1,2),"cache.rds");0})'
  ])('withdraws producer proof around argument traversal: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains lexical reads without granting recursive result ownership', async () => {
    const { facts } = await analyzeRNotebookSource(
      'offset <- 3\nshrink_leaf <- function(x) x-offset\nresult <- base::rapply(tree,shrink_leaf,how="replace")'
    )
    expect(facts.usedNames).toContain('offset')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.state).toBe('unknown')
  })
  it('keeps inline callback locals out of caller definitions', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- base::rapply(tree,function(x) {local_only <- x-offset;local_only})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('x')
  })
  it.each([false, true])('keeps failed recursion history conservative (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path <- "old.txt"', 'base::rapply(tree,shrink_leaf,how="replace")'],
      [{}, { status: 'failed', kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
  it('does not recover captures from a failed helper definition', async () => {
    const context = await fileContext(
      'r',
      ['shrink_leaf <- function(x) x-offset\nstop("after definition")'],
      [{ status: 'failed', kernelDispatched: true }]
    )
    const { facts } = await analyzeRNotebookSource('base::rapply(tree,shrink_leaf)', context)
    expect(facts.usedNames).toContain('shrink_leaf')
    expect(facts.usedNames).not.toContain('offset')
    expect(facts.state).toBe('unknown')
  })
  it('retains captures from a completed prior helper definition', async () => {
    const context = await fileContext('r', ['offset <- 3\nshrink_leaf <- function(x) x-offset'])
    const { facts } = await analyzeRNotebookSource(
      'result <- base::rapply(tree,shrink_leaf)',
      context
    )
    expect(facts.usedNames).toContain('offset')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.state).toBe('unknown')
  })
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() base::rapply(tree,shrink_leaf)',
      'factory <- base::rapply',
      'rapply <- function(...) 1\nrapply(tree,shrink_leaf)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::rapply(tree,shrink_leaf)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
  it('does not infer callback purity from a class filter on an unknown tree', async () => {
    const { facts, fileAccess } = await analyzeRNotebookSource(
      'path <- "old.txt"\nresult <- base::rapply(tree,shrink_leaf,classes="numeric",how="replace")\nbase::readLines(path)'
    )
    expect(facts.state).toBe('unknown')
    expect(fileAccess?.reads).toEqual([])
    expect(fileAccess?.unresolvedWrites).toBe(true)
  })
})

describe('R by callback file authority', () => {
  it.each([
    'base::by(xs,groups,compare_group)',
    'by(data=xs,INDICES=groups,FUN=compare_group)',
    'base::by(FUN=compare_group,INDICES=groups,data=xs,simplify=FALSE)',
    'base::by(xs,groups,"compare_group")',
    'base::by(xs,groups,function(x) {path <<- "new.txt";x+offset})'
  ])('withdraws stale caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::by(xs,groups,compare_group)',
    'base::by(xs,groups,compare_group,extra={base::saveRDS(c(1,2),"cache.rds");1})'
  ])('withdraws producer proof, including lazy arguments: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains lexical captures without certifying callback result ownership', async () => {
    const { facts } = await analyzeRNotebookSource(
      'offset <- 3\ncompare_group <- function(x) x+offset\nresult <- base::by(xs,groups,compare_group)'
    )
    expect(facts.usedNames).toContain('offset')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.state).toBe('unknown')
  })
  it('keeps inline callback locals out of caller definitions and ownership', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- base::by(xs,groups,function(x) {local_only <- x+offset;local_only})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('x')
  })
  it.each([false, true])(
    'keeps failed invocation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::by(xs,groups,compare_group)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('does not trust a primitive callback with unknown S3 input dispatch', async () => {
    const { facts, fileAccess } = await analyzeRNotebookSource(
      'path <- "old.txt"\nresult <- base::by(xs,groups,FUN=base::sum)\nbase::readLines(path)'
    )
    expect(facts.state).toBe('unknown')
    expect(fileAccess?.reads).toEqual([])
    expect(fileAccess?.unresolvedWrites).toBe(true)
  })
  it('does not recover callback captures from a failed definition', async () => {
    const context = await fileContext(
      'r',
      ['compare_group <- function(x) x+offset\nstop("after definition")'],
      [{ status: 'failed', kernelDispatched: true }]
    )
    const { facts } = await analyzeRNotebookSource('base::by(xs,groups,compare_group)', context)
    expect(facts.usedNames).toContain('compare_group')
    expect(facts.usedNames).not.toContain('offset')
    expect(facts.state).toBe('unknown')
  })
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() base::by(xs,groups,compare_group)',
      'factory <- base::by',
      'by <- function(...) 1\nby(xs,groups,compare_group)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::by(xs,groups,compare_group)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R replicate expression file authority', () => {
  it.each([
    'base::replicate(4,draw_mean())',
    'replicate(n=4,expr=draw_mean())',
    'base::replicate(expr=draw_mean(),n=4,simplify=FALSE)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nvalue <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::replicate(4,draw_mean())',
    'base::replicate(4,{base::saveRDS(c(1,2),"cache.rds");draw_mean()})'
  ])('withdraws producer proof even after an expression write: %s', async (prefix) => {
    const source = prefix + '\nbase::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('keeps expression locals out of caller definitions, ownership and prior reads', async () => {
    const { facts } = await analyzeRNotebookSource(
      'offset <- 5\nresult <- base::replicate(3,{local_only <- offset+1;local_only})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.state).toBe('unknown')
  })
  it('does not export a locally shadowed caller path', async () => {
    const source =
      'path <- "old.txt"\nvalue <- base::replicate(3,{path <- "new.txt";path})\nbase::readLines(path)'
    const { fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual([])
    expect(fileAccess?.context?.staticStrings ?? []).not.toContainEqual({
      name: 'path',
      value: 'new.txt'
    })
  })
  it('preserves proven helper captures without granting a result contract', async () => {
    const { facts } = await analyzeRNotebookSource(
      'offset <- 5\nstatistic <- function() offset+1\nresult <- base::replicate(3,statistic())'
    )
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).toContain('statistic')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.state).toBe('unknown')
  })
  it('keeps unsupported expression bindings opaque rather than exporting them', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- base::replicate(3,{local_only <- custom();local_only})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.state).toBe('unknown')
  })
  it('evaluates the count argument in the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- base::replicate(n={n_outer <- 3;n_outer},expr={local_only <- offset;local_only})'
    )
    expect(facts.definedNames).toContain('n_outer')
    expect(facts.definedNames).not.toContain('local_only')
  })
  it('preserves local replacements, dormant calls and post-call literal paths', async () => {
    for (const prefix of [
      'replicate <- function(...) 1\nreplicate(3,draw_mean())',
      'later <- function() base::replicate(3,draw_mean())',
      'factory <- base::replicate'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::replicate(3,draw_mean())\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
  it.each([false, true])(
    'keeps failed invocation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::replicate(3,draw_mean())'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'base::replicate(2,attach(list(),name="audit"))',
    'change_path <- function() attach(list(),name="audit")\nbase::replicate(2,change_path())'
  ])('retains search-path negative evidence: %s', async (source) => {
    const context = await fileContext('r', [source])
    expect(context?.rSearchPathUncertain).toBe(true)
  })
  it('does not read nested deferred bodies or export zero-count locals', async () => {
    const { facts } = await analyzeRNotebookSource(
      'a <- base::replicate(2,function() hidden)\nb <- base::replicate(0,{local_only <- offset;local_only})'
    )
    expect(facts.usedNames).not.toContain('hidden')
    expect(facts.definedNames).not.toContain('local_only')
  })
})

describe('R sweep callback file authority', () => {
  it.each([
    'base::sweep(xs,2,centers,deviation)',
    'sweep(x=xs,MARGIN=2,STATS=centers,FUN=deviation)',
    'base::sweep(FUN=deviation,STATS=centers,x=xs,MARGIN=2)',
    'base::sweep(xs,2,centers,"deviation")',
    'base::sweep(xs,2,centers,function(a,b) { path <<- "new.txt"; (a-b)^2 })'
  ])('withdraws stale caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nvalue <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::sweep(xs,2,centers,FUN=deviation)',
    'base::sweep(xs,2,centers,FUN=deviation,extra={base::saveRDS(c(1,2),"cache.rds");1})'
  ])('withdraws producer proof, including lazy arguments: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains the captured exponent without certifying callback return ownership', async () => {
    const { facts } = await analyzeRNotebookSource(
      'power <- 2\ndeviation <- function(a,b) (a-b)^power\nQ <- base::sweep(xs,2,centers,FUN=deviation)'
    )
    expect(facts.usedNames).toContain('power')
    expect(facts.state).toBe('unknown')
    expect(facts.copyOnModifyNames ?? []).not.toContain('Q')
  })
  it('does not invent a capture summary from a failed definition', async () => {
    const context = await fileContext(
      'r',
      ['deviation <- function(a,b) (a-b)^power\nstop("after definition")'],
      [{ status: 'failed', kernelDispatched: true }]
    )
    const { facts } = await analyzeRNotebookSource(
      'Q <- base::sweep(xs,2,centers,FUN=deviation)',
      context
    )
    expect(facts.usedNames).toContain('deviation')
    expect(facts.usedNames).not.toContain('power')
    expect(facts.state).toBe('unknown')
  })
  it('keeps dormant bodies from revoking current file proof', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nlater <- function() base::sweep(xs,2,centers,FUN=deviation)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('does not invoke a sweep function value', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nfactory <- base::sweep\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves a pure local replacement and post-call literal paths', async () => {
    const source =
      'sweep <- function(...) 1\npath <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nsweep(xs,2,centers,FUN=deviation)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::sweep(xs,2,centers,FUN=deviation)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
  it.each([false, true])(
    'keeps failed invocation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::sweep(xs,2,centers,FUN=deviation)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('keeps default and primitive callbacks conservative with unknown input dispatch', async () => {
    for (const call of ['base::sweep(xs,2,centers,FUN="-")', 'base::sweep(xs,2,centers)']) {
      const { facts, fileAccess } = await analyzeRNotebookSource(
        'path <- "old.txt"\nvalue <- ' + call + '\nbase::readLines(path)'
      )
      expect(facts.state).toBe('unknown')
      expect(fileAccess?.reads).toEqual([])
      expect(fileAccess?.unresolvedWrites).toBe(true)
    }
  })
})

describe('R outer callback file authority', () => {
  it.each([
    'base::outer(xs,ys,rbf)',
    'outer(X=xs,Y=ys,FUN=rbf)',
    'base::outer(FUN=rbf,Y=ys,X=xs)',
    'base::outer(xs,ys,"rbf")',
    'base::outer(xs,ys,function(a,b) { path <<- "new.txt"; a+b })'
  ])('withdraws stale caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nvalue <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nbase::outer(xs,ys,FUN=rbf)',
    'base::outer(xs,ys,FUN=rbf,extra={base::saveRDS(c(1,2),"cache.rds");1})'
  ])('withdraws serialized producer proof, including lazy arguments: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains bounded lexical captures without certifying callback values or ownership', async () => {
    const { facts } = await analyzeRNotebookSource(
      'h <- 0.5\nrbf <- function(a,b) exp(-0.5*((a-b)/h)^2)\nK <- base::outer(xs,ys,FUN=rbf)'
    )
    expect(facts.usedNames).toContain('h')
    expect(facts.state).toBe('unknown')
    expect(facts.copyOnModifyNames ?? []).not.toContain('K')
  })
  it('retains contextual lexical captures after a failed definition', async () => {
    const context = await fileContext(
      'r',
      ['rbf <- function(a,b) exp(-0.5*((a-b)/h)^2)\nstop("after definition")'],
      [{ status: 'failed', kernelDispatched: true }]
    )
    const { facts } = await analyzeRNotebookSource('K <- base::outer(xs,ys,FUN=rbf)', context)
    expect(facts.usedNames).toContain('rbf')
    // A failed definition is not a completed callback summary; do not invent h.
    expect(facts.state).toBe('unknown')
  })
  it('keeps deferred bodies from revoking current file proof', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nlater <- function() base::outer(xs,ys,FUN=rbf)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves a pure local replacement and post-call literal paths', async () => {
    const source =
      'outer <- function(...) 1\npath <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nouter(xs,ys,FUN=rbf)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::outer(xs,ys,FUN=rbf)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
  it.each([false, true])(
    'keeps failed invocation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::outer(xs,ys,FUN=rbf)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('does not certify unknown input dispatch with a built-in callback or the product default', async () => {
    for (const call of ['base::outer(xs,ys,FUN="+")', 'base::outer(xs,ys)']) {
      const { facts, fileAccess } = await analyzeRNotebookSource(
        'path <- "old.txt"\nvalue <- ' + call + '\nbase::readLines(path)'
      )
      expect(facts.state).toBe('unknown')
      expect(fileAccess?.reads).toEqual([])
      expect(fileAccess?.unresolvedWrites).toBe(true)
    }
  })
})

describe('R apply callback file authority', () => {
  it.each([
    'base::apply(counts,1,diversity)',
    'apply(X=counts,MARGIN=1,FUN=diversity)',
    'base::apply(FUN=diversity,X=counts,MARGIN=2,simplify=FALSE)',
    'base::apply(counts,1,function(v) { path <<- "new.txt"; sum(v) })',
    'base::apply(counts,1,"diversity")'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('revokes prior and nested serialized producer proof', async () => {
    for (const source of [
      'base::saveRDS(c(1,2),"cache.rds")\nbase::apply(counts,1,diversity)\nbase::readRDS("cache.rds")',
      'base::apply(counts,1,diversity,extra={base::saveRDS(c(1,2),"cache.rds");1})\nbase::readRDS("cache.rds")'
    ]) {
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
    }
  })
  it('retains lexical callback reads', async () => {
    expect(
      (
        await analyzeRNotebookSource(
          'offset <- 2\nformatter <- function(v) sum(v)+offset\nbase::apply(counts,1,formatter)'
        )
      ).facts.usedNames
    ).toContain('offset')
  })
  it('keeps dormant callback bodies from revoking proof', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nlater <- function() base::apply(counts,1,diversity)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves local replacements and post-call literal paths', async () => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'apply <- function(...) 1\npath <- "old.txt"\napply(counts,1,diversity)\nbase::readLines(path)'
        )
      ).reads
    ).toContain('old.txt')
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::apply(counts,1,diversity)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toContain('after.txt')
  })
  it.each([false, true])(
    'keeps failed history conservative (precompute=%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'base::apply(counts,1,diversity)'],
        [{}, { status: 'failed' as const, kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each(['function(v) sum(v)', 'function(v) length(v)'])(
    'preserves an already proven callback on a closed matrix: %s',
    async (callback) => {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nbase::apply(matrix(1:6,nrow=2),1,' +
        callback +
        ')\nbase::readLines(path)'
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        reads: ['old.txt']
      })
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
  )
  it('preserves a contextual proven callback on a closed matrix', async () => {
    const context = await fileContext('r', ['formatter <- function(v) sum(v)'])
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nbase::apply(matrix(1:6,nrow=2),1,formatter)\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['old.txt']
    })
  })
  it('does not widen the existing mean or result ownership contract', async () => {
    const source =
      'path <- "old.txt"\nresult <- base::apply(matrix(1:6,nrow=2),1,function(v) mean(v))\nbase::readLines(path)'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(facts.state).toBe('unknown')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(fileAccess?.reads).toEqual([])
  })
  it.each(['base::readRDS("counts.rds")', 'structure(matrix(1:6,nrow=2),class="custom")'])(
    'keeps input coercion uncertain despite a read-only callback: %s',
    async (input) => {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nbase::apply(' +
        input +
        ',1,sum)\nbase::readLines(path)\nbase::readRDS("cache.rds")'
      const { facts, fileAccess } = await analyzeRNotebookSource(source)
      expect(fileAccess?.reads).not.toContain('old.txt')
      expect(fileAccess?.reads).toContain('cache.rds')
      expect(fileAccess?.unresolvedWrites).toBe(true)
      expect(facts.serializedValueWrites ?? []).toEqual([])
    }
  )
  it('does not borrow an identical earlier call proof after rebinding', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nformatter <- function(v) sum(v)\nbase::apply(matrix(1:6,nrow=2),1,formatter)\nformatter <- function(v) { path <<- "new.txt"; v }\nbase::apply(matrix(1:6,nrow=2),1,formatter)\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
  it('withdraws proof inside a data mask', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\ndplyr::mutate(frame,z=base::apply(counts,1,diversity))\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
})

describe.each(['mapply', 'Map'])('R %s callback file authority', (mapper) => {
  const call = (callback = 'statistic', extra = ''): string =>
    `base::${mapper}(${mapper === 'mapply' ? 'FUN' : 'f'}=${callback},xs,ys${extra})`
  it.each(['positional', 'named', 'inline', 'string'])(
    'withdraws caller paths for an unproved %s callback',
    async (kind) => {
      const callback =
        kind === 'inline'
          ? 'function(a,b) { path <<- "new.txt"; a }'
          : kind === 'string'
            ? '"statistic"'
            : 'statistic'
      const expression = kind === 'positional' ? `base::${mapper}(statistic,xs,ys)` : call(callback)
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          'path <- "old.txt"\nresult <- ' + expression + '\nbase::readLines(path)'
        )
      ).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reads: []
      })
    }
  )
  it('revokes producer and definite-writer authority', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- ' + call() + '\nbase::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive proof from a lazy extra argument', async () => {
    const source =
      'result <- ' +
      call('statistic', ',extra={base::saveRDS(c(1,2),"cache.rds");1}') +
      '\nbase::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains lexical callback reads', async () => {
    expect(
      (
        await analyzeRNotebookSource(
          'offset <- 2\nstatistic <- function(a,b) sum(a,b)+offset\nresult <- ' + call()
        )
      ).facts.usedNames
    ).toContain('offset')
  })
  it('preserves authority when a callback is deferred', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nlater <- function() ' +
      call() +
      '\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves later literals and local pure replacements', async () => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'result <- ' + call() + '\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toContain('after.txt')
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          mapper +
            ' <- function(...) 1\npath <- "old.txt"\nresult <- ' +
            call().replace('base::', '') +
            '\nbase::readLines(path)'
        )
      ).reads
    ).toContain('old.txt')
  })
  it.each([false, true])(
    'keeps failed history conservative (precompute=%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'result <- ' + call()],
        [{}, { status: 'failed' as const, kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves a proven contextual read-only callback', async () => {
    const context = await fileContext('r', [
      'offset <- 2\nformatter <- function(a,b) sum(a,b)+offset'
    ])
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- ' +
      call('formatter').replace('xs', '1:3').replace('ys', '4:6') +
      '\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['old.txt']
    })
    expect(
      (await analyzeRNotebookSource(source, context)).facts.serializedValueWrites
    ).toHaveLength(1)
  })
  it('preserves a closed arithmetic callback', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- ' +
      call('function(a,b) round(a+b)').replace('xs', '1:3').replace('ys', '4:6') +
      '\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['old.txt']
    })
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('does not borrow an identical earlier call proof after rebinding', async () => {
    const expression = call('formatter').replace('xs', '1:3').replace('ys', '4:6')
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nformatter <- function(a,b) round(a+b)\nresult <- ' +
      expression +
      '\nformatter <- function(a,b) { path <<- "new.txt"; a }\nresult <- ' +
      expression +
      '\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
  it('withdraws proof inside a data mask', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- dplyr::mutate(frame,z=' +
      call() +
      ')\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
})

describe('R Reduce callback file authority', () => {
  it.each([
    'base::Reduce(step,values,init=initial,accumulate=TRUE)',
    'Reduce(f=step,x=values,init=initial)',
    'base::Reduce(x=values,f=step,init=initial,right=TRUE)',
    'base::Reduce(function(a,b) { path <<- "new.txt"; a },values,init=initial)',
    'base::Reduce("step",values,init=initial)'
  ])('withdraws prior caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('revokes prior producer proof and restores a cache read candidate', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- base::Reduce(step,values,init=initial)\nbase::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive proof from a lazy initial value', async () => {
    const source =
      'result <- base::Reduce(step,values,init=base::saveRDS(c(1,2),"cache.rds"))\nbase::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains lexical reducer dependencies', async () => {
    const source =
      'offset <- 2\nstep <- function(a,b) sum(a,b)+offset\nresult <- base::Reduce(step,values,init=0)'
    expect((await analyzeRNotebookSource(source)).facts.usedNames).toContain('offset')
  })
  it('keeps deferred reductions from revoking proof', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nlater <- function() base::Reduce(step,values,init=initial)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves later literals and local pure replacements', async () => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'result <- base::Reduce(step,values)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toContain('after.txt')
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'Reduce <- function(...) 1\npath <- "old.txt"\nresult <- Reduce(step,values)\nbase::readLines(path)'
        )
      ).reads
    ).toContain('old.txt')
  })
  it.each([false, true])('keeps failed history uncertain (precompute=%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path <- "old.txt"', 'result <- base::Reduce(step,values,init=initial)'],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
  it('keeps identical later calls conservative after callback rebinding', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nstep <- function(a,b) round(a+b)\nresult <- base::Reduce(step,1:3,init=0)\nstep <- function(a,b) { path <<- "new.txt"; a }\nresult <- base::Reduce(step,1:3,init=0)\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
  it('withdraws proof inside a data mask', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- dplyr::mutate(frame,z=base::Reduce(step,x,init=initial))\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
  it('preserves a contextual proven read-only reducer', async () => {
    const context = await fileContext('r', ['offset <- 2\nstep <- function(a,b) sum(a,b)+offset'])
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- base::Reduce(step,1:3,init=0)\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['old.txt']
    })
    expect(
      (await analyzeRNotebookSource(source, context)).facts.serializedValueWrites
    ).toHaveLength(1)
  })
  it('preserves a directly proven arithmetic reducer', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- base::Reduce(function(a,b) round(a+b),1:3,init=0)\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['old.txt']
    })
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves the existing bounded set-reduction contract', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nsets <- list(c("a","b"),c("b","c"))\nresult <- base::Reduce(union,sets)\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['old.txt']
    })
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
})

describe.each(['sapply', 'vapply'])('R %s callback file authority', (mapper) => {
  const call = (callback = 'statistic', extra = ''): string =>
    `base::${mapper}(indices,FUN=${callback}${mapper === 'vapply' ? ',FUN.VALUE=numeric(1)' : ''}${extra})`
  it.each(['plain', 'named', 'inline', 'string'])(
    'withdraws caller paths for an unproved %s callback',
    async (kind) => {
      const callback =
        kind === 'inline'
          ? 'function(x) { path <<- "new.txt"; x }'
          : kind === 'string'
            ? '"statistic"'
            : 'statistic'
      const expression =
        kind === 'named' ? call(callback).replace('(indices,', '(X=indices,') : call(callback)
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          'path <- "old.txt"\nresult <- ' + expression + '\nbase::readLines(path)'
        )
      ).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reads: []
      })
    }
  )
  it('revokes prior serialized producer and definite-writer proof', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- ' + call() + '\nbase::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive proof from a nested lazy argument', async () => {
    const source =
      'result <- ' +
      call('statistic', ',extra=base::saveRDS(c(1,2),"cache.rds")') +
      '\nbase::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains lexical callback reads', async () => {
    const source = 'offset <- 2\nstatistic <- function(x) sum(x)+offset\nresult <- ' + call()
    expect((await analyzeRNotebookSource(source)).facts.usedNames).toContain('offset')
  })
  it('keeps dormant callbacks from revoking proof', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\npath <- "old.txt"\nlater <- function() ' +
      call() +
      '\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves later literal paths and local pure replacements', async () => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'result <- ' + call() + '\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toContain('after.txt')
    const source =
      mapper +
      ' <- function(...) 1\npath <- "old.txt"\nresult <- ' +
      call().replace('base::', '') +
      '\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
  })
  it.each([false, true])(
    'keeps failed map history conservative (precompute=%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'result <- ' + call()],
        [{}, { status: 'failed' as const, kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves a contextual verified read-only callback', async () => {
    const context = await fileContext('r', [
      'factor <- 2\nformatter <- function(x) round(x*factor)'
    ])
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nvalues <- ' +
      call('formatter').replace('indices', '1:3') +
      '\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['old.txt']
    })
    expect(
      (await analyzeRNotebookSource(source, context)).facts.serializedValueWrites
    ).toHaveLength(1)
  })
  it('does not reuse earlier call proof after callback rebinding', async () => {
    const expression = call('formatter').replace('indices', '1:3')
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nformatter <- function(x) round(x)\nresult <- ' +
      expression +
      '\nformatter <- function(x) { path <<- "new.txt"; x }\nresult <- ' +
      expression +
      '\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
  it('withdraws proof inside a data mask', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- dplyr::mutate(frame,z=' +
      call() +
      ')\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
})

describe('R lapply callback file authority', () => {
  it.each([
    'base::lapply(indices,FUN=statistic)',
    'base::lapply(X=indices,FUN=statistic)',
    'lapply(indices,statistic)',
    'base::lapply(FUN=statistic,X=indices)',
    'base::lapply(indices,function(x) { path <<- "new.txt"; sum(x) })',
    'base::lapply(indices,FUN="statistic")'
  ])('withdraws old caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('preserves callback lexical reads while revoking file proof', async () => {
    const source =
      'offset <- 2\nstatistic <- function(x) sum(x)+offset\nresult <- base::lapply(indices,FUN=statistic)'
    expect((await analyzeRNotebookSource(source)).facts.usedNames).toContain('offset')
  })
  it('does not suppress a cache read using a pre-callback producer', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- base::lapply(indices,FUN=statistic)\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive a producer from a lazy iteration argument', async () => {
    const source =
      'result <- base::lapply(indices,FUN=statistic,extra=base::saveRDS(c(1,2),"cache.rds"))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('preserves cache proof when the iteration closure is not called', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\npath <- "old.txt"\nlater <- function() base::lapply(indices,FUN=statistic)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves caller paths for a local pure replacement', async () => {
    const source =
      'lapply <- function(...) 1\npath <- "old.txt"\nresult <- lapply(indices,statistic)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
  })
  it('preserves a literal path assigned after iteration', async () => {
    const source =
      'result <- base::lapply(indices,FUN=statistic)\npath <- "after.txt"\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('after.txt')
  })
  it('withdraws caller collection paths after iteration', async () => {
    const source =
      'paths <- c("old.txt","other.txt")\nresult <- base::lapply(indices,FUN=statistic)\nbase::readLines(paths[1])'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it.each([false, true])('keeps failed callback history uncertain (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path <- "old.txt"', 'result <- base::lapply(indices,FUN=statistic)'],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
  it('does not reuse proof from an identical earlier call after rebinding', async () => {
    const source = [
      'path <- "old.txt"',
      'base::saveRDS(c(1,2),"cache.rds")',
      'formatter <- function(x) round(x)',
      'values <- base::lapply(1:3,formatter)',
      'formatter <- function(x) { path <<- "new.txt"; x }',
      'values <- base::lapply(1:3,formatter)',
      'base::readLines(path)',
      'base::readRDS("cache.rds")'
    ].join('\n')
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(fileAccess?.unresolvedReads).toBe(true)
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not reuse a contextual callback summary after local replacement', async () => {
    const context = await fileContext('r', ['formatter <- function(x) round(x)'])
    const source =
      'path <- "old.txt"\nformatter <- opaque\nvalues <- base::lapply(1:3,formatter)\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      reads: []
    })
  })
  it('withdraws file authority for an unproved callback inside a data mask', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- dplyr::mutate(frame,z=base::lapply(x,statistic))\nbase::readLines(path)\nbase::readRDS("cache.rds")'
    const { facts, fileAccess } = await analyzeRNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['cache.rds'])
    expect(fileAccess?.unresolvedWrites).toBe(true)
    expect(facts.serializedValueWrites ?? []).toEqual([])
  })
  it('retains a bounded file-reader map', async () => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nvalues <- base::lapply(c("a.txt","b.txt"),base::readLines)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([
      'a.txt',
      'b.txt',
      'old.txt'
    ])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('retains a verified read-only callback on ordinary numeric inputs', async () => {
    const context = await fileContext('r', [
      'factor <- 2\nformatter <- function(x) round(x*factor)'
    ])
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nvalues <- lapply(1:3,formatter)\nbase::readLines(path)'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['old.txt']
    })
    expect(
      (await analyzeRNotebookSource(source, context)).facts.serializedValueWrites
    ).toHaveLength(1)
  })
})

describe('R aggregate callback file authority', () => {
  it.each([
    'stats::aggregate(c(1,2),list(g=c(1,1)),FUN=reduce_group)',
    'stats::aggregate(x=c(1,2),by=list(g=c(1,1)),FUN=reduce_group)',
    'aggregate(c(1,2),list(g=c(1,1)),reduce_group)',
    'stats::aggregate(waiting~group,data=frame,FUN=reduce_group)',
    'stats::aggregate(c(1,2),list(g=c(1,1)),FUN=function(x) { path <<- "new.txt"; sum(x) })',
    'stats::aggregate(c(1,2),list(g=c(1,1)),FUN="reduce_group")'
  ])('withdraws old caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('preserves callback lexical reads while revoking file proof', async () => {
    const source =
      'offset <- 2\nreduce_group <- function(x) sum(x)+offset\nresult <- stats::aggregate(c(1,2),list(g=c(1,1)),FUN=reduce_group)'
    expect((await analyzeRNotebookSource(source)).facts.usedNames).toContain('offset')
  })
  it('does not suppress a cache read using a pre-reducer producer', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- stats::aggregate(c(1,2),list(g=c(1,1)),FUN=reduce_group)\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive a producer from a lazy aggregation argument', async () => {
    const source =
      'result <- stats::aggregate(c(1,2),list(g=c(1,1)),FUN=reduce_group,extra=base::saveRDS(c(1,2),"cache.rds"))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('preserves cache proof when the aggregation closure is not called', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\npath <- "old.txt"\nlater <- function() stats::aggregate(c(1,2),list(g=c(1,1)),FUN=reduce_group)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves caller paths for a local pure replacement', async () => {
    const source =
      'aggregate <- function(...) 1\npath <- "old.txt"\nresult <- aggregate(c(1,2),list(g=c(1,1)),reduce_group)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
  })
  it('preserves a literal path assigned after aggregation', async () => {
    const source =
      'result <- stats::aggregate(c(1,2),list(g=c(1,1)),FUN=reduce_group)\npath <- "after.txt"\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('after.txt')
  })
  it('withdraws caller collection paths after aggregation', async () => {
    const source =
      'paths <- c("old.txt","other.txt")\nresult <- stats::aggregate(c(1,2),list(g=c(1,1)),FUN=reduce_group)\nbase::readLines(paths[1])'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it.each([false, true])('keeps failed reducer history uncertain (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path <- "old.txt"', 'result <- stats::aggregate(c(1,2),list(g=c(1,1)),FUN=reduce_group)'],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
})

describe('R integration callback file authority', () => {
  it.each([
    'stats::integrate(kernel,-Inf,Inf)',
    'stats::integrate(f=kernel,lower=-Inf,upper=Inf)',
    'integrate(kernel,-Inf,Inf)',
    'stats::integrate(upper=Inf,f=kernel,lower=-Inf)',
    'stats::integrate(function(x) { path <<- "new.txt"; x*x },0,1)',
    'stats::integrate("kernel",0,1)'
  ])('withdraws old caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('does not suppress a cache read using a pre-integrand producer', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- stats::integrate(kernel,0,1)\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive a producer from a lazy integration argument', async () => {
    const source =
      'result <- stats::integrate(kernel,0,1,extra=base::saveRDS(c(1,2),"cache.rds"))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('preserves cache proof when the integration closure is not called', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\npath <- "old.txt"\nlater <- function() stats::integrate(kernel,0,1)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('preserves caller paths for a local pure replacement', async () => {
    const source =
      'integrate <- function(...) 1\npath <- "old.txt"\nresult <- integrate(kernel,0,1)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
  })
  it('preserves a literal path assigned after integration', async () => {
    const source =
      'result <- stats::integrate(kernel,0,1)\npath <- "after.txt"\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('after.txt')
  })
  it('withdraws caller collection paths after integration', async () => {
    const source =
      'paths <- c("old.txt","other.txt")\nresult <- stats::integrate(kernel,0,1)\nbase::readLines(paths[1])'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it.each([false, true])('keeps failed integrand history uncertain (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path <- "old.txt"', 'result <- stats::integrate(kernel,0,1)'],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
})

describe('R tapply callback file authority', () => {
  it.each([
    'base::tapply(c(1,2),c(1,2),FUN=reduce_group)',
    'tapply(c(1,2),c(1,2),reduce_group)',
    'base::tapply(INDEX=c(1,2),FUN=reduce_group,X=c(1,2))',
    'base::tapply(c(1,2),c(1,2),FU=reduce_group)',
    'base::tapply(c(1,2),c(1,2),FUN="reduce_group")',
    'base::tapply(c(1,2),c(1,2),FUN=function(x) { path <<- "new.txt"; base::mean(x) })'
  ])('withdraws old caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it.each(['', ',FUN=NULL'])(
    'preserves paths when tapply only returns group indices: %s',
    async (options) => {
      const source =
        'path <- "old.txt"\nresult <- base::tapply(c(1,2),c(1,2)' +
        options +
        ')\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
    }
  )
  it('does not treat a local replacement as base tapply', async () => {
    const source =
      'tapply <- function(...) 1\npath <- "old.txt"\nresult <- tapply(c(1,2),c(1,2),FUN=reduce_group)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('old.txt')
  })
  it('withdraws static collections as well as scalar paths', async () => {
    const source =
      'paths <- c("old.txt","other.txt")\nresult <- base::tapply(c(1,2),c(1,2),FUN=reduce_group)\nbase::readLines(paths[1])'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it('does not suppress a cache read using a pre-callback writer', async () => {
    const source =
      'base::saveRDS(c(1,2),"cache.rds")\nresult <- base::tapply(c(1,2),c(1,2),FUN=reduce_group)\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not revive a producer written by a nested callback argument', async () => {
    const source =
      'result <- base::tapply(c(1,2),c(1,2),FUN=reduce_group,extra=base::saveRDS(c(1,2),"cache.rds"))\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
  })
  it.each([false, true])('keeps failed callback history uncertain (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path <- "old.txt"', 'result <- base::tapply(c(1,2),c(1,2),FUN=reduce_group)'],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
})

describe('Pearson resampling callback boundaries', () => {
  it.each([
    'stats.pearsonr(x,y,method=method)',
    'stats.pearsonr(x,y,method=stats.MonteCarloMethod(rvs=(draw_x,draw_y)))',
    'stats.pearsonr(x,y,method=stats.PermutationMethod())',
    'stats.pearsonr(x,y,**options)',
    'stats.pearsonr(*args)',
    'stats.pearsonr(x,y,None)',
    'stats.pearsonr(x,y,method=None,**options)'
  ])('does not close callback I/O or caller paths: %s', async (call) => {
    const source = 'from scipy import stats\npath="old.txt"\nresult=' + call + '\nopen(path)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it.each(['', ',method=None'])(
    'preserves the default analytic Pearson path: %s',
    async (options) => {
      const source =
        'from scipy import stats\npath="old.txt"\nresult=stats.pearsonr(x,y' +
        options +
        ')\nopen(path)'
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        writeState: 'complete',
        externalState: 'complete',
        reads: ['old.txt']
      })
    }
  )
  it('withdraws serialized content proof after resampling', async () => {
    const source =
      'import numpy as np\nfrom scipy import stats\nnp.save("cache.npy",np.array([1.,2.]))\n' +
      'result=stats.pearsonr(x,y,method=method)\nafter=np.load("cache.npy")'
    const facts = (await analyzePythonNotebookSource(source)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
  it.each([
    'from scipy.stats import pearsonr as correlate\nresult=correlate(x,y,method=method)',
    'from scipy import stats\ndef correlate():\n    return stats.pearsonr(x,y,method=method)\nresult=correlate()'
  ])('keeps the boundary across aliases and helpers: %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', 'path="old.txt"\n' + call + '\nopen(path)')
    ).toMatchObject({ writeState: 'partial', externalState: 'partial', reads: [] })
  })
  it('does not assume an unproved resampling call is pure', async () => {
    const source = 'path="old.txt"\nresult=pearsonr(x,y,method=method)\nopen(path)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it('does not infer SciPy identity for a local pure replacement', async () => {
    const source =
      'def pearsonr(*args,**kwargs):\n    return 1\npath="old.txt"\nresult=pearsonr(x,y,method=method)\nopen(path)'
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('old.txt')
  })
  it.each([false, true])('keeps failed resampling uncertain (%s)', async (precompute) => {
    const context = await fileContext(
      'python',
      ['path="old.txt"', 'from scipy import stats\nresult=stats.pearsonr(x,y,method=method)'],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect((await analyzeNotebookSourceFileAccess('python', 'open(path)', context)).reads).toEqual(
      []
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
  })
})

describe('NumPy text converter caller path boundaries', () => {
  it.each([
    'np.loadtxt(input_path,converters={0:convert})',
    'np.loadtxt(fname=input_path,converters=convert)',
    'np.genfromtxt(input_path,converters={0:convert})',
    'np.genfromtxt(fname=input_path,converters={0:convert})',
    'np.loadtxt(input_path,float,"#",None,{0:convert})',
    'np.genfromtxt(input_path,float,"#",None,0,0,{0:convert})'
  ])('keeps the evaluated input but withdraws downstream paths: %s', async (call) => {
    const source =
      'import numpy as np\ninput_path="input.txt"\npath="old.txt"\nresult=' + call + '\nopen(path)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['input.txt']
    })
    expect((await analyzePythonNotebookSource(source)).facts.state).toBe('unknown')
  })
  it.each(['loadtxt', 'genfromtxt'])(
    'does not restore caller paths after %s helper replay',
    async (reader) => {
      const source =
        'import numpy as np\npath="old.txt"\ndef read(path):\n    return np.' +
        reader +
        '(path,converters={0:convert})\nresult=read("input.txt")\nopen(path)'
      const io = await analyzeNotebookSourceFileAccess('python', source)
      expect(io.reads).toContain('input.txt')
      expect(io.reads).not.toContain('old.txt')
      expect(io).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('withdraws path collections and mappings after conversion', async () => {
    const source =
      'import numpy as np\npaths=["old.txt"]\noptions={"path":"before.txt"}\n' +
      'result=np.loadtxt("input.txt",converters={0:convert})\nopen(paths[0])\nopen(options["path"])'
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual(['input.txt'])
  })
  it.each(['loadtxt', 'genfromtxt'])(
    'preserves paths with an empty %s converter map',
    async (reader) => {
      const source =
        'import numpy as np\npath="old.txt"\nresult=np.' +
        reader +
        '("input.txt",converters={})\nopen(path)'
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        reads: ['input.txt', 'old.txt']
      })
    }
  )
  it('preserves a path assigned after the converter', async () => {
    const source =
      'import numpy as np\nresult=np.loadtxt("input.txt",converters={0:convert})\n' +
      'path="after.txt"\nopen(path)'
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([
      'after.txt',
      'input.txt'
    ])
  })
  it.each([false, true])('keeps failed converter history uncertain (%s)', async (precompute) => {
    const context = await fileContext(
      'python',
      [
        'path="old.txt"',
        'import numpy as np\nresult=np.loadtxt("input.txt",converters={0:convert})'
      ],
      [{}, { status: 'failed' as const, kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect((await analyzeNotebookSourceFileAccess('python', 'open(path)', context)).reads).toEqual(
      []
    )
  })
})

describe('Scientific callback caller path boundaries', () => {
  it.each(['quad(model,0.,1.)', 'integrate.quad(model,0.,1.)'])(
    'withdraws paths when callback identity is unavailable: %s',
    async (call) => {
      const source = 'path="old.txt"\nresult=' + call + '\nopen(path)'
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reads: []
      })
      expect((await analyzePythonNotebookSource(source)).facts.state).toBe('unknown')
    }
  )
  it.each([false, true])(
    'does not revive paths after callback import proof is lost (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        ['from scipy.integrate import quad', 'raise RuntimeError()'],
        [{}, { status: 'failed' as const, kernelDispatched: true }],
        precompute
      )
      const source = 'path="old.txt"\nresult=quad(model,0.,1.)\nopen(path)'
      expect(
        (await analyzeNotebookSourceFileAccess('python', source, context)).reads
      ).not.toContain('old.txt')
    }
  )
  it('does not treat a local constant function as SciPy', async () => {
    const source =
      'def quad(*args):\n    return 1\npath="old.txt"\nresult=quad(model,0.,1.)\nopen(path)'
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('old.txt')
  })
  it.each([
    'from scipy.integrate import quad\nresult=quad(model,0.,1.)',
    'from scipy.integrate import quad as integrate\nresult=integrate(func=model,a=0.,b=1.)',
    'from scipy import integrate\nresult=integrate.solve_ivp(model,[0.,1.],[1.])',
    'from scipy import optimize\nresult=optimize.root_scalar(model,bracket=[0.,1.])',
    'from scipy import optimize\nresult=optimize.curve_fit(model,[0.,1.],[1.,2.])',
    'from scipy import optimize\nresult=optimize.least_squares(model,[1.])',
    'from scipy import ndimage\nresult=ndimage.generic_filter([1.,2.,3.],model,size=3)',
    'from scipy import stats\nresult=stats.binned_statistic([1.,2.],[3.,4.],statistic=model)',
    'from scipy import signal\nresult=signal.welch([1.,2.,3.,4.],nperseg=4,detrend=model)'
  ])('does not certify a pre-callback caller path: %s', async (call) => {
    const source = 'path="old.txt"\n' + call + '\nopen(path)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
  })
  it.each([
    'from scipy.integrate import quad\ndef calculate():\n    return quad(model,0.,1.)\nresult=calculate()',
    'from scipy import integrate\ndef calculate():\n    return integrate.quad(model,0.,1.)\nresult=calculate()'
  ])('keeps callback revocation through local helper replay: %s', async (call) => {
    expect(
      (await analyzeNotebookSourceFileAccess('python', 'path="old.txt"\n' + call + '\nopen(path)'))
        .reads
    ).not.toContain('old.txt')
  })
  it.each([
    'from scipy import signal\nresult=signal.welch([1.,2.,3.,4.],nperseg=4,detrend=False)',
    'from scipy import stats\nresult=stats.binned_statistic([1.,2.],[3.,4.],statistic="mean")',
    'from scipy.integrate import quad\ndef later():\n    return quad(model,0.,1.)'
  ])('keeps paths when the audited callback does not run: %s', async (call) => {
    expect(
      (await analyzeNotebookSourceFileAccess('python', 'path="old.txt"\n' + call + '\nopen(path)'))
        .reads
    ).toContain('old.txt')
  })
  it.each([false, true])(
    'preserves uncertainty after a failed callback (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        ['path="old.txt"', 'from scipy.integrate import quad\nresult=quad(model,0.,1.)'],
        [{}, { status: 'failed' as const, kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('python', 'open(path)', context)).reads
      ).not.toContain('old.txt')
    }
  )
})

describe('Spearman NumPy scientific delegate boundaries', () => {
  const tainted: NotebookSourceFileAccessContext = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonTaintedNamespaces: ['numpy']
  }
  it.each([
    'from scipy import stats\nresult=stats.spearmanr([1.,2.,3.],[3.,1.,2.])',
    'from scipy.stats import spearmanr as correlate\nresult=correlate([1.,2.,3.],[3.,1.,2.])',
    'from scipy import stats\nresult=stats.spearmanr(a=[1.,2.,3.],b=[3.,1.,2.])',
    'from scipy import stats\nresult=stats.spearmanr(x,y,nan_policy="omit")',
    'from scipy.stats import spearmanr\ndef correlate(x,y):\n    return spearmanr(x,y)\nresult=correlate([1.,2.,3.],[3.,1.,2.])',
    'from scipy import stats\ndef correlate(x,y):\n    return stats.spearmanr(x,y)\nresult=correlate([1.,2.,3.],[3.,1.,2.])'
  ])('withdraws caller paths across scientific NumPy dispatch: %s', async (call) => {
    const source = 'path="old.txt"\n' + call + '\nopen(path)'
    expect(await analyzeNotebookSourceFileAccess('python', source, tainted)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: []
    })
    expect((await analyzePythonNotebookSource(source, tainted)).facts.state).toBe('unknown')
  })
  it.each(['np.corrcoef=replacement', 'setattr(np,"corrcoef",replacement)'])(
    'does not revive same-cell paths after %s',
    async (mutation) => {
      const source =
        'import numpy as np\nfrom scipy import stats\n' +
        mutation +
        '\npath="old.txt"\nresult=stats.spearmanr([1.,2.,3.],[3.,1.,2.])\nopen(path)'
      const io = await analyzeNotebookSourceFileAccess('python', source)
      expect(io.reads).not.toContain('old.txt')
      expect(io).toMatchObject({ writeState: 'partial', externalState: 'partial' })
    }
  )
  it.each([false, true])(
    'retains failed NumPy dispatch uncertainty on replay (%s)',
    async (precompute) => {
      const scripts = [
        'import numpy as np',
        'np.corrcoef=replacement\nraise RuntimeError()',
        'path="old.txt"'
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      const source = 'from scipy import stats\nresult=stats.spearmanr([1.,2.,3.],[3.,1.,2.])'
      expect(
        await analyzeNotebookSourceFileAccess('python', source + '\nopen(path)', context)
      ).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reads: []
      })
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'fresh-epoch'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [],
        writes: []
      })
    }
  )
  it.each([{ namespaces: [] }, { namespaces: ['pandas'] }, { namespaces: ['gzip'] }])(
    'keeps unrelated namespace precision $namespaces',
    async ({ namespaces }) => {
      const source =
        'from scipy import stats\npath="old.txt"\nresult=stats.spearmanr([1.,2.,3.],[3.,1.,2.])\nopen(path)'
      expect(
        await analyzeNotebookSourceFileAccess('python', source, {
          ...tainted,
          pythonTaintedNamespaces: namespaces
        })
      ).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: ['old.txt'],
        writes: []
      })
    }
  )
})

describe('Matrix Market builtin opener boundaries', () => {
  const tainted: NotebookSourceFileAccessContext = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonTaintedNamespaces: ['builtins']
  }
  it.each([
    'from scipy.io import mminfo\nresult=mminfo("input.mtx")',
    'from scipy.io import mminfo as inspect\nresult=inspect(source="input.mtx")',
    'from scipy import io as sio\nresult=sio.mminfo("input.mtx")',
    'from scipy.io import mmread\nresult=mmread("input.mtx")',
    'from scipy.io import mmread as read\ndef reopen(path):\n    return read(path)\nresult=reopen("input.mtx")'
  ])('withdraws path authority across a patched builtin: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('python', call, tainted)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(call, tainted)).facts.state).toBe('unknown')
    const source = 'path="old.txt"\n' + call + '\nopen(path)'
    expect(await analyzeNotebookSourceFileAccess('python', source, tainted)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzeNotebookSourceFileAccess('python', source, tainted)).reads).not.toContain(
      'old.txt'
    )
    expect((await analyzePythonNotebookSource(source, tainted)).facts.state).toBe('unknown')
  })
  it.each([false, true])(
    'retains failed builtin replacement across replay (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        ['import builtins\nbuiltins.open=replacement\nraise RuntimeError()'],
        [{ status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.pythonTaintedNamespaces).toContain('builtins')
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'from scipy.io import mminfo\ninfo=mminfo("input.mtx")',
          context
        )
      ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
    }
  )
  it.each(['mmread', 'mminfo'])('preserves unpatched reads for %s', async (name) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `from scipy.io import ${name}\nresult=${name}("input.mtx")`
      )
    ).toMatchObject({
      reads: ['input.mtx'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
})

describe('Matrix Market bzip2 delegate boundaries', () => {
  const tainted: NotebookSourceFileAccessContext = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonTaintedNamespaces: ['bz2']
  }
  it.each([
    'from scipy.io import mmread\nresult=mmread("input.mtx.bz2")',
    'from scipy.io import mmread\nresult=mmread(source="input.mtx.bz2")',
    'from scipy.io import mminfo as inspect\nresult=inspect("input.mtx.bz2")',
    'from scipy import io as sio\nresult=sio.mminfo(source="input.mtx.bz2")',
    'from scipy.io import mmread as read\ndef reopen(path):\n    return read(path)\nresult=reopen("input.mtx.bz2")'
  ])('keeps input but withdraws same-cell paths across bzip2: %s', async (call) => {
    const source = 'path="old.txt"\n' + call + '\nopen(path)'
    expect(await analyzeNotebookSourceFileAccess('python', source, tainted)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['input.mtx.bz2']
    })
  })
  it.each(['mmread', 'mminfo'])('also withdraws same-cell paths for gzip %s', async (name) => {
    const source =
      'from scipy.io import ' +
      name +
      '\npath="old.txt"\nresult=' +
      name +
      '(source="input.mtx.gz")\nopen(path)'
    expect(
      await analyzeNotebookSourceFileAccess('python', source, {
        ...tainted,
        pythonTaintedNamespaces: ['gzip']
      })
    ).toMatchObject({
      writeState: 'partial',
      externalState: 'partial',
      reads: ['input.mtx.gz']
    })
  })
  it.each(['mmread', 'mminfo'])('withdraws serialized content across bzip2 %s', async (name) => {
    const source =
      'import numpy as np\nfrom scipy.io import ' +
      name +
      '\nnp.save("cache.npy",np.array([1.,2.]))\nresult=' +
      name +
      '("input.mtx.bz2")\nafter=np.load("cache.npy")'
    const facts = (await analyzePythonNotebookSource(source, tainted)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
  })
  it.each(['read(path)', 'read(**options)'])(
    'keeps unknown input conservative: %s',
    async (call) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'from scipy.io import mmread as read\n' + call,
          tainted
        )
      ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
    }
  )
  it.each([
    { namespace: 'bz2', file: 'input.mtx' },
    { namespace: 'bz2', file: 'input.mtx.gz' },
    { namespace: 'gzip', file: 'input.mtx.bz2' },
    { namespace: 'lzma', file: 'input.mtx.bz2' }
  ])(
    'preserves unrelated literal codec precision $namespace $file',
    async ({ namespace, file }) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `from scipy.io import mmread\nresult=mmread("${file}")`,
          { ...tainted, pythonTaintedNamespaces: [namespace] }
        )
      ).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [file]
      })
    }
  )
  it.each([false, true])(
    'retains failed bzip2 replacement across replay (%s)',
    async (precompute) => {
      const scripts = [
        'import bz2 as codec',
        'setattr(codec,"BZ2File",replacement)\nraise RuntimeError()',
        'path="old.txt"'
      ]
      const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
      const context = await fileContext('python', scripts, overrides, precompute)
      const source = 'from scipy.io import mminfo\ninfo=mminfo(source="input.mtx.bz2")'
      expect(
        await analyzeNotebookSourceFileAccess('python', source + '\nopen(path)', context)
      ).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reads: ['input.mtx.bz2']
      })
      expect((await analyzePythonNotebookSource(source, context)).facts.state).toBe('unknown')
      const fresh = await fileContext(
        'python',
        scripts,
        overrides,
        precompute,
        undefined,
        'fresh-epoch'
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, fresh)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: ['input.mtx.bz2']
      })
    }
  )
})

describe('WAV NumPy reader delegate boundaries', () => {
  const tainted: NotebookSourceFileAccessContext = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonTaintedNamespaces: ['numpy']
  }
  it.each([
    'wavfile.read("input.wav")',
    'wavfile.read(filename="input.wav")',
    'wavfile.read("input.wav",mmap=True)',
    'wavfile.read(filename="input.wav",mmap=False)',
    'read_signal("input.wav")',
    'wavfile.read("input.wav",**options)'
  ])('withdraws tuple and path proof through a replaced NumPy reader: %s', async (call) => {
    const source =
      'from scipy.io import wavfile\nfrom scipy.io.wavfile import read as read_signal\npath="old.txt"\nrate,data=' +
      call +
      '\nopen(path)'
    const facts = (await analyzePythonNotebookSource(source, tainted)).facts
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'data', typeName: 'numpy.ndarray' })
    )
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'rate', typeName: 'python.scalar' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source, tainted)
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['input.wav']
    })
  })
  it.each(['wavfile.read(path)', 'wavfile.read(**options)'])(
    'does not certify unresolved WAV input: %s',
    async (call) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'from scipy.io import wavfile\n' + call,
          tainted
        )
      ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
    }
  )
  it('invalidates same-cell paths after a NumPy replacement', async () => {
    const source =
      'import numpy as np\nfrom scipy.io import wavfile\nnp.fromfile=replacement\npath="old.txt"\nrate,data=wavfile.read(filename="input.wav")\nopen(path)'
    const io = await analyzeNotebookSourceFileAccess('python', source)
    expect(io.reads).toContain('input.wav')
    expect(io.reads).not.toContain('old.txt')
    expect((await analyzePythonNotebookSource(source)).facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'data', typeName: 'numpy.ndarray' })
    )
  })
  it.each([false, true])('keeps failed NumPy mutation on replay (%s)', async (precompute) => {
    const scripts = [
      'import numpy as np',
      'setattr(np,"fromfile",replacement)\nraise RuntimeError()',
      'path="old.txt"'
    ]
    const overrides = [{}, { status: 'failed' as const, kernelDispatched: true }]
    const context = await fileContext('python', scripts, overrides, precompute)
    const source =
      'from scipy.io import wavfile\nrate,data=wavfile.read(filename="input.wav")\nopen(path)'
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      writeState: 'partial',
      externalState: 'partial',
      reads: ['input.wav']
    })
    expect(
      (await analyzePythonNotebookSource(source, context)).facts.typeBindings
    ).not.toContainEqual(expect.objectContaining({ target: 'data', typeName: 'numpy.ndarray' }))
    const fresh = await fileContext(
      'python',
      scripts,
      overrides,
      precompute,
      undefined,
      'fresh-epoch'
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', source.split('\nopen(path)')[0]!, fresh)
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['input.wav']
    })
  })
  it.each([{ namespaces: [] }, { namespaces: ['pandas'] }, { namespaces: ['io'] }])(
    'keeps healthy WAV contracts with unrelated taint $namespaces',
    async ({ namespaces }) => {
      const context = { ...tainted, pythonTaintedNamespaces: namespaces }
      const source =
        'from scipy.io import wavfile\npath="old.txt"\nrate,data=wavfile.read(filename="input.wav")\nopen(path)'
      expect(
        (await analyzePythonNotebookSource(source, context)).facts.typeBindings
      ).toContainEqual(expect.objectContaining({ target: 'data', typeName: 'numpy.ndarray' }))
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: ['input.wav', 'old.txt']
      })
    }
  )
})

describe('Stata reader delegated I/O boundaries', () => {
  it.each([
    ['gzip', 'gz'],
    ['bz2', 'bz2'],
    ['lzma', 'xz'],
    ['zipfile', 'zip'],
    ['tarfile', 'tar'],
    ['builtins', 'dta']
  ])('does not certify a replaced Stata opener: %s', async (namespace, suffix) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: [namespace]
    }
    const source = `import pandas as pd\nframe=pd.read_stata(filepath_or_buffer="input.dta.${suffix}")`
    expect(
      (await analyzePythonNotebookSource(source, context)).facts.typeBindings
    ).not.toContainEqual(expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' }))
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    ['gzip', 'gz'],
    ['bz2', 'bz2'],
    ['lzma', 'xz'],
    ['tarfile', 'tar']
  ])('withdraws pre-read content and paths for %s', async (namespace, suffix) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: [namespace]
    }
    const source = `import pandas as pd,numpy as np\nnp.save("cache.npy",np.array([1.,2.]))\npath="old.txt"\nframe=pd.read_stata("input.${suffix}")\nafter=np.load("cache.npy")\nopen(path)`
    const facts = (await analyzePythonNotebookSource(source, context)).facts
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.typeBindings).not.toContainEqual(
      expect.objectContaining({ target: 'after', typeName: 'numpy.ndarray' })
    )
    const io = await analyzeNotebookSourceFileAccess('python', source, context)
    expect(io).toMatchObject({ writeState: 'partial', externalState: 'partial' })
    expect(io.reads).not.toContain('old.txt')
  })
  it.each([
    'pd.read_stata("input.dta",compression="gzip")',
    'pd.read_stata(filepath_or_buffer=path,compression=None)',
    'pd.read_stata("input.dta",**options)'
  ])('does not close unresolved or explicit codec inputs: %s', async (call) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'import pandas as pd\n' + call, context)
    ).toMatchObject({ writeState: 'partial', externalState: 'partial' })
  })
  it.each([
    'pd.read_stata("input.dta")',
    'pd.read_stata("input.gz",compression=None)',
    'pd.read_stata("input.gz",compression={"method":None})',
    'pd.read_stata("input.bz2")'
  ])('preserves unrelated codec precision: %s', async (call) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['gzip']
    }
    const source = 'import pandas as pd\nframe=' + call
    expect((await analyzePythonNotebookSource(source, context)).facts.typeBindings).toContainEqual(
      expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' })
    )
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([false, true])(
    'retains failed Stata codec mutation through replay (%s)',
    async (precompute) => {
      const context = await fileContext(
        'python',
        [
          'import gzip as codec',
          'raise RuntimeError()',
          'setattr(codec,"GzipFile",replacement)\nraise RuntimeError()'
        ],
        [
          {},
          { status: 'failed' as const, kernelDispatched: true },
          { status: 'failed' as const, kernelDispatched: true }
        ],
        precompute
      )
      const source = 'import pandas as pd\nframe=pd.read_stata("input.dta.gz")'
      expect(
        (await analyzePythonNotebookSource(source, context)).facts.typeBindings
      ).not.toContainEqual(
        expect.objectContaining({ target: 'frame', typeName: 'pandas.DataFrame' })
      )
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )
})

describe('R pvec vector worker authority', () => {
  it.each([
    'parallel::pvec(thetas,fit_worker,mc.cores=1)',
    'parallel::pvec(inputs,base::sum,mc.cores=1)',
    'pvec(v=thetas,FUN=fit_worker,mc.cores=1)',
    'parallel::pvec(thetas,"fit_worker",mc.cores=1)',
    'parallel::pvec(thetas,function(a) {path <<- "new.txt";a},mc.cores=1)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nparallel::pvec(thetas,fit_worker,mc.cores=1)',
    'parallel::pvec(v={base::saveRDS(c(1,2),"cache.rds");thetas},FUN=fit_worker,mc.cores=1)'
  ])('withdraws producer proof around vector worker evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting vector result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(a) {a+offset}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- parallel::pvec(thetas,visit,mc.cores=1)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- parallel::pvec(thetas,function(a) {local_only <- offset;a},mc.cores=1)'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('a')
  })
  it.each([false, true])(
    'keeps failed vector worker evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'parallel::pvec(thetas,fit_worker,mc.cores=1)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() parallel::pvec(thetas,fit_worker,mc.cores=1)',
      'factory <- parallel::pvec',
      'pvec <- function(...) 1\npvec(thetas,fit_worker,mc.cores=1)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'parallel::pvec(thetas,fit_worker,mc.cores=1)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R nlminb derivative worker authority', () => {
  it.each([
    'stats::nlminb(start,fit_worker)',
    'stats::nlminb(start,base::sum)',
    'stats::nlminb(start,base::sum,gradient=grad_worker)',
    'stats::nlminb(start,base::sum,hessian=hess_worker)',
    'nlminb(start=start,objective=fit_worker)',
    'stats::nlminb(start,"fit_worker")',
    'stats::nlminb(start,function(a) {path <<- "new.txt";a})'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nstats::nlminb(start,fit_worker)',
    'stats::nlminb(start={base::saveRDS(c(1,2),"cache.rds");start},objective=fit_worker)'
  ])('withdraws producer proof around derivative worker evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each(
    [false, true].flatMap((priorCell) =>
      [
        'stats::nlminb(start,visit)',
        'stats::nlminb(start,base::sum,gradient=visit)',
        'stats::nlminb(start,base::sum,hessian=visit)',
        'stats::nlminb(start,base::sum,visit)',
        'stats::nlminb(start,base::sum,NULL,visit)'
      ].map((call) => [priorCell, call] as const)
    )
  )(
    'retains captures without granting derivative result ownership (%s, %s)',
    async (priorCell, call) => {
      const setup = 'offset <- 3\nvisit <- function(a) {a+offset}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- ' + call,
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- stats::nlminb(start,function(a) {local_only <- offset;a})'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('a')
  })
  it.each([false, true])(
    'keeps failed derivative worker evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'stats::nlminb(start,fit_worker)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() stats::nlminb(start,fit_worker)',
      'factory <- stats::nlminb',
      'nlminb <- function(...) 1\nnlminb(start,fit_worker)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'stats::nlminb(start,fit_worker)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R nlm attributed objective authority', () => {
  it.each([
    'stats::nlm(fit_worker,start)',
    'stats::nlm(base::sum,start)',
    'nlm(p=start,f=fit_worker)',
    'stats::nlm("fit_worker",start)',
    'stats::nlm(function(a) {path <<- "new.txt";a},start)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nstats::nlm(fit_worker,start)',
    'stats::nlm(p={base::saveRDS(c(1,2),"cache.rds");start},f=fit_worker)'
  ])('withdraws producer proof around attributed objective evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'retains captures without granting objective result ownership (%s)',
    async (priorCell) => {
      const setup = 'offset <- 3\nvisit <- function(a) {a+offset}'
      const context = priorCell ? await fileContext('r', [setup]) : undefined
      const { facts } = await analyzeRNotebookSource(
        (priorCell ? '' : setup + '\n') + 'result <- stats::nlm(visit,start)',
        context
      )
      expect(facts.usedNames).toContain('offset')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(facts.state).toBe('unknown')
    }
  )
  it('keeps callback locals out of the caller scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'result <- stats::nlm(function(a) {local_only <- offset;a},start)'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.priorUsedNames).not.toContain('local_only')
    expect(facts.usedNames).toContain('offset')
    expect(facts.usedNames).not.toContain('a')
  })
  it.each([false, true])(
    'keeps failed attributed objective evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'stats::nlm(fit_worker,start)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() stats::nlm(fit_worker,start)',
      'factory <- stats::nlm',
      'nlm <- function(...) 1\nnlm(fit_worker,start)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'stats::nlm(fit_worker,start)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R numericDeriv evaluation authority', () => {
  it.each([
    'stats::numericDeriv(quote(model(rate)),"rate",rho=parameters)',
    'stats::numericDeriv(quote(rate),"rate",rho=parameters)',
    'numericDeriv(expr=quote(model(rate)),theta="rate",rho=parameters)',
    'stats::numericDeriv(quote(model(rate)),theta="rate",rho=parameters,central=TRUE)',
    'stats::numericDeriv(quote({path <<- "new.txt";rate}),"rate",rho=parameters)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nstats::numericDeriv(quote(model(rate)),"rate",rho=parameters)',
    'stats::numericDeriv(quote(rate),"rate",rho={base::saveRDS(c(1,2),"cache.rds");parameters})'
  ])('withdraws producer proof around quoted expression evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it('does not promote bindings inside a quoted expression into caller facts', async () => {
    const { facts } = await analyzeRNotebookSource(
      'answer <- stats::numericDeriv(quote({local_only <- rate;local_only}),"rate",rho=parameters)'
    )
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('answer')
    expect(facts.state).toBe('unknown')
  })
  it.each([false, true])(
    'keeps failed quoted expression evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'stats::numericDeriv(quote(model(rate)),"rate",rho=parameters)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() stats::numericDeriv(quote(model(rate)),"rate",rho=parameters)',
      'factory <- stats::numericDeriv',
      'numericDeriv <- function(...) 1\nnumericDeriv(quote(rate),"rate",rho=parameters)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'stats::numericDeriv(quote(model(rate)),"rate",rho=parameters)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R nls formula evaluation authority', () => {
  it.each([
    'stats::nls(y~model(x,a),data=frame,start=list(a=1))',
    'stats::nls(y~a*x,data=frame,start=list(a=1))',
    'nls(formula=y~model(x,a),data=frame,start=list(a=1))',
    'stats::nls(formula=y~model(x,a),data=frame,start=list(a=1),weights=weights)',
    'stats::nls(y~{path <<- "new.txt";a*x},data=frame,start=list(a=1))'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nstats::nls(y~model(x,a),data=frame,start=list(a=1))',
    'stats::nls(y~a*x,data={base::saveRDS(c(1,2),"cache.rds");frame},start=list(a=1))'
  ])('withdraws producer proof around formula evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([
    'stats::nls(y~{local_only <- a*x;local_only},data=frame,start=list(a=1))',
    'stats::nls(formula=(y~{local_only <- a*x;local_only}),data=frame,start=list(a=1))',
    'stats::nls(data=frame,start=list(a=1),form=(y~{local_only <- a*x;local_only}))',
    'stats::nls(formula=(y~{local_only <- a*x;local_only}),data=frame,start=list(a=1),extra=1)'
  ])('does not promote formula bindings into caller facts: %s', async (call) => {
    const { facts } = await analyzeRNotebookSource('answer <- ' + call)
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('answer')
    expect(facts.state).toBe('unknown')
  })
  it('keeps matched data arguments in caller evaluation scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'answer <- stats::nls(y~a*x,data={caller_data <- frame;caller_data},start=list(a=1))'
    )
    expect(facts.definedNames).toContain('caller_data')
    expect(facts.state).toBe('unknown')
  })
  it.each([false, true])(
    'keeps failed formula evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'stats::nls(y~model(x,a),data=frame,start=list(a=1))'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() stats::nls(y~model(x,a),data=frame,start=list(a=1))',
      'factory <- stats::nls',
      'nls <- function(...) 1\nnls(y~a*x,data=frame,start=list(a=1))'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'stats::nls(y~model(x,a),data=frame,start=list(a=1))\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R loess formula evaluation authority', () => {
  it('retains ordinary caller definitions in matched control arguments', async () => {
    const { facts } = await analyzeRNotebookSource(
      'answer <- stats::loess(data=frame,form=y~x,span={caller_span <- 0.75;caller_span})'
    )
    expect(facts.definedNames).toContain('caller_span')
    expect(facts.copyOnModifyNames ?? []).not.toContain('answer')
  })
  it.each([
    'stats::loess(y~model(x),data=frame)',
    'stats::loess(y~x,data=frame)',
    'loess(formula=y~model(x),data=frame)',
    'stats::loess(formula=y~model(x),data=frame,weights=weights)',
    'stats::loess(y~{path <<- "new.txt";x},data=frame)'
  ])('withdraws caller paths across %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'path <- "old.txt"\nresult <- ' + call + '\nbase::readLines(path)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds")\nstats::loess(y~model(x),data=frame)',
    'stats::loess(y~x,data={base::saveRDS(c(1,2),"cache.rds");frame})'
  ])('withdraws producer proof around formula evaluation: %s', async (prefix) => {
    const source = prefix + '\nafter <- base::readRDS("cache.rds")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toContain('cache.rds')
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([
    'stats::loess(y~{local_only <- x;local_only},data=frame)',
    'stats::loess(y~I(local_only <- x),data=frame)',
    'stats::loess(formula=(y~{local_only <- x;local_only}),data=frame)',
    'stats::loess(data=frame,form=(y~{local_only <- x;local_only}))',
    'stats::loess(formula=(y~{local_only <- x;local_only}),data=frame,extra=1)'
  ])('does not promote formula bindings into caller facts: %s', async (call) => {
    const { facts } = await analyzeRNotebookSource('answer <- ' + call)
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('answer')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'stats::loess(y~x,data=frame,weights={local_only <- w;local_only})',
    'stats::loess(y~x,data=frame,subset={local_only <- x>0;local_only})',
    'stats::loess(sub={local_only <- x>0;local_only},data=frame,form=y~x)',
    'stats::loess(y~x,data=frame,unknown_option={local_only <- x;local_only})'
  ])('does not promote model-frame bindings into caller facts: %s', async (call) => {
    const { facts } = await analyzeRNotebookSource('answer <- ' + call)
    expect(facts.definedNames).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('local_only')
    expect(facts.copyOnModifyNames ?? []).not.toContain('answer')
    expect(facts.state).toBe('unknown')
  })
  it('keeps matched data arguments in caller evaluation scope', async () => {
    const { facts } = await analyzeRNotebookSource(
      'answer <- stats::loess(y~x,data={caller_data <- frame;caller_data})'
    )
    expect(facts.definedNames).toContain('caller_data')
    expect(facts.state).toBe('unknown')
  })
  it.each([false, true])(
    'keeps failed formula evaluation history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path <- "old.txt"', 'stats::loess(y~model(x),data=frame)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it('preserves dormant calls, function values and a pure local replacement', async () => {
    for (const prefix of [
      'later <- function() stats::loess(y~model(x),data=frame)',
      'factory <- stats::loess',
      'loess <- function(...) 1\nloess(y~x,data=frame)'
    ]) {
      const source =
        'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\n' +
        prefix +
        '\nbase::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
    }
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'stats::loess(y~model(x),data=frame)\npath <- "after.txt"\nbase::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R Filter subsetting and predicate coercion authority', () => {
  it.each(['dplyr::mutate', 'dplyr::summarise'])(
    'does not borrow caller atomic facts in a data mask: %s',
    async (mask) => {
      const source =
        'values<-c(1,2,3);path<-"old.txt";' +
        mask +
        '(frame, selected=base::Filter(function(v)v>1,values));base::readLines(path)'
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
    }
  )

  it.each([
    'base::Filter(function(v)v>0,indices)',
    'Filter(f=function(v)v>0,x=structure(c(1,2),class="quality_index"))',
    'base::Filter(x=indices,f=function(v)TRUE)',
    'base::Filter(function(v){path <<- "new.txt";v>0},c(1,2))',
    'base::Filter(function(v)structure(TRUE,class="flag"),c(1,2))',
    'base::Filter(function(v)external,c(1,2))',
    'base::Filter(function(v)TRUE,list(c(1,2)))'
  ])('withdraws path and serialized proof across %s', async (call) => {
    const source =
      'path <- "old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult <- ' +
      call +
      '\nbase::readLines(path)\nafter <- base::readRDS("cache.rds")'
    const io = await analyzeNotebookSourceFileAccess('r', source)
    expect(io.reads).toEqual(['cache.rds'])
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.state).toBe('unknown')
    expect(facts.safeCallNames ?? []).not.toContain('base::Filter')
  })
  it.each([
    'base::Filter(function(v)v>1,c(1,2,3))',
    'Filter(x=values,f=function(value)value>1)',
    'base::Filter(function(v)TRUE,c(1,2))',
    'base::Filter(function(v)v>=threshold,values)'
  ])('retains primitive input and result precision: %s', async (call) => {
    const source =
      'values<-c(1,2,3)\nthreshold<-1\npath<-"old.txt"\nbase::saveRDS(c(1,2),"cache.rds")\nresult<-' +
      call +
      '\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites).toHaveLength(1)
    expect(
      (await analyzeRNotebookSource('values<-c(1,2,3);threshold<-1;result<-' + call)).facts.state
    ).toBe('available')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");base::Filter(function(v)TRUE,indices)',
    'base::Filter(function(v)TRUE,{base::saveRDS(c(1,2),"cache.rds");indices})'
  ])('withdraws producer proof before and after lazy inputs: %s', async (prefix) => {
    expect((await analyzeRNotebookSource(prefix)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])('keeps failed class subsetting conservative (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path<-"old.txt"', 'base::Filter(function(v)TRUE,indices)'],
      [{}, { status: 'failed', kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
  it('keeps per-invocation proof distinct within one cell', async () => {
    const source =
      'path<-"old.txt"\nbase::Filter(function(v)v>1,c(1,2,3))\nbase::Filter(function(v)TRUE,indices)\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it('does not substitute a formal name into a captured function callee', async () => {
    const source =
      'path<-"old.txt"\nbase::Filter(function(value)value(value),c(1,2))\nbase::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })
  it.each([
    'later<-function()base::Filter(function(v)TRUE,indices)',
    'factory<-base::Filter',
    'Filter<-function(...)1;Filter(function(v)TRUE,indices)'
  ])('preserves dormant references and pure local replacement: %s', async (prefix) => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'path<-"old.txt";' + prefix + ';base::readLines(path)'
        )
      ).reads
    ).toEqual(['old.txt'])
  })
  it('allows a new explicit path after the opaque call', async () => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'base::Filter(function(v)TRUE,indices);path<-"after.txt";base::readLines(path)'
        )
      ).reads
    ).toEqual(['after.txt'])
  })
})

describe('R interpolation ties callback authority', () => {
  it.each([
    'stats::approx(x,y,xout=grid,ties=tie_mean)',
    'approx(x,y,xout=grid,ties=function(z)mean(z))',
    'stats::approx(x,y,xout=grid)',
    'stats::approx(x,y,xout=grid,ties="ordered")',
    'stats::approx(x,y,grid,"linear",50,NULL,NULL,2,0,tie_mean)',
    'stats::approxfun(x,y,ties=tie_mean)',
    'stats::spline(x,y,xout=grid,ties=tie_mean)',
    'stats::splinefun(x,y,ties=tie_mean)'
  ])('withdraws caller path and serialized authority across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");result<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.state).toBe('unknown')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::approx(x,y,ties=tie_mean)',
    'stats::approx({base::saveRDS(c(1,2),"cache.rds");x},y,ties=tie_mean)'
  ])('withdraws producer proof around lazy argument forcing: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])('keeps failed ties history conservative (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path<-"old.txt"', 'stats::approx(x,y,ties=tie_mean)'],
      [{}, { status: 'failed', kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
  it.each(['approx', 'approxfun', 'spline', 'splinefun'])(
    'preserves dormant and local replacement forms: %s',
    async (name) => {
      for (const body of [
        'later<-function()stats::' + name + '(x,y,ties=tie_mean)',
        'factory<-stats::' + name,
        name + '<-function(...)1;' + name + '(x,y,ties=tie_mean)'
      ])
        expect(
          (
            await analyzeNotebookSourceFileAccess(
              'r',
              'path<-"old.txt";' + body + ';base::readLines(path)'
            )
          ).reads
        ).toEqual(['old.txt'])
    }
  )
  it('allows an explicit later path without granting returned closure purity', async () => {
    const source = 'f<-stats::approxfun(x,y,ties=tie_mean);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.copyOnModifyNames ?? []).not.toContain('f')
    expect(facts.safeCallNames ?? []).not.toContain('stats::approxfun')
  })
})

describe('R density coordinate coercion authority', () => {
  it.each([
    'stats::density(sensor,bw=0.5)',
    'density(sensor,bw=0.5)',
    'stats::density.default(sensor,bw=0.5)',
    'density.default(sensor,bw=0.5)',
    'stats::density(structure(c(4.7,8.1),class="audit_sensor"),bw=0.5)',
    'stats::density(sensor,bw=0.5,give.Rkern=TRUE)',
    'stats::density.default(sensor,bw="nrd0",na.rm=TRUE)'
  ])('withdraws path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::density(sensor,bw=0.5)',
    'stats::density({base::saveRDS(c(1,2),"cache.rds");sensor},bw=0.5)',
    'stats::density.default(sensor,bw={base::saveRDS(c(1,2),"cache.rds");0.5})'
  ])('withdraws producer proof before and after lazy inputs: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])('keeps failed coercion history conservative (%s)', async (precompute) => {
    const context = await fileContext(
      'r',
      ['path<-"old.txt"', 'stats::density(sensor,bw=0.5)'],
      [{}, { status: 'failed', kernelDispatched: true }],
      precompute
    )
    expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
    ).toEqual([])
  })
  it.each(['density', 'density.default'])(
    'preserves dormant references and local replacement: %s',
    async (name) => {
      for (const body of [
        'later<-function()stats::' + name + '(sensor,bw=0.5)',
        'factory<-stats::' + name,
        name + '<-function(...)1;' + name + '(sensor,bw=0.5)'
      ]) {
        const source =
          'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
        expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
        expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
      }
    }
  )
  it('retains an explicit later path without certifying density results', async () => {
    const source = 'fit<-stats::density(sensor,bw=0.5);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::density'
    )
  })
})

describe('R multivariate distance matrix coercion authority', () => {
  it.each([
    'stats::mahalanobis(sensor,center,covariance)',
    'mahalanobis(sensor,center,covariance)',
    'stats::mahalanobis(x=sensor,center=center,cov=covariance,inverted=TRUE)',
    'stats::mahalanobis(sensor,FALSE,covariance)',
    'stats::dist(sensor,method="euclidean")',
    'dist(sensor,method="manhattan")',
    'stats::dist(structure(matrix(1:6,ncol=2),class=c("audit_points","matrix","array")),method="minkowski",p=2)'
  ])('withdraws caller path and serialized authority across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::mahalanobis(sensor,center,covariance)',
    'stats::mahalanobis({base::saveRDS(c(1,2),"cache.rds");sensor},center,covariance)',
    'stats::dist({base::saveRDS(c(1,2),"cache.rds");sensor})'
  ])('withdraws producer proof before and after arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed matrix conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::mahalanobis(sensor,center,covariance)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each(['mahalanobis', 'dist'])(
    'preserves dormant and local replacement forms: %s',
    async (name) => {
      for (const body of [
        'later<-function()stats::' + name + '(sensor)',
        'factory<-stats::' + name,
        name + '<-function(...)1;' + name + '(sensor)'
      ]) {
        const source =
          'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
        expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
        expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
      }
    }
  )
  it('permits an explicit later path without granting distance ownership', async () => {
    const source =
      'fit<-stats::mahalanobis(sensor,center,covariance);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::mahalanobis'
    )
  })
})

describe('R glm.fit family evaluation authority', () => {
  it.each([
    'stats::glm.fit(design,counts,family=family)',
    'glm.fit(x=design,y=counts,family=family)',
    'stats::glm.fit(design,counts)',
    'stats::glm.fit(design,counts,family=stats::poisson(link="log"))',
    'stats::glm.fit(design,counts,family=family,etastart=initial)',
    'stats::glm.fit(design,counts,family=family,weights=weights,offset=offset)'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::glm.fit(design,counts,family=family)',
    'stats::glm.fit({base::saveRDS(c(1,2),"cache.rds");design},counts,family=family)',
    'stats::glm.fit(design,counts,family={base::saveRDS(c(1,2),"cache.rds");family})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed family callback history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::glm.fit(design,counts,family=family)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::glm.fit(design,counts,family=family)',
    'factory<-stats::glm.fit',
    'glm.fit<-function(...)1;glm.fit(design,counts,family=family)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting model purity', async () => {
    const source =
      'fit<-stats::glm.fit(design,counts,family=family);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::glm.fit'
    )
  })
})

describe('R optimHess callback evaluation authority', () => {
  it.each([
    'stats::optimHess(point,fn=objective)',
    'optimHess(par=point,fn=objective)',
    'stats::optimHess(point,objective)',
    'stats::optimHess(point,fn=objective,gr=gradient)',
    'stats::optimHess(point,fn=objective,control=list(ndeps=c(1e-4,1e-4)))',
    'stats::optimHess(point,fn=objective,gr=NULL)'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::optimHess(point,fn=objective)',
    'stats::optimHess({base::saveRDS(c(1,2),"cache.rds");point},fn=objective)',
    'stats::optimHess(point,fn={base::saveRDS(c(1,2),"cache.rds");objective})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed curvature callback history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::optimHess(point,fn=objective)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::optimHess(point,fn=objective)',
    'factory<-stats::optimHess',
    'optimHess<-function(...)1;optimHess(point,fn=objective)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting curvature purity', async () => {
    const source =
      'fit<-stats::optimHess(point,fn=objective);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::optimHess'
    )
  })
})

describe('R PCA matrix conversion evaluation authority', () => {
  it.each([
    'stats::prcomp(sensor,center=TRUE,scale.=TRUE)',
    'prcomp(x=sensor)',
    'stats::prcomp.default(sensor)',
    'stats::prcomp.default(sensor,center=FALSE,scale.=FALSE)',
    'stats::prcomp(sensor,rank.=1)',
    'stats::prcomp(sensor,tol=0.1,retx=FALSE)'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::prcomp(sensor,center=TRUE,scale.=TRUE)',
    'stats::prcomp({base::saveRDS(c(1,2),"cache.rds");sensor})',
    'stats::prcomp.default(sensor,center={base::saveRDS(c(1,2),"cache.rds");TRUE})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed PCA conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::prcomp(sensor,center=TRUE,scale.=TRUE)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::prcomp(sensor,center=TRUE,scale.=TRUE)',
    'factory<-stats::prcomp',
    'prcomp<-function(...)1;prcomp(sensor)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting PCA purity', async () => {
    const source =
      'fit<-stats::prcomp(sensor,center=TRUE,scale.=TRUE);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::prcomp'
    )
  })
})

describe('R autocovariance conversion evaluation authority', () => {
  it.each([
    'stats::acf(signal,lag.max=6,plot=FALSE)',
    'acf(x=signal,plot=FALSE)',
    'stats::acf(signal,type="covariance",plot=FALSE)',
    'stats::acf(signal,type="correlation",plot=FALSE,na.action=base::identity)',
    'stats::acf(signal,demean=FALSE,plot=FALSE)',
    'stats::acf(signal,plot=FALSE,na.action=selector)'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::acf(signal,lag.max=6,plot=FALSE)',
    'stats::acf({base::saveRDS(c(1,2),"cache.rds");signal},plot=FALSE)',
    'stats::acf(signal,plot=FALSE,na.action={base::saveRDS(c(1,2),"cache.rds");selector})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed series conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::acf(signal,lag.max=6,plot=FALSE)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::acf(signal,lag.max=6,plot=FALSE)',
    'factory<-stats::acf',
    'acf<-function(...)1;acf(signal)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting autocovariance purity', async () => {
    const source =
      'fit<-stats::acf(signal,lag.max=6,plot=FALSE);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::acf'
    )
  })
})

describe('R Lloyd clustering matrix conversion authority', () => {
  it.each([
    'stats::kmeans(sensor,centers=initial,algorithm="Lloyd")',
    'kmeans(x=sensor,centers=initial)',
    'stats::kmeans(sensor,centers=2)',
    'stats::kmeans(sensor,centers=initial,algorithm="Forgy")',
    'stats::kmeans(sensor,centers=initial,iter.max=100)',
    'stats::kmeans(sensor,centers=initial,algorithm="MacQueen")'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::kmeans(sensor,centers=initial,algorithm="Lloyd")',
    'stats::kmeans({base::saveRDS(c(1,2),"cache.rds");sensor},centers=initial)',
    'stats::kmeans(sensor,centers={base::saveRDS(c(1,2),"cache.rds");initial})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed clustering conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::kmeans(sensor,centers=initial,algorithm="Lloyd")'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::kmeans(sensor,centers=initial,algorithm="Lloyd")',
    'factory<-stats::kmeans',
    'kmeans<-function(...)1;kmeans(sensor)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting clustering purity', async () => {
    const source =
      'fit<-stats::kmeans(sensor,centers=initial,algorithm="Lloyd");path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::kmeans'
    )
  })
})

describe('R classical MDS matrix conversion authority', () => {
  it.each([
    'stats::cmdscale(dissimilarity,k=2,eig=TRUE)',
    'cmdscale(d=dissimilarity,k=2)',
    'stats::cmdscale(dissimilarity,k=1)',
    'stats::cmdscale(dissimilarity,k=2,add=FALSE)',
    'stats::cmdscale(dissimilarity,k=2,x.ret=TRUE)',
    'stats::cmdscale(dissimilarity,k=2,list.=TRUE)'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::cmdscale(dissimilarity,k=2,eig=TRUE)',
    'stats::cmdscale({base::saveRDS(c(1,2),"cache.rds");dissimilarity},k=2)',
    'stats::cmdscale(dissimilarity,k={base::saveRDS(c(1,2),"cache.rds");2})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed MDS conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::cmdscale(dissimilarity,k=2,eig=TRUE)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::cmdscale(dissimilarity,k=2,eig=TRUE)',
    'factory<-stats::cmdscale',
    'cmdscale<-function(...)1;cmdscale(dissimilarity)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting MDS purity', async () => {
    const source =
      'fit<-stats::cmdscale(dissimilarity,k=2,eig=TRUE);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::cmdscale'
    )
  })
})

describe('R weighted covariance conversion authority', () => {
  it.each([
    'stats::cov.wt(observations,wt=weights,cor=TRUE,method="unbiased")',
    'cov.wt(x=observations,wt=weights)',
    'stats::cov.wt(observations,wt=weights,method="ML")',
    'stats::cov.wt(observations,wt=weights,center=FALSE)',
    'stats::cov.wt(observations,wt=weights,center=c(0,1))',
    'stats::cov.wt(observations,cor=FALSE)'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::cov.wt(observations,wt=weights,cor=TRUE,method="unbiased")',
    'stats::cov.wt({base::saveRDS(c(1,2),"cache.rds");observations},wt=weights)',
    'stats::cov.wt(observations,wt={base::saveRDS(c(1,2),"cache.rds");weights})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed weighted covariance conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::cov.wt(observations,wt=weights,cor=TRUE,method="unbiased")'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::cov.wt(observations,wt=weights,cor=TRUE,method="unbiased")',
    'factory<-stats::cov.wt',
    'cov.wt<-function(...)1;cov.wt(observations)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting weighted covariance purity', async () => {
    const source =
      'fit<-stats::cov.wt(observations,wt=weights,cor=TRUE,method="unbiased");path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::cov.wt'
    )
  })
})

describe('R periodogram conversion and preprocessing authority', () => {
  it.each([
    'stats::spec.pgram(signal,taper=0,fast=FALSE,detrend=FALSE,demean=TRUE,plot=FALSE)',
    'spec.pgram(x=signal,plot=FALSE)',
    'stats::spectrum(signal,method="pgram",plot=FALSE)',
    'stats::spec.pgram(signal,na.action=selector,plot=FALSE)',
    'stats::spec.pgram(signal,spans=c(3,3),plot=FALSE)',
    'stats::spec.pgram(signal,demean=FALSE,plot=FALSE)'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::spec.pgram(signal,taper=0,fast=FALSE,detrend=FALSE,demean=TRUE,plot=FALSE)',
    'stats::spec.pgram({base::saveRDS(c(1,2),"cache.rds");signal},plot=FALSE)',
    'stats::spec.pgram(signal,na.action={base::saveRDS(c(1,2),"cache.rds");selector},plot=FALSE)'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed periodogram conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        [
          'path<-"old.txt"',
          'stats::spec.pgram(signal,taper=0,fast=FALSE,detrend=FALSE,demean=TRUE,plot=FALSE)'
        ],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::spec.pgram(signal,taper=0,fast=FALSE,detrend=FALSE,demean=TRUE,plot=FALSE)',
    'factory<-stats::spec.pgram',
    'spec.pgram<-function(...)1;spec.pgram(signal)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting periodogram purity', async () => {
    const source =
      'fit<-stats::spec.pgram(signal,taper=0,fast=FALSE,detrend=FALSE,demean=TRUE,plot=FALSE);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::spec.pgram'
    )
  })
})

describe('R weighted calibration design conversion authority', () => {
  it.each([
    'stats::lsfit(design,response,wt=weights)',
    'lsfit(x=design,y=response)',
    'stats::lsfit(design,response,wt=NULL)',
    'stats::lsfit(design,response,wt=weights,intercept=FALSE)',
    'stats::lsfit(design,response,tolerance=1e-9)',
    'stats::lsfit(design,response,yname="calibration")'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::lsfit(design,response,wt=weights)',
    'stats::lsfit({base::saveRDS(c(1,2),"cache.rds");design},response)',
    'stats::lsfit(design,response,wt={base::saveRDS(c(1,2),"cache.rds");weights})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed weighted calibration conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::lsfit(design,response,wt=weights)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::lsfit(design,response,wt=weights)',
    'factory<-stats::lsfit',
    'lsfit<-function(...)1;lsfit(design,response)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting weighted calibration purity', async () => {
    const source =
      'fit<-stats::lsfit(design,response,wt=weights);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::lsfit'
    )
  })
})

describe('R canonical correlation matrix conversion authority', () => {
  it.each([
    'stats::cancor(predictors,responses)',
    'cancor(x=predictors,y=responses)',
    'stats::cancor(predictors,responses,xcenter=FALSE)',
    'stats::cancor(predictors,responses,ycenter=FALSE)',
    'stats::cancor(predictors,responses,xcenter=c(0,1))',
    'stats::cancor(predictors,responses,ycenter=c(1,0))'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::cancor(predictors,responses)',
    'stats::cancor({base::saveRDS(c(1,2),"cache.rds");predictors},responses)',
    'stats::cancor(predictors,{base::saveRDS(c(1,2),"cache.rds");responses})'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed canonical correlation conversion history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        ['path<-"old.txt"', 'stats::cancor(predictors,responses)'],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::cancor(predictors,responses)',
    'factory<-stats::cancor',
    'cancor<-function(...)1;cancor(predictors,responses)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting canonical correlation purity', async () => {
    const source =
      'fit<-stats::cancor(predictors,responses);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::cancor'
    )
  })
})

describe('R kernel smoothing subset authority', () => {
  it.each([
    'stats::ksmooth(axis,response,kernel="box",bandwidth=0.8,x.points=grid)',
    'ksmooth(x=axis,y=response,x.points=grid)',
    'stats::ksmooth(axis,response,kernel="normal",x.points=grid)',
    'stats::ksmooth(axis,response,bandwidth=1,x.points=grid)',
    'stats::ksmooth(axis,response,n.points=10)',
    'stats::ksmooth(axis,response,range.x=c(0,6))'
  ])('withdraws caller path and serialized contents across %s', async (call) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");fit<-' +
      call +
      ';base::readLines(path);after<-base::readRDS("cache.rds")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['cache.rds'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.serializedValueWrites ?? []).toEqual([])
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.state).toBe('unknown')
  })
  it.each([
    'base::saveRDS(c(1,2),"cache.rds");stats::ksmooth(axis,response,kernel="box",bandwidth=0.8,x.points=grid)',
    'stats::ksmooth({base::saveRDS(c(1,2),"cache.rds");axis},response,x.points=grid)',
    'stats::ksmooth(axis,{base::saveRDS(c(1,2),"cache.rds");response},x.points=grid)'
  ])('withdraws producer proof before and after lazy arguments: %s', async (source) => {
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
  })
  it.each([false, true])(
    'keeps failed kernel subset history conservative (%s)',
    async (precompute) => {
      const context = await fileContext(
        'r',
        [
          'path<-"old.txt"',
          'stats::ksmooth(axis,response,kernel="box",bandwidth=0.8,x.points=grid)'
        ],
        [{}, { status: 'failed', kernelDispatched: true }],
        precompute
      )
      expect(context?.staticStrings ?? []).not.toContainEqual({ name: 'path', value: 'old.txt' })
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'base::readLines(path)', context)).reads
      ).toEqual([])
    }
  )
  it.each([
    'later<-function()stats::ksmooth(axis,response,kernel="box",bandwidth=0.8,x.points=grid)',
    'factory<-stats::ksmooth',
    'ksmooth<-function(...)1;ksmooth(axis,response)'
  ])('preserves dormant references and a pure local replacement: %s', async (body) => {
    const source =
      'path<-"old.txt";base::saveRDS(c(1,2),"cache.rds");' + body + ';base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['old.txt'])
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toHaveLength(1)
  })
  it('allows explicit later paths without granting kernel smoothing purity', async () => {
    const source =
      'fit<-stats::ksmooth(axis,response,kernel="box",bandwidth=0.8,x.points=grid);path<-"after.txt";base::readLines(path)'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['after.txt'])
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames ?? []).not.toContain(
      'stats::ksmooth'
    )
  })
})

describe('plain R matrix source provenance', () => {
  const read = 'raw <- utils::read.csv("raw.csv",row.names=1,check.names=FALSE);NULL'
  const clean = 'clean <- as.matrix(raw[rowSums(raw)>=10,,drop=FALSE]);NULL'
  const metadata = (count: number): Array<Partial<NotebookRunRecord>> =>
    Array.from({ length: count }, (_, index) => ({
      environmentManifest: {
        executionContext: {
          before: {},
          rPackages: {
            before: ['stats', 'utils', 'base'],
            after: ['stats', 'utils', 'base'],
            reads: [],
            complete: true,
            cleanSession: index === 0
          }
        }
      }
    }))
  it('projects the original CSV and matrix cleaning source through cache reload', async () => {
    const context = await fileContext('r', [read, clean], metadata(2))
    expect(context?.rDataFrameNames).toContain('raw')
    expect(context?.rMatrixNames).toContain('clean')
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'grDevices::png("heatmap.png");stats::heatmap(log2(clean+1),scale="row",Colv=NA);grDevices::dev.off();NULL',
        context
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
  })
  it.each([
    'class(clean) <- "foo"',
    'attributes(clean) <- list(class="matrix")',
    'storage.mode(clean) <- "double"',
    'dimnames(clean) <- NULL',
    'alias <- clean;class(alias) <- "foo"',
    'clean <- structure(clean,class="matrix")',
    'clean <- unknown_transform(clean)',
    'dim.matrix <- function(x) c(2,2)',
    'as.matrix.data.frame <- function(x) structure(matrix(1),class="foo")'
  ])(
    'revokes prior provenance after mutation, unknown source or method changes: %s',
    async (change) => {
      const context = await fileContext('r', [read, clean, change], metadata(3))
      expect(context?.rMatrixNames ?? []).not.toContain('clean')
      expect(
        await analyzeNotebookSourceFileAccess('r', 'stats::heatmap(clean)', context)
      ).toMatchObject({ readState: 'partial' })
    }
  )
  it.each([
    'raw <- structure(list(x=1),class="data.frame"); clean <- as.matrix(raw)',
    'raw <- utils::read.csv("raw.csv",colClasses="foo"); clean <- as.matrix(raw)',
    'clean <- structure(matrix(c(1,2,3,4),nrow=2),class="__r_plain_matrix__")',
    'setClass("__r_plain_matrix__");clean <- new("__r_plain_matrix__")',
    'setClass("matrix");clean <- new("matrix")',
    'setRefClass("__r_plain_matrix__");clean <- new("__r_plain_matrix__")',
    'raw <- utils::read.csv("raw.csv");clean <- as.matrix(raw[1,,drop=TRUE])',
    'raw <- utils::read.csv("raw.csv");clean <- as.matrix(raw[indices,,drop=FALSE])'
  ])(
    'does not manufacture matrix proof from class markers or unknown dispatch: %s',
    async (source) => {
      const context = await fileContext('r', [source], metadata(1))
      expect(context?.rMatrixNames ?? []).not.toContain('clean')
      expect(
        await analyzeNotebookSourceFileAccess('r', 'stats::heatmap(clean)', context)
      ).toMatchObject({ readState: 'partial' })
    }
  )
  it('does not recover dispatch proof after a missing history entry', async () => {
    const entries: Array<FileContextEntry | undefined> = []
    for (const script of [read, clean]) {
      const analysis = await analyzeRNotebookSource(
        script,
        projectNotebookFileContext('r', entries)
      )
      entries.push({ facts: analysis.facts, fileContext: analysis.fileAccess!.context })
    }
    entries.push(undefined)
    const analysis = await analyzeRNotebookSource('fresh <- matrix(c(1,2,3,4),nrow=2)')
    entries.push({ facts: analysis.facts, fileContext: analysis.fileAccess!.context })
    const context = projectNotebookFileContext('r', entries)
    expect(context?.rDispatchUncertain).toBe(true)
    expect(context?.rMatrixNames ?? []).toEqual([])
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'stats::heatmap(matrix(c(1,2,3,4),nrow=2))',
        context
      )
    ).toMatchObject({ readState: 'partial' })
  })
})
