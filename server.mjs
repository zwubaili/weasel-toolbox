import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { Store, validateDraft } from './lib/core.mjs';
import { discover } from './lib/discovery.mjs';
import { deleteBackup, deployDrafts, listBackups, restoreManagedBackup, setBackupPinned } from './lib/rime-writer.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.join(root,'.local-data');await fs.mkdir(dataDir,{recursive:true});
const store=new Store(path.join(dataDir,'toolbox.sqlite'));
let detection=await discover();store.event({code:'DISCOVERY_OK',count:detection.schemas.length,details:{total:detection.schemas.length,schemaIds:detection.schemas.map(item=>item.id)}});
const token=randomBytes(32).toString('hex');
const port=Number(process.env.TOOLBOX_PORT || 43187);const host=`127.0.0.1:${port}`;
const vite=await createViteServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'}).catch(()=>null);
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
const messages={INVALID_TEXT:'内容须为不超过500字的单行文本',INVALID_CODE:'编码须为小写字母，可含空格或拼音分隔符',INVALID_SCHEMA:'请选择有效输入方案',INVALID_ORDER:'排序必须为1–999',INVALID_ID:'草稿编号无效',NOT_FOUND:'记录不存在或状态已改变',DUPLICATE:'相同草稿已存在',RIME_NOT_READY:'尚未确认可写入的小狼毫目录',NO_DRAFTS:'没有需要同步的记录',UNKNOWN_SCHEMA:'草稿包含已停用或未知的输入方案',DEPLOYER_NOT_FOUND:'没有找到小狼毫部署程序',WRITE_BUSY:'另一个写入或恢复操作正在进行',CONFIG_CONFLICT:'目标方案已有自定义配置，工具不会自动覆盖',TARGET_CONFLICT:'目标短语文件已存在但不归本工具管理',EXTERNAL_CHANGE:'工具管理的配置已被外部修改，请先处理冲突',MANIFEST_INVALID:'工具写入清单损坏，已停止操作',DEPLOY_VERIFY_FAILED:'重新部署完成，但配置验证未通过',BACKUP_INVALID:'备份不存在或清单无效',BACKUP_UNVERIFIED:'旧备份缺少校验值，不能自动恢复',BACKUP_DAMAGED:'备份文件校验失败，已停止恢复',RESTORE_VERIFY_FAILED:'恢复后配置验证未通过'};
const deployErrors=new Set(['RIME_NOT_READY','NO_DRAFTS','UNKNOWN_SCHEMA','DEPLOYER_NOT_FOUND','WRITE_BUSY','CONFIG_CONFLICT','TARGET_CONFLICT','EXTERNAL_CHANGE','MANIFEST_INVALID','DEPLOY_VERIFY_FAILED']);
const restoreErrors=new Set(['BACKUP_INVALID','BACKUP_UNVERIFIED','BACKUP_DAMAGED','RESTORE_VERIFY_FAILED']);
const server=http.createServer(async(req,res)=>{
  if(req.headers.host!==host){reply(res,403,{error:'HOST_DENIED'});return;}
  const url=new URL(req.url,`http://${host}`);
  if(url.pathname.startsWith('/api/')){
    if(req.headers['x-toolbox-token']!==token){reply(res,403,{error:'TOKEN_REQUIRED'});return;}
    if(req.headers.origin && req.headers.origin!==`http://${host}`){reply(res,403,{error:'ORIGIN_DENIED'});return;}
    try{
      if(req.method==='GET' && url.pathname==='/api/state'){reply(res,200,{detection,drafts:store.drafts(),events:store.events(),version:'0.3.0 开发预览',readOnlyRime:false,writeFeature:'fixed_phrase'});return;}
      if(req.method==='POST' && url.pathname==='/api/refresh'){detection=await discover();store.event({code:'DISCOVERY_OK',count:detection.schemas.length,details:{total:detection.schemas.length,schemaIds:detection.schemas.map(item=>item.id)}});reply(res,200,{ok:true});return;}
      if(req.method==='GET' && url.pathname==='/api/logs/export'){store.event({code:'EXPORT_DONE'});reply(res,200,{app:'Weasel Toolbox',version:'0.1.0-dev',events:store.events()});return;}
      if(req.method==='GET' && url.pathname==='/api/backups'){const backups=await listBackups(path.join(dataDir,'backups'));reply(res,200,{backups,totalBytes:backups.reduce((sum,item)=>sum+item.sizeBytes,0),policy:{keepDeploy:20,keepSafety:5}});return;}
      if(req.method==='POST' && /^\/api\/backups\/[^/]+\/pin$/.test(url.pathname)){
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1024){reply(res,413,{error:'内容过大'});return;}}
        const result=await setBackupPinned(path.join(dataDir,'backups'),url.pathname.split('/')[3],Boolean(JSON.parse(body).pinned));reply(res,200,result);return;
      }
      if(req.method==='DELETE' && /^\/api\/backups\/[^/]+$/.test(url.pathname)){const result=await deleteBackup(path.join(dataDir,'backups'),url.pathname.split('/')[3]);reply(res,200,result);return;}
      if(req.method==='POST' && url.pathname==='/api/drafts'){
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>8192){reply(res,413,{error:'内容过大'});return;}}
        const draft=validateDraft(JSON.parse(body),detection.schemas.map(s=>s.id));store.add(draft);reply(res,201,{ok:true});return;
      }
      if(req.method==='PUT' && url.pathname.startsWith('/api/drafts/')){
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>8192){reply(res,413,{error:'内容过大'});return;}}
        const draft=validateDraft(JSON.parse(body),detection.schemas.map(s=>s.id));store.update(url.pathname.split('/').pop(),draft);reply(res,200,{ok:true});return;
      }
      if(req.method==='POST' && url.pathname==='/api/deploy-drafts'){
        const operationId=randomUUID();const started=Date.now();const all=store.drafts();const active=all.filter(item=>item.status!=='delete_pending');
        const details={added:all.filter(item=>item.status==='draft').length,modified:all.filter(item=>item.status==='modified').length,deleted:all.filter(item=>item.status==='delete_pending').length,total:all.length,schemaIds:[...new Set(active.flatMap(item=>item.schemaIds))]};
        store.event({code:'DEPLOY_STARTED',operationId,count:all.length,details});
        try {
          if(!all.length)throw new Error('NO_DRAFTS');detection=await discover();
          const result=await deployDrafts({detection,drafts:active,backupRoot:path.join(dataDir,'backups')});
          store.markDeployed();store.event({code:'DEPLOY_COMPLETED',operationId,count:result.draftCount,details:{...details,backupId:result.backupId,schemaIds:result.schemas,durationMs:Date.now()-started}});reply(res,200,{...result,changes:details,durationMs:Date.now()-started});return;
        } catch(e){store.event({code:'DEPLOY_FAILED',operationId,count:all.length,details:{...details,errorCode:e.message,durationMs:Date.now()-started}});e.eventLogged=true;throw e;}
      }
      if(req.method==='POST' && /^\/api\/backups\/[^/]+\/restore$/.test(url.pathname)){
        const backupId=url.pathname.split('/')[3];const operationId=randomUUID();const started=Date.now();store.event({code:'RESTORE_STARTED',operationId,details:{sourceBackupId:backupId}});
        try {detection=await discover();const result=await restoreManagedBackup({detection,backupRoot:path.join(dataDir,'backups'),backupId});store.markAllPending();store.event({code:'RESTORE_COMPLETED',operationId,details:{sourceBackupId:backupId,backupId:result.safetyBackupId,durationMs:Date.now()-started}});reply(res,200,{...result,durationMs:Date.now()-started});return;}
        catch(e){store.event({code:'RESTORE_FAILED',operationId,details:{sourceBackupId:backupId,errorCode:e.message,durationMs:Date.now()-started}});e.eventLogged=true;throw e;}
      }
      if(req.method==='POST' && /^\/api\/drafts\/[^/]+\/undelete$/.test(url.pathname)){store.restoreDeleted(url.pathname.split('/')[3]);reply(res,200,{ok:true});return;}
      if(req.method==='DELETE' && url.pathname.startsWith('/api/drafts/')){store.remove(url.pathname.split('/').pop());reply(res,200,{ok:true});return;}
      reply(res,404,{error:'NOT_FOUND'});
    }catch(e){if(!e.eventLogged)store.event({code:deployErrors.has(e.message)?'DEPLOY_FAILED':restoreErrors.has(e.message)?'RESTORE_FAILED':'INTERNAL_ERROR',details:{errorCode:e.message}});reply(res,400,{error:messages[e.message]||'操作未完成，请检查输入或日志'});}return;
  }
  if(url.pathname==='/'){let html=await fs.readFile(path.join(root,'index.html'),'utf8');html=html.replace('__TOKEN__',token);if(vite)html=await vite.transformIndexHtml(req.url,html);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY'});res.end(html);return;}
  if(vite)vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});else{res.writeHead(503);res.end('Development dependencies unavailable');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Toolbox ready: http://${host}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await vite?.close();store.close();server.close();process.exit(0);});
