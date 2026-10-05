import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export function draftHash(draft) {
  const normalized={kind:draft.kind,text:draft.text,code:draft.code,schemaIds:[...draft.schemaIds].sort(),order:draft.order};
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
const overlapsEntry=(a,b)=>a.code===b.code&&a.text===b.text&&a.schemaIds.some(s=>b.schemaIds.includes(s));
export function validateSnapshot(rows) {
  if(!Array.isArray(rows)||rows.length>10000)throw Error('BACKUP_INVALID');
  const ids=new Set();
  for(const r of rows){
    if(typeof r.id!=='string'||!/^[a-f0-9-]{36}$/.test(r.id)||ids.has(r.id)||![0,1].includes(r.deleted)||typeof r.created!=='string'||typeof r.updated!=='string'||!(r.deployed_hash===null||typeof r.deployed_hash==='string')||!(r.deployed_at===null||typeof r.deployed_at==='string'))throw Error('BACKUP_INVALID');
    ids.add(r.id);const d=validateDraft(JSON.parse(r.payload));if(d.kind!==r.kind)throw Error('BACKUP_INVALID');
  }
  return rows;
}

export function selectInstallation(candidates) {
  const valid = candidates.filter(c => c.valid);
  const active = valid.filter(c => c.running);
  if (active.length === 1) return { selected: active[0], ambiguous: false };
  return { selected: valid.length === 1 ? valid[0] : null, ambiguous: valid.length > 1 };
}
export function validateDraft(value, schemas = null) {
  if (!value || !['word','phrase'].includes(value.kind)) throw new Error('INVALID_DRAFT');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 500 || /[\r\n\t\x00-\x1f]/.test(value.text)) throw new Error('INVALID_TEXT');
  if (typeof value.code !== 'string' || !/^[a-z][a-z ']{0,63}$/.test(value.code) || value.code !== value.code.trim()) throw new Error('INVALID_CODE');
  if (!Array.isArray(value.schemaIds) || !value.schemaIds.length || value.schemaIds.length > 50 || !value.schemaIds.every(s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s) && (!schemas || schemas.includes(s)))) throw new Error('INVALID_SCHEMA');
  if (!Number.isInteger(value.order) || value.order < 1 || value.order > 999) throw new Error('INVALID_ORDER');
  return { kind:value.kind, text:value.text, code:value.code, schemaIds:[...new Set(value.schemaIds)], order:value.order };
}
export function publicEvent(input) {
  const code = ['DISCOVERY_OK','DISCOVERY_FAILED','DRAFT_SAVED','DRAFT_UPDATED','DRAFT_DELETED','DRAFT_RESTORED','DRAFT_INVALID','DEPLOY_STARTED','DEPLOY_COMPLETED','DEPLOY_FAILED','RESTORE_STARTED','RESTORE_COMPLETED','RESTORE_FAILED','RECORDS_RESTORE_STARTED','RECORDS_RESTORE_COMPLETED','RECORDS_RESTORE_FAILED','EXPORT_DONE','INTERNAL_ERROR'].includes(input.code) ? input.code : 'INTERNAL_ERROR';
  const source=input.details&&typeof input.details==='object'?input.details:{};
  const details={};
  for(const key of ['added','modified','deleted','total','durationMs']) if(Number.isSafeInteger(source[key])&&source[key]>=0) details[key]=source[key];
  if(Array.isArray(source.schemaIds)) details.schemaIds=[...new Set(source.schemaIds.filter(value=>typeof value==='string'&&/^[a-z0-9_.-]{1,80}$/.test(value)))].slice(0,30);
  if(typeof source.backupId==='string'&&/^[A-Za-z0-9-]{20,100}$/.test(source.backupId)) details.backupId=source.backupId;
  if(typeof source.sourceBackupId==='string'&&/^[A-Za-z0-9-]{20,100}$/.test(source.sourceBackupId)) details.sourceBackupId=source.sourceBackupId;
  if(typeof source.errorCode==='string'&&/^[A-Z0-9_]{2,80}$/.test(source.errorCode)) details.errorCode=source.errorCode;
  const operationId=typeof input.operationId==='string'&&/^[a-f0-9-]{36}$/.test(input.operationId)?input.operationId:randomUUID();
  return { id:randomUUID(), timestamp:new Date().toISOString(), level:code.endsWith('FAILED') || code === 'INTERNAL_ERROR' ? 'error' : 'info', code, operationId, count:Number.isSafeInteger(input.count) && input.count >= 0 ? input.count : 0, details };
}
export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, payload TEXT NOT NULL, created TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const columns=new Set(this.db.prepare('PRAGMA table_info(drafts)').all().map(r=>r.name));
    if(!columns.has('updated')) this.db.exec('ALTER TABLE drafts ADD COLUMN updated TEXT');
    if(!columns.has('deployed_hash')) this.db.exec('ALTER TABLE drafts ADD COLUMN deployed_hash TEXT');
    if(!columns.has('deployed_at')) this.db.exec('ALTER TABLE drafts ADD COLUMN deployed_at TEXT');
    if(!columns.has('deleted')) this.db.exec('ALTER TABLE drafts ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
    this.db.exec('UPDATE drafts SET updated=created WHERE updated IS NULL; PRAGMA user_version=2;');
    this.pruneEvents();
  }
  drafts() { return this.db.prepare('SELECT * FROM drafts ORDER BY updated DESC').all().map(r => {const value=JSON.parse(r.payload);const status=r.deleted?'delete_pending':r.deployed_hash?(r.deployed_hash===draftHash(value)?'deployed':'modified'):'draft';return {id:r.id,...value,created:r.created,updated:r.updated,deployedAt:r.deployed_at,status};}); }
  activeDrafts() { return this.drafts().filter(r=>r.status!=='delete_pending'); }
  pruneEvents(now = Date.now()) {
    const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM events WHERE created < ?').run(cutoff);
    this.db.exec('DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY created DESC, rowid DESC LIMIT 1000)');
  }
  event(input) { const e = publicEvent(input); this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(e.id,JSON.stringify(e),e.timestamp); this.pruneEvents(); return e; }
  events(all = false) { const cutoff=new Date(Date.now()-30*24*60*60*1000).toISOString(); return this.db.prepare('SELECT payload FROM events WHERE created >= ? ORDER BY created DESC, rowid DESC LIMIT ?').all(cutoff,all?1000:100).map(r=>JSON.parse(r.payload)); }
  add(draft) {
    if(this.db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n>=10000)throw Error('RECORD_LIMIT');
    if(this.drafts().some(r=>overlapsEntry(r,draft))) throw new Error('DUPLICATE');
    const id=randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try { const now=new Date().toISOString();this.db.prepare('INSERT INTO drafts(id,kind,payload,created,updated,deleted) VALUES(?,?,?,?,?,0)').run(id,draft.kind,JSON.stringify(draft),now,now); this.event({code:'DRAFT_SAVED',count:1}); this.db.exec('COMMIT'); return id; }
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  update(id,draft) {
    if(!/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_ID');
    if(!this.db.prepare('SELECT 1 FROM drafts WHERE id=? AND deleted=0').get(id)) throw new Error('NOT_FOUND');
    if(this.drafts().some(r=>r.id!==id&&overlapsEntry(r,draft))) throw new Error('DUPLICATE');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE drafts SET kind=?,payload=?,updated=? WHERE id=?').run(draft.kind,JSON.stringify(draft),new Date().toISOString(),id); this.event({code:'DRAFT_UPDATED',count:1}); this.db.exec('COMMIT'); }
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  remove(id) { if(!/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_ID'); this.db.exec('BEGIN IMMEDIATE'); try { const row=this.db.prepare('SELECT deployed_hash FROM drafts WHERE id=? AND deleted=0').get(id); if(!row) throw new Error('NOT_FOUND'); if(row.deployed_hash)this.db.prepare('UPDATE drafts SET deleted=1,updated=? WHERE id=?').run(new Date().toISOString(),id);else this.db.prepare('DELETE FROM drafts WHERE id=?').run(id); this.event({code:'DRAFT_DELETED',count:1});this.db.exec('COMMIT'); }catch(e){this.db.exec('ROLLBACK');throw e;} }
  restoreDeleted(id) { if(!/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_ID');const result=this.db.prepare('UPDATE drafts SET deleted=0,updated=? WHERE id=? AND deleted=1').run(new Date().toISOString(),id);if(result.changes!==1)throw new Error('NOT_FOUND');this.event({code:'DRAFT_RESTORED',count:1}); }
  markDeployed() { const now=new Date().toISOString();this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM drafts WHERE deleted=1').run();for(const row of this.db.prepare('SELECT id,payload FROM drafts WHERE deleted=0').all())this.db.prepare('UPDATE drafts SET deployed_hash=?,deployed_at=? WHERE id=?').run(draftHash(JSON.parse(row.payload)),now,row.id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;} }
  markAllPending() { this.db.prepare("UPDATE drafts SET deployed_hash='needs-sync' WHERE deleted=0").run(); }
  getSetting(key) { const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row?JSON.parse(row.value):null; }
  setSetting(key,value) { this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value)); }
  snapshot() { return this.db.prepare('SELECT * FROM drafts ORDER BY id').all().map(r=>({...r})); }
  revision() { return createHash('sha256').update(JSON.stringify(this.snapshot())).digest('hex'); }
  replaceSnapshot(rows, pending = false) {
    validateSnapshot(rows);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM drafts');
      const insert=this.db.prepare('INSERT INTO drafts(id,kind,payload,created,updated,deployed_hash,deployed_at,deleted) VALUES(?,?,?,?,?,?,?,?)');
      for(const r of rows) insert.run(r.id,r.kind,r.payload,r.created,r.updated,pending?'needs-sync':r.deployed_hash,r.deployed_at,r.deleted);
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  mergeRecords(records) {
    // One transaction: keep existing IDs and sync hashes, assign fresh IDs to imports.
    const before=new Map(this.snapshot().map(r=>[r.id,r]));
    const now=new Date().toISOString();
    const rows=records.map(item=>{
      const draft=validateDraft(item);
      const old=before.get(item.id);
      return old?{...old,kind:draft.kind,payload:JSON.stringify(draft),updated:old.payload===JSON.stringify(draft)?old.updated:now}:{id:randomUUID(),kind:draft.kind,payload:JSON.stringify(draft),created:now,updated:now,deployed_hash:null,deployed_at:null,deleted:0};
    });
    this.replaceSnapshot([...rows,...[...before.values()].filter(r=>r.deleted)]);
  }
  close(){this.db.close();}
}
