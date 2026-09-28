import { createHash, randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { captureNavigation, findChromium } from './browserAuth';

/**
 * Client of the Yandex Music desktop app: only music:* and login:info scopes.
 * It has no client secret, so the authorization code is exchanged with PKCE.
 * Its only callback is https://music.yandex.ru/oauth, a page that navigates away
 * immediately, so the redirect has to be intercepted before the page loads.
 */
const CLIENT_ID = '97fe03033fa34407ac9bcf91d5afed5b';
const CALLBACK = 'https://music.yandex.ru/oauth';
const TOKEN_KEY = 'yandexMusic.token';

const DONE_HTML = `<!doctype html><meta charset="utf-8"><title>Yandex Music</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh">You're signed in. You can return to VS Code.</body>`;

/** Extracts the authorization code from a redirect URL (`…/oauth?code=…`), or accepts a bare code. */
export function parseCode(input: string): string | undefined {
  const value = input.trim();
  const param = value.match(/[?&]code=([^&#\s]+)/);
  if (param) {
    return decodeURIComponent(param[1]);
  }
  return /^\w+$/.test(value) ? value : undefined;
}

export class Auth {
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly storageDir: string,
  ) {}

  getToken(): Thenable<string | undefined> {
    return this.secrets.get(TOKEN_KEY);
  }

  async setToken(token: string | undefined): Promise<void> {
    if (token) {
      await this.secrets.store(TOKEN_KEY, token.trim());
    } else {
      await this.secrets.delete(TOKEN_KEY);
    }
    this.changed.fire(token);
  }

  /**
   * Browser sign-in: the user authorizes on oauth.yandex.ru, the code is intercepted
   * on the redirect and exchanged for a token using PKCE.
   */
  async signInWithBrowser(oauthBase: string): Promise<string | undefined> {
    const base = oauthBase.replace(/\/$/, '');
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(`${base}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');

    const redirect = await this.obtainRedirect(url.toString());
    if (!redirect) {
      return undefined;
    }
    const error = redirect.match(/[?&]error_description=([^&#]+)/) ?? redirect.match(/[?&]error=([^&#]+)/);
    if (error) {
      throw new Error(`Sign-in failed: ${decodeURIComponent(error[1].replace(/\+/g, ' '))}`);
    }
    const code = parseCode(redirect);
    if (!code) {
      throw new Error('Yandex did not return an authorization code');
    }

    const res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT_ID, code_verifier: verifier }).toString(),
    });
    const body = (await res.json()) as any;
    if (!body.access_token) {
      throw new Error(`Sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
    }
    await this.setToken(body.access_token);
    return body.access_token as string;
  }

  /** The URL Yandex redirected to after sign-in, or a code the user entered by hand. */
  private async obtainRedirect(authorizeUrl: string): Promise<string | undefined> {
    const browserPath = findChromium();
    if (browserPath) {
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Sign in to Yandex in the browser window that just opened…', cancellable: true },
        (_p, cancel) => {
          const abort = new AbortController();
          cancel.onCancellationRequested(() => abort.abort());
          return captureNavigation({
            browserPath,
            profileDir: `${this.storageDir}/browser-profile`,
            startUrl: authorizeUrl,
            interceptPattern: `${CALLBACK}*`,
            doneHtml: DONE_HTML,
            signal: abort.signal,
          });
        },
      );
    }

    // Without a Chromium browser, music.yandex.ru/oauth navigates away from the URL with the code
    // before we can catch it, but the URL still ends up in the browser history.
    await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl, true));
    return vscode.window.showInputBox({
      prompt: 'After signing in, find the music.yandex.ru/oauth?code=… link in your browser history and paste the link or just the code here',
      placeHolder: 'https://music.yandex.ru/oauth?code=…',
      ignoreFocusOut: true,
      validateInput: (v) => (!v || parseCode(v) ? undefined : 'This link has no code parameter'),
    });
  }
}
