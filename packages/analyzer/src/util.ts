/** Hängt einen Wert an die Liste des Schlüssels an (Liste wird bei Bedarf angelegt, Einfügereihenfolge bleibt) */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Vergleich nach UTF-16-Codeeinheiten wie StringComparer.Ordinal */
export function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
