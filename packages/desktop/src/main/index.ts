import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import { join } from 'path';
import { openDatabase, createRepositories, LmStudioClient, ConcurrencyLimiter } from '@acs/core';
import { Channels } from '../shared/ipc.js';
import { createIpcRouter } from './ipcRouter.js';
import { RunManager } from './RunManager.js';
import { SettingsStore } from './SettingsStore.js';
import { writeRunPdf } from './PdfWriter.js';

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

  // Renderer console output (including uncaught React errors) is otherwise
  // invisible outside devtools - forward it into the main process log so
  // renderer-side failures show up wherever the app's own logs go.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // No File/Edit/View/Window/Help bar in the real app. The menu (and its
  // devtools/reload shortcuts) is kept only when running against the
  // electron-vite dev server, where devtools access matters.
  if (!process.env['ELECTRON_RENDERER_URL']) {
    Menu.setApplicationMenu(null);
  }

  const userDataDir = app.getPath('userData');

  const db = openDatabase(join(userDataDir, 'acs.sqlite'));
  const repos = createRepositories(db);
  // Recover from a prior crash/quit before anything else touches the DB.
  repos.runs.markInterrupted();

  const settingsStore = new SettingsStore(join(userDataDir, 'settings.json'), {
    reportsFolder: join(userDataDir, 'reports')
  });

  const buildClient = (s = settingsStore.get()) =>
    new LmStudioClient(s.lmStudioBaseUrl, {
      firstTokenTimeoutMs: s.firstTokenTimeoutSec * 1000,
      interTokenTimeoutMs: s.interTokenTimeoutSec * 1000
    });

  let lmStudioClient = buildClient();
  const concurrencyLimiter = new ConcurrencyLimiter(settingsStore.get().concurrencyCap);

  // Keep the client/limiter in sync whenever settings change via IPC.
  settingsStore.onChange((s) => {
    lmStudioClient = buildClient(s);
    concurrencyLimiter.setLimit(s.concurrencyCap);
  });

  const broadcast = (channel: string, payload: unknown) => {
    mainWindow?.webContents.send(channel, payload);
  };

  const runManager = new RunManager(
    repos,
    () => lmStudioClient,
    () => concurrencyLimiter,
    broadcast,
    () => settingsStore.get().reportsFolder,
    writeRunPdf
  );

  const router = createIpcRouter({
    repos,
    getLmStudioClient: () => lmStudioClient,
    runManager,
    settingsStore,
    openPath: (p) => shell.openPath(p),
    showInFolder: (p) => shell.showItemInFolder(p)
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
