# ecolemotion.com — migration Webflow → Firebase

Copie à l'identique du site publié sur Webflow, hébergée sur **Firebase Hosting**
(projet `ecole-motion`) et importable telle quelle dans **[Instatic](https://github.com/corebunch/instatic)**
pour une édition visuelle.

```
site/                  ← le site statique servi par Firebase (généré par `npm run mirror`)
static/                ← fichiers propres au projet, copiés dans site/ à chaque aspiration
  js/forms-firebase.js ← remplace Webflow Forms (envois → Firestore)
scripts/
  mirror.mjs           ← aspire ecolemotion.com + toutes ses ressources Webflow
  check.mjs            ← vérifie : aucun lien cassé, aucune ressource Webflow restante
  package-instatic.mjs ← produit dist/instatic-import.zip pour le Super Import d'Instatic
firebase.json          ← hébergement (URLs propres, cache, redirections) + Firestore
firestore.rules        ← formulaires : création publique, lecture interdite
```

## Commandes

```sh
npm ci
npm run mirror     # (ré)aspire le site en ligne dans site/
npm run check      # contrôle d'intégrité (aussi lancé par la CI)
npm run serve      # prévisualisation locale sur http://localhost:5000
npm run instatic   # dist/instatic-import.zip
npm run deploy     # déploiement manuel (nécessite `firebase login`)
```

## Ce que fait l'aspiration

- Parcourt `sitemap.xml` et tous les liens internes, récupère aussi la page 404.
- Rapatrie tout ce qui est hébergé chez Webflow (CSS, `webflow.js` avec les
  interactions, jQuery, images et `srcset`, polices, vidéos d'arrière-plan,
  Lottie, PDF…) dans `css/ js/ images/ fonts/ videos/ documents/`, et réécrit
  toutes les URLs (HTML, CSS, JSON des lightbox, styles inline).
- Conserve le HTML, les classes et attributs `data-wf-*` : les interactions,
  animations, menus et sliders fonctionnent exactement comme sur Webflow.
- Garde les URLs propres (`/formations`) : Firebase les sert grâce à `cleanUrls`.
- Les formulaires Webflow sont branchés sur Firestore (`form_submissions`), avec
  les mêmes messages de succès et d'erreur.
- `site/_mirror-report.json` liste les pages, ressources, formulaires, scripts
  tiers et erreurs éventuelles.

## État de la copie

Vérifiée par comparaison pixel à pixel avec le site en ligne (après défilement complet,
pour déclencher les animations) sur 3 largeurs : 1440 px, 800 px et 390 px.
Les 11 pages sont identiques (0,00 % d'écart, mêmes hauteurs), le menu mobile aussi.

Différences volontaires avec Webflow :
- **404** : Webflow servait sa page d'erreur générique en anglais ; elle est remplacée
  par une 404 aux couleurs du site.
- **/search** : la recherche Webflow (côté serveur) est remplacée par une recherche
  locale sur `search-index.json`.
- **Google Analytics** : le tag « first-party » servi par Webflow est remplacé par le
  chargement standard de `gtag.js` (même identifiant G-L758FQVZNZ).
- **Formulaires** : enregistrés dans Firestore (`form_submissions`) au lieu de Webflow.
  Pour recevoir un e-mail à chaque envoi : extension Firebase *Trigger Email*.

## Déploiement automatique (GitHub Actions)

`.github/workflows/deploy.yml` :
- **pull request** → URL de prévisualisation Firebase (valable 7 jours) postée sur la PR ;
- **push sur `main`** → mise en production (Hosting + règles Firestore).

À configurer une fois :
1. Console Google Cloud du projet `ecole-motion` → *IAM → Comptes de service* →
   créer un compte avec les rôles **Firebase Hosting Admin**, **Firebase Rules Admin**,
   **Cloud Datastore Index Admin** et **Service Account User**, puis générer une clé JSON.
   (Ou lancer `npx firebase-tools init hosting:github`, qui crée le compte et le secret tout seul.)
2. GitHub → *Settings → Secrets and variables → Actions* → secret
   `FIREBASE_SERVICE_ACCOUNT` = contenu du JSON.
3. Console Firebase → activer **Firestore** (mode production) pour les formulaires.

## Bascule du domaine (couper Webflow)

1. Déployer, vérifier le site sur `https://ecole-motion.web.app`.
2. Console Firebase → *Hosting → Ajouter un domaine personnalisé* :
   `www.ecolemotion.com` et `ecolemotion.com` (redirection vers www).
3. Remplacer chez le registrar les enregistrements DNS Webflow
   (`proxy-ssl.webflow.com` / `75.2.70.75`, `99.83.190.102`) par ceux indiqués par Firebase.
4. Reporter les **redirections 301** définies dans Webflow (*Site settings → Publishing →
   301 redirects*) dans `firebase.json` → `hosting.redirects`.
5. Une fois le certificat SSL actif, résilier l'abonnement Webflow.

## Édition avec Instatic

Instatic est un CMS auto-hébergé (serveur Bun + SQLite/Postgres) : il ne tourne pas
sur Firebase Hosting (statique) mais sur Docker, Railway, Render ou un VPS.
Workflow proposé :

1. Lancer Instatic (`docker compose … up`, voir leur README) — en local ou sur un petit serveur.
2. `npm run instatic` puis, dans Instatic, **Super Import** → déposer `dist/instatic-import.zip`
   (pages, styles éditables, médias, polices et scripts sont importés, les liens entre pages sont reliés).
   À l'étape *Conflicts*, choisir **Overwrite** pour la page `index` (sinon elle arrive en `index-2`
   à côté de la page d'accueil vide créée par Instatic).
   Vérifié avec le pipeline d'import d'Instatic 0.0.20 : 12 pages, 919 règles CSS, 356 médias,
   5 polices, 6 couleurs, 50 scripts, aucun avertissement bloquant.
3. Éditer visuellement dans Instatic, publier, puis déployer le HTML publié sur Firebase
   (ou héberger directement le site sur l'instance Instatic).
