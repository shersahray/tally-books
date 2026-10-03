'use strict';
// The desktop app's "where are your books?" page, and the page shown when the office server can't be reached.
const FR = {
  'Where are your books?': 'Où sont vos livres?',
  'You can change this later from File → Where the books are.': 'Vous pourrez changer ce choix plus tard dans Fichier → Où sont les livres.',
  'On our office server': 'Sur le serveur du bureau',
  'Now': 'Actuel',
  'Everyone in your offices works in the same books, saved on your firm’s server. Nothing is kept on this computer.': 'Tout le monde dans vos bureaux travaille dans les mêmes livres, enregistrés sur le serveur de votre cabinet. Rien n’est conservé sur cet ordinateur.',
  'Server address': 'Adresse du serveur',
  'Ask whoever set up the server. It starts with https://.': 'Demandez-la à la personne qui a installé le serveur. Elle commence par https://.',
  'Connect': 'Se connecter',
  'Connecting…': 'Connexion…',
  'On this computer': 'Sur cet ordinateur',
  'Just you, on this computer. The books are saved here and backed up every day. Nobody else can open them.': 'Vous seul, sur cet ordinateur. Les livres sont enregistrés ici et sauvegardés chaque jour. Personne d’autre ne peut les ouvrir.',
  'This computer already has books in Sumlora. They stay here whichever you choose.': 'Cet ordinateur contient déjà des livres Sumlora. Ils restent ici, quel que soit votre choix.',
  'Use this computer': 'Utiliser cet ordinateur',
  'Back to my books': 'Retour à mes livres',
  'Can’t reach your office server': 'Impossible de joindre le serveur du bureau',
  'Sumlora tried': 'Sumlora a essayé',
  'Your books are safe on the server. Once this computer can reach it again, everything is where you left it.': 'Vos livres sont en sécurité sur le serveur. Dès que cet ordinateur pourra le joindre, tout sera comme vous l’avez laissé.',
  'Try again': 'Réessayer',
  'Change server': 'Changer de serveur',
  // Messages from the app
  'Enter your server’s address.': 'Saisissez l’adresse de votre serveur.',
  'That isn’t a web address. It looks like https://books.yourfirm.ca': 'Ce n’est pas une adresse Web. Elle ressemble à https://livres.votrecabinet.ca',
  'The address has to start with https:// so passwords and the books travel encrypted.': 'L’adresse doit commencer par https:// pour que les mots de passe et les livres circulent chiffrés.',
  'Leave the user name and password out of the address. You sign in after connecting.': 'N’incluez pas le nom d’utilisateur ni le mot de passe dans l’adresse. Vous vous connectez ensuite.',
  'Something answered at that address, but it isn’t Sumlora. Check the address.': 'Quelque chose répond à cette adresse, mais ce n’est pas Sumlora. Vérifiez l’adresse.',
  'The server’s security certificate isn’t valid, so the app won’t connect. Ask whoever set up the server to check its HTTPS certificate.': 'Le certificat de sécurité du serveur n’est pas valide, alors l’application ne s’y connecte pas. Demandez à la personne qui a installé le serveur de vérifier son certificat HTTPS.',
  'Couldn’t find a server with that address. Check the spelling, and that you’re connected to the internet or the office VPN.': 'Aucun serveur trouvé à cette adresse. Vérifiez l’orthographe et que vous êtes connecté à Internet ou au RPV du bureau.',
  'The server didn’t answer. It may be off, or this computer can’t reach it (check the internet or the office VPN).': 'Le serveur n’a pas répondu. Il est peut-être éteint, ou cet ordinateur ne peut pas le joindre (vérifiez Internet ou le RPV du bureau).',
  'This computer isn’t connected to the internet.': 'Cet ordinateur n’est pas connecté à Internet.',
  'The server sent the app to a different address. Check the server address.': 'Le serveur a envoyé l’application vers une autre adresse. Vérifiez l’adresse du serveur.',
  // Choosing the folder for the books
  'Books folder:': 'Dossier des livres :',
  'Choose folder…': 'Choisir le dossier…',
  'Can’t find your books folder': 'Impossible de trouver le dossier des livres',
  'The folder may be on a drive that isn’t connected right now. Connect it and try again, or choose the folder where the books are now.': 'Le dossier est peut-être sur un disque qui n’est pas branché. Branchez-le et réessayez, ou choisissez le dossier où se trouvent maintenant les livres.',
  'Other choices': 'Autres choix',
  'The books are already in this folder.': 'Les livres sont déjà dans ce dossier.',
  'This folder is synced with a cloud service (OneDrive, Google Drive, Dropbox or iCloud). Syncing can damage books while they’re open and being saved. Choose a folder on this computer, and send the daily backups to the cloud folder instead (Settings → Backups).': 'Ce dossier est synchronisé avec un service infonuagique (OneDrive, Google Drive, Dropbox ou iCloud). La synchronisation peut endommager les livres pendant qu’ils sont ouverts et enregistrés. Choisissez un dossier sur cet ordinateur et envoyez plutôt les sauvegardes quotidiennes dans le dossier infonuagique (Paramètres → Sauvegardes).',
  'This folder is on a network drive. If the connection drops while the books are being saved they can be damaged, and two computers opening the same books at once will damage them. To share books between people or offices, use the office server instead.': 'Ce dossier est sur un lecteur réseau. Si la connexion coupe pendant l’enregistrement, les livres peuvent être endommagés, et deux ordinateurs qui ouvrent les mêmes livres en même temps les endommageront. Pour partager des livres entre personnes ou bureaux, utilisez plutôt le serveur du bureau.',
  'That folder already has books in Sumlora. Open them? The books in the current folder stay where they are.': 'Ce dossier contient déjà des livres Sumlora. Les ouvrir? Les livres du dossier actuel restent où ils sont.',
  'Open the books in that folder': 'Ouvrir les livres de ce dossier',
  'Your books will be moved to:': 'Vos livres seront déplacés vers :',
  'They’re copied, every file is checked, they’re opened from the new folder, and only then removed from the old one.': 'Ils sont copiés, chaque fichier est vérifié, ils sont ouverts depuis le nouveau dossier, et seulement ensuite retirés de l’ancien.',
  'Move the books here': 'Déplacer les livres ici',
  'There are no books in that folder yet. New, empty books will start there:': 'Ce dossier ne contient pas encore de livres. De nouveaux livres vides y commenceront :',
  'Use this folder': 'Utiliser ce dossier',
  'Cancel': 'Annuler',
  'The books are being moved. Wait a moment.': 'Les livres sont en cours de déplacement. Patientez un instant.',
  'Moving the books…': 'Déplacement des livres…',
  'Choose a folder.': 'Choisissez un dossier.',
  'That folder doesn’t exist any more. Choose another.': 'Ce dossier n’existe plus. Choisissez-en un autre.',
  'Sumlora can’t save in that folder. Choose one you can save files in.': 'Sumlora ne peut pas enregistrer dans ce dossier. Choisissez un dossier où vous pouvez enregistrer des fichiers.',
  'That folder has part of a Sumlora data folder in it. Choose an empty folder.': 'Ce dossier contient une partie d’un dossier de données Sumlora. Choisissez un dossier vide.',
  'The books couldn’t be opened from the new folder, so they stay where they were.': 'Les livres n’ont pas pu être ouverts depuis le nouveau dossier, alors ils restent où ils étaient.',
  'The books couldn’t be moved, so they stay where they were.': 'Les livres n’ont pas pu être déplacés, alors ils restent où ils étaient.',
};
let lang = 'en';
try { const l = localStorage.getItem('tb_lang'); lang = l === 'fr' || l === 'en' ? l : (navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'; } catch { lang = (navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'; }
const T = s => (lang === 'fr' && FR[s]) || s;
document.documentElement.lang = lang;
for (const el of document.querySelectorAll('[data-t]')) el.textContent = T(el.textContent.trim());
const $ = id => document.getElementById(id);
const D = window.tallyDesktop;

(async () => {
  const info = await D.info();
  const want = new URLSearchParams(location.search).get('page');
  const page = want === 'offline' || want === 'missing' ? want : 'setup';
  $(page).hidden = false;
  if (page === 'missing') {
    $('missPath').textContent = info.dataDir;
    $('missRetry').onclick = async () => { $('missRetry').disabled = true; await D.retry(); $('missRetry').disabled = false; };
    $('missPick').onclick = () => chooseFolder($('missErr'), $('missPanel'));
    $('missChange').onclick = () => D.change();
    $('missRetry').focus();
    return;
  }
  if (page === 'offline') {
    $('offUrl').textContent = info.serverUrl;
    $('offErr').textContent = T(info.error || '');
    $('retryBtn').onclick = async () => { $('retryBtn').disabled = true; $('retryBtn').textContent = T('Connecting…'); await D.retry(); };
    $('changeBtn').onclick = () => D.change();
    $('retryBtn').focus();
    return;
  }
  $('srv').value = info.serverUrl || info.lastServerUrl || '';
  $('localHas').hidden = !info.hasLocalBooks;
  if (info.mode) {
    $('backRow').hidden = false;
    $(info.mode === 'server' ? 'nowServer' : 'nowLocal').hidden = false;
    $(info.mode === 'server' ? 'cardServer' : 'cardLocal').classList.add('on');
    $('backBtn').onclick = () => D.retry();
  }
  $('srvForm').onsubmit = async e => {
    e.preventDefault();
    const b = $('srvBtn'); b.disabled = true; b.textContent = T('Connecting…'); $('srvErr').textContent = '';
    const r = await D.useServer($('srv').value);
    if (r && r.error) { $('srvErr').textContent = T(r.error); b.disabled = false; b.textContent = T('Connect'); $('srv').focus(); }
  };
  $('localBtn').onclick = async () => { $('localBtn').disabled = true; await D.useLocal(); };
  $('dirPath').textContent = info.dataDir || '';
  $('dirBtn').onclick = () => chooseFolder($('dirErr'), $('dirPanel'));
  // Office-server users keep no books here, so there's no folder to choose.
  if (info.mode === 'server') { $('dirBtn').hidden = true; $('dirPath').parentElement.hidden = true; }
  $('srv').focus();
})();

/** Pick a folder in the system's folder window, then say what will happen (and any risk) before doing it. */
async function chooseFolder(errEl, panel) {
  errEl.textContent = ''; panel.hidden = true; panel.textContent = '';
  const r = await D.pickFolder();
  if (!r || r.cancel) return;
  if (r.error) { errEl.textContent = T(r.error); return; }
  if (r.same) { errEl.textContent = T('The books are already in this folder.'); return; }
  const el = (tag, text, cls) => { const x = document.createElement(tag); if (text) x.textContent = text; if (cls) x.className = cls; return x; };
  const para = (text, cls) => panel.appendChild(el('div', text, cls));
  for (const w of r.warnings || []) {
    para(T(w === 'sync'
      ? 'This folder is synced with a cloud service (OneDrive, Google Drive, Dropbox or iCloud). Syncing can damage books while they’re open and being saved. Choose a folder on this computer, and send the daily backups to the cloud folder instead (Settings → Backups).'
      : 'This folder is on a network drive. If the connection drops while the books are being saved they can be damaged, and two computers opening the same books at once will damage them. To share books between people or offices, use the office server instead.'), 'warn');
  }
  let how = 'move', label;
  const where = el('div'); const b = el('b', r.target, 'path'); b.setAttribute('translate', 'no');
  if (r.booksThere) {
    how = 'open'; label = 'Open the books in that folder';
    para(T('That folder already has books in Sumlora. Open them? The books in the current folder stay where they are.'));
    where.appendChild(b); panel.appendChild(where);
  } else if (r.hasBooks) {
    label = 'Move the books here';
    where.append(T('Your books will be moved to:') + ' ', b); panel.appendChild(where);
    para(T('They’re copied, every file is checked, they’re opened from the new folder, and only then removed from the old one.'), 'hint');
  } else {
    label = 'Use this folder';
    where.append(T('There are no books in that folder yet. New, empty books will start there:') + ' ', b); panel.appendChild(where);
  }
  const row = el('div', '', 'row'), go = el('button', T(label), (r.warnings || []).length ? '' : 'primary'), no = el('button', T('Cancel'));
  go.type = no.type = 'button'; row.append(go, no); panel.appendChild(row); panel.hidden = false;
  no.onclick = () => { panel.hidden = true; panel.textContent = ''; };
  const pickers = [...document.querySelectorAll('#dirBtn, #missPick, #localBtn, #missRetry')];
  go.onclick = async () => {
    go.disabled = no.disabled = true; pickers.forEach(x => { x.disabled = true; }); if (how === 'move' && r.hasBooks) go.textContent = T('Moving the books…');
    const res = await D.useFolder(how);
    if (res && res.error) {
      go.disabled = no.disabled = false; pickers.forEach(x => { x.disabled = false; }); go.textContent = T(label);
      errEl.textContent = res.error.startsWith('The books couldn’t be moved') ? T('The books couldn’t be moved, so they stay where they were.') + ' ' + res.error.replace(/^The books couldn’t be moved, so they stay where they were\. /, '') : T(res.error);
    }
  };
  go.focus();
}
