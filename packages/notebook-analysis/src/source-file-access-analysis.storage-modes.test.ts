import { describe, expect, it } from 'vitest'
import type { NotebookRunRecord } from './analysis-test-support'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { projectNotebookDependencies } from './dependency-projection'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('scientific storage modes', () => {
  it.each([
    ['import os', 'os.replace', ''],
    ['import shutil', 'shutil.move', ''],
    ['import os as files', 'files.replace', ''],
    ['from shutil import move as transfer', 'transfer', ''],
    ['import os', 'os.replace', '    marker=1\n'],
    ['import shutil', 'shutil.move', '    marker=1\n']
  ])('replays mutation helper paths for %s / %s', async (imports, operation, prefix) => {
    const source =
      imports +
      '\ndef publish(src,dst):\n' +
      prefix +
      '    ' +
      operation +
      '(src,dst)\npublish("stage.csv","published.csv")'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['stage.csv'],
      writes: ['published.csv', 'stage.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    for (const unused of [
      imports + '\ndef publish(src,dst):\n    ' + operation + '(src,dst)',
      imports +
        '\ndef publish(src,dst):\n    ' +
        operation +
        '(src,dst)\npublish=lambda *args: None\npublish("stage.csv","published.csv")'
    ])
      expect(await analyzeNotebookSourceFileAccess('python', unused)).toMatchObject({
        reads: [],
        writes: []
      })
  })
  it.each(['loadtxt', 'genfromtxt'])(
    'preserves complete ordinary NumPy text reader helper coverage: %s',
    async (reader) => {
      const source = `import numpy as np\ndef load(path):\n    return np.${reader}(path)\nvalue=load("input.txt")`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['input.txt'],
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  )
  it.each([
    'np.loadtxt(fname=path,converters={0:convert})',
    'np.loadtxt(path,converters={0:convert})',
    'np.genfromtxt(path,converters={0:convert})'
  ])('retains NumPy text reader helper calls without a return: %s', async (call) => {
    const source = `import numpy as np\ndef load(path):\n    ${call}\nload("input.txt")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['input.txt'],
      externalState: 'partial'
    })
  })
  it.each([
    'np.loadtxt(path,fname="other.txt")',
    'np.loadtxt(path,converters={0:convert},**options)',
    'np.genfromtxt(path,float,"#",None,0,0,{},converters=None)',
    'np.loadtxt(path,invalid=True)'
  ])('rejects unresolved NumPy text reader helper signatures: %s', async (call) => {
    const source = `import numpy as np\ndef load(path):\n    return ${call}\nload("input.txt")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      externalState: 'partial'
    })
  })
  it.each([
    'import numpy as np\nnp.loadtxt=other\ndef load(path):\n    return np.loadtxt(path,converters={0:convert})\nload("input.txt")',
    'import numpy as np\ndef load(path,np):\n    return np.loadtxt(path,converters={0:convert})\nload("input.txt",other)'
  ])('checks active NumPy text reader helper authority: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      externalState: 'partial'
    })
  })
  it('does not invoke an unused NumPy text reader helper', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import numpy as np\ndef load(path):\n    return np.loadtxt(path,converters={0:convert})'
      )
    ).toMatchObject({ reads: [], writes: [] })
  })
  it.each([
    'np.loadtxt(path,converters={0:convert})',
    'np.loadtxt(path,float,"#",None,{0:convert})',
    'np.genfromtxt(path,converters={0:convert})',
    'np.genfromtxt(path,float,"#",None,0,0,{0:convert})'
  ])('keeps NumPy text reader helper converter I/O partial: %s', async (call) => {
    const source = `import numpy as np\ndef convert(value):\n    return float(value)+float(open("offset.txt").read())\ndef load(path):\n    return ${call}\nvalue=load("input.txt")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['input.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each(['loadtxt', 'genfromtxt'])(
    'retains NumPy text reader helper aliases: %s',
    async (reader) => {
      const source = `from numpy import ${reader} as read\ndef load(path):\n    return read(path,converters={0:convert})\nvalue=load("input.txt")`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['input.txt'],
        externalState: 'partial'
      })
    }
  )

  it('retains NumPy text reader helper converter default argument reads', async () => {
    const source =
      'import numpy as np\ndef load(path):\n    return np.loadtxt(path,converters=lambda value,offset=float(open("offset.txt").read()):float(value)+offset)\nvalue=load("input.txt")'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['input.txt', 'offset.txt'],
      externalState: 'partial'
    })
  })

  it.each([
    'np.savetxt(path,np.load("input.npy"))',
    'return np.savetxt(fname=path,X=np.load("input.npy"))',
    'np.savetxt(path,[1,2],header=open("header.txt").read())'
  ])('retains NumPy text writer helper argument reads: %s', async (body) => {
    const source = `import numpy as np\ndef export(path):\n    ${body}\nexport("result.txt")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [body.includes('header.txt') ? 'header.txt' : 'input.npy'],
      writes: ['result.txt'],
      externalState: 'partial'
    })
  })

  it('retains the input of an aliased NumPy text writer helper', async () => {
    const source =
      'import numpy as np\nfrom numpy import savetxt as emit\ndef export(path):\n    emit(path,np.load("input.npy"))\nexport("result.txt.gz")'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['input.npy'],
      writes: ['result.txt.gz'],
      externalState: 'partial'
    })
  })

  it('does not give NumPy text writer authority to a helper parameter', async () => {
    const source =
      'import numpy as np\ndef export(path,np):\n    np.savetxt(path,[1,2])\nexport("result.txt",other)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: [],
      externalState: 'partial'
    })
  })

  it('does not invoke an unused NumPy text writer helper', async () => {
    const source =
      'import numpy as np\ndef export(path):\n    np.savetxt(path,np.load("input.npy"))'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it.each([
    'np.savetxt(path,[1,2],fname="other.txt")',
    'np.savetxt(path)',
    'np.savetxt(path,[1,2],unknown=True)',
    'np.savetxt(path,[1,2],**options)'
  ])('does not certify unresolved NumPy text writer helper binding: %s', async (call) => {
    const source = `import numpy as np\ndef export(path):\n    ${call}\nexport("result.txt")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: [],
      externalState: 'partial'
    })
  })

  it.each([
    'import numpy as np\nnp.savetxt=other\ndef export(path):\n    np.savetxt(path,[1,2])',
    'def savetxt(path,data):\n    return None\ndef export(path):\n    savetxt(path,[1,2])'
  ])('does not borrow NumPy text writer authority from a rebound name: %s', async (definitions) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', definitions + '\nexport("result.txt")')
    ).toMatchObject({ writes: [], externalState: 'partial' })
  })

  it.each([
    'from pathlib import Path\nexport(Path("result.txt"))',
    'with open("result.txt","w") as handle:\n    export(handle)'
  ])(
    'retains NumPy text writer helper inputs through paths and handles: %s',
    async (invocation) => {
      const source = `import numpy as np\ndef export(path):\n    np.savetxt(path,np.load("input.npy"))\n${invocation}`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['input.npy'],
        writes: ['result.txt']
      })
    }
  )

  it('retains writable mapping effects inside a NumPy text writer helper', async () => {
    const source =
      'import numpy as np\ndef export(path):\n    np.savetxt(path,np.load("input.npy",mmap_mode="r+"))\nexport("result.txt")\nnp.save("later.npy",np.array([1,2]))'
    const result = await analyzePythonNotebookSource(source)
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['input.npy'],
      writes: ['input.npy', 'later.npy', 'result.txt']
    })
    expect(result.fileAccess?.context.pythonMayHaveWritableMappings).toBe(true)
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it('retains nested input reads inside a NumPy archive writer helper', async () => {
    const source =
      'import numpy as np\ndef export(path):\n    np.savez(path,values=np.load("input.npy"))\nexport("result")'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['input.npy'],
      writes: ['result.npz']
    })
  })

  it('retains a Path argument to a NumPy archive writer helper', async () => {
    const source =
      'import numpy as np\nfrom pathlib import Path\ndef export(path):\n    np.savez(path,values=[1,2])\nexport(Path("result"))'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: ['result.npz']
    })
  })

  it.each([
    'np.savez(path,file="wrong",values=[1,2])',
    'np.savez(file=path,**options)',
    'np.savez(*paths,values=[1,2])'
  ])('does not certify unresolved archive helper path binding: %s', async (call) => {
    const source = `import numpy as np\ndef export(path):\n    ${call}\nexport("result")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: [],
      externalState: 'partial'
    })
  })

  it('does not use a shadowed namespace parameter as an archive writer', async () => {
    const source =
      'import numpy as np\ndef export(path,np):\n    np.savez(path,values=[1,2])\nexport("result",other)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: [],
      externalState: 'partial'
    })
  })

  it('does not invoke an unused NumPy archive helper', async () => {
    const source = 'import numpy as np\ndef export(path):\n    np.savez(path,values=[1,2])'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })
  it.each(['savez', 'savez_compressed'])(
    'retains the physical .npz path of a %s helper',
    async (method) => {
      const source = `import numpy as np\ndef export(path):\n    np.${method}(path,values=np.array([1,2]))\nexport("result")\nvalue=np.load("result")`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['result'],
        writes: ['result.npz']
      })
    }
  )

  it.each(['"result.npz"', '"result.bin"'])(
    'retains NumPy archive helper suffix rules for %s',
    async (target) => {
      const source = `import numpy as np\ndef export(path):\n    return np.savez(file=path,values=np.array([1,2]))\nexport(${target})`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        writes: [target === '"result.npz"' ? 'result.npz' : 'result.bin.npz']
      })
    }
  )

  it('does not append an archive suffix to a helper file handle', async () => {
    const source =
      'import numpy as np\ndef export(handle):\n    np.savez(handle,values=np.array([1,2]))\nwith open("result.bin","wb") as handle:\n    export(handle)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: ['result.bin']
    })
  })

  it('resolves the actual imported archive writer alias inside a helper', async () => {
    const source =
      'from numpy import savez as pack\ndef export(path):\n    pack(path,values=[1,2])\nexport("result")'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: ['result.npz']
    })
  })

  it('does not borrow archive writer semantics from a local shadow', async () => {
    const source =
      'def savez(path,**values):\n    return None\ndef export(path):\n    savez(path,values=[1,2])\nexport("result")'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })
  it.each([
    'from numpy import load as read\ndef reopen(path):\n    return read(path,mmap_mode="r+")\nmapped=reopen("seed.npy")',
    'import numpy as np\ndef reopen(path):\n    return np.load(path,mmap_mode="r+")\ndef outer(path):\n    return reopen(path)\nmapped=outer("seed.npy")',
    'import numpy as np\ndef reopen(path,mode="r+"):\n    return np.load(path,mmap_mode=mode)\nmapped=reopen("seed.npy")',
    'import numpy as np\ndef reopen(path,mode):\n    return np.load(path,mmap_mode=mode)\nmapped=reopen("seed.npy","r+")'
  ])('retains aliased and delegated NumPy helper mappings: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.npy'],
      writes: ['seed.npy'],
      externalState: 'partial'
    })
    expect(
      (
        await analyzePythonNotebookSource(
          source + '\nimport numpy as np\nnp.save("seed.npy",np.array([3,4]))'
        )
      ).facts.serializedValueWrites ?? []
    ).toEqual([])
  })

  it('does not create NumPy mapping effects for an uninvoked helper', async () => {
    const source =
      'import numpy as np\ndef reopen(path):\n    return np.load(path,mmap_mode="r+")\nnp.save("result.npy",np.array([1,2]))'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: ['result.npy']
    })
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
      { path: 'result.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })

  it('does not borrow NumPy mapping authority for a local loader shadow', async () => {
    const source =
      'import numpy as np\ndef load(path,mmap_mode=None):\n    return np.array([1,2])\ndef reopen(path):\n    return load(path,mmap_mode="r+")\nmapped=reopen("seed.npy")'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: []
    })
    expect(
      (await analyzePythonNotebookSource(source + '\nnp.save("result.npy",np.array([3]))')).facts
        .serializedValueWrites
    ).toEqual([{ path: 'result.npy', format: 'npy', valueType: 'numpy.ndarray' }])
  })

  it.each([
    'np.load(path,mmap_mode="r+")',
    'np.load(path,"r+")',
    'np.load(file=path,mmap_mode="r+")',
    'np.load(path,mmap_mode=mode)',
    'np.load(path,**options)'
  ])('retains writable NumPy mapping helper effects: %s', async (call) => {
    const source = `import numpy as np\ndef reopen(path):\n    return ${call}\nmapped=reopen("seed.npy")\nmapped[0]=7`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.npy'],
      writes: ['seed.npy'],
      externalState: 'partial'
    })
  })

  it.each(['"r+"', 'mode'])(
    'revokes serialized proof through a NumPy mapping helper: %s',
    async (mode) => {
      const source = `import numpy as np\ndef reopen(path):\n    return np.load(path,mmap_mode=${mode})\nnp.save("seed.npy",np.array([1,2]))\nmapped=reopen("seed.npy")\nnp.save("seed.npy",np.array([3,4]))`
      expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual(
        []
      )
    }
  )

  it.each(['"r"', '"c"', 'None'])(
    'preserves nonpersistent NumPy helper controls: %s',
    async (mode) => {
      const source = `import numpy as np\ndef reopen(path):\n    return np.load(path,mmap_mode=${mode})\nmapped=reopen("seed.npy")\nnp.save("result.npy",np.array([3,4]))`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['seed.npy'],
        writes: ['result.npy']
      })
      expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
        { path: 'result.npy', format: 'npy', valueType: 'numpy.ndarray' }
      ])
    }
  )

  it.each([
    'np.load(file="seed.npy",max_header_size=10000)',
    'np.load("seed.npy",None,False,True,"ASCII")',
    'np.load(encoding="ASCII",allow_pickle=False,file="seed.npy")'
  ])('retains matched NumPy load paths: %s', async (call) => {
    const source = `import numpy as np\nvalue=${call}`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.npy'],
      writes: []
    })
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueReads).toEqual([
      'seed.npy'
    ])
  })

  it.each(['savez', 'savez_compressed'])('retains arbitrary %s data keywords', async (method) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import numpy as np\nnp.${method}("result.npz",bogus=np.array([1,2]))`
      )
    ).toMatchObject({ writes: ['result.npz'] })
  })

  it.each(['save', 'load'])('validates an imported NumPy %s alias', async (method) => {
    const source = `from numpy import ${method} as operation\noperation("result.npy",bogus=True)`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: [],
      externalState: 'partial'
    })
  })

  it('retains NumPy handle destinations without appending a suffix', async () => {
    const source =
      'import numpy as np\nwith open("result.bin","wb") as f:\n    np.save(f,np.array([1,2]))'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: ['result.bin']
    })
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
      { path: 'result.bin', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })

  it('does not apply NumPy signatures to a local loader shadow', async () => {
    const source =
      'def load(path,bogus=False):\n    return [1,2]\nvalue=load("seed.npy",bogus=True)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: []
    })
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueReads ?? []).toEqual([])
  })

  it('allows a later valid NumPy save to establish fresh proof', async () => {
    const source =
      'import numpy as np\nnp.load("seed.npy",bogus=True)\nnp.save("result.npy",np.array([1,2]))'
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
      { path: 'result.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })

  it.each([
    'np.save("result.npy",np.array([1,2]),bogus=True)',
    'np.save("result.npy",np.array([1,2]),file="other.npy")',
    'np.save("result.npy",np.array([1,2]),arr=np.array([3]))',
    'np.save("result.npy",np.array([1,2]),True,False)',
    'np.save("result.npy")',
    'np.save(file="result.npy",**options)',
    'np.load("result.npy",bogus=True)',
    'np.load("result.npy",file="other.npy")',
    'np.load("result.npy",None,False,True,"ASCII",10000)',
    'np.load()',
    'np.load(*paths)'
  ])('rejects unresolved NumPy serialization argument layouts: %s', async (call) => {
    const source = `import numpy as np\n${call}`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual(
      []
    )
  })

  it.each([
    'np.save(arr=np.array([1,2]),file="result.npy")',
    'np.save("result.npy",arr=np.array([1,2]),allow_pickle=False)',
    'np.save("result.npy",np.array([1,2]),False)'
  ])('preserves matched NumPy save argument layouts: %s', async (call) => {
    const source = `import numpy as np\n${call}`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: ['result.npy']
    })
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
      { path: 'result.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })

  it.each([
    'np.load("result.npy",bogus=True)',
    'np.save("bad.npy",np.save("result.npy",np.array([3])),bogus=True)',
    'read("result.npy")'
  ])('revokes NumPy proof across rejected direct and helper calls: %s', async (call) => {
    const source = [
      'import numpy as np',
      'def read(path):\n    return np.load(path,bogus=True)',
      'np.save("result.npy",np.array([1,2]))',
      call,
      'value=np.load("result.npy")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['result.npy'],
      writes: ['result.npy'],
      externalState: 'partial'
    })
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual(
      []
    )
  })

  it.each([
    'base::saveRDS(obj=list(x=1),fi="result.rds")',
    'base::saveRDS(a=FALSE,v=2L,co=FALSE,re=NULL,list(x=1),"result.rds")',
    'base::saveRDS(obj=list(x=1),co=FALSE,"result.rds")',
    'base::saveRDS(fi="result.rds",co=FALSE,list(x=1))'
  ])('matches RDS writer arguments for paths and value proof: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: ['result.rds']
    })
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toEqual([
      { path: 'result.rds', format: 'rds', valueType: 'r-value' }
    ])
  })

  it.each(['base::readRDS(fi="seed.rds")', 'base::readRDS(re=NULL,"seed.rds")'])(
    'matches RDS reader paths and serialized reads: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['seed.rds'],
        writes: []
      })
      expect((await analyzeRNotebookSource(source)).facts.serializedValueReads).toEqual([
        'seed.rds'
      ])
    }
  )

  it.each([
    'base::saveRDS(list(x=1),file="result.rds",fi="other.rds")',
    'base::saveRDS(list(x=1),"result.rds",bogus=TRUE)',
    'base::saveRDS(fi="result.rds")',
    'base::saveRDS(list(x=1),"result.rds",FALSE,NULL,FALSE,NULL,0)',
    'base::readRDS(file="seed.rds",fi="other.rds")',
    'base::readRDS("seed.rds",bogus=TRUE)',
    'base::readRDS("seed.rds",NULL,0)',
    'base::readRDS(...)'
  ])('rejects invalid RDS layouts as serialized proof: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const result = await analyzeRNotebookSource('saveRDS(list(x=1),"checkpoint.rds");' + source)
    expect(result.facts.state).toBe('unknown')
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it.each([
    'version=999L',
    'version=version',
    'ascii=flag',
    'compress="invalid"',
    'refhook=function(x) NULL',
    'refhook=hook'
  ])('keeps unproven RDS writer options partial without proof: %s', async (option) => {
    const source = `base::saveRDS(list(x=1),"result.rds",${option})`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      writes: ['result.rds'],
      writeState: 'partial',
      externalState: 'partial'
    })
    const result = await analyzeRNotebookSource(source)
    expect(result.facts.state).toBe('unknown')
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it('does not suppress a later RDS input after a writer with invalid options', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::saveRDS(list(x=1),"result.rds",version=999L);base::readRDS("result.rds")'
      )
    ).toMatchObject({ reads: ['result.rds'], writes: ['result.rds'], externalState: 'partial' })
  })

  it('does not trust RDS readers with a custom refhook', async () => {
    const source =
      'base::saveRDS(list(x=1),"seed.rds");value <- base::readRDS(fi="seed.rds",re=function(x) NULL);base::saveRDS(value,"result.rds")'
    const result = await analyzeRNotebookSource(source)
    expect(result.facts.state).toBe('unknown')
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it.each(['version=999L', 'refhook=hook', 'bogus=TRUE'])(
    'does not certify RDS wrapper writes with unsupported options: %s',
    async (option) => {
      const source = `emit <- function(path) base::saveRDS(list(x=1),path,${option});emit("result.rds");base::readRDS("result.rds")`
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['result.rds'],
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
    }
  )

  it('retains a valid RDS wrapper destination with partial argument names', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'emit <- function(path) base::saveRDS(obj=list(x=1),fi=path,co=FALSE);emit("result.rds")'
      )
    ).toMatchObject({ reads: [], writes: ['result.rds'] })
  })

  it('retains value proof through a matched RDS roundtrip', async () => {
    const source =
      'base::saveRDS(obj=list(x=1),fi="seed.rds");value <- base::readRDS(fi="seed.rds");base::saveRDS(value,"result.rds")'
    expect((await analyzeRNotebookSource(source)).facts.serializedValueWrites).toEqual([
      { path: 'seed.rds', format: 'rds', valueType: 'r-value' },
      { path: 'result.rds', format: 'rds', valueType: 'r-value' }
    ])
  })

  it.each(['readRDS', 'saveRDS'])(
    'does not apply RDS effects to a local %s shadow',
    async (name) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `${name} <- function(...) NULL;${name}(obj=list(x=1),fi="result.rds")`
        )
      ).toMatchObject({ reads: [], writes: [] })
    }
  )

  it.each([
    'from scipy.io import loadmat\nvalue=loadmat("seed")',
    'import scipy.io as sio\nvalue=sio.loadmat(file_name="seed")',
    'from scipy.io import loadmat as read\nvalue=read("seed",None,True)',
    'from scipy.io import loadmat\ntarget="seed"\nvalue=loadmat(target)',
    'from scipy.io import loadmat\ndef reopen(path):\n    return loadmat(path)\nvalue=reopen("seed")',
    'from scipy.io import whosmat\nvalue=whosmat("seed")',
    'import scipy.io as sio\nvalue=sio.whosmat(file_name="seed")',
    'from scipy.io import whosmat as inspect\nvalue=inspect("seed",True)'
  ])('retains both possible SciPy MAT string inputs: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed', 'seed.mat'],
      writes: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'from scipy.io import loadmat\nvalue=loadmat("seed",appendmat=False)',
    'from scipy.io import loadmat\nvalue=loadmat("seed",None,False)',
    'from scipy.io import whosmat\nvalue=whosmat("seed",False)',
    'from scipy.io import whosmat\nvalue=whosmat("seed",appendmat=False)',
    'from pathlib import Path\nfrom scipy.io import loadmat\nvalue=loadmat(Path("seed"))',
    'from pathlib import Path\nfrom scipy.io import loadmat\ntarget=Path("seed")\nvalue=loadmat(target)',
    'from pathlib import Path\nfrom scipy.io import whosmat\nvalue=whosmat(Path("seed"))'
  ])('does not append a fallback for disabled or Path SciPy MAT inputs: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed'],
      writes: []
    })
  })

  it.each([
    'from scipy.io import loadmat\nvalue=loadmat("seed.mat")',
    'from scipy.io import whosmat\nvalue=whosmat("seed.mat")',
    'from scipy.io import loadmat\nwith open("seed.mat","rb") as handle:\n    value=loadmat(handle)',
    'from scipy.io import loadmat\nvalue=loadmat(open("seed.mat","rb"))'
  ])('keeps exact SciPy MAT paths and handle inputs: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['seed.mat'],
      writes: []
    })
  })

  it.each([
    'from scipy.io import loadmat\nvalue=loadmat("seed",file_name="other")',
    'from scipy.io import loadmat\nvalue=loadmat("seed",None,True,0)',
    'from scipy.io import loadmat\nvalue=loadmat("seed",None,True,appendmat=False)',
    'from scipy.io import whosmat\nvalue=whosmat("seed",True,False)'
  ])('keeps invalid SciPy MAT layouts uncertain without invented paths: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'from scipy.io import loadmat\ndef reopen(path):\n    return loadmat(path,appendmat=False)\nvalue=reopen("seed")',
    'from scipy.io import loadmat\ndef reopen(path):\n    return loadmat(file_name=path)\nvalue=reopen("seed.mat")'
  ])('retains bounded SciPy MAT wrapper options: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: source.includes('seed.mat') ? ['seed.mat'] : ['seed'],
      writes: []
    })
  })

  it('keeps dynamic SciPy MAT fallback options uncertain', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from scipy.io import loadmat\nvalue=loadmat("seed",appendmat=flag)'
      )
    ).toMatchObject({
      reads: ['seed', 'seed.mat'],
      writes: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not invent SciPy MAT disk paths for an in-memory buffer', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from io import BytesIO\nfrom scipy.io import loadmat\nbuffer=BytesIO()\nvalue=loadmat(buffer)'
      )
    ).toMatchObject({ reads: [], writes: [] })
  })

  it('does not infer SciPy MAT effects for a shadowed loader', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from scipy.io import loadmat\nloadmat=lambda path: None\nvalue=loadmat("seed")'
      )
    ).toMatchObject({ reads: [], writes: [] })
  })

  it('does not restore SciPy MAT path authority after a member overwrite', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import scipy.io as sio\nsio.loadmat=custom\nvalue=sio.loadmat("seed")'
      )
    ).toMatchObject({ reads: [], writes: [], externalState: 'partial' })
  })

  it.each([
    'readLines(co="seed.bin",w=FALSE)',
    'base::readLines(co="seed.bin",w=FALSE)',
    'base::readLines(n=1L,w=FALSE,"seed.bin")',
    'base::readLines(w=FALSE,co="seed.bin",1L)',
    'con <- base::file("seed.bin","rb");base::readLines(co=con,w=FALSE);base::close(con)',
    'read <- function(path) base::readLines(co=path,w=FALSE);read("seed.bin")'
  ])('matches R readLines arguments and wrappers: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['seed.bin'],
      writes: []
    })
  })

  it.each([
    'writeLines(te="new",co="result.bin")',
    'base::writeLines(te="new",co="result.bin")',
    'base::writeLines(se="|",u=TRUE,"new","result.bin")',
    'base::writeLines(se="|",te="new","result.bin")',
    'base::writeLines(se="|",co="result.bin","new")',
    'emit <- function(path) base::writeLines(te="new",co=path,se="|");emit("result.bin")'
  ])('matches R writeLines arguments and wrappers: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: ['result.bin']
    })
  })

  it.each([
    'base::readLines(con="seed.bin",co="other.bin")',
    'base::readLines("seed.bin",bogus=TRUE)',
    'base::readLines("seed.bin",1L,TRUE,FALSE,"unknown",FALSE,0)',
    'base::readLines("seed.bin",...)',
    'base::writeLines(text="new",con="result.bin",co="other.bin")',
    'base::writeLines("new","result.bin",bogus=TRUE)',
    'base::writeLines(co="result.bin")',
    'base::writeLines("new","result.bin","|",TRUE,0)',
    'base::writeLines("new",...)'
  ])('keeps invalid R line I/O layouts uncertain: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const result = await analyzeRNotebookSource('saveRDS(list(x=1),"checkpoint.rds");' + source)
    expect(result.facts.state).toBe('unknown')
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it.each([
    'base::writeLines(base::readLines("seed.bin",warn=FALSE))',
    'base::writeLines(te=base::readLines(co="seed.bin",w=FALSE))'
  ])('retains nested R line inputs when writing to the console: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['seed.bin'],
      writes: []
    })
  })

  it('retains nested R line input and output', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeLines(te=base::readLines(co="seed.bin",w=FALSE),co="result.bin",se="|")'
      )
    ).toMatchObject({ reads: ['seed.bin'], writes: ['result.bin'] })
  })

  it('retains existing bytes as input for an R line append connection', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'con <- base::file("result.bin","ab");base::writeLines(te="new",co=con,se="|");base::close(con)'
      )
    ).toMatchObject({ reads: ['result.bin'], writes: ['result.bin'] })
  })

  it.each(['readLines', 'writeLines'])(
    'does not infer line I/O for a local %s shadow',
    async (name) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `${name} <- function(...) NULL;${name}(te="new",co="result.bin")`
        )
      ).toMatchObject({ reads: [], writes: [] })
    }
  )

  it('does not mistake writeLines options for a console output path', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'base::writeLines(se="|",te="new")')
    ).toMatchObject({ reads: [], writes: [] })
  })

  it.each([
    'readChar(co="seed.bin",n=3L,u=TRUE)',
    'base::readChar(co="seed.bin",n=3L,u=TRUE)',
    'base::readChar(u=TRUE,n=3L,"seed.bin")',
    'base::readChar(u=TRUE,co="seed.bin",3L)',
    'con <- base::file("seed.bin","rb");base::readChar(n=3L,co=con);base::close(con)'
  ])('matches R readChar partial and reordered arguments: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['seed.bin'],
      writes: []
    })
  })

  it.each([
    'writeChar(obj="new",co="result.bin",e=NULL)',
    'base::writeChar(obj="new",co="result.bin",e=NULL)',
    'base::writeChar(e=NULL,u=TRUE,n=2L,"new","result.bin")',
    'base::writeChar(e=NULL,obj="new","result.bin")',
    'base::writeChar(e=NULL,co="result.bin","new")'
  ])('matches R writeChar partial and reordered arguments: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      writes: ['result.bin'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'base::readChar(con="seed.bin",con="other.bin",nchars=3L)',
    'base::readChar("seed.bin",3L,bogus=TRUE)',
    'base::readChar(co="seed.bin")',
    'base::readChar("seed.bin",3L,TRUE,0)',
    'base::readChar(con="seed.bin",nchars=3L,n=2L)',
    'base::readChar("seed.bin",...)'
  ])('keeps invalid R readChar argument layouts uncertain: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const result = await analyzeRNotebookSource('saveRDS(list(x=1),"checkpoint.rds");' + source)
    expect(result.facts.state).toBe('unknown')
    expect(result.facts.serializedValueWrites ?? []).toEqual([])
  })

  it.each([
    'base::writeChar(obj=base::readChar(co="seed.bin",n=3L,u=TRUE),co="result.bin",e=NULL)',
    'base::writeChar(object=payload,con="result.bin",eos=NULL)'
  ])('retains possible R writeChar outputs independently of payload proof: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      writes: ['result.bin'],
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not suppress a later read after a partial-name writeChar', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'base::writeChar(obj="new",co="result.bin",e=NULL);base::readChar(co="result.bin",n=3L)'
      )
    ).toMatchObject({ reads: ['result.bin'], writes: ['result.bin'], externalState: 'partial' })
  })

  it.each(['readChar', 'writeChar'])(
    'does not assign base character I/O effects to a local %s shadow',
    async (name) => {
      const source = `${name} <- function(...) NULL;${name}(co="result.bin",n=3L)`
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: [],
        writes: []
      })
    }
  )

  it.each([
    'file.copy("inputs/data.tsv", "outputs/observed.tsv")',
    'base::file.copy("inputs/data.tsv", "outputs/observed.tsv", overwrite=TRUE)',
    'file.copy(to="outputs/observed.tsv", from="inputs/data.tsv", recursive=FALSE)',
    'src <- "inputs/data.tsv"; dst <- "outputs/observed.tsv"; file.copy(src, dst)'
  ])(
    'retains possible base R copy paths without claiming complete filesystem coverage: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/data.tsv'],
        writes: ['outputs/observed.tsv'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('does not treat a possible copy as a successful producer for a later read', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'file.copy("inputs/data.tsv", "outputs/observed.tsv"); readLines("outputs/observed.tsv")'
      )
    ).toMatchObject({ reads: ['inputs/data.tsv', 'outputs/observed.tsv'], writeState: 'partial' })
  })

  it.each([
    'file.copy <- custom; file.copy("inputs/data.tsv", "outputs/observed.tsv")',
    'other::file.copy("inputs/data.tsv", "outputs/observed.tsv")',
    'file.copy("inputs/data.tsv", "outputs/observed.tsv", recursive=TRUE)'
  ])(
    'does not assign single-file copy paths to unrelated or recursive calls: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial'
      })
    }
  )

  it.each([
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)',
    'from importlib import util as u\nspec = u.spec_from_file_location("helper", "outputs/helper.py")\nmodule = u.module_from_spec(spec)\nspec.loader.exec_module(module)',
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nexecute = spec.loader.exec_module\nexecute(module)',
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nexecute = spec.loader.exec_module\nother = execute\nother(module)',
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nif True:\n    execute = spec.loader.exec_module\nexecute(module)',
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nexecute = spec.loader.exec_module\nif False:\n    execute = lambda module: None\nexecute(module)',
    'import importlib.machinery as machinery\nloader = machinery.SourceFileLoader("helper", "outputs/helper.py")\nloader.load_module("helper")'
  ])('keeps unmodeled Python module execution I/O uncertain: %s', async (source) => {
    const access = await analyzeNotebookSourceFileAccess('python', source)
    expect(access).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      writes: []
    })
    expect(access.reasonCodes).toContain('dynamic-path-unresolved')
  })

  it('preserves explicit paths alongside unmodeled Python module execution', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nwith open("inputs/data.csv") as source:\n    data = source.read()\nwith open("outputs/report.txt", "w") as target:\n    target.write(data)'
    )
    expect(access).toMatchObject({
      reads: ['inputs/data.csv'],
      writes: ['outputs/report.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not treat constructing a module specification as module execution', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)'
      )
    ).toMatchObject({ writes: [], writeState: 'complete' })
  })

  it('does not impose loader effects on a local function with the same name', async () => {
    const source =
      'from pathlib import Path\ndef emit(path):\n    Path(path).write_text("done")\nemit("outputs/report.txt")'
    expect(
      await analyzeNotebookSourceFileAccess('python', source.replaceAll('emit', 'exec_module'))
    ).toEqual(await analyzeNotebookSourceFileAccess('python', source))
  })

  it('does not execute a bound loader alias after it is rebound', async () => {
    const source =
      'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nexecute = spec.loader.exec_module\nexecute = lambda module: None\nexecute(module)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: [],
      writeState: 'complete'
    })
  })

  it('records the known trace destination of R cat', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'TRACE_PATH <- "outputs/score-trace.csv"; header <- "call_id,score"; cat(header, "\\n", file=TRACE_PATH, append=FALSE, sep="")'
      )
    ).toMatchObject({ reads: [], writes: ['outputs/score-trace.csv'] })
  })

  it.each([
    ['base::cat("next", file="report.txt", append=TRUE)', ['report.txt']],
    ['cat("next", file="report.txt", append=FALSE)', []],
    ['cat("next", file="report.txt")', []],
    ['cat("next", file="report.txt", app=TRUE)', []]
  ] as const)('matches only the exact post-dots R cat append option: %s', async (source, reads) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads,
      writes: ['report.txt'],
      writeState: 'complete'
    })
  })

  it('does not require old bytes after R cat replaces and then appends', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'cat("first", file="report.txt"); cat("next", file="report.txt", append=TRUE)'
      )
    ).toMatchObject({ reads: [], writes: ['report.txt'], writeState: 'complete' })
  })

  it('retains a known R cat destination with uncertain append intent', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'cat("next", file="report.txt", append=flag)')
    ).toMatchObject({ writes: ['report.txt'], readState: 'partial', writeState: 'partial' })
  })

  it.each([
    'con <- file("report.txt", "rt"); cat("next", file=con); readLines("report.txt")',
    'con <- file("report.txt", "wt"); close(con); cat("next", file=con); readLines("report.txt")',
    'con <- file("report.txt", mode); cat("next", file=con); readLines("report.txt")'
  ])(
    'does not certify a cat write through an unusable or unknown connection: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['report.txt'],
        writes: ['report.txt'],
        readState: 'partial',
        writeState: 'partial'
      })
    }
  )

  it.each([
    ['at', 'FALSE', ['report.txt']],
    ['wt', 'TRUE', []],
    ['', 'TRUE', []]
  ] as const)('uses the R cat connection mode %s before append=%s', async (mode, append, reads) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `con <- file("report.txt", "${mode}"); alias <- con; cat("next", file=alias, append=${append})`
      )
    ).toMatchObject({ reads, writes: ['report.txt'], writeState: 'complete' })
  })

  it.each([
    'cat("next", "report.txt")',
    'cat("next", fil="report.txt")',
    'cat("next", fi="report.txt")'
  ])('does not interpret R cat data after dots as a file control: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).writes).toEqual([])
  })

  it.each([
    'cat(readLines("input.txt"))',
    'base::cat(readLines("input.txt"), file="")',
    'cat(readLines("input.txt"), file="|consumer")',
    'cat(readLines("input.txt"), file=1)'
  ])('retains nested R cat readers without inventing a disk destination: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['input.txt'],
      writes: []
    })
  })

  it.each([
    'other::cat("next", file="report.txt")',
    'cat <- custom; cat("next", file="report.txt")',
    'if (flag) cat <- custom; cat("next", file="report.txt")',
    'emit <- base::cat; emit <- custom; emit("next", file="report.txt")',
    'emit <- function(path) cat("next", file=path); cat <- custom; emit("report.txt")',
    'emit <- function(path) base::cat("next", file=path); emit("")',
    'emit <- function(path) base::cat("next", file=path); emit("|consumer")'
  ])(
    'does not infer a base R cat destination through a different callable or wrapper: %s',
    async (source) => {
      expect((await analyzeNotebookSourceFileAccess('r', source)).writes).toEqual([])
    }
  )

  it('preserves opaque R effects alongside a known cat destination', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'opaque(); base::cat("next", file="report.txt")')
    ).toMatchObject({
      writes: ['report.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each(['TRUE', 'flag'])(
    'does not borrow base cat append=%s semantics for a known local replacement writer',
    async (append) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `cat <- function(file, append) writeLines("next", file); cat("report.txt", append=${append})`
        )
      ).toMatchObject({ reads: [], writes: ['report.txt'], writeState: 'complete' })
    }
  )

  it('keeps base cat append separate from a same-name local replacement writer', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'cat <- function(file, append) writeLines("next", file); base::cat("base", file="base.txt", append=TRUE); cat("report.txt", append=TRUE)'
      )
    ).toMatchObject({
      reads: ['base.txt'],
      writes: ['base.txt', 'report.txt'],
      writeState: 'complete'
    })
  })

  it.each([
    'write("{}", "outputs/report.json")',
    'base::write("{}", file="outputs/report.json")',
    'write("outputs/report.json", x="{}")',
    'write("{}", fi="outputs/report.json")'
  ])('recognizes base R write destinations with R argument matching: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: ['outputs/report.json'],
      writeState: 'complete'
    })
  })

  it.each([
    'write("next", "report.txt", append=TRUE)',
    'base::write("next", "report.txt", 1, TRUE)',
    'write("report.txt", x="next", app=TRUE)',
    'con <- file("report.txt", "at"); other <- con; write("next", other)'
  ])('retains preceding bytes for an R write append: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['report.txt'],
      writes: ['report.txt'],
      writeState: 'complete'
    })
  })

  it('recognizes the base R write default file rather than console output', async () => {
    expect(await analyzeNotebookSourceFileAccess('r', 'write("next")')).toMatchObject({
      reads: [],
      writes: ['data'],
      writeState: 'complete'
    })
  })

  it('does not require old bytes after a same-cell replacement followed by append', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'write("first", "report.txt"); write("next", "report.txt", append=TRUE)'
      )
    ).toMatchObject({
      reads: [],
      writes: ['report.txt'],
      writeState: 'complete'
    })
  })

  it('keeps dynamic append intent uncertain while retaining the exact destination', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'write("next", "report.txt", append=flag)')
    ).toMatchObject({
      writes: ['report.txt'],
      writeState: 'partial',
      readState: 'partial'
    })
  })

  it.each(['write("next", "")', 'base::write("next", "|consumer")'])(
    'does not publish console or pipe output as a disk file: %s',
    async (source) => {
      const access = await analyzeNotebookSourceFileAccess('r', source)
      expect(access.writes).toEqual([])
      expect(access.externalState).toBe('partial')
    }
  )

  it.each([
    'utils::write("next", "report.txt")',
    'unknownPackage::write("next", "report.txt")',
    'write <- function(x, file) NULL; write("next", "report.txt")',
    'write <- custom_writer; write("next", "report.txt")',
    'emit <- function(x, file) utils::write(x, file); emit("next", "report.txt")'
  ])('does not apply the base R writer contract to a different function: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).writes).toEqual([])
  })

  it.each([
    'write <- custom_writer; emit <- function(x, file) write(x, file); emit("next", "report.txt")',
    'write <- function(x, file) NULL; emit <- function(file) write("next", file); emit("report.txt")',
    'if (flag) write <- custom_writer; emit <- function(file) write("next", file); emit("report.txt")',
    'emit <- function(file) write("next", file); write <- custom_writer; emit("report.txt")',
    'emit <- function(file, write) write("next", file); emit("report.txt", custom_writer)'
  ])('does not infer a base R writer through a shadowed wrapper: %s', async (source) => {
    const access = await analyzeNotebookSourceFileAccess('r', source)
    expect(access.writes).toEqual([])
    expect(access.writeState).toBe('partial')
  })

  it('retains an explicitly qualified base writer inside a wrapper despite shadowing', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'r',
      'write <- custom_writer; emit <- function(x, file) base::write(x, file); emit("next", "report.txt")'
    )
    expect(access.writes).toEqual(['report.txt'])
  })

  it('does not promote an append wrapper into a replacement contract', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'emit <- function(file) write("next", file, append=TRUE); emit("report.txt")'
    )
    expect(result.externalState).toBe('partial')
    expect(result.writeState).toBe('partial')
  })

  it('retains nested readers when the R writer targets console output', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'write(readLines("input.txt"), "")')
    ).toMatchObject({
      reads: ['input.txt'],
      writes: [],
      externalState: 'partial'
    })
  })

  it('retains the destination without assuming custom R coercion has no hidden effects', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'x <- structure("next", class="custom"); write(x, "report.txt")'
      )
    ).toMatchObject({
      writes: ['report.txt'],
      externalState: 'partial',
      writeState: 'partial'
    })
  })

  it('preserves the mode of an already-open R connection', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("counts.txt", "at")\nother <- con\nopen(other, "wt")\nwriteLines("row", con)'
    )
    expect(result).toMatchObject({
      reads: ['counts.txt'],
      writes: ['counts.txt'],
      writeState: 'complete'
    })
  })
  it.each(['app', 'appen'])('preserves append intent in R partial argument %s', async (name) => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      `write.table(data.frame(x=1), "counts.txt", ${name}=TRUE)`
    )
    expect(result).toMatchObject({
      reads: ['counts.txt'],
      writes: ['counts.txt'],
      writeState: 'complete'
    })
  })
  it.each([
    'con <- file("counts.txt", op="at")\nwriteLines("row", con)',
    'con <- file("counts.txt")\nopen(con, op="at")\nwriteLines("row", con)'
  ])('preserves partial open arguments for an R connection', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result).toMatchObject({
      reads: ['counts.txt'],
      writes: ['counts.txt'],
      writeState: 'complete'
    })
  })
  it.each([
    'if (FALSE) open(other, "wt")',
    'while (FALSE) open(other, "wt")',
    'if (flag) open(other, "wt")'
  ])('does not apply a conditional connection mode as certain: %s', async (branch) => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      `con <- file("counts.txt", "at")\nother <- con\n${branch}\nwriteLines("row", con)`
    )
    expect(result).toMatchObject({
      reads: ['counts.txt'],
      writes: ['counts.txt'],
      writeState: 'complete'
    })
  })

  it.each(['if (flag)', 'while (flag)'])(
    'keeps a conditional first open uncertain: %s',
    async (branch) => {
      const result = await analyzeNotebookSourceFileAccess(
        'r',
        `con <- file("counts.txt")\nother <- con\n${branch} open(other, "at")\nwriteLines("row", con)`
      )
      expect(result.writeState).toBe('partial')
    }
  )

  it.each([
    'con <- gzfile("counts.gz")\nopen(open="at", con=con)\nwriteLines("row", con)',
    'con <- gzfile("at", description="counts.gz")\nwriteLines("row", con)',
    'con <- gzfile(open="at", "counts.gz")\nwriteLines("row", con)'
  ])('matches named R connection arguments before positional arguments', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result).toMatchObject({
      reads: ['counts.gz'],
      writes: ['counts.gz'],
      writeState: 'complete'
    })
  })

  it.each([
    'other <- prior_connection\nrows <- readLines(other)',
    'con <- gzfile("input.gz", "rt")\nother <- con\nother <- unknown_connection\nrows <- readLines(other)'
  ])('does not infer an unknown connection from an earlier or replaced binding', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.readState).toBe('partial')
  })

  it('preserves an input path through compressed R connection aliases', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- gzfile("inputs/counts.csv.gz", "rt")\nother <- con\nrows <- readLines(other)\nclose(con)'
    )
    expect(result).toMatchObject({
      reads: ['inputs/counts.csv.gz'],
      writes: [],
      readState: 'complete'
    })
  })
  it('discards the old R connection when a name is rebound', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("old.txt", "at")\ncon <- file("new.txt", "wt")\nwriteLines("row", con)'
    )
    expect(result).toMatchObject({ reads: [], writes: ['new.txt'] })
  })
  it('updates append mode through an R connection alias when explicitly opened', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("counts.txt")\nother <- con\nopen(con, open="at")\nwriteLines("row", other)'
    )
    expect(result).toMatchObject({ reads: ['counts.txt'], writes: ['counts.txt'] })
  })
  it('keeps an explicitly closed R connection conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("counts.txt", "at")\nclose(con)\nwriteLines("row", con)'
    )
    expect(result.writeState).toBe('partial')
  })
  it.each(["mode='w'", "mode='w-'", 'compute=True'])(
    'keeps an eager replacement Zarr write supported: %s',
    async (option) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import xarray as xr\nds = xr.Dataset()\nds.to_zarr('counts.zarr', ${option})`
      )
      expect(result).toMatchObject({ reads: [], writes: ['counts.zarr'], writeState: 'complete' })
    }
  )
  it.each(['driver=None', "driver='sec2'", "driver='stdio'"])(
    'keeps ordinary HDF5 storage supported: %s',
    async (option) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import h5py\nf = h5py.File('counts.h5', 'r+', ${option})`
      )
      expect(result).toMatchObject({
        reads: ['counts.h5'],
        writes: ['counts.h5'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )

  it.each(['file', 'gzfile', 'bzfile', 'xzfile'])(
    'retains old bytes through an R %s append connection and alias',
    async (constructor) => {
      const result = await analyzeNotebookSourceFileAccess(
        'r',
        `con <- ${constructor}("counts.csv.gz", "at")\nother <- con\nwriteLines("1,2", other)\nclose(con)`
      )
      expect(result).toMatchObject({
        reads: ['counts.csv.gz'],
        writes: ['counts.csv.gz'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )
  it.each(['', 'wt'])(
    'keeps replacing R connection mode %s independent of old bytes',
    async (mode) => {
      const result = await analyzeNotebookSourceFileAccess(
        'r',
        `con <- gzfile("counts.csv.gz", "${mode}")\nwriteLines("1,2", con)\nclose(con)`
      )
      expect(result).toMatchObject({
        reads: [],
        writes: ['counts.csv.gz'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )
  it('retains an inline binary append connection', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'writeBin(as.raw(1), file("counts.bin", "ab"))'
    )
    expect(result.reads).toEqual(['counts.bin'])
    expect(result.writes).toEqual(['counts.bin'])
  })
  it('keeps an unresolved R connection mode conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("counts.txt", open=unknown_mode)\nwriteLines("1", con)'
    )
    expect(result.writeState).toBe('partial')
  })
  it.each(["mode='a'", "append_dim='time'", "region={'time': slice(0, 1)}"])(
    'does not hide prior Zarr members for %s',
    async (option) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import xarray as xr\nds = xr.Dataset()\nds.to_zarr('counts.zarr', ${option})`
      )
      expect(result.readState).toBe('partial')
      expect(result.writes).toContain('counts.zarr')
    }
  )
  it.each(['to_zarr', 'to_netcdf'])(
    'does not claim %s delayed output is materialized',
    async (writer) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import xarray as xr\nds = xr.Dataset()\njob = ds.${writer}('counts.${writer === 'to_zarr' ? 'zarr' : 'nc'}', compute=False)`
      )
      expect(result.writeState).toBe('partial')
    }
  )
  it.each(["driver='split'", "driver='family'", "driver='core', backing_store=False"])(
    'keeps HDF5 alternate storage conservative: %s',
    async (options) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import h5py\nhandle = h5py.File('counts.h5', 'w', ${options})`
      )
      expect(result.writeState).toBe('partial')
    }
  )
})

