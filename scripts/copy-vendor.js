// Copie Three.js et supabase-js dans game/vendor pour que le jeu fonctionne sans CDN (Electron / hors ligne).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'game', 'vendor');
fs.mkdirSync(out, { recursive: true });
[['node_modules/three/build/three.min.js', 'three.min.js'],
 ['node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js']].forEach(([src, dst]) => {
  const s = path.join(root, src);
  if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(out, dst)); console.log('vendor OK :', dst); }
  else console.warn('Introuvable (npm install a-t-il réussi ?) :', src);
});
