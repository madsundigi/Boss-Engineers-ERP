'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

/**
 * Boss Engineers ERP — desktop shell. Loads the built React SPA (renderer/) and
 * lets it talk to the ERP API at whatever base URL the user configures on the
 * login screen. webSecurity is disabled so the file:// renderer can call the
 * remote API without CORS friction (standard for a trusted desktop client).
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Boss Engineers ERP',
    backgroundColor: '#f3f4f6',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // External links open in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