it('records a writable NumPy load as both input and possible output', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    "import numpy as np\nmm = np.load('profiles.npy', mmap_mode='r+', allow_pickle=False)\nmm[:] = 2\nmm.flush()"
  )
  expect(result.reads).toContain('profiles.npy')
  expect(result.writes).toContain('profiles.npy')
})

it.each([
  ["np.load('profiles.npy')", false],
  ["np.load(file='profiles.npy', mmap_mode=None)", false],
  ["np.load('profiles.npy', 'r')", false],
  ["np.load('profiles.npy', mmap_mode='c')", false],
  ["np.load('profiles.npy', 'r+')", true],
  ["np.load(file='profiles.npy', mmap_mode='w+')", true],
  ["np.memmap('profiles.npy', mode='c')", false],
  ["np.lib.format.open_memmap('profiles.npy', mode='c')", false],
  ["np.lib.format.open_memmap('profiles.npy')", true]
])('distinguishes persistent and private NumPy mappings: %s', async (call, writable) => {
  const result = await analyzeNotebookSourceFileAccess('python', `import numpy as np\na = ${call}`)
  expect(result.reads).toContain('profiles.npy')
  expect(result.writes).toEqual(writable ? ['profiles.npy'] : [])
})
it.each([
  ['readonly', 'r'],
  ['copyonwrite', 'c'],
  ['readwrite', 'r+'],
  ['write', 'w+']
])('matches NumPy memmap mode alias %s to %s', async (alias, canonical) => {
  const source = (mode: string): string =>
    `import numpy as np\nmapped = np.memmap('data.bin', dtype='uint8', mode='${mode}', shape=(4,))`
  expect(await analyzeNotebookSourceFileAccess('python', source(alias))).toEqual(
    await analyzeNotebookSourceFileAccess('python', source(canonical))
  )
})

