import {spawnSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
export const repository='fraiyee14minecraft-dot/licaris';
export const apiBase=`https://api.github.com/repos/${repository}`;
let credential;
function token(){
 if(credential)return credential;
 if(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)return credential=process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
 const r=spawnSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});
 const line=(r.stdout||'').split('\n').find(l=>l.startsWith('password='));
 if(!line)throw new Error('Connexion GitHub absente. Connectez Git Credential Manager sur ce PC avant de publier.');
 return credential=line.slice(9).trim();
}
export async function request(url,options={}){
 if(!['api.github.com','uploads.github.com'].includes(new URL(url).hostname))throw new Error('Destination GitHub refusée.');
 const response=await fetch(url,{...options,signal:AbortSignal.timeout(15*60*1000),headers:{Accept:'application/vnd.github+json','User-Agent':'Licaris-publisher','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${token()}`,...options.headers}});
 if(!response.ok){const err=await response.json().catch(()=>({}));throw new Error(`GitHub HTTP ${response.status}: ${err.message||'Requête refusée'}`);}
 return response.status===204?null:response.json();
}
export function jsonRequest(url,method,body){return request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
export async function upload(release,name,file){
 const size=(await stat(file)).size;if(size>=2*1024**3)throw new Error(`Fichier trop volumineux pour GitHub : ${name}`);
 const assets=await request(`${apiBase}/releases/${release.id}/assets?per_page=100`);
 const existing=assets.find(a=>a.name===name);if(existing) return existing;
 const url=release.upload_url.split('{')[0]+'?name='+encodeURIComponent(name);
 return request(url,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(size)},body:createReadStream(file),duplex:'half'});
}
export async function putPointer(name,data,message){
 const endpoint=`${apiBase}/contents/distribution/${name}`;
 const existing=await fetch(endpoint,{headers:{Accept:'application/vnd.github+json','User-Agent':'Licaris-publisher'}}).then(r=>r.status===404?null:r.json());
 return jsonRequest(endpoint,'PUT',{message,content:Buffer.from(JSON.stringify(data,null,2)+'\n').toString('base64'),...(existing?.sha?{sha:existing.sha}:{})});
}
