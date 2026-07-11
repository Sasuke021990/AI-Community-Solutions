import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { openDatabase, createRepositories, LmStudioClient, ConcurrencyLimiter } from '@acs/core';
import { Channels } from '../shared/ipc.js';
import { createIpcRouter } from './ipcRouter.js';
import { RunManager } from './RunManager.js';
import { SettingsStore } from './SettingsStore.js';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      // electron-vite emits the preload bundle as .mjs once @acs/desktop is
      // an ESM package ("type": "module") - the extension is not .js here.
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  });

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');

  const db = openDatabase(join(userDataDir, 'acs.sqlite'));
  const repos = createRepositories(db);
  // Recover from a prior crash/quit before anything else touches the DB.
  repos.runs.markInterrupted();

  const settingsStore = new SettingsStore(join(userDataDir, 'settings.json'), {
    reportsFolder: join(userDataDir, 'reports')
  });

  let lmStudioClient = new LmStudioClient(settingsStore.get().lmStudioBaseUrl);
  const concurrencyLimiter = new ConcurrencyLimiter(settingsStore.get().concurrencyCap);

  // Keep the client/limiter in sync whenever settings change via IPC.
  settingsStore.onChange((s) => {
    lmStudioClient = new LmStudioClient(s.lmStudioBaseUrl);
    concurrencyLimiter.setLimit(s.concurrencyCap);
  });

  const broadcast = (channel: string, payload: unknown) => {
    mainWindow?.webContents.send(channel, payload);
  };

  const runManager = new RunManager(repos, () => lmStudioClient, () => concurrencyLimiter, broadcast);

  const router = createIpcRouter({
    repos,
    getLmStudioClient: () => lmStudioClient,
    runManager,
    settingsStore
  });

  for (const { name } of Object.values(Channels)) {
    ipcMain.handle(name, async (_event, payload: unknown) => router.handle(name, payload));
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