it.each(['readonly', 'copyonwrite', 'readwrite', 'write'])(
  'resolves imported and static NumPy memmap mode aliases: %s',
  async (mode) => {
    const direct = `import numpy as np\nmapped=np.memmap('data.bin', dtype='uint8', mode='${mode}', shape=(4,))`
    const indirect = `from numpy import memmap as mapping\nmode='${mode}'\nmapped=mapping('data.bin', 'uint8', mode, shape=(4,))`
    expect(await analyzeNotebookSourceFileAccess('python', indirect)).toEqual(
      await analyzeNotebookSourceFileAccess('python', direct)
    )
  }
)

it.each(['readonly', 'copyonwrite'])(
  'does not report persistent outputs for private or readonly memmap mutations: %s',
  async (mode) => {
    const source = `import numpy as np\nmapped=np.memmap('data.bin', dtype='uint8', mode='${mode}', shape=(4,))\nmapped[0]=9\nmapped.flush()`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['data.bin'],
      writes: []
    })
  }
)

it.each(['readwrite', 'write'])(
  'does not treat writable memmap aliases as proven producers: %s',
  async (mode) => {
    const source = `import numpy as np\nmapped=np.memmap('data.bin', dtype='uint8', mode='${mode}', shape=(4,))\nwith open('data.bin', 'rb') as source:\n    data=source.read()`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['data.bin'],
      writes: ['data.bin']
    })
  }
)

