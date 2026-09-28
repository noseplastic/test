// 트레이너·오버레이 창에 노출하는 최소 API (window.vatDesktop)
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...args));
};

contextBridge.exposeInMainWorld('vatDesktop', {
  getState: () => ipcRenderer.invoke('overlay:get-state'),
  setConfig: (partial) => ipcRenderer.invoke('overlay:set-config', partial),
  pushCoach: (card) => ipcRenderer.send('coach:push', card),
  reportSize: (w, h) => ipcRenderer.send('overlay:size', w, h),
  onCoach: on('overlay:coach'),
  onConfig: on('overlay:config'),
  onNextTip: on('overlay:next-tip'),
  onMoveMode: on('overlay:move'),
  // 리플레이 분석
  listReplays: () => ipcRenderer.invoke('replay:list'),
  pickReplay: () => ipcRenderer.invoke('replay:pick'),
  exportReplay: (vrfPath) => ipcRenderer.invoke('replay:export', vrfPath),
  readFileSlice: (path, offset, length) => ipcRenderer.invoke('replay:read', path, offset, length),
});
