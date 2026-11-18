// Sandboxed preload for the desktop shell. It exposes exactly two constants to
// the console: a flag marking this window as the desktop shell, and a narrow
// "notify" bridge used for new-proposal notifications (no Node.js/Electron API
// leaks; the main process validates and displays the notification via the tray).
const { contextBridge, ipcRenderer } = require('electron');

function sendNotification(title, body) {
  try {
    ipcRenderer.send('sag:notify', {
      title: String(title).slice(0, 120),
      body: String(body).slice(0, 300),
    });
  } catch {
    // Notifications are best effort.
  }
}

try {
  contextBridge.exposeInMainWorld('sagDesktop', {
    shell: true,
    notify: sendNotification,
  });
} catch {
  // A host without contextBridge: the console keeps in-page banners only.
}
