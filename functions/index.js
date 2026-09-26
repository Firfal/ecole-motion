/**
 * Soumission d'un formulaire du site (Firestore form_submissions) → abonné MailerLite.
 * Remplace le zap Webflow « New Form Submission » → MailerLite « Create or Update Subscriber ».
 *
 * Le résultat est écrit sur la soumission (champ `mailerlite`) pour suivre les envois.
 * Déploiement : voir README (secret MAILERLITE_API_KEY).
 */
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { defineSecret } from 'firebase-functions/params'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { FORMS } from './forms.config.js'
import { groupIdByName, upsertSubscriber } from './mailerlite.js'

initializeApp()
const MAILERLITE_API_KEY = defineSecret('MAILERLITE_API_KEY')
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const formToMailerLite = onDocumentCreated(
  {
    document: 'form_submissions/{id}',
    database: '(default)',
    region: 'europe-west1', // base Firestore en eur3
    secrets: [MAILERLITE_API_KEY],
    retry: true, // erreurs temporaires (réseau, 429, 5xx) réessayées automatiquement
    maxInstances: 5,
  },
  async (event) => {
    const snap = event.data
    if (!snap) return
    const data = snap.data()
    const config = FORMS[data.form]
    if (!config) return // formulaire sans routage MailerLite

    const ref = getFirestore().doc(snap.ref.path)
    const fresh = (await ref.get()).get('mailerlite')
    if (fresh?.status === 'ok') return // déjà traité (nouvelle tentative)

    const fields = data.fields || {}
    const email = String(fields[config.emailField] || '').trim().toLowerCase()
    const name = String(fields[config.nameField] || '').trim()
    if (!EMAIL_RE.test(email)) {
      await ref.update({ mailerlite: { status: 'ignored', reason: 'e-mail invalide', at: FieldValue.serverTimestamp() } })
      return
    }

    try {
      const apiKey = MAILERLITE_API_KEY.value()
      const groupId = await groupIdByName(apiKey, config.group)
      const subscriberId = await upsertSubscriber(apiKey, { email, name, groupId, resubscribe: config.resubscribe })
      await ref.update({ mailerlite: { status: 'ok', group: config.group, subscriberId: subscriberId || null, at: FieldValue.serverTimestamp() } })
      logger.info('MailerLite : abonné ajouté', { form: data.form, group: config.group })
    } catch (e) {
      logger.error('MailerLite : échec', { form: data.form, error: e.message, status: e.status })
      await ref.update({ mailerlite: { status: 'error', error: String(e.message).slice(0, 500), at: FieldValue.serverTimestamp() } })
      if (e.retryable) throw e
    }
  },
)
