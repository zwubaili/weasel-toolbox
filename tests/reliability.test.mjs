import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/core.mjs';
import { deployDrafts, restoreManagedBackup, recoverInterrupted, inspectRecovery, listBackups, deleteBackup, manifestName } from '../lib/rime-writer.mjs';
import { previewImport, commitImport, exportRecords, recoverRecords, parseImport } from '../lib/transfer.mjs';
import { createToolbox } from '../server.mjs';
import { saveRecordBackup, restoreRecordBackup, listRecordBackups, pruneRecordBackups } from '../lib/record-backups.mjs';

test('本地快照可撤销合并并保留恢复前安全副本，损坏和过期请求不修改数据',async t=>{
  const f=await fixture(t);const backupDir=path.join(f.dataDir,'record-backups');
  const id=f.store.add(word);const source=await saveRecordBackup(backupDir,f.store,'before-import');
  f.store.update(id,{...word,text:'修改后'});f.store.add({...word,text:'新增内容',code:'new'});
  const revision=f.store.revision();
  await assert.rejects(restoreRecordBackup({store:f.store,backupDir,id:source,revision:'stale'}),/IMPORT_STALE/);
  assert.equal(f.store.revision(),revision);
  const restored=await restoreRecordBackup({store:f.store,backupDir,id:source,revision});
  assert.equal(f.store.drafts().length,1);assert.equal(f.store.drafts()[0].text,word.text);assert.equal(f.store.drafts()[0].status,'modified');
  await restoreRecordBackup({store:f.store,backupDir,id:restored.safetyId,revision:f.store.revision()});
  assert.equal(f.store.drafts().length,2);
  const file=path.join(backupDir,source);const content=JSON.parse(await fs.readFile(file,'utf8'));
  content.snapshot[0].payload=JSON.stringify({...word,text:'被篡改'});await fs.writeFile(file,JSON.stringify(content));
  const before=f.store.revision();await assert.rejects(restoreRecordBackup({store:f.store,backupDir,id:source,revision:before}),/BACKUP_DAMAGED/);
  assert.equal(f.store.revision(),before);
  await assert.rejects(restoreRecordBackup({store:f.store,backupDir,id:'../outside.json',revision:before}),/BACKUP_INVALID/);
});

