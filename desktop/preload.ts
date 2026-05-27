import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("flowApp", {
  platform: process.platform,
  ping: () => ipcRenderer.invoke("flow:ping"),
  openExternal: (url: string) => ipcRenderer.invoke("flow:openExternal", url),
});
