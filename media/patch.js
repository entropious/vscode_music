// @ts-check
/**
 * Brings a DOM tree in line with a new one by changing only what differs, for the player panel
 * (media/player.js). What stays the same
 * keeps its nodes and their state: a click between press and release, focus and typing, an image
 * on show. Elements are matched in order by tag, or by id where they have one.
 */

/**
 * @typedef {object} PatchOptions
 * @property {boolean} [keepStyles] Leave inline styles alone: where the markup has none and a
 *   script sets them after each update, as in the panel, whose CSP allows no styles in markup.
 */

/** @param {Node} a @param {Node} b */
const sameNode = (a, b) => a.nodeType === b.nodeType && (!(a instanceof Element) || !(b instanceof Element) || (a.tagName === b.tagName && a.id === b.id));

/**
 * Makes the children of `target` match `html`.
 * @param {Node} target
 * @param {string} html
 * @param {PatchOptions} [options]
 */
export function patch(target, html, options = {}) {
  const t = document.createElement('template');
  t.innerHTML = html;
  patchChildren(target, t.content, options);
}

/**
 * Makes the children of `target` match those of `next`, taking new nodes from `next` as they are.
 * @param {Node} target
 * @param {Node} next
 * @param {PatchOptions} [options]
 */
export function patchChildren(target, next, options = {}) {
  /** @type {Map<string, Element>} */
  const byId = new Map();
  for (const n of Array.from(target.childNodes)) {
    if (n instanceof Element && n.id) {
      byId.set(n.id, n);
    }
  }
  let at = target.firstChild;
  for (const n of Array.from(next.childNodes)) {
    const keyed = n instanceof Element && n.id ? byId.get(n.id) : undefined;
    const match = keyed || (at && sameNode(at, n) ? at : undefined);
    if (!match) {
      target.insertBefore(n, at);
      continue;
    }
    if (match === at) {
      at = at.nextSibling;
    } else {
      target.insertBefore(match, at);
    }
    patchNode(match, n, options);
  }
  while (at) {
    const rest = at.nextSibling;
    target.removeChild(at);
    at = rest;
  }
}

/** @param {Node} old @param {Node} next @param {PatchOptions} options */
function patchNode(old, next, options) {
  if (!(old instanceof Element) || !(next instanceof Element)) {
    if (old.nodeValue !== next.nodeValue) {
      old.nodeValue = next.nodeValue;
    }
    return;
  }
  const kept = (/** @type {string} */ name) => options.keepStyles && name === 'style';
  for (const { name, value } of Array.from(next.attributes)) {
    if (!kept(name) && old.getAttribute(name) !== value) {
      old.setAttribute(name, value);
    }
  }
  for (const { name } of Array.from(old.attributes)) {
    if (!kept(name) && !next.hasAttribute(name)) {
      old.removeAttribute(name);
    }
  }
  // A field being typed in or a slider being dragged keeps what the user is doing.
  if (old instanceof HTMLInputElement && old !== document.activeElement) {
    const value = next.getAttribute('value');
    if (value !== null && old.value !== value) {
      old.value = value;
    }
  }
  patchChildren(old, next, options);
}