test('快照保留最近20份并保护指定快照；兼容已有旧格式快照',async t=>{
  const f=await fixture(t);const dir=path.join(f.dataDir,'record-backups');f.store.add(word);
  const ids=[];for(let i=0;i<23;i++)ids.push(await saveRecordBackup(dir,f.store,'before-import'));
  const list=await listRecordBackups(dir);const protectedId=list.at(-1).id;
  await pruneRecordBackups(dir,[protectedId]);assert.equal((await listRecordBackups(dir)).length,21);assert.equal(await exists(path.join(dir,protectedId)),true);
  const old=JSON.parse(await fs.readFile(path.join(dir,protectedId),'utf8'));delete old.snapshotHash;
  await fs.writeFile(path.join(dir,protectedId),JSON.stringify(old));
  const result=await restoreRecordBackup({store:f.store,backupDir:dir,id:protectedId,revision:f.store.revision()});assert.equal(result.count,1);
});

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base=path.join(root,'artifacts','test-runs');
const word={kind:'word',text:'测试记录',code:'test',schemaIds:['pinyin'],order:1};
async function fixture(t){
  await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'reliability-'));
  const userDir=path.join(dir,'Rime');const installDir=path.join(dir,'install');const dataDir=path.join(dir,'data');const backupRoot=path.join(dataDir,'backups');
  for(const p of [userDir,installDir,dataDir])await fs.mkdir(p);
  await fs.writeFile(path.join(installDir,'WeaselDeployer.exe'),'fixture');
  const detection={state:'detected',userDir,installDir,schemas:[{id:'pinyin',name:'拼音'},{id:'wubi',name:'五笔'}],warnings:[]};
  const store=new Store(path.join(dataDir,'toolbox.sqlite'));
  const runDeployer=async()=>{
    const build=path.join(userDir,'build');await fs.mkdir(build,{recursive:true});
    for(const s of detection.schemas){
      const exists=await fs.access(path.join(userDir,s.id+'.custom.yaml')).then(()=>true,()=>false);
      await fs.writeFile(path.join(build,s.id+'.schema.yaml'),exists?'engine:\n  translators: [table_translator@weasel_toolbox_phrase]\nweasel_toolbox_phrase:\n  user_dict: weasel_toolbox_'+s.id+'\n':'engine: {}\n');
    }
  };
  const cleanup=[];
  t.after(async()=>{for(const fn of cleanup)await fn();store.close();assert.ok(dir.startsWith(base+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  return {dir,userDir,installDir,dataDir,backupRoot,detection,store,runDeployer,cleanup};
}
const crashAt=stage=>async current=>{if(current===stage){const e=Error('POWER_LOSS');e.simulatedPowerLoss=true;throw e;}};
const exists=p=>fs.access(p).then(()=>true,()=>false);

test('合并容量包含待删除项，超限不写快照或数据',async t=>{
  const f=await fixture(t);let written=false;
  const store={revision:()=> 'same',drafts:()=>[],snapshot:()=>Array.from({length:10000},()=>({deleted:1})),mergeRecords:()=>{written=true;}};
  await assert.rejects(commitImport({store,preview:previewImport([word],[],['pinyin']),decisions:[{action:'add'}],revision:'same',backupDir:path.join(f.dir,'should-not-exist')}),/RECORD_LIMIT/);
  assert.equal(written,false);assert.equal(await exists(path.join(f.dir,'should-not-exist')),false);
});

test('恢复API记录开始及失败，快照恢复有完整日志且不调用部署',async t=>{
  const f=await fixture(t);const dataDir=path.join(f.dir,'api-restore');
  const app=await createToolbox({root,dataDir,port:0,discoverFn:async()=>f.detection,operations:{restoreManagedBackup:async()=>{throw Error('BACKUP_DAMAGED');},recoverInterrupted:async()=>{throw Error('BACKUP_DAMAGED');},deployDrafts:async()=>{throw Error('UNEXPECTED_DEPLOY');}}});
  f.cleanup.push(()=>app.close());
  const call=async(url,value)=>{const r=await fetch('http://127.0.0.1:'+app.port+url,{method:value===undefined?'GET':'POST',headers:{'x-toolbox-token':app.token,'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:r.status,data:await r.json()};};
  assert.equal((await call('/api/backups/not-a-backup/restore',{})).data.code,'BACKUP_DAMAGED');
  const failure=app.store.events().find(e=>e.code==='RESTORE_FAILED');
  assert.ok(app.store.events().some(e=>e.code==='RESTORE_STARTED'&&e.operationId===failure.operationId));
  assert.equal(failure.details.errorCode,'BACKUP_DAMAGED');
  assert.equal((await call('/api/recovery',{})).data.code,'BACKUP_DAMAGED');
  app.store.add(word);const id=await saveRecordBackup(path.join(dataDir,'record-backups'),app.store,'before-import');app.store.add({...word,text:'额外条目'});
  const list=(await call('/api/record-backups')).data;
  assert.equal((await call('/api/record-backups/restore',{id,revision:list.revision})).status,200);
  assert.equal(app.store.drafts().length,1);
  assert.ok(app.store.events().some(e=>e.code==='RECORDS_RESTORE_COMPLETED'));
});

test('仅写入选择的方案，未选中的自定义配置不阻止部署',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.userDir,'wubi.custom.yaml'),'user-owned');
  f.store.add(word);await deployDrafts({...f,drafts:f.store.activeDrafts()});
  assert.equal(await fs.readFile(path.join(f.userDir,'wubi.custom.yaml'),'utf8'),'user-owned');
  assert.equal(await exists(path.join(f.userDir,'weasel_toolbox_wubi.txt')),false);
  assert.equal(f.store.drafts()[0].status,'deployed');
});
test('删除最后一条后，本地记录与旧方案文件同时清理',async t=>{
  const f=await fixture(t);const id=f.store.add(word);await deployDrafts({...f,drafts:f.store.activeDrafts()});
  f.store.remove(id);await deployDrafts({...f,drafts:f.store.activeDrafts()});
  assert.equal(f.store.drafts().length,0);assert.equal(await exists(path.join(f.userDir,'pinyin.custom.yaml')),false);assert.equal(await exists(path.join(f.userDir,'weasel_toolbox_pinyin.txt')),false);
});
test('迁移适用方案后清理旧文件，输入方案停用仍可清理',async t=>{
  const f=await fixture(t);const id=f.store.add(word);await deployDrafts({...f,drafts:f.store.activeDrafts()});
  f.store.update(id,{...word,schemaIds:['wubi']});f.detection.schemas=[{id:'wubi'}];
  await deployDrafts({...f,drafts:f.store.activeDrafts()});
  assert.equal(await exists(path.join(f.userDir,'pinyin.custom.yaml')),false);assert.equal(await exists(path.join(f.userDir,'wubi.custom.yaml')),true);
});
for(const stage of ['prepared','file-written','files-written','committing','database-committed'])test('中断可恢复：'+stage,async t=>{
  const f=await fixture(t);f.store.add(word);
  await assert.rejects(deployDrafts({...f,drafts:f.store.activeDrafts(),checkpoint:crashAt(stage)}),/POWER_LOSS/);
  assert.equal((await inspectRecovery(f.backupRoot,f.userDir)).state,'pending');
  const backups=await listBackups(f.backupRoot);assert.equal(backups[0].protected,true);
  await assert.rejects(deleteBackup(f.backupRoot,backups[0].id),/BACKUP_PROTECTED/);
  await recoverInterrupted(f);
  assert.equal((await inspectRecovery(f.backupRoot,f.userDir)).state,'clear');assert.equal(await exists(path.join(f.userDir,'pinyin.custom.yaml')),false);
  assert.equal(f.store.drafts().length,1);assert.notEqual(f.store.drafts()[0].status,'deployed');
  await deployDrafts({...f,drafts:f.store.activeDrafts()});assert.equal(f.store.drafts()[0].status,'deployed');
});
test('恢复再次中断可以重试，不丢失恢复入口',async t=>{
  const f=await fixture(t);f.store.add(word);await assert.rejects(deployDrafts({...f,drafts:f.store.activeDrafts(),checkpoint:crashAt('files-written')}));
  await assert.rejects(recoverInterrupted({...f,runDeployer:async()=>{throw Error('INTERRUPTED');}}),/INTERRUPTED/);
  assert.equal((await inspectRecovery(f.backupRoot,f.userDir)).state,'pending');
  await recoverInterrupted(f);assert.equal((await inspectRecovery(f.backupRoot,f.userDir)).blocked,false);
});
test('备份损坏与外部改动均阻止恢复，保留现场',async t=>{
  const f=await fixture(t);f.store.add(word);await deployDrafts({...f,drafts:f.store.activeDrafts()});
  f.store.update(f.store.drafts()[0].id,{...word,text:'修改'});
  await assert.rejects(deployDrafts({...f,drafts:f.store.activeDrafts(),checkpoint:crashAt('files-written')}));
  const state=await inspectRecovery(f.backupRoot,f.userDir);const manifest=JSON.parse(await fs.readFile(path.join(f.backupRoot,state.backupId,'manifest.json'),'utf8'));
  const file=manifest.files.find(x=>x.existed);const backupFile=path.join(f.backupRoot,state.backupId,file.copy);const content=await fs.readFile(backupFile);
  await fs.writeFile(backupFile,'damaged');await assert.rejects(recoverInterrupted(f),/BACKUP_DAMAGED/);await fs.writeFile(backupFile,content);
  await fs.writeFile(path.join(f.userDir,'pinyin.custom.yaml'),'external change');await assert.rejects(recoverInterrupted(f),/EXTERNAL_CHANGE/);
  assert.equal(await fs.readFile(path.join(f.userDir,'pinyin.custom.yaml'),'utf8'),'external change');
});
test('普通部署失败但回滚成功时释放锁；回滚失败时保留恢复状态',async t=>{
  const f=await fixture(t);let calls=0;f.store.add(word);
  await assert.rejects(deployDrafts({...f,drafts:f.store.activeDrafts(),runDeployer:async()=>{if(++calls===1)throw Error('FIRST_FAILED');await f.runDeployer();}}),/FIRST_FAILED/);
  assert.equal((await inspectRecovery(f.backupRoot,f.userDir)).blocked,false);
  await assert.rejects(deployDrafts({...f,drafts:f.store.activeDrafts(),runDeployer:async()=>{throw Error('ALL_FAILED');}}),/RECOVERY_REQUIRED/);
  assert.equal((await inspectRecovery(f.backupRoot,f.userDir)).state,'pending');
});
test('历史恢复包含记录，方案列表变化也能恢复并清理新增方案',async t=>{
  const f=await fixture(t);const id=f.store.add(word);await deployDrafts({...f,drafts:f.store.activeDrafts()});
  f.store.update(id,{...word,text:'第二版'});const second=await deployDrafts({...f,drafts:f.store.activeDrafts()});
  f.store.add({...word,kind:'phrase',text:'新增五笔',code:'wb',schemaIds:['wubi']});await deployDrafts({...f,drafts:f.store.activeDrafts()});
  f.detection.schemas.push({id:'new_scheme'});
  const result=await restoreManagedBackup({...f,backupId:second.backupId});assert.equal(result.hasRecords,true);
  assert.equal(f.store.drafts().length,1);assert.equal(f.store.drafts()[0].text,'第二版');assert.equal(f.store.drafts()[0].status,'modified');
  assert.equal(await exists(path.join(f.userDir,'wubi.custom.yaml')),false);
  assert.match(await fs.readFile(path.join(f.userDir,'weasel_toolbox_pinyin.txt'),'utf8'),/测试记录/);
});
test('恢复历史备份途中崩溃，重试回到恢复前记录和配置',async t=>{
  const f=await fixture(t);const id=f.store.add(word);const first=await deployDrafts({...f,drafts:f.store.activeDrafts()});
  f.store.update(id,{...word,text:'最新记录'});await deployDrafts({...f,drafts:f.store.activeDrafts()});
  await assert.rejects(restoreManagedBackup({...f,backupId:first.backupId,checkpoint:crashAt('database-committed')}));
  await recoverInterrupted(f);assert.equal(f.store.drafts()[0].text,'最新记录');assert.match(await fs.readFile(path.join(f.userDir,'weasel_toolbox_pinyin.txt'),'utf8'),/最新记录/);
});
test('新锁失效可清理，旧版本锁保留人工检查',async t=>{
  const f=await fixture(t);const lock=path.join(f.userDir,'.weasel-toolbox.lock');
  await fs.writeFile(lock,JSON.stringify({version:2,pid:2147483647}));assert.equal((await inspectRecovery(f.backupRoot,f.userDir)).blocked,false);assert.equal(await exists(lock),false);
  await fs.writeFile(lock,JSON.stringify({pid:2147483647}));assert.equal((await inspectRecovery(f.backupRoot,f.userDir)).state,'legacy');assert.equal(await exists(lock),true);
});
test('找回保留新记录分类；旧格式默认短语，并合并方案',async t=>{
  const f=await fixture(t);f.store.add({...word,schemaIds:['pinyin','wubi']});await deployDrafts({...f,drafts:f.store.activeDrafts()});
  let found=await recoverRecords(f.userDir);assert.equal(found.records.length,1);assert.equal(found.records[0].kind,'word');assert.equal(found.records[0].schemaIds.length,2);
  await fs.unlink(path.join(f.userDir,manifestName));found=await recoverRecords(f.userDir);assert.equal(found.records[0].kind,'phrase');assert.ok(found.warnings.length);
});
test('重复导入不会增加记录，合并前有完整备份，待删除项不会丢失',async t=>{
  const f=await fixture(t);const deleted=f.store.add({...word,text:'待删除'});f.store.markDeployed();f.store.remove(deleted);
  const input=[word];let rows=previewImport(input,f.store.drafts(),['pinyin']);
  await commitImport({store:f.store,preview:rows,decisions:[{action:'add'}],revision:f.store.revision(),backupDir:path.join(f.dataDir,'record-backups')});
  assert.equal(f.store.drafts().length,2);assert.equal((await fs.readdir(path.join(f.dataDir,'record-backups'))).length,1);
  rows=previewImport(input,f.store.drafts(),['pinyin']);assert.equal(rows[0].state,'duplicate');
  await commitImport({store:f.store,preview:rows,decisions:[{action:'skip'}],revision:f.store.revision(),backupDir:path.join(f.dataDir,'record-backups')});
  assert.equal(f.store.drafts().length,2);assert.equal(exportRecords(f.store).records.length,1);
});
test('校对前数据变化、冲突未处理、未知方案均不隐式覆盖',async t=>{
  const f=await fixture(t);f.store.add(word);const before=f.store.revision();
  let rows=previewImport([{...word,text:'另一条'}],f.store.drafts(),['pinyin']);assert.equal(rows[0].state,'conflict');
  await assert.rejects(commitImport({store:f.store,preview:rows,decisions:[{action:''}],revision:before,backupDir:f.backupRoot}),/IMPORT_UNRESOLVED/);
  f.store.add({...word,text:'另外',code:'other'});
  await assert.rejects(commitImport({store:f.store,preview:rows,decisions:[{action:'replace'}],revision:before,backupDir:f.backupRoot}),/IMPORT_STALE/);
  rows=previewImport([{...word,schemaIds:['missing']}],f.store.drafts(),['pinyin']);assert.equal(rows[0].state,'invalid');
  assert.throws(()=>parseImport({records:[word]}),/IMPORT_INVALID/);
});
test('同编码保留两条自动排序，分类间重复不能重复添加',async t=>{
  const f=await fixture(t);f.store.add(word);
  const rows=previewImport([{...word,text:'新内容',kind:'phrase'}],f.store.drafts(),['pinyin']);
  await commitImport({store:f.store,preview:rows,decisions:[{action:'both'}],revision:f.store.revision(),backupDir:path.join(f.dataDir,'record-backups')});
  assert.equal(f.store.drafts().find(d=>d.text==='新内容').order,2);
  assert.throws(()=>f.store.add({...word,kind:'phrase'}),/DUPLICATE/);
});

test('API互斥、目标变更确认、失效方案保留与令牌保护',{timeout:10000},async t=>{
  const f=await fixture(t);const apiData=path.join(f.dir,'api-data');let detection=f.detection;let release;let entered;
  const started=new Promise(r=>{entered=r;});const pause=new Promise(r=>{release=r;});
  const app=await createToolbox({root,dataDir:apiData,port:0,discoverFn:async()=>detection,operations:{deployDrafts:async()=>{entered();await pause;return {draftCount:1};}}});
  f.cleanup.push(async()=>{release();await new Promise(r=>setTimeout(r,30));await app.close();});
  const call=async(url,method='GET',value)=>{const r=await fetch('http://127.0.0.1:'+app.port+url,{method,headers:{'x-toolbox-token':app.token,'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:r.status,data:await r.json()};};
  assert.equal((await call('/api/drafts','POST',word)).status,201);
  const deploying=call('/api/deploy-drafts','POST');await started;
  assert.equal((await call('/api/drafts','POST',{...word,code:'other'})).status,409);
  assert.equal((await call('/api/state')).data.busy,true);release();assert.equal((await deploying).status,200);
  const id=app.store.drafts()[0].id;detection={...detection,schemas:[]};await call('/api/refresh','POST');
  assert.equal((await call('/api/drafts/'+id,'PUT',{...word,text:'仍可修改'})).status,200);
  detection={...f.detection,userDir:path.join(f.dir,'another')};await fs.mkdir(detection.userDir);await call('/api/refresh','POST');
  assert.equal((await call('/api/state')).data.targetChanged,true);assert.equal((await call('/api/deploy-drafts','POST')).data.code,'TARGET_CHANGED');
  assert.equal((await call('/api/target/confirm','POST',{userDir:detection.userDir})).status,200);assert.equal((await call('/api/state')).data.targetChanged,false);
  const unauth=await fetch('http://127.0.0.1:'+app.port+'/api/state');assert.equal(unauth.status,403);
  const badOrigin=await fetch('http://127.0.0.1:'+app.port+'/api/state',{headers:{'x-toolbox-token':app.token,Origin:'https://example.invalid'}});assert.equal(badOrigin.status,403);
});
