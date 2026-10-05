import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store, validateDraft } from './lib/core.mjs';
import { discover } from './lib/discovery.mjs';
import * as writer from './lib/rime-writer.mjs';
import { exportRecords, parseImport, previewImport, commitImport, recoverRecords } from './lib/transfer.mjs';
import { processAlive, readOptional, writeJson } from './lib/durable.mjs';
import { listRecordBackups, restoreRecordBackup } from './lib/record-backups.mjs';

const defaultRoot=path.dirname(fileURLToPath(import.meta.url));
const equalDir=(a,b)=>!!a&&!!b&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const messages={
 RECORD_LIMIT:'本地记录上限为10000条（含待删除项），请先同步删除或减少导入数量',
 INVALID_DRAFT:'请选择常用词或快捷短语',INVALID_TEXT:'内容须为不超过500字的单行文本',INVALID_CODE:'编码须为小写字母，可含空格或拼音分隔符',INVALID_SCHEMA:'请选择有效方案；原有失效方案可保留，但写入前需要处理',INVALID_ORDER:'排序必须为1–999，同编码候选可能已满',INVALID_ID:'记录编号无效',NOT_FOUND:'记录不存在或状态已改变',DUPLICATE:'相同记录已存在',
 RIME_NOT_READY:'未确认可用的输入法，请在更新完成后重新检测',NO_DRAFTS:'没有需要同步的记录或受管文件',UNKNOWN_SCHEMA:'记录含有已停用的方案，请修改适用方案后再同步',DEPLOYER_NOT_FOUND:'未找到部署程序，请等待更新完成并重新检测',WRITE_BUSY:'正在执行其他操作，请稍后重试',
 CONFIG_CONFLICT:'此方案已有其他自定义配置，已停止覆盖',TARGET_CONFLICT:'目标文件不是可安全覆盖的受管文件',EXTERNAL_CHANGE:'配置被外部修改，已保留现场，请核对后处理',MANIFEST_INVALID:'管理清单损坏，已停止写入',DEPLOY_VERIFY_FAILED:'输入法配置验证失败，请检查恢复提示',
 BACKUP_INVALID:'备份清单无效',BACKUP_UNVERIFIED:'旧备份缺少校验值，不能自动恢复',BACKUP_DAMAGED:'备份校验失败，已停止恢复',BACKUP_PROTECTED:'此备份用于未完成操作，暂不能删除',RECOVERY_REQUIRED:'上次操作未完成，请先恢复到操作前',RECOVERY_INVALID:'操作记录损坏或缺失，请保留备份并人工检查',
 TARGET_CHANGED:'用户目录已变化，请先确认新的目标；历史恢复只允许回到原目录',
 IMPORT_INVALID:'请选择本工具导出的记录 JSON 文件（最多10000条）',IMPORT_UNRESOLVED:'请逐项处理差异后确认合并',IMPORT_STALE:'本地记录或输入方案已变化，请重新预览',IMPORT_CONFLICT:'导入项之间存在重复或相互覆盖，请保留其中一项后再确认',BODY_TOO_LARGE:'文件或请求过大（导入上限5MB）'
};
const mime={'.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json; charset=utf-8'};
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req,limit=8192){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('BODY_TOO_LARGE');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}

