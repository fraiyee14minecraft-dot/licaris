import {readFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {getLauncherDataDir,getMinecraftInstanceDir} from './installPaths';
const record=()=>path.join(getLauncherDataDir(),'running-game.json');
export async function rememberGame(pid:number){await writeFile(record(),JSON.stringify({pid}));}
export async function forgetGame(pid:number){const value=await readFile(record(),'utf8').then(JSON.parse).catch(()=>null);if(value?.pid===pid)await rm(record(),{force:true});}
export async function isManagedGameRunning():Promise<boolean>{
 const value=await readFile(record(),'utf8').then(JSON.parse).catch(()=>null);if(!Number.isSafeInteger(value?.pid)||value.pid<=0)return false;
 try{process.kill(value.pid,0);}catch{await forgetGame(value.pid);return false;}
 if(process.platform!=='win32')return true;
 const instance=getMinecraftInstanceDir().replace(/'/g,"''");
 const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${value.pid}'; if($p -and $p.Name -match '^java(w)?\\.exe$' -and $p.CommandLine.Contains('${instance}')){'running'}else{'stopped'}`;
 try{const r=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:8000});if(r.stdout.trim()==='running')return true;await forgetGame(value.pid);return false;}catch{return true;}
}
