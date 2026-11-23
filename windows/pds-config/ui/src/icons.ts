import { _api, addCollection } from '@iconify/vue'
import type { IconifyIcon, IconifyJSON } from '@iconify/vue'
import { convertParsedSVG, parseSVGContent } from '@iconify/utils/lib/svg/parse'

// Siemens-Icons des UI-Layers als lokale Iconify-Sammlung `siemens`: im Bundle, kein Nachladen.
// Gleiche Umwandlung wie die Custom Collection von @nuxt/icon in der App, damit die Icons gleich aussehen.
const files = import.meta.glob<string>('../../../../packages/ui/app/assets/siemens/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/**
 * Nur die Form zählt, gezeichnet in der Textfarbe – wie der CSS-Modus (Maske) von @nuxt/icon in der App.
 * Einige SVGs haben feste Füllfarben (z. B. #0E0F26) und wären im dunklen Schema sonst unsichtbar.
 * Als Inline-SVG statt CSS-Maske, damit Größenklassen (size-4 …) greifen; `mask-type` als Attribut,
 * nicht als style, damit eine strenge CSP es nicht verwirft.
 */
function monochrome(icon: IconifyIcon): IconifyIcon {
  const { left = 0, top = 0, width = 16, height = 16 } = icon
  return {
    ...icon,
    body: `<mask id="shape" mask-type="alpha">${icon.body}</mask>`
      + `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="currentColor" mask="url(#shape)"/>`,
  }
}

export function siemensCollection(): IconifyJSON {
  const icons: IconifyJSON['icons'] = {}
  for (const [path, content] of Object.entries(files)) {
    const name = path.slice(path.lastIndexOf('/') + 1, -'.svg'.length)
    const start = content.indexOf('<svg')
    const parsed = parseSVGContent(start > 0 ? content.slice(start) : content)
    const data = parsed && convertParsedSVG(parsed)
    if (!data) continue
    if (data.left === 0) delete data.left
    if (data.top === 0) delete data.top
    icons[name] = monochrome(data)
  }
  return { prefix: 'siemens', icons }
}

export function registerSiemensIcons(): void {
  // Ein unbekannter Name (Tippfehler, fremde Sammlung) bleibt leer, statt die Iconify-API anzufragen
  _api.setFetch(() => Promise.reject(new Error('Iconify-API ist abgeschaltet')))
  addCollection(siemensCollection())
}
