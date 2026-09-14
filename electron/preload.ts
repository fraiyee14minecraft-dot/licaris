import { contextBridge, ipcRenderer } from 'electron';
const allowed = new Set(['state','ui-ready','logs','save-settings','login','logout','switch-account','window-minimize','window-close','retry-launcher-update','install','play','server-status','open-folder','open-pack','repair','client-mods','set-client-mod','account-avatar','skins','import-skin','apply-skin','delete-skin','shaders','install-shader','select-shader','copy-diagnostics','open-link']);
const events = new Set(['progress','busy','auth','log','running','notice','launcher-update']);
contextBridge.exposeInMainWorld('cobblemon', {
  invoke: (channel: string, input?: unknown) => {
    if (!allowed.has(channel)) return Promise.reject(new Error('Action inconnue.'));
    return ipcRenderer.invoke(channel,input);
  },
  on: (channel: string, callback: (payload: unknown) => void) => {
    if (!events.has(channel)) throw new Error('Événement inconnu.');
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on(channel,listener);
    return () => ipcRenderer.removeListener(channel,listener);
  }
});
