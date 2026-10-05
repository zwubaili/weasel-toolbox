import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const hash = content => createHash('sha256').update(content).digest('hex');
export async function readOptional(file) {
  try { return await fs.readFile(file); } catch(e) { if(e.code==='ENOENT')return null;throw e; }
}
export async function atomicWrite(file, content) {
  const temp=`${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle=await fs.open(temp,'wx');
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();handle=null;
    await fs.rename(temp,file);
    // Directory fsync is available on POSIX; Windows may reject directory handles.
    let dir;
    try {dir=await fs.open(path.dirname(file),'r');await dir.sync();}
    catch(e){if(!['EPERM','EISDIR','EINVAL','ENOTSUP','EACCES'].includes(e.code))throw e;}
    finally {await dir?.close();}
  } finally {
    await handle?.close();
    await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
}
export const writeJson=(file,value)=>atomicWrite(file,JSON.stringify(value,null,2));
export function processAlive(pid) {
  if(!Number.isSafeInteger(pid)||pid<1)return false;
  try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}
}
