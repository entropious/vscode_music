import * as vscode from 'vscode';

/** Public client of the Yandex Music Android app, used by all third-party clients. */
const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300';
const TOKEN_KEY = 'yandexMusic.token';

export class Auth {
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

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
   * Вход через OAuth device flow: пользователь открывает ya.ru/device,
   * вводит код и подтверждает доступ, а мы опрашиваем сервер до получения токена.
   */
  async signInWithDeviceCode(oauthBase: string): Promise<string | undefined> {
    const base = oauthBase.replace(/\/$/, '');
    const codeRes = await fetch(`${base}/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, device_name: 'VS Code' }).toString(),
    });
    const code = (await codeRes.json()) as any;
    if (!codeRes.ok || !code.device_code) {
      throw new Error(`Не удалось начать вход: ${code.error_description ?? code.error ?? codeRes.status}`);
    }

    const verifyUrl: string = code.verification_url ?? 'https://ya.ru/device';
    await vscode.env.clipboard.writeText(code.user_code);
    const choice = await vscode.window.showInformationMessage(
      `Код для входа: ${code.user_code} (скопирован в буфер). Откройте ${verifyUrl}, введите код и разрешите доступ.`,
      'Открыть страницу',
    );
    if (choice === 'Открыть страницу') {
      await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));
    }

    const intervalMs = Math.max(1, Number(code.interval) || 5) * 1000;
    const deadline = Date.now() + (Number(code.expires_in) || 300) * 1000;

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Ожидаю подтверждения входа (код ${code.user_code})…`, cancellable: true },
      async (_p, cancel) => {
        while (Date.now() < deadline && !cancel.isCancellationRequested) {
          await new Promise((r) => setTimeout(r, intervalMs));
          const res = await fetch(`${base}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'device_code',
              code: code.device_code,
              client_id: CLIENT_ID,
              client_secret: CLIENT_SECRET,
            }).toString(),
          });
          const body = (await res.json()) as any;
          if (body.access_token) {
            await this.setToken(body.access_token);
            return body.access_token as string;
          }
          if (body.error && body.error !== 'authorization_pending') {
            throw new Error(`Вход не выполнен: ${body.error_description ?? body.error}`);
          }
        }
        return undefined;
      },
    );
  }
}
