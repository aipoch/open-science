import { join } from 'node:path'
import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'

const analyzedPythonPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

it.each([
  'utils::tar("output.tar",files="source/a.txt",tar="internal")',
  'tar("output.tar",files="source/a.txt",tar="internal")',
  'utils::tar(files="source/a.txt",tarfile="output.tar",tar="internal")',
  'utils::tar(files="source/a.txt","output.tar",tar="internal")',
  'utils::tar("output.tar",fi="source/a.txt",tar="internal")',
  'utils::tar("output.tar",files="source/a.txt",compression="gzip",tar="internal")'
])('retains R tar creation input and output candidates: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['source/a.txt'],
    writes: ['output.tar'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it('retains R tar creation file vectors', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'utils::tar("output.tar",files=c("source/a.txt","source/b.txt"),tar="internal")'
    )
  ).toMatchObject({
    reads: ['source/a.txt', 'source/b.txt'],
    writes: ['output.tar'],
    externalState: 'partial'
  })
})

it('retains R tar creation directory input without inventing descendants', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'utils::tar("output.tar",files="source",tar="internal")'
    )
  ).toMatchObject({ reads: ['source'], writes: ['output.tar'], readState: 'partial' })
})

it.each([
  'utils::tar("output.tar",tar="internal")',
  'utils::tar("output.tar",files=NULL,tar="internal")',
  'utils::tar("output.tar",files=character(),tar="internal")'
])('keeps R tar creation implicit or empty inputs conservative: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    writes: ['output.tar'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  ['utils::tar(target,files="source/a.txt")', ['source/a.txt'], []],
  ['utils::tar("output.tar",files=selection)', [], ['output.tar']]
])('keeps dynamic R tar creation paths partial: %s', async (source, reads, writes) => {
  expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
    reads,
    writes,
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  'utils::tar("output.tar",files="source/a.txt",files="source/b.txt")',
  'utils::tar("output.tar",files="source/a.txt",bogus=TRUE)',
  'other::tar("output.tar",files="source/a.txt")'
])('does not invent R tar creation paths for invalid or unrelated calls: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    writes: [],
    externalState: 'partial'
  })
})

it('does not apply R tar creation paths to a local replacement', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'tar <- function(...) NULL;tar("output.tar",files="source/a.txt")'
    )
  ).toMatchObject({ reads: [], writes: [] })
})

it('retains qualified R tar creation after a local replacement', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'tar <- function(...) NULL;utils::tar("output.tar",files="source/a.txt")'
    )
  ).toMatchObject({ reads: ['source/a.txt'], writes: ['output.tar'] })
})

it('keeps a later R tar creation output read as an input candidate', async () => {
  const source =
    'utils::tar("output.tar",files="source/a.txt",tar="internal");base::readBin("output.tar","raw",n=1L)'
  expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([
    'output.tar',
    'source/a.txt'
  ])
})

it('retains reads after R tar creation argument writes', async () => {
  const source =
    'utils::tar("output.tar",files={base::writeLines("argument","side.txt");"source/a.txt"},tar="internal");base::readLines("side.txt")'
  expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['side.txt'])
})

it('retains statically bound R tar creation file vectors', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'selection <- c("source/a.txt","source/b.txt");utils::tar("output.tar",files=selection,tar="internal")'
    )
  ).toMatchObject({ reads: ['source/a.txt', 'source/b.txt'], writes: ['output.tar'] })
})

it.each([
  'utils::unzip("input.zip",exdir="out",unzip="internal")',
  'unzip("input.zip",exdir="out",unzip="internal")',
  'utils::unzip(exdir="out",zipfile="input.zip",unzip="internal")',
  'utils::unzip(exdir="out","input.zip",unzip="internal")',
  'utils::unzip("input.zip",files="report.txt",exdir="out",unzip="internal")',
  'utils::unzip("input.zip",files=character(),exdir="out",unzip="internal")',
  'utils::unzip("input.zip",exd="out",unzip="internal")',
  'utils::unzip("input.zip",overwrite=FALSE,exdir="out",unzip="internal")',
  'utils::unzip("input.zip",junkpaths=TRUE,exdir="out",unzip="internal")',
  'utils::unzip("input.zip",NULL,FALSE,TRUE,FALSE,"out","internal")'
])('retains R unzip input and directory candidates: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['input.zip'],
    writes: ['out'],
    writeScopes: [{ kind: 'directory', path: 'out' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each(['TRUE', '1'])('suppresses R unzip listing output: %s', async (list) => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `utils::unzip("input.zip",list=${list},exdir="out",unzip="internal")`
    )
  ).toMatchObject({ reads: ['input.zip'], writes: [], externalState: 'partial' })
})

it('retains the default R unzip directory scope', async () => {
  expect(
    await analyzeNotebookSourceFileAccess('r', 'utils::unzip("input.zip",unzip="internal")')
  ).toMatchObject({
    reads: ['input.zip'],
    writes: ['.'],
    writeScopes: [{ kind: 'directory', path: '.' }]
  })
})

it.each([
  ['utils::unzip(archive,exdir="out")', [], ['out']],
  ['utils::unzip("input.zip",exdir=destination)', ['input.zip'], []]
])('keeps dynamic R unzip paths partial: %s', async (source, reads, writes) => {
  expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
    reads,
    writes,
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  'utils::unzip("input.zip",exdir="out",exdir="other")',
  'utils::unzip("input.zip",bogus=TRUE)',
  'other::unzip("input.zip",exdir="out")'
])('does not invent R unzip paths for invalid or unrelated calls: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    writes: [],
    externalState: 'partial'
  })
})

it('does not apply R unzip paths to a local replacement', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'unzip <- function(...) NULL;unzip("input.zip",exdir="out")'
    )
  ).toMatchObject({ reads: [], writes: [] })
})

it('retains qualified R unzip paths after a local replacement', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'unzip <- function(...) NULL;utils::unzip("input.zip",exdir="out")'
    )
  ).toMatchObject({ reads: ['input.zip'], writes: ['out'] })
})

it('retains reads after R unzip can replace an earlier output', async () => {
  const source =
    'base::writeLines("old","out/report.txt");utils::unzip("input.zip",exdir="out",unzip="internal");base::readLines("out/report.txt")'
  expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([
    'input.zip',
    'out/report.txt'
  ])
})

it('retains reads after R unzip destination argument effects', async () => {
  const source =
    'utils::unzip("input.zip",exdir={base::writeLines("argument","side.txt");"out"},unzip="internal");base::readLines("side.txt")'
  expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([
    'input.zip',
    'side.txt'
  ])
})

it.each([
  'base::writeBin(size=1L,7L,"result.bin")',
  'base::writeBin(endian="big",7L,"result.bin",size=2L)',
  'base::writeBin(object=7L,"result.bin",size=1L)',
  'base::writeBin(7L,c="result.bin",s=1L)',
  'base::writeBin(con="result.bin",size=1L,object=7L)',
  'writeBin(size=1L,7L,"result.bin")'
])('matches R binary writer formals before attributing output: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    writes: ['result.bin']
  })
})

it.each([
  'base::readBin(n=3L,what="raw",c="seed.bin")',
  'base::readBin(n=3L,"seed.bin","raw")',
  'base::readBin("seed.bin","raw",n=3L,size=1L,s=FALSE)',
  'readBin(n=3L,what="raw",c="seed.bin")'
])('matches R binary reader formals before attributing input: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['seed.bin'],
    writes: []
  })
})

it.each([
  'base::writeBin(7L,con="result.bin",con="other.bin",size=1L)',
  'base::writeBin(7L,"result.bin",bogus=TRUE)',
  'base::writeBin(con="result.bin",size=1L)',
  'base::writeBin(7L,"result.bin",...)',
  'base::readBin(con="seed.bin",con="other.bin",what="raw")',
  'base::readBin("seed.bin","raw",bogus=TRUE)',
  'base::readBin("seed.bin","raw",s=1L)'
])('keeps invalid R binary argument layouts uncertain: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it('retains a later read after a rejected R binary writer layout', async () => {
  const source = 'base::writeBin(7L,"result.bin",bogus=TRUE);base::readBin("result.bin","raw",n=3L)'
  expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['result.bin'])
})

it('retains nested R binary reads and the matched writer destination', async () => {
  const source = 'base::writeBin(size=1L,base::readBin("seed.bin","raw",n=3L),"result.bin")'
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['seed.bin'],
    writes: ['result.bin']
  })
})

it('retains append input for a reordered R binary writer', async () => {
  const source =
    'con <- base::file("result.bin","ab");base::writeBin(size=1L,7L,con);base::close(con)'
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['result.bin'],
    writes: ['result.bin']
  })
})

it('does not infer R binary paths for a local replacement', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'writeBin <- function(...) NULL;writeBin(size=1L,7L,"result.bin")'
    )
  ).toMatchObject({ reads: [], writes: [] })
})

it.each([
  'utils::untar("input.tar",exdir="out",tar="internal")',
  'untar("input.tar",exdir="out",tar="internal")',
  'utils::untar(exdir="out",tarfile="input.tar",tar="internal")',
  'utils::untar(exdir="out","input.tar",tar="internal")',
  'utils::untar("input.tar",files="report.txt",exdir="out",tar="internal")',
  'utils::untar("input.tar",files=character(),exdir="out",tar="internal")',
  'utils::untar("input.tar",exd="out",tar="internal")'
])('retains R untar input and directory candidates: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['input.tar'],
    writes: ['out'],
    writeScopes: [{ kind: 'directory', path: 'out' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzeRNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each(['TRUE', '1'])('does not invent R untar listing output: %s', async (list) => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `utils::untar("input.tar",list=${list},exdir="out",tar="internal")`
    )
  ).toMatchObject({
    reads: ['input.tar'],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures the default R untar output directory scope', async () => {
  expect(
    await analyzeNotebookSourceFileAccess('r', 'utils::untar("input.tar",tar="internal")')
  ).toMatchObject({
    reads: ['input.tar'],
    writes: ['.'],
    writeScopes: [{ kind: 'directory', path: '.' }]
  })
})

it.each([
  ['utils::untar(archive,exdir="out")', [], ['out']],
  ['utils::untar("input.tar",exdir=destination)', ['input.tar'], []],
  ['utils::untar("input.tar",list=listing,exdir="out")', ['input.tar'], ['out']]
])('keeps dynamic R untar arguments partial: %s', async (source, reads, writes) => {
  expect(await analyzeNotebookSourceFileAccess('r', source as string)).toMatchObject({
    reads,
    writes,
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  'utils::untar("input.tar",exdir="one",exdir="two")',
  'utils::untar("input.tar",unknown="out")',
  'utils::untar(t="input.tar",exdir="out")'
])('does not resolve invalid R untar argument layouts: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    writes: [],
    externalState: 'partial'
  })
})

it('does not apply R untar paths to a local replacement', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'untar <- function(...) NULL;untar("input.tar",exdir="out")'
    )
  ).toMatchObject({
    reads: [],
    writes: []
  })
})

