const compare=(a,b)=>a<b?-1:a>b?1:0;
export const validSchemaFilter=(schemas,selected)=>schemas.length>1&&schemas.includes(selected)?selected:'all';
export function recentRecords(records=[]) {
  return records.filter(d=>d.status!=='delete_pending')
    .sort((a,b)=>compare(b.updated||b.created,a.updated||a.created)||compare(a.id,b.id)).slice(0,10);
}
export function selectRecords(records,{kind,query='',status='all',sort='recent',schema='all',page=1}={}) {
  const needle=query.trim().toLowerCase();
  const list=records.filter(d=>d.kind===kind&&(!needle||d.text.toLowerCase().includes(needle)||d.code.toLowerCase().includes(needle))&&(schema==='all'||d.schemaIds.includes(schema))&&(status==='all'||(status==='synced'?d.status==='deployed':d.status!=='deployed')));
  list.sort((a,b)=>{
    let order;
    if(sort==='az'||sort==='za')order=compare(a.code,b.code)*(sort==='za'?-1:1)||a.order-b.order;
    else if(sort==='oldest')order=compare(a.created,b.created);
    else order=compare(b.updated||b.created,a.updated||a.created);
    return order||compare(a.id,b.id);
  });
  const pages=Math.max(1,Math.ceil(list.length/50));
  const current=Math.max(1,Math.min(pages,page));
  return {total:list.length,pages,page:current,rows:list.slice((current-1)*50,current*50)};
}
