declare module '#app' {
  interface PageMeta {
    /** Seite nur für Admins (Einstellungen, Protokolle) */
    admin?: boolean
  }
}

export {}
