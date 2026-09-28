import * as vscode from 'vscode';

export type Status = { playing: boolean; position: number; duration: number; trackId?: string; title?: string; queueLength: number; index: number; source: string; error?: string; needsGesture?: boolean };

export const status = () => vscode.commands.executeCommand<Status>('yandexMusic.getStatus');

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) {
      return v;
    }
    last = await status();
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}. Last status: ${JSON.stringify(last)}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
