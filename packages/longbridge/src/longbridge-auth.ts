/**
 * Longbridge OAuth2 helper with PKCE — authorization URL generation and token exchange.
 *
 * Flow (per https://open.longbridge.com/zh-CN/docs/how-to-access-api):
 *  1. Generate code_verifier + code_challenge (S256)
 *  2. Build authorization URL with code_challenge
 *  3. Open URL in browser, user authorizes
 *  4. Longbridge redirects to redirect_uri with ?code=...
 *  5. Exchange code + code_verifier for tokens
 *  6. Store (accessToken, refreshToken, expiresAt) in accounts.json
 */

import https from 'https'
import { URLSearchParams } from 'url'
import { createHash, randomBytes } from 'crypto'

const LB_AUTH_URL = 'https://openapi.longbridge.com/oauth2/authorize'
const LB_TOKEN_URL = 'https://openapi.longbridge.com/oauth2/token'

// In-memory store for PKCE verifiers (keyed by accountId)
// In production you'd use Redis or a DB
const verifierStore = new Map<string, string>()

/** Generate a random code_verifier and its S256 code_challenge. */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Build the OAuth2 authorization URL with PKCE. */
export function buildAuthorizationUrl(config: {
  clientId: string
  clientSecret?: string
  redirectUri: string
  accountId: string
  state?: string
}): { url: string; verifier: string } {
  const { verifier, challenge } = generatePkce()
  // Store verifier for callback
  verifierStore.set(config.accountId, verifier)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: '3',  // trading scope
    ...(config.state ? { state: config.state } : {}),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return { url: `${LB_AUTH_URL}?${params.toString()}`, verifier }
}

/** Exchange an authorization code + code_verifier for tokens. */
export async function exchangeCode(
  config: {
    clientId: string
    clientSecret?: string
    redirectUri: string
    accountId: string
  },
  code: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const verifier = verifierStore.get(config.accountId)
  if (!verifier) throw new Error('No PKCE verifier found — restart the authorization flow')

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code,
    code_verifier: verifier,
  })

  const result = await postToken(params, !!config.clientSecret)

  if (!result.access_token || !result.refresh_token) {
    const err = result.error_description ?? result.msg ?? `Error: ${result.error ?? 'unknown'}`
    throw new Error(`Token exchange failed: ${err}`)
  }

  // Clean up verifier after use
  verifierStore.delete(config.accountId)

  const expiresAt = new Date(Date.now() + (result.expires_in ?? 2592000) * 1000).toISOString()
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt,
  }
}

/**
 * Refresh access token using OAuth 2.0 refresh_token grant.
 */
export async function refreshAccessToken(config: {
  appKey: string
  appSecret?: string
  refreshToken: string
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.appKey,
    refresh_token: config.refreshToken,
  })

  const result = await postToken(params, !!config.appSecret)

  if (!result.access_token) {
    const msg = result.error_description ?? result.msg ?? `Server error: ${result.error ?? 'unknown'}`
    throw new Error(`Token refresh failed: ${msg}`)
  }

  const expiresAt = new Date(Date.now() + (result.expires_in ?? 2592000) * 1000).toISOString()
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? config.refreshToken,
    expiresAt,
  }
}

async function postToken(params: URLSearchParams, hasSecret: boolean): Promise<{
  access_token?: string
  refresh_token?: string
  expires_in?: number
  msg?: string
  code?: number
  error?: string
  error_description?: string
}> {
  if (hasSecret) {
    params.set('client_secret', '')
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'openapi.longbridge.com',
        path: '/oauth2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params.toString()),
        },
      },
      (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { reject(new Error(`Invalid JSON: ${data}`)) }
        })
      },
    )
    req.on('error', reject)
    req.write(params.toString())
    req.end()
  })
}

export function isTokenExpiringSoon(expiredAt: string, days = 7): boolean {
  return new Date(expiredAt).getTime() - Date.now() < days * 24 * 60 * 60 * 1000
}
