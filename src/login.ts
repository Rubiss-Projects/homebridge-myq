import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CLIENT_ID, REDIRECT_URI, SCOPE, TOKEN_URL, tokenResponse, type Tokens } from './auth.js';
import { MyQError, retryAfter } from './errors.js';

const IDENTITY = 'https://partner-identity.myq-cloud.com';
const LIFETIME_MS = 10 * 60_000;

/** One short-lived PKCE login; the verifier stays in Homebridge, never in the browser UI. */
export class LoginSession {
  readonly expiresAt: number;
  readonly authorizationURL: string;
  private readonly verifier = randomBytes(32).toString('base64url');
  private readonly state = randomBytes(32).toString('base64url');
  private consumed = false;

  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    this.expiresAt = now() + LIFETIME_MS;
    const url = new URL('/connect/authorize', IDENTITY);
    url.search = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPE,
      code_challenge: createHash('sha256').update(this.verifier).digest('base64url'),
      code_challenge_method: 'S256', state: this.state,
    }).toString();
    this.authorizationURL = url.toString();
  }

  cancel(): void { this.consumed = true; }

  async complete(callback: string): Promise<Tokens> {
    if (this.consumed || this.now() >= this.expiresAt) throw new MyQError('Sign-in expired. Start again.');
    let url: URL;
    try { url = new URL(callback); }
    catch { throw new MyQError('Invalid sign-in callback.'); }
    if (url.protocol !== 'com.myqops:' || url.hostname !== 'ios' || (url.pathname !== '' && url.pathname !== '/')
        || url.username || url.password || url.port || url.hash) throw new MyQError('Invalid sign-in callback.');
    const states = url.searchParams.getAll('state');
    const state = Buffer.from(states[0] ?? '');
    const expected = Buffer.from(this.state);
    if (states.length !== 1 || state.length !== expected.length || !timingSafeEqual(state, expected)) {
      throw new MyQError('Sign-in callback does not match this session.');
    }
    const issuer = url.searchParams.getAll('iss');
    if (issuer.length > 1 || (issuer.length === 1 && issuer[0] !== IDENTITY)) {
      throw new MyQError('Unexpected sign-in provider.');
    }
    if (url.searchParams.has('error')) {
      this.consumed = true;
      throw new MyQError('myQ did not authorize sign-in. Start again.');
    }
    const codes = url.searchParams.getAll('code');
    const code = codes[0];
    if (codes.length !== 1 || !code || code.length > 8192 || /\s/.test(code)) throw new MyQError('Invalid authorization code.');
    // Authorization codes are one-use. Even ambiguous transport failures need a new login.
    this.consumed = true;
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI, scope: SCOPE, code, code_verifier: this.verifier }),
      });
    } catch { throw new MyQError('Could not finish myQ sign-in. Start a new sign-in attempt.'); }
    if (response.status === 429) throw new MyQError('myQ rate limited sign-in. Try again later.', retryAfter(response));
    if (!response.ok) {
      let applicationRejected = false;
      try {
        const body: unknown = await response.json();
        applicationRejected = typeof body === 'object' && body !== null
          && 'code' in body && body.code === '401.122';
      } catch { /* Never expose raw provider responses or callback codes. */ }
      if (applicationRejected) throw new MyQError('myQ rejected this application (401.122). Signing in again will not fix application authorization.');
      throw new MyQError(`myQ sign-in returned HTTP ${response.status}. Start again.`);
    }
    let tokens: Tokens;
    try { tokens = tokenResponse(await response.json()); }
    catch { throw new MyQError('myQ returned an invalid sign-in response.'); }
    if (!tokens.refreshToken) throw new MyQError('myQ did not grant automatic renewal. Existing credentials were not replaced.');
    return tokens;
  }
}
