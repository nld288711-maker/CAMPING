// Test de la logique de cloud.js avec un faux Supabase en mémoire. Lancer : node tests/cloud.test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../game/cloud.js', 'utf8');

function makeEnv(db, opts) {
  opts = opts || {};
  const store = opts.store || {};
  const calls = { insert: 0, update: 0 };
  const ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const q = (tbl) => {
    const st = { f: {} , op: 'select', row: null };
    const api = {
      select() { return api; }, eq(k, v) { st.f[k] = v; return api; },
      insert(row) { st.op = 'insert'; st.row = row; return api; }, update(row) { st.op = 'update'; st.row = row; return api; },
      maybeSingle() { return opts.offline ? Promise.reject(new Error('network')) : Promise.resolve({ data: db.row || null, error: null }); },
      then(res, rej) {
        let out;
        if (opts.offline) return Promise.resolve({ error: { message: 'network' } }).then(res, rej);
        if (st.op === 'insert') { calls.insert++; if (db.row) out = { error: { code: '23505' } }; else { db.row = Object.assign({}, st.row); out = { data: [{ revision: st.row.revision }], error: null }; } }
        else if (st.op === 'update') { calls.update++; if (db.row && db.row.revision === st.f.revision) { db.row = Object.assign({}, db.row, st.row); out = { data: [{ revision: st.row.revision }], error: null }; } else out = { data: [], error: null }; }
        return Promise.resolve(out).then(res, rej);
      }
    };
    return api;
  };
  const sb = { from: q, rpc: () => Promise.resolve({ data: true }), auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1', user_metadata: { username: 'Test' } } } } }), signOut: () => Promise.resolve() } };
  const el = () => ({ style: {}, classList: { toggle() {} }, appendChild() {}, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, remove() {}, set innerHTML(v) {}, set textContent(v) {} });
  const listeners = {};
  const win = { CAMPING_CONFIG: { SUPABASE_URL: 'x', SUPABASE_KEY: 'y', GAME_VERSION: '1.0.0' }, supabase: { createClient: () => sb },
    addEventListener() {}, location: { reload() { win.reloaded = true; } }, alert() {}, confirm: opts.confirm || (() => true) };
  const ctx = { window: win, document: { head: el(), body: el(), getElementById: () => null, createElement: el, addEventListener() {}, visibilityState: 'visible' },
    localStorage: ls, navigator: { onLine: true }, setTimeout, clearTimeout, setInterval: () => 0, console, JSON, Date, Math, isFinite, location: win.location, alert: win.alert, confirm: win.confirm, fetch: () => Promise.reject(new Error('x')) };
  ctx.window.window = win; vm.createContext(ctx); vm.runInContext(src, ctx);
  return { cloud: win.CampingCloud, store, calls, win };
}
const game = (money) => ({ money, parcels: [{ id: '0-0' }], buildings: [{ t: 'tent' }], day: 3 });
const tick = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  // 1. Nouveau compte : une partie valide est envoyée (insert), le backup est marqué propre
  let db = { row: null }; let e = makeEnv(db);
  await e.cloud.boot(); assert.strictEqual(e.cloud.getInitialRaw(), null);
  let S = game(100); e.cloud.attach(() => S); await e.cloud.flush();
  assert.strictEqual(db.row.revision, 1); assert.strictEqual(db.row.save_data.money, 100); console.log('OK 1 : première sauvegarde (insert)');

  // 2. Une sauvegarde vide / corrompue n'est JAMAIS envoyée
  S = { money: 0, parcels: [], buildings: [] }; await e.cloud.flush(); assert.strictEqual(db.row.save_data.money, 100);
  S = null; await e.cloud.flush(); assert.strictEqual(db.row.save_data.money, 100);
  S = { money: NaN, parcels: [1], buildings: [] }; await e.cloud.flush(); assert.strictEqual(db.row.save_data.money, 100); console.log('OK 2 : vide/corrompu refusé');

  // 3. Mise à jour normale (revision +1)
  S = game(250); await e.cloud.flush(); assert.strictEqual(db.row.revision, 2); assert.strictEqual(db.row.save_data.money, 250); console.log('OK 3 : update avec révision');

  // 5. Réouverture (autre session) : la partie est récupérée à l'identique
  let e2 = makeEnv(db); await e2.cloud.boot();
  const got = JSON.parse(e2.cloud.getInitialRaw()); assert.strictEqual(got.money, 250); assert.deepStrictEqual(got.buildings, [{ t: 'tent' }]); console.log('OK 5 : récupération au démarrage');

  // 6. Conflit entre deux appareils : refus d'écraser, bascule sur la version en ligne
  let e3 = makeEnv(db, { confirm: () => true }); await e3.cloud.boot(); let S3 = game(300); e3.cloud.attach(() => S3);
  db.row = Object.assign({}, db.row, { revision: db.row.revision + 5, client_id: 'autre', save_data: game(9999) }); // un autre appareil a sauvegardé
  await e3.cloud.flush(); assert.strictEqual(db.row.save_data.money, 9999); assert.ok(e3.win.reloaded); console.log('OK 6 : conflit détecté, rien d\'écrasé');

  // 7. Hors ligne : la partie est gardée en copie locale puis envoyée au retour d'Internet
  db = { row: null }; const opts7 = { store: {}, offline: false };
  let e4 = makeEnv(db, opts7); await e4.cloud.boot(); let S4 = game(400); e4.cloud.attach(() => S4); await e4.cloud.flush();
  assert.strictEqual(db.row.save_data.money, 400);
  opts7.offline = true; S4 = game(500); await e4.cloud.flush();
  assert.strictEqual(db.row.save_data.money, 400, 'rien envoyé hors ligne');
  const bk = JSON.parse(opts7.store['camping_backup_u1']); assert.strictEqual(bk.dirty, true); assert.strictEqual(JSON.parse(bk.raw).money, 500);
  // Relance de l'application HORS LIGNE : la copie locale est rechargée
  let e5 = makeEnv(db, { store: opts7.store, offline: true }); await e5.cloud.boot();
  assert.strictEqual(JSON.parse(e5.cloud.getInitialRaw()).money, 500);
  // Retour d'Internet : la progression locale est envoyée
  opts7.offline = false; await e4.cloud.flush(); assert.strictEqual(db.row.save_data.money, 500);
  console.log('OK 7 : hors ligne -> copie locale -> relance hors ligne -> synchro');
  // 8. Relance en ligne avec progression locale non synchronisée (même révision) : la copie locale est reprise
  db = { row: null }; const o8 = { store: {} }; let e6 = makeEnv(db, o8); await e6.cloud.boot(); let S6 = game(10); e6.cloud.attach(() => S6); await e6.cloud.flush();
  o8.offline = true; S6 = game(77); await e6.cloud.flush(); o8.offline = false;
  let e7 = makeEnv(db, { store: o8.store }); await e7.cloud.boot(); assert.strictEqual(JSON.parse(e7.cloud.getInitialRaw()).money, 77);
  console.log('OK 8 : progression hors ligne retrouvée au redémarrage');
  console.log('\nTOUS LES TESTS PASSENT');
})().catch(err => { console.error('ÉCHEC', err); process.exit(1); });
