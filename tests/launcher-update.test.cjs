const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {LauncherUpdates}=require('../dist-electron/services/launcherUpdateService');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,overrides={}){
  const driver=new EventEmitter(),calls=[],states=[],logs=[];
  driver.checkForUpdates=async()=>null;
  driver.quitAndInstall=(...args)=>calls.push(args);
  const update=new LauncherUpdates({driver,supported:true,busy:()=>false,gameRunning:async()=>false,
    changed:s=>states.push(s),log:s=>logs.push(s),...overrides});
  t.after(()=>update.dispose());
  return {driver,update,calls,states,logs};
}
test('startup is gated until the installed launcher is checked, with no quit-time installation',async t=>{
  const {driver,update,calls}=fixture(t);
  assert.equal(update.blocking,true);
  assert.equal(driver.autoDownload,true);assert.equal(driver.autoInstallOnAppQuit,false);assert.equal(driver.allowDowngrade,false);
  driver.checkForUpdates=async()=>{driver.emit('update-not-available');return {};};
  await update.start();
  assert.equal(update.snapshot().phase,'current');assert.equal(update.blocking,false);assert.equal(calls.length,0);
});
test('downloaded update automatically installs silently and relaunches exactly once',async t=>{
  const {driver,update,calls,states}=fixture(t);
  driver.checkForUpdates=async()=>{
    driver.emit('update-available',{version:'9.0.0'});
    driver.emit('download-progress',{percent:42});
    driver.emit('update-downloaded',{version:'9.0.0'});
    return {};
  };
  await update.start();await flush();
  assert.ok(states.some(s=>s.phase==='downloading'&&s.percent===42&&s.blocking));
  assert.equal(update.snapshot().phase,'installing');assert.deepEqual(calls,[[true,true]]);
  driver.emit('update-downloaded',{version:'9.0.0'});await update.resume();await update.start();
  assert.equal(calls.length,1);
});
test('a cached installer follows the same automatic path without download progress',async t=>{
  const {driver,update,calls}=fixture(t);
  driver.checkForUpdates=async()=>{driver.emit('update-downloaded',{version:'9.0.0'});return {};};
  await update.start();await flush();assert.deepEqual(calls,[[true,true]]);
});
test('updates wait for an existing Minecraft process then install without a click',async t=>{
  let running=true;
  const {driver,update,calls}=fixture(t,{gameRunning:async()=>running,retryIntervalMs:5});
  driver.emit('update-downloaded',{version:'9.0.0'});await flush();
  assert.equal(update.snapshot().phase,'deferred');assert.equal(calls.length,0);
  running=false;
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.deepEqual(calls,[[true,true]]);
});
test('file and authentication operations finish before an update installs',async t=>{
  let busy=true;
  const {driver,update,calls}=fixture(t,{busy:()=>busy});
  driver.emit('update-downloaded',{version:'9.0.0'});await flush();
  assert.equal(update.snapshot().phase,'deferred');assert.equal(calls.length,0);
  busy=false;await update.resume();assert.deepEqual(calls,[[true,true]]);
});
test('an operation starting during the asynchronous game check cannot be interrupted',async t=>{
  let busy=false,resolve;
  const {driver,update,calls}=fixture(t,{busy:()=>busy,gameRunning:()=>new Promise(r=>resolve=r)});
  driver.emit('update-downloaded',{version:'9.0.0'});
  busy=true;resolve(false);await flush();
  assert.equal(update.snapshot().phase,'deferred');assert.equal(calls.length,0);
});
test('network errors allow using the launcher and retrying the update',async t=>{
  const {driver,update,calls}=fixture(t);
  driver.checkForUpdates=async()=>{throw new Error('offline');};
  await update.start();assert.equal(update.blocking,false);assert.equal(update.snapshot().retryable,true);
  driver.checkForUpdates=async()=>{driver.emit('update-downloaded',{version:'9.0.0'});return {};};
  await update.retry();await flush();assert.deepEqual(calls,[[true,true]]);
});
test('failed or unverified downloads never invoke the installer',async t=>{
  const {driver,update,calls}=fixture(t);
  driver.checkForUpdates=async()=>{
    driver.emit('update-available',{version:'9.0.0'});
    return {downloadPromise:Promise.reject(new Error('checksum mismatch'))};
  };
  await update.start();assert.equal(update.snapshot().phase,'error');assert.equal(update.blocking,false);assert.equal(calls.length,0);
});
test('a stalled startup check releases controls without starting duplicate network checks',async t=>{
  const {driver,update,calls}=fixture(t,{checkTimeoutMs:5});let checks=0,resolve;
  driver.checkForUpdates=()=>{checks++;return new Promise(r=>resolve=r);};
  const pending=update.start();await new Promise(r=>setTimeout(r,25));
  assert.equal(update.snapshot().phase,'error');assert.equal(update.blocking,false);assert.equal(update.snapshot().retryable,false);
  await update.retry();assert.equal(checks,1);assert.equal(calls.length,0);resolve(null);await pending;
});
test('installer failures permit an explicit retry without an automatic restart loop',async t=>{
  const {driver,update,calls}=fixture(t);
  driver.quitAndInstall=()=>{throw new Error('access denied');};
  driver.emit('update-downloaded',{version:'9.0.0'});await flush();
  assert.equal(update.snapshot().phase,'error');assert.equal(update.blocking,false);
  driver.quitAndInstall=(...args)=>calls.push(args);await update.retry();assert.deepEqual(calls,[[true,true]]);
});
test('portable, development and smoke sessions never check or install updates',async t=>{
  const {driver,update,calls}=fixture(t,{supported:false});let checks=0;
  driver.checkForUpdates=async()=>{checks++;return {};};
  await update.start();await update.retry();driver.emit('update-downloaded',{version:'9.0.0'});
  assert.equal(update.blocking,false);assert.equal(checks,0);assert.equal(calls.length,0);
});
test('closing the launcher during a game check cannot start a deferred installer',async t=>{
  let resolve;
  const {driver,update,calls}=fixture(t,{gameRunning:()=>new Promise(r=>resolve=r)});
  driver.emit('update-downloaded',{version:'9.0.0'});update.dispose();resolve(false);await flush();
  assert.equal(calls.length,0);
});
