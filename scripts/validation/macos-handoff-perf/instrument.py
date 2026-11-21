"""Add scoped loopback instrumentation to the pinned signed timing probe."""
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
source = path.read_text()
marker = "const start=Date.now();const event="
assert source.count(marker) == 1
instrument = """
const started=Date.now();
const record=(event, extra={})=>fs.appendFileSync(${JSON.stringify(join(dir,'stream.jsonl'))},JSON.stringify({event,ms:Date.now()-started,...extra})+'\\\\n');
const original=fs.createReadStream;
const mode=${JSON.stringify(process.env.MODE)};
fs.createReadStream=function(path,options){
  if(typeof path!=='string'||!path.endsWith('.zip')||!path.includes('/pending/'))return original.call(this,path,options);
  const stream=original.call(this,path,mode==='large'?{...options,highWaterMark:1048576}:options);
  record('stream-start',{chunk:stream.readableHighWaterMark,size:fs.statSync(path).size});
  stream.once('end',()=>record('stream-end'));
  return stream;
};
const start=Date.now();const event=
"""
path.write_text(source.replace(marker, instrument).replace(
    "return {event,ms:Date.now()-start}", "fs.createReadStream=original;return {event,ms:Date.now()-start}"
))
