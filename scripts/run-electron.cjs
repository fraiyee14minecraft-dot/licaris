const {spawn}=require('node:child_process');
const env={...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),['.',...process.argv.slice(2)],{env,cwd:require('node:path').join(__dirname,'..'),stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error);process.exit(1);});
child.on('exit',code=>process.exit(code??1));
