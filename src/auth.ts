import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { asObject, MyQError, retryAfter } from './errors.js';

export const TOKEN_URL = 'https://partner-identity.myq-cloud.com/connect/token';
export const CLIENT_ID = 'IOS_CGI_MYQ';
export const SCOPE = 'MyQ_Residential offline_access';
export const REDIRECT_URI = 'com.myqops://ios';
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function credential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}

export function parseTokens(value: unknown): Tokens {
  const data = asObject(value);
  if (!credential(data.accessToken)
    || (data.refreshToken !== undefined && !credential(data.refreshToken))
    || (data.expiresAt !== undefined && (typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)))) {
    throw new MyQError('Invalid myQ token file. Sign in again.');
  }
  return {
    accessToken: data.accessToken,
    ...(typeof data.refreshToken === 'string' ? { refreshToken: data.refreshToken } : {}),
    ...(typeof data.expiresAt === 'number' ? { expiresAt: data.expiresAt } : {}),
  };
}

export async function saveTokens(path: string, tokens: Tokens): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(tokens)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function tokenResponse(value: unknown, oldRefreshToken?: string): Tokens {
  const data = asObject(value);
  if (!credential(data.access_token) || typeof data.expires_in !== 'number'
      || !Number.isFinite(data.expires_in) || data.expires_in <= 0
      || (data.refresh_token !== undefined && !credential(data.refresh_token))) {
    throw new MyQError('Invalid myQ token response.');
  }
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : oldRefreshToken;
  return {
    accessToken: data.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/** A single refresh is shared across callers; rotating credentials are saved before use. */
export class TokenManager {
  private refreshing: Promise<Tokens> | undefined;
  private rejectedRefresh: string | undefined;
  private rejectedAccess: string | undefined;
  private retryAt = 0;

  constructor(readonly path: string, private readonly fetcher: typeof fetch = fetch) {}

  async read(): Promise<Tokens> {
    try { return parseTokens(JSON.parse(await readFile(this.path, 'utf8')) as unknown); }
    catch { throw new MyQError('Cannot read myQ credentials. Check the private token file.'); }
  }

  async accessToken(): Promise<string> {
    const tokens = await this.read();
    if (tokens.accessToken === this.rejectedAccess) {
      throw new MyQError('myQ rejected this session. Sign in again.');
    }
    if (tokens.expiresAt !== undefined && tokens.expiresAt <= Date.now() + 60_000) {
      return (await this.refresh(tokens)).accessToken;
    }
    return tokens.accessToken;
  }

  async recover(rejectedAccess: string): Promise<string> {
    const tokens = await this.read();
    if (tokens.accessToken !== rejectedAccess) return tokens.accessToken;
    if (this.rejectedAccess === rejectedAccess) throw new MyQError('myQ rejected this session. Sign in again.');
    if (!tokens.refreshToken) {
      this.rejectedAccess = rejectedAccess;
      throw new MyQError('This legacy access token expired. Sign in to enable automatic renewal.');
    }
    return (await this.refresh(tokens)).accessToken;
  }

  reject(accessToken: string): void { this.rejectedAccess = accessToken; }

  async refresh(tokens: Tokens): Promise<Tokens> {
    if (this.refreshing) return this.refreshing;
    if (!tokens.refreshToken || tokens.refreshToken === this.rejectedRefresh) {
      throw new MyQError('myQ session has expired or been revoked. Sign in again.');
    }
    if (Date.now() < this.retryAt) {
      throw new MyQError('myQ authentication is backing off.', Math.ceil((this.retryAt - Date.now()) / 1000));
    }
    this.refreshing = this.renew(tokens);
    try { return await this.refreshing; }
    finally { this.refreshing = undefined; }
  }

  private async renew(tokens: Tokens): Promise<Tokens> {
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tokens.refreshToken! }),
      });
    } catch {
      this.retryAt = Date.now() + 60_000;
      throw new MyQError('myQ token refresh failed or timed out.');
    }
    if (response.status === 429) {
      const seconds = retryAfter(response);
      this.retryAt = Date.now() + seconds * 1000;
      throw new MyQError('myQ rate limited token refresh.', seconds);
    }
    if ([400, 401, 403].includes(response.status)) {
      this.rejectedRefresh = tokens.refreshToken;
      throw new MyQError('myQ session could not be renewed. Sign in again.');
    }
    if (!response.ok) {
      this.retryAt = Date.now() + 60_000;
      throw new MyQError(`myQ token refresh returned HTTP ${response.status}.`);
    }
    // A successful exchange may consume a rotating refresh token even if parsing or persistence fails.
    this.rejectedRefresh = tokens.refreshToken;
    let renewed: Tokens;
    try { renewed = tokenResponse(await response.json(), tokens.refreshToken); }
    catch { throw new MyQError('myQ returned an invalid token response.'); }
    // A manual sign-in that finished during this request wins over this old session.
    const current = await this.read();
    if (current.accessToken !== tokens.accessToken || current.refreshToken !== tokens.refreshToken) return current;
    try { await saveTokens(this.path, renewed); }
    catch { throw new MyQError('Cannot save renewed myQ credentials. Check token-file directory permissions.'); }
    this.retryAt = 0;
    this.rejectedRefresh = undefined;
    return renewed;
  }
}
