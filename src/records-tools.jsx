import React, { useEffect, useState } from 'react';
import { apiErrorMessage } from './api-errors.mjs';

export async function api(url, options={}) {
  const res=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-Toolbox-Token':window.__TOOLBOX_TOKEN__,...options.headers}});
  const value=await res.json();if(!res.ok)throw Error(apiErrorMessage(value));return value;
}
export async function exportFile(kind) {
  return api('/api/records/export',{method:'POST',body:JSON.stringify({kind})});
}
const labels={skip:'保留本地 / 跳过',add:'新增',replace:'使用导入内容',both:'两条都保留',merge:'合并适用方案'};
const typeName=kind=>kind==='word'?'常用词':'快捷短语';
function RecordDetail({record}) {
  return <div className="review-record"><strong>{record.text}</strong><code>{record.code}</code><small>{typeName(record.kind)} · 排序 {record.order} · {record.schemaIds.join('、')}</small></div>;
}
export function RecordsTools({disabled,onChanged}) {
  const [preview,setPreview]=useState(null);const [decisions,setDecisions]=useState([]);const [message,setMessage]=useState('');const [working,setWorking]=useState(false);
  const [snapshots,setSnapshots]=useState({backups:[],revision:null});
  const loadSnapshots=async()=>setSnapshots(await api('/api/record-backups'));
  useEffect(()=>{loadSnapshots().catch(e=>setMessage(e.message));},[]);
  const loadPreview=value=>{setPreview(value);setDecisions(value.rows.map(row=>({action:row.state==='new'?'add':row.state==='conflict'?'':'skip',kind:row.record?.kind})));};
  async function work(fn){setWorking(true);setMessage('');try{await fn();}catch(e){setMessage(e.message);}finally{setWorking(false);}}
  async function importFile(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;await work(async()=>{if(file.size>5*1024*1024)throw Error('文件超过5MB');const input=JSON.parse(await file.text());loadPreview(await api('/api/import/preview',{method:'POST',body:JSON.stringify(input)}));});}
  async function apply(){await work(async()=>{
    const result=await api('/api/import/commit',{method:'POST',body:JSON.stringify({id:preview.id,decisions})});
    setPreview(null);setMessage('合并完成：新增 '+result.added+' 条，修改 '+result.modified+' 条。请检查列表，再点击“同步到输入法”。'+(result.cleanupWarning?' 旧快照清理未完成，已保留。':''));await onChanged();await loadSnapshots();
  });}
  const locked=disabled||working;
  return <section className="panel records-tools"><h2>完整记录与找回</h2><p className="muted">完整导出包含常用词和快捷短语，不含待删除项。导入只更新本地记录，确认后再同步到输入法。</p>
    <div className="toolbar tools-actions">
      <button className="primary" disabled={working} onClick={()=>work(async()=>{const r=await exportFile();setMessage('已导出 '+r.count+' 条，文件保存在：'+r.path);})}>导出全部记录</button>
      <label className={'ghost file-button '+(locked?'disabled':'')}>导入记录文件<input aria-label="导入记录文件" type="file" accept=".json,application/json" disabled={locked} onChange={importFile}/></label>
      <button className="ghost" disabled={locked} onClick={()=>work(async()=>loadPreview(await api('/api/records/recover-preview',{method:'POST'})))}>从输入法找回</button>
    </div>
    {message&&<p className="backup-message" role="status">{message}</p>}
    {preview&&<div className="import-preview">
      <h3>校对后合并</h3><p>新增 {preview.rows.filter(r=>r.state==='new').length} · 重复 {preview.rows.filter(r=>r.state==='duplicate').length} · 待确认 {preview.rows.filter(r=>r.state==='conflict').length} · 无效 {preview.rows.filter(r=>r.state==='invalid').length}</p>
      {preview.warnings?.map(w=><p className="notice" key={w}>{w}</p>)}
      <p className="muted">“使用导入内容”会替换对应的本地记录。全部确认前不会改动数据；本地记录变化后须重新预览。</p>
      {preview.source==='recovery'&&<button className="ghost" disabled={locked} onClick={()=>setDecisions(ds=>ds.map(d=>({...d,kind:'word'})))}>将本次可导入项统一归为常用词</button>}
      <div className="import-rows">{preview.rows.map(row=><div className="import-row" key={row.index}>
        <div><small>导入内容 · {row.reason}</small>{row.record?<RecordDetail record={row.record}/>:<span>无法读取此项</span>}</div>
        <div><small>本地内容</small>{row.local?.map(d=><RecordDetail key={d.id} record={d}/>)}{!row.local?.length&&<span className="muted">—</span>}</div>
        <div className="review-actions"><select aria-label={'第'+(row.index+1)+'项处理方式'} disabled={locked||row.choices.length===1} value={decisions[row.index].action} onChange={e=>setDecisions(ds=>ds.map((d,i)=>i===row.index?{...d,action:e.target.value}:d))}>
          <option value="">请选择处理方式</option>{row.choices.map(c=><option key={c} value={c}>{labels[c]}</option>)}
        </select>{preview.source==='recovery'&&row.choices.length>1&&<select aria-label={'第'+(row.index+1)+'项分类'} value={decisions[row.index].kind} disabled={locked} onChange={e=>setDecisions(ds=>ds.map((d,i)=>i===row.index?{...d,kind:e.target.value}:d))}><option value="word">常用词</option><option value="phrase">快捷短语</option></select>}</div>
      </div>)}</div>
      {!preview.rows.length&&<p>没有找到可导入的记录。</p>}
      <div className="drawer-actions"><button className="ghost" disabled={working} onClick={()=>setPreview(null)}>取消</button><button className="primary" disabled={locked||!preview.rows.length||decisions.some(d=>!d.action)} onClick={apply}>确认合并到本地</button></div>
    </div>}
    <div className="import-preview"><h3>本地记录快照</h3><p className="muted">合并及恢复前自动保存，保留最近20份有效快照；本次恢复来源和安全副本额外保护。恢复会替换本地记录，不直接更改输入法，之后需检查并同步。</p>
      <button className="ghost" disabled={locked} onClick={()=>work(loadSnapshots)}>刷新快照列表</button>
      {snapshots.backups.map(b=><div className="backup-row" key={b.id}><div><strong>{b.createdAt?new Date(b.createdAt).toLocaleString():'无法读取的快照'}</strong><span>{b.invalid?'校验失败，已保留，请人工检查':`${b.reason==='before-import'?'合并前':'恢复前'} · ${b.count}条 · ${b.verified?'校验保护':'旧格式：仅结构校验'}`}</span></div><button className="ghost" disabled={locked||b.invalid} onClick={()=>{if(confirm('将本地记录替换为此快照：快照之后新增的记录将移除，历史内容会恢复。当前记录会先备份。输入法不会立即改变，恢复后需检查并同步。是否继续？'))work(async()=>{const r=await api('/api/record-backups/restore',{method:'POST',body:JSON.stringify({id:b.id,revision:snapshots.revision})});setPreview(null);setMessage('本地记录已恢复，请检查后同步到输入法。'+(r.cleanupWarning?' 旧快照清理未完成，已保留。':''));await onChanged();await loadSnapshots();});}}>恢复本地记录</button></div>)}
      {!snapshots.backups.length&&<p className="muted">暂无记录快照。合并导入后会自动生成。</p>}
    </div>
  </section>;
}