it.each([
  "np.memmap('data.bin', mode=unknown_mode)",
  "np.memmap('data.bin', mode='invalid')",
  "np.memmap('data.bin', mode='readonly', **options)",
  "np.memmap('data.bin', *options, mode='copyonwrite')",
  "np.lib.format.open_memmap('data.bin', mode='copyonwrite')",
  "np.lib.format.open_memmap('data.bin', mode='readwrite')",
  "np.load('data.bin', mmap_mode='copyonwrite')"
])('keeps uncertain or different-API mapping modes partial: %s', async (call) => {
  expect(
    await analyzeNotebookSourceFileAccess('python', `import numpy as np\nmapped=${call}`)
  ).toMatchObject({
    reads: ['data.bin'],
    writes: ['data.bin'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('does not recognize a shadowed memmap constructor through its mode alias', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      "from numpy import memmap\nmemmap=custom\nmapped=memmap('data.bin', mode='readonly')"
    )
  ).toMatchObject({
    reads: [],
    writes: [],
    readState: 'partial',
    reasonCodes: ['source-analysis-unsupported-call']
  })
})

it.each([
  "np.memmap('data.npy', mode='w+', shape=(4,))",
  "np.memmap('data.npy', mode='write', shape=(4,))",
  "np.memmap('data.npy', mode='r+')",
  "np.memmap('data.npy', mode='readwrite')",
  "np.memmap('data.npy')",
  "np.memmap('data.npy', mode=unknown_mode)",
  "np.memmap('data.npy', mode='r', **options)",
  "np.lib.format.open_memmap('data.npy')",
  "np.lib.format.open_memmap('data.npy', mode='w+', shape=(4,))",
  "np.load('data.npy', mmap_mode='r+')"
])('invalidates serialized value proof exposed through a writable mapping: %s', async (call) => {
  const source = `import numpy as np\nnp.save('data.npy', np.array([1,2,3]))\nmapped=${call}`
  expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
})

it.each([
  "np.memmap('data.npy', mode='r')",
  "np.memmap('data.npy', mode='readonly')",
  "np.memmap('data.npy', mode='c')",
  "np.memmap('data.npy', mode='copyonwrite')",
  "np.lib.format.open_memmap('data.npy', mode='r')",
  "np.lib.format.open_memmap('data.npy', mode='c')",
  "np.load('data.npy')",
  "np.load('data.npy', mmap_mode=None)",
  "np.load('data.npy', mmap_mode='r')",
  "np.load('data.npy', mmap_mode='c')"
])('retains serialized value proof for nonpersistent mappings: %s', async (call) => {
  const source = `import numpy as np\nnp.save('data.npy', np.array([1,2,3]))\nmapped=${call}`
  expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
    { path: 'data.npy', format: 'npy', valueType: 'numpy.ndarray' }
  ])
})

