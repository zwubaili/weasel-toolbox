import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateDraft, draftHash } from './core.mjs';
import { hash, readOptional, writeJson } from './durable.mjs';
import { marker, readManagedManifest } from './rime-writer.mjs';
import { saveRecordBackup, pruneRecordBackups } from './record-backups.mjs';

export function exportRecords(store,kind) {
  return {format:'weasel-toolbox-records',version:1,exportedAt:new Date().toISOString(),records:store.activeDrafts().filter(d=>!kind||d.kind===kind).map(d=>validateDraft(d))};
}
export function parseImport(value) {
  if(value?.format!=='weasel-toolbox-records'||value.version!==1||!Array.isArray(value.records)||value.records.length>10000)throw Error('IMPORT_INVALID');
  return value.records;
}
const overlaps=(a,b)=>a.schemaIds.some(s=>b.schemaIds.includes(s));
const identical=(a,b)=>draftHash(a)===draftHash(b);
const sameEntry=(a,b)=>a.text===b.text&&a.code===b.code;
export function previewImport(input,local,schemas) {
  const seen=new Set();
  return input.map((raw,index)=>{
    let record;
    try{record=validateDraft(raw);}catch{return {index,state:'invalid',reason:'格式无效，跳过此项',choices:['skip']};}
    const key=draftHash(record);
    if(seen.has(key))return {index,record,state:'duplicate',reason:'文件内重复',choices:['skip']};
    seen.add(key);
    if(record.schemaIds.some(s=>!schemas.includes(s)))return {index,record,state:'invalid',reason:'包含本机不可用方案，暂不导入',choices:['skip']};
    if(local.some(d=>d.status==='delete_pending'&&sameEntry(d,record)&&overlaps(d,record)))return {index,record,state:'invalid',reason:'本地同项正在等待删除，请先处理待删除记录',choices:['skip']};
    const active=local.filter(d=>d.status!=='delete_pending');
    if(active.some(d=>identical(d,record)))return {index,record,state:'duplicate',reason:'与本地完全相同',choices:['skip']};
    const matches=active.filter(d=>(sameEntry(d,record))||(overlaps(d,record)&&(d.code===record.code||d.text===record.text)));
    const choices=['skip'];
    if(!matches.length)choices.push('add');
    else {
      if(matches.length===1)choices.push('replace');
      if(!matches.some(d=>sameEntry(d,record)))choices.push('both');
      if(matches.length===1&&sameEntry(matches[0],record)&&matches[0].kind===record.kind)choices.push('merge');
    }
    return {index,record,state:matches.length?'conflict':'new',local:matches,reason:matches.length?'编码、内容、分类、方案或排序存在差异':'新增记录',choices};
  });
}
export function resolveImport(preview,decisions,local) {
  if(!Array.isArray(decisions)||decisions.length!==preview.length)throw Error('IMPORT_UNRESOLVED');
  const records=local.filter(d=>d.status!=='delete_pending').map(d=>({...d}));
  let added=0,modified=0;
  for(const row of preview){
    const decision=decisions[row.index];const action=decision?.action;
    if(!row.choices.includes(action))throw Error('IMPORT_UNRESOLVED');
    if(action==='skip')continue;
    const incoming={...row.record,kind:decision.kind||row.record.kind};validateDraft(incoming);
    if(action==='replace'||action==='merge'){
      const id=row.local[0].id;const index=records.findIndex(r=>r.id===id);if(index<0)throw Error('IMPORT_STALE');
      const old=records[index];
      const next=action==='merge'?{...old,schemaIds:[...new Set([...old.schemaIds,...incoming.schemaIds])]}:{...incoming,id};
      // Do not let multiple imported entries silently replace the same local row.
      if(old._touched)throw Error('IMPORT_CONFLICT');
      records[index]={...next,_touched:true};modified++;
    }else{
      if(records.some(d=>sameEntry(d,incoming)&&overlaps(d,incoming)))throw Error('IMPORT_CONFLICT');
      if(action==='both'){
        const max=Math.max(0,...records.filter(d=>d.code===incoming.code&&overlaps(d,incoming)).map(d=>d.order));
        if(max>=999)throw Error('INVALID_ORDER');incoming.order=max+1;
      }
      records.push(incoming);added++;
    }
  }
  for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
    if(sameEntry(records[i],records[j])&&overlaps(records[i],records[j])&&(records[i]._touched||records[j]._touched))throw Error('IMPORT_CONFLICT');
  }
  return {records,added,modified};
}
export async function commitImport({store,preview,decisions,revision,backupDir}) {
  if(store.revision()!==revision)throw Error('IMPORT_STALE');
  const result=resolveImport(preview,decisions,store.drafts());
  if(!result.added&&!result.modified)return {ok:true,added:0,modified:0};
  if(result.records.length+store.snapshot().filter(r=>r.deleted).length>10000)throw Error('RECORD_LIMIT');
  const safetyId=await saveRecordBackup(backupDir,store,'before-import');
  store.mergeRecords(result.records);
  store.event({code:'DRAFT_SAVED',count:result.added+result.modified,details:{added:result.added,modified:result.modified}});
  let cleanupWarning=false;
  try{await pruneRecordBackups(backupDir,[safetyId]);}catch{cleanupWarning=true;}
  return {ok:true,added:result.added,modified:result.modified,cleanupWarning};
}

export async function recoverRecords(userDir) {
  if(!path.isAbsolute(userDir||''))throw Error('RIME_NOT_READY');
  let manifest;const warnings=[];
  try{manifest=await readManagedManifest(userDir);}catch{manifest={files:{}};warnings.push('管理清单不可读，将尝试按旧格式找回。');}
  const entries=await fs.readdir(userDir,{withFileTypes:true});const merged=new Map();
  for(const entry of entries){
    const m=entry.name.match(/^weasel_toolbox_([a-zA-Z0-9_-]+)\.txt$/);if(!m||!entry.isFile()||entry.isSymbolicLink())continue;
    const id=m[1];const file=path.join(userDir,entry.name);const stat=await fs.stat(file);
    if(stat.size>10*1024*1024){warnings.push(entry.name+' 过大，已跳过');continue;}
    const bytes=await fs.readFile(file);const content=bytes.toString('utf8');
    const config=await readOptional(path.join(userDir,id+'.custom.yaml'));
    const verified=manifest.files[entry.name]===hash(bytes);
    if(!verified&&!(config?.toString('utf8').startsWith(marker)&&content.startsWith('# Rime table\n')&&content.includes('#@/db_name\tweasel_toolbox_'+id+'.txt')))continue;
    const metadata=verified&&Array.isArray(manifest.records)?manifest.records:[];
    for(const line of content.split(/\r?\n/)){
      if(!line||line.startsWith('#'))continue;
      const [text,code,weight,...rest]=line.split('\t');
      const match=metadata.find(r=>r.text===text&&r.code===code&&r.schemaIds?.includes(id));
      const draft={kind:match?.kind||'phrase',text,code,order:10000-Number(weight),schemaIds:[id]};
      try {if(rest.length)throw Error();validateDraft(draft);}catch{warnings.push(entry.name+' 有无效行，已跳过');continue;}
      const key=JSON.stringify([draft.kind,text,code,draft.order]);
      if(merged.has(key))merged.get(key).schemaIds.push(id);else merged.set(key,draft);
      if(!match&&!warnings.includes('旧记录无法确定分类，默认归为快捷短语，可在校对时调整。'))warnings.push('旧记录无法确定分类，默认归为快捷短语，可在校对时调整。');
    }
  }
  return {records:[...merged.values()],warnings:[...new Set(warnings)]};
}
