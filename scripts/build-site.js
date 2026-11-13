// Assemble le site : insère le CSS, l'en-tête et le pied de page DIRECTEMENT dans chaque page HTML
// (chaque page est ainsi autonome et ne peut plus s'afficher « toute blanche »).
// À relancer après toute modification de website/css/style.css :  npm run css
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'website');
const css = fs.readFileSync(path.join(dir, 'css', 'style.css'), 'utf8').replace(/url\(\.\.\/img\//g, 'url(img/');
const cfg = fs.readFileSync(path.join(dir, 'js', 'config.js'), 'utf8');
const dl = (cfg.match(/"DOWNLOAD_URL":\s*"([^"]+)"/) || [])[1] || '#';
const header = page => `<div class="bg"></div>
<header class="top"><div class="wrap">
<a class="logo" href="index.html"><img src="img/icon.png" alt=""><b>Campground <i>Builder</i></b></a>
<nav><a href="index.html"${page === 'index.html' ? ' class="on"' : ''}>Accueil</a><a href="download.html"${page === 'download.html' ? ' class="on"' : ''}>Télécharger</a>
<span id="nav-auth"><a href="login.html"${page === 'login.html' ? ' class="on"' : ''}>Se connecter</a><a class="btn sm" href="register.html">Créer un compte</a></span>
<button id="snd" aria-label="Son" title="Activer l'ambiance sonore">🔇</button></nav></div></header>`;
const footer = `<footer><div class="wrap">© ${new Date().getFullYear()} Campground Builder — Construisez · Aménagez · Accueillez</div></footer>`;
const swap = (h, tag, content) => h.replace(new RegExp(`<!--${tag}-->[\\s\\S]*?<!--/${tag}-->`), () => `<!--${tag}-->${content}<!--/${tag}-->`);
fs.readdirSync(dir).filter(f => f.endsWith('.html')).forEach(f => {
  let h = fs.readFileSync(path.join(dir, f), 'utf8');
  const page = (h.match(/data-page="([^"]+)"/) || [])[1] || f;
  h = swap(h, 'CSS', '<meta name="color-scheme" content="dark"><style>' + css + '</style>');
  h = swap(h, 'HEADER', header(page));
  h = swap(h, 'FOOTER', footer);
  fs.writeFileSync(path.join(dir, f), h);
  console.log('OK', f, Math.round(h.length / 1024) + ' Ko');
});