it.each([
  "from numpy import memmap as mapping\nmapped=mapping('data.npy','uint8','r+')",
  "from numpy.lib.format import open_memmap as mapping\nmapped=mapping('data.npy')",
  "mode='readwrite'\npath='./data.npy'\nmapped=np.memmap(path,mode=mode)",
  "mapped=np.memmap('data.npy',mode=(np.save('data.npy',np.array([4])), 'w+')[1],shape=(4,))",
  "mapped=np.memmap((np.save('data.npy',np.array([4])), 'data.npy')[1],mode='w+',shape=(4,))"
])(
  'invalidates mapped serialization after aliases and argument evaluation: %s',
  async (operation) => {
    const source = `import numpy as np\nnp.save('data.npy',np.array([1,2,3]))\n${operation}`
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual(
      []
    )
  }
)

it('invalidates only the resolved writable mapping target', async () => {
  const source =
    "import numpy as np\nnp.save('data.npy',np.array([1]))\nnp.save('other.npy',np.array([2]))\nmapped=np.memmap('data.npy',mode='w+',shape=(4,))"
  expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
    { path: 'other.npy', format: 'npy', valueType: 'numpy.ndarray' }
  ])
})

it('invalidates all serialized proof when a writable mapping path is unresolved', async () => {
  const source =
    "import numpy as np\nnp.save('data.npy',np.array([1]))\nnp.save('other.npy',np.array([2]))\nmapped=np.memmap(unknown_path,mode='r+')"
  expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
})

