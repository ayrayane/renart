// @ts-check
// A small Markdown subset for the agent's answers. Its text can quote MR and issue content written by anyone,
// so this never produces HTML: it returns tokens, and the panel builds DOM nodes with textContent.

/** @typedef {{ type: 'text' | 'code', text: string } | { type: 'strong', children: Inline[] } | { type: 'link', text: string, href: string }} Inline */
/** @typedef {{ type: 'p' | 'h', inline: Inline[] } | { type: 'ul', items: Inline[][] }} Block */

/**
 * **bold**, `code` and [text](http(s)://…) links; anything else stays plain text.
 * @param {string} line
 * @returns {Inline[]}
 */
export function inline(line) {
  /** @type {Inline[]} */
  const out = []
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
  let last = 0
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push({ type: 'text', text: line.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ type: 'strong', children: inline(m[1]) })
    else if (m[2] !== undefined) out.push({ type: 'code', text: m[2] })
    else out.push({ type: 'link', text: m[3], href: m[4] })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ type: 'text', text: line.slice(last) })
  return out
}

/**
 * Paragraphs, `#` headings, `-`/`*`/`1.` lists; `>` quote markers are dropped.
 * @param {string} text
 * @returns {Block[]}
 */
export function blocks(text) {
  /** @type {Block[]} */
  const out = []
  /** @type {string[]} */
  let para = []
  const flush = () => { if (para.length) out.push({ type: 'p', inline: inline(para.join(' ')) }); para = [] }
  for (const raw of text.split('\n')) {
    // Quotes are shown as plain text: the marker is dropped, the words stay.
    const line = raw.trim().replace(/^>\s?/, '')
    const item = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/)
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (!line) flush()
    else if (heading) { flush(); out.push({ type: 'h', inline: inline(heading[1]) }) }
    else if (item) {
      flush()
      const prev = out[out.length - 1]
      if (prev?.type === 'ul') prev.items.push(inline(item[1]))
      else out.push({ type: 'ul', items: [inline(item[1])] })
    } else para.push(line)
  }
  flush()
  return out
}