it('retains qualified R untar paths after an unqualified replacement', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'untar <- function(...) NULL;utils::untar("input.tar",exdir="out")'
    )
  ).toMatchObject({
    reads: ['input.tar'],
    writes: ['out']
  })
})

it('retains reads after R untar can replace earlier output', async () => {
  const source =
    'base::writeLines("old","out/report.txt");utils::untar("input.tar",exdir="out",tar="internal");base::readLines("out/report.txt")'
  expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([
    'input.tar',
    'out/report.txt'
  ])
})

it('retains reads after R untar destination argument effects', async () => {
  const source =
    'utils::untar("input.tar",exdir={base::writeLines("argument","side.txt");"out"},tar="internal");base::readLines("side.txt")'
  expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([
    'input.tar',
    'side.txt'
  ])
})

it.each([
  'with tarfile.TarFile("output.tar","w") as archive:\n    archive.add("source/report.txt",arcname="member.txt")',
  'archive=tarfile.TarFile("output.tar","w")\nalias=archive\nalias.add("source/report.txt",arcname="member.txt")\narchive.close()',
  'with tarfile.TarFile.open("output.tar","w:gz") as archive:\n    archive.add("source/report.txt",arcname="member.txt")',
  'from tarfile import TarFile as Archive\nwith Archive("output.tar","w") as archive:\n    archive.add("source/report.txt",arcname="member.txt")',
  'from tarfile import TarFile as Archive\nwith Archive.open("output.tar","w:gz") as archive:\n    archive.add("source/report.txt",arcname="member.txt")',
  'tarfile.TarFile("output.tar","w").add("source/report.txt",arcname="member.txt")'
])('tracks TAR class constructor member writes: %s', async (body) => {
  const source = `import tarfile\n${body}`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['source/report.txt'],
    writes: ['output.tar'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each(['tarfile.TarFile', 'tarfile.TarFile.open'])(
  'tracks TAR class constructor reads with None fileobj: %s',
  async (constructor) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import tarfile\n${constructor}("input.tar",fileobj=None)`
      )
    ).toMatchObject({ reads: ['input.tar'], writes: [], readState: 'complete' })
  }
)

it.each(['tarfile.TarFile', 'tarfile.TarFile.open'])(
  'keeps TAR class constructor memory streams partial without fake paths: %s',
  async (constructor) => {
    const source = `import tarfile\nfrom io import BytesIO\n${constructor}("ignored.tar","w",BytesIO())`
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
  }
)

it.each(['tarfile.TarFile', 'tarfile.TarFile.open'])(
  'retains captured TAR class constructor stream output and later reads: %s',
  async (constructor) => {
    const source = `import tarfile\nfrom pathlib import Path\nwith open("actual.tar","wb") as stream:\n    with ${constructor}("ignored.tar","w",fileobj=stream) as archive:\n        archive.add("source/report.txt",arcname="member.txt")\nresult=Path("actual.tar").read_bytes()`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['actual.tar', 'source/report.txt'],
      writes: ['actual.tar'],
      externalState: 'partial'
    })
  }
)

it.each([
  'tarfile.TarFile = replacement',
  'tarfile.TarFile.open = replacement',
  'from tarfile import TarFile as Archive\nArchive.open = replacement'
])('rejects replaced TAR class constructor identities: %s', async (replacement) => {
  const source = `import tarfile\n${replacement}\nwith tarfile.TarFile.open("output.tar","w") as archive:\n    archive.add("source/report.txt",arcname="member.txt")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [],
    writes: [],
    externalState: 'partial'
  })
})

