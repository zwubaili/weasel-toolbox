import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import{Home,BookOpen,MessageSquare,Archive,Activity,Settings,ScrollText,Plus,RefreshCw,Search,CheckCircle2,AlertCircle,ChevronRight,Trash2,Pencil,Download,ShieldCheck,UploadCloud,RotateCcw,Pin}from'lucide-react';import'./style.css';import'./draft-actions.css';
import { api, exportFile, RecordsTools } from './records-tools.jsx';
import './reliability.css';
import { selectRecords, recentRecords, validSchemaFilter } from './record-list.mjs';
const nav=[['home','首页',Home],['words','常用词',BookOpen],['shortcuts','快捷短语',MessageSquare],['backups','备份恢复',Archive],['status','输入法状态',Activity],['logs','日志中心',ScrollText]];
const statusLabels={draft:'未写入',deployed:'已部署',modified:'修改待同步',delete_pending:'删除待同步'};
const eventLabels={
RECORDS_RESTORE_STARTED:{module:'记录恢复',action:'恢复本地快照',result:'已开始',tone:'working',detail:'备份当前记录后恢复，不直接写入输入法'},
RECORDS_RESTORE_COMPLETED:{module:'记录恢复',action:'恢复本地快照',result:'成功',tone:'success',detail:'本地记录已恢复，请检查后同步到输入法'},
RECORDS_RESTORE_FAILED:{module:'记录恢复',action:'恢复本地快照',result:'失败',tone:'error',detail:'恢复未完成，请查看错误提示并保留快照'},
DISCOVERY_OK:{module:'输入法检测',action:'重新检测小狼毫',result:'成功',tone:'success',detail:'已刷新安装目录和输入方案'},
DISCOVERY_FAILED:{module:'输入法检测',action:'检测小狼毫',result:'失败',tone:'error',detail:'没有取得有效的安装或用户目录'},
DRAFT_SAVED:{module:'内容管理',action:'新增内容',result:'已保存',tone:'neutral',detail:'当时已存入工具，是否同步请看后续写入记录'},
DRAFT_UPDATED:{module:'内容管理',action:'修改内容',result:'已修改',tone:'neutral',detail:'当时已保存修改，是否同步请看后续写入记录'},
DRAFT_DELETED:{module:'内容管理',action:'删除内容',result:'已标记',tone:'neutral',detail:'当时已登记删除，是否生效请看后续写入记录'},
DRAFT_RESTORED:{module:'内容管理',action:'取消删除',result:'已取消',tone:'neutral',detail:'当时已取消删除标记'},
DRAFT_INVALID:{module:'内容管理',action:'保存内容',result:'失败',tone:'error',detail:'填写内容未通过校验'},
DEPLOY_STARTED:{module:'词库部署',action:'写入词库',result:'已开始',tone:'working',detail:'此时开始备份、写入并重新部署小狼毫'},
DEPLOY_COMPLETED:{module:'词库部署',action:'写入词库',result:'成功',tone:'success',detail:'内容已写入，请实际试输确认'},
DEPLOY_FAILED:{module:'词库部署',action:'写入词库',result:'失败',tone:'error',detail:'写入未完成，请查看页面提示'},
RESTORE_STARTED:{module:'备份恢复',action:'恢复配置',result:'已开始',tone:'working',detail:'此时开始备份当前配置并执行恢复'},
RESTORE_COMPLETED:{module:'备份恢复',action:'恢复配置',result:'成功',tone:'success',detail:'配置已恢复，请实际试输确认'},
RESTORE_FAILED:{module:'备份恢复',action:'恢复配置',result:'失败',tone:'error',detail:'恢复未完成，请保留现有备份'},
EXPORT_DONE:{module:'日志中心',action:'导出诊断日志',result:'成功',tone:'success',detail:'脱敏诊断文件已生成'},
INTERNAL_ERROR:{module:'系统',action:'执行操作',result:'失败',tone:'error',detail:'发生内部错误，建议导出诊断日志'}
};
const eventView=e=>eventLabels[e.code]||{module:'系统',action:'记录操作',result:e.level==='error'?'失败':'已记录',tone:e.level==='error'?'error':'neutral',detail:'这是较新版本产生的操作记录'};
const errorAdvice={RIME_NOT_READY:'请重新检测小狼毫安装和用户目录',NO_DRAFTS:'请先添加需要同步的词语或短语',UNKNOWN_SCHEMA:'草稿包含已停用的输入方案，请修改适用方案',DEPLOYER_NOT_FOUND:'请确认小狼毫安装完整后重新检测',WRITE_BUSY:'请等待当前写入或恢复完成后重试',CONFIG_CONFLICT:'目标方案已有其他自定义配置，工具已停止覆盖',TARGET_CONFLICT:'目标短语文件不归本工具管理，工具已停止覆盖',EXTERNAL_CHANGE:'受管配置已被其他程序修改，请先核对配置',DEPLOY_VERIFY_FAILED:'重新部署后的配置验证失败，请恢复最近备份',BACKUP_INVALID:'备份不存在或清单无效',BACKUP_UNVERIFIED:'该旧备份缺少校验信息，不能自动恢复',BACKUP_DAMAGED:'备份文件校验失败，已停止恢复',RESTORE_VERIFY_FAILED:'恢复后的配置验证失败，请保留当前安全备份'};
const formatBytes=value=>value<1024?`${value} B`:value<1024*1024?`${(value/1024).toFixed(1)} KB`:`${(value/1024/1024).toFixed(1)} MB`;
function logRecords(events){const groups=[];const found=new Map();for(const event of events){const grouped=/^(DEPLOY|RESTORE|RECORDS_RESTORE)_/.test(event.code);const key=grouped?event.operationId:event.id;if(grouped&&found.has(key)){found.get(key).events.push(event);continue}const group={id:key,events:[event]};groups.push(group);if(grouped)found.set(key,group)}return groups.map(group=>{const history=[...group.events].sort((a,b)=>a.timestamp.localeCompare(b.timestamp));const terminal=[...history].reverse().find(item=>/(COMPLETED|FAILED)$/.test(item.code))||history.at(-1);return {...group,event:terminal,history,details:Object.assign({},...history.map(item=>item.details||{})),...eventView(terminal)}})}

