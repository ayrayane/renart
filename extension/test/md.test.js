import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inline, blocks } from '../md.js'

test('inline: bold, code, http(s) links only', () => {
  assert.deepEqual(inline('a **b** `c` [d](https://x.y/z) e'), [
    { type: 'text', text: 'a ' }, { type: 'strong', children: [{ type: 'text', text: 'b' }] }, { type: 'text', text: ' ' }, { type: 'code', text: 'c' },
    { type: 'text', text: ' ' }, { type: 'link', text: 'd', href: 'https://x.y/z' }, { type: 'text', text: ' e' }])
  // javascript: and other schemes stay plain text, so they never become a clickable link.
  assert.deepEqual(inline('[x](javascript:alert(1))'), [{ type: 'text', text: '[x](javascript:alert(1))' }])
  assert.deepEqual(inline('<img src=x onerror=alert(1)>'), [{ type: 'text', text: '<img src=x onerror=alert(1)>' }])
})

test('blocks: paragraphs, headings, lists', () => {
  assert.deepEqual(blocks('## Titre\nune ligne\nsuite\n\n- un\n- **deux**\n1. trois').map((b) => b.type), ['h', 'p', 'ul'])
  const list = blocks('- un\n- deux\n1. trois')[0]
  assert.equal(list.type === 'ul' && list.items.length, 3)
})

test('blocks: quote markers are dropped', () => {
  assert.deepEqual(blocks('> **Résumé** : texte'), [{ type: 'p', inline: [{ type: 'strong', children: [{ type: 'text', text: 'Résumé' }] }, { type: 'text', text: ' : texte' }] }])
})

test('inline: code inside bold', () => {
  assert.deepEqual(inline('**`False` :** x'), [{ type: 'strong', children: [{ type: 'code', text: 'False' }, { type: 'text', text: ' :' }] }, { type: 'text', text: ' x' }])
})
