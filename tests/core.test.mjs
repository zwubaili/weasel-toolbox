import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicEvent, Store, validateDraft } from '../lib/core.mjs';

const schemas=['pinyin_simp','wubi86'];
const word={kind:'word',text:'测试词',code:'ceshici',schemaIds:['pinyin_simp'],order:1};

function withStore(run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weasel-toolbox-'));
  const store=new Store(path.join(dir,'test.sqlite'));
  try { run(store); } finally { store.close(); fs.rmSync(dir,{recursive:true,force:true}); }
}

test('草稿可添加、修改并记录修改日志',()=>withStore(store=>{
  const id=store.add(validateDraft(word,schemas));
  const changed=validateDraft({...word,text:'修改后的词',code:'xiugai',schemaIds:['wubi86']},schemas);
  store.update(id,changed);
  const saved=store.drafts()[0];
  assert.deepEqual({id:saved.id,kind:saved.kind,text:saved.text,code:saved.code,schemaIds:saved.schemaIds,order:saved.order,status:saved.status},{id,...changed,status:'draft'});
  assert.ok(saved.updated);
  assert.equal(saved.deployedAt,null);
  assert.equal(store.events()[0].code,'DRAFT_UPDATED');
}));

test('修改时允许保留自身内容，但禁止变成另一条重复草稿',()=>withStore(store=>{
  const first=store.add(validateDraft(word,schemas));
  const second=store.add(validateDraft({...word,text:'另一个词'},schemas));
  assert.doesNotThrow(()=>store.update(first,validateDraft(word,schemas)));
  assert.throws(()=>store.update(second,validateDraft(word,schemas)),/DUPLICATE/);
}));

test('修改或删除不存在的草稿会明确失败',()=>withStore(store=>{
  const missing='00000000-0000-4000-8000-000000000000';
  assert.throws(()=>store.update(missing,validateDraft(word,schemas)),/NOT_FOUND/);
  assert.throws(()=>store.remove(missing),/NOT_FOUND/);
}));

test('部署、修改、待删除和取消删除状态可持续追踪',()=>withStore(store=>{
  const id=store.add(validateDraft(word,schemas));
  store.markDeployed();
  assert.equal(store.drafts()[0].status,'deployed');
  store.update(id,validateDraft({...word,text:'有修改'},schemas));
  assert.equal(store.drafts()[0].status,'modified');
  store.markDeployed();
  store.remove(id);
  assert.equal(store.drafts()[0].status,'delete_pending');
  store.restoreDeleted(id);
  assert.equal(store.drafts()[0].status,'deployed');
  store.remove(id);
  store.markDeployed();
  assert.equal(store.drafts().length,0);
}));

test('同一次操作可共享编号且日志详情只保留允许字段',()=>{
  const operationId='00000000-0000-4000-8000-000000000001';
  const event=publicEvent({code:'DEPLOY_COMPLETED',operationId,count:3,details:{added:2,modified:1,schemaIds:['wubi86','../secret'],backupId:'2026-09-05T00-00-00-000Z-00000000-0000-4000-8000-000000000000',privatePath:'C:\\secret'}});
  assert.equal(event.operationId,operationId);
  assert.deepEqual(event.details.schemaIds,['wubi86']);
  assert.equal(event.details.added,2);
  assert.equal(event.details.privatePath,undefined);
});