export async function createToolbox({root=defaultRoot,dataDir=path.join(root,'.local-data'),discoverFn=discover,operations={},staticMode=true,port=43187}={}){
  await fs.mkdir(dataDir,{recursive:true});
  const instanceFile=path.join(dataDir,'server.lock');
  const old=await readOptional(instanceFile);
  if(old){let owner;try{owner=JSON.parse(old);}catch{throw Error('INSTANCE_LOCK_INVALID');}if(processAlive(owner.pid))throw Error('INSTANCE_RUNNING');await fs.unlink(instanceFile);}
  const instance=await fs.open(instanceFile,'wx');
  await instance.writeFile(JSON.stringify({pid:process.pid}));await instance.close();
  const store=new Store(path.join(dataDir,'toolbox.sqlite'));
  const backupRoot=path.join(dataDir,'backups');
  const recordBackupRoot=path.join(dataDir,'record-backups');
  const ops={...writer,...operations};
  let detection=await discoverFn();
  if(!store.getSetting('userDir')&&detection.state==='detected')store.setSetting('userDir',detection.userDir);
  let busy=false;let preview=null;
  const token=randomBytes(32).toString('hex');
  const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
  const vite=staticMode?null:await import('vite').then(({createServer})=>createServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'}));
  const state=async()=>({
    detection,drafts:store.drafts(),events:store.events(),version,busy,revision:store.revision(),
    recovery:busy?{state:'busy',blocked:true}:await ops.inspectRecovery(backupRoot,detection.userDir),
    targetChanged:detection.state==='detected'&&!equalDir(store.getSetting('userDir'),detection.userDir),
    acceptedUserDir:store.getSetting('userDir'),readOnlyRime:false,writeFeature:'fixed_phrase'
  });
  async function refresh(){detection=await discoverFn();store.event({code:detection.state==='detected'?'DISCOVERY_OK':'DISCOVERY_FAILED',count:detection.schemas.length});}
  async function requireTarget(){
    await refresh();
    if(detection.state!=='detected')throw Error('RIME_NOT_READY');
    if(!equalDir(store.getSetting('userDir'),detection.userDir))throw Error('TARGET_CHANGED');
  }
  async function loggedRestore(action,prefix='RESTORE'){
    const operationId=randomUUID();const started=Date.now();
    store.event({code:prefix+'_STARTED',operationId});
    try{
      const result=await action();
      store.event({code:prefix+'_COMPLETED',operationId,details:{durationMs:Date.now()-started,backupId:result.safetyBackupId,sourceBackupId:result.backupId}});
      return result;
    }catch(e){store.event({code:prefix+'_FAILED',operationId,details:{durationMs:Date.now()-started,errorCode:e.message}});throw e;}
  }
  async function mutable(action,{recovery=false,allowBlocked=false}={}){
    if(busy)throw Error('WRITE_BUSY');
    busy=true;
    try{
      if(!recovery&&!allowBlocked){const status=await ops.inspectRecovery(backupRoot,detection.userDir);if(status.blocked)throw Error(status.state==='busy'?'WRITE_BUSY':'RECOVERY_REQUIRED');}
      return await action();
    }finally{busy=false;}
  }
  const server=http.createServer(async(req,res)=>{
    const address=server.address();const host='127.0.0.1:'+address.port;
    try{
      if(req.headers.host!==host){reply(res,403,{error:'HOST_DENIED'});return;}
      const url=new URL(req.url,'http://'+host);
      if(url.pathname.startsWith('/api/')){
        if(req.headers['x-toolbox-token']!==token){reply(res,403,{error:'TOKEN_REQUIRED'});return;}
        if(req.headers.origin&&req.headers.origin!=='http://'+host){reply(res,403,{error:'ORIGIN_DENIED'});return;}
        if(req.method==='GET'){
          if(url.pathname==='/api/record-backups'){reply(res,200,{backups:await listRecordBackups(recordBackupRoot),revision:store.revision()});return;}
          if(url.pathname==='/api/state'){reply(res,200,await state());return;}
          if(url.pathname==='/api/logs/export'){reply(res,200,{app:'Weasel Toolbox',version,events:store.events(true)});return;}
          if(url.pathname==='/api/records/export'){
            const kind=url.searchParams.get('kind');if(kind&&!['word','phrase'].includes(kind))throw Error('INVALID_DRAFT');
            reply(res,200,exportRecords(store,kind));return;
          }
          if(url.pathname==='/api/backups'){const backups=await ops.listBackups(backupRoot);reply(res,200,{backups,totalBytes:backups.reduce((n,b)=>n+b.sizeBytes,0),policy:{keepDeploy:20,keepSafety:5}});return;}
        }
        if(req.method==='POST'&&url.pathname==='/api/refresh'){await mutable(refresh,{allowBlocked:true});reply(res,200,{ok:true});return;}
        if(req.method==='POST'&&url.pathname==='/api/records/export'){
          const result=await mutable(async()=>{
            const {kind}=await body(req);if(kind&&!['word','phrase'].includes(kind))throw Error('INVALID_DRAFT');
            const exported=exportRecords(store,kind);const dir=path.join(dataDir,'exports');await fs.mkdir(dir,{recursive:true});
            const file=path.join(dir,(kind||'all')+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.json');
            await writeJson(file,exported);return {ok:true,path:file,count:exported.records.length};
          },{allowBlocked:true});reply(res,200,result);return;
        }
        if(req.method==='POST'&&url.pathname==='/api/target/confirm'){
          await mutable(async()=>{
            const value=await body(req);await refresh();if(detection.state!=='detected'||!equalDir(value.userDir,detection.userDir))throw Error('TARGET_CHANGED');
            store.setSetting('userDir',detection.userDir);store.markAllPending();preview=null;
          });reply(res,200,{ok:true});return;
        }
        if(req.method==='POST'&&url.pathname==='/api/recovery'){
          await mutable(()=>loggedRestore(async()=>{await requireTarget();return ops.recoverInterrupted({detection,backupRoot,store});}),{recovery:true});
          reply(res,200,{ok:true});return;
        }
        if(req.method==='POST'&&url.pathname==='/api/record-backups/restore'){
          const result=await mutable(()=>loggedRestore(async()=>{
            const input=await body(req);
            const restored=await restoreRecordBackup({store,backupDir:recordBackupRoot,id:input.id,revision:input.revision});preview=null;return restored;
          },'RECORDS_RESTORE'));
          reply(res,200,result);return;
        }
        if(req.method==='POST'&&url.pathname==='/api/import/preview'){
          const result=await mutable(async()=>{
            const input=await body(req,5*1024*1024);await refresh();
            const records=parseImport(input);
            preview={id:randomUUID(),revision:store.revision(),schemas:detection.schemas.map(s=>s.id).sort(),expires:Date.now()+15*60*1000,rows:previewImport(records,store.drafts(),detection.schemas.map(s=>s.id))};
            return preview;
          });reply(res,200,result);return;
        }
        if(req.method==='POST'&&url.pathname==='/api/records/recover-preview'){
          const result=await mutable(async()=>{
            await requireTarget();
            const found=await recoverRecords(detection.userDir);
            preview={id:randomUUID(),revision:store.revision(),schemas:detection.schemas.map(s=>s.id).sort(),expires:Date.now()+15*60*1000,rows:previewImport(found.records,store.drafts(),detection.schemas.map(s=>s.id)),warnings:found.warnings,source:'recovery'};
            return preview;
          });reply(res,200,result);return;
        }
        if(req.method==='POST'&&url.pathname==='/api/import/commit'){
          const result=await mutable(async()=>{
            const input=await body(req,5*1024*1024);await refresh();
            if(!preview||input.id!==preview.id||Date.now()>preview.expires||JSON.stringify(preview.schemas)!==JSON.stringify(detection.schemas.map(s=>s.id).sort()))throw Error('IMPORT_STALE');
            const result=await commitImport({store,preview:preview.rows,decisions:input.decisions,revision:preview.revision,backupDir:path.join(dataDir,'record-backups')});preview=null;return result;
          });reply(res,200,result);return;
        }
        if((req.method==='POST'&&url.pathname==='/api/drafts')||(req.method==='PUT'&&/^\/api\/drafts\/[^/]+$/.test(url.pathname))){
          await mutable(async()=>{
            const input=await body(req);const id=url.pathname.split('/').pop();const old=req.method==='PUT'?store.drafts().find(d=>d.id===id):null;
            const schemas=[...new Set([...detection.schemas.map(s=>s.id),...(old?.schemaIds||[])])];
            const draft=validateDraft(input,schemas);
            if(old)store.update(id,draft);else if(req.method==='PUT')throw Error('NOT_FOUND');else store.add(draft);
          });reply(res,req.method==='POST'?201:200,{ok:true});return;
        }
        if(req.method==='DELETE'&&/^\/api\/drafts\/[^/]+$/.test(url.pathname)){
          await mutable(()=>store.remove(url.pathname.split('/').pop()));reply(res,200,{ok:true});return;
        }
        if(req.method==='POST'&&/^\/api\/drafts\/[^/]+\/undelete$/.test(url.pathname)){
          await mutable(()=>store.restoreDeleted(url.pathname.split('/')[3]));reply(res,200,{ok:true});return;
        }
        if(req.method==='POST'&&url.pathname==='/api/deploy-drafts'){
          const result=await mutable(async()=>{
            await requireTarget();const all=store.drafts();const active=all.filter(d=>d.status!=='delete_pending');
            const operationId=randomUUID();const started=Date.now();
            const details={added:all.filter(d=>d.status==='draft').length,modified:all.filter(d=>d.status==='modified').length,deleted:all.filter(d=>d.status==='delete_pending').length};
            store.event({code:'DEPLOY_STARTED',operationId,count:all.length,details});
            try{
              const result=await ops.deployDrafts({detection,drafts:active,backupRoot,store});
              store.event({code:'DEPLOY_COMPLETED',operationId,count:result.draftCount,details:{...details,backupId:result.backupId,durationMs:Date.now()-started}});return result;
            }catch(e){store.event({code:'DEPLOY_FAILED',operationId,details:{errorCode:e.message}});throw e;}
          });reply(res,200,result);return;
        }
        const backupMatch=url.pathname.match(/^\/api\/backups\/([^/]+)(?:\/(restore|pin))?$/);
        if(backupMatch){
          const [,id,action]=backupMatch;let result;
          if(req.method==='POST'&&action==='restore')result=await mutable(()=>loggedRestore(async()=>{
            await requireTarget();return ops.restoreManagedBackup({detection,backupRoot,backupId:id,store});
          }));
          else if(req.method==='POST'&&action==='pin')result=await mutable(async()=>ops.setBackupPinned(backupRoot,id,Boolean((await body(req)).pinned)));
          else if(req.method==='DELETE'&&!action)result=await mutable(()=>ops.deleteBackup(backupRoot,id));
          if(result){reply(res,200,result);return;}
        }
        reply(res,404,{error:'NOT_FOUND'});return;
      }
      if(url.pathname==='/'){
        let html=await fs.readFile(path.join(root,staticMode?'dist/index.html':'index.html'),'utf8');html=html.replace('__TOKEN__',token);if(vite)html=await vite.transformIndexHtml(req.url,html);
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY'});res.end(html);return;
      }
      if(vite){vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});return;}
      let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end();return;}
      const distRoot=path.join(root,'dist');const target=path.resolve(distRoot,decoded.replace(/^\/+/,''));
      if(!target.startsWith(distRoot+path.sep)||decoded.includes(':')||decoded.includes('\\')){res.writeHead(404);res.end();return;}
      try{const content=await fs.readFile(target);res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(content);}catch{res.writeHead(404);res.end();}
    }catch(e){
      if(!res.headersSent)reply(res,['WRITE_BUSY','RECOVERY_REQUIRED','IMPORT_STALE','TARGET_CHANGED'].includes(e.message)?409:e.message==='BODY_TOO_LARGE'?413:400,{error:messages[e.message]||'操作未完成，请检查输入或日志',code:messages[e.message]?e.message:'INVALID_REQUEST'});
      else res.destroy();
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);}).catch(async e=>{await vite?.close();store.close();await fs.unlink(instanceFile);throw e;});
  return {server,store,token,port:server.address().port,async close(){
    if(busy)throw Error('WRITE_BUSY');
    await vite?.close();await new Promise(resolve=>server.close(resolve));store.close();await fs.unlink(instanceFile);
  }};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createToolbox({staticMode:process.env.TOOLBOX_STATIC==='1',port:Number(process.env.TOOLBOX_PORT||43187),dataDir:process.env.TOOLBOX_DATA_DIR||path.join(defaultRoot,'.local-data')});
  console.log('Toolbox ready: http://127.0.0.1:'+app.port);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{try{await app.close();process.exit(0);}catch{console.log('正在完成写入，请稍后退出。');}});
}
