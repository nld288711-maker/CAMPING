# CAMPING — site, jeu, comptes, sauvegardes cloud, application Windows

## Structure
```
CAMPING/
├─ database/schema.sql        Tables + règles RLS (à exécuter dans Supabase)
├─ game/
│  ├─ index.html              TON jeu, modifié (voir « Modifications » ci-dessous)
│  ├─ index.original.html     copie intacte de ton jeu d'origine
│  ├─ cloud.js                comptes + sauvegarde en ligne + copie locale + mises à jour
│  ├─ config.js               URL + clé PUBLIABLE Supabase (aucune clé secrète)
│  └─ vendor/                 (créé par npm install) three.js + supabase-js en local
├─ website/                   index, register, login, reset, account, download + css/js
│  └─ version.json            dernière version publiée
├─ electron/main.js, preload.js   application Windows + electron-updater
├─ scripts/                   copy-vendor, generate-config (.env), sync-version
├─ tests/cloud.test.js        tests de la logique de sauvegarde
├─ package.json, .env.example, .gitignore
```

## Modifications faites dans ton index.html (diff complet : `diff game/index.original.html game/index.html`)
1. Ajout de `config.js` et `cloud.js` avant ton script.
2. Three.js : essaie d'abord `vendor/three.min.js`, puis tes 3 CDN d'origine.
3. Le démarrage passe par `CampingCloud.boot()` (écran de connexion) avant `start()`.
4. Au chargement, l'état vient de la sauvegarde du compte (au lieu de `localStorage`).
5. `save()` appelle `CampingCloud.notify()` ; l'objet `S` complet est sauvegardé.
6. Le bouton « Tout effacer » efface aussi la sauvegarde en ligne (confirmation renforcée).
Aucun élément de gameplay n'est modifié.

## Étape 1 — Supabase (≈ 5 min)
1. https://supabase.com/dashboard → ton projet → menu **SQL Editor** → **New query**.
2. Colle tout `database/schema.sql` → **Run**. Message « Success ».
3. **Authentication → Providers → Email** : laisse « Enable Email provider » activé. « Confirm email » = ton choix
   (activé : le joueur doit cliquer sur le lien reçu ; désactivé : connexion immédiate).
4. **Authentication → URL Configuration** : *Site URL* = l'adresse de ton site (ex. `https://camping.netlify.app`) ;
   *Redirect URLs* : ajoute `https://TON-SITE/login.html` et `https://TON-SITE/reset.html`
   (et `http://localhost:3000/**` pour tester en local).
5. **Table Editor** : tu peux y ajouter des lignes dans `news` et `releases`.

## Étape 2 — Tester le site en local
```
npm install
npm run site          → http://localhost:3000
```
Pour un autre domaine : copie `.env.example` en `.env`, modifie `SITE_URL` / `GITHUB_REPO`, puis `npm run config`.
Hébergement : dépose le dossier `website/` tel quel (Netlify, Vercel, GitHub Pages…).

## Étape 3 — Tester le jeu
- Navigateur : `npx serve game -l 3001` puis ouvre http://localhost:3001 (ajoute cette adresse dans les Redirect URLs si besoin).
- Application : `npm start`.

## Étape 4 — Créer l'installateur Windows et publier
1. Crée un dépôt GitHub (public), puis remplace `nld288711-maker/CAMPING` dans `package.json` (section `build.publish`) et `.env`.
2. Crée un jeton GitHub (Settings → Developer settings → Fine-grained token, droit « Contents: write » sur ce dépôt)
   et exporte-le dans ta console seulement : `set GH_TOKEN=...` (ne jamais le mettre dans le projet).
3. `npm run dist` → installateur local dans `dist/`.  `npm run release` → publie sur GitHub Releases.
4. Ajoute une ligne dans la table `releases` (version, notes) pour le site.

## Publier une nouvelle version sans perdre les sauvegardes
1. Modifie le jeu. 2. Augmente `version` dans `package.json` (ex. 1.0.1). 3. `npm run release`.
4. Les joueurs reçoivent une bannière « Mise à jour prête → Redémarrer ». Leur partie est dans Supabase : rien n'est perdu.
5. Si tu changes la structure des données : monte `SAVE_VERSION` dans `game/cloud.js` et ajoute `MIGRATIONS[2] = function(d){ ...; return d; }`.

## Sécurité
- Seule la clé publiable est utilisée. Les règles RLS limitent chaque joueur à ses propres lignes ; la base refuse
  elle-même une sauvegarde vide. Mots de passe gérés par Supabase Auth (jamais stockés par le projet).
- Electron : `contextIsolation`, `sandbox`, pas de `nodeIntegration`, navigation externe bloquée.
- Session et copie locale : dossier utilisateur Electron (userData), séparé des fichiers du jeu.