it.each(['r+', 'w+'])(
  'does not reuse verified serialized types after a writable mapping: %s',
  async (mode) => {
    const source = `import numpy as np\nmapped=np.memmap('data.npy',mode='${mode}',shape=(4,))\nrestored=np.load('data.npy')`
    const result = await analyzePythonNotebookSource(source, {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      verifiedSerializedValues: [{ path: 'data.npy', format: 'npy', valueType: 'numpy.ndarray' }]
    })
    expect(
      result.facts.typeBindings?.find((binding) => binding.target === 'restored')
    ).toBeUndefined()
  }
)

describe('serialization while writable mappings may remain alive', () => {
  const save = "with open('data.npy','r+b') as handle:\n    np.save(handle,np.array([4,5,6]))"

  it.each([
    "mapped=np.memmap('data.npy',mode='r+')",
    "mapped=np.memmap('data.npy',mode='readwrite')",
    "mapped=np.memmap('data.npy')",
    "from numpy import memmap as mapping\nmapped=mapping('data.npy','uint8','r+')",
    "path='./data.npy'\nmode='r+'\nmapped=np.memmap(path,mode=mode)",
    "original=np.memmap('data.npy',mode='r+')\nmapped=original\ndel original",
    "original=np.memmap('data.npy',mode='r+')\nmapped=original[:]\ndel original",
    "original=np.memmap('data.npy',mode='r+')\nmapped=original\noriginal=None",
    "mapped=np.load('data.npy',mmap_mode='r+')",
    "mapped=np.lib.format.open_memmap('data.npy')",
    "mapped=np.memmap(unknown_path,mode='r+')",
    "mapped=np.memmap('data.npy',mode=unknown_mode)",
    "mapped=np.memmap('data.npy',mode='r+')\nmapped._mmap.close()",
    "if condition:\n    mapped=np.memmap('data.npy',mode='r+')"
  ])('does not recertify a file while a mapping may still write it: %s', async (operation) => {
    const source = `import numpy as np\n${operation}\n${save}`
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual(
      []
    )
  })

  it.each([
    "mapped=np.memmap('data.npy',mode='r')",
    "mapped=np.memmap('data.npy',mode='readonly')",
    "mapped=np.memmap('data.npy',mode='c')",
    "mapped=np.memmap('data.npy',mode='copyonwrite')",
    "mapped=np.load('data.npy',mmap_mode='c')",
    "mapped=np.lib.format.open_memmap('data.npy',mode='c')",
    "mapped=np.load('data.npy')",
    "def unused():\n    return np.memmap('data.npy',mode='r+')"
  ])(
    'preserves later serialization without an executed writable mapping: %s',
    async (operation) => {
      const source = `import numpy as np\n${operation}\n${save}`
      expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
        { path: 'data.npy', format: 'npy', valueType: 'numpy.ndarray' }
      ])
    }
  )

  it('does not restore a trusted loader type after saving into a live mapping', async () => {
    const source = `import numpy as np\nmapped=np.memmap('data.npy',mode='r+')\n${save}\nmapped[0]=0\nrestored=np.load('data.npy')`
    const result = await analyzePythonNotebookSource(source)
    expect(
      result.facts.typeBindings?.find((binding) => binding.target === 'restored')
    ).toBeUndefined()
  })

  it('retains serialization for a different file while a known target is mapped', async () => {
    const source = `import numpy as np\nmapped=np.memmap('other.npy',mode='r+')\n${save}`
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites).toEqual([
      { path: 'data.npy', format: 'npy', valueType: 'numpy.ndarray' }
    ])
  })

  it('blocks direct-path serialized writers as well as file-handle writers', async () => {
    const source =
      "import numpy as np\nmapped=np.memmap('data.npy',mode='r+')\nnp.save('data.npy',np.array([4,5,6]))"
    expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual(
      []
    )
  })
})

