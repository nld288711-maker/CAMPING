// Lit .env et écrit game/config.js et website/js/config.js (clé publiable uniquement).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const envFile = fs.existsSync(path.join(root, '.env')) ? '.env' : '.env.example';
const env = {};
fs.readFileSync(path.join(root, envFile), 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#')) env[m[1]] = m[2];
});
if (/sb_secret|service_role/.test(JSON.stringify(env))) { console.error('ERREUR : clé secrète détectée. Abandon.'); process.exit(1); }
const cfg = {
  SUPABASE_URL: env.SUPABASE_URL, SUPABASE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
  SITE_URL: (env.SITE_URL || '').replace(/\/$/, ''), GAME_VERSION: env.GAME_VERSION || '1.0.0',
  GITHUB_REPO: env.GITHUB_REPO
};
const json = JSON.stringify(cfg, null, 2);
fs.writeFileSync(path.join(root, 'game', 'config.js'), 'window.CAMPING_CONFIG = ' + json + ';\n');
fs.writeFileSync(path.join(root, 'website', 'js', 'config.js'), 'export const CONFIG = ' + json + ';\n');
console.log('Config écrite depuis', envFile);
