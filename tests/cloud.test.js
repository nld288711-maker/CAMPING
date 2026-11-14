// Test de la logique de cloud.js (comptes, sauvegardes, campings multiples) avec un faux Supabase en mémoire.
// Lancer : node tests/cloud.test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../game/cloud.js', 'utf8');

function getPath(o, p) { return p.split('->>').reduce((a, k) => (a == null ? a : a[k]), o); }

// db = { rows: [...], legacy: bool (ancienne base sans colonne slot) }
function makeEnv(db, opts) {
  opts = opts || {};
  const store = opts.store || {}, sess = opts.session || {};
  const ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }, get length() { return Object.keys(store).length; }, key: i => Object.keys(store)[i] || null };
  const ss = { getItem: k => (k in sess ? sess[k] : null), setItem: (k, v) => { sess[k] = String(v); }, removeItem: k => { delete sess[k]; } };
  const q = (tbl) => {
    const st = { f: [], op: 'select', row: null, cols: '*', single: false };
    const noSlot = () => db.legacy && (st.f.some(x => x[0] === 'slot') || (st.row && 'slot' in st.row) || /slot/.test(st.cols));
    const match = r => st.f.every(x => (r[x[0]] === undefined && x[0] === 'slot' ? 1 : r[x[0]]) === x[1]);
    const proj = r => st.cols === '*' ? r : st.cols.split(',').reduce((o, c) => { const m = c.trim().match(/^(?:(\w+):)?(.+)$/); o[m[1] || m[2].split('->>').pop()] = getPath(r, m[2]); return o; }, {});
    const run = () => {
      if (opts.offline) return Promise.resolve({ data: null, error: { message: 'fetch failed' } });
      if (tbl !== 'game_saves') return Promise.resolve({ data: [], error: null });
      if (noSlot()) return Promise.resolve({ data: null, error: { code: '42703', message: 'column game_saves.slot does not exist' } });
      if (st.op === 'select') { const r = db.rows.filter(match).map(proj); return Promise.resolve({ data: st.single ? (r[0] || null) : r, error: null }); }
      if (st.op === 'insert') {
        const row = Object.assign({ slot: 1 }, st.row);
        if (db.rows.some(x => x.user_id === row.user_id && x.slot === row.slot)) return Promise.resolve({ data: null, error: { code: '23505' } });
        if (row.slot < 1 || row.slot > 4) return Promise.resolve({ data: null, error: { code: '23514', message: 'slot_range' } });
        db.rows.push(row); db.inserts = (db.inserts || 0) + 1; return Promise.resolve({ data: [{ revision: row.revision }], error: null });
      }
      if (st.op === 'update') { const hit = db.rows.filter(match); hit.forEach(r => Object.assign(r, st.row)); db.updates = (db.updates || 0) + 1; return Promise.resolve({ data: hit.map(r => ({ revision: r.revision })), error: null }); }
      if (st.op === 'delete') { db.rows = db.rows.filter(r => !match(r)); return Promise.resolve({ data: [], error: null }); }
    };
    const api = {
      select(c) { st.cols = c || '*'; return api; }, eq(k, v) { st.f.push([k, v]); return api; },
      insert(r) { st.op = 'insert'; st.row = r; return api; }, update(r) { st.op = 'update'; st.row = r; return api; }, delete() { st.op = 'delete'; return api; },
      maybeSingle() { st.single = true; return run(); }, then(res, rej) { return run().then(res, rej); }
    };
    return api;
  };
  const sb = { from: q, rpc: () => Promise.resolve({ data: true }), auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1', user_metadata: { username: 'Test' } } } } }), signOut: () => Promise.resolve(), refreshSession: () => Promise.resolve({}) } };
  const el = () => ({ style: {}, classList: { toggle() {} }, appendChild() {}, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, remove() {}, set innerHTML(v) {}, set textContent(v) {} });
  const win = { CAMPING_CONFIG: { SUPABASE_URL: 'x', SUPABASE_KEY: 'y', GAME_VERSION: '1.1.0' }, supabase: { createClient: () => sb },
    addEventListener() {}, location: { reload() { win.reloaded = true; } }, alert() {}, confirm: opts.confirm || (() => true) };
  const ctx = { window: win, document: { head: el(), body: el(), getElementById: () => null, createElement: el, addEventListener() {}, visibilityState: 'visible' },
    localStorage: ls, sessionStorage: ss, navigator: { onLine: true }, setTimeout, clearTimeout, setInterval: () => 0, console, JSON, Date, Math, isFinite, Number, String, location: win.location, alert: win.alert, confirm: win.confirm, fetch: () => Promise.reject(new Error('x')) };
  ctx.window.window = win; vm.createContext(ctx); vm.runInContext(src, ctx);
  return { cloud: win.CampingCloud, store, sess, win };
}
const game = (money, name) => ({ money, parcels: [{ id: '0-0' }], buildings: [{ t: 'tent' }], day: 3, name: name || 'Camp' });
const enter = (slot, isNew, name) => ({ camping_enter: JSON.stringify({ slot, isNew: !!isNew, name: name || null }) });
(async () => {
  // 1. Nouveau camping n°2 (choisi dans le salon) : nom conservé, insertion dans le bon emplacement
  let db = { rows: [{ user_id: 'u1', slot: 1, save_data: game(500, 'Premier'), save_version: 1, revision: 4, updated_at: '2026-01-02T00:00:00Z' }] };
  let e = makeEnv(db, { session: enter(2, true, 'Les Pins') }); await e.cloud.boot();
  assert.strictEqual(e.cloud.isLobby(), false); assert.strictEqual(e.cloud.getSlot(), 2); assert.strictEqual(e.cloud.getNewName(), 'Les Pins'); assert.strictEqual(e.cloud.getInitialRaw(), null);
  let S = game(100, 'Les Pins'); e.cloud.attach(() => S); await e.cloud.flush();
  assert.strictEqual(db.rows.length, 2); const r2 = db.rows.find(r => r.slot === 2); assert.ok(r2); assert.strictEqual(r2.save_data.name, 'Les Pins'); assert.strictEqual(r2.revision, 1);
  assert.strictEqual(db.rows.find(r => r.slot === 1).save_data.money, 500, 'le camping n°1 est intact'); console.log('OK 1 : nouveau camping créé dans l\'emplacement 2, camping 1 intact');

  // 2. Une sauvegarde vide / corrompue n'est JAMAIS envoyée ; un NaN ne bloque plus les sauvegardes
  S = { money: 0, parcels: [], buildings: [] }; await e.cloud.flush(); assert.strictEqual(r2.save_data.money, 100);
  S = null; await e.cloud.flush(); assert.strictEqual(r2.save_data.money, 100);
  S = Object.assign(game(0, 'Les Pins'), { money: NaN }); await e.cloud.flush(); assert.strictEqual(r2.save_data.money, 100);
  console.log('OK 2 : vide/corrompu refusé');

  // 3. Mise à jour : révisions indépendantes par camping
  S = game(250, 'Les Pins'); await e.cloud.flush(); assert.strictEqual(db.rows.find(r => r.slot === 2).revision, 2); assert.strictEqual(db.rows.find(r => r.slot === 1).revision, 4);
  assert.strictEqual(db.rows.find(r => r.slot === 1).save_data.money, 500); console.log('OK 3 : mise à jour du camping 2 sans toucher le camping 1');

  // 4. Réouverture du camping 2 : récupéré à l'identique
  let e2 = makeEnv(db, { session: enter(2) }); await e2.cloud.boot();
  assert.strictEqual(e2.cloud.isLobby(), false); const got = JSON.parse(e2.cloud.getInitialRaw()); assert.strictEqual(got.money, 250); assert.strictEqual(got.name, 'Les Pins'); console.log('OK 4 : récupération du bon camping');

  // 5. Salon d'accueil : aucun camping choisi => décor = camping le plus récent, RIEN n'est jamais écrit
  db.rows.find(r => r.slot === 1).updated_at = '2026-05-01T00:00:00Z'; db.rows.find(r => r.slot === 2).updated_at = '2026-03-01T00:00:00Z';
  const before = JSON.stringify(db.rows); let e3 = makeEnv(db); await e3.cloud.boot();
  assert.strictEqual(e3.cloud.isLobby(), true); assert.strictEqual(JSON.parse(e3.cloud.getInitialRaw()).name, 'Premier');
  let S3 = game(1, 'Sandbox'); e3.cloud.attach(() => S3); e3.cloud.notify(); await e3.cloud.flush();
  assert.strictEqual(JSON.stringify(db.rows), before, 'le salon ne modifie aucune sauvegarde'); assert.ok(!Object.keys(e3.store).some(k => k.indexOf('camping_backup') === 0), 'ni copie locale');
  console.log('OK 5 : salon = simulation jetable, aucune écriture');

  // 6. Premier lancement : aucun camping => salon avec décor de démonstration
  let e4 = makeEnv({ rows: [] }); await e4.cloud.boot(); assert.strictEqual(e4.cloud.isLobby(), true); assert.strictEqual(e4.cloud.getInitialRaw(), null); console.log('OK 6 : aucun camping => salon vide + décor de démo');

  // 7. Camping supprimé ailleurs : le salon s'ouvre au lieu de recréer une partie vide par erreur
  let e5 = makeEnv(db, { session: enter(4, false) }); await e5.cloud.boot(); assert.strictEqual(e5.cloud.isLobby(), true); console.log('OK 7 : emplacement disparu => retour au salon');

  // 8. Conflit entre deux appareils : refus d'écraser, bascule sur la version en ligne
  let e6 = makeEnv(db, { session: enter(1) }); await e6.cloud.boot(); let S6 = game(300, 'Premier'); e6.cloud.attach(() => S6);
  const row1 = db.rows.find(r => r.slot === 1); row1.revision += 5; row1.client_id = 'autre'; row1.save_data = game(9999, 'Premier');
  await e6.cloud.flush(); assert.strictEqual(row1.save_data.money, 9999); assert.ok(e6.win.reloaded); console.log('OK 8 : conflit détecté, rien d\'écrasé');

  // 9. Hors ligne : copie locale puis envoi au retour d'Internet
  db = { rows: [] }; const o9 = { store: {}, session: enter(1, true, 'Hors'), offline: false };
  let e7 = makeEnv(db, o9); await e7.cloud.boot(); let S7 = game(400, 'Hors'); e7.cloud.attach(() => S7); await e7.cloud.flush(); assert.strictEqual(db.rows[0].save_data.money, 400);
  o9.offline = true; S7 = game(500, 'Hors'); await e7.cloud.flush(); assert.strictEqual(db.rows[0].save_data.money, 400, 'rien envoyé hors ligne');
  const bk = JSON.parse(o9.store['camping_backup_u1_1']); assert.strictEqual(bk.dirty, true); assert.strictEqual(JSON.parse(bk.raw).money, 500);
  let e8 = makeEnv(db, { store: o9.store, session: enter(1), offline: true }); await e8.cloud.boot(); assert.strictEqual(JSON.parse(e8.cloud.getInitialRaw()).money, 500);
  let e9 = makeEnv(db, { store: o9.store, offline: true }); await e9.cloud.boot(); assert.strictEqual(e9.cloud.isLobby(), true); assert.strictEqual(JSON.parse(e9.cloud.getInitialRaw()).money, 500, 'salon hors ligne : copies locales');
  o9.offline = false; await e7.cloud.flush(); assert.strictEqual(db.rows[0].save_data.money, 500); console.log('OK 9 : hors ligne -> copie locale -> salon hors ligne -> synchro');

  // 10. Ancienne copie locale (avant les campings multiples) retrouvée dans l'emplacement 1
  db = { rows: [] }; const old = { 'camping_backup_u1': JSON.stringify({ v: 1, baseRevision: 0, dirty: true, savedAt: 1, raw: JSON.stringify(game(77, 'Ancien')) }) };
  let e10 = makeEnv(db, { store: old, session: enter(1, true, 'x') }); await e10.cloud.boot(); assert.strictEqual(JSON.parse(e10.cloud.getInitialRaw()).money, 77); console.log('OK 10 : ancienne copie locale reprise');

  // 11. Base PAS ENCORE migrée (pas de colonne slot) : le jeu reste jouable en mode « un seul camping »
  db = { legacy: true, rows: [{ user_id: 'u1', save_data: game(42, 'Vieux'), save_version: 1, revision: 2 }] };
  let e11 = makeEnv(db); await e11.cloud.boot(); assert.strictEqual(e11.cloud.isLobby(), false); assert.strictEqual(JSON.parse(e11.cloud.getInitialRaw()).money, 42);
  let S11 = game(43, 'Vieux'); e11.cloud.attach(() => S11); await e11.cloud.flush(); assert.strictEqual(db.rows[0].save_data.money, 43); assert.ok(!('slot' in db.rows[0])); console.log('OK 11 : ancienne base => mode un seul camping, rien ne casse');

  // 12. La base refuse un 5e camping (contrainte slot 1..4)
  const bad = makeEnv({ rows: [] }); const sbBad = bad.win.supabase.createClient();
  const r = await sbBad.from('game_saves').insert({ user_id: 'u1', slot: 5, save_data: game(1), revision: 1 }); assert.ok(r.error); console.log('OK 12 : 5e camping refusé par la base');
  console.log('\nTOUS LES TESTS PASSENT');
})().catch(err => { console.error('ÉCHEC', err); process.exit(1); });
