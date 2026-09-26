/**
 * Routage formulaire du site → groupe MailerLite (remplace les zaps Webflow → MailerLite).
 * La clé est le nom du formulaire (attribut data-name dans Webflow), tel qu'enregistré
 * dans Firestore par static/js/forms-firebase.js.
 */
export const FORMS = {
  // Zap « Téléchargement fichier source » : Create or Update Subscriber, Resubscribe = True
  'Formulaire Fichier Source': {
    group: '01_Fichier Source',
    emailField: 'email',
    nameField: 'name',
    resubscribe: true,
  },
}
