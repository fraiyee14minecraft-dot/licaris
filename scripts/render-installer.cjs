const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');const path=require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const w=new BrowserWindow({width:960,height:600,useContentSize:true,show:false,backgroundColor:'#071425',webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  await w.loadFile(path.join(__dirname,'../build/installer-art.html'));
  await w.webContents.executeJavaScript('Promise.all([...document.images].map(i=>i.decode()))');
  await fs.writeFile(path.join(__dirname,'../build/installer-art.png'),(await w.webContents.capturePage()).toPNG());
  app.quit();
}).catch(e=>{console.error(e);app.exit(1);});
