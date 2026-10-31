// One icon per route, handed to Magpie as the auth hook's `icon` (a data:image
// URI, magpie's own field). Each is a solid rounded square with a white glyph,
// so it reads on both light and dark themes at the small sizes Magpie uses.
const svg = (bg, glyph) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/>${glyph}</svg>`

const uri = (s) => `data:image/svg+xml;utf8,${encodeURIComponent(s)}`

export const ICONS = {
  // terracotta, a bold "A"
  anthropic: uri(
    svg(
      "#D97757",
      `<path d="M32 12 L48 52 H39.5 L36.3 43.5 H27.7 L24.5 52 H16 Z M32 25.5 L29.8 36.5 H34.2 Z" fill="#fff" fill-rule="evenodd"/>`,
    ),
  ),
  // green, six-petal knot
  openai: uri(
    svg(
      "#10A37F",
      `<g fill="none" stroke="#fff" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"><path d="M32 12 L49.3 22 V42 L32 52 L14.7 42 V22 Z"/><path d="M32 12 V32 L49.3 42 M14.7 42 L32 32 L49.3 22"/></g>`,
    ),
  ),
  // blue, linked nodes forming a vertex
  vertex: uri(
    svg(
      "#4285F4",
      `<g stroke="#fff" stroke-width="4" stroke-linecap="round"><path d="M32 14 L16 46 M32 14 L48 46 M16 46 H48 M32 14 V34 M32 34 L16 46 M32 34 L48 46" fill="none"/></g><g fill="#fff"><circle cx="32" cy="14" r="6"/><circle cx="16" cy="46" r="6"/><circle cx="48" cy="46" r="6"/><circle cx="32" cy="34" r="4.5"/></g>`,
    ),
  ),
}
