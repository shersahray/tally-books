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
  'This computer already has books in Tally Books. They stay here whichever you choose.': 'Cet ordinateur contient déjà des livres Tally Books. Ils restent ici, quel que soit votre choix.',
  'Use this computer': 'Utiliser cet ordinateur',
  'Back to my books': 'Retour à mes livres',
  'Can’t reach your office server': 'Impossible de joindre le serveur du bureau',
  'Tally Books tried': 'Tally Books a essayé',
  'Your books are safe on the server. Once this computer can reach it again, everything is where you left it.': 'Vos livres sont en sécurité sur le serveur. Dès que cet ordinateur pourra le joindre, tout sera comme vous l’avez laissé.',
  'Try again': 'Réessayer',
  'Change server': 'Changer de serveur',
  // Messages from the app
  'Enter your server’s address.': 'Saisissez l’adresse de votre serveur.',
  'That isn’t a web address. It looks like https://books.yourfirm.ca': 'Ce n’est pas une adresse Web. Elle ressemble à https://livres.votrecabinet.ca',
  'The address has to start with https:// so passwords and the books travel encrypted.': 'L’adresse doit commencer par https:// pour que les mots de passe et les livres circulent chiffrés.',
  'Leave the user name and password out of the address. You sign in after connecting.': 'N’incluez pas le nom d’utilisateur ni le mot de passe dans l’adresse. Vous vous connectez ensuite.',
  'Something answered at that address, but it isn’t Tally Books. Check the address.': 'Quelque chose répond à cette adresse, mais ce n’est pas Tally Books. Vérifiez l’adresse.',
  'The server’s security certificate isn’t valid, so the app won’t connect. Ask whoever set up the server to check its HTTPS certificate.': 'Le certificat de sécurité du serveur n’est pas valide, alors l’application ne s’y connecte pas. Demandez à la personne qui a installé le serveur de vérifier son certificat HTTPS.',
  'Couldn’t find a server with that address. Check the spelling, and that you’re connected to the internet or the office VPN.': 'Aucun serveur trouvé à cette adresse. Vérifiez l’orthographe et que vous êtes connecté à Internet ou au RPV du bureau.',
  'The server didn’t answer. It may be off, or this computer can’t reach it (check the internet or the office VPN).': 'Le serveur n’a pas répondu. Il est peut-être éteint, ou cet ordinateur ne peut pas le joindre (vérifiez Internet ou le RPV du bureau).',
  'This computer isn’t connected to the internet.': 'Cet ordinateur n’est pas connecté à Internet.',
  'The server sent the app to a different address. Check the server address.': 'Le serveur a envoyé l’application vers une autre adresse. Vérifiez l’adresse du serveur.',
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
  const page = new URLSearchParams(location.search).get('page') === 'offline' ? 'offline' : 'setup';
  $(page).hidden = false;
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
  $('srv').focus();
})();