it('retains reads after TAR class constructor member argument effects', async () => {
  const source =
    'import tarfile\nfrom pathlib import Path\nwith tarfile.TarFile("output.tar","w") as archive:\n    archive.add((Path("side.txt").write_text("argument"),"source/report.txt")[1],arcname="member.txt")\nresult=Path("side.txt").read_text()'
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it.each(['"w:gz"', '"w|gz"', 'mode'])(
  'does not certify unsupported TAR class constructor modes: %s',
  async (mode) => {
    const source = `from tarfile import TarFile as Archive\nfrom pathlib import Path\nArchive("output.tar",${mode})\nresult=Path("output.tar").read_bytes()`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['output.tar'],
      writes: [],
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

it('tracks TAR class constructor inline extraction scope', async () => {
  const source = 'import tarfile\ntarfile.TarFile("input.tar").extractall("out")'
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['input.tar'],
    writes: ['out'],
    writeScopes: [{ path: 'out', kind: 'directory' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  'tarfile.open("input.tar",fileobj=None)',
  'tarfile.open("input.tar","r",None)',
  'tarfile.open(name="input.tar",mode="r",fileobj=None)'
])('uses the filename for TAR fileobj None: %s', async (call) => {
  expect(await analyzeNotebookSourceFileAccess('python', `import tarfile\n${call}`)).toMatchObject({
    reads: ['input.tar'],
    writes: [],
    readState: 'complete'
  })
})

it.each([
  'tarfile.open("ignored.tar","w",BytesIO())',
  'tarfile.open("ignored.tar","w",fileobj=BytesIO())',
  'tarfile.open("ignored.tar","w",fileobj="not-a-stream")',
  'tarfile.open("ignored.tar","w",fileobj=stream)',
  'tarfile.open("ignored.tar","w",**options)',
  'tarfile.open(*arguments)'
])('keeps opaque TAR fileobj paths and dependence conservative: %s', async (call) => {
  const source = `import tarfile\nfrom io import BytesIO\n${call}`
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

it.each(['stream', 'fileobj=stream'])(
  'retains captured TAR fileobj output and later archive reads: %s',
  async (argument) => {
    const source = `import tarfile\nfrom pathlib import Path\nwith open("actual.tar","wb") as stream:\n    with tarfile.open("ignored.tar","w",${argument}) as archive:\n        archive.add("source/report.txt",arcname="member.txt")\nresult=Path("actual.tar").read_bytes()`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['actual.tar', 'source/report.txt'],
      writes: ['actual.tar'],
      writeState: 'partial',
      externalState: 'partial'
    })
  }
)

it('retains captured TAR fileobj input without using the ignored name', async () => {
  const source =
    'import tarfile\nwith open("actual.tar","rb") as stream:\n    archive=tarfile.open("ignored.tar","r",fileobj=stream)'
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['actual.tar'],
    writes: [],
    externalState: 'partial'
  })
})

it('retains reads after TAR fileobj argument writes', async () => {
  const source =
    'import tarfile\nfrom pathlib import Path\nfrom io import BytesIO\narchive=tarfile.open("ignored.tar","w",fileobj=(Path("side.txt").write_text("argument"),BytesIO())[1])\nresult=Path("side.txt").read_text()'
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it('does not infer TAR fileobj paths from a replacement constructor', async () => {
  const source =
    'from tarfile import open as open_tar\ndef open_tar(*args,**kwargs):\n    pass\nopen_tar("ignored.tar","w",fileobj="not-a-stream")'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
})

it.each([
  '.open("member.txt","w")',
  '.open(name="member.txt",mode="w")',
  '.open("member.txt",mode)',
  '.open("member.txt",**options)',
  '.open(*arguments)',
  '.open("member.txt",None)'
])('retains later reads and partial writes for inline ZIP stream %s', async (call) => {
  const source = `import zipfile\nfrom pathlib import Path\nwith zipfile.ZipFile("output.zip","w")${call} as stream:\n    stream.write(b"payload")\nresult=Path("output.zip").read_bytes()`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toContain('output.zip')
  expect(result.writes).toEqual(['output.zip'])
  expect(result).toMatchObject({
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each(['', ',"r"'])('keeps read-only inline ZIP stream %s free of writes', async (mode) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import zipfile\nwith zipfile.ZipFile("input.zip").open("member.txt"${mode}) as stream:\n    result=stream.read()`
  )
  expect(result.reads).toEqual(['input.zip'])
  expect(result.writes).toEqual([])
  expect(result.writeState).toBe('complete')
})

it('keeps inline ZIP stream memory output off disk', async () => {
  const source =
    'import zipfile\nfrom io import BytesIO\nwith zipfile.ZipFile(BytesIO(),"w").open("member.txt","w") as stream:\n    stream.write(b"payload")'
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [],
    writes: [],
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('tracks imported aliases for inline ZIP stream writes', async () => {
  const source =
    'from zipfile import ZipFile as Archive\nfrom pathlib import Path\nstream=Archive("output.zip","w").open("member.txt","w")\nstream.write(b"payload")\nresult=Path("output.zip").read_bytes()'
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['output.zip'],
    writes: ['output.zip'],
    writeState: 'partial'
  })
})

it.each([
  '.open((Path("side.txt").write_text("argument"),"member.txt")[1],"w")',
  '.open("member.txt",(Path("side.txt").write_text("argument"),"w")[1])'
])('retains later reads after inline ZIP stream argument effects: %s', async (call) => {
  const source = `import zipfile\nfrom pathlib import Path\nstream=zipfile.ZipFile("output.zip","w")${call}\nresult=Path("side.txt").read_text()`
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it.each(['zipfile=Noop()', 'zipfile.ZipFile=Noop().ZipFile'])(
  'does not invent inline ZIP stream paths after replacement: %s',
  async (replacement) => {
    const source = `import zipfile\nclass Noop:\n    def ZipFile(self,*args,**kwargs):\n        return self\n    def open(self,*args,**kwargs):\n        return self\n${replacement}\nstream=zipfile.ZipFile("output.zip","w").open("member.txt","w")`
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).toEqual([])
    expect(result.writes).toEqual([])
  }
)

it.each([
  ['zipfile.ZipFile("input.zip").extractall("out")', 'input.zip'],
  ['zipfile.ZipFile("input.zip").extract("report.txt","out")', 'input.zip'],
  ['tarfile.open("input.tar").extractall(path="out")', 'input.tar'],
  ['tarfile.open("input.tar").extract(member="report.txt",path="out")', 'input.tar'],
  ['from zipfile import ZipFile as Archive\nArchive("input.zip").extractall("out")', 'input.zip'],
  ['tarfile.open(fileobj=BytesIO(),mode="w").open("input.tar").extractall("out")', 'input.tar']
])('tracks inline archive extraction input and directory scope: %s', async (call, input) => {
  const source = `import zipfile,tarfile\nfrom io import BytesIO\n${call}`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [input],
    writes: ['out'],
    writeScopes: [{ kind: 'directory', path: 'out' }],
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
  'zipfile.ZipFile("input.zip").extractall("out")',
  'tarfile.open("input.tar").extract("report.txt","out")',
  'zipfile.ZipFile("input.zip").extractall((Path("out/report.txt").write_text("argument"),"out")[1])',
  'zipfile.ZipFile("input.zip").extract((Path("out/report.txt").write_text("argument"),"report.txt")[1],"out")'
])('retains later reads after inline archive extraction and arguments: %s', async (call) => {
  const source = `import zipfile,tarfile\nfrom pathlib import Path\nPath("out/report.txt").write_text("before")\n${call}\nresult=Path("out/report.txt").read_text()`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toContain(analyzedPythonPath('out/report.txt'))
  expect(result.writeState).toBe('partial')
})

it.each(['', 'None', 'target', '"out/*"', '"https://example.test/out"'])(
  'does not invent an inline archive extraction destination for %s',
  async (target) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import zipfile\nzipfile.ZipFile("input.zip").extractall(${target})`
    )
    expect(result.reads).toEqual(['input.zip'])
    expect(result.writes).toEqual([])
    expect(result.writeScopes).toBeUndefined()
    expect(result.writeState).toBe('partial')
  }
)

it.each([
  'zipfile=Noop()',
  'tarfile=Noop()',
  'zipfile.ZipFile=Noop().ZipFile',
  'tarfile.open=Noop().open'
])('does not infer inline archive extraction paths after replacement: %s', async (replacement) => {
  const call = replacement.startsWith('zipfile')
    ? 'zipfile.ZipFile("input.zip")'
    : 'tarfile.open("input.tar")'
  const source = `import zipfile,tarfile\nclass Noop:\n    def ZipFile(self,*args,**kwargs):\n        return self\n    def open(self,*args,**kwargs):\n        return self\n    def extractall(self,*args,**kwargs):\n        pass\n${replacement}\n${call}.extractall("out")`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
})

it.each([
  [
    'zipfile.ZipFile("output.zip","w").write("source/report.txt",arcname="member.txt")',
    'output.zip'
  ],
  [
    'zipfile.ZipFile("output.zip","w").write(filename="source/report.txt",arcname="member.txt")',
    'output.zip'
  ],
  ['tarfile.open("output.tar","w").add("source/report.txt",arcname="member.txt")', 'output.tar'],
  [
    'tarfile.open("output.tar","w").add(name="source/report.txt",arcname="member.txt")',
    'output.tar'
  ],
  [
    'tarfile.open(fileobj=BytesIO(),mode="w").open("output.tar","w").add("source/report.txt",arcname="member.txt")',
    'output.tar'
  ],
  [
    'from zipfile import ZipFile as Archive\nArchive("output.zip","w").write("source/report.txt",arcname="member.txt")',
    'output.zip'
  ]
])('tracks inline archive member source and target: %s', async (body, output) => {
  const source = `import zipfile,tarfile\nfrom io import BytesIO\n${body}`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['source/report.txt'],
    writes: [output],
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
  'zipfile.ZipFile("output.zip","w").writestr("member.txt","payload.csv")',
  'tarfile.open("output.tar","w").addfile(tarfile.TarInfo("member.txt"))'
])('does not treat inline archive member payloads as file inputs: %s', async (call) => {
  const result = await analyzeNotebookSourceFileAccess('python', `import zipfile,tarfile\n${call}`)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([call.startsWith('zipfile') ? 'output.zip' : 'output.tar'])
  expect(result.writeState).toBe('partial')
})

it('tracks inline archive member fileobj input', async () => {
  const source =
    'import tarfile\nwith open("source/report.txt","rb") as stream:\n    tarfile.open("output.tar","w").addfile(tarfile.TarInfo("member.txt"),fileobj=stream)'
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['source/report.txt'],
    writes: ['output.tar'],
    writeState: 'partial'
  })
})

it.each([
  'zipfile.ZipFile(BytesIO(),"w").write("source/report.txt",arcname="member.txt")',
  'tarfile.open(fileobj=BytesIO(),mode="w").add("source/report.txt",arcname="member.txt")'
])('tracks inline archive member memory output conservatively: %s', async (call) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import zipfile,tarfile\nfrom io import BytesIO\n${call}`
  )
  expect(result).toMatchObject({ reads: ['source/report.txt'], writes: [], writeState: 'partial' })
})

it.each([
  'zipfile.ZipFile("output.zip","w").write("source/report.txt",arcname="member.txt")',
  'zipfile.ZipFile("output.zip","w").write((Path("output.zip").write_bytes(b"argument"),"source/report.txt")[1],arcname="member.txt")',
  'tarfile.open("output.tar","w").add("source/report.txt",arcname="member.txt")'
])(
  'retains later reads after inline archive member construction and arguments: %s',
  async (call) => {
    const path = call.startsWith('zipfile') ? 'output.zip' : 'output.tar'
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import zipfile,tarfile\nfrom pathlib import Path\n${call}\nresult=Path("${path}").read_bytes()`
    )
    expect(result.reads).toContain(path)
    expect(result.externalState).toBe('partial')
  }
)

it.each(['zipfile=Noop()', 'zipfile.ZipFile=Noop().ZipFile'])(
  'does not infer inline archive member paths after replacement: %s',
  async (replacement) => {
    const source = `import zipfile\nclass Noop:\n    def ZipFile(self,*args,**kwargs):\n        return self\n    def write(self,*args,**kwargs):\n        pass\n${replacement}\nzipfile.ZipFile("output.zip","w").write("source/report.txt",arcname="member.txt")`
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).toEqual([])
    expect(result.writes).toEqual([])
  }
)

it.each([
  'with tarfile.open(fileobj=BytesIO(),mode="w").open("child.tar","w") as child:\n    child.add("source/report.txt",arcname="member.txt")',
  'child=tarfile.open(fileobj=BytesIO(),mode="w").open(name="child.tar",mode="w")\nchild.add("source/report.txt",arcname="member.txt")',
  'child=tarfile.open(fileobj=BytesIO(),mode="w").open(fileobj=BytesIO(),mode="w").open("child.tar","w")\nchild.add("source/report.txt",arcname="member.txt")',
  'parent=tarfile.open(fileobj=BytesIO(),mode="w")\nchild=parent.open(fileobj=BytesIO(),mode="w").open("child.tar","w")\nchild.add("source/report.txt",arcname="member.txt")',
  'from tarfile import open as open_tar\nchild=open_tar(fileobj=BytesIO(),mode="w").open("child.tar","w")\nalias=child\nalias.add("source/report.txt",arcname="member.txt")',
  'import tarfile as archive\nchild=archive.open(fileobj=BytesIO(),mode="w").open("child.tar","w:gz")\nchild.add("source/report.txt",arcname="member.txt")'
])('tracks inline TAR factory returned handles: %s', async (body) => {
  const source = `import tarfile\nfrom io import BytesIO\n${body}`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['source/report.txt'],
    writes: ['child.tar'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each(['r', 'a', 'mode'])('tracks inline TAR factory mode %s conservatively', async (mode) => {
  const source = `import tarfile\nfrom io import BytesIO\nchild=tarfile.open(fileobj=BytesIO(),mode="w").open("child.tar",${mode === 'mode' ? 'mode' : JSON.stringify(mode)})`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual(['child.tar'])
  expect(result.writes).toEqual(mode === 'r' ? [] : ['child.tar'])
  expect(result.externalState).toBe('partial')
})

it('retains later reads after inline TAR factory arguments', async () => {
  const source =
    'import tarfile\nfrom io import BytesIO\nfrom pathlib import Path\nchild=tarfile.open(fileobj=BytesIO(),mode="w").open((Path("side.txt").write_text("argument"),"child.tar")[1],"w")\nresult=Path("side.txt").read_text()'
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it('keeps inline TAR factory memory targets off disk', async () => {
  const source =
    'import tarfile\nfrom io import BytesIO\nchild=tarfile.open(fileobj=BytesIO(),mode="w").open(name="ignored.tar",fileobj=BytesIO(),mode="w")\nchild.add("source/report.txt",arcname="member.txt")'
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['source/report.txt'],
    writes: [],
    writeState: 'partial'
  })
})

it.each([
  'class Noop:\n    def open(self,*args,**kwargs):\n        return self\n    def add(self,*args,**kwargs):\n        pass\ntarfile=Noop()',
  'class Noop:\n    def open(self,*args,**kwargs):\n        return self\n    def add(self,*args,**kwargs):\n        pass\ntarfile.open=Noop().open'
])('does not infer inline TAR factory paths after replacement: %s', async (replacement) => {
  const source = `import tarfile\nfrom io import BytesIO\n${replacement}\nchild=tarfile.open(fileobj=BytesIO(),mode="w").open("child.tar","w")\nchild.add("source/report.txt",arcname="member.txt")`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
})

it.each([
  ['import shutil\nshutil.make_archive("bundle","zip",root_dir="source")', 'source', 'bundle.zip'],
  [
    'import shutil as archive\narchive.make_archive("bundle","tar","source")',
    'source',
    'bundle.tar'
  ],
  [
    'from shutil import make_archive as pack\npack(base_name="bundle",format="gztar",root_dir="source")',
    'source',
    'bundle.tar.gz'
  ],
  [
    'import shutil\nshutil.make_archive("bundle","bztar",base_dir="source")',
    'source',
    'bundle.tar.bz2'
  ],
  [
    'import shutil\nshutil.make_archive("bundle","xztar","source","nested")',
    analyzedPythonPath('source/nested'),
    'bundle.tar.xz'
  ],
  [
    'import shutil\nshutil.make_archive("bundle.zip","zip",None,"source")',
    'source',
    'bundle.zip.zip'
  ],
  ['import shutil\nshutil.make_archive("bundle","zip")', '.', 'bundle.zip']
])(
  'tracks make_archive directory inputs and output candidates: %s',
  async (source, input, output) => {
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result).toMatchObject({
      reads: [input],
      writes: [output],
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
  'shutil.make_archive("bundle","zip",root_dir="source")',
  'shutil.make_archive("bundle","custom",root_dir="source")',
  'shutil.make_archive((Path("side.txt").write_text("argument"),"bundle")[1],"zip",root_dir="source")',
  'shutil.make_archive("bundle","zip",root_dir=(Path("side.txt").write_text("argument"),"source")[1])'
])('retains reads after make_archive and argument side effects: %s', async (call) => {
  const source = `import shutil\nfrom pathlib import Path\nPath("side.txt").write_text("before")\n${call}\nresult=Path("side.txt").read_text()`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toContain('side.txt')
  expect(result.readState).toBe('partial')
})

it.each(['custom', 'unknown'])(
  'does not infer a make_archive suffix for %s format',
  async (format) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import shutil\nshutil.make_archive("bundle",${format === 'custom' ? '"custom"' : 'format'},root_dir="source")`
    )
    expect(result.reads).toEqual(['source'])
    expect(result.writes).toEqual([])
    expect(result.writeState).toBe('partial')
  }
)

it.each(['True', '1'])(
  'does not certify an output for literal make_archive dry_run=%s',
  async (value) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import shutil\nshutil.make_archive("bundle","zip",root_dir="source",dry_run=${value})`
    )
    expect(result.writes).toEqual([])
    expect(result.externalState).toBe('partial')
  }
)

it.each([
  'shutil.make_archive(*args)',
  'shutil.make_archive(**options)',
  'shutil.make_archive("https://example.test/bundle","zip",root_dir="https://example.test/source")',
  'shutil.make_archive("out/*","zip",root_dir="source/*")'
])('avoids fabricated make_archive paths for unresolved arguments: %s', async (call) => {
  const result = await analyzeNotebookSourceFileAccess('python', `import shutil\n${call}`)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
  expect(result).toMatchObject({
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  'from shutil import make_archive as pack\ndef pack(*args,**kwargs):\n    pass\npack("bundle","zip",root_dir="source")',
  'class Noop:\n    def make_archive(self,*args,**kwargs):\n        pass\nshutil=Noop()\nshutil.make_archive("bundle","zip",root_dir="source")'
])('does not infer make_archive paths for replacement callables: %s', async (source) => {
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
})

it('captures partitioned pandas Parquet output as a directory scope', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'import pandas as pd',
      'frame = pd.read_csv("inputs/measurements.csv")',
      'frame.to_parquet("results/measurements", partition_cols=["group"], index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: ['inputs/measurements.csv'],
    writes: ['results/measurements'],
    writeScopes: [{ kind: 'directory', path: 'results/measurements' }],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('keeps dynamic Parquet partition outputs uncertain', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'import pandas as pd',
      'columns = get_partition_columns()',
      'frame = pd.read_csv("inputs/measurements.csv")',
      'frame.to_parquet("results/measurements", partition_cols=columns, index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: ['inputs/measurements.csv'],
    writes: ['results/measurements'],
    writeState: 'partial',
    externalState: 'partial'
  })
  expect(result.writeScopes).toBeUndefined()
})

it('treats pathlib output-directory setup as local notebook scaffolding', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'from pathlib import Path',
      'import pandas as pd',
      'Path("work").mkdir(parents=True, exist_ok=True)',
      'Path("outputs").mkdir(parents=True, exist_ok=True)',
      'frame = pd.read_csv("inputs/measurements.csv")',
      'frame.to_parquet("work/measurements.parquet")'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: ['inputs/measurements.csv'],
    writes: ['work/measurements.parquet'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('retains local metadata copy candidates without certifying destination resolution', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'from pathlib import Path',
      'import shutil',
      'import pandas as pd',
      'source = Path("inputs/atlas/metadata.json")',
      'shutil.copy2(source, "work/metadata.json")',
      'frame = pd.read_csv("inputs/counts.csv")',
      'frame.to_csv("outputs/counts.csv", index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining([join('inputs', 'atlas', 'metadata.json'), 'inputs/counts.csv']),
    writes: expect.arrayContaining(['work/metadata.json', 'outputs/counts.csv']),
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
  })
})

it('keeps recursive copytree coverage partial while retaining copied directory lineage', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'import shutil',
      'import pandas as pd',
      'shutil.copytree("inputs/reference", "work/reference", dirs_exist_ok=True)',
      'frame = pd.read_csv("work/reference/annotations.csv")',
      'frame.to_csv("outputs/annotated.csv", index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining(['inputs/reference', 'work/reference/annotations.csv']),
    writes: expect.arrayContaining(['work/reference', 'outputs/annotated.csv']),
    writeScopes: [{ kind: 'directory', path: 'work/reference' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining([
      'dynamic-path-unresolved',
      'source-analysis-unsupported-call'
    ])
  })
})

it.each([
  'copy_function=custom_copy',
  'ignore=custom_ignore',
  '**options',
  'False, None, custom_copy'
])('keeps copytree effects partial with %s', async (extraArguments) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import shutil\nshutil.copytree("inputs/reference", "work/reference", ${extraArguments})`
  )
  expect(result).toMatchObject({
    reads: ['inputs/reference'],
    writes: ['work/reference'],
    writeScopes: [{ kind: 'directory', path: 'work/reference' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  'import shutil\nshutil.copytree("source","out")',
  'import shutil\nshutil.copytree(dst="out",src="source",dirs_exist_ok=True)',
  'from shutil import copytree as copy\ncopy("source","out",dirs_exist_ok=True)',
  'import shutil\nfrom pathlib import Path\nshutil.copytree(Path("source"),Path("out"),dirs_exist_ok=True)',
  'import shutil\nshutil.copytree("source","out",ignore=lambda src,names:["report.txt"],dirs_exist_ok=True)',
  'import shutil\nshutil.copytree("source","out",copy_function=custom,dirs_exist_ok=True)'
])('does not certify copytree production or dependence completeness: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['source'],
    writes: ['out'],
    writeScopes: [{ kind: 'directory', path: 'out' }],
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
  'shutil.copytree("source","out",dirs_exist_ok=True)',
  'shutil.copytree("source","out")',
  'shutil.copytree("missing","out",dirs_exist_ok=True)',
  'shutil.copytree("source",(Path("out/report.txt").write_text("argument"),"out")[1],dirs_exist_ok=True)',
  'shutil.copytree("source","out",copy_function=custom,dirs_exist_ok=True)'
])('retains descendant reads after copytree can invalidate earlier writes: %s', async (call) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import shutil\nfrom pathlib import Path\nPath("out/report.txt").write_text("fresh")\n${call}\nresult=Path("out/report.txt").read_text()`
  )
  expect(result.reads).toContain(analyzedPythonPath('out/report.txt'))
  expect(result).toMatchObject({
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('retains reads outside copytree output after a callback may change them', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    'import shutil\nfrom pathlib import Path\nPath("side.txt").write_text("fresh")\nshutil.copytree("source","out",copy_function=custom,dirs_exist_ok=True)\nresult=Path("side.txt").read_text()'
  )
  expect(result.reads).toContain('side.txt')
  expect(result.writeState).toBe('partial')
})

it.each(['https://example.test/out', 'out/*'])(
  'does not invent a copytree output scope for %s',
  async (target) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import shutil\nshutil.copytree("source",${JSON.stringify(target)})`
    )
    expect(result.writes).toEqual([])
    expect(result.writeScopes).toBeUndefined()
    expect(result.writeState).toBe('partial')
  }
)

it('does not apply copytree mutation candidates to a rebound import', async () => {
  const source =
    'from shutil import copytree as copy\ndef copy(src,dst,**kwargs):\n    return dst\ncopy("source","out",dirs_exist_ok=True)'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
  expect(result.writeScopes).toBeUndefined()
})

it.each([
  'import shutil\nshutil.unpack_archive("input.zip","out")',
  'import shutil\nshutil.unpack_archive("input.tar","out",format="tar")',
  'import shutil as archive\narchive.unpack_archive("input.zip","out")',
  'from shutil import unpack_archive as unpack\nunpack("input.zip","out")',
  'import shutil\nshutil.unpack_archive(extract_dir="out",filename="input.zip")',
  'import shutil\nfrom pathlib import Path\nshutil.unpack_archive(Path("input.zip"),Path("out"))'
])('tracks unpack_archive candidates without certifying completeness: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [source.includes('input.tar') ? 'input.tar' : 'input.zip'],
    writes: ['out'],
    writeScopes: [{ kind: 'directory', path: 'out' }],
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
  'shutil.unpack_archive("input.zip","out")',
  'shutil.unpack_archive("input.tar","out",filter=custom)',
  'shutil.unpack_archive("input.zip",(Path("out/report.txt").write_text("argument"),"out")[1])',
  'shutil.unpack_archive((Path("out/report.txt").write_text("argument"),"input.zip")[1],"out")'
])('retains reads after unpack_archive invalidates earlier outputs: %s', async (call) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import shutil\nfrom pathlib import Path\nPath("out/report.txt").write_text("fresh")\n${call}\nresult=Path("out/report.txt").read_text()`
  )
  expect(result.reads).toContain(analyzedPythonPath('out/report.txt'))
  expect(result.writeState).toBe('partial')
})

it.each(['', ',None', ',"https://example.test/out"', ',"out/*"', ',target'])(
  'does not invent an unpack_archive output scope for %s',
  async (target) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import shutil\nshutil.unpack_archive("input.zip"${target})`
    )
    expect(result.reads).toEqual(['input.zip'])
    expect(result.writes).toEqual([])
    expect(result.writeScopes).toBeUndefined()
    expect(result).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  }
)

it('retains outside reads after unpack_archive can invoke registered unpackers', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    'import shutil\nfrom pathlib import Path\nPath("side.txt").write_text("fresh")\nshutil.unpack_archive("input.zip","out",format="custom")\nresult=Path("side.txt").read_text()'
  )
  expect(result.reads).toContain('side.txt')
  expect(result.writeState).toBe('partial')
})

it.each([
  'from shutil import unpack_archive as unpack\ndef unpack(filename,extract_dir):\n    return extract_dir\nunpack("input.zip","out")',
  'class Noop:\n    def unpack_archive(self,filename,extract_dir):\n        pass\nshutil=Noop()\nshutil.unpack_archive("input.zip","out")'
])('does not invent unpack_archive lineage for a replacement callable: %s', async (source) => {
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
  expect(result.writeScopes).toBeUndefined()
})

it.each([
  [
    'with zipfile.ZipFile("output.zip","w") as archive:\n    archive.write("source/report.txt",arcname="member.txt")',
    'output.zip'
  ],
  [
    'archive=zipfile.ZipFile("output.zip","w")\nalias=archive\nalias.write(filename="source/report.txt",arcname="member.txt")',
    'output.zip'
  ],
  [
    'with zipfile.ZipFile("output.zip","a") as archive:\n    archive.write("source/report.txt")',
    'output.zip'
  ],
  [
    'with tarfile.open("output.tar","w") as archive:\n    archive.add("source/report.txt",arcname="member.txt")',
    'output.tar'
  ],
  [
    'archive=tarfile.open("output.tar","w")\nalias=archive\nalias.add(name="source/report.txt",arcname="member.txt")',
    'output.tar'
  ],
  [
    'with tarfile.open("output.tar","a") as archive:\n    archive.add("source/report.txt")',
    'output.tar'
  ]
])('captures archive member writes with file input: %s', async (body, output) => {
  const source = 'import zipfile,tarfile\n' + body
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toContain('source/report.txt')
  expect(result.writes).toContain(output)
  expect(result.reads).not.toContain('member.txt')
  expect(result.writes).not.toContain('member.txt')
  expect(result).toMatchObject({
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
  ['zipfile.ZipFile("output.zip","w")', 'write', 'output.zip'],
  ['tarfile.open("output.tar","w")', 'add', 'output.tar']
])(
  'retains subsequent archive reads after archive member writes: %s',
  async (open, method, output) => {
    const source = `import zipfile,tarfile\nfrom pathlib import Path\nwith ${open} as archive:\n    archive.${method}("source/report.txt")\nresult=Path("${output}").read_bytes()`
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain(output)
  }
)

it.each([
  ['zipfile.ZipFile("output.zip","w")', 'write'],
  ['tarfile.open("output.tar","w")', 'add']
])('invalidates argument-side writes after archive member writes: %s', async (open, method) => {
  const source = `import zipfile,tarfile\nfrom pathlib import Path\nwith ${open} as archive:\n    archive.${method}((Path("side.txt").write_text("argument"),"source/report.txt")[1])\nresult=Path("side.txt").read_text()`
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it('retains outside reads after archive member writes invoke a TAR filter', async () => {
  const source =
    'import tarfile\nfrom pathlib import Path\nPath("side.txt").write_text("fresh")\nwith tarfile.open("output.tar","w") as archive:\n    archive.add("source",filter=custom)\nresult=Path("side.txt").read_text()'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual(expect.arrayContaining(['source', 'side.txt']))
  expect(result.writeState).toBe('partial')
})

it.each([
  ['zipfile.ZipFile(BytesIO(),"w")', 'write'],
  ['tarfile.open(fileobj=BytesIO(),mode="w")', 'add']
])('does not invent disk outputs for in-memory archive member writes: %s', async (open, method) => {
  const source = `import zipfile,tarfile\nfrom io import BytesIO\nwith ${open} as archive:\n    archive.${method}("source/report.txt",arcname="member.txt")`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toContain('source/report.txt')
  expect(result.writes).toEqual([])
  expect(result.writeState).toBe('partial')
})

it.each([
  ['zipfile.ZipFile("output.zip","w")', 'write'],
  ['tarfile.open("output.tar","w")', 'add']
])('does not invent dynamic inputs for archive member writes: %s', async (open, method) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import zipfile,tarfile\nwith ${open} as archive:\n    archive.${method}(source,arcname="member.txt")`
  )
  expect(result.reads).toEqual([])
  expect(result.readState).toBe('partial')
})