function App(){
  const[state,setState]=useState(null);const[page,setPage]=useState('home');const[drawer,setDrawer]=useState(null);
  const[toast,setToast]=useState('');const[working,setWorking]=useState(false);
  const refresh=async()=>{const s=await api('/api/state');setState(s);return s;};
  useEffect(()=>{let active=true;const read=()=>api('/api/state').then(s=>{if(active)setState(s);}).catch(e=>{if(active)setToast(e.message);});read();const timer=setInterval(read,2500);return()=>{active=false;clearInterval(timer);};},[]);
  async function act(fn){setWorking(true);try{await fn();}catch(e){setToast(e.message);}finally{try{await refresh();}catch(e){setToast(e.message);}setWorking(false);}}
  const schemas=state?.detection?.schemas||[];const connected=state?.detection?.state==='detected';
  const locked=working||state?.busy||state?.recovery?.blocked;
  const pending=(state?.drafts||[]).filter(d=>d.status!=='deployed');
  async function sync(){
    const all=state?.drafts||[];
    if(!confirm('同步到输入法：新增 '+all.filter(d=>d.status==='draft').length+' 条，修改 '+all.filter(d=>d.status==='modified').length+' 条，删除 '+all.filter(d=>d.status==='delete_pending').length+' 条。写入前自动备份，是否继续？'))return;
    await act(async()=>{await api('/api/deploy-drafts',{method:'POST'});setToast('同步完成，请切换到对应方案实际试输。');});
  }
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><img src="/weasel-toolbox-icon.svg" alt=""/></div><div><div className="brand-name">小狼毫扩展工具箱</div><div className="brand-sub">本地管理工具 · {state?.version||'载入中'}</div></div></div>
    <div className="nav">{nav.map(([id,label,Icon])=><button key={id} className={page===id?'nav-item active':'nav-item'} onClick={()=>setPage(id)}><Icon size={18}/><span>{label}</span></button>)}</div>
    <button className="nav-item settings" onClick={()=>setPage('settings')}><Settings size={18}/>设置</button></aside>
    <main className="main"><header className="top"><div><h1>{page==='settings'?'设置':nav.find(x=>x[0]===page)?.[1]||'首页'}</h1><p>本地保存 · 手动同步 · 操作前备份</p></div>
    <div className="top-actions"><button className="primary" disabled={!state||locked||!connected||state.targetChanged} onClick={sync}><UploadCloud size={15}/>{working||state?.busy?'正在处理…':'同步到输入法'}</button>
    <button className="ghost" disabled={working||state?.busy} onClick={()=>act(()=>api('/api/refresh',{method:'POST'}))}><RefreshCw size={15}/>重新检测</button>
    <div className={connected?'status-pill ok':'status-pill warn'}>{connected?'已检测到小狼毫':'未确认输入法'}</div></div></header>
    <p className="sync-summary">本地有效记录 {(state?.drafts||[]).filter(d=>d.status!=='delete_pending').length} 条 · 待同步 {pending.length} 条（含待删除 {pending.filter(d=>d.status==='delete_pending').length} 条）</p>
    {(working||state?.busy)&&<div className="operation-banner">正在处理，请等待完成后再编辑或退出。</div>}
    {state?.recovery?.blocked&&state.recovery.state!=='busy'&&<div className="operation-banner" role="alert"><strong>上次操作需要处理</strong>
      <p>{state.recovery.state==='pending'?'上次写入或恢复意外中断。记录已保留，请恢复到操作前，再继续编辑和同步。':'旧锁或操作记录无法安全判断，请保留备份并检查配置；工具不会自动清除。'}</p>
      {state.recovery.state==='pending'&&<button className="primary" disabled={working||state.busy||!connected} onClick={()=>{if(confirm('校验备份并恢复到上次操作前的记录和配置，是否继续？'))act(async()=>{await api('/api/recovery',{method:'POST'});setToast('恢复完成，记录标为待同步，请检查后重新同步。');});}}>恢复到操作前</button>}
    </div>}
    {state?.targetChanged&&<div className="operation-banner"><strong>输入法用户目录发生变化</strong><p>原目录：{state.acceptedUserDir}<br/>新目录：{state.detection.userDir}</p><button className="ghost" disabled={locked} onClick={()=>{if(confirm('确认改用新用户目录？本地记录会保留并标为待同步。'))act(()=>api('/api/target/confirm',{method:'POST',body:JSON.stringify({userDir:state.detection.userDir})}));}}>确认使用新目录</button></div>}
    {page==='home'&&<HomePage state={state} schemas={schemas} onAdd={kind=>setDrawer({kind})} onEdit={draft=>setDrawer({kind:draft.kind,draft})} onPage={setPage} disabled={locked}/>}
    {['words','shortcuts'].includes(page)&&<DraftPage key={page} kind={page==='words'?'word':'phrase'} state={state} disabled={locked} onAdd={kind=>setDrawer({kind})} onEdit={draft=>setDrawer({kind:draft.kind,draft})} act={act} onMessage={setToast}/>}
    {page==='logs'&&<Logs events={state?.events||[]}/>}
    {page==='status'&&<Status state={state}/>}
    {page==='backups'&&<Backups state={state} disabled={locked} refresh={refresh} act={act}/>}
    {page==='settings'&&<section className="panel"><h2>设置</h2><p>记录、导出文件和自动备份统一保存在本工具目录的 .local-data 文件夹中。请定期复制完整导出文件到另一块磁盘。</p><p>输入法更新后点击“重新检测”；记录不会因方案暂时不可用而删除。</p><p>版本：{state?.version}</p></section>}
    </main>
    {drawer&&<Drawer kind={drawer.kind} draft={drawer.draft} schemas={schemas} disabled={locked} onClose={()=>setDrawer(null)} onSaved={async()=>{setDrawer(null);await refresh();setToast('已保存到本地，请同步到输入法。');}}/>}
    {toast&&<div className="toast" role="status" onClick={()=>setToast('')}>{toast} <button className="ghost" onClick={()=>setToast('')}>关闭</button></div>}
  </div>;
}
function HomePage({state,schemas,onAdd,onEdit,onPage,disabled}){
  const records=recentRecords(state?.drafts);
  return <><div className="connection-card"><div><div className="connection-title">{state?.detection?.state==='detected'?'小狼毫已识别':'等待有效输入法'}</div><div className="muted">先保存到本地，确认后同步到输入法；工具退出后已写入内容仍可使用。</div></div><ShieldCheck size={32}/></div>
    <div className="scheme-row"><span>已启用方案</span>{schemas.map(s=><span className="scheme-chip" key={s.id}>{s.name}</span>)}</div>
    <div className="cards">{[['word','添加常用词'],['phrase','添加快捷短语']].map(([kind,title])=><button key={kind} className={'action-card '+(kind==='word'?'blue':'purple')} disabled={disabled} onClick={()=>onAdd(kind)}><Plus size={25}/><div className="action-copy"><h2>{title}</h2><p>保存编码、内容与适用方案</p></div></button>)}</div>
    <div className="panel"><div className="panel-head"><div><h2>最近添加 / 修改</h2><p>最近10条 · 点击记录继续编辑</p></div><button className="ghost" onClick={()=>onPage('backups')}>导出、导入与找回</button></div>
    {records.length?records.map(d=><button className="row recent-record" key={d.id} disabled={disabled} onClick={()=>onEdit(d)}><span>{d.kind==='word'?'常用词':'快捷短语'}</span><strong className="record-text">{d.text}</strong><code>{d.code}</code><span>{statusLabels[d.status]}</span></button>):<Empty text="没有可显示的记录，可以添加常用词、快捷短语或导入记录"/>}
    <div className="record-actions"><button className="ghost" onClick={()=>onPage('words')}>查看常用词</button><button className="ghost" onClick={()=>onPage('shortcuts')}>查看快捷短语</button></div></div></>;
}
function DraftPage({kind,state,disabled,onAdd,onEdit,act,onMessage}){
  const[q,setQ]=useState('');const[filter,setFilter]=useState('all');const[sort,setSort]=useState('recent');const[schema,setSchema]=useState('all');const[page,setPage]=useState(1);const[expanded,setExpanded]=useState({});
  const records=(state?.drafts||[]).filter(d=>d.kind===kind);
  const schemas=[...new Set(records.flatMap(d=>d.schemaIds))].sort();
  const effectiveSchema=validSchemaFilter(schemas,schema);
  const result=selectRecords(records,{kind,query:q,status:filter,sort,schema:effectiveSchema,page});
  useEffect(()=>{if(schema!==effectiveSchema){setSchema(effectiveSchema);setPage(1);}},[schema,effectiveSchema]);
  useEffect(()=>{if(page!==result.page)setPage(result.page);},[page,result.page]);
  const change=setter=>e=>{setter(e.target.value);setPage(1);};
  const known=new Set((state?.detection?.schemas||[]).map(s=>s.id));
  return <section className="page-body"><div className="toolbar"><div className="search"><Search size={16}/><input aria-label="搜索编码或内容" value={q} onChange={change(setQ)} placeholder="搜索编码或内容"/></div><button className="primary" disabled={disabled} onClick={()=>onAdd(kind)}>添加{kind==='word'?'常用词':'快捷短语'}</button></div>
    <div className="list-filters"><label>状态 <select value={filter} onChange={change(setFilter)}><option value="all">全部</option><option value="pending">待同步</option><option value="synced">已同步</option></select></label><label>排序方式 <select value={sort} onChange={change(setSort)}><option value="recent">最近修改</option><option value="oldest">最早添加</option><option value="az">编码 A–Z</option><option value="za">编码 Z–A</option></select></label>{schemas.length>1&&<label>适用方案 <select value={schema} onChange={change(setSchema)}><option value="all">全部方案</option>{schemas.map(id=><option key={id} value={id}>{state?.detection?.schemas?.find(s=>s.id===id)?.name||id}</option>)}</select></label>}</div>
    <div className="panel table-panel"><div className="panel-head"><div><h2>{kind==='word'?'常用词':'快捷短语'} · {records.filter(d=>d.status!=='delete_pending').length} 条有效 · {records.filter(d=>d.status==='delete_pending').length} 条待删除</h2><p>删除已同步记录后，再同步一次才会从输入法移除。</p></div><button className="ghost" onClick={()=>act(async()=>{const result=await exportFile(kind);onMessage('已导出 '+result.count+' 条到：'+result.path);})}>导出本类记录</button></div>
      {result.rows.map(d=><div className={'row data-row '+(d.status!=='deployed'?'pending-sync-row':'')} key={d.id}><span className="tag">{kind==='word'?'词语':'短语'}</span><div className="draft-copy"><strong className={expanded[d.id]?'record-text expanded':'record-text'}>{d.text}</strong>{kind==='phrase'&&<button className="text-toggle" aria-expanded={!!expanded[d.id]} onClick={()=>setExpanded(v=>({...v,[d.id]:!v[d.id]}))}>{expanded[d.id]?'收起':'展开内容'}</button>}<span className={'draft-status '+d.status}>{statusLabels[d.status]}</span></div><code>{d.code}</code><span>{d.schemaIds.map(s=><span key={s} className={known.has(s)?'':'schema-missing'}>{s}{known.has(s)?'':'（不可用）'} </span>)}</span>
      <div className="row-actions">{d.status==='delete_pending'?<button className="icon-btn" title="取消删除" disabled={disabled} onClick={()=>act(()=>api('/api/drafts/'+d.id+'/undelete',{method:'POST'}))}><RotateCcw size={16}/></button>:<><button className="icon-btn" title="修改记录" disabled={disabled} onClick={()=>onEdit(d)}><Pencil size={16}/></button><button className="icon-btn danger" title="删除记录" disabled={disabled} onClick={()=>{if(confirm(d.status==='draft'?'删除此本地记录？':'删除后需再次同步到输入法才会生效，是否继续？'))act(()=>api('/api/drafts/'+d.id,{method:'DELETE'}));}}><Trash2 size={16}/></button></>}</div></div>)}
      {!result.total&&<Empty text="没有匹配的记录"/>}
      <div className="list-pagination"><span>匹配 {result.total} 条 · 每页50条 · 第 {result.page} / {result.pages} 页</span><button className="ghost" disabled={result.page===1} onClick={()=>setPage(result.page-1)}>上一页</button><button className="ghost" disabled={result.page===result.pages} onClick={()=>setPage(result.page+1)}>下一页</button></div>
    </div></section>;
}
function Drawer({kind,draft,schemas,disabled,onClose,onSaved}){
  const[text,setText]=useState(draft?.text||'');const[code,setCode]=useState(draft?.code||'');const[schemaIds,setSchemaIds]=useState(draft?.schemaIds||[]);
  const[order,setOrder]=useState(draft?.order||1);const[existing,setExisting]=useState([]);const[err,setErr]=useState('');const[saving,setSaving]=useState(false);
  const available=[...schemas,...(draft?.schemaIds||[]).filter(id=>!schemas.some(s=>s.id===id)).map(id=>({id,name:id+'（暂不可用）'}))];
  useEffect(()=>{api('/api/state').then(s=>setExisting(s.drafts||[])).catch(e=>setErr(e.message));},[]);
  useEffect(()=>{if(draft)return;const max=Math.max(0,...existing.filter(d=>d.status!=='delete_pending'&&d.code===code&&d.schemaIds.some(s=>schemaIds.includes(s))).map(d=>d.order));setOrder(Math.min(999,max+1));},[code,schemaIds,existing]);
  async function save(){setSaving(true);try{await api(draft?'/api/drafts/'+draft.id:'/api/drafts',{method:draft?'PUT':'POST',body:JSON.stringify({kind,text,code,schemaIds,order})});await onSaved();}catch(e){setErr(e.message);}finally{setSaving(false);}}
  return <div className="overlay"><div className="drawer" role="dialog" aria-modal="true" aria-label="编辑本地记录"><div className="drawer-head"><h2>{draft?'修改':'添加'}{kind==='word'?'常用词':'快捷短语'}</h2><button className="close" aria-label="关闭" onClick={onClose}>×</button></div>
    <fieldset disabled={disabled||saving}><label>输入编码<input value={code} onChange={e=>setCode(e.target.value)} placeholder="例如 dz"/></label><label>内容<textarea value={text} onChange={e=>setText(e.target.value)} placeholder="单行内容"/></label>
    <div className="schema-options"><span>适用方案</span><div className="checks">{available.map(s=><label className="check" key={s.id}><input type="checkbox" checked={schemaIds.includes(s.id)} onChange={e=>setSchemaIds(e.target.checked?[...schemaIds,s.id]:schemaIds.filter(x=>x!==s.id))}/>{s.name}</label>)}</div></div>
    {!available.length&&<p className="notice">尚未检测到方案，请先安装或重新检测输入法。</p>}
    <label>同编码候选排序<input type="number" min="1" max="999" value={order} onChange={e=>setOrder(Number(e.target.value))}/></label></fieldset>
    {err&&<p className="error">{err}</p>}<div className="drawer-actions"><button className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={disabled||saving} onClick={save}>{saving?'保存中…':'保存到本地'}</button></div>
  </div></div>;
}
function LogRecord({record}){const[open,setOpen]=useState(false);const d=record.details;const hasChanges=['added','modified','deleted'].some(key=>Number.isInteger(d[key]));const legacyOperation=/^(DEPLOY|RESTORE|RECORDS_RESTORE)_/.test(record.event.code)&&record.history.length===1&&Object.keys(d).length===0;const hasDetails=record.event.count>0||Object.keys(d).length>0||record.history.length>1||legacyOperation;const row=<div className="row log-row"><span className="log-time">{new Date(record.event.timestamp).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</span><span className="tag">{record.module}</span><div className="log-copy"><strong>{record.action}</strong><span>{record.detail}</span></div><span className={'log-result '+record.tone}>{record.result}</span>{hasDetails?<ChevronRight className="log-chevron" size={17}/>:<span className="log-basic">基础记录</span>}</div>;return <div className={'log-record '+(open?'open':'')}>{hasDetails?<button className="log-row-button" onClick={()=>setOpen(!open)} aria-expanded={open}>{row}</button>:<div className="log-row-static">{row}</div>}{open&&<div className="log-details"><div><span>完整时间</span><strong>{new Date(record.event.timestamp).toLocaleString()}</strong></div>{record.event.count>0&&<div><span>{record.module==='输入法检测'?'检测结果':'涉及数量'}</span><strong>{record.event.count} {record.module==='输入法检测'?'个输入方案':'条记录'}</strong></div>}{hasChanges&&<div><span>内容变化</span><strong>新增 {d.added||0} · 修改 {d.modified||0} · 删除 {d.deleted||0}</strong></div>}{d.schemaIds?.length>0&&<div><span>适用方案</span><strong>{d.schemaIds.join('、')}</strong></div>}{d.backupId&&<div><span>安全备份</span><strong>{d.backupId.slice(0,19)}</strong></div>}{d.sourceBackupId&&<div><span>恢复来源</span><strong>{d.sourceBackupId.slice(0,19)}</strong></div>}{Number.isInteger(d.durationMs)&&<div><span>执行耗时</span><strong>{d.durationMs<1000?`${d.durationMs} 毫秒`:`${(d.durationMs/1000).toFixed(1)} 秒`}</strong></div>}{d.errorCode&&<div className="log-error-detail"><span>失败原因</span><strong>{errorAdvice[d.errorCode]||'发生未识别错误，请导出诊断文件'}</strong></div>}{record.history.length>1&&<div><span>执行过程</span><strong>{record.history.map(item=>eventView(item).result).join(' → ')}</strong></div>}{legacyOperation&&<div className="log-legacy-note"><span>记录说明</span><strong>这是升级前产生的基础记录，当时尚未保存方案、备份编号和耗时，无法补全。</strong></div>}</div>}</div>}
function Logs({events}){const rows=logRecords(events);const success=rows.filter(x=>x.tone==='success').length;const general=rows.filter(x=>x.tone==='neutral'||x.tone==='working'||x.tone==='pending').length;const failed=rows.filter(x=>x.tone==='error').length;return <section className="page-body"><div className="panel table-panel"><div className="panel-head"><div><h2>操作记录 <span className="count">{rows.length}</span></h2><p className="muted">保留最近30天、最多1000条；此处显示最近100条，相关操作合并展示。诊断导出包含全部保留日志。</p></div><button className="ghost" onClick={()=>api('/api/logs/export').then(d=>{const b=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='weasel-toolbox-diagnostic.json';a.click()})}><Download size={15}/>导出诊断文件</button></div>{rows.length?<><div className="log-summary"><div className="log-stat success"><span>成功记录</span><strong>{success}</strong></div><div className="log-stat pending"><span>一般及过程记录</span><strong>{general}</strong></div><div className="log-stat error"><span>失败记录</span><strong>{failed}</strong></div></div><div className="table log-table">{rows.map(record=><LogRecord key={record.id} record={record}/>)}</div></>:<Empty text="还没有操作记录"/>}</div></section>}
function Status({state}){const d=state?.detection||{};return <section className="page-body"><div className="status-grid"><Info label="检测状态" value={d.state||'读取中'}/><Info label="用户目录来源" value={d.userSource||'—'}/><Info label="已启用方案" value={String(d.schemas?.length||0)}/><Info label="运行模式" value={d.mode||'—'}/></div><div className="panel"><div className="panel-head"><h2>检测依据</h2><span className="muted">{d.checkedAt?new Date(d.checkedAt).toLocaleString():'—'}</span></div><pre className="evidence">{JSON.stringify({installDir:d.installDir,userDir:d.userDir,candidates:d.candidates,warnings:d.warnings},null,2)}</pre></div></section>}
function Info({label,value}){return <div className="info-card"><span>{label}</span><strong>{value}</strong></div>}

function Backups({state,disabled,refresh,act}){
  const[data,setData]=useState({backups:[],totalBytes:0});const[message,setMessage]=useState('');
  const load=async()=>setData(await api('/api/backups'));
  useEffect(()=>{load().catch(e=>setMessage(e.message));},[state?.revision,state?.recovery?.state]);
  async function perform(fn){await act(async()=>{await fn();await load();});}
  return <section className="page-body"><RecordsTools disabled={disabled} onChanged={refresh}/>
    <div className="panel"><div className="panel-head"><div><h2>操作前备份</h2><p>保留最近20份写入备份、5份恢复安全备份；长期保留和中断恢复所需备份不自动删除。</p><p className="muted">新备份包含操作前记录与配置；历史恢复后仍需检查待同步内容。</p></div><button className="ghost" onClick={()=>perform(load)}>刷新</button></div>
    {message&&<p className="backup-message">{message}</p>}
    {data.backups.map(b=><div className="backup-row" key={b.id}><Archive size={20}/><div><strong>{new Date(b.createdAt).toLocaleString()}</strong><span>{b.hasRecords?'记录 + 配置':'旧备份：仅配置'} · {formatBytes(b.sizeBytes)}{b.protected?' · 恢复所需，已保护':''}{b.pinned?' · 长期保留':''}</span></div><div className="backup-actions">
      <button className="ghost" disabled={disabled} onClick={()=>perform(()=>api('/api/backups/'+b.id+'/pin',{method:'POST',body:JSON.stringify({pinned:!b.pinned})}))}>{b.pinned?'取消保留':'长期保留'}</button>
      <button className="ghost" disabled={disabled||!b.restorable||state?.targetChanged} onClick={()=>{if(confirm(b.hasRecords?'恢复此备份的本地记录与输入法配置？可能找回已删除的记录，当前状态会先备份。':'此旧备份只能恢复配置，可能与本地列表不一致。当前状态会先备份，之后请检查并同步。继续？'))perform(async()=>{await api('/api/backups/'+b.id+'/restore',{method:'POST'});setMessage('恢复完成，请检查记录和待同步状态。');});}}>恢复</button>
      <button className="ghost" disabled={disabled||b.protected} onClick={()=>{if(confirm('永久删除这份历史备份？'))perform(()=>api('/api/backups/'+b.id,{method:'DELETE'}));}}>删除</button>
    </div></div>)}
    {!data.backups.length&&<Empty text="还没有操作前备份"/>}
    </div></section>;
}
function Empty({text}){return <div className="empty"><BookOpen size={24}/><span>{text}</span></div>;}
createRoot(document.getElementById('root')).render(<App/>);
