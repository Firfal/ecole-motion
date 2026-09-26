/**
 * Appels à l'API MailerLite (https://developers.mailerlite.com), sans dépendance Firebase
 * pour pouvoir être testés isolément.
 */
// MAILERLITE_API_URL : uniquement pour les tests avec l'émulateur (faux serveur MailerLite)
const API = process.env.MAILERLITE_API_URL || 'https://connect.mailerlite.com/api'

export class MailerLiteError extends Error {
  constructor(message, { status, retryable }) {
    super(message)
    this.status = status
    this.retryable = retryable
  }
}

async function call(apiKey, method, path, body, fetchImpl) {
  let res
  try {
    res = await fetchImpl(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    throw new MailerLiteError(`réseau : ${e.message}`, { status: 0, retryable: true })
  }
  const text = await res.text()
  if (!res.ok) {
    // 429 et 5xx : temporaire, on laisse Cloud Functions réessayer. 4xx : données invalides.
    const retryable = res.status === 429 || res.status >= 500
    throw new MailerLiteError(`HTTP ${res.status} : ${text.slice(0, 300)}`, { status: res.status, retryable })
  }
  return text ? JSON.parse(text) : null
}

const groupCache = new Map()

/** ID du groupe à partir de son nom exact (mis en cache pour la durée de vie de l'instance). */
export async function groupIdByName(apiKey, name, fetchImpl = fetch) {
  if (groupCache.has(name)) return groupCache.get(name)
  const res = await call(apiKey, 'GET', `/groups?limit=100&filter[name]=${encodeURIComponent(name)}`, null, fetchImpl)
  const group = (res?.data || []).find((g) => g.name === name)
  if (!group) throw new MailerLiteError(`groupe « ${name} » introuvable`, { status: 404, retryable: false })
  groupCache.set(name, group.id)
  return group.id
}

/** Équivalent de « Create or Update Subscriber » de Zapier. */
export async function upsertSubscriber(apiKey, { email, name, groupId, resubscribe }, fetchImpl = fetch) {
  const body = { email, groups: [groupId] }
  if (name) body.fields = { name }
  if (resubscribe) body.status = 'active'
  const res = await call(apiKey, 'POST', '/subscribers', body, fetchImpl)
  return res?.data?.id
}

export function _resetCache() {
  groupCache.clear()
}
