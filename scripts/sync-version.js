// Écrit website/version.json à partir de package.json (version du jeu).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const notes = process.env.NOTES || '';
const cfgPath = path.join(root, 'game', 'config.js');
let c = fs.readFileSync(cfgPath, 'utf8').replace(/"GAME_VERSION": "[^"]*"/, '"GAME_VERSION": "' + pkg.version + '"');
fs.writeFileSync(cfgPath, c);
const wp = path.join(root, 'website', 'js', 'config.js');
fs.writeFileSync(wp, fs.readFileSync(wp, 'utf8').replace(/"GAME_VERSION": "[^"]*"/, '"GAME_VERSION": "' + pkg.version + '"'));
fs.writeFileSync(path.join(root, 'website', 'version.json'), JSON.stringify({ version: pkg.version, notes, date: new Date().toISOString() }, null, 2));
console.log('Version synchronisée :', pkg.version);
