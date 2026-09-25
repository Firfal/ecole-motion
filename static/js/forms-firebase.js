/*
 * Remplace le traitement des formulaires Webflow (qui s'arrête avec l'abonnement).
 * Chaque envoi d'un formulaire `.w-form form` est enregistré dans Firestore
 * (collection `form_submissions`) puis les messages natifs Webflow
 * (.w-form-done / .w-form-fail) sont affichés exactement comme avant.
 *
 * La configuration Firebase est lue depuis /__/firebase/init.json, fourni
 * automatiquement par Firebase Hosting : aucune clé à maintenir ici.
 */
(function () {
  'use strict'
  var configPromise = null
  function getConfig() {
    if (!configPromise) {
      configPromise = fetch('/__/firebase/init.json').then(function (r) {
        if (!r.ok) throw new Error('init.json ' + r.status)
        return r.json()
      })
    }
    return configPromise
  }

  function toFirestoreValue(v) {
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } }
    return { stringValue: String(v).slice(0, 5000) }
  }

  function collect(form) {
    var fields = {}
    var data = new FormData(form)
    data.forEach(function (value, key) {
      if (typeof value !== 'string') return // pas de fichiers
      if (key === 'cf-turnstile-response' || key === 'g-recaptcha-response') return
      if (key in fields) {
        fields[key] = [].concat(fields[key], value)
      } else {
        fields[key] = value
      }
    })
    return fields
  }

  function send(form) {
    var fields = collect(form)
    var mapFields = {}
    Object.keys(fields).slice(0, 49).forEach(function (k) {
      mapFields[k.slice(0, 200)] = toFirestoreValue(fields[k])
    })
    return getConfig().then(function (cfg) {
      var base = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents'
      var id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10))
      var docName = 'projects/' + cfg.projectId + '/databases/(default)/documents/form_submissions/' + id
      var body = {
        writes: [
          {
            update: {
              name: docName,
              fields: {
                form: { stringValue: (form.getAttribute('data-name') || form.getAttribute('name') || form.id || 'form').slice(0, 199) },
                page: { stringValue: location.pathname.slice(0, 499) },
                userAgent: { stringValue: navigator.userAgent.slice(0, 300) },
                fields: { mapValue: { fields: mapFields } },
              },
            },
            currentDocument: { exists: false },
            updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
          },
        ],
      }
      return fetch(base + ':commit?key=' + encodeURIComponent(cfg.apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) throw new Error('firestore ' + r.status)
      })
    })
  }

  function show(el, visible) {
    if (el) el.style.display = visible ? 'block' : 'none'
  }

  // Écoute en phase de capture sur window : passe avant le gestionnaire jQuery de webflow.js.
  window.addEventListener(
    'submit',
    function (e) {
      var form = e.target
      if (!form || !form.closest) return
      var wrap = form.closest('.w-form')
      if (!wrap) return
      if (form.getAttribute('action') && !/webflow\.com/.test(form.getAttribute('action'))) return // formulaires tiers : on ne touche pas
      e.preventDefault()
      e.stopImmediatePropagation()
      if (form.__sending) return
      form.__sending = true

      var btn = form.querySelector('[type=submit]')
      var original = btn && (btn.value || btn.textContent)
      var wait = btn && btn.getAttribute('data-wait')
      if (btn && wait) {
        if ('value' in btn && btn.tagName === 'INPUT') btn.value = wait
        else btn.textContent = wait
      }
      var done = wrap.querySelector('.w-form-done')
      var fail = wrap.querySelector('.w-form-fail')
      show(fail, false)

      send(form)
        .then(function () {
          form.reset()
          show(form, false)
          show(done, true)
          var redirect = form.getAttribute('data-redirect') || wrap.getAttribute('data-redirect')
          if (redirect) location.href = redirect
        })
        .catch(function (err) {
          console.error(err)
          show(fail, true)
        })
        .then(function () {
          form.__sending = false
          if (btn && wait) {
            if (btn.tagName === 'INPUT') btn.value = original
            else btn.textContent = original
          }
        })
    },
    true,
  )
})()
