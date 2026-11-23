import type { Config } from '../bindings/Config'

/** Wie `Config::default()` in `pds-common/src/config/model.rs` */
export function defaultConfig(): Config {
  return {
    schema: 1,
    public: { host: '', port: 443, scheme: 'https' },
    listen: { http_port: 80 },
    internal: { port: 3000 },
    tls: { mode: 'certificate', acme_email: '', acme_ca_url: '', acme_ca_root: '', acme_eab_key_id: '', acme_eab_hmac: '' },
    db: { kind: 'sqlite', path: '', server: '', port: 1433, database: 'pds', user: 'pds_app', password: '', encrypt: true, trust_server_certificate: false },
    oidc: {
      tenant_id: '',
      issuer: '',
      client_id: '',
      client_secret: '',
      scopes: 'openid profile email',
      roles_claim: 'roles',
      admin_roles: 'Admin',
      provider_name: 'Microsoft',
    },
    proxy: { url: '', no_proxy: '' },
    mcp: { enabled: false },
    app: { secret: '' },
  }
}
