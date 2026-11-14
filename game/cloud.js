/* =====================================================================
   CAMPING — module de comptes + sauvegarde cloud (Supabase)
   Indépendant du gameplay : le jeu lui fournit son état (objet S) via attach().
   ===================================================================== */
(function () {
  'use strict';
  var CFG = window.CAMPING_CONFIG || {};
  var SAVE_VERSION = 1;               // version du FORMAT de sauvegarde (≠ version du jeu)
  var MAX_CAMPS = 4;                  // nombre maximum de campings par compte (aussi imposé par la base)
  var ENTER_KEY = 'camping_enter';    // camping choisi dans le salon (sessionStorage)
  var LEGACY_KEY = 'camping_v8';      // ancienne sauvegarde locale du jeu
  var SDK_URLS = ['vendor/supabase.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'];

  /* Migrations : MIGRATIONS[n] transforme une sauvegarde de la version n-1 vers n.
     Exemple pour une future version :
       MIGRATIONS[2] = function(d){ d.nouveauChamp = d.nouveauChamp || 0; return d; };
     (les ajouts de champs « simples » restent aussi gérés par le code d'initialisation du jeu) */
  var MIGRATIONS = {};

  var sb = null, user = null, getState = null, initialRaw = null;
  var slot = 1, multi = true, lobbyMode = false, autoEnterFlag = false, isNewCamp = false, newName = null, camps = [], campsOffline = false;
  var lastErr = null, revision = 0, saving = false, pending = false, halted = false, offlineMode = false;
  var needSync = false, lastSent = '', latestStr = '', timer = null, retry = null, appVersion = CFG.GAME_VERSION;
  var clientId = (function () { try { var k = localStorage.getItem('camping_client_id'); if (!k) { k = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('camping_client_id', k); } return k; } catch (e) { return 'c' + Math.random().toString(36).slice(2); } })();

  /* ---------- utilitaires ---------- */
  function valid(s) { return !!s && typeof s === 'object' && Array.isArray(s.parcels) && s.parcels.length > 0 && Array.isArray(s.buildings) && isFinite(s.money); }
  function migrate(d, from) { from = from || 1; for (var v = from + 1; v <= SAVE_VERSION; v++) if (MIGRATIONS[v]) d = MIGRATIONS[v](d); return d; }
  function bkKeyFor(n) { return 'camping_backup_' + (user ? user.id : 'anon') + '_' + n; }
  function bkKey() { return bkKeyFor(slot); }
  function parseBackup(k) { try { var b = JSON.parse(localStorage.getItem(k)); if (b && b.raw) { var d = migrate(JSON.parse(b.raw), b.v); if (valid(d)) { b.data = d; return b; } } } catch (e) {} return null; }
  function readBackup() {
    var b = parseBackup(bkKey());
    if (!b && slot === 1) b = parseBackup('camping_backup_' + (user ? user.id : 'anon'));   // ancien format (avant les campings multiples)
    return b;
  }
  function writeBackup(raw, dirty) { if (lobbyMode) return; try { localStorage.setItem(bkKey(), JSON.stringify({ v: SAVE_VERSION, baseRevision: revision, dirty: !!dirty, savedAt: Date.now(), raw: raw })); } catch (e) {} }
  function isNoSlotCol(e) { return !!e && /slot/i.test((e.message || '') + (e.details || '')) && (e.code === '42703' || e.code === 'PGRST204' || /does not exist|schema cache/i.test(e.message || '')); }
  function scope(q) { return multi ? q.eq('slot', slot) : q; }
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
    '#ccpill button{background:0;border:0;color:#fca5a5;cursor:pointer;font-size:12px;text-decoration:underline}#ccpill button.home{color:#6ee7b7;text-decoration:none;font-weight:700;background:rgba(16,185,129,.18);border-radius:7px;padding:3px 8px}' +
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
    p.innerHTML = '👤 <b></b> <span id="ccst">☁️</span>' + (multi ? ' <button class="home">🏠 Mes campings</button>' : '') + ' <button class="out">Déconnexion</button>';
    p.querySelector('b').textContent = name;
    var hb = p.querySelector('.home'); if (hb) hb.onclick = function () { goLobby(); };
    p.querySelector('.out').onclick = async function () { await flush(); try { sessionStorage.removeItem(ENTER_KEY); } catch (e) {} try { await sb.auth.signOut(); } catch (e) {} location.reload(); };
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

  /* ---------- liste des campings du compte ---------- */
  function num(v) { v = Number(v); return isFinite(v) ? v : null; }
  function fromRow(r) { return { slot: r.slot || 1, name: (r.name && String(r.name).slice(0, 24)) || 'Les Flots Bleus', money: num(r.money), day: num(r.day), month: num(r.month), stars: num(r.stars), updated: r.updated_at ? Date.parse(r.updated_at) : 0 }; }
  async function listCamps() {
    var r = await sb.from('game_saves').select('slot,updated_at,name:save_data->>name,money:save_data->>money,day:save_data->>day,month:save_data->>month,stars:save_data->>stars').eq('user_id', user.id);
    if (r.error && !isNoSlotCol(r.error)) r = await sb.from('game_saves').select('slot,updated_at').eq('user_id', user.id);
    if (r.error) throw r.error;
    return (r.data || []).map(fromRow).sort(function (a, b) { return a.slot - b.slot; });
  }
  function localCamps() {                              // hors ligne : on retrouve les copies locales de ce compte
    var out = [], pre = 'camping_backup_' + user.id;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i); if (!k || k.indexOf(pre) !== 0) continue;
        var m = k.slice(pre.length).match(/^_(\d)$/), n = m ? Number(m[1]) : (k === pre ? 1 : 0);
        if (n < 1 || n > MAX_CAMPS || out.some(function (c) { return c.slot === n; })) continue;
        var b = parseBackup(k); if (!b) continue;
        out.push({ slot: n, name: String(b.data.name || 'Les Flots Bleus').slice(0, 24), money: num(b.data.money), day: num(b.data.day), month: num(b.data.month), stars: num(b.data.stars), updated: b.savedAt || 0, local: true });
      }
    } catch (e) {}
    return out.sort(function (a, b) { return a.slot - b.slot; });
  }
  function readEnter() { try { var e = JSON.parse(sessionStorage.getItem(ENTER_KEY)); if (e && e.slot >= 1 && e.slot <= MAX_CAMPS) return e; } catch (x) {} return null; }
  function enterCamp(n, isNew, name) {
    try { sessionStorage.setItem(ENTER_KEY, JSON.stringify({ slot: n, isNew: !!isNew, name: name || null })); } catch (e) {}
    location.reload();
  }
  async function goLobby() {
    await flush();
    try { sessionStorage.removeItem(ENTER_KEY); } catch (e) {}
    location.reload();
  }

  /* ---------- démarrage : connexion, salon, récupération de la sauvegarde ---------- */
  async function boot() {
    try {
      await loadScript(SDK_URLS.slice());
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'camping-auth' } });
    } catch (e) {
      // Impossible de charger le SDK : on joue avec l'ancienne sauvegarde locale, sans cloud.
      offlineMode = true; halted = true; multi = false; initialRaw = localStorage.getItem(LEGACY_KEY); return;
    }
    try { var s = await sb.auth.getSession(); if (s.data && s.data.session) user = s.data.session.user; } catch (e) {}
    if (!user) await authUI();
    await prepare();
    if (!lobbyMode) { pill(); setStatus(offlineMode ? 'off' : 'ok'); }
    if (!offlineMode) { try { sb.from('profiles').update({ installed_version: appVersion }).eq('id', user.id).then(function () {}, function () {}); } catch (e) {} }
    setupUpdates();
  }

  async function prepare() {
    if (window.campingApp && window.campingApp.getVersion) { try { appVersion = await window.campingApp.getVersion(); } catch (e) {} }
    revision = 0; lastErr = null; halted = false; offlineMode = false; needSync = false;
    var listed = null;
    try { listed = await listCamps(); multi = true; campsOffline = false; }
    catch (e) {
      if (isNoSlotCol(e)) { multi = false; }          // base pas encore mise à jour : ancien mode « un seul camping »
      else { campsOffline = true; lastErr = e; }       // pas de réseau : on propose les copies locales
    }
    if (!multi) { slot = 1; lobbyMode = false; autoEnterFlag = false; await loadSave(); return; }
    camps = listed || localCamps();

    var en = readEnter(), known = en && camps.some(function (c) { return c.slot === en.slot; });
    if (en && (known || (en.isNew && !campsOffline))) {            // un camping a été choisi dans le salon
      slot = en.slot; lobbyMode = false; autoEnterFlag = true;
      isNewCamp = !known; newName = isNewCamp ? String(en.name || '').trim().slice(0, 24) || null : null;
      await loadSave(); return;
    }
    try { sessionStorage.removeItem(ENTER_KEY); } catch (e) {}
    lobbyMode = true; autoEnterFlag = false;                       // salon d'accueil : décor = camping le plus récent (jamais sauvegardé)
    initialRaw = null;
    var best = camps.slice().sort(function (a, b) { return b.updated - a.updated; })[0];
    if (best) {
      try {
        if (best.local || campsOffline) { var lb = parseBackup(bkKeyFor(best.slot)); initialRaw = lb ? JSON.stringify(lb.data) : null; }
        else {
          var r = await sb.from('game_saves').select('save_data,save_version').eq('user_id', user.id).eq('slot', best.slot).maybeSingle();
          if (r.error) throw r.error;
          if (r.data) { var d = migrate(r.data.save_data, r.data.save_version || 1); if (valid(d)) initialRaw = JSON.stringify(d); }
        }
      } catch (e) { initialRaw = null; }
    }
  }

  async function loadSave() {
    var bk = readBackup(), remote = null, failed = false;
    try {
      var r = await scope(sb.from('game_saves').select('save_data,save_version,revision').eq('user_id', user.id)).maybeSingle();
      if (r.error) throw r.error; remote = r.data;
    } catch (e) { failed = true; lastErr = e; try { console.error('Chargement sauvegarde :', e); } catch (x) {} }

    if (failed) {                                    // pas de réseau : copie locale de ce compte
      offlineMode = true; revision = bk ? (bk.baseRevision || 0) : 0;
      initialRaw = bk ? JSON.stringify(bk.data) : null;
      if (!bk && !isNewCamp) { halted = true; alert("Impossible de joindre le serveur et aucune copie locale n'existe pour ce camping.\nVérifie ta connexion Internet puis relance le jeu."); }
      else needSync = true;
      return;
    }
    if (remote) {
      isNewCamp = false;
      var data = migrate(remote.save_data, remote.save_version || 1);
      revision = remote.revision;
      if (!valid(data)) {                            // sauvegarde en ligne illisible : on ne l'écrase jamais
        if (bk) { data = bk.data; } else { halted = true; alert('La sauvegarde en ligne est illisible. Contacte le support (aucune donnée écrasée).'); }
      } else if (bk && bk.dirty) {
        if (bk.baseRevision === remote.revision) { data = bk.data; needSync = true; }           // progression hors ligne à synchroniser
        else if (!confirm('Une copie locale non synchronisée ET une sauvegarde en ligne plus récente existent.\n\nOK = garder la sauvegarde EN LIGNE\nAnnuler = garder la copie LOCALE de cet ordinateur')) { data = bk.data; needSync = true; }
      }
      initialRaw = data ? JSON.stringify(data) : null; lastSent = '';
    } else {                                         // aucune sauvegarde en ligne pour cet emplacement
      revision = 0; var legacy = null;
      try { var lr = localStorage.getItem(LEGACY_KEY); if (lr && valid(JSON.parse(lr))) legacy = lr; } catch (e) {}
      var firstEver = !multi || (slot === 1 && camps.length === 0);
      if (bk && bk.baseRevision === 0) { initialRaw = JSON.stringify(bk.data); needSync = true; }
      else if (firstEver && legacy && confirm("Une partie existe déjà sur cet ordinateur.\n\nOK = l'importer dans ton compte\nAnnuler = commencer une nouvelle partie")) { initialRaw = legacy; needSync = true; isNewCamp = false; }
      else initialRaw = null;
    }
  }

  /* ---------- sauvegarde ---------- */
  function snapshot() {
    if (!getState || lobbyMode) return null; var s; try { s = getState(); } catch (e) { return null; }
    if (!valid(s)) return null;                      // jamais de sauvegarde vide/corrompue
    var str; try { str = JSON.stringify(s); } catch (e) { return null; }
    if (!str || str.length > 4500000) return null; return str;
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(function () { push(false); }, ms); }

  async function push(force) {
    if (!user || !getState || halted || lobbyMode || offlineMode && !sb) return;
    if (saving) { pending = true; return; }
    var str = snapshot(); if (!str) return;
    latestStr = str;
    if (str === lastSent && !force) return;
    writeBackup(str, true);                          // copie locale de secours, synchrone
    if (!navigator.onLine) { setStatus('off'); return; }
    saving = true; setStatus('saving');
    try {
      var row = { save_data: JSON.parse(str), save_version: SAVE_VERSION, game_version: appVersion, client_id: clientId, revision: revision + 1 }, res;
      if (multi) row.slot = slot;
      if (revision === 0) res = await sb.from('game_saves').insert(Object.assign({ user_id: user.id }, row)).select('revision');
      else res = await scope(sb.from('game_saves').update(row).eq('user_id', user.id)).eq('revision', revision).select('revision');
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
    var r = await scope(sb.from('game_saves').select('save_data,save_version,revision,client_id').eq('user_id', user.id)).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) { revision = 0; schedule(500); return; }                   // la ligne a disparu : on recrée
    if (r.data.client_id === clientId) { revision = r.data.revision; schedule(300); return; }
    var d = migrate(r.data.save_data, r.data.save_version || 1);
    if (valid(d) && confirm('Ce camping a été modifié sur un autre appareil.\n\nOK = charger la partie la plus récente (recommandé)\nAnnuler = garder cette partie et écraser l\'autre')) {
      halted = true; try { localStorage.removeItem(bkKey()); } catch (e) {} location.reload(); return;
    }
    revision = r.data.revision; schedule(300);
  }

  function flush() {
    if (lobbyMode) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; resolve(); } }, 2500);
      var str = snapshot(); if (str) { latestStr = str; writeBackup(str, str !== lastSent); }
      push(true).then(function () { if (!done) { done = true; clearTimeout(t); resolve(); } }, function () { if (!done) { done = true; resolve(); } });
    });
  }

  function attach(fn) {
    getState = fn;
    if (lobbyMode) return;                                                        // salon : simulation jetable, rien n'est jamais sauvegardé
    setInterval(function () { push(false); }, 60000);                               // sauvegarde périodique
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', function () { var s = snapshot(); if (s) writeBackup(s, s !== lastSent); flush(); });
    window.addEventListener('online', function () { schedule(500); });             // synchro au retour d'Internet
    window.addEventListener('offline', function () { setStatus('off'); });
    if (window.campingApp && window.campingApp.onFlushRequest) window.campingApp.onFlushRequest(function () { flush().then(window.campingApp.flushDone, window.campingApp.flushDone); });
    if (isNewCamp) { needSync = true; schedule(800); }                              // nouveau camping : il apparaît tout de suite dans le salon
    else if (needSync && initialRaw) schedule(2000); // données importées / copie locale à envoyer
  }

  function notify() { if (halted || lobbyMode) return; schedule(isNewCamp && !lastSent ? 800 : 3000); var s = snapshot(); if (s) { latestStr = s; writeBackup(s, s !== lastSent); } }

  async function resetSave() {                       // « Tout effacer » : uniquement le camping en cours
    halted = true;
    try { if (sb && user && navigator.onLine) { var r = await scope(sb.from('game_saves').delete().eq('user_id', user.id)); if (r.error) throw r.error; } } catch (e) { halted = false; alert("Impossible d'effacer la sauvegarde en ligne : " + frErr(e)); return; }
    try { localStorage.removeItem(bkKey()); localStorage.removeItem(LEGACY_KEY); if (slot === 1) localStorage.removeItem('camping_backup_' + (user ? user.id : 'anon')); sessionStorage.removeItem(ENTER_KEY); } catch (e) {}
    location.reload();
  }

  /* ---------- salon d'accueil : liste des campings, création, suppression ---------- */
  var lobbyCss = '#lobby{position:fixed;inset:0;z-index:100000;font-family:"Segoe UI",system-ui,sans-serif;color:#f8fafc;display:flex;flex-direction:column;justify-content:space-between;pointer-events:auto;user-select:none;background:radial-gradient(ellipse at center,rgba(5,10,20,0) 45%,rgba(5,10,20,.55) 100%),linear-gradient(to bottom,rgba(5,10,20,.55) 0,rgba(5,10,20,0) 22%,rgba(5,10,20,0) 48%,rgba(5,10,20,.88) 100%)}' +
    '#lobby .top{display:flex;justify-content:space-between;align-items:flex-start;padding:22px 28px;gap:14px;flex-wrap:wrap}' +
    '#lobby .brand{font-size:30px;font-weight:800;text-shadow:0 2px 14px rgba(0,0,0,.7)}#lobby .brand small{display:block;font-size:13px;font-weight:600;color:#cbd5e1;margin-top:2px;letter-spacing:.3px}' +
    '#lobby .who{background:rgba(15,23,42,.72);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px 12px;font-size:13px;display:flex;gap:10px;align-items:center}' +
    '#lobby .who button{background:0;border:0;color:#fca5a5;cursor:pointer;font-size:12px;text-decoration:underline}' +
    '#lobby .bottom{padding:0 28px 30px;display:flex;flex-direction:column;align-items:center;gap:14px}' +
    '#lobby h2{font-size:15px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#e2e8f0;text-shadow:0 2px 10px rgba(0,0,0,.8)}#lobby h2 span{color:#6ee7b7}' +
    '#lobby .cards{display:flex;gap:16px;justify-content:center;max-width:100%;overflow-x:auto;padding:6px 6px 10px}' +
    '#lobby .cc{flex:0 0 232px;min-height:214px;background:rgba(15,23,42,.8);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.16);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:7px;transition:transform .18s,border-color .18s,box-shadow .18s;position:relative}' +
    '#lobby .cc.camp{cursor:pointer}#lobby .cc.camp:hover{transform:translateY(-6px);border-color:#10b981;box-shadow:0 14px 34px rgba(16,185,129,.28)}' +
    '#lobby .cc .ic{font-size:34px;line-height:1}#lobby .cc .nm{font-size:18px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#lobby .cc .st{color:#fbbf24;font-size:13px;letter-spacing:2px;min-height:17px}#lobby .cc .ln{font-size:13px;color:#cbd5e1}#lobby .cc .ln b{color:#fff;font-variant-numeric:tabular-nums}' +
    '#lobby .cc .ago{font-size:11px;color:#94a3b8;margin-top:auto}' +
    '#lobby .play{margin-top:4px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:0;border-radius:10px;padding:10px;font-weight:800;font-size:14px;cursor:pointer}#lobby .play:hover{filter:brightness(1.12)}' +
    '#lobby .del{position:absolute;top:10px;right:10px;background:rgba(51,65,85,.7);border:1px solid rgba(255,255,255,.14);color:#fca5a5;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:14px}#lobby .del:hover{background:#7f1d1d;color:#fff}' +
    '#lobby .cc.add{align-items:center;justify-content:center;text-align:center;border:2px dashed rgba(110,231,183,.55);background:rgba(6,78,59,.28);cursor:pointer;color:#6ee7b7}#lobby .cc.add:hover{background:rgba(6,95,70,.5);transform:translateY(-6px);border-color:#34d399}' +
    '#lobby .cc.add .plus{font-size:62px;line-height:1;font-weight:300}#lobby .cc.add div{font-weight:700;font-size:15px}#lobby .cc.add small{color:#a7f3d0;font-size:12px}#lobby .cc.add.off{opacity:.45;cursor:not-allowed;transform:none!important}' +
    '#lobby .note{font-size:12px;color:#cbd5e1;text-align:center;text-shadow:0 1px 6px rgba(0,0,0,.9);min-height:16px}#lobby .note.err{color:#fca5a5}' +
    '#lobdlg{position:fixed;inset:0;z-index:100001;background:rgba(2,6,23,.62);display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,sans-serif;color:#f8fafc}' +
    '#lobdlg .box{width:400px;max-width:92vw;background:rgba(15,23,42,.97);border:1px solid rgba(255,255,255,.16);border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:12px}' +
    '#lobdlg h3{font-size:20px}#lobdlg p{font-size:13px;color:#94a3b8}' +
    '#lobdlg input{padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(2,6,23,.65);color:#fff;font-size:16px;outline:0;user-select:text;-webkit-user-select:text}#lobdlg input:focus{border-color:#10b981}' +
    '#lobdlg .row{display:flex;gap:10px;justify-content:flex-end}#lobdlg .row button{padding:10px 16px;border-radius:10px;border:0;font-weight:800;font-size:14px;cursor:pointer}' +
    '#lobdlg .ok{background:linear-gradient(135deg,#10b981,#059669);color:#fff}#lobdlg .no{background:rgba(51,65,85,.8);color:#e2e8f0}#lobdlg .dng{background:#dc2626;color:#fff}#lobdlg .msg{min-height:17px;font-size:13px;color:#fca5a5}' +
    '@media(max-width:760px){#lobby .brand{font-size:22px}#lobby .cards{justify-content:flex-start}#lobby .cc{flex-basis:200px}#lobby .top{padding:12px 14px}#lobby .bottom{padding:0 12px 16px}}';

  function ago(t) {
    if (!t) return '';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 2) return "À l'instant"; if (m < 60) return 'il y a ' + m + ' min';
    var h = Math.round(m / 60); if (h < 48) return 'il y a ' + h + ' h';
    return 'il y a ' + Math.round(h / 24) + ' j';
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function eur(n) { return n == null ? '—' : Math.round(n).toLocaleString('fr-FR') + ' €'; }

  function dialog(build) {                           // petite fenêtre au-dessus du salon (pas de prompt() : indisponible dans Electron)
    var d = el('div'); d.id = 'lobdlg'; var box = el('div', 'box'); d.appendChild(box); document.body.appendChild(d);
    var close = function () { d.remove(); }; build(box, close);
    d.addEventListener('mousedown', function (e) { if (e.target === d) close(); });
    return close;
  }

  function openLobby() {
    injectCss();
    if (!document.getElementById('lobby-css')) { var st = document.createElement('style'); st.id = 'lobby-css'; st.textContent = lobbyCss; document.head.appendChild(st); }
    var root = document.getElementById('lobby'); if (root) root.remove();
    root = el('div'); root.id = 'lobby'; document.body.appendChild(root);
    var uname = (user && user.user_metadata && user.user_metadata.username) || (user && user.email) || '';

    function render() {
      root.textContent = '';
      var top = el('div', 'top'), brand = el('div', 'brand', '🏕️ Campground Builder'); brand.appendChild(el('small', '', 'Bienvenue ' + uname + ' — choisis ton camping'));
      var who = el('div', 'who'); who.appendChild(el('span', '', '👤 ' + uname));
      var out = el('button', '', 'Déconnexion'); out.onclick = async function () { try { sessionStorage.removeItem(ENTER_KEY); } catch (e) {} try { await sb.auth.signOut(); } catch (e) {} location.reload(); };
      who.appendChild(out); top.appendChild(brand); top.appendChild(who); root.appendChild(top);

      var bottom = el('div', 'bottom'), h = el('h2', '', 'Mes campings '); h.appendChild(el('span', '', camps.length + ' / ' + MAX_CAMPS)); bottom.appendChild(h);
      var cards = el('div', 'cards');
      camps.forEach(function (c) {
        var card = el('div', 'cc camp');
        card.appendChild(el('div', 'ic', ['⛺', '🚐', '🏡', '🏖️'][(c.slot - 1) % 4]));
        card.appendChild(el('div', 'nm', c.name));
        card.appendChild(el('div', 'st', c.stars != null ? '★'.repeat(Math.max(0, Math.min(5, c.stars))) + '☆'.repeat(5 - Math.max(0, Math.min(5, c.stars))) : ''));
        var l1 = el('div', 'ln', '💰 '); l1.appendChild(el('b', '', eur(c.money))); card.appendChild(l1);
        var l2 = el('div', 'ln', '📅 '); l2.appendChild(el('b', '', c.month != null && c.day != null ? 'Mois ' + c.month + ' • Jour ' + c.day : '—')); card.appendChild(l2);
        card.appendChild(el('div', 'ago', (c.local ? '💾 Copie locale • ' : 'Dernière partie : ') + ago(c.updated)));
        var play = el('button', 'play', '▶ Jouer'); card.appendChild(play);
        card.onclick = function () { enterCamp(c.slot, false, null); };
        if (!c.local && !campsOffline) {
          var del = el('button', 'del', '🗑'); del.title = 'Supprimer ce camping';
          del.onclick = function (ev) { ev.stopPropagation(); askDelete(c); }; card.appendChild(del);
        }
        cards.appendChild(card);
      });
      if (camps.length < MAX_CAMPS) {
        var add = el('div', 'cc add' + (campsOffline ? ' off' : ''));
        add.appendChild(el('div', 'plus', '+')); add.appendChild(el('div', '', 'Nouveau camping'));
        add.appendChild(el('small', '', campsOffline ? 'Connexion Internet requise' : 'Choisis son nom et lance-toi'));
        if (!campsOffline) add.onclick = askCreate;
        cards.appendChild(add);
      }
      bottom.appendChild(cards);
      bottom.appendChild(el('div', 'note' + (campsOffline ? ' err' : ''), campsOffline ? '⚠️ Hors ligne : seules les copies locales sont disponibles.' : (camps.length >= MAX_CAMPS ? 'Maximum de ' + MAX_CAMPS + ' campings atteint : supprime-en un pour en créer un nouveau.' : '')));
      root.appendChild(bottom);
    }

    function freeSlot() { for (var i = 1; i <= MAX_CAMPS; i++) if (!camps.some(function (c) { return c.slot === i; })) return i; return 0; }

    function askCreate() {
      var n = freeSlot(); if (!n) return;
      var names = ['Les Flots Bleus', 'Les Pins Dorés', 'Le Domaine du Lac', 'La Clairière', 'Les Mouettes'], def = names.filter(function (x) { return !camps.some(function (c) { return c.name.toLowerCase() === x.toLowerCase(); }); })[0] || 'Mon camping';
      dialog(function (box, close) {
        box.appendChild(el('h3', '', '🏕️ Nouveau camping')); box.appendChild(el('p', '', 'Quel nom veux-tu donner à ton camping ? (3 à 24 caractères)'));
        var inp = el('input'); inp.maxLength = 24; inp.value = def; inp.placeholder = 'Nom du camping'; box.appendChild(inp);
        var msg = el('div', 'msg'); box.appendChild(msg);
        var row = el('div', 'row'), no = el('button', 'no', 'Annuler'), ok = el('button', 'ok', 'Créer et jouer');
        row.appendChild(no); row.appendChild(ok); box.appendChild(row);
        no.onclick = close;
        function go() {
          var v = inp.value.replace(/\s+/g, ' ').trim();
          if (v.length < 3) { msg.textContent = 'Le nom doit faire au moins 3 caractères.'; return; }
          if (camps.some(function (c) { return c.name.toLowerCase() === v.toLowerCase(); })) { msg.textContent = 'Tu as déjà un camping avec ce nom.'; return; }
          ok.disabled = true; enterCamp(n, true, v);
        }
        ok.onclick = go; inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') go(); if (e.key === 'Escape') close(); });
        setTimeout(function () { inp.focus(); inp.select(); }, 30);
      });
    }

    function askDelete(c) {
      dialog(function (box, close) {
        box.appendChild(el('h3', '', '🗑 Supprimer « ' + c.name + ' » ?'));
        box.appendChild(el('p', '', 'Ce camping et toute sa progression seront effacés définitivement, sur tous tes appareils. Pour confirmer, écris le nom du camping :'));
        var inp = el('input'); inp.placeholder = c.name; box.appendChild(inp);
        var msg = el('div', 'msg'); box.appendChild(msg);
        var row = el('div', 'row'), no = el('button', 'no', 'Annuler'), ok = el('button', 'dng', 'Supprimer');
        row.appendChild(no); row.appendChild(ok); box.appendChild(row); no.onclick = close;
        ok.onclick = async function () {
          if (inp.value.trim().toLowerCase() !== c.name.toLowerCase()) { msg.textContent = 'Le nom ne correspond pas.'; return; }
          ok.disabled = true;
          try {
            var r = await sb.from('game_saves').delete().eq('user_id', user.id).eq('slot', c.slot); if (r.error) throw r.error;
            try { localStorage.removeItem(bkKeyFor(c.slot)); if (c.slot === 1) localStorage.removeItem('camping_backup_' + user.id); } catch (e) {}
            camps = camps.filter(function (x) { return x.slot !== c.slot; }); close(); render();
          } catch (e) { ok.disabled = false; msg.textContent = 'Suppression impossible : ' + frErr(e); }
        };
        inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') close(); });
      });
    }
    render();
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

  window.CampingCloud = {
    boot: boot, attach: attach, notify: notify, flush: flush, resetSave: resetSave, getInitialRaw: function () { return initialRaw; }, saveVersion: SAVE_VERSION,
    isLobby: function () { return lobbyMode; }, autoEnter: function () { return autoEnterFlag; }, getNewName: function () { return isNewCamp ? newName : null; },
    openLobby: openLobby, goLobby: goLobby, maxCamps: MAX_CAMPS, getSlot: function () { return slot; }
  };
})();
