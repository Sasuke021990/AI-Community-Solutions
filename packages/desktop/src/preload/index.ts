import { contextBridge } from 'electron';

const api = {};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('acs', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.acs = api;
}
