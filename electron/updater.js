'use strict';
/* Automatic updates for the Windows desktop app.
 *
 * New versions are GitHub releases (see .github/workflows/release.yml). The app checks when it starts and
 * every 4 hours, downloads a new version in the background, and asks to restart; otherwise it installs
 * the next time Sumlora is closed. Only installers signed with the same certificate as this copy are
 * installed (electron-updater compares the publisher name), and updates are only turned on in signed
 * builds, so an update can't come from anyone else. Books kept on this computer are backed up first.
 */
const fs = require('node:fs');
const path = require('node:path');

const CHECK_EVERY = 4 * 60 * 60 * 1000;

/** GitHub's answer when no release (or no installer for this system) has been published yet. */
const noRelease = msg => /\b404\b|Cannot find latest|No published versions|Unable to find latest version|latest\.yml/i.test(msg);

/** What the build recorded about itself (written by the build workflow when it signs the installer). */
function buildInfo(dir = __dirname) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8')); } catch { return {}; }
}

/** Should this copy update itself? Only the installed, signed Windows app. */
function updatesOn({ isPackaged, platform = process.platform, info = buildInfo() }) {
  return !!(isPackaged && platform === 'win32' && info.signed && info.publisher);
}

/**
 * @param {object} o
 * @param {object} o.autoUpdater  electron-updater's autoUpdater (injected for tests)
 * @param {object} o.dialog       Electron dialog
 * @param {() => object} o.window the main window
 * @param {() => object|null} o.localServer  the private server when books are on this computer (for the backup)
 * @param {boolean} o.fr          French messages
 * @param {Function} [o.log]
 */
function setupUpdates({ autoUpdater, dialog, window, localServer, fr = false, log = () => {} }) {
  const L = (en, f) => (fr ? f : en);
  let asked = false, checking = false, manual = false, timer = null, downloaded = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  const backup = () => {
    // Books on this computer: a fresh backup before the program changes.
    try { const s = localServer(); if (s && s.backups) s.backups.run(); } catch (e) { log('backup before update failed: ' + e.message); }
  };

  autoUpdater.on('error', err => {
    checking = false;
    const msg = String((err && err.message) || '');
    log('update error: ' + msg);
    if (!manual) return;
    manual = false;
    const offline = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION|net::/i.test(msg);
    // No release published yet (GitHub answers "not found"): there's simply nothing newer, not a connection problem.
    if (!offline && noRelease(msg)) { dialog.showMessageBox(window(), { type: 'info', message: L('Sumlora is up to date.', 'Sumlora est à jour.'), detail: L('No newer version has been published.', 'Aucune version plus récente n’a été publiée.') }).catch(() => {}); return; }
    dialog.showMessageBox(window(), { type: 'warning', message: L('Couldn’t check for updates.', 'Impossible de vérifier les mises à jour.'),
      detail: offline ? L('Check the internet connection and try again later.', 'Vérifiez la connexion Internet et réessayez plus tard.')
        : L('The update server didn’t answer as expected. Try again later.', 'Le serveur de mises à jour n’a pas répondu comme prévu. Réessayez plus tard.') + '\n\n' + msg.split('\n')[0].slice(0, 200) }).catch(() => {});
  });
  autoUpdater.on('update-not-available', () => {
    checking = false;
    if (manual) { manual = false; dialog.showMessageBox(window(), { type: 'info', message: L('Sumlora is up to date.', 'Sumlora est à jour.') }).catch(() => {}); }
  });
  autoUpdater.on('update-available', () => { manual = false; });
  autoUpdater.on('update-downloaded', async info => {
    checking = false; downloaded = true;
    if (asked) return;
    asked = true;
    const v = info && info.version ? info.version : '';
    const r = await dialog.showMessageBox(window(), {
      type: 'info', buttons: [L('Restart now', 'Redémarrer maintenant'), L('Later', 'Plus tard')], defaultId: 0, cancelId: 1,
      message: L(`Sumlora ${v} is ready`, `Sumlora ${v} est prête`),
      detail: L('Restart to update. It takes a few seconds and your books are kept. If you choose Later, it updates the next time you close Sumlora.',
        'Redémarrez pour faire la mise à jour. Cela prend quelques secondes et vos livres sont conservés. Si vous choisissez Plus tard, elle se fera à la prochaine fermeture de Sumlora.'),
    }).catch(() => ({ response: 1 }));
    if (r.response === 0) { backup(); autoUpdater.quitAndInstall(false, true); }
  });
  autoUpdater.on('before-quit-for-update', backup);

  const check = (byHand = false) => {
    if (checking) return;
    checking = true; manual = byHand;
    Promise.resolve(autoUpdater.checkForUpdates()).catch(() => { checking = false; });
  };
  check();
  timer = setInterval(() => check(), CHECK_EVERY);
  if (timer.unref) timer.unref();
  // An update waiting for Sumlora to close: back up first (called from the app's before-quit).
  const beforeQuit = () => { if (downloaded) backup(); };
  return { check: () => check(true), stop: () => clearInterval(timer), beforeQuit };
}

module.exports = { setupUpdates, updatesOn, buildInfo, noRelease };
