import { contextBridge, ipcRenderer } from 'electron';
import { type Bridge, type BridgeEvent, CHANNEL } from './bridge.ts';

const bridge: Bridge = {
  call: (method, ...args) => ipcRenderer.invoke(CHANNEL.call, method, args),
  onEvent: (listener) => {
    ipcRenderer.on(CHANNEL.event, (_e, event: BridgeEvent) => listener(event));
    ipcRenderer.send(CHANNEL.ready);
  },
  toggleFullScreen: () => ipcRenderer.send(CHANNEL.fullScreen),
};

contextBridge.exposeInMainWorld('ym', bridge);