## État des tests — à lire
**Réellement testé (dans mon environnement, Supabase simulé) :** `node tests/cloud.test.js` — première sauvegarde, refus des
états vides/corrompus, mises à jour avec révision, récupération au démarrage, détection de conflit entre deux appareils,
mode hors ligne + copie locale + synchro au retour d'Internet. Syntaxe JavaScript de tous les fichiers vérifiée.

**NON testé (pas de réseau ni de Windows chez moi) — à faire de ton côté :**
inscription/connexion réelles sur ton Supabase, e-mails de confirmation et de réinitialisation, exécution du SQL,
rendu visuel du site, lancement d'Electron, création de l'installateur, mise à jour automatique réelle,
connexion depuis un 2ᵉ ordinateur, et le jeu 3D lui-même avec l'écran de connexion.
Checklist : 1) SQL OK  2) inscription sur le site  3) connexion dans le jeu avec le même compte  4) construire, attendre
« ☁️ Synchronisé »  5) fermer/rouvrir  6) se connecter sur un autre PC  7) publier 1.0.1 et vérifier la mise à jour + la partie.

---
## Site v2 (Campground Builder) — ce qui a changé
- Nouveau design (bois / forêt), animations (apparition au scroll, lucioles, parallaxe, cartes inclinables).
- **Ambiance sonore** (vent, feu de camp, oiseaux + bruitages de boutons) générée par le navigateur : bouton 🔊/🔇 dans l'en-tête, désactivée par défaut.
- L'image du jeu est utilisée comme visuel d'accueil, comme icône du jeu/de l'application (`build/icon.png`), dans la page Télécharger et sur l'écran de connexion du jeu.
- Bandeau « Nouvelle version disponible » sur le site pour les joueurs connectés dont la version installée est plus ancienne.

## Publier une nouvelle version (les données des joueurs ne bougent pas)
Rien à transférer : les parties sont dans Supabase, pas dans les fichiers du jeu.
1. Modifie le jeu (`game/index.html`).
2. Monte la version : `npm version patch --no-git-tag-version` (1.0.0 → 1.0.1) — ou modifie `version` dans `package.json`.
3. `set GH_TOKEN=ton_jeton` puis `npm run release` → publie l'installateur sur GitHub Releases.
4. Supabase → SQL Editor, déclare la version pour le site (change le texte) :
   `insert into public.releases (version, notes) values ('1.0.1', 'Ce qui change…');`
5. Les joueurs : bannière dans le jeu (« Redémarrer ») + bandeau sur le site.
6. Seulement si tu changes la STRUCTURE des données : monte `SAVE_VERSION` dans `game/cloud.js` et ajoute `MIGRATIONS[2]`.

---
## PUBLIER LE SITE (pour que les joueurs téléchargent le jeu)
Le site est un simple dossier de fichiers : `website/`. Ouvrir une page en double-cliquant donne un site sans comptes
(Supabase exige une adresse web `http://…`), donc il faut le publier ou le lancer avec `npm run site`.

### Méthode la plus simple : Netlify Drop (gratuit, 2 minutes, sans ligne de commande)
1. Va sur https://app.netlify.com/drop et crée un compte gratuit.
2. Fais glisser **le dossier `website`** (le dossier entier) dans la zone « Drag and drop ».
3. Netlify te donne une adresse (ex. `https://nom-aleatoire.netlify.app`). Tu peux la renommer dans *Site configuration → Change site name*.
4. **Indique cette adresse au projet** : ouvre `.env.example`, copie-le en `.env`, mets `SITE_URL=https://ton-adresse.netlify.app`,
   lance `npm run config` puis `npm run css`, puis re-dépose le dossier `website` (Netlify → *Deploys* → glisser à nouveau).
5. **Supabase → Authentication → URL Configuration** : *Site URL* = ton adresse ; *Redirect URLs* : `https://ton-adresse/login.html` et `https://ton-adresse/reset.html`.
6. Teste : inscription → e-mail de confirmation → connexion.

### Le bouton « Télécharger »
Il pointe vers GitHub Releases (`GITHUB_REPO` dans `.env`). Crée un dépôt GitHub public, puis `npm run release` y envoie l'installateur.
(Supabase Storage n'est pas utilisable : le plan gratuit limite les fichiers à 50 Mo, un installateur Electron en fait plus.)

### Autres hébergeurs
GitHub Pages, Vercel, Cloudflare Pages : publier le dossier `website/` tel quel, sans étape de build.

### Modifier le design
Édite `website/css/style.css`, puis `npm run css` : le style est recopié dans chaque page (chaque page est autonome).
