// The single "Central" provider icon, handed to Magpie as the auth hook's `icon`
// (a data:image URI, magpie's own field): a solid rounded square with a white
// "C" ring, so it reads on light and dark themes at small sizes.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1B1B1F"/><path d="M45 20.5 A18 18 0 1 0 45 43.5" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/><circle cx="46" cy="32" r="4" fill="#FE315D"/></svg>`

export const ICON = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
