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

  var sb = null, user = null, getState = null, initialRaw = null, metaFn = null, newStateFn = null;
  var MAX_SLOTS = 4, slot = 0, slots = [], hasSlots = true, listOk = false, readOnly = false, mode = 'play';
  var shared = null, remoteHook = null, pollT = null;
  var lastErr = null, revision = 0, saving = false, pending = false, halted = false, offlineMode = false;
  var needSync = false, lastSent = '', latestStr = '', timer = null, retry = null, appVersion = CFG.GAME_VERSION;
  var clientId = (function () { try { var k = localStorage.getItem('camping_client_id'); if (!k) { k = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('camping_client_id', k); } return k; } catch (e) { return 'c' + Math.random().toString(36).slice(2); } })();

  /* ---------- utilitaires ---------- */
  function valid(s) { return !!s && typeof s === 'object' && Array.isArray(s.parcels) && s.parcels.length > 0 && Array.isArray(s.buildings) && isFinite(s.money); }
  function migrate(d, from) { from = from || 1; for (var v = from + 1; v <= SAVE_VERSION; v++) if (MIGRATIONS[v]) d = MIGRATIONS[v](d); return d; }
  function bkKey(n) { return 'camping_backup_' + (user ? user.id : 'anon') + '_' + (n || slot); }
  function bkLegacyKey() { return 'camping_backup_' + (user ? user.id : 'anon'); }   // ancien format (1 seul camping)
  function readBackup(n) {
    n = n || slot;
    try {
      var raw0 = localStorage.getItem(bkKey(n)); if (!raw0 && n === 1) raw0 = localStorage.getItem(bkLegacyKey());
      var b = JSON.parse(raw0); if (b && b.raw) { var d = migrate(JSON.parse(b.raw), b.v); if (valid(d)) { b.data = d; return b; } }
    } catch (e) {} return null;
  }
  function writeBackup(raw, dirty) {
    try { localStorage.setItem(bkKey(), JSON.stringify({ v: SAVE_VERSION, baseRevision: revision, dirty: !!dirty, savedAt: Date.now(), raw: raw })); if (slot === 1) localStorage.removeItem(bkLegacyKey()); } catch (e) {}
  }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} return null; }
  function T() { return shared ? 'shared_campings' : 'game_saves'; }
  function scoped(q) { if (shared) return q.eq('id', shared); q = q.eq('user_id', user.id); return hasSlots ? q.eq('slot', slot) : q; }   // cible le camping actif
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
    '#ccban button,#ccban a{background:#10b981;color:#fff;border:0;border-radius:8px;padding:6px 10px;font-weight:700;cursor:pointer;text-decoration:none;font-size:12px}' +
    /* ----- salon d'accueil ----- */
    '#lb{position:fixed;inset:0;z-index:90;pointer-events:none;font-family:"Segoe UI",system-ui,sans-serif;color:#f8fafc;background:linear-gradient(90deg,rgba(2,6,23,.82) 0,rgba(2,6,23,.5) 40%,rgba(2,6,23,0) 72%),linear-gradient(0deg,rgba(2,6,23,.6),rgba(2,6,23,0) 26%)}' +
    '#lb .lbp{pointer-events:auto;position:absolute;left:4vw;top:50%;transform:translateY(-50%);width:min(640px,92vw);display:flex;flex-direction:column;gap:14px}' +
    '#lb .lbt{font-size:34px;font-weight:800;text-shadow:0 2px 14px rgba(0,0,0,.6)}#lb .lbs{color:#cbd5e1;font-size:15px;margin-top:-8px}' +
    '#lb .lbg{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
    '#lb .lbc{position:relative;min-height:138px;border-radius:16px;padding:14px;background:rgba(15,23,42,.82);border:1.5px solid rgba(255,255,255,.14);backdrop-filter:blur(6px);cursor:pointer;display:flex;flex-direction:column;gap:5px;transition:border-color .15s,transform .15s}' +
    '#lb .lbc:hover{border-color:#6ee7b7;transform:translateY(-2px)}#lb .lbc.on{border-color:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,.35),0 10px 30px rgba(0,0,0,.45)}' +
    '#lb .lbc.new{align-items:center;justify-content:center;border-style:dashed;color:#94a3b8;gap:2px}#lb .lbc.new b{font-size:42px;line-height:1;color:#6ee7b7;font-weight:600}' +
    '#lb .nm{font-weight:800;font-size:17px;padding-right:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#lb .ln{font-size:12.5px;color:#cbd5e1}' +
    '#lb .pl{margin-top:auto;padding:9px;border:0;border-radius:9px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;font-weight:800;font-size:14px;cursor:pointer}' +
    '#lb .pl2{margin-top:auto;font-size:11.5px;color:#94a3b8}' +
    '#lb .del{position:absolute;top:8px;right:8px;background:0;border:0;color:#94a3b8;cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px}#lb .del:hover{background:rgba(239,68,68,.25);color:#fca5a5}' +
    '#lb .lbh{font-size:12.5px;color:#94a3b8}' +
    '#lb .lbcap{position:absolute;right:20px;bottom:18px;font-size:13px;background:rgba(15,23,42,.65);border:1px solid rgba(255,255,255,.14);padding:6px 14px;border-radius:20px;color:#e2e8f0}' +
    '#lbm{position:fixed;inset:0;z-index:95;background:rgba(2,6,23,.6);display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,sans-serif;color:#f8fafc}' +
    '#lbm .box{width:400px;max-width:92vw;background:rgba(15,23,42,.97);border:1px solid rgba(255,255,255,.16);border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:12px}' +
    '#lbm h2{font-size:20px}#lbm p{color:#cbd5e1;font-size:14px;line-height:1.4}' +
    '#lbm input{padding:12px;border-radius:9px;border:1px solid rgba(255,255,255,.2);background:rgba(2,6,23,.6);color:#fff;font-size:15px;user-select:text;-webkit-user-select:text;outline:0}#lbm input:focus{border-color:#10b981}' +
    '#lbm .msg{min-height:16px;font-size:13px;color:#fca5a5}#lbm .row{display:flex;gap:10px}' +
    '#lbm button{flex:1;padding:11px;border:0;border-radius:10px;font-weight:800;font-size:14px;cursor:pointer;color:#fff}' +
    '#lbm .go{background:linear-gradient(135deg,#10b981,#059669)}#lbm .go.dg{background:#dc2626}#lbm .sec{background:rgba(51,65,85,.8)}' +
    '#lbbusy{position:fixed;inset:0;z-index:96;background:#020617;color:#e2e8f0;display:flex;align-items:center;justify-content:center;font:600 18px "Segoe UI",system-ui,sans-serif;opacity:0;transition:opacity .35s;pointer-events:auto}#lbbusy.on{opacity:1}' +
    '@media(max-width:700px){#lb .lbp{left:3vw;right:3vw;width:auto;top:auto;bottom:3vh;transform:none;gap:10px}#lb .lbt{font-size:24px}#lb .lbc{min-height:112px;padding:10px}#lb .lbcap{display:none}}';
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
    p.innerHTML = '👤 <b></b> <span id="ccst">☁️</span> <button class="lobbyb" style="color:#6ee7b7">🏠 Salon</button> <button class="outb">Déconnexion</button>';
    p.querySelector('b').textContent = name;
    var lb = p.querySelector('.lobbyb'); if (mode === 'play' && slot) lb.onclick = function () { toLobby(); }; else lb.style.display = 'none';
    p.querySelector('.outb').onclick = async function () { await flush(); try { await sb.auth.signOut(); } catch (e) {} ss('camping_play', null); ss('camping_slot', null); location.reload(); };
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

  /* ---------- liste des campings du compte (4 maximum) ---------- */
  function lastKey() { return 'camping_last_slot_' + (user ? user.id : 'anon'); }
  function bySlot(a, b) { return a.slot - b.slot; }
  function metaFromData(d) { return { name: d.name || 'Camping', money: Math.round(d.money), day: d.day, month: d.month, nb: d.buildings.length, stars: 0 }; }
  function metaOf(row) {
    var m = (row.meta && typeof row.meta === 'object' && row.meta.name) ? row.meta : {};
    function pick(a, b) { return a != null ? a : (b != null && b !== '' ? Number(b) : null); }
    return { name: m.name || row.sn || 'Camping', money: pick(m.money, row.sm), day: pick(m.day, row.sd), month: pick(m.month, row.smo), nb: m.nb != null ? m.nb : null, stars: m.stars != null ? m.stars : null, shared: m.shared || null };
  }
  async function listSlots() {
    var full = 'slot,meta,revision,updated_at,sn:save_data->>name,sm:save_data->>money,sd:save_data->>day,smo:save_data->>month', tries = [full, 'slot,meta,revision,updated_at'], r = null;
    hasSlots = true;
    for (var i = 0; i < tries.length; i++) {
      r = await sb.from('game_saves').select(tries[i]).eq('user_id', user.id);
      if (!r.error) break;
      if (/slot|meta|42703/.test((r.error.code || '') + ' ' + (r.error.message || ''))) { hasSlots = false; break; }
    }
    if (!hasSlots) {                                  // base pas encore migrée : un seul camping (ancien format)
      r = await sb.from('game_saves').select('revision,updated_at,sn:save_data->>name,sm:save_data->>money,sd:save_data->>day,smo:save_data->>month').eq('user_id', user.id);
      if (!r.error) (r.data || []).forEach(function (x) { x.slot = 1; });
    }
    if (r.error) throw r.error;
    slots = (r.data || []).map(function (x) { return { slot: x.slot, revision: x.revision, updated_at: x.updated_at, meta: metaOf(x) }; }).sort(bySlot);
    listOk = true;
  }
  function slotsFromBackups() {                       // hors ligne : on liste les copies locales
    var out = [];
    for (var n = 1; n <= MAX_SLOTS; n++) { var b = readBackup(n); if (b) out.push({ slot: n, revision: b.baseRevision || 0, updated_at: new Date(b.savedAt || 0).toISOString(), meta: metaFromData(b.data) }); }
    return out;
  }

  /* ---------- démarrage : connexion + liste des campings + sauvegarde du camping actif ---------- */
  async function boot() {
    try {
      await loadScript(SDK_URLS.slice());
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'camping-auth' } });
    } catch (e) {
      // Impossible de charger le SDK : on joue avec l'ancienne sauvegarde locale, sans cloud.
      offlineMode = true; halted = true; mode = 'play'; initialRaw = localStorage.getItem(LEGACY_KEY); return;
    }
    try { var s = await sb.auth.getSession(); if (s.data && s.data.session) user = s.data.session.user; } catch (e) {}
    if (!user) await authUI();
    if (window.campingApp && window.campingApp.getVersion) { try { appVersion = await window.campingApp.getVersion(); } catch (e) {} }
    try { await listSlots(); } catch (e) { lastErr = e; listOk = false; slots = slotsFromBackups(); try { console.error('Liste des campings :', e); } catch (x) {} }
    // camping actif : celui choisi dans cette session, sinon le dernier joué, sinon le plus récent
    var want = parseInt(ss('camping_slot'), 10) || 0;
    if (!want) { try { want = parseInt(localStorage.getItem(lastKey()), 10) || 0; } catch (e) {} }
    if (!slots.some(function (x) { return x.slot === want; })) {
      var best = slots.slice().sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); })[0];
      want = best ? best.slot : 0;
    }
    slot = want; shared = ((slots.filter(function (x) { return x.slot === slot; })[0] || {}).meta || {}).shared || null;
    mode = (ss('camping_play') === '1' && slot) ? 'play' : 'lobby';
    readOnly = mode === 'lobby';                      // le salon est un décor : jamais de sauvegarde depuis lui
    if (slot) await loadSave(readOnly); else { initialRaw = null; revision = 0; }
    pill(); setStatus(offlineMode ? 'off' : 'ok');
    if (!offlineMode) { try { sb.from('profiles').update({ installed_version: appVersion }).eq('id', user.id).then(function () {}, function () {}); } catch (e) {} }
    setupUpdates();
  }

  async function loadSave(quiet) {                    // quiet = salon : aucune boîte de dialogue, aucune écriture
    var bk = readBackup(), remote = null, failed = false;
    try {
      var r = await scoped(sb.from(T()).select('save_data,save_version,revision')).maybeSingle();
      if (r.error) throw r.error; remote = r.data;
    } catch (e) { failed = true; lastErr = e; try { console.error('Chargement sauvegarde :', e); } catch (x) {} }

    if (failed) {                                    // pas de réseau : copie locale de ce camping
      offlineMode = true; revision = bk ? (bk.baseRevision || 0) : 0;
      initialRaw = bk ? JSON.stringify(bk.data) : null;
      if (!bk) { halted = true; if (!quiet) alert("Impossible de joindre le serveur et aucune copie locale n'existe pour ce camping.\nVérifie ta connexion Internet puis relance le jeu."); }
      else if (!quiet) needSync = true;
      return;
    }
    if (remote) {
      var data = migrate(remote.save_data, remote.save_version || 1);
      revision = remote.revision;
      if (!valid(data)) {                            // sauvegarde en ligne illisible : on ne l'écrase jamais
        if (bk) { data = bk.data; } else { halted = true; data = null; if (!quiet) alert('La sauvegarde en ligne est illisible. Contacte le support (aucune donnée écrasée).'); }
      } else if (bk && bk.dirty && !quiet) {
        if (bk.baseRevision === remote.revision) { data = bk.data; needSync = true; }           // progression hors ligne à synchroniser
        else if (!confirm('Une copie locale non synchronisée ET une sauvegarde en ligne plus récente existent.\n\nOK = garder la sauvegarde EN LIGNE\nAnnuler = garder la copie LOCALE de cet ordinateur')) { data = bk.data; needSync = true; }
      }
      initialRaw = data ? JSON.stringify(data) : null; lastSent = '';
    } else {                                         // ce camping n'existe pas (encore) en ligne
      revision = 0;
      if (bk && bk.baseRevision === 0) { initialRaw = JSON.stringify(bk.data); if (!quiet) needSync = true; }
      else initialRaw = null;
    }
  }

  /* ---------- création / suppression / changement de camping ---------- */
  async function createCamping(name, want) {
    if (!sb || !user) throw new Error('Connexion à Internet impossible.');
    if (!listOk || !navigator.onLine) throw new Error('Connexion à Internet impossible : réessaie en ligne pour créer un camping.');
    if (!newStateFn) throw new Error('Le jeu n\'est pas encore prêt, réessaie dans un instant.');
    if (!hasSlots && slots.length) throw new Error('Mise à jour de la base de données requise pour avoir plusieurs campings (voir database/migration_multi_camping.sql).');
    if (slots.length >= MAX_SLOTS) throw new Error('Maximum ' + MAX_SLOTS + ' campings par compte.');
    var n = 1;
    if (hasSlots) { n = (want && !slots.some(function (x) { return x.slot === want; })) ? want : 0; for (var k = 1; !n && k <= MAX_SLOTS; k++) if (!slots.some(function (x) { return x.slot === k; })) n = k; }
    var state = newStateFn(name);
    if (!slots.length) {                               // premier camping : proposer d'importer l'ancienne partie locale
      try { var lr = localStorage.getItem(LEGACY_KEY); if (lr && valid(JSON.parse(lr)) && confirm("Une partie existe déjà sur cet ordinateur.\n\nOK = l'importer dans ce camping\nAnnuler = commencer un camping tout neuf")) state = JSON.parse(lr); } catch (e) {}
    }
    state.name = name;
    if (!valid(state)) throw new Error('Création impossible (état de départ invalide).');
    var row = { user_id: user.id, save_data: state, save_version: SAVE_VERSION, game_version: appVersion, client_id: clientId, revision: 1 };
    if (hasSlots) { row.slot = n; row.meta = metaFromData(state); }
    var r = await sb.from('game_saves').insert(row).select('revision');
    if (r.error) {
      if (r.error.code === '23505') { try { await listSlots(); } catch (e) {} throw new Error('Cet emplacement est déjà utilisé (autre appareil ?). Réessaie.'); }
      throw r.error;
    }
    slots.push({ slot: n, revision: 1, updated_at: new Date().toISOString(), meta: metaFromData(state) }); slots.sort(bySlot);
    return n;
  }
  async function deleteCamping(n) {
    if (!sb || !user || !listOk || !navigator.onLine) throw new Error('Connexion à Internet impossible : réessaie en ligne.');
    var sl = slots.filter(function (x) { return x.slot === n; })[0]; if (sl && sl.meta && sl.meta.shared) { try { await sb.rpc('leave_shared', { p_id: sl.meta.shared }); } catch (e) {} }
    var q = sb.from('game_saves').delete().eq('user_id', user.id); if (hasSlots) q = q.eq('slot', n);
    var r = await q; if (r.error) throw r.error;
    try { localStorage.removeItem(bkKey(n)); if (n === 1) localStorage.removeItem(bkLegacyKey()); } catch (e) {}
    slots = slots.filter(function (x) { return x.slot !== n; });
  }
  function goSlot(n, play) {                           // change de camping (ou y entre) : on recharge proprement
    ss('camping_slot', String(n)); ss('camping_play', play ? '1' : null);
    try { localStorage.setItem(lastKey(), String(n)); } catch (e) {}
    location.reload();
  }
  async function toLobby() { await flush(); ss('camping_play', null); location.reload(); }

  /* ---------- salon d'accueil (interface) ---------- */
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function ask(o) {                                    // petite fenêtre (les prompt()/confirm() natifs ne conviennent pas partout)
    return new Promise(function (resolve) {
      var back = el('div'); back.id = 'lbm'; var box = el('div', 'box'); back.appendChild(box);
      box.appendChild(el('h2', '', o.title)); if (o.text) box.appendChild(el('p', '', o.text));
      var inp = null, err = el('div', 'msg');
      if (o.input) { inp = el('input'); inp.type = 'text'; inp.maxLength = o.input.max || 24; inp.placeholder = o.input.ph || ''; box.appendChild(inp); }
      box.appendChild(err);
      var row = el('div', 'row'), no = el('button', 'sec', o.cancel || 'Annuler'), ok = el('button', 'go' + (o.danger ? ' dg' : ''), o.ok || 'OK');
      row.appendChild(no); row.appendChild(ok); box.appendChild(row);
      function close(v) { back.remove(); resolve(v); }
      function submit() { var v = inp ? inp.value.trim() : true; if (o.validate) { var m = o.validate(v); if (m) { err.textContent = m; return; } } close(v); }
      no.onclick = function () { close(o.noValue !== undefined ? o.noValue : null); }; ok.onclick = submit;
      back.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') close(null); });
      back.addEventListener('pointerdown', function (e) { if (e.target === back) close(null); });
      document.body.appendChild(back); if (inp) inp.focus();
    });
  }
  function busy(msg) { var b = document.getElementById('lbbusy'); if (!b) { b = el('div'); b.id = 'lbbusy'; document.body.appendChild(b); } b.textContent = msg || 'Chargement…'; setTimeout(function () { b.classList.add('on'); }, 0); }
  function unbusy() { var b = document.getElementById('lbbusy'); if (b) b.remove(); }
  function fadeGo(n, play, msg) { busy(msg); setTimeout(function () { goSlot(n, play); }, 380); }
  function fmtN(n) { return Math.round(n).toLocaleString('fr-FR'); }

  async function onCreate(n) {
    var mp = await ask({ title: 'Nouveau camping', text: 'Comment veux-tu jouer ?', ok: '👥 Multijoueur', cancel: '🧍 Solo', noValue: 'solo' }); if (mp == null) return;
    var name = await ask({ title: 'Nouveau camping', text: 'Donne un nom à ton camping :', input: { ph: 'Ex. Les Flots Bleus', max: 24 }, ok: 'Créer',
      validate: function (v) { return v.length < 2 ? 'Le nom doit faire au moins 2 caractères.' : ''; } });
    if (name == null) return;
    busy('Création de « ' + name + ' »…');
    try { var made = await createCamping(name, n); if (mp === true) { busy('Création du camping multijoueur…'); await makeShared(made); } fadeGo(made, false, 'Ouverture de « ' + name + ' »…'); }
    catch (e) { unbusy(); alert(frErr(e)); }
  }
  async function onDelete(n) {
    var s = slots.filter(function (x) { return x.slot === n; })[0], nm = (s && s.meta && s.meta.name) || 'ce camping';
    var yes = await ask({ title: 'Supprimer ce camping ?', text: '« ' + nm + ' » sera supprimé définitivement, sauvegarde en ligne comprise. Cette action est irréversible.', ok: 'Supprimer', danger: true });
    if (!yes) return;
    try {
      await deleteCamping(n);
      if (n === slot) { ss('camping_slot', null); try { localStorage.removeItem(lastKey()); } catch (e) {} busy('Suppression…'); setTimeout(function () { location.reload(); }, 380); }
      else renderLobby();
    } catch (e) { alert(frErr(e)); }
  }
  function card(n) {
    var s = slots.filter(function (x) { return x.slot === n; })[0], c = el('div', 'lbc');
    if (!s) {
      c.classList.add('new'); c.appendChild(el('b', '', '+')); c.appendChild(el('span', '', 'Nouveau camping'));
      c.onclick = function () { onCreate(n); }; return c;
    }
    var m = s.meta || {};
    c.appendChild(el('div', 'nm', m.name || 'Camping'));
    c.appendChild(el('div', 'ln', m.month != null ? '📅 Mois ' + m.month + ' • Jour ' + m.day : '📅 —'));
    c.appendChild(el('div', 'ln', '💰 ' + (m.money != null ? fmtN(m.money) + ' €' : '—')));
    c.appendChild(el('div', 'ln', '🏠 ' + (m.nb != null ? m.nb + ' bâtiments' : '—') + (m.stars ? '   ' + '⭐'.repeat(Math.min(5, m.stars)) : '')));
    if (n === slot) {
      c.classList.add('on'); var pl = el('button', 'pl', '▶ Jouer');
      pl.onclick = function (e) { e.stopPropagation(); fadeGo(n, true, 'Entrée au camping…'); }; c.appendChild(pl);
    } else c.appendChild(el('div', 'pl2', 'Cliquer pour le voir en arrière-plan'));
    { var d = el('button', 'del', '🗑 Supprimer'); d.title = 'Supprimer ce camping'; d.onclick = function (e) { e.stopPropagation(); onDelete(n); }; c.appendChild(d); }
    c.onclick = function () { if (n === slot) fadeGo(n, true, 'Entrée au camping…'); else fadeGo(n, false, 'Chargement de « ' + (m.name || 'Camping') + ' »…'); };
    return c;
  }
  function renderLobby() {
    var root = document.getElementById('lb'); if (!root) return;
    var g = root.querySelector('.lbg'); g.textContent = '';
    for (var n = 1; n <= MAX_SLOTS; n++) g.appendChild(card(n));
    root.querySelector('.lbs').textContent = slots.length ? 'Choisis ton camping' : 'Crée ton premier camping !';
    root.querySelector('.lbh').textContent = (!hasSlots && slots.length) ? '⚠️ Base de données à mettre à jour pour avoir plusieurs campings (voir README).' : (!listOk ? '⚠️ Hors ligne : seules les copies locales de cet ordinateur sont affichées.' : slots.length + ' / ' + MAX_SLOTS + ' campings');
  }
  function showLobby() {
    injectCss(); var old = document.getElementById('lb'); if (old) old.remove();
    var root = el('div'); root.id = 'lb';
    var p = el('div', 'lbp'); p.appendChild(el('div', 'lbt', '🏕️ Camping Manager 3D')); p.appendChild(el('div', 'lbs')); p.appendChild(el('div', 'lbg'));
    var jb = el('button', '', '🔑 Rejoindre avec un code'); jb.style.cssText = 'display:block;margin:14px auto 0;padding:10px 18px;border-radius:12px;border:1px solid #475569;background:#1e293b;color:#f8fafc;font-weight:700;cursor:pointer'; jb.onclick = joinByCode; p.appendChild(jb);
    p.appendChild(el('div', 'lbh'));
    root.appendChild(p); root.appendChild(el('div', 'lbcap')); document.body.appendChild(root); renderLobby();
  }
  function caption(t) { var c = document.querySelector('#lb .lbcap'); if (c) c.textContent = t || ''; }

  /* ---------- sauvegarde ---------- */
  function snapshot() {
    if (!getState) return null; var s; try { s = getState(); } catch (e) { return null; }
    if (!valid(s)) return null;                      // jamais de sauvegarde vide/corrompue
    var str; try { str = JSON.stringify(s); } catch (e) { return null; }
    if (!str || str.length > 4500000) return null; return str;
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(function () { push(false); }, ms); }

  async function push(force) {
    if (!user || !getState || halted || readOnly || !slot || offlineMode && !sb) return;
    if (saving) { pending = true; return; }
    var str = snapshot(); if (!str) return;
    latestStr = str;
    if (str === lastSent && !force) return;
    writeBackup(str, true);                          // copie locale de secours, synchrone
    if (!navigator.onLine) { setStatus('off'); return; }
    saving = true; setStatus('saving');
    try {
      var row = { save_data: JSON.parse(str), save_version: SAVE_VERSION, game_version: appVersion, client_id: clientId, revision: revision + 1 }, res;
      if (hasSlots && !shared) { try { row.meta = metaFn ? metaFn() : {}; } catch (e) { row.meta = {}; } }
      if (revision === 0) res = await sb.from('game_saves').insert(Object.assign({ user_id: user.id }, hasSlots ? { slot: slot } : {}, row)).select('revision');
      else res = await scoped(sb.from(T()).update(row)).eq('revision', revision).select('revision');
      if (res.error) { if (res.error.code === '23505') { await conflict(); return; } throw res.error; }
      if (!res.data || !res.data.length) { await conflict(); return; }
      revision = row.revision; lastSent = str; offlineMode = false;
      if (shared) { try { var mm = metaFn ? metaFn() : {}; mm.shared = shared; mm.multi = true; sb.from('game_saves').update({ meta: mm }).eq('user_id', user.id).eq('slot', slot).then(function () {}, function () {}); } catch (e) {} }
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
    var r = await scoped(sb.from(T()).select('save_data,save_version,revision,client_id')).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) { revision = 0; schedule(500); return; }                   // la ligne a disparu : on recrée
    if (r.data.client_id === clientId) { revision = r.data.revision; schedule(300); return; }
    if (shared) { if (!(await applyRemote(r.data))) schedule(2000); return; }
    var d = migrate(r.data.save_data, r.data.save_version || 1);
    if (valid(d) && confirm('Ce camping a été modifié sur un autre appareil.\n\nOK = charger la partie la plus récente (recommandé)\nAnnuler = garder cette partie et écraser l\'autre')) {
      halted = true; try { localStorage.removeItem(bkKey()); } catch (e) {} location.reload(); return;
    }
    revision = r.data.revision; schedule(300);
  }

  function flush() {
    if (readOnly) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; resolve(); } }, 2500);
      var str = snapshot(); if (str) { latestStr = str; writeBackup(str, str !== lastSent); }
      push(true).then(function () { if (!done) { done = true; clearTimeout(t); resolve(); } }, function () { if (!done) { done = true; resolve(); } });
    });
  }

  function attach(fn, mfn, nfn) {
    getState = fn; metaFn = mfn || null; newStateFn = nfn || null;
    if (readOnly) return;                            // salon : rien n'est jamais sauvegardé
    setInterval(function () { push(false); }, 60000);                               // sauvegarde périodique
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', function () { var s = snapshot(); if (s) writeBackup(s, s !== lastSent); flush(); });
    window.addEventListener('online', function () { schedule(500); });             // synchro au retour d'Internet
    window.addEventListener('offline', function () { setStatus('off'); });
    if (window.campingApp && window.campingApp.onFlushRequest) window.campingApp.onFlushRequest(function () { flush().then(window.campingApp.flushDone, window.campingApp.flushDone); });
    if (needSync && initialRaw) schedule(2000); // données importées / copie locale à envoyer
  }

  function notify() { if (halted || readOnly) return; schedule(3000); var s = snapshot(); if (s) { latestStr = s; writeBackup(s, s !== lastSent); } }

  async function resetSave() {                       // « Tout effacer » : supprime CE camping puis retour au salon
    halted = true;
    try { if (sb && user && navigator.onLine) { var r = await scoped(sb.from('game_saves').delete()); if (r.error) throw r.error; } } catch (e) { halted = false; alert("Impossible d'effacer la sauvegarde en ligne : " + frErr(e)); return; }
    try { localStorage.removeItem(bkKey()); if (slot === 1) localStorage.removeItem(bkLegacyKey()); localStorage.removeItem(LEGACY_KEY); localStorage.removeItem(lastKey()); } catch (e) {}
    ss('camping_play', null); ss('camping_slot', null); location.reload();
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

  /* ---------- multijoueur (2 joueurs, même camping) ---------- */
  function genCode() { var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = ''; for (var i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
  async function makeShared(n) {
    var g = await sb.from('game_saves').select('save_data,save_version,meta').eq('user_id', user.id).eq('slot', n).single(); if (g.error) throw g.error;
    for (var i = 0; i < 6; i++) {
      var r = await sb.from('shared_campings').insert({ code: genCode(), owner: user.id, members: [user.id], name: g.data.save_data.name || 'Camping', save_data: g.data.save_data, save_version: g.data.save_version, revision: 1, client_id: clientId, game_version: appVersion }).select('id').single();
      if (!r.error) { var u = await sb.from('game_saves').update({ meta: Object.assign({}, g.data.meta, { shared: r.data.id, multi: true }) }).eq('user_id', user.id).eq('slot', n); if (u.error) throw u.error; return; }
      if (r.error.code !== '23505') throw r.error;
    }
    throw new Error('Impossible de générer un code, réessaie.');
  }
  async function joinByCode() {
    var code = await ask({ title: 'Rejoindre un camping', text: 'Entre le code donné par ton ami :', input: { ph: 'Ex. K7M2QX', max: 8 }, ok: 'Rejoindre', validate: function (v) { return v.length < 4 ? 'Code trop court.' : ''; } });
    if (code == null) return;
    busy('Connexion au camping…');
    try {
      var j = await sb.rpc('join_shared', { p_code: code.toUpperCase().replace(/\s/g, '') }); if (j.error) throw j.error;
      var id = j.data, ex = slots.filter(function (x) { return x.meta && x.meta.shared === id; })[0];
      if (ex) { fadeGo(ex.slot, false, 'Ouverture…'); return; }
      if (slots.length >= MAX_SLOTS) throw new Error('Maximum ' + MAX_SLOTS + ' campings par compte : supprime-en un avant.');
      var s = await sb.from('shared_campings').select('save_data,save_version,name').eq('id', id).single(); if (s.error) throw s.error;
      var n = 0; for (var k = 1; !n && k <= MAX_SLOTS; k++) if (!slots.some(function (x) { return x.slot === k; })) n = k;
      var ins = await sb.from('game_saves').insert({ user_id: user.id, slot: n, save_data: s.data.save_data, save_version: s.data.save_version, game_version: appVersion, client_id: clientId, revision: 1, meta: { name: s.data.name, multi: true, shared: id } });
      if (ins.error) throw ins.error;
      fadeGo(n, false, 'Ouverture de « ' + s.data.name + ' »…');
    } catch (e) { unbusy(); alert(e && e.code === 'P0001' ? e.message : (e && e.message && !e.code ? e.message : frErr(e))); }
  }
  async function applyRemote(row) {                    // fusionne le camping du partenaire avec nos changements ; false = on réessaiera
    var d = migrate(row.save_data, row.save_version || 1); if (!valid(d)) return true;
    var keep = remoteHook ? remoteHook(d, lastSent || initialRaw) : false;
    if (keep === 'defer') return false;
    revision = row.revision;
    if (keep) { lastSent = ''; schedule(300); } else lastSent = snapshot() || lastSent;
    return true;
  }
  function startPoll() {                               // le partenaire a joué ? on récupère son camping toutes les 5 s
    if (!shared || pollT || mode !== 'play') return;
    pollT = setInterval(async function () {
      if (halted || saving || !navigator.onLine) return;
      try { var r = await sb.from('shared_campings').select('revision,client_id').eq('id', shared).maybeSingle();
        if (r.data && r.data.revision > revision && r.data.client_id !== clientId) await pullRemote(); } catch (e) {}
    }, 5000);
  }
  async function pullRemote() {
    var r = await sb.from('shared_campings').select('save_data,save_version,revision').eq('id', shared).maybeSingle();
    if (r.error || !r.data) return; await applyRemote(r.data); return;
    
  }

  window.CampingCloud = {
    boot: boot, attach: attach, notify: notify, flush: flush, resetSave: resetSave, getInitialRaw: function () { return initialRaw; }, saveVersion: SAVE_VERSION,
    mode: function () { return mode; }, showLobby: showLobby, caption: caption, toLobby: toLobby,
    createCamping: createCamping, deleteCamping: deleteCamping, goSlot: goSlot,
    getSlots: function () { return slots.slice(); }, isShared: function () { return !!shared; }, onRemote: function (fn) { remoteHook = fn; startPoll(); },
    shareInfo: async function () { var r = await sb.from('shared_campings').select('code,members').eq('id', shared).single(); if (r.error) throw r.error; return { code: r.data.code, players: r.data.members.length }; }, currentSlot: function () { return slot; }, maxSlots: MAX_SLOTS
  };
})();
