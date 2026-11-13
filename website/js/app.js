// supabase-js est chargé en local (js/vendor/supabase.js) : plus de dépendance à un CDN externe.
const createClient = window.supabase && window.supabase.createClient;
if (!createClient) { document.addEventListener('DOMContentLoaded', () => { const m = document.getElementById('m'); if (m) { m.className = 'msg err'; m.textContent = 'Le module de connexion n\'a pas pu se charger (js/vendor/supabase.js manquant).'; } }); throw new Error('supabase-js introuvable'); }
import { CONFIG } from './config.js';

export { CONFIG };
export const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

export const $ = (s, r = document) => r.querySelector(s);
export const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtDate = d => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export function frError(e) {
  const m = (e && e.message) || String(e || '');
  if (/Invalid login/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/not confirmed/i.test(m)) return "Adresse e-mail non confirmée : clique sur le lien reçu par e-mail.";
  if (/already registered|already been registered/i.test(m)) return 'Un compte existe déjà avec cet e-mail.';
  if (/at least 6|Password should/i.test(m)) return 'Mot de passe trop court (6 caractères minimum).';
  if (/rate limit|too many/i.test(m)) return "Limite d'e-mails Supabase atteinte (environ 2 par heure en gratuit). Réessaie plus tard ou désactive « Confirm email » dans Supabase.";
  if (/valid email|invalid format/i.test(m)) return 'Adresse e-mail invalide.';
  if (/Database error/i.test(m)) return "Inscription impossible côté base de données : le SQL (database/schema.sql) n'a sans doute pas été exécuté dans Supabase. Détail : " + m;
  if (/fetch|network|Failed to fetch/i.test(m)) return 'Connexion au serveur impossible. Vérifie ta connexion Internet.';
  return m || 'Une erreur est survenue.';
}
export function say(el, text, kind) { el.className = 'msg ' + (kind || ''); el.textContent = text; }

export async function getUser() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; }

export const cmpVer = (a, b) => { a = String(a || '0').split('.').map(Number); b = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1; } return 0; };

export async function renderShell(active, opts = {}) {
  let user = null;
  try { user = await getUser(); } catch (e) {}
  const na = document.getElementById('nav-auth');
  if (user && na) na.innerHTML = `<a href="account.html" class="${active === 'account.html' ? 'on' : ''}">Mon espace</a>`;
  // Bandeau « nouvelle version disponible » pour les joueurs connectés dont la version installée est plus ancienne
  if (user) {
    try {
      const [p, r] = await Promise.all([sb.from('profiles').select('installed_version').eq('id', user.id).maybeSingle(), latestRelease()]);
      const inst = p.data && p.data.installed_version, last = r.latest && r.latest.version;
      if (inst && last && cmpVer(last, inst) > 0 && localStorage.getItem('cb_up_dismiss') !== last) {
        document.body.insertAdjacentHTML('afterbegin', `<div id="upban">🆕 Nouvelle version ${esc(last)} disponible (tu as la ${esc(inst)}). Ta partie est conservée.
          <a class="btn sm" href="download.html">Télécharger</a><button aria-label="Fermer">✕</button></div>`);
        document.querySelector('#upban button').onclick = () => { localStorage.setItem('cb_up_dismiss', last); document.getElementById('upban').remove(); };
      }
    } catch (e) {}
  }
  return user;
}

export async function latestRelease() {
  const { data, error } = await sb.from('releases').select('*').order('published_at', { ascending: false });
  if (error || !data || !data.length) return { latest: null, all: [] };
  return { latest: data[0], all: data };
}

// Dernière version Windows publiée sur GitHub Releases (aucun lien en dur : l'adresse vient de l'API GitHub).
// Retourne { status:'ok', latest, all } | { status:'none' } (aucune release avec .exe) | { status:'error' }
export async function githubReleases() {
  try {
    const r = await fetch('https://api.github.com/repos/' + CONFIG.GITHUB_REPO + '/releases?per_page=15', { headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404) return { status: 'none' };
    if (!r.ok) return { status: 'error' };
    const list = (await r.json()).filter(x => !x.draft && !x.prerelease).map(x => {
      const exes = (x.assets || []).filter(a => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name));
      const a = exes.find(e => /setup/i.test(e.name)) || exes[0];
      return { version: String(x.tag_name || '').replace(/^v/i, ''), notes: x.body || '', date: x.published_at, page: x.html_url, url: a ? a.browser_download_url : null, name: a && a.name, size: a && a.size };
    }).filter(x => x.url);
    return list.length ? { status: 'ok', latest: list[0], all: list } : { status: 'none' };
  } catch (e) { return { status: 'error' }; }
}
