// 桌面版给页面开的一个小口子：页面只能通过这里跟外壳说话（换标题栏颜色、控制内置浏览器）。
// 页面里用 window.holaDesktop 判断"是不是在桌面版里"；不在（网页版、压缩包版、老版本外壳）就没有这个对象，功能自动不显示。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('holaDesktop', {
  shell: 4, // 外壳能力的版本：1.1 起有标题栏和内置浏览器；2.0 起有托盘和页面画的更新提示；3.0 起设置里能手动检查更新
  // 外壳 3.0 起：设置里的"检查更新"。check() 返回最后的结果；检查、下载的过程通过 onProgress 推过来
  // 外壳 3.0 起（Windows）：窗口按钮由页面自己画（右上角的玻璃胶囊），通过这里最小化 / 最大化 / 关闭（关闭 = 缩到托盘）
  win: process.platform === 'win32' ? {
    minimize: () => ipcRenderer.send('hola:win', 'min'),
    toggleMaximize: () => ipcRenderer.send('hola:win', 'max'),
    close: () => ipcRenderer.send('hola:win', 'close'),
    state: () => ipcRenderer.invoke('hola:win-state'),
    onState: (fn) => ipcRenderer.on('hola:win-state', (_, s) => fn(s)),
  } : null,
  updates: {
    check: () => ipcRenderer.invoke('hola:update-check'),
    state: () => ipcRenderer.invoke('hola:update-state'),
    onProgress: (fn) => ipcRenderer.on('hola:update-progress', (_, u) => fn(u)),
  },
  platform: process.platform,
  setTitleBarColors: (bg, fg) => ipcRenderer.send('hola:titlebar', { bg: String(bg), fg: String(fg) }),
  // 有事等老板（比如队友要点网页）而 Hola 不在前台：任务栏图标闪一闪
  attention: () => ipcRenderer.send('hola:attention'),
  // 外壳 2.0 起：更新提示交给页面自己画（页面先说一声自己会画）
  ui: (info) => ipcRenderer.send('hola:ui', { updates: !!(info && info.updates) }),
  onUpdate: (fn) => ipcRenderer.on('hola:update', (_, u) => fn(u)),
  updateAnswer: (a) => ipcRenderer.send('hola:update-answer', String(a)),
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
