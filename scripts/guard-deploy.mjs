#!/usr/bin/env node
/**
 * guard-deploy.mjs — lancé par Firebase avant chaque déploiement du site (firebase.json →
 * hosting.predeploy). Le site ne se publie que depuis GitHub Actions (PR → preview,
 * main → production), jamais depuis un ordinateur : pas de version locale non relue,
 * non commitée ou en retard sur main mise en ligne par erreur.
 *
 * Urgence uniquement (GitHub en panne…) : ECOLE_MOTION_DEPLOY_MANUEL=1 npx firebase-tools deploy --only hosting
 */
const fromGitHub = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'Firfal/ecole-motion'

if (fromGitHub) {
  console.log(`guard-deploy : déploiement autorisé (GitHub Actions, ${process.env.GITHUB_EVENT_NAME} sur ${process.env.GITHUB_REF})`)
} else if (process.env.ECOLE_MOTION_DEPLOY_MANUEL === '1') {
  console.warn('guard-deploy : déploiement MANUEL forcé (ECOLE_MOTION_DEPLOY_MANUEL=1). Pensez à repasser par une PR ensuite.')
} else {
  console.error(`
  ✋ Déploiement du site refusé : il ne se fait que depuis GitHub.

     - pour publier : ouvrir une pull request, vérifier la preview, puis la merger sur main
       (le déploiement en production est automatique) ;
     - les règles Firestore et les fonctions restent déployables à la main :
       npx firebase-tools deploy --only firestore   /   --only functions
     - urgence uniquement : ECOLE_MOTION_DEPLOY_MANUEL=1 npx firebase-tools deploy --only hosting
`)
  process.exit(1)
}
