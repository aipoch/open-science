/** Portable, standard-library-only entry point for explicitly requested conditional restores. */
export const conditionalRestoreScript = String.raw`#!/usr/bin/env python3
import argparse, hashlib, json, os, pathlib, re, subprocess, sys

def run(argv, env=None):
    return subprocess.run(argv, check=True, text=True, stdout=subprocess.PIPE, env=env).stdout

def architecture(value):
    return {'x86_64':'x64', 'amd64':'x64', 'aarch64':'arm64'}.get(value.lower(), value.lower())

def versions_match(language, left, right):
    if left == right:
        return True
    if language == 'r':
        return re.sub(r'[-_]', '.', left) == re.sub(r'[-_]', '.', right)
    if not all(re.fullmatch(r'\d+(?:\.\d+)*', value) for value in (left, right)):
        return False
    return re.sub(r'(?:\.0)+$', '', left) == re.sub(r'(?:\.0)+$', '', right)

parser = argparse.ArgumentParser(description='Restore packages using a matching user-supplied interpreter; does not recreate the OS or interpreter.')
parser.add_argument('--interpreter', required=True)
parser.add_argument('--destination', required=True)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent
raw = (root / 'environment-lock.json').read_bytes()
manifest = json.loads((root / 'bundle-manifest.json').read_text(encoding='utf-8'))
if hashlib.sha256(raw).hexdigest() != manifest['lockChecksum']:
    raise SystemExit('Environment lock checksum mismatch.')
lock = json.loads(raw)
if lock.get('schemaVersion') != 2 or 'externalRuntime' not in lock or len(lock['components']) != 1:
    raise SystemExit('Not a supported conditional environment lock.')
component = lock['components'][0]
language = lock['kernelKind']
if component['format'] != ('renv-lock' if language == 'r' else 'pip-requirements'):
    raise SystemExit('Unsupported native package manager.')
files = {}
for file in component['files']:
    path = pathlib.PurePosixPath(file['path'])
    if path.is_absolute() or '..' in path.parts or '\\' in file['path'] or ':' in file['path']:
        raise SystemExit('Unsafe lock path.')
    physical = (root / pathlib.Path(*path.parts)).resolve(strict=True)
    if not physical.is_relative_to(root):
        raise SystemExit('Lock file resolves outside the bundle.')
    content = physical.read_bytes()
    if hashlib.sha256(content).hexdigest() != file['checksum']:
        raise SystemExit('Native lock checksum mismatch.')
    files[path.name] = physical
interpreter = str(pathlib.Path(args.interpreter).resolve(strict=True))
if language == 'r':
    probe = 'cat(jsonlite::toJSON(list(version=as.character(getRversion()),platform=if (.Platform$OS.type=="windows") "win32" else if(Sys.info()[["sysname"]]=="Darwin") "darwin" else "linux",architecture=R.version$arch,installerVersion=as.character(packageVersion("renv")),toolLibrary=dirname(find.package("renv"))),auto_unbox=TRUE))'
    identity = json.loads(run([interpreter, '--vanilla', '--slave', '-e', probe]))
else:
    probe = 'import json,sys,platform,importlib.metadata as m; print(json.dumps(dict(version=platform.python_version(),platform=sys.platform,architecture=platform.machine(),installerVersion=m.version("pip"))))'
    identity = json.loads(run([interpreter, '-I', '-c', probe]))
expected = lock['externalRuntime']
if (identity['version'] != expected['version'] or identity['installerVersion'] != expected['installerVersion'] or
    identity['platform'] != lock['platform'] or architecture(identity['architecture']) != architecture(lock['architecture'])):
    raise SystemExit('Interpreter/platform/architecture/package-manager mismatch. Nothing was installed.')
if language == 'python' and tuple(int(x) for x in re.findall(r'\d+', identity['installerVersion'])[:2]) < (22,3):
    raise SystemExit('Conditional restore requires pip 22.3 or later.')
destination = pathlib.Path(args.destination).absolute()
if destination.exists() or destination.is_symlink():
    raise SystemExit('Choose a new destination; existing environments are never overwritten.')
# Prerequisites and bundle integrity are checked before creating any destination.
destination.mkdir(parents=False)
env = os.environ.copy()
for key in list(env):
    if key.upper().startswith(('PIP_', 'PYTHON', 'RENV_')):
        env.pop(key)
env.update(PIP_CONFIG_FILE=os.devnull, PIP_DISABLE_PIP_VERSION_CHECK='1')
if language == 'r':
    for key in ['R_LIBS','R_LIBS_USER','R_LIBS_SITE','R_ENVIRON','R_ENVIRON_USER','R_PROFILE','R_PROFILE_USER']:
        env.pop(key, None)
    env.update(RENV_CONFIG_CACHE_ENABLED='FALSE', RENV_CONFIG_AUTO_SNAPSHOT='FALSE',
               RENV_PATHS_ROOT=str(destination / '.renv'), RENV_CONFIG_USER_PROFILE='FALSE')
    native = files['renv.lock']
    records = json.loads(native.read_text(encoding='utf-8'))['Packages']
    # Tool library is discovered from the explicitly supplied interpreter, never from a lock path.
    script = '.libPaths(c(' + json.dumps(str(destination)) + ',' + json.dumps(identity['toolLibrary']) + ',.Library));'
    script += 'a<-list(lockfile=' + json.dumps(str(native)) + ',library=' + json.dumps(str(destination)) + ',prompt=FALSE);'
    script += 'f<-names(formals(renv::restore)); if("strict" %in% f) a$strict<-TRUE; if("retry" %in% f) a$retry<-FALSE; do.call(renv::restore,a);'
    run([interpreter, '--vanilla', '--slave', '-e', script], env)
    names = json.dumps(json.dumps(list(records)))
    verify = script.split('a<-list')[0] + 'n<-jsonlite::fromJSON(' + names + '); cat(jsonlite::toJSON(lapply(n,function(n) {p<-find.package(n); d<-read.dcf(file.path(p,"DESCRIPTION")); list(name=n,version=unname(d[1,"Version"]),path=normalizePath(p,winslash="/"),sha=if("RemoteSha" %in% colnames(d)) unname(d[1,"RemoteSha"]) else NULL)}),auto_unbox=TRUE))'
    observed = json.loads(run([interpreter, '--vanilla', '--slave', '-e', verify], env))
    for item in observed:
        record = records[item['name']]
        if (not versions_match('r', item['version'], record['Version']) or not pathlib.Path(item['path']).resolve().is_relative_to(destination.resolve()) or
            (record.get('Source') == 'GitHub' and item.get('sha') != record.get('RemoteSha'))):
            raise SystemExit('Restored R package identity mismatch.')
else:
    run([interpreter, '-I', '-m', 'venv', '--without-pip', str(destination)], env)
    python = str(destination / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python'))
    native = files.get('requirements.lock', files.get('requirements.txt'))
    run([interpreter, '-I', '-m', 'pip', '--python', python, 'install', '--require-hashes', '-r', str(native)], env)
    normalized = '\n'.join(line.strip() for line in re.sub(r'\\\r?\n', ' ', native.read_text(encoding='utf-8')).splitlines())
    pins = dict(re.findall(r'^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==([^\s;]+)', normalized, re.M))
    if not pins:
        raise SystemExit('No pinned package identities found.')
    probe = 'import json,importlib.metadata as m; names=json.loads(' + repr(json.dumps(list(pins))) + '); print(json.dumps({n:m.version(n) for n in names}))'
    observed = json.loads(run([python, '-I', '-c', probe], env))
    if any(not versions_match('python', observed[name], version) for name, version in pins.items()):
        raise SystemExit('Restored Python package versions differ from the lock.')
print('Package restoration verified. The interpreter and OS were supplied by you; rerun and compare outputs before claiming reproducibility.')
`
