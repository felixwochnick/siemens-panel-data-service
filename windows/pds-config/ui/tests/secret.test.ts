import { describe, expect, it } from 'vitest'
import { fromValue, removed, secretMode, secretValue, typed, unchanged } from '../src/secret'

describe('Secret-Feld', () => {
  it('empty_input_keeps_set_secret', () => {
    expect(secretValue('***', unchanged())).toBe('***')
    expect(secretMode('***', unchanged())).toBe('set')
    // Getippt und wieder geleert: unverändert, auch nach „Entfernen“
    expect(secretValue('***', typed(''))).toBe('***')
    expect(secretValue('', typed(''))).toBe('')
    expect(secretMode('', typed(''))).toBe('empty')
  })

  it('typed_text_is_plaintext', () => {
    expect(secretValue('***', typed('neues Passwort'))).toBe('neues Passwort')
    expect(secretMode('***', typed('neues Passwort'))).toBe('new')
    // Beginnt mit *** und bleibt trotzdem Klartext
    expect(secretValue('***', typed('***abc'))).toBe('***abc')
    expect(secretMode('***', typed('***abc'))).toBe('new')
  })

  it('remove_sets_empty', () => {
    expect(secretValue('***', removed())).toBe('')
    expect(secretMode('***', removed())).toBe('removed')
    // Ohne gespeicherten Wert gibt es nichts zu entfernen
    expect(secretMode('', removed())).toBe('empty')
  })

  it('state_from_outside_value', () => {
    expect(fromValue('***', '***')).toEqual(unchanged())
    expect(fromValue('***', '')).toEqual(removed())
    expect(fromValue('', '')).toEqual(unchanged())
    expect(fromValue('***', 'abc')).toEqual(typed('abc'))
  })
})
