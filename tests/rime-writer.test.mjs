import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWritePlan, deleteBackup, deployDrafts, listBackups, restoreManagedBackup, setBackupPinned } from '../lib/rime-writer.mjs';

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weasel-writer-'));
  const userDir=path.join(dir,'Rime');
  const installDir=path.join(dir,'install');
  const backupRoot=path.join(dir,'backups');
  fs.mkdirSync(userDir);fs.mkdirSync(installDir);fs.writeFileSync(path.join(installDir,'WeaselDeployer.exe'),'test');
  const detection={state:'detected',userDir,installDir,schemas:[{id:'luna_pinyin'},{id:'wubi86'}]};
  const drafts=[
    {id:'1',kind:'word',text:'柔韧',code:'rouren',schemaIds:['luna_pinyin','wubi86'],order:1},
    {id:'2',kind:'phrase',text:'测试短语',code:'cs',schemaIds:['wubi86'],order:2}
  ];
  return {dir,userDir,installDir,backupRoot,detection,drafts};
}

test('写入计划按方案生成独立短语表与补丁',()=>{
  const f=fixture();
  try {
    const plan=createWritePlan(f.detection,f.drafts);
    assert.equal(plan.length,2);
    assert.match(plan[1].config,/table_translator@weasel_toolbox_phrase/);
    assert.match(plan[1].table,/柔韧\trouren\t9999/);
    assert.match(plan[1].table,/测试短语\tcs\t9998/);
    assert.doesNotMatch(plan[0].table,/测试短语/);
  } finally { fs.rmSync(f.dir,{recursive:true,force:true}); }
});

test('部署前备份并写入全部方案，失败时恢复原文件',async()=>{
  const f=fixture();
  try {
    const first=await deployDrafts({...f,runDeployer:async()=>{},verify:async()=>{}});
    assert.equal(first.draftCount,2);
    const table=path.join(f.userDir,'weasel_toolbox_wubi86.txt');
    const original=fs.readFileSync(table,'utf8');
    assert.ok(fs.existsSync(path.join(f.userDir,'wubi86.custom.yaml')));
    await assert.rejects(()=>deployDrafts({...f,drafts:[{...f.drafts[0],text:'变化'}],runDeployer:async()=>{throw Error('DEPLOY_FAILED')},verify:async()=>{}}),/DEPLOY_FAILED/);
    assert.equal(fs.readFileSync(table,'utf8'),original);
  } finally { fs.rmSync(f.dir,{recursive:true,force:true}); }
});

test('不覆盖用户已有的方案自定义文件',async()=>{
  const f=fixture();
  try {
    fs.writeFileSync(path.join(f.userDir,'wubi86.custom.yaml'),'patch:\n  menu/page_size: 9\n');
    await assert.rejects(()=>deployDrafts({...f,runDeployer:async()=>{},verify:async()=>{}}),/CONFIG_CONFLICT/);
    assert.equal(fs.readFileSync(path.join(f.userDir,'wubi86.custom.yaml'),'utf8'),'patch:\n  menu/page_size: 9\n');
  } finally { fs.rmSync(f.dir,{recursive:true,force:true}); }
});

test('备份可列出并能在校验后恢复到写入前状态',async()=>{
  const f=fixture();
  try {
    const fakeDeploy=async()=>{
      const build=path.join(f.userDir,'build');fs.mkdirSync(build,{recursive:true});
      for(const schema of f.detection.schemas){const custom=path.join(f.userDir,`${schema.id}.custom.yaml`);fs.writeFileSync(path.join(build,`${schema.id}.schema.yaml`),fs.existsSync(custom)?`table_translator@weasel_toolbox_phrase\nuser_dict: weasel_toolbox_${schema.id}\n`:'engine: {}\n');}
    };
    const deployed=await deployDrafts({...f,runDeployer:fakeDeploy,verify:async()=>{}});
    const backups=await listBackups(f.backupRoot);
    assert.equal(backups[0].id,deployed.backupId);
    assert.equal(backups[0].restorable,true);
    const restored=await restoreManagedBackup({...f,backupId:deployed.backupId,runDeployer:fakeDeploy});
    assert.equal(restored.ok,true);
    assert.equal(fs.existsSync(path.join(f.userDir,'wubi86.custom.yaml')),false);
    assert.equal(fs.existsSync(path.join(f.userDir,'weasel_toolbox_wubi86.txt')),false);
  } finally { fs.rmSync(f.dir,{recursive:true,force:true}); }
});

test('自动清理旧备份，同时保留用户固定的备份',async()=>{
  const f=fixture();
  try {
    const options={...f,runDeployer:async()=>{},verify:async()=>{}};
    const first=await deployDrafts(options);await setBackupPinned(f.backupRoot,first.backupId,true);
    for(let i=0;i<22;i++)await deployDrafts({...options,drafts:[{...f.drafts[0],text:`变化${i}`}]});
    const backups=await listBackups(f.backupRoot);
    assert.equal(backups.length,21);
    assert.equal(backups.find(item=>item.id===first.backupId)?.pinned,true);
    const removable=backups.find(item=>!item.pinned);await deleteBackup(f.backupRoot,removable.id);
    assert.equal((await listBackups(f.backupRoot)).length,20);
  } finally { fs.rmSync(f.dir,{recursive:true,force:true}); }
});
