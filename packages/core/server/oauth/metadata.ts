import { MCP_SCOPES } from '../../shared/utils/mcp'
import type { OAuthOptions } from './common'

const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic']

/** Metadaten der geschützten Ressource (RFC 9728): sagt Programmen, wer Tokens für `/mcp` ausstellt */
export function protectedResourceMetadata(o: OAuthOptions, resourceName: string) {
  return {
    resource: o.resource,
    authorization_servers: [o.issuer],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: resourceName,
  }
}

/** Metadaten des Autorisierungsservers (RFC 8414) samt `iss`-Rücksprung-Parameter (RFC 9207) */
export function authorizationServerMetadata(o: OAuthOptions) {
  return {
    issuer: o.issuer,
    authorization_endpoint: `${o.issuer}/oauth/authorize`,
    token_endpoint: `${o.issuer}/oauth/token`,
    registration_endpoint: `${o.issuer}/oauth/register`,
    revocation_endpoint: `${o.issuer}/oauth/revoke`,
    scopes_supported: MCP_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    authorization_response_iss_parameter_supported: true,
  }
}
