import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { _resetCache, groupIdByName, MailerLiteError, upsertSubscriber } from '../mailerlite.js'

function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) })
    const r = routes(url, init)
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body ?? {}) }
  }
  impl.calls = calls
  return impl
}

beforeEach(() => _resetCache())

test('trouve le groupe par nom exact et le met en cache', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { data: [{ id: '9', name: '01_Fichier Source 2' }, { id: '42', name: '01_Fichier Source' }] } }))
  assert.equal(await groupIdByName('k', '01_Fichier Source', f), '42')
  assert.equal(await groupIdByName('k', '01_Fichier Source', f), '42')
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0].url, /groups\?limit=100&filter\[name\]=01_Fichier%20Source$/)
  assert.equal(f.calls[0].headers.Authorization, 'Bearer k')
})

test('groupe introuvable → erreur non réessayable', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { data: [] } }))
  await assert.rejects(groupIdByName('k', 'x', f), (e) => e instanceof MailerLiteError && !e.retryable)
})

test('upsert : e-mail, nom, groupe et réabonnement comme le zap', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { data: { id: 's1' } } }))
  const id = await upsertSubscriber('k', { email: 'a@b.fr', name: 'Ana', groupId: '42', resubscribe: true }, f)
  assert.equal(id, 's1')
  assert.equal(f.calls[0].method, 'POST')
  assert.match(f.calls[0].url, /\/api\/subscribers$/)
  assert.deepEqual(f.calls[0].body, { email: 'a@b.fr', groups: ['42'], fields: { name: 'Ana' }, status: 'active' })
})

test('429/5xx réessayables, 422 non', async () => {
  for (const [status, retryable] of [[429, true], [503, true], [422, false]]) {
    const f = fakeFetch(() => ({ status, body: { message: 'x' } }))
    await assert.rejects(upsertSubscriber('k', { email: 'a@b.fr', groupId: '1' }, f), (e) => e.retryable === retryable && e.status === status)
  }
})
