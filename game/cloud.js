/* =====================================================================
   CAMPING — module de comptes + sauvegarde cloud (Supabase)
   Indépendant du gameplay : le jeu lui fournit son état (objet S) via attach().
   ===================================================================== */
(function () {
  'use strict';
  var CFG = window.CAMPING_CONFIG || {};
  var SAVE_VERSION = 1;               // version du FORMAT de sauvegarde (≠ version du jeu)
  var LEGACY_KEY = 'camping_v8';      // ancienne sauvegarde locale du jeu
  var SDK_URLS = ['vendor/supabase.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'];

  /* Migrations : MIGRATIONS[n] transforme une sauvegarde de la version n-1 vers n.
     Exemple pour une future version :
       MIGRATIONS[2] = function(d){ d.nouveauChamp = d.nouveauChamp || 0; return d; };
     (les ajouts de champs « simples » restent aussi gérés par le code d'initialisation du jeu) */
  var MIGRATIONS = {};

  var sb = null, user = null, getState = null, initialRaw = null;
  var lastErr = null, revision = 0, saving = false, pending = false, halted = false, offlineMode = false;
  var needSync = false, lastSent = '', latestStr = '', timer = null, retry = null, appVersion = CFG.GAME_VERSION;
  var clientId = (function () { try { var k = localStorage.getItem('camping_client_id'); if (!k) { k = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('camping_client_id', k); } return k; } catch (e) { return 'c' + Math.random().toString(36).slice(2); } })();

  /* ---------- utilitaires ---------- */
  function valid(s) { return !!s && typeof s === 'object' && Array.isArray(s.parcels) && s.parcels.length > 0 && Array.isArray(s.buildings) && isFinite(s.money); }
  function migrate(d, from) { from = from || 1; for (var v = from + 1; v <= SAVE_VERSION; v++) if (MIGRATIONS[v]) d = MIGRATIONS[v](d); return d; }
  function bkKey() { return 'camping_backup_' + (user ? user.id : 'anon'); }
  function readBackup() { try { var b = JSON.parse(localStorage.getItem(bkKey())); if (b && b.raw) { var d = migrate(JSON.parse(b.raw), b.v); if (valid(d)) { b.data = d; return b; } } } catch (e) {} return null; }
  function writeBackup(raw, dirty) { try { localStorage.setItem(bkKey(), JSON.stringify({ v: SAVE_VERSION, baseRevision: revision, dirty: !!dirty, savedAt: Date.now(), raw: raw })); } catch (e) {} }
  function loadScript(urls) {
    return new Promise(function (res, rej) {
      if (window.supabase && window.supabase.createClient) return res();
      if (!urls.length) return rej(new Error('sdk'));
      var s = document.createElement('script'); s.src = urls[0];
      s.onload = function () { (window.supabase && window.supabase.createClient) ? res() : loadScript(urls.slice(1)).then(res, rej); };
      s.onerror = function () { loadScript(urls.slice(1)).then(res, rej); };
      document.head.appendChild(s);
    });
  }
  function frErr(e) {
    var m = (e && e.message || '') + '';
    if (/Invalid login/i.test(m)) return 'E-mail ou mot de passe incorrect.';
    if (/not confirmed/i.test(m)) return "Confirme d'abord ton adresse e-mail (vérifie ta boîte de réception).";
    if (/already registered|already been registered/i.test(m)) return 'Un compte existe déjà avec cet e-mail.';
    if (/at least 6|Password should/i.test(m)) return 'Mot de passe trop court (6 caractères minimum).';
    if (/rate limit|too many/i.test(m)) return 'Trop de tentatives. Réessaie dans quelques minutes.';
    if (/valid email|invalid format/i.test(m)) return 'Adresse e-mail invalide.';
    if (/Database error/i.test(m)) return "Inscription impossible (pseudo invalide ou déjà pris).";
    if (/fetch|network/i.test(m)) return 'Connexion à Internet impossible.';
    return m || 'Erreur inconnue.';
  }

  /* ---------- interface (écran de connexion + pastille de compte) ---------- */
  var css = '#cc{position:fixed;inset:0;z-index:100000;background:linear-gradient(rgba(10,20,10,.55),rgba(10,20,10,.82)),url(cover.jpg) center/cover #0f2a1a;display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,sans-serif;color:#f8fafc}' +
    '#cc .box{width:380px;max-width:92vw;background:rgba(15,23,42,.92);border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:26px;display:flex;flex-direction:column;gap:10px}' +
    '#cc h1{font-size:24px;text-align:center}#cc .sub{color:#94a3b8;text-align:center;font-size:13px;margin-bottom:6px}' +
    '#cc .tabs{display:flex;gap:6px}#cc .tabs button{flex:1;padding:8px;border:0;border-radius:8px;background:rgba(51,65,85,.7);color:#94a3b8;font-weight:700;cursor:pointer}#cc .tabs button.on{background:#10b981;color:#fff}' +
    '#cc input{padding:11px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(2,6,23,.6);color:#fff;font-size:14px;user-select:text;-webkit-user-select:text;outline:0}#cc input:focus{border-color:#10b981}' +
    '#cc .go{padding:12px;border:0;border-radius:10px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;font-weight:800;font-size:14px;cursor:pointer}#cc .go:disabled{opacity:.5;cursor:wait}' +
    '#cc .lnk{background:0;border:0;color:#6ee7b7;font-size:12px;cursor:pointer;text-decoration:underline}' +
    '#cc .msg{min-height:18px;font-size:13px;text-align:center}#cc .msg.err{color:#fca5a5}#cc .msg.ok{color:#6ee7b7}' +
    '#ccpill{position:fixed;left:10px;bottom:10px;z-index:60;background:rgba(15,23,42,.92);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:6px 10px;font:12px "Segoe UI",system-ui,sans-serif;color:#cbd5e1;display:flex;gap:8px;align-items:center}' +
    '#ccpill button{background:0;border:0;color:#fca5a5;cursor:pointer;font-size:12px;text-decoration:underline}' +
    '#ccban{position:fixed;top:78px;left:50%;transform:translateX(-50%);z-index:70;background:#065f46;border:1px solid #10b981;border-radius:10px;padding:10px 14px;color:#fff;font:13px "Segoe UI",system-ui,sans-serif;display:none;gap:10px;align-items:center}' +
    '#ccban button,#ccban a{background:#10b981;color:#fff;border:0;border-radius:8px;padding:6px 10px;font-weight:700;cursor:pointer;text-decoration:none;font-size:12px}';
  function injectCss() { if (document.getElementById('cc-css')) return; var s = document.createElement('style'); s.id = 'cc-css'; s.textContent = css; document.head.appendChild(s); }

  function authUI() {
    return new Promise(function (resolve) {
      injectCss();
      var mode = 'login', el = document.createElement('div'); el.id = 'cc';
      el.innerHTML = '<div class="box"><h1>🏕️ Campground Builder</h1><div class="sub">Connecte-toi avec le même compte que sur le site</div>' +
        '<div class="tabs"><button data-m="login" class="on">Connexion</button><button data-m="register">Créer un compte</button></div>' +
        '<input id="ccu" placeholder="Pseudo (3 à 20 caractères)" maxlength="20" autocomplete="username" style="display:none">' +
        '<input id="cce" type="email" placeholder="Adresse e-mail" autocomplete="email">' +
        '<input id="ccp" type="password" placeholder="Mot de passe" autocomplete="current-password">' +
        '<button class="go" id="ccg">Se connecter</button><div class="msg" id="ccm"></div>' +
        '<button class="lnk" id="ccf">Mot de passe oublié ?</button></div>';
      document.body.appendChild(el);
      var $ = function (id) { return el.querySelector('#' + id); }, msg = function (t, k) { var m = $('ccm'); m.textContent = t; m.className = 'msg ' + (k || ''); };
      function setMode(m) {
        mode = m;
        el.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.m === m); });
        $('ccu').style.display = m === 'register' ? '' : 'none';
        $('ccp').style.display = m === 'forgot' ? 'none' : '';
        $('ccg').textContent = m === 'login' ? 'Se connecter' : m === 'register' ? 'Créer mon compte' : 'Envoyer le lien';
        $('ccf').style.display = m === 'login' ? '' : 'none'; msg('');
      }
      el.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { setMode(b.dataset.m); }; });
      $('ccf').onclick = function () { setMode('forgot'); };
      async function submit() {
        var email = $('cce').value.trim(), pw = $('ccp').value, un = $('ccu').value.trim(), g = $('ccg');
        if (!email) return msg('Entre ton adresse e-mail.', 'err');
        if (mode !== 'forgot' && !pw) return msg('Entre ton mot de passe.', 'err');
        g.disabled = true; msg('…');
        try {
          if (mode === 'login') {
            var r = await sb.auth.signInWithPassword({ email: email, password: pw });
            if (r.error) throw r.error; user = r.data.user; el.remove(); resolve();
          } else if (mode === 'register') {
            if (!/^[A-Za-z0-9_\-]{3,20}$/.test(un)) throw new Error('Pseudo : 3 à 20 caractères (lettres, chiffres, _ ou -).');
            if (pw.length < 6) throw new Error('Mot de passe trop court (6 caractères minimum).');
            var av = await sb.rpc('username_available', { p_username: un });
            if (!av.error && av.data === false) throw new Error('Ce pseudo est déjà pris.');
            var s = await sb.auth.signUp({ email: email, password: pw, options: { data: { username: un }, emailRedirectTo: (CFG.SITE_URL || '') + '/login.html' } });
            if (s.error) throw s.error;
            if (s.data.session) { user = s.data.user; el.remove(); resolve(); }
            else { msg("Compte créé ! Clique sur le lien reçu par e-mail, puis connecte-toi ici.", 'ok'); setMode('login'); msg("Compte créé ! Confirme ton e-mail puis connecte-toi.", 'ok'); }
          } else {
            var f = await sb.auth.resetPasswordForEmail(email, { redirectTo: (CFG.SITE_URL || '') + '/reset.html' });
            if (f.error) throw f.error; msg('Si un compte existe, un e-mail de réinitialisation vient d\'être envoyé.', 'ok');
          }
        } catch (e) { msg(frErr(e), 'err'); }
        g.disabled = false;
      }
      $('ccg').onclick = submit;
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
  }

  function pill() {
    injectCss(); if (document.getElementById('ccpill')) return;
    var p = document.createElement('div'); p.id = 'ccpill';
    var name = (user && user.user_metadata && user.user_metadata.username) || (user && user.email) || '';
    p.innerHTML = '👤 <b></b> <span id="ccst">☁️</span> <button>Déconnexion</button>';
    p.querySelector('b').textContent = name;
    p.querySelector('button').onclick = async function () { await flush(); try { await sb.auth.signOut(); } catch (e) {} location.reload(); };
    document.body.appendChild(p);
  }
  function setStatus(k) {
    var e = document.getElementById('ccst'); if (!e) return;
    e.textContent = k === 'ok' ? '☁️ Synchronisé' : k === 'saving' ? '☁️ Sauvegarde…' : '⚠️ Hors ligne (copie locale) — cliquer pour le détail';
    if (k === 'off') {
      e.style.cursor = 'pointer';
      e.onclick = function () {
        var m = lastErr ? ((lastErr.code ? '[' + lastErr.code + '] ' : '') + (lastErr.message || String(lastErr)) + (lastErr.details ? '\n' + lastErr.details : '') + (lastErr.hint ? '\n' + lastErr.hint : '')) : (navigator.onLine ? 'Aucune erreur enregistrée (en attente de la prochaine tentative).' : 'Pas de connexion Internet.');
        alert('Raison du mode hors ligne :\n\n' + m + '\n\nTa partie reste enregistrée sur cet ordinateur.');
      };
    } else { e.style.cursor = ''; e.onclick = null; }
  }
  function banner(html, actionText, action, href) {
    injectCss(); var b = document.getElementById('ccban');
    if (!b) { b = document.createElement('div'); b.id = 'ccban'; document.body.appendChild(b); }
    b.style.display = 'flex'; b.innerHTML = '<span></span>'; b.firstChild.textContent = html;
    if (actionText) { var a = document.createElement(href ? 'a' : 'button'); a.textContent = actionText; if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; } else a.onclick = action; b.appendChild(a); }
  }
  function cmp(a, b) { a = String(a).split('.').map(Number); b = String(b).split('.').map(Number); for (var i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1; } return 0; }

  /* ---------- démarrage : connexion + récupération de la sauvegarde ---------- */
  async function boot() {
    try {
      await loadScript(SDK_URLS.slice());
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'camping-auth' } });
    } catch (e) {
      // Impossible de charger le SDK : on joue avec l'ancienne sauvegarde locale, sans cloud.
      offlineMode = true; halted = true; initialRaw = localStorage.getItem(LEGACY_KEY); return;
    }
    try { var s = await sb.auth.getSession(); if (s.data && s.data.session) user = s.data.session.user; } catch (e) {}
    if (!user) await authUI();
    if (window.campingApp && window.campingApp.getVersion) { try { appVersion = await window.campingApp.getVersion(); } catch (e) {} }
    await loadSave();
    pill(); setStatus(offlineMode ? 'off' : 'ok');
    if (!offlineMode) { try { sb.from('profiles').update({ installed_version: appVersion }).eq('id', user.id).then(function () {}, function () {}); } catch (e) {} }
    setupUpdates();
  }

  async function loadSave() {
    var bk = readBackup(), remote = null, failed = false;
    try {
      var r = await sb.from('game_saves').select('save_data,save_version,revision').eq('user_id', user.id).maybeSingle();
      if (r.error) throw r.error; remote = r.data;
    } catch (e) { failed = true; lastErr = e; try { console.error('Chargement sauvegarde :', e); } catch (x) {} }

    if (failed) {                                    // pas de réseau : copie locale de ce compte
      offlineMode = true; revision = bk ? (bk.baseRevision || 0) : 0;
      initialRaw = bk ? JSON.stringify(bk.data) : null;
      if (!bk) { halted = true; alert("Impossible de joindre le serveur et aucune copie locale n'existe pour ce compte.\nVérifie ta connexion Internet puis relance le jeu."); }
      else needSync = true;
      return;
    }
    if (remote) {
      var data = migrate(remote.save_data, remote.save_version || 1);
      revision = remote.revision;
      if (!valid(data)) {                            // sauvegarde en ligne illisible : on ne l'écrase jamais
        if (bk) { data = bk.data; } else { halted = true; alert('La sauvegarde en ligne est illisible. Contacte le support (aucune donnée écrasée).'); }
      } else if (bk && bk.dirty) {
        if (bk.baseRevision === remote.revision) { data = bk.data; needSync = true; }           // progression hors ligne à synchroniser
        else if (!confirm('Une copie locale non synchronisée ET une sauvegarde en ligne plus récente existent.\n\nOK = garder la sauvegarde EN LIGNE\nAnnuler = garder la copie LOCALE de cet ordinateur')) { data = bk.data; needSync = true; }
      }
      initialRaw = data ? JSON.stringify(data) : null; lastSent = '';
    } else {                                         // aucune sauvegarde en ligne
      revision = 0; var legacy = null;
      try { var lr = localStorage.getItem(LEGACY_KEY); if (lr && valid(JSON.parse(lr))) legacy = lr; } catch (e) {}
      if (bk && bk.baseRevision === 0) { initialRaw = JSON.stringify(bk.data); needSync = true; }
      else if (legacy && confirm("Une partie existe déjà sur cet ordinateur.\n\nOK = l'importer dans ton compte\nAnnuler = commencer une nouvelle partie")) { initialRaw = legacy; needSync = true; }
      else initialRaw = null;
    }
  }

  /* ---------- sauvegarde ---------- */
  function snapshot() {
    if (!getState) return null; var s; try { s = getState(); } catch (e) { return null; }
    if (!valid(s)) return null;                      // jamais de sauvegarde vide/corrompue
    var str; try { str = JSON.stringify(s); } catch (e) { return null; }
    if (!str || str.length > 4500000) return null; return str;
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(function () { push(false); }, ms); }

  async function push(force) {
    if (!user || !getState || halted || offlineMode && !sb) return;
    if (saving) { pending = true; return; }
    var str = snapshot(); if (!str) return;
    latestStr = str;
    if (str === lastSent && !force) return;
    writeBackup(str, true);                          // copie locale de secours, synchrone
    if (!navigator.onLine) { setStatus('off'); return; }
    saving = true; setStatus('saving');
    try {
      var row = { save_data: JSON.parse(str), save_version: SAVE_VERSION, game_version: appVersion, client_id: clientId, revision: revision + 1 }, res;
      if (revision === 0) res = await sb.from('game_saves').insert(Object.assign({ user_id: user.id }, row)).select('revision');
      else res = await sb.from('game_saves').update(row).eq('user_id', user.id).eq('revision', revision).select('revision');
      if (res.error) { if (res.error.code === '23505') { await conflict(); return; } throw res.error; }
      if (!res.data || !res.data.length) { await conflict(); return; }
      revision = row.revision; lastSent = str; offlineMode = false;
      if (latestStr === str) writeBackup(str, false); else writeBackup(latestStr, true);
      setStatus('ok');
    } catch (e) {
      lastErr = e; try { console.error('Sauvegarde :', e); } catch (x) {}
      setStatus('off'); clearTimeout(retry); retry = setTimeout(function () { push(false); }, 30000);
    } finally {
      saving = false; if (pending) { pending = false; schedule(500); }
    }
  }

  async function conflict() {
    var r = await sb.from('game_saves').select('save_data,save_version,revision,client_id').eq('user_id', user.id).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) { revision = 0; schedule(500); return; }                   // la ligne a disparu : on recrée
    if (r.data.client_id === clientId) { revision = r.data.revision; schedule(300); return; }
    var d = migrate(r.data.save_data, r.data.save_version || 1);
    if (valid(d) && confirm('Ta partie a été modifiée sur un autre appareil.\n\nOK = charger la partie la plus récente (recommandé)\nAnnuler = garder cette partie et écraser l\'autre')) {
      halted = true; try { localStorage.removeItem(bkKey()); } catch (e) {} location.reload(); return;
    }
    revision = r.data.revision; schedule(300);
  }

  function flush() {
    return new Promise(function (resolve) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; resolve(); } }, 2500);
      var str = snapshot(); if (str) { latestStr = str; writeBackup(str, str !== lastSent); }
      push(true).then(function () { if (!done) { done = true; clearTimeout(t); resolve(); } }, function () { if (!done) { done = true; resolve(); } });
    });
  }

  function attach(fn) {
    getState = fn;
    setInterval(function () { push(false); }, 60000);                               // sauvegarde périodique
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', function () { var s = snapshot(); if (s) writeBackup(s, s !== lastSent); flush(); });
    window.addEventListener('online', function () { schedule(500); });             // synchro au retour d'Internet
    window.addEventListener('offline', function () { setStatus('off'); });
    if (window.campingApp && window.campingApp.onFlushRequest) window.campingApp.onFlushRequest(function () { flush().then(window.campingApp.flushDone, window.campingApp.flushDone); });
    if (needSync && initialRaw) schedule(2000); // données importées / copie locale à envoyer
  }

  function notify() { if (halted) return; schedule(3000); var s = snapshot(); if (s) { latestStr = s; writeBackup(s, s !== lastSent); } }

  async function resetSave() {
    halted = true;
    try { if (sb && user && navigator.onLine) { var r = await sb.from('game_saves').delete().eq('user_id', user.id); if (r.error) throw r.error; } } catch (e) { halted = false; alert("Impossible d'effacer la sauvegarde en ligne : " + frErr(e)); return; }
    try { localStorage.removeItem(bkKey()); localStorage.removeItem(LEGACY_KEY); } catch (e) {}
    location.reload();
  }

  /* ---------- mises à jour ---------- */
  function setupUpdates() {
    var app = window.campingApp;
    if (app && app.isElectron) {
      var show = function (s) {
        if (!s || s.state === 'none') return;
        if (s.state === 'downloading') banner('⬇️ Mise à jour ' + s.version + ' en cours de téléchargement…');
        if (s.state === 'ready') banner('✅ Mise à jour ' + s.version + ' prête. Ta partie est sauvegardée en ligne.', 'Redémarrer', function () { flush().then(function () { app.installUpdate(); }); });
      };
      app.onUpdate(show); if (app.getUpdateState) app.getUpdateState().then(show).catch(function () {});
    } else if (CFG.SITE_URL) {
      fetch(CFG.SITE_URL + '/version.json?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (v) {
        if (v && v.version && cmp(v.version, appVersion) > 0) banner('🆕 Version ' + v.version + ' disponible.', 'Télécharger', null, CFG.SITE_URL + '/download.html');
      }).catch(function () {});
    }
  }

  window.CampingCloud = { boot: boot, attach: attach, notify: notify, flush: flush, resetSave: resetSave, getInitialRaw: function () { return initialRaw; }, saveVersion: SAVE_VERSION };
})();
