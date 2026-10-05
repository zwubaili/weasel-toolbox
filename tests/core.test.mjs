import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicEvent, Store, validateDraft } from '../lib/core.mjs';
import { selectRecords, recentRecords, validSchemaFilter } from '../src/record-list.mjs';
import { apiErrorMessage } from '../src/api-errors.mjs';

test('隐藏或失效的方案筛选自动归为全部，过期凭证显示中文且提示保存内容',()=>{
  assert.equal(validSchemaFilter(['a'],'b'),'all');
  assert.equal(validSchemaFilter(['a','b'],'c'),'all');
  assert.equal(validSchemaFilter(['a','b'],'b'),'b');
  assert.match(apiErrorMessage({error:'TOKEN_REQUIRED'}),/未保存.*刷新/);
});

test('达到10000条后禁止新增但仍能删除',()=>withStore(store=>{
  const insert=store.db.prepare('INSERT INTO drafts(id,kind,payload,created,updated,deleted) VALUES(?,?,?,?,?,0)');
  store.db.exec('BEGIN');
  for(let i=0;i<10000;i++)insert.run(i.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000','word',JSON.stringify({...word,text:'记录'+i}),'2026-01-01','2026-01-01');
  store.db.exec('COMMIT');
  assert.throws(()=>store.add({...word,text:'超过上限'}),/RECORD_LIMIT/);
  store.remove('00000000-0000-4000-8000-000000000000');
  assert.ok(store.add({...word,text:'可以新增'}));
}));

test('首页最近10条排除待删除，状态变化不影响顺序且不修改源数据',()=>{
  const rows=Array.from({length:13},(_,i)=>({id:String(i),kind:i%2?'word':'phrase',created:new Date(2026,0,i+1).toISOString(),status:i===12?'delete_pending':i===0?'modified':'draft'}));
  const original=JSON.stringify(rows);
  const ids=recentRecords(rows).map(r=>r.id);
  assert.deepEqual(ids,['11','10','9','8','7','6','5','4','3','2']);
  assert.equal(JSON.stringify(rows),original);
  assert.deepEqual(recentRecords(rows.map(r=>({...r,status:r.status==='delete_pending'?r.status:'deployed'}))).map(r=>r.id),ids);
  assert.equal(recentRecords(rows.map(r=>r.id==='0'?{...r,updated:'2027-01-01T00:00:00.000Z'}:r))[0].id,'0');
  assert.equal(recentRecords(rows.filter(r=>r.id!=='11')).at(-1).id,'1');
  assert.deepEqual(recentRecords(),[]);
});

test('列表组合筛选、四种排序及同编码候选顺序，不改动原记录',()=>{
  const rows=[
    {id:'a',kind:'word',text:'甲',code:'bb',order:2,schemaIds:['s'],status:'draft',created:'2026-01-01',updated:'2026-01-03'},
    {id:'b',kind:'word',text:'乙',code:'aa',order:3,schemaIds:['s'],status:'deployed',created:'2026-01-02',updated:'2026-01-02'},
    {id:'c',kind:'word',text:'丙',code:'aa',order:1,schemaIds:['t'],status:'delete_pending',created:'2026-01-03',updated:'2026-01-01'}
  ];
  const original=JSON.stringify(rows);
  const ids=options=>selectRecords(rows,{kind:'word',...options}).rows.map(d=>d.id);
  assert.deepEqual(ids({sort:'az'}),['c','b','a']);
  assert.deepEqual(ids({sort:'za'}),['a','c','b']);
  assert.deepEqual(ids({sort:'recent'}),['a','b','c']);
  assert.deepEqual(ids({sort:'oldest'}),['a','b','c']);
  assert.deepEqual(ids({query:'AA',status:'pending'}),['c']);
  assert.deepEqual(ids({status:'synced',schema:'s'}),['b']);
  assert.equal(JSON.stringify(rows),original);
  assert.deepEqual(ids({sort:'az'}),selectRecords([...rows].reverse(),{kind:'word',sort:'az'}).rows.map(d=>d.id));
});

test('列表全量搜索、50条分页和越界页修正',()=>{
  const rows=Array.from({length:101},(_,i)=>({id:String(i).padStart(3,'0'),kind:'phrase',text:'内容'+i,code:'a',order:i+1,schemaIds:['s'],status:'deployed',created:'2026-01-01'}));
  assert.equal(selectRecords(rows,{kind:'phrase'}).rows.length,50);
  const last=selectRecords(rows,{kind:'phrase',page:99});
  assert.equal(last.page,3);assert.equal(last.rows.length,1);
  assert.equal(selectRecords(rows,{kind:'phrase',query:'内容100'}).total,1);
  assert.equal(selectRecords(rows,{kind:'word',page:5}).page,1);
});

const schemas=['pinyin_simp','wubi86'];
test('日志保留30天最多1000条，默认100条且支持完整导出',()=>withStore(store=>{
  const now=Date.now();
  const insert=store.db.prepare('INSERT INTO events VALUES(?,?,?)');
  for(let i=0;i<1100;i++){
    const e=publicEvent({code:'DRAFT_SAVED',count:i});
    e.timestamp=new Date(now-i*1000).toISOString();
    insert.run(e.id,JSON.stringify(e),e.timestamp);
  }
  const old=publicEvent({code:'DRAFT_SAVED'});
  old.timestamp=new Date(now-31*86400000).toISOString();
  insert.run(old.id,JSON.stringify(old),old.timestamp);
  store.pruneEvents(now);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,1000);
  assert.equal(store.events().length,100);
  assert.equal(store.events(true).length,1000);
  assert.equal(store.events(true).at(-1).count,999);
  store.pruneEvents(now+31*86400000);
  assert.equal(store.events(true).length,0);
}));
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
