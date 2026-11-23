import type { AppDatabase } from '../database/types'

/** Datenbank-Client mit allen Tabellen dieser App */
export const useAppDb = () => useDb<AppDatabase>()
