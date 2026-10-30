import type { PlaybackStatus, RemoteMethod, RemoteMethods, SharedState } from './wire.ts';

/**
 * The link to the player service, as the window sees it:
 * - `starting`: no service answered; the app has started the extension's service and waits for it.
 * - `searching`: the service didn't come up (or the app was told a socket where nothing listens).
 * - `no-extension`: the Yandex Music extension isn't installed in VS Code or one of its forks.
 * - `connected`: the service took the app as its remote.
 * - `outdated`: the service speaks another protocol; the app or the extension needs an update.
 * - `old-service`: the service predates remotes other than VS Code windows.
 */
export type LinkState = 'starting' | 'searching' | 'no-extension' | 'connected' | 'outdated' | 'old-service';

/** What the main process passes on to the window. */
export type BridgeEvent =
  | { type: 'state'; state: SharedState }
  | { type: 'status'; status: PlaybackStatus }
  | { type: 'notice'; text: string }
  | { type: 'link'; link: LinkState };

/** The API the preload script puts on `window.ym`. */
export interface Bridge {
  call<M extends RemoteMethod>(method: M, ...args: RemoteMethods[M]): Promise<unknown>;
  onEvent(listener: (event: BridgeEvent) => void): void;
  toggleFullScreen(): void;
}

export const CHANNEL = {
  call: 'ym:call',
  event: 'ym:event',
  ready: 'ym:ready',
  fullScreen: 'ym:fullscreen',
} as const;