it('recognizes imported mapping aliases without claiming a write already happened', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    "from numpy.lib.format import open_memmap as mapping\na = mapping(filename='profiles.npy', mode='r+')\nb = mapping(filename='profiles.npy', mode='r')"
  )
  expect(result.reads).toEqual(['profiles.npy'])
  expect(result.writes).toEqual(['profiles.npy'])
})
it.each(['mmap_mode=unknown_mode', '**options'])(
  'keeps dynamic NumPy mapping modes uncertain: %s',
  async (option) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import numpy as np\na=np.load('profiles.npy',${option})`
    )
    expect(result.reads).toContain('profiles.npy')
    expect(result.writeState).toBe('partial')
  }
)
it('does not infer NumPy mapping effects after its loader is shadowed', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    "from numpy import load\nload = custom_loader\na = load('profiles.npy', mmap_mode='r+')"
  )
  expect(result.writes).toEqual([])
  expect(result.reads).toEqual([])
})

it('retains a readonly SQLite cursor input without certifying complete SQL capture', async () => {
  const { fileAccess } = await analyzePythonNotebookSource(
    [
      'import sqlite3',
      'conn = sqlite3.connect("file:inputs/observations.sqlite?mode=ro", uri=True)',
      'cur = conn.cursor()',
      'cur.execute("SELECT row_id, uptake FROM observations ORDER BY row_id")',
      'rows = cur.fetchall()'
    ].join('\n')
  )
  expect(fileAccess?.reads).toEqual(['inputs/observations.sqlite'])
  expect(fileAccess?.unsupportedExternalState).toBe(true)
  expect(fileAccess?.context?.pythonBindings).toEqual(
    expect.arrayContaining([
      {
        name: 'conn',
        qualifiedName: 'sqlite3.Connection',
        kind: 'object',
        filePath: 'inputs/observations.sqlite'
      },
      {
        name: 'cur',
        qualifiedName: 'sqlite3.Cursor',
        kind: 'object',
        filePath: 'inputs/observations.sqlite'
      }
    ])
  )
})

it('records the inherited readonly SQLite input of a parameterized continuation', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    'cur.execute("SELECT row_id, uptake FROM observations WHERE conc >= ? ORDER BY row_id", (500,))\nrows = cur.fetchall()',
    {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonBindings: [
        {
          name: 'cur',
          qualifiedName: 'sqlite3.Cursor',
          kind: 'object',
          filePath: 'inputs/observations.sqlite'
        }
      ]
    }
  )
  expect(result).toMatchObject({
    reads: ['inputs/observations.sqlite'],
    writes: [],
    readState: 'partial',
    externalState: 'partial'
  })
})

const readonlySqliteContext = {
  staticStrings: [],
  staticCollections: [],
  localFileWrappers: [],
  pythonBindings: [
    {
      name: 'conn',
      qualifiedName: 'sqlite3.Connection',
      kind: 'object' as const,
      filePath: 'inputs/observations.sqlite'
    },
    {
      name: 'cur',
      qualifiedName: 'sqlite3.Cursor',
      kind: 'object' as const,
      filePath: 'inputs/observations.sqlite'
    }
  ]
}

it('preserves readonly SQLite paths through the actual scalar LIVE_IDS diagnostic', async () => {
  const { fileAccess } = await analyzePythonNotebookSource(
    'cur.execute("SELECT 1")\nprint("LIVE_IDS", id(conn), id(cur))',
    readonlySqliteContext
  )
  expect(fileAccess?.context?.pythonBindings).toEqual(readonlySqliteContext.pythonBindings)
})

it('preserves readonly SQLite context through the actual pandas scalar summary diagnostic', async () => {
  const { fileAccess } = await analyzePythonNotebookSource(
    'import pandas as pd\nsummary = pd.DataFrame([[7]], columns=["n"])\nprint(sorted(summary["n"].unique().tolist()))',
    readonlySqliteContext
  )
  expect(fileAccess?.context?.pythonBindings).toEqual(
    expect.arrayContaining(readonlySqliteContext.pythonBindings)
  )
})

it.each([
  'summary["n"].custom().tolist()',
  'summary["n"].unique(callback).tolist()',
  'summary["n"].unique().tolist(**options)',
  'summary["n"].map(callback).tolist()'
])(
  'does not close arbitrary summary calls around readonly SQLite context: %s',
  async (expression) => {
    const { fileAccess } = await analyzePythonNotebookSource(
      'import pandas as pd\nsummary = pd.DataFrame([[7]], columns=["n"])\nprint(' +
        expression +
        ')',
      readonlySqliteContext
    )
    expect(
      fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
    ).toEqual([])
  }
)

it.each(['id = custom', 'print(conn)', 'holder = list([cur])', 'alias = cur.connection'])(
  'does not exempt arbitrary or shadowed SQLite diagnostic escapes: %s',
  async (source) => {
    const { fileAccess } = await analyzePythonNotebookSource(
      source + '\nprint("LIVE_IDS", id(conn), id(cur))',
      readonlySqliteContext
    )
    expect(
      fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
    ).toEqual([])
  }
)

it.each([
  'alias = cur',
  'alias = conn',
  'holder = [cur]',
  'holder = {"cursor": cur}',
  'alias = cur.execute("SELECT 1")\nalias.close()',
  'cur.close()',
  'conn = replacement',
  'if flag:\n    cur = replacement',
  'cur.row_factory = custom',
  'conn.create_function("custom", 1, callback)',
  'cur.execute(sql)',
  'cur.execute("UPDATE observations SET uptake = 0")',
  'cur.execute("ATTACH DATABASE other AS aux")',
  'cur.executescript("SELECT 1;")',
  'conn.cursor(factory=custom)',
  'opaque()',
  'def close_database():\n    conn.close()\nclose_database()',
  'import os\nos.chdir("elsewhere")\nos.chdir("original")'
])('revokes readonly SQLite handle paths before a later cell after: %s', async (source) => {
  const { fileAccess } = await analyzePythonNotebookSource(source, readonlySqliteContext)
  expect(
    fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
  ).toEqual([])
  const next = await analyzeNotebookSourceFileAccess(
    'python',
    'cur.execute("SELECT 1")',
    fileAccess?.context
  )
  expect(next.reads).toEqual([])
  expect(next.readState).toBe('partial')
})

it.each([
  'cur.execute("SELECT ?", (conn.close(),))',
  'cur.execute("SELECT ?", (opaque(),))',
  'cur.execute("SELECT ?", parameters)',
  'cur.execute("SELECT 1"); cur.close(); cur.execute("SELECT 1")'
])('does not certify effectful or unknown SQLite query parameter lifetimes: %s', async (source) => {
  const { fileAccess } = await analyzePythonNotebookSource(source, readonlySqliteContext)
  expect(
    fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
  ).toEqual([])
  // An earlier SELECT can retain its potential read; effectful parameters cannot.
  expect(fileAccess?.reads).toEqual(
    source.startsWith('cur.execute("SELECT 1");') ? ['inputs/observations.sqlite'] : []
  )
  expect(fileAccess?.unsupportedExternalState).toBe(true)
})

it.each([
  'sqlite3.connect("file:data.sqlite?mode=ro", uri=True, factory=custom)',
  'sqlite3.connect("file:data.sqlite?mode=ro", **options)',
  'sqlite3.connect("file:data.sqlite?mode=ro&mode=rw", uri=True)',
  'sqlite3.connect("file:data.sqlite?mode=ro&vfs=custom", uri=True)',
  'sqlite3.connect("file:data.sqlite?mode=ro#fragment", uri=True)',
  'sqlite3.connect("file:data%00.sqlite?mode=ro", uri=True)',
  'sqlite3.connect("file:data%ZZ.sqlite?mode=ro", uri=True)',
  'sqlite3.connect("file:%5Cdata.sqlite?mode=ro", uri=True)',
  'sqlite3.connect("file://server/data.sqlite?mode=ro", uri=True)',
  'sqlite3.connect("file:data.sqlite?mode=ro", uri=True, database="other")',
  'sqlite3.connect = custom\nconn = sqlite3.connect("file:data.sqlite?mode=ro", uri=True)'
])('does not propagate ambiguous readonly SQLite constructors: %s', async (constructor) => {
  const { fileAccess } = await analyzePythonNotebookSource('import sqlite3\nconn = ' + constructor)
  expect(fileAccess?.reads).toEqual([])
  expect(
    fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
  ).toEqual([])
  expect(fileAccess?.unsupportedExternalState).toBe(true)
})

it('does not identify an unimported SQLite constructor by spelling alone', async () => {
  const { fileAccess } = await analyzePythonNotebookSource(
    'conn = sqlite3.connect("file:data.sqlite?mode=ro", uri=True)'
  )
  expect(fileAccess?.reads).toEqual([])
  expect(
    fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
  ).toEqual([])
})

it.each([
  "import sqlite3\ncon = sqlite3.connect('outputs/checkpoint.sqlite')",
  "import sqlite3 as db\nfrom pathlib import Path\np=Path('outputs') / 'checkpoint.sqlite'\ncon=db.connect(database=p, uri=False)",
  "from sqlite3 import connect as connect_db\ncon=connect_db('outputs/checkpoint.sqlite')"
])(
  'retains an ordinary SQLite checkpoint as potential input/output without claiming complete SQL capture: %s',
  async (code) => {
    const result = await analyzeNotebookSourceFileAccess('python', code)
    expect({
      ...result,
      reads: result.reads.map((p) => p.replaceAll('\\', '/')),
      writes: result.writes.map((p) => p.replaceAll('\\', '/'))
    }).toMatchObject({
      reads: ['outputs/checkpoint.sqlite'],
      writes: ['outputs/checkpoint.sqlite'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  }
)
it.each([
  "sqlite3.connect(':memory:')",
  "sqlite3.connect('')",
  "sqlite3.connect('file:cache?mode=memory', uri=True)",
  'sqlite3.connect(path)',
  "sqlite3.connect('checkpoint.sqlite', uri=unknown)",
  "sqlite3.connect('checkpoint.sqlite', **options)",
  "sqlite3.connect('checkpoint.sqlite', factory=custom)",
  "sqlite3.connect('file:cache?mode=memory', 5, 0, None, True, custom, 128, True)"
])(
  'does not invent a disk path for unresolved, in-memory or custom SQLite connections: %s',
  async (call) => {
    const result = await analyzeNotebookSourceFileAccess('python', `import sqlite3\ncon=${call}`)
    expect(result.reads).toEqual([])
    expect(result.writes).toEqual([])
    expect(result.externalState).toBe('partial')
  }
)
it('does not apply SQLite effects after the imported constructor is rebound', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    "from sqlite3 import connect\nconnect=custom\ncon=connect('checkpoint.sqlite')"
  )
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
})

describe('R compressed serialization path evidence', () => {
  it.each([
    'gzfile <- custom\ncon <- gzfile("fake.gz", "wb")\nserialize(list(x = 1), con)',
    'gzcon <- custom\nserialize(list(x = 1), gzcon(gzfile("fake.gz", "wb")))',
    'gzfile <- custom\nrestored <- unserialize(gzfile("fake.gz", "rb"))'
  ])('does not infer a base connection from a shadowed constructor: %s', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.reads).not.toContain('fake.gz')
    expect(result.writes).not.toContain('fake.gz')
  })
  const captureSerialization = async (
    source: string
  ): Promise<
    Awaited<ReturnType<typeof analyzeRNotebookSource>> & {
      normalized: Awaited<ReturnType<typeof analyzeNotebookSourceFileAccess>>
    }
  > => ({
    ...(await analyzeRNotebookSource(source)),
    normalized: await analyzeNotebookSourceFileAccess('r', source)
  })

  it.each([
    [
      'literal gz writer',
      'con <- gzfile("outputs/checkpoint.gz", "wb")\nserialize(list(values = c(1, 2)), con)\nclose(con)'
    ],
    [
      'aliased gz writer',
      'pack <- base::serialize\ncon <- gzfile("outputs/checkpoint.gz", "wb")\nother <- con\npack(list(values = c(1, 2)), other)\nclose(con)'
    ]
  ])('captures exact compressed output evidence: %s', async (_label, source) => {
    const result = await captureSerialization(source)
    expect(result.fileAccess?.writes).toContain('outputs/checkpoint.gz')
    expect(result.normalized.writes).toContain('outputs/checkpoint.gz')
  })

  it.each([
    [
      'literal gz reader',
      'con <- gzfile("outputs/checkpoint.gz", "rb")\nrestored <- unserialize(con)\nclose(con)'
    ],
    ['qualified gz reader', 'restored <- base::unserialize(gzfile("outputs/checkpoint.gz", "rb"))'],
    [
      'aliased gz reader',
      'restore <- base::unserialize\ncon <- gzfile("outputs/checkpoint.gz", "rb")\nother <- con\nrestored <- restore(other)\nclose(con)'
    ]
  ])('captures exact compressed input evidence: %s', async (_label, source) => {
    const result = await captureSerialization(source)
    expect(result.fileAccess?.reads).toContain('outputs/checkpoint.gz')
    expect(result.normalized.reads).toContain('outputs/checkpoint.gz')
  })

  it.each([
    ['raw serialization', 'payload <- serialize(list(values = c(1, 2)), NULL)'],
    [
      'raw roundtrip',
      'payload <- serialize(list(values = c(1, 2)), NULL)\nrestored <- unserialize(payload)'
    ],
    [
      'aliased raw roundtrip',
      'pack <- base::serialize\nrestore <- base::unserialize\npayload <- pack(list(values = c(1, 2)), NULL)\nrestored <- restore(payload)'
    ],
    [
      'invalid character deserializer argument',
      'restored <- base::unserialize("not-a-file-argument")'
    ]
  ])('does not invent a disk artifact for %s', async (_label, source) => {
    const result = await captureSerialization(source)
    expect(result.normalized.reads).toEqual([])
    expect(result.normalized.writes).toEqual([])
  })

  it.each([
    [
      'serialize refhook',
      'con <- gzfile("outputs/checkpoint.gz", "wb")\nserialize(new.env(), con, refhook = function(x) { writeLines("hook", "outputs/hook.txt"); "token" })\nclose(con)'
    ],
    [
      'unserialize refhook',
      'con <- gzfile("outputs/checkpoint.gz", "rb")\nrestored <- unserialize(con, refhook = function(x) readRDS("inputs/reference.rds"))\nclose(con)'
    ]
  ])('retains uncertainty for %s', async (_label, source) => {
    const result = await captureSerialization(source)
    expect(result.facts.state).toBe('unknown')
    expect(result.normalized.readState).toBe('partial')
    expect(result.normalized.writeState).toBe('partial')
  })

  it('retains an append checkpoint as both input and output through aliases', async () => {
    const source =
      'pack <- base::serialize\ncon <- gzfile("state.bin.gz", "ab")\nother <- con\npack(list(x = 1), other)\nclose(con)'
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.reads).toContain('state.bin.gz')
    expect(result.writes).toContain('state.bin.gz')
  })

  it.each([
    'pack <- base::serialize\npack <- custom\npack(list(x = 1), gzfile("fake.gz", "wb"))',
    'if (flag) pack <- base::serialize\npack(list(x = 1), gzfile("fake.gz", "wb"))',
    'custom::serialize(list(x = 1), gzfile("fake.gz", "wb"))',
    'serialize(list(x = 1), "fake.gz")',
    'con <- gzfile("fake.gz", "rb")\nserialize(list(x = 1), con)',
    'con <- gzfile("fake.gz")\nserialize(list(x = 1), con)',
    'con <- gzfile("fake.gz", "wb")\nclose(con)\nserialize(list(x = 1), con)'
  ])(
    'does not publish a serialization write without valid known callable/connection: %s',
    async (source) => {
      const result = await analyzeNotebookSourceFileAccess('r', source)
      expect(result.writes).not.toContain('fake.gz')
      expect(result.writeState).toBe('partial')
    }
  )

  it.each([
    'restore <- base::unserialize\nrestore <- custom\nrestored <- restore(gzfile("fake.gz", "rb"))',
    'custom::unserialize(gzfile("fake.gz", "rb"))',
    'restored <- unserialize("fake.gz")',
    'con <- gzfile("fake.gz", "wb")\nrestored <- unserialize(con)',
    'con <- gzfile("fake.gz", "rb")\nclose(con)\nrestored <- unserialize(con)'
  ])('does not publish an invalid/unknown unserialization input: %s', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.reads).not.toContain('fake.gz')
    expect(result.readState).toBe('partial')
  })

  it('captures reordered named connection arguments without certifying restored ownership', async () => {
    const writer = await analyzeRNotebookSource(
      'con <- gzfile("state.gz", "wb")\nserialize(connection = con, object = list(x = 1))'
    )
    expect(writer.fileAccess?.writes).toContain('state.gz')
    expect(writer.facts.serializedValueWrites ?? []).toEqual([])
    const reader = await analyzeRNotebookSource(
      'con <- gzfile("state.gz", "rb")\nrestored <- unserialize(connection = con)'
    )
    expect(reader.fileAccess?.reads).toContain('state.gz')
    expect(reader.facts.typeBindings ?? []).toEqual([])
    expect(reader.facts.safeCallNames ?? []).not.toContain('unserialize')
    const run: NotebookRunRecord = {
      runId: 'restore-run',
      cellId: 'restore-cell',
      source: 'agent',
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      script: 'con <- gzfile("state.gz", "rb")\nrestored <- unserialize(connection = con)',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }
    const snapshotScript = 'snapshot <- sum(restored$x)\nprint(snapshot)'
    const mutationScript = 'external_mutation(restored)'
    const snapshot = (await analyzeRNotebookSource(snapshotScript)).facts
    const mutation = (await analyzeRNotebookSource(mutationScript)).facts
    const projection = projectNotebookDependencies([
      { run, facts: reader.facts },
      {
        run: {
          ...run,
          runId: 'snapshot',
          cellId: 'snapshot',
          startedAt: 3,
          endedAt: 4,
          script: snapshotScript
        },
        facts: snapshot
      },
      {
        run: {
          ...run,
          runId: 'mutation',
          cellId: 'mutation',
          startedAt: 5,
          endedAt: 6,
          script: mutationScript
        },
        facts: mutation
      }
    ])
    expect(projection.stalenessByRunId.snapshot).toMatchObject({ state: 'unknown' })
  })

  it('keeps NULL serialization with a refhook conservative for both IO directions', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'payload <- serialize(new.env(), NULL, refhook = function(x) { writeLines("hook", "side.txt"); "token" })'
    )
    expect(result.readState).toBe('partial')
    expect(result.writeState).toBe('partial')
    expect(result.writes).not.toContain('NULL')
  })
})

describe('base R generic predicates require primitive dispatch proof', () => {
  it.each([
    'sensor <- as.numeric(structure(c(1., 2.), class="mercury_sensor"))\nflags <- is.finite(sensor)',
    'original <- structure(c(1., 2.), class="mercury_sensor")\nsensor <- as.integer(original)\nflags <- is.infinite(sensor)',
    'sensor <- as.logical(structure(c(1., 2.), .Dim=c(1L,2L)))\nflags <- is.nan(sensor)',
    'sensor <- as.character(structure(c(1., 2.), class="mercury_sensor"))\nflags <- base::is.finite(sensor)',
    'raw <- read.csv("inputs/pressure.csv")\nsensor <- structure(as.numeric(raw$pressure),class="mercury_sensor")\nis.finite.mercury_sensor <- function(x) { writeLines(as.character(length(x)), "outputs/r-sensor-audit.txt"); base::is.finite(unclass(x)) }\nflags <- base::is.finite(sensor)',
    'sensor <- structure(c(1., 2.), class = "mercury_sensor")\nstopifnot(all(is.finite(sensor)))',
    'sensor <- structure(c(1., 2.), class = "mercury_sensor")\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), class = "mercury_sensor")\nalias <- sensor\nflags <- is.infinite(alias)',
    'sensor <- structure(c(1., 2.), class = "mercury_sensor")\nflags <- base::is.nan(sensor)',
    'original <- structure(c(1., 2.), class = "mercury_sensor")\nsensor <- structure(original)\nstopifnot(all(is.finite(sensor)))',
    'sensor <- structure(get_sensor(), names = c("first", "second"))\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), ...)\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), dim = c(1L, 2L))\nstopifnot(all(is.finite(sensor)))',
    'sensor <- structure(c(1., 2.), .Dim = c(1L, 2L))\nflags <- is.finite(sensor)',
    'sensor <- matrix(c(1., 2.), nrow = 1L)\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), names = c("first", "second"))\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), .Names = c("first", "second"))\nflags <- is.finite(sensor)'
  ])('does not borrow ownership as proof of an unmodeled predicate method: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'sensor <- as.numeric(read.csv("inputs/pressure.csv")$pressure)\nstopifnot(all(is.finite(sensor)))',
    'sensor <- as.numeric(c(first="1",second="2"))\nflags <- is.finite(sensor)',
    'sensor <- as.integer(c(1.,2.))\nflags <- is.infinite(sensor)',
    'sensor <- as.logical(c(1L,0L))\nflags <- is.nan(sensor)',
    'sensor <- as.character(c(1.,2.))\nflags <- is.finite(sensor)',
    'sensor <- c(first = 1., second = 2.)\nstopifnot(all(is.finite(sensor)))',
    'sensor <- c(1., 2.)\nstopifnot(all(base::is.finite(sensor)))',
    'sensor <- seq_len(2L)\nflags <- is.infinite(sensor)',
    'sensor <- numeric(2L)\nflags <- is.nan(sensor)'
  ])('retains fresh primitive vector predicate certainty: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('uses existing atomic context without inventing class metadata', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['sensor'],
      rAtomicValueNames: ['sensor'],
      rCopyOnModifyNames: ['sensor']
    }
    expect(
      await analyzeNotebookSourceFileAccess('r', 'flags <- is.finite(sensor)', context)
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not equate contextual copy ownership with primitive dispatch', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['sensor'],
      rCopyOnModifyNames: ['sensor']
    }
    expect(
      await analyzeNotebookSourceFileAccess('r', 'flags <- is.finite(sensor)', context)
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('R count and sequence generic dispatch', () => {
  it.each(['length', 'nrow', 'ncol'])(
    'keeps classed %s results conservative when a predicate can dispatch hidden IO',
    async (inspector) => {
      // Native R permits length/dim methods to return classed counts. nrow/ncol
      // select dim(x), so a classed dimension's subset method can preserve that class.
      const source = [
        'sensor <- structure(c(1., 2.), class="mercury_sensor")',
        'length.mercury_sensor <- function(x) structure(base::length(unclass(x)), class="classed_count")',
        'dim.mercury_sensor <- function(x) structure(c(2L, 1L), class="classed_dim")',
        '`[.classed_dim` <- function(x, ...) structure(NextMethod("["), class="classed_count")',
        'is.finite.classed_count <- function(x) { writeLines("audit", "outputs/count-audit.txt"); base::is.finite(unclass(x)) }',
        `count <- ${inspector}(sensor)`,
        'flags <- base::is.finite(count)'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('does not infer a pure sequence from only its primitive starting value', async () => {
    const source = [
      'Ops.mercury_limit <- function(e1, e2) { writeLines(.Generic, "outputs/seq-audit.txt"); do.call(.Generic, list(unclass(e1), unclass(e2))) }',
      'limit <- structure(3., class="mercury_limit")',
      'values <- seq(1., limit, by=1.)',
      'flags <- is.finite(values)'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not borrow table ownership to prove a primitive count', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'raw <- read.csv("inputs/pressure.csv")\ncount <- nrow(raw)\nflags <- is.finite(count)'
      )
    ).toMatchObject({
      reads: ['inputs/pressure.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'count <- length(c(first="one", second="two"))\nflags <- is.finite(count)',
    'endpoint <- length(c(1., 2., 3.))\nvalues <- seq(1., endpoint, by=1.)\nflags <- is.finite(values)',
    'values <- seq(0, 2*pi, length.out=400)\nflags <- is.finite(values)'
  ])('retains recursively proven primitive counts and endpoints: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('retains sequence proof through existing atomic kernel context', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['endpoint'],
      rAtomicValueNames: ['endpoint'],
      rCopyOnModifyNames: ['endpoint']
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'values <- seq(1., endpoint, by=1.)\nflags <- is.finite(values)',
        context
      )
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
})

// A library statistic can perform I/O independently of explicit notebook paths.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.binned_statistic.html
it.each([
  'result = binned_statistic(depth_arr, mag_arr, statistic=bin_reducer, bins=edges)',
  'result = binned_statistic(depth_arr, mag_arr, bin_reducer, edges)'
])(
  'keeps binned_statistic callback I/O partial while retaining explicit paths: %s',
  async (call) => {
    const source = [
      'from scipy.stats import binned_statistic',
      'CALIBRATION_PATH = "inputs/offset.txt"',
      'depth_arr = [40., 100., 680.]',
      'mag_arr = [4., 5., 6.]',
      'edges = [0., 40., 100., 680.]',
      'def calibrate():\n    with open(CALIBRATION_PATH) as handle:\n        return float(handle.read())',
      'def bin_reducer(values):\n    return sum(values) + calibrate()',
      'with open("inputs/metadata.txt") as handle:\n    metadata = handle.read()',
      call,
      'with open("outputs/report.txt", "w") as handle:\n    handle.write(metadata)'
    ].join('\n')
    const access = await analyzeNotebookSourceFileAccess('python', source)
    expect(access).toMatchObject({
      reads: ['inputs/metadata.txt'],
      writes: ['outputs/report.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    // The callback's potential global input does not identify each actual file open.
    expect(access.reads).not.toContain('inputs/offset.txt')
  }
)

// A reduced quad call must remain opaque even when its surrounding notebook has
// no other opaque operations; explicit paths do not describe complete callback I/O.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.quad.html
it.each([
  'result = quad(integrand, 0.0, 2.0, points=[1.0])',
  'result = quad(func=integrand, a=0.0, b=2.0, points=[1.0])'
])('keeps quad callback I/O partial while preserving explicit paths: %s', async (call) => {
  const source = [
    'from scipy.integrate import quad',
    'CALIBRATION_PATH = "inputs/offset.txt"',
    'def calibrate():\n    with open(CALIBRATION_PATH, "r", encoding="utf-8") as f:\n        return float(f.read().strip())',
    'def integrand(t):\n    return t + calibrate()',
    'with open("inputs/metadata.txt") as f:\n    metadata = f.read()',
    call,
    'with open("outputs/report.txt", "w") as f:\n    f.write(metadata)'
  ].join('\n')
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access).toMatchObject({
    reads: ['inputs/metadata.txt'],
    writes: ['outputs/report.txt'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect(access.reads).not.toContain('inputs/offset.txt')
})

// The executed pressure notebook read its calibration through a solver callback.
// Explicit top-level paths must not make that unmodeled callback I/O complete.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.root_scalar.html
it.each([
  'result = optimize.root_scalar(objective, args=(50.0,), bracket=(0.0, 360.0), method="brentq")',
  'result = optimize.root_scalar(f=objective, args=(50.0,), bracket=(0.0, 360.0), method="brentq")'
])('keeps root_scalar callback I/O partial while preserving explicit paths: %s', async (call) => {
  const source = [
    'from scipy import optimize',
    'OFFSET_PATH = "inputs/offset.txt"',
    'def calibrated_pressure(t):\n    with open(OFFSET_PATH, "r") as f:\n        return t + float(f.read().strip())',
    'def objective(t, target):\n    return calibrated_pressure(t) - target',
    'with open("inputs/metadata.txt") as f:\n    metadata = f.read()',
    call,
    'with open("outputs/report.txt", "w") as f:\n    f.write(metadata)'
  ].join('\n')
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access).toMatchObject({
    reads: ['inputs/metadata.txt'],
    writes: ['outputs/report.txt'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect(access.reads).not.toContain('inputs/offset.txt')
})
