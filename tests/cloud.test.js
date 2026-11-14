// Test de la logique de cloud.js avec un faux Supabase en mémoire. Lancer : node tests/cloud.test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../game/cloud.js', 'utf8');

function makeEnv(db, opts) {
  opts = opts || {};
  const store = opts.store || {};
  const calls = { insert: 0, update: 0 };
  const sess = Object.assign({}, opts.session || {});
  const ss = { getItem: k => (k in sess ? sess[k] : null), setItem: (k, v) => { sess[k] = String(v); }, removeItem: k => { delete sess[k]; } };
  const ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const match = (r, f) => Object.keys(f).every(k => r[k] === f[k]);
  const q = (tbl) => {
    const st = { f: {}, op: 'select', row: null, sel: '' };
    const run = () => {
      if (opts.offline) return Promise.resolve({ data: null, error: { message: 'network' } });
      if (tbl !== 'game_saves') return Promise.resolve({ data: [], error: null });
      const rows = db.rows;
      if (st.op === 'select') return Promise.resolve({ data: rows.filter(r => match(r, st.f)).map(r => Object.assign({}, r, /sn:/.test(st.sel) ? { sn: r.save_data.name, sm: String(r.save_data.money), sd: String(r.save_data.day), smo: String(r.save_data.month) } : {})), error: null });
      if (st.op === 'insert') {
        calls.insert++;
        const r = Object.assign({ slot: 1 }, st.row);
        if (!(r.slot >= 1 && r.slot <= 4)) return Promise.resolve({ data: null, error: { code: '23514' } });
        if (rows.some(x => x.user_id === r.user_id && x.slot === r.slot)) return Promise.resolve({ data: null, error: { code: '23505' } });
        rows.push(JSON.parse(JSON.stringify(r))); return Promise.resolve({ data: [{ revision: r.revision }], error: null });
      }
      if (st.op === 'update') {
        calls.update++; const m = rows.filter(r => match(r, st.f));
        m.forEach(r => Object.assign(r, JSON.parse(JSON.stringify(st.row)))); return Promise.resolve({ data: m.map(r => ({ revision: r.revision })), error: null });
      }
      if (st.op === 'delete') { db.rows = rows.filter(r => !match(r, st.f)); return Promise.resolve({ data: [], error: null }); }
    };
    const api = {
      select(c) { st.sel = c || ''; return api; }, eq(k, v) { st.f[k] = v; return api; },
      insert(row) { st.op = 'insert'; st.row = row; return api; }, update(row) { st.op = 'update'; st.row = row; return api; }, delete() { st.op = 'delete'; return api; },
      maybeSingle() { if (opts.offline) return Promise.reject(new Error('network')); return run().then(o => (o.data && o.data.length > 1) ? { data: null, error: { message: 'multiple rows' } } : { data: o.data ? (o.data[0] || null) : null, error: o.error || null }); },
      then(res, rej) { return run().then(res, rej); }
    };
    return api;
  };
  const sb = { from: q, rpc: () => Promise.resolve({ data: true }), auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1', user_metadata: { username: 'Test' } } } } }), signOut: () => Promise.resolve() } };
  const el = () => ({ style: {}, classList: { toggle() {} }, appendChild() {}, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, remove() {}, set innerHTML(v) {}, set textContent(v) {} });
  const listeners = {};
  const win = { CAMPING_CONFIG: { SUPABASE_URL: 'x', SUPABASE_KEY: 'y', GAME_VERSION: '1.0.0' }, supabase: { createClient: () => sb },
    addEventListener() {}, location: { reload() { win.reloaded = true; } }, alert() {}, confirm: opts.confirm || (() => true) };
  const ctx = { window: win, document: { head: el(), body: el(), getElementById: () => null, createElement: el, addEventListener() {}, visibilityState: 'visible' },
    localStorage: ls, sessionStorage: ss, navigator: { onLine: true }, setTimeout, clearTimeout, setInterval: () => 0, console, JSON, Date, Math, isFinite, location: win.location, alert: win.alert, confirm: win.confirm, fetch: () => Promise.reject(new Error('x')) };
  ctx.window.window = win; vm.createContext(ctx); vm.runInContext(src, ctx);
  return { cloud: win.CampingCloud, store, calls, win, sess };
}
const game = (money, name) => ({ money, name: name || 'Camp', month: 6, day: 3, parcels: [{ id: '0-0' }], buildings: [{ t: 'tent' }] });
const mkdb = () => ({ rows: [], get row() { return this.rows[0] || null; }, set row(v) { if (v) this.rows[0] = v; else this.rows = []; } });
const PLAY = (n) => ({ session: { camping_play: '1', camping_slot: String(n || 1) } });   // démarrage direct « en jeu » sur un camping
const seed = (db, slot, money, name) => db.rows.push({ user_id: 'u1', slot, revision: 1, client_id: 'x', save_data: game(money, name), meta: { name: name || 'Camp' } });
(async () => {
  // 1. Compte neuf : salon vide, création d'un camping (insert), le salon ne sauvegarde JAMAIS
  let db = mkdb(); let e = makeEnv(db);
  await e.cloud.boot(); assert.strictEqual(e.cloud.mode(), 'lobby'); assert.strictEqual(e.cloud.getInitialRaw(), null); assert.deepStrictEqual(e.cloud.getSlots(), []);
  let S = game(100); e.cloud.attach(() => S, () => ({}), n => game(35000, n));
  await e.cloud.flush(); assert.strictEqual(e.calls.insert + e.calls.update, 0, 'le salon ne doit rien écrire');
  const n1 = await e.cloud.createCamping('Les Flots Bleus'); assert.strictEqual(n1, 1);
  assert.strictEqual(db.rows[0].slot, 1); assert.strictEqual(db.rows[0].save_data.name, 'Les Flots Bleus'); assert.strictEqual(db.rows[0].meta.name, 'Les Flots Bleus'); assert.strictEqual(db.rows[0].revision, 1);
  console.log('OK 1 : salon en lecture seule + création du 1er camping');

  // 2. Une sauvegarde vide / corrompue n'est JAMAIS envoyée (en jeu)
  db = mkdb(); seed(db, 1, 100); e = makeEnv(db, PLAY());
  await e.cloud.boot(); assert.strictEqual(e.cloud.mode(), 'play'); S = game(100); e.cloud.attach(() => S);
  S = { money: 0, parcels: [], buildings: [] }; await e.cloud.flush(); assert.strictEqual(db.row.save_data.money, 100);
  S = null; await e.cloud.flush(); assert.strictEqual(db.row.save_data.money, 100);
  S = { money: NaN, parcels: [1], buildings: [] }; await e.cloud.flush(); assert.strictEqual(db.row.save_data.money, 100); console.log('OK 2 : vide/corrompu refusé');

  // 3. Mise à jour normale (revision +1) + résumé (meta) mis à jour
  S = game(250); await e.cloud.flush(); assert.strictEqual(db.row.revision, 2); assert.strictEqual(db.row.save_data.money, 250); console.log('OK 3 : update avec révision');

  // 5. Réouverture (autre session) : la partie est récupérée à l'identique
  let e2 = makeEnv(db, PLAY()); await e2.cloud.boot();
  const got = JSON.parse(e2.cloud.getInitialRaw()); assert.strictEqual(got.money, 250); assert.deepStrictEqual(got.buildings, [{ t: 'tent' }]); console.log('OK 5 : récupération au démarrage');

  // 6. Conflit entre deux appareils : refus d'écraser, bascule sur la version en ligne
  let e3 = makeEnv(db, Object.assign({ confirm: () => true }, PLAY())); await e3.cloud.boot(); let S3 = game(300); e3.cloud.attach(() => S3);
  db.row = Object.assign({}, db.row, { revision: db.row.revision + 5, client_id: 'autre', save_data: game(9999) });
  await e3.cloud.flush(); assert.strictEqual(db.row.save_data.money, 9999); assert.ok(e3.win.reloaded); assert.strictEqual(e3.sess.camping_play, '1', 'on reste en jeu après le rechargement'); console.log('OK 6 : conflit détecté, rien d\'écrasé');

  // 7. Hors ligne : copie locale (par camping) puis envoyée au retour d'Internet
  db = mkdb(); seed(db, 1, 400); const opts7 = Object.assign({ store: {}, offline: false }, PLAY());
  let e4 = makeEnv(db, opts7); await e4.cloud.boot(); let S4 = game(400); e4.cloud.attach(() => S4); await e4.cloud.flush();
  opts7.offline = true; S4 = game(500); await e4.cloud.flush();
  assert.strictEqual(db.row.save_data.money, 400, 'rien envoyé hors ligne');
  const bk = JSON.parse(opts7.store['camping_backup_u1_1']); assert.strictEqual(bk.dirty, true); assert.strictEqual(JSON.parse(bk.raw).money, 500);
  let e5 = makeEnv(db, Object.assign({ store: opts7.store, offline: true }, PLAY())); await e5.cloud.boot();
  assert.strictEqual(JSON.parse(e5.cloud.getInitialRaw()).money, 500);
  opts7.offline = false; await e4.cloud.flush(); assert.strictEqual(db.row.save_data.money, 500);
  console.log('OK 7 : hors ligne -> copie locale -> relance hors ligne -> synchro');

  // 8. Relance en ligne avec progression locale non synchronisée (même révision) : la copie locale est reprise
  db = mkdb(); seed(db, 1, 10); const o8 = Object.assign({ store: {} }, PLAY()); let e6 = makeEnv(db, o8); await e6.cloud.boot(); let S6 = game(10); e6.cloud.attach(() => S6); await e6.cloud.flush();
  o8.offline = true; S6 = game(77); await e6.cloud.flush(); o8.offline = false;
  let e7 = makeEnv(db, Object.assign({ store: o8.store }, PLAY())); await e7.cloud.boot(); assert.strictEqual(JSON.parse(e7.cloud.getInitialRaw()).money, 77);
  console.log('OK 8 : progression hors ligne retrouvée au redémarrage');

  // 9. Plusieurs campings : 4 maximum, emplacements indépendants, suppression qui libère la place
  db = mkdb(); let e8 = makeEnv(db); await e8.cloud.boot(); e8.cloud.attach(() => game(1), () => ({}), n => game(35000, n));
  for (const nm of ['A', 'B', 'C', 'D']) await e8.cloud.createCamping(nm);
  assert.deepStrictEqual(db.rows.map(r => r.slot).sort(), [1, 2, 3, 4]);
  await assert.rejects(() => e8.cloud.createCamping('E'), /Maximum 4/); assert.strictEqual(db.rows.length, 4);
  await e8.cloud.deleteCamping(2); assert.deepStrictEqual(db.rows.map(r => r.slot).sort(), [1, 3, 4]);
  assert.strictEqual(await e8.cloud.createCamping('E'), 2); assert.strictEqual(db.rows.find(r => r.slot === 2).save_data.name, 'E');
  // jouer le camping n°3 ne touche pas aux autres
  const before = JSON.stringify(db.rows.filter(r => r.slot !== 3));
  let e9 = makeEnv(db, PLAY(3)); await e9.cloud.boot(); assert.strictEqual(JSON.parse(e9.cloud.getInitialRaw()).name, 'C'); let S9 = game(555, 'C'); e9.cloud.attach(() => S9, () => ({ name: 'C' })); await e9.cloud.flush();
  assert.strictEqual(db.rows.find(r => r.slot === 3).save_data.money, 555); assert.strictEqual(JSON.stringify(db.rows.filter(r => r.slot !== 3)), before);
  // le salon choisit le camping demandé, et goSlot mémorise le choix
  let e10 = makeEnv(db, { session: { camping_slot: '4' } }); await e10.cloud.boot(); assert.strictEqual(e10.cloud.mode(), 'lobby'); assert.strictEqual(e10.cloud.currentSlot(), 4);
  e10.cloud.goSlot(1, true); assert.strictEqual(e10.sess.camping_slot, '1'); assert.strictEqual(e10.sess.camping_play, '1'); assert.ok(e10.win.reloaded);
  console.log('OK 9 : 4 campings max, emplacements indépendants, suppression, sélection');

  // 10. Nom stocké tel quel (jamais interprété) ; ancien backup local (1 seul camping) repris pour le camping n°1
  db = mkdb(); seed(db, 1, 5); const st10 = { 'camping_backup_u1': JSON.stringify({ v: 1, baseRevision: 1, dirty: true, savedAt: 1, raw: JSON.stringify(game(42)) }) };
  let e11 = makeEnv(db, Object.assign({ store: st10 }, PLAY())); await e11.cloud.boot(); assert.strictEqual(JSON.parse(e11.cloud.getInitialRaw()).money, 42);
  console.log('OK 10 : ancien backup local migré vers le camping n°1');
  console.log('\nTOUS LES TESTS PASSENT');
})().catch(err => { console.error('ÉCHEC', err); process.exit(1); });
