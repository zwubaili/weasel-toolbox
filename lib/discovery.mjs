import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { selectInstallation } from './core.mjs';
const run = promisify(execFile);
const exists = p=>fs.access(p).then(()=>true,()=>false);
async function readYaml(p){ const stat=await fs.stat(p); if(stat.size>10*1024*1024) throw new Error('CONFIG_TOO_LARGE'); return YAML.parse(await fs.readFile(p,'utf8'),{uniqueKeys:true,maxAliasCount:50}); }
export async function discover(){
  if(process.platform!=='win32') return {state:'unsupported',schemas:[],candidates:[],warnings:['仅支持 Windows 检测']};
  // Fixed read-only script: no user-supplied command interpolation.
  const script = `$ErrorActionPreference='SilentlyContinue'; $p=Get-Process -Name WeaselServer; $r=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Rime\\Weasel'; [PSCustomObject]@{userDir=$r.RimeUserDir;processPaths=@($p | ForEach-Object {$_.Path})} | ConvertTo-Json -Compress`;
  let detected={}; let warnings=[];
  try { const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:1024*1024}); detected=JSON.parse(result.stdout.replace(/^\uFEFF/,'')); }catch{ warnings.push('进程或注册表检测不可用，已检查标准目录'); }
  const processPaths=(detected.processPaths||[]).filter(Boolean);
  const roots=new Set(processPaths.map(p=>path.dirname(p)));
  for(const base of [process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,'Programs')].filter(Boolean)){
    const root=path.join(base,'Rime'); roots.add(root);
    try{for(const e of await fs.readdir(root,{withFileTypes:true})) if(e.isDirectory()) roots.add(path.join(root,e.name));}catch{}
  }
  const candidates=[];
  for(const dir of roots){const valid=await exists(path.join(dir,'WeaselDeployer.exe')) && await exists(path.join(dir,'data')); if(valid)candidates.push({id:dir,dir,valid,running:processPaths.some(p=>path.dirname(p).toLowerCase()===dir.toLowerCase())});}
  const picked=selectInstallation(candidates);
  const custom = typeof detected.userDir==='string' && detected.userDir.trim() ? detected.userDir.trim() : null;
  const userDir=custom || (process.env.APPDATA ? path.join(process.env.APPDATA,'Rime') : null);
  const userValid = userDir && path.isAbsolute(userDir) && await exists(userDir);
  const schemas=[];
  if(userValid){
    try {
      const config=await readYaml(path.join(userDir,'build','default.yaml'));
      for(const entry of config.schema_list || []){
        const id=entry.schema;if(typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id))continue;
        try {const schema=await readYaml(path.join(userDir,'build',`${id}.schema.yaml`));schemas.push({id,name:schema.schema?.name||id,dictionary:schema.translator?.user_dict||schema.translator?.dictionary||null,capability:'只读识别',dependencies:schema.schema?.dependencies||[]});}
        catch{schemas.push({id,name:id,capability:'配置无法读取',dependencies:[]});}
      }
    }catch{warnings.push('有效配置不可读取；请检查输入法是否已成功部署');}
  }
  return {state:picked.ambiguous?'ambiguous':picked.selected && userValid?'detected':'not_found',userDir:userDir||'',userSource:custom?'注册表 RimeUserDir':'当前用户 AppData 默认目录',installDir:picked.selected?.dir||'',running:!!picked.selected?.running,candidates,schemas,warnings,checkedAt:new Date().toISOString(),mode:'只读检测'};
}
