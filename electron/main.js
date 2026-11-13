const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let win = null, flushed = false, updateState = { state: 'none' };

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#87ceeb', autoHideMenuBar: true, title: 'Campground Builder', icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  Menu.setApplicationMenu(null);
  // Les fichiers du jeu sont dans l'application ; la session et les sauvegardes locales (localStorage)
  // sont dans le dossier utilisateur (userData) : une mise à jour ne les touche jamais.
  win.loadFile(path.join(__dirname, '..', 'game', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });

  // À la fermeture : on demande au jeu de synchroniser (3 s maximum), puis on quitte.
  win.on('close', e => {
    if (flushed) return;
    e.preventDefault();
    win.webContents.send('app:flush');
    setTimeout(() => { flushed = true; if (win && !win.isDestroyed()) win.close(); }, 3000);
  });
  win.on('closed', () => { win = null; });
}

function pushUpdate(s) { updateState = s; if (win && !win.isDestroyed()) win.webContents.send('update:state', s); }

function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', i => pushUpdate({ state: 'downloading', version: i.version }));
  autoUpdater.on('update-downloaded', i => pushUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('error', err => console.error('Mise à jour :', err && err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check(); setInterval(check, 4 * 60 * 60 * 1000);
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:get', () => updateState);
ipcMain.on('app:flushed', () => { flushed = true; if (win && !win.isDestroyed()) win.close(); });
ipcMain.on('update:install', () => { flushed = true; autoUpdater.quitAndInstall(false, true); });

app.whenReady().then(() => { createWindow(); setupUpdater(); });
app.on('window-all-closed', () => app.quit());
