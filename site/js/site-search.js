/*
 * Recherche du site sans Webflow : filtre /search-index.json (généré par
 * scripts/mirror.mjs) et affiche les résultats avec le balisage de la page
 * de recherche Webflow d'origine (/search?query=…).
 */
(function () {
  'use strict'
  var query = (new URLSearchParams(location.search).get('query') || '').trim()
  var input = document.querySelector('input[name=query]')
  if (input) input.value = query
  var box = document.querySelector('.w-container > div:last-child')
  if (!box || !query) return

  function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  }
  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  fetch('/search-index.json')
    .then(function (r) { return r.json() })
    .then(function (pages) {
      var terms = norm(query).split(/\s+/).filter(Boolean)
      var results = pages
        .map(function (p) {
          var hay = norm(p.title + ' ' + p.description + ' ' + p.text)
          var score = 0
          for (var i = 0; i < terms.length; i++) {
            if (hay.indexOf(terms[i]) === -1) return null
            score += norm(p.title).indexOf(terms[i]) !== -1 ? 10 : 1
          }
          return { page: p, score: score }
        })
        .filter(Boolean)
        .sort(function (a, b) { return b.score - a.score })

      if (!results.length) {
        box.innerHTML = '<div><div>No matching results.</div></div>'
        return
      }
      box.innerHTML = results
        .map(function (r) {
          var p = r.page
          var text = p.description
          if (!text) {
            var idx = norm(p.text).indexOf(terms[0])
            text = p.text.slice(Math.max(0, idx - 80), idx + 160)
          }
          return (
            '<div style="margin-bottom:20px"><h3><a href="' + esc(p.path) + '">' + esc(p.title) + '</a></h3>' +
            '<div>' + esc(p.path) + '</div><p>' + esc(text) + '</p></div>'
          )
        })
        .join('')
    })
})()
