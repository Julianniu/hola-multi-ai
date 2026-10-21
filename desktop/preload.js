// 桌面版给页面开的一个小口子：页面只能通过这里跟外壳说话（换标题栏颜色、控制内置浏览器）。
// 页面里用 window.holaDesktop 判断"是不是在桌面版里"；不在（网页版、压缩包版、老版本外壳）就没有这个对象，功能自动不显示。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('holaDesktop', {
  shell: 2, // 外壳能力的版本：1.1 起有标题栏和内置浏览器
  platform: process.platform,
  setTitleBarColors: (bg, fg) => ipcRenderer.send('hola:titlebar', { bg: String(bg), fg: String(fg) }),
  // 有事等老板（比如队友要点网页）而 Hola 不在前台：任务栏图标闪一闪
  attention: () => ipcRenderer.send('hola:attention'),
  browser: {
    // 告诉外壳浏览器区域在窗口里的位置（外壳把真正的网页摆在那儿）；null = 收起
    setBounds: (rect) => ipcRenderer.send('hola:browser-bounds', rect),
    open: (url) => ipcRenderer.invoke('hola:browser', { op: 'open', url: String(url) }),
    back: () => ipcRenderer.invoke('hola:browser', { op: 'back' }),
    forward: () => ipcRenderer.invoke('hola:browser', { op: 'forward' }),
    reload: () => ipcRenderer.invoke('hola:browser', { op: 'reload' }),
    state: () => ipcRenderer.invoke('hola:browser', { op: 'state' }),
    onState: (fn) => ipcRenderer.on('hola:browser-state', (_, s) => fn(s)),
  },
});
