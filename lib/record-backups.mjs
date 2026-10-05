import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSnapshot } from './core.mjs';
import { hash, writeJson } from './durable.mjs';

const safeId=/^[0-9TZ-]+-[a-f0-9-]{36}\.json$/;
async function readSnapshot(root,id) {
  if(!safeId.test(id))throw Error('BACKUP_INVALID');
  const file=path.join(root,id);const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024*1024)throw Error('BACKUP_INVALID');
  let value;
  try {
    value=JSON.parse(await fs.readFile(file,'utf8'));
    if(!['before-import','before-record-restore'].includes(value.reason)||value.format!=='weasel-toolbox-records'||value.version!==1)throw Error();
    validateSnapshot(value.snapshot);
    if(value.snapshotHash&&value.snapshotHash!==hash(JSON.stringify(value.snapshot)))throw Error();
  }catch{throw Error('BACKUP_DAMAGED');}
  return value;
}
export async function listRecordBackups(root) {
  const names=await fs.readdir(root,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const result=[];
  for(const entry of names){
    if(!entry.isFile()||!safeId.test(entry.name))continue;
    try{const b=await readSnapshot(root,entry.name);result.push({id:entry.name,createdAt:b.exportedAt,reason:b.reason,count:b.snapshot.filter(r=>!r.deleted).length,verified:!!b.snapshotHash});}
    catch{result.push({id:entry.name,invalid:true});}
  }
  return result.sort((a,b)=>b.id.localeCompare(a.id));
}
export async function saveRecordBackup(root,store,reason) {
  await fs.mkdir(root,{recursive:true});
  const snapshot=store.snapshot();validateSnapshot(snapshot);
  const exportedAt=new Date().toISOString();const id=exportedAt.replace(/[:.]/g,'-')+'-'+randomUUID()+'.json';
  await writeJson(path.join(root,id),{format:'weasel-toolbox-records',version:1,exportedAt,reason,records:store.activeDrafts().map(d=>{const {kind,text,code,schemaIds,order}=d;return {kind,text,code,schemaIds,order};}),snapshot,snapshotHash:hash(JSON.stringify(snapshot))});
  await readSnapshot(root,id);
  return id;
}
export async function pruneRecordBackups(root,protectedIds=[]) {
  const list=(await listRecordBackups(root)).filter(b=>!b.invalid);
  const keep=new Set([...list.slice(0,20).map(b=>b.id),...protectedIds]);
  for(const b of list)if(!keep.has(b.id))await fs.unlink(path.join(root,b.id));
}
export async function restoreRecordBackup({store,backupDir,id,revision}) {
  if(revision!==store.revision())throw Error('IMPORT_STALE');
  const source=await readSnapshot(backupDir,id);
  const safetyId=await saveRecordBackup(backupDir,store,'before-record-restore');
  if(revision!==store.revision())throw Error('IMPORT_STALE');
  // SQLite transaction is all-or-nothing. Input-method files are not changed here.
  store.replaceSnapshot(source.snapshot,true);
  let cleanupWarning=false;
  try{await pruneRecordBackups(backupDir,[id,safetyId]);}catch{cleanupWarning=true;}
  return {ok:true,safetyId,cleanupWarning,count:source.snapshot.filter(r=>!r.deleted).length};
}
