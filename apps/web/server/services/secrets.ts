import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const PREFIX = 'enc:v1:'
const IV_BYTES = 12
const TAG_BYTES = 16

/** Zweck des Schlüssels; dieselbe Ableitung wie `deriveSecret('pds:settings')` von Nuxt */
export const SETTINGS_KEY_PURPOSE = 'pds:settings'

/**
 * Schlüssel wie Nuxts `deriveSecret`: HKDF-SHA256 über das App-Geheimnis, Salz "nuxt", Info = Zweck. Nuxt liefert die
 * 32 Byte als Hex-Text; als AES-Schlüssel dienen die Bytes. Für Skripte und Tests ohne Nuxt-Laufzeit.
 */
export function deriveSettingsKey(appSecret: string, purpose = SETTINGS_KEY_PURPOSE): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'nuxt', purpose, 32))
}

/** Hex-Text von `deriveSecret` → Schlüssel */
export function keyFromHex(hex: string): Buffer {
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) throw new Error('Schlüssel für die Einstellungen muss 32 Byte haben')
  return key
}

export const isEncrypted = (value: string) => value.startsWith(PREFIX)

/** AES-256-GCM; Format `enc:v1:<base64(iv | tag | ciphertext)>` */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

/** Klartext oder undefined, wenn der Wert mit diesem Schlüssel nicht lesbar ist (App-Geheimnis neu erzeugt, beschädigt) */
export function decryptSecret(key: Buffer, value: string): string | undefined {
  if (!isEncrypted(value)) return undefined
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
    if (raw.length < IV_BYTES + TAG_BYTES) return undefined
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  }
  catch {
    return undefined
  }
}