it.each(['write', 'add'])(
  'ignores replacement receivers for archive member writes: %s',
  async (method) => {
    const source = `import zipfile\narchive=zipfile.ZipFile("output.zip","w")\narchive.close()\nclass Noop:\n    def ${method}(self,source,arcname):\n        pass\narchive=Noop()\narchive.${method}("source/report.txt",arcname="member.txt")`
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  }
)

it.each([
  'with zipfile.ZipFile("output.zip","w") as archive:\n    archive.writestr("member.txt","payload")',
  'archive=zipfile.ZipFile("output.zip","w")\nalias=archive\nalias.writestr(zinfo_or_arcname="member.txt",data=b"payload")',
  'with tarfile.open("output.tar","w") as archive:\n    archive.addfile(tarfile.TarInfo("member.txt"))',
  'archive=tarfile.open("output.tar","w")\nalias=archive\nalias.addfile(tarinfo=tarfile.TarInfo("member.txt"),fileobj=None)'
])('keeps archive payload writes external without inventing member inputs: %s', async (body) => {
  const source = 'import zipfile,tarfile\n' + body
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([body.includes('tarfile') ? 'output.tar' : 'output.zip'])
  expect(result).toMatchObject({
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
  ['zipfile.ZipFile("output.zip","w")', 'writestr("member.txt","payload")', 'output.zip'],
  ['tarfile.open("output.tar","w")', 'addfile(tarfile.TarInfo("member.txt"))', 'output.tar']
])('retains archive reads after archive payload writes: %s', async (open, call, output) => {
  const source = `import zipfile,tarfile\nfrom pathlib import Path\nwith ${open} as archive:\n    archive.${call}\nresult=Path("${output}").read_bytes()`
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain(output)
})

it.each(['handle', 'open("source/report.txt","rb")'])(
  'captures stream inputs after archive payload writes: %s',
  async (stream) => {
    const source = `import tarfile\nfrom pathlib import Path\nPath("source/report.txt").write_text("payload")\nhandle=open("source/report.txt","rb")\nwith tarfile.open("output.tar","w") as archive:\n    archive.addfile(info,fileobj=${stream})`
    expect(
      (await analyzeNotebookSourceFileAccess('python', source)).reads.map((path) =>
        path.replaceAll('\\', '/')
      )
    ).toContain('source/report.txt')
  }
)

it.each(['"source/report.txt"', 'BytesIO(b"payload")', 'None', 'stream'])(
  'does not treat arbitrary fileobj as a filename in archive payload writes: %s',
  async (stream) => {
    const source = `import tarfile\nfrom io import BytesIO\nwith tarfile.open("output.tar","w") as archive:\n    archive.addfile(info,fileobj=${stream})`
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).toEqual([])
    expect(result.readState).toBe('partial')
  }
)

it.each([
  [
    'zipfile.ZipFile("output.zip","w")',
    'writestr("member.txt",(Path("side.txt").write_text("argument"),"payload")[1])'
  ],
  [
    'tarfile.open("output.tar","w")',
    'addfile(info,(Path("side.txt").write_text("argument"),stream)[1])'
  ]
])('invalidates argument-side writes after archive payload writes: %s', async (open, call) => {
  const source = `import zipfile,tarfile\nfrom pathlib import Path\nwith ${open} as archive:\n    archive.${call}\nresult=Path("side.txt").read_text()`
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it('retains outside reads after archive payload writes invoke a reader', async () => {
  const source =
    'import tarfile\nfrom pathlib import Path\nPath("side.txt").write_text("fresh")\nwith tarfile.open("output.tar","w") as archive:\n    archive.addfile(info,fileobj=custom)\nresult=Path("side.txt").read_text()'
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it.each([
  ['zipfile.ZipFile(BytesIO(),"w")', 'writestr("member.txt","payload")'],
  ['tarfile.open(fileobj=BytesIO(),mode="w")', 'addfile(tarfile.TarInfo("member.txt"))']
])('keeps memory outputs off disk for archive payload writes: %s', async (open, call) => {
  const source = `import zipfile,tarfile\nfrom io import BytesIO\nwith ${open} as archive:\n    archive.${call}`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
  expect(result.writeState).toBe('partial')
})

it('does not invent inputs or outputs for rebound archive payload writes', async () => {
  const source =
    'import zipfile\narchive=zipfile.ZipFile("output.zip","w")\narchive.close()\nclass Noop:\n    def writestr(self,name,data):\n        pass\narchive=Noop()\narchive.writestr("member.txt","payload")'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual(['output.zip'])
})

it.each([
  'archive.open("member.txt","w")',
  'archive.open(name="member.txt",mode="w")',
  'archive.open("member.txt",mode=mode)',
  'archive.open("member.txt",**options)',
  'archive.open(*arguments)',
  'archive.open("member.txt",None)'
])('keeps archive stream writes partial and preserves later reads: %s', async (call) => {
  const source = `import zipfile\nfrom pathlib import Path\nwith zipfile.ZipFile("output.zip","w") as archive:\n    stream=${call}\nresult=Path("output.zip").read_bytes()`
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toContain('output.zip')
  expect(result.writes).toEqual(['output.zip'])
  expect(result.reads).not.toContain('member.txt')
  expect(result).toMatchObject({
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
  'archive=zipfile.ZipFile("output.zip","w")\nalias=archive\nstream=alias.open("member.txt","w")',
  'with zipfile.ZipFile("output.zip","a") as archive:\n    with archive.open("member.txt","w") as stream:\n        stream.write(b"payload")'
])('tracks aliases and contexts for archive stream writes: %s', async (body) => {
  const source = 'import zipfile\n' + body
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.writes).toEqual(['output.zip'])
  expect(result.writeState).toBe('partial')
  expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each([
  'archive.open((Path("side.txt").write_text("argument"),"member.txt")[1],"w")',
  'archive.open("member.txt",(Path("side.txt").write_text("argument"),"w")[1])'
])('invalidates argument-side proof after archive stream writes: %s', async (call) => {
  const source = `import zipfile\nfrom pathlib import Path\nwith zipfile.ZipFile("output.zip","w") as archive:\n    stream=${call}\nresult=Path("side.txt").read_text()`
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it('does not invent disk outputs for memory archive stream writes', async () => {
  const source =
    'import zipfile\nfrom io import BytesIO\nwith zipfile.ZipFile(BytesIO(),"w") as archive:\n    stream=archive.open("member.txt","w")'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
  expect(result.writeState).toBe('partial')
})

it.each(['archive.open("member.txt")', 'archive.open("member.txt","r")'])(
  'does not apply archive stream writes to explicit read-only calls: %s',
  async (call) => {
    const source = `import zipfile\nwith zipfile.ZipFile("input.zip","r") as archive:\n    stream=${call}`
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).toEqual(['input.zip'])
    expect(result.writes).toEqual([])
    expect(result.writeState).toBe('complete')
    const { facts } = await analyzePythonNotebookSource(source)
    expect(facts.state === 'unknown' ? facts.reasons : []).not.toContain('external-state')
  }
)

it('clears ZIP identity on receiver rebinding for archive stream writes', async () => {
  const source =
    'import zipfile\narchive=zipfile.ZipFile("output.zip","w")\narchive.close()\nclass Noop:\n    def open(self,name,mode):\n        pass\narchive=Noop()\narchive.open("member.txt","w")'
  const { facts } = await analyzePythonNotebookSource(source)
  expect(facts.state === 'unknown' ? facts.reasons : []).not.toContain('external-state')
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
})

it('tracks TAR factory open separately from ZIP archive stream writes', async () => {
  const source =
    'import tarfile\narchive=tarfile.open("output.tar","w")\nchild=archive.open("child.tar","w")'
  const { facts } = await analyzePythonNotebookSource(source)
  expect(facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
  expect((await analyzeNotebookSourceFileAccess('python', source)).writes).toEqual([
    'child.tar',
    'output.tar'
  ])
})

it.each([
  'child=archive.open("child.tar","w")\nchild.add("source/report.txt",arcname="member.txt")',
  'child=archive.open(name="child.tar",mode="w")\nchild.add("source/report.txt",arcname="member.txt")',
  'alias=archive\nchild=alias.open("child.tar","w")\nchild.add("source/report.txt",arcname="member.txt")',
  'with archive.open("child.tar","w") as child:\n    child.add("source/report.txt",arcname="member.txt")',
  'child=archive.open("child.tar","w:gz")\nchild.add("source/report.txt",arcname="member.txt")',
  'child=archive.open("child.tar","w")\nalias=child\nalias.add("source/report.txt",arcname="member.txt")'
])('tracks TAR factory output and returned archive identity: %s', async (body) => {
  const source = 'import tarfile\narchive=tarfile.open("parent.tar","w")\n' + body
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.writes).toEqual(['child.tar', 'parent.tar'])
  expect(result.reads).toContain('source/report.txt')
  expect(result.reads).not.toContain('member.txt')
  expect(result).toMatchObject({
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each(['r', 'a'])('retains TAR factory input for mode %s', async (mode) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import tarfile\narchive=tarfile.open("parent.tar","w")\nchild=archive.open("child.tar","${mode}")`
  )
  expect(result.reads).toEqual(['child.tar'])
  expect(result.writes).toEqual(mode === 'a' ? ['child.tar', 'parent.tar'] : ['parent.tar'])
  expect(result.readState).toBe('partial')
})

it.each(['BytesIO()', '"not-a-stream.tar"'])(
  'does not treat TAR factory fileobj as a disk filename: %s',
  async (stream) => {
    const source = `import tarfile\nfrom io import BytesIO\narchive=tarfile.open("parent.tar","w")\nchild=archive.open(name="ignored.tar",mode="w",fileobj=${stream})`
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).toEqual([])
    expect(result.writes).toEqual(['parent.tar'])
    expect(result.writeState).toBe('partial')
  }
)

it.each(['mode', 'None'])('keeps unresolved TAR factory modes conservative: %s', async (mode) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import tarfile\narchive=tarfile.open("parent.tar","w")\nchild=archive.open("child.tar",${mode})`
  )
  expect(result.reads).toEqual(['child.tar'])
  expect(result.writes).toEqual(['child.tar', 'parent.tar'])
  expect(result.writeState).toBe('partial')
})

it.each([
  'archive.open((Path("side.txt").write_text("argument"),"child.tar")[1],"w")',
  'archive.open("child.tar",(Path("side.txt").write_text("argument"),"w")[1])'
])('retains later reads after TAR factory argument effects: %s', async (call) => {
  const source = `import tarfile\nfrom pathlib import Path\narchive=tarfile.open("parent.tar","w")\nchild=${call}\nresult=Path("side.txt").read_text()`
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain('side.txt')
})

it.each([
  'class Noop:\n    def open(self,name,mode):\n        return None\narchive=Noop()\nchild=archive.open("child.tar","w")',
  'def noop(name,mode):\n    return None\nalias=archive\nalias.open=noop\nchild=archive.open("child.tar","w")'
])('does not invent TAR factory lineage after identity replacement: %s', async (body) => {
  const source = 'import tarfile\narchive=tarfile.open("parent.tar","w")\n' + body
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.writes).not.toContain('child.tar')
})

it('propagates TAR factory identity through another factory call', async () => {
  const source =
    'import tarfile\narchive=tarfile.open("parent.tar","w")\nchild=archive.open("child.tar","w")\ngrandchild=child.open("grandchild.tar","w")\ngrandchild.add("source/report.txt")'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.writes).toEqual(['child.tar', 'grandchild.tar', 'parent.tar'])
  expect(result.reads).toEqual(['source/report.txt'])
})

it('captures a wearable sensor QC workflow with compressed and JSON inputs', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'from pathlib import Path',
      'import gzip',
      'import json',
      'import matplotlib.pyplot as plt',
      'import numpy as np',
      'import pandas as pd',
      'work = Path("work")',
      'outputs = Path("outputs")',
      'work.mkdir(parents=True, exist_ok=True)',
      'outputs.mkdir(parents=True, exist_ok=True)',
      'sensors = pd.read_csv("inputs/sensors.csv")',
      'with gzip.open("inputs/reference.csv.gz", "rt") as handle:',
      '    reference = pd.read_csv(handle)',
      'calibration = json.loads(Path("inputs/calibration.json").read_text())',
      'sensors["calibrated"] = sensors["raw"] * calibration["scale"] + calibration["offset"]',
      'sensors.to_parquet("work/calibrated_sensor_data.parquet", index=False)',
      'summary = {"missing": int(sensors.isna().sum().sum()), "reference_rows": len(reference)}',
      'Path("outputs/qc_summary.json").write_text(json.dumps(summary))',
      'plt.plot(np.arange(len(sensors)), sensors["calibrated"].to_numpy())',
      'plt.savefig("outputs/qc.png")'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining([
      'inputs/sensors.csv',
      'inputs/reference.csv.gz',
      join('inputs', 'calibration.json')
    ]),
    writes: expect.arrayContaining([
      'work/calibrated_sensor_data.parquet',
      join('outputs', 'qc_summary.json'),
      'outputs/qc.png'
    ]),
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('captures archive extraction before downstream table analysis', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'import tarfile',
      'import pandas as pd',
      'with tarfile.open("inputs/batch.tar.gz", "r:gz") as archive:',
      '    archive.extractall("work/batch")',
      'frame = pd.read_csv("work/batch/measurements.csv")',
      'frame.to_csv("outputs/summary.csv", index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining(['inputs/batch.tar.gz', 'work/batch/measurements.csv']),
    writes: expect.arrayContaining(['work/batch', 'outputs/summary.csv']),
    writeScopes: [{ kind: 'directory', path: 'work/batch' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
  })
})

it('captures archive extraction in a real agent-generated ZIP batch workflow', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'from zipfile import ZipFile',
      'from pathlib import Path',
      'import csv',
      'import statistics',
      'import json',
      '',
      'archive = Path("inputs/batch.zip")',
      'extract_dir = Path("work/batch")',
      'output_dir = Path("outputs")',
      '',
      'extract_dir.mkdir(parents=True, exist_ok=True)',
      'output_dir.mkdir(parents=True, exist_ok=True)',
      '',
      'with ZipFile(archive) as batch:',
      '    batch.extractall(extract_dir)',
      '',
      'observations_path = extract_dir / "observations.csv"',
      'with observations_path.open(newline="", encoding="utf-8") as file:',
      '    rows = list(csv.DictReader(file))',
      '',
      'temperatures = [float(row["temperature"]) for row in rows]',
      'humidities = [float(row["humidity"]) for row in rows]',
      '',
      'summary = {',
      '    "row_count": len(rows),',
      '    "mean_temperature": statistics.mean(temperatures),',
      '    "mean_humidity": statistics.mean(humidities),',
      '}',
      '',
      'with (output_dir / "summary.json").open("w", encoding="utf-8") as file:',
      '    json.dump(summary, file, indent=2)',
      '',
      'print(len(rows))'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining([
      analyzedPythonPath('inputs/batch.zip'),
      analyzedPythonPath('work/batch/observations.csv')
    ]),
    writes: expect.arrayContaining([
      analyzedPythonPath('work/batch'),
      analyzedPythonPath('outputs/summary.json')
    ]),
    writeScopes: [{ kind: 'directory', path: analyzedPythonPath('work/batch') }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
  })
})

it.each([
  'with zipfile.ZipFile("input.zip") as archive:\n    archive.extractall("out")',
  'archive=zipfile.ZipFile("input.zip")\narchive.extractall("out")',
  'archive=zipfile.ZipFile("input.zip")\nalias=archive\nalias.extractall(path="out")',
  'with tarfile.open("input.tar") as archive:\n    archive.extractall("out")',
  'archive=tarfile.open("input.tar")\narchive.extractall("out")',
  'archive=tarfile.open("input.tar")\nalias=archive\nalias.extractall(path="out")'
])('retains archive extraction scope without certifying completeness: %s', async (body) => {
  const source = 'import zipfile,tarfile\n' + body
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    writes: ['out'],
    writeScopes: [{ kind: 'directory', path: 'out' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each(['zipfile.ZipFile("input.zip")', 'tarfile.open("input.tar")'])(
  'retains reads after archive extraction overwrites a prior output: %s',
  async (open) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import zipfile,tarfile\nfrom pathlib import Path\nPath("out/report.txt").write_text("fresh")\nwith ${open} as archive:\n    archive.extractall("out")\nresult=Path("out/report.txt").read_text()`
    )
    expect(result.reads).toContain(analyzedPythonPath('out/report.txt'))
    expect(result.writeState).toBe('partial')
  }
)

it('invalidates argument-side writes after archive extraction', async () => {
  const source =
    'import zipfile\nfrom pathlib import Path\nwith zipfile.ZipFile("input.zip") as archive:\n    archive.extractall((Path("out/report.txt").write_text("argument"),"out")[1])\nresult=Path("out/report.txt").read_text()'
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain(
    analyzedPythonPath('out/report.txt')
  )
})

it('retains outside reads after archive extraction can invoke a filter', async () => {
  const source =
    'import tarfile\nfrom pathlib import Path\nPath("side.txt").write_text("fresh")\nwith tarfile.open("input.tar") as archive:\n    archive.extractall("out",filter=custom)\nresult=Path("side.txt").read_text()'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toContain('side.txt')
  expect(result.writeState).toBe('partial')
})

it.each(['', 'None', '"https://example.test/out"', '"out/*"'])(
  'does not invent an archive extraction scope for %s',
  async (target) => {
    const source = `import zipfile\nwith zipfile.ZipFile("input.zip") as archive:\n    archive.extractall(${target})`
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.writes).toEqual([])
    expect(result.writeScopes).toBeUndefined()
    expect(result).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  }
)

it.each([
  'import zipfile\narchive=zipfile.ZipFile("input.zip")\narchive.close()\nclass Noop:\n    def extractall(self,path):\n        pass\narchive=Noop()\narchive.extractall("out")',
  'class Noop:\n    def extractall(self,path):\n        pass\narchive=Noop()\narchive.extractall("out")'
])('does not apply archive extraction scopes to a replacement receiver: %s', async (source) => {
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.writes).toEqual([])
  expect(result.writeScopes).toBeUndefined()
})

it.each([
  'with zipfile.ZipFile("input.zip") as archive:\n    archive.extract("report.txt","out")',
  'archive=zipfile.ZipFile("input.zip")\narchive.extract("report.txt","out")',
  'archive=zipfile.ZipFile("input.zip")\nalias=archive\nalias.extract("report.txt",path="out")',
  'with tarfile.open("input.tar") as archive:\n    archive.extract("report.txt","out")',
  'archive=tarfile.open("input.tar")\narchive.extract("report.txt","out")',
  'archive=tarfile.open("input.tar")\nalias=archive\nalias.extract("report.txt",path="out")'
])('retains single-member extraction scope without certifying completeness: %s', async (body) => {
  const source = 'import zipfile,tarfile\n' + body
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual([body.includes('tarfile') ? 'input.tar' : 'input.zip'])
  expect(result).toMatchObject({
    writes: ['out'],
    writeScopes: [{ kind: 'directory', path: 'out' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect((await analyzePythonNotebookSource(source)).facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it.each(['zipfile.ZipFile("input.zip")', 'tarfile.open("input.tar")'])(
  'retains reads after single-member extraction overwrites a prior output: %s',
  async (open) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import zipfile,tarfile\nfrom pathlib import Path\nPath("out/report.txt").write_text("fresh")\nwith ${open} as archive:\n    archive.extract("report.txt","out")\nresult=Path("out/report.txt").read_text()`
    )
    expect(result.reads).toContain(analyzedPythonPath('out/report.txt'))
    expect(result.writeState).toBe('partial')
  }
)

it('invalidates argument-side writes after single-member extraction', async () => {
  const source =
    'import zipfile\nfrom pathlib import Path\nwith zipfile.ZipFile("input.zip") as archive:\n    archive.extract("report.txt",(Path("out/report.txt").write_text("argument"),"out")[1])\nresult=Path("out/report.txt").read_text()'
  expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toContain(
    analyzedPythonPath('out/report.txt')
  )
})

it('retains outside reads after single-member extraction can invoke a filter', async () => {
  const source =
    'import tarfile\nfrom pathlib import Path\nPath("side.txt").write_text("fresh")\nwith tarfile.open("input.tar") as archive:\n    archive.extract("report.txt","out",filter=custom)\nresult=Path("side.txt").read_text()'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toContain('side.txt')
  expect(result.writeState).toBe('partial')
})

it.each(['', 'None', '"https://example.test/out"', '"out/*"'])(
  'does not invent a single-member extraction scope for %s',
  async (target) => {
    const source = `import zipfile\nwith zipfile.ZipFile("input.zip") as archive:\n    archive.extract("report.txt"${target ? `,${target}` : ''})`
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.writes).toEqual([])
    expect(result.writeScopes).toBeUndefined()
    expect(result).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  }
)

it.each([
  'import zipfile\narchive=zipfile.ZipFile("input.zip")\narchive.close()\nclass Noop:\n    def extract(self,member,path):\n        pass\narchive=Noop()\narchive.extract("report.txt","out")',
  'class Noop:\n    def extract(self,member,path):\n        pass\narchive=Noop()\narchive.extract("report.txt","out")'
])(
  'does not apply single-member extraction scopes to a replacement receiver: %s',
  async (source) => {
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.writes).toEqual([])
    expect(result.writeScopes).toBeUndefined()
  }
)

it.each([
  ['zipfile.ZipFile("input.zip")', 'archive.getinfo("report.txt")', 'input.zip'],
  ['tarfile.open("input.tar")', 'archive.getmember("report.txt")', 'input.tar']
])(
  'captures single-member extraction from an archive member object: %s',
  async (open, member, input) => {
    const source = `import zipfile,tarfile\nwith ${open} as archive:\n    archive.extract(${member}, path="out")`
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).toEqual([input])
    expect(result).toMatchObject({
      writes: ['out'],
      writeScopes: [{ kind: 'directory', path: 'out' }],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  }
)

it('uses named path rather than member for single-member extraction', async () => {
  const source =
    'import zipfile\nwith zipfile.ZipFile("input.zip") as archive:\n    archive.extract(path="out", member="report.txt")'
  const result = await analyzeNotebookSourceFileAccess('python', source)
  expect(result.reads).toEqual(['input.zip'])
  expect(result.writes).toEqual(['out'])
  expect(result.writeScopes).toEqual([{ kind: 'directory', path: 'out' }])
})

it('captures a real agent-generated FASTQ QC workflow', async () => {
  const source = String.raw`from pathlib import Path
import gzip
import csv
import json

input_path = Path("inputs/sample_R1.fastq.gz")
output_dir = Path("outputs")
output_dir.mkdir(parents=True, exist_ok=True)

read_count = 0
total_read_length = 0
total_gc_bases = 0
total_bases = 0
total_phred = 0

with gzip.open(input_path, "rt", encoding="ascii", newline="") as fastq:
    record_number = 0
    while True:
        header = fastq.readline()
        if header == "":
            break

        record_number += 1
        sequence = fastq.readline()
        separator = fastq.readline()
        quality = fastq.readline()

        if sequence == "" or separator == "" or quality == "":
            raise ValueError(f"Incomplete FASTQ record {record_number}")
        if not header.rstrip("\r\n").startswith("@"):
            raise ValueError(f"Invalid FASTQ header in record {record_number}")
        if not separator.rstrip("\r\n").startswith("+"):
            raise ValueError(f"Invalid FASTQ separator in record {record_number}")

        sequence = sequence.rstrip("\r\n")
        quality = quality.rstrip("\r\n")

        if len(sequence) != len(quality):
            raise ValueError(f"Sequence and quality lengths differ in record {record_number}")

        read_length = len(sequence)
        read_count += 1
        total_read_length += read_length
        total_bases += read_length
        total_gc_bases += sum(base in "GgCc" for base in sequence)
        total_phred += sum(ord(score) - 33 for score in quality)

summary = {
    "read_count": read_count,
    "mean_read_length": total_read_length / read_count if read_count else 0.0,
    "gc_fraction": total_gc_bases / total_bases if total_bases else 0.0,
    "mean_phred_quality": total_phred / total_bases if total_bases else 0.0,
}

with (output_dir / "fastq_qc.json").open("w", encoding="utf-8", newline="\n") as json_file:
    json.dump(summary, json_file, indent=2)
    json_file.write("\n")

with (output_dir / "fastq_qc.tsv").open("w", encoding="utf-8", newline="") as tsv_file:
    writer = csv.writer(tsv_file, delimiter="\t", lineterminator="\n")
    writer.writerow(["metric", "value"])
    for metric, value in summary.items():
        writer.writerow([metric, value])`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [analyzedPythonPath('inputs/sample_R1.fastq.gz')],
    writes: [
      analyzedPythonPath('outputs/fastq_qc.json'),
      analyzedPythonPath('outputs/fastq_qc.tsv')
    ],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('retains a real agent-generated FASTQ glob as partial batch input lineage', async () => {
  const source = String.raw`from pathlib import Path
import gzip
import csv
import json
import statistics

input_files = sorted(Path("inputs").glob("*.fastq.gz"))
records = []

for path in input_files:
    read_count = 0
    read_lengths = []
    total_bases = 0
    gc_bases = 0
    total_phred = 0

    with gzip.open(path, "rt", encoding="ascii", newline="") as handle:
        while True:
            header = handle.readline()
            if header == "":
                break

            sequence = handle.readline()
            separator = handle.readline()
            quality = handle.readline()

            if sequence == "" or separator == "" or quality == "":
                raise ValueError(f"Incomplete FASTQ record in {path}")

            header = header.rstrip("\r\n")
            sequence = sequence.rstrip("\r\n")
            separator = separator.rstrip("\r\n")
            quality = quality.rstrip("\r\n")

            if not header.startswith("@"):
                raise ValueError(f"Invalid FASTQ header in {path}")
            if not separator.startswith("+"):
                raise ValueError(f"Invalid FASTQ separator in {path}")
            if len(sequence) != len(quality):
                raise ValueError(f"Sequence and quality lengths differ in {path}")

            read_count += 1
            read_length = len(sequence)
            read_lengths.append(read_length)
            total_bases += read_length
            gc_bases += sum(base in "GCgc" for base in sequence)
            total_phred += sum(ord(char) - 33 for char in quality)

    records.append(
        {
            "file": path.as_posix(),
            "read_count": read_count,
            "mean_read_length": statistics.mean(read_lengths) if read_lengths else 0.0,
            "gc_fraction": gc_bases / total_bases if total_bases else 0.0,
            "mean_phred_quality": total_phred / total_bases if total_bases else 0.0,
        }
    )

outputs = Path("outputs")
outputs.mkdir(parents=True, exist_ok=True)

with (outputs / "fastq_batch_qc.json").open("w", encoding="utf-8", newline="\n") as handle:
    json.dump(records, handle, indent=2)
    handle.write("\n")

fields = ["file", "read_count", "mean_read_length", "gc_fraction", "mean_phred_quality"]
with (outputs / "fastq_batch_qc.tsv").open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=fields, delimiter="\t", lineterminator="\n")
    writer.writeheader()
    writer.writerows(records)`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [analyzedPythonPath('inputs/*.fastq.gz')],
    writes: [
      analyzedPythonPath('outputs/fastq_batch_qc.json'),
      analyzedPythonPath('outputs/fastq_batch_qc.tsv')
    ],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining([
      'dynamic-path-unresolved',
      'source-analysis-unsupported-call'
    ])
  })
})

it('captures a real agent-generated ELISA calibration workflow', async () => {
  const source = String.raw`from pathlib import Path
import csv
import json
import math
import statistics

blank_values = []
standard_values = {}
unknown_values = {}

with Path("inputs/plate.csv").open("r", encoding="utf-8-sig", newline="") as handle:
    reader = csv.DictReader(handle)
    for row in reader:
        role = row["role"].strip()
        absorbance = float(row["absorbance"])
        if not math.isfinite(absorbance):
            raise ValueError("Nonfinite absorbance")
        if role == "blank":
            blank_values.append(absorbance)
        elif role == "standard":
            concentration = float(row["concentration_ng_ml"])
            standard_values.setdefault(concentration, []).append(absorbance)
        else:
            unknown_values.setdefault(row["sample_id"].strip(), []).append(absorbance)

if not blank_values or len(standard_values) < 3:
    raise ValueError("Missing calibration controls")
blank_mean = statistics.mean(blank_values)
standard_concentrations = sorted(standard_values)
x_values = [math.log10(value) for value in standard_concentrations]
y_values = [statistics.mean(value - blank_mean for value in standard_values[key]) for key in standard_concentrations]
x_mean = statistics.mean(x_values)
y_mean = statistics.mean(y_values)
sxx = math.fsum((value - x_mean) ** 2 for value in x_values)
sxy = math.fsum((x - x_mean) * (y - y_mean) for x, y in zip(x_values, y_values))
slope = sxy / sxx
if not math.isfinite(slope) or slope == 0:
    raise ValueError("Calibration slope must be finite and nonzero")
intercept = y_mean - slope * x_mean
results = []
for sample_id in sorted(unknown_values):
    mean_corrected_absorbance = statistics.mean(value - blank_mean for value in unknown_values[sample_id])
    try:
        concentration = 10.0 ** ((mean_corrected_absorbance - intercept) / slope)
    except OverflowError as exc:
        raise ValueError("Concentration overflow") from exc
    results.append({"sample_id": sample_id, "mean_corrected_absorbance": mean_corrected_absorbance, "concentration_ng_ml": concentration})

Path("outputs").mkdir(parents=True, exist_ok=True)
with Path("outputs/calibration.json").open("w", encoding="utf-8", newline="\n") as handle:
    json.dump({"slope": slope, "intercept": intercept, "blank_mean": blank_mean}, handle)
with Path("outputs/concentrations.csv").open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=["sample_id", "mean_corrected_absorbance", "concentration_ng_ml"], lineterminator="\n")
    writer.writeheader()
    writer.writerows(results)`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [analyzedPythonPath('inputs/plate.csv')],
    writes: [
      analyzedPythonPath('outputs/calibration.json'),
      analyzedPythonPath('outputs/concentrations.csv')
    ],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('captures a multi-stage ATAC and peak annotation workflow', async () => {
  const source = `from pathlib import Path
import subprocess
import pandas as pd
samples = pd.read_csv("inputs/atac-samples.csv")
Path("work").mkdir(exist_ok=True)
for row in samples.itertuples():
    subprocess.run(["aligner", "-1", row.fastq_r1, "-2", row.fastq_r2, "-o", f"work/{row.sample}.bam"], check=True)
    subprocess.run(["peakcaller", "--bam", f"work/{row.sample}.bam", "--out", f"work/{row.sample}.narrowPeak"], check=True)
peaks = pd.read_csv("inputs/consensus-peaks.bed", sep="\\t")
counts = pd.read_csv("work/peak-counts.tsv", sep="\\t")
peaks.merge(counts, on="peak_id").to_csv("results/differential-peaks.csv", index=False)
Path("results/qc-report.html").write_text("<html>qc</html>")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/atac-samples.csv', 'inputs/consensus-peaks.bed', 'work/peak-counts.tsv'],
    writes: ['results/differential-peaks.csv', join('results', 'qc-report.html')],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures a metagenomic assembly and abundance workflow', async () => {
  const source = `from pathlib import Path
import subprocess
import pandas as pd
manifest = pd.read_csv("inputs/metagenome-manifest.csv")
for row in manifest.itertuples():
    subprocess.run(["assembler", row.reads, "--output", f"work/{row.sample}/contigs.fasta"], check=True)
    subprocess.run(["classifier", f"work/{row.sample}/contigs.fasta", "--database", "inputs/taxonomy-db"], check=True)
tables = [pd.read_csv(f"work/{row.sample}/abundance.tsv", sep="\\t") for row in manifest.itertuples()]
pd.concat(tables).to_parquet("results/taxon-abundance.parquet")
Path("results/metagenome-report.html").write_text("<html>report</html>")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/metagenome-manifest.csv'],
    writes: [join('results', 'metagenome-report.html'), 'results/taxon-abundance.parquet'].sort(),
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures multimodal h5mu integration and export', async () => {
  const source = `import muon as mu
import pandas as pd
multi = mu.read_h5mu("inputs/multiome.h5mu")
clinical = pd.read_csv("inputs/cell-clinical.csv")
multi.obs = multi.obs.join(clinical.set_index("cell_id"), on="cell_id")
multi.mod["rna"].write_h5ad("results/rna-annotated.h5ad")
multi.mod["atac"].write_h5ad("results/atac-annotated.h5ad")
multi.write_h5mu("results/integrated.h5mu")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/cell-clinical.csv', 'inputs/multiome.h5mu'],
    writes: ['results/atac-annotated.h5ad', 'results/rna-annotated.h5ad'],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures methylation normalization and differential report outputs', async () => {
  const source = `library(minfi)
library(limma)
targets <- read.csv("inputs/idat-sample-sheet.csv")
rg <- read.metharray.exp(targets = targets)
mset <- preprocessNoob(rg)
beta <- getBeta(mset)
design <- model.matrix(~ targets$condition)
fit <- eBayes(lmFit(beta, design))
dmr <- topTable(fit, number = Inf)
write.csv(dmr, "results/differential-methylation.csv")
saveRDS(mset, "results/normalized-methylation.rds")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/idat-sample-sheet.csv'],
    writes: ['results/differential-methylation.csv', 'results/normalized-methylation.rds'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a VCF annotation and cohort burden workflow', async () => {
  const source = `from pathlib import Path
import pandas as pd
import subprocess
from cyvcf2 import VCF
manifest = pd.read_csv("inputs/variant-manifest.csv")
rows = []
for sample in manifest.itertuples():
    subprocess.run(["variant-annotator", sample.vcf, "--reference", "inputs/reference.fa", "--output", f"work/{sample.sample}.annotated.vcf.gz"], check=True)
    for variant in VCF(f"work/{sample.sample}.annotated.vcf.gz"):
        rows.append({"sample": sample.sample, "gene": variant.INFO.get("GENE"), "impact": variant.INFO.get("IMPACT")})
burden = pd.DataFrame(rows).groupby(["sample", "gene"]).size().reset_index(name="count")
burden.to_parquet("results/gene-burden.parquet")
Path("results/variant-qc.json").write_text("{}")`
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access.writes).toEqual(['results/gene-burden.parquet', join('results', 'variant-qc.json')])
  expect(access.reads).toContain('inputs/variant-manifest.csv')
  expect(access.externalState).toBe('partial')
})

it('captures an R proteomics quantification and pathway workflow', async () => {
  const source = `library(MSnbase)
library(xcms)
library(limma)
metadata <- read.csv("inputs/proteomics-samples.csv")
raw <- readMSData(metadata$file, mode = "onDisk")
peaks <- findChromPeaks(raw, param = CentWaveParam())
aligned <- adjustRtime(peaks, param = ObiwarpParam())
features <- featureValues(aligned, value = "into")
design <- model.matrix(~ metadata$condition)
fit <- eBayes(lmFit(log2(features + 1), design))
hits <- topTable(fit, number = Inf)
write.csv(hits, "results/differential-proteins.csv")
saveRDS(aligned, "results/aligned-features.rds")
writeLines(capture.output(sessionInfo()), "results/proteomics-session.txt")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/proteomics-samples.csv'],
    writes: [
      'results/aligned-features.rds',
      'results/differential-proteins.csv',
      'results/proteomics-session.txt'
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a phyloseq microbiome differential abundance workflow', async () => {
  const source = `library(phyloseq)
library(DESeq2)
counts <- read.csv("inputs/otu-counts.csv", row.names = 1)
taxonomy <- read.csv("inputs/taxonomy.csv", row.names = 1)
clinical <- read.csv("inputs/microbiome-clinical.csv")
ps <- phyloseq(otu_table(as.matrix(counts), taxa_are_rows = TRUE), tax_table(as.matrix(taxonomy)), sample_data(clinical))
dds <- phyloseq_to_deseq2(ps, ~ treatment + batch)
dds <- DESeq(dds)
results <- as.data.frame(results(dds, contrast = c("treatment", "case", "control")))
write.csv(results, "results/differential-taxa.csv")
saveRDS(ps, "results/phyloseq-object.rds")
writeLines(capture.output(plot_richness(ps)), "results/richness-report.txt")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/microbiome-clinical.csv', 'inputs/otu-counts.csv', 'inputs/taxonomy.csv'],
    writes: [
      'results/differential-taxa.csv',
      'results/phyloseq-object.rds',
      'results/richness-report.txt'
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a radiomics cohort preprocessing and survival model workflow', async () => {
  const source = `from pathlib import Path
import pandas as pd
import SimpleITK as sitk
from radiomics import featureextractor
from lifelines import CoxPHFitter
manifest = pd.read_csv("inputs/radiomics-manifest.csv")
features = []
extractor = featureextractor.RadiomicsFeatureExtractor("inputs/radiomics.yaml")
for row in manifest.itertuples():
    image = sitk.ReadImage(row.image)
    mask = sitk.ReadImage(row.mask)
    values = extractor.execute(image, mask)
    features.append({"patient_id": row.patient_id, **values})
frame = pd.DataFrame(features).merge(pd.read_csv("inputs/outcomes.csv"), on="patient_id")
frame.to_parquet("results/radiomics-features.parquet")
CoxPHFitter().fit(frame, duration_col="time", event_col="event").print_summary()
Path("results/radiomics-report.html").write_text("<html>report</html>")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/outcomes.csv', 'inputs/radiomics-manifest.csv', 'inputs/radiomics.yaml'],
    writes: ['results/radiomics-features.parquet', join('results', 'radiomics-report.html')],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures an RNA velocity multi-stage export workflow', async () => {
  const source = `import scanpy as sc
import scvelo as scv
import pandas as pd
adata = scv.read("inputs/spliced-unspliced.loom", cache=True)
metadata = pd.read_csv("inputs/cell-metadata.csv")
adata.obs = adata.obs.join(metadata.set_index("cell_id"), on="cell_id")
sc.pp.filter_and_normalize(adata, min_shared_counts=20)
scv.pp.moments(adata, n_pcs=30, n_neighbors=30)
scv.tl.velocity(adata, mode="dynamical")
scv.tl.velocity_graph(adata)
scv.pl.velocity_embedding_stream(adata, basis="umap", save="-velocity.pdf")
adata.write("results/velocity.h5ad")
adata.obs.to_csv("results/velocity-cell-metadata.csv")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/cell-metadata.csv'],
    writes: ['results/velocity-cell-metadata.csv'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('retains known paths without certifying a readonly SQLite ecology workflow as complete', async () => {
  const source = String.raw`from pathlib import Path
import csv
import json
import sqlite3
import statistics

database_path = Path("inputs/field_observations.sqlite")
output_directory = Path("outputs")
json_path = output_directory / "species_summary.json"
csv_path = output_directory / "species_summary.csv"

summaries = {}
connection = sqlite3.connect(
    "file:inputs/field_observations.sqlite?mode=ro",
    uri=True,
)
try:
    rows = connection.execute("SELECT species, site, count FROM observations")
    for species, site, count in rows:
        if species is None or not str(species).strip():
            raise ValueError("species must be nonempty")
        if count is None:
            raise ValueError("count must be nonnegative")
        try:
            if count < 0 or count != count:
                raise ValueError("count must be nonnegative")
        except TypeError as error:
            raise ValueError("count must be numeric and nonnegative") from error
        species_name = str(species).strip()
        site_name = "" if site is None else str(site)
        if species_name not in summaries:
            summaries[species_name] = {
                "species": species_name,
                "total_count": 0,
                "observation_count": 0,
                "mean_count": 0,
                "median_count": 0,
                "sites": set(),
                "_counts": [],
            }
        summary = summaries[species_name]
        summary["total_count"] += count
        summary["observation_count"] += 1
        summary["_counts"].append(count)
        summary["sites"].add(site_name)
finally:
    connection.close()

species_summary = []
for species_name in sorted(summaries):
    summary = summaries[species_name]
    counts = summary.pop("_counts")
    summary["mean_count"] = statistics.mean(counts)
    summary["median_count"] = statistics.median(counts)
    summary["sites"] = sorted(summary["sites"])
    species_summary.append(summary)

output_directory.mkdir(parents=True, exist_ok=True)
with json_path.open("w", encoding="utf-8") as json_file:
    json.dump(species_summary, json_file, ensure_ascii=False, indent=2, sort_keys=True)
    json_file.write("\n")
with csv_path.open("w", encoding="utf-8", newline="") as csv_file:
    writer = csv.DictWriter(csv_file, fieldnames=["species", "total_count", "observation_count", "mean_count", "median_count", "sites"])
    writer.writeheader()
    for summary in species_summary:
        row = dict(summary)
        row["sites"] = json.dumps(row["sites"], ensure_ascii=False, separators=(",", ":"))
        writer.writerow(row)`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/field_observations.sqlite'],
    writes: [
      analyzedPythonPath('outputs/species_summary.csv'),
      analyzedPythonPath('outputs/species_summary.json')
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
    reasonCodes: ['dynamic-path-unresolved', 'source-analysis-unsupported-call']
  })
})

it('keeps writable or dynamic SQLite access conservative', async () => {
  const source = String.raw`import sqlite3
connection = sqlite3.connect("inputs/field_observations.sqlite")
table = get_table_name()
rows = connection.execute("SELECT * FROM " + table)
connection.close()`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/field_observations.sqlite'],
    writes: ['inputs/field_observations.sqlite'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining([
      'source-analysis-unsupported-call',
      'dynamic-path-unresolved'
    ])
  })
})
