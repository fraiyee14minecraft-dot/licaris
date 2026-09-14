const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');const path=require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const w=new BrowserWindow({width:960,height:600,useContentSize:true,show:false,backgroundColor:"#070f20",webPreferences:{sandbox:true,contextIsolation:true}});await w.loadFile(path.join(__dirname,'../build/installer-art.html'));await new Promise(r=>setTimeout(r,1500));await fs.writeFile(path.join(__dirname,'../build/installer-art.png'),(await w.webContents.capturePage()).toPNG());app.quit();}).catch(e=>{console.error(e);app.exit(1);});
