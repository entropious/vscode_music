// The light build: no subtitles, alternate audio or DRM, none of which a motion cover has.
import Hls from 'hls.js/light';
import type { TrackVisuals } from '../wire.ts';

/** One video to show for a track. */
export type Visual = { kind: 'clip' | 'video' | 'artistVideo' | 'motionCover'; url: string } | { kind: 'youtube'; id: string };

/** The video to show, in order of preference: a music video, the track's own video shot, the artist's video, the album's motion cover. */
export function pickVisual(v: TrackVisuals | undefined): Visual | undefined {
  if (!v) {
    return undefined;
  }
  if (v.clip) {
    return { kind: 'clip', url: v.clip.previewUrl };
  }
  if (v.youtubeId) {
    return { kind: 'youtube', id: v.youtubeId };
  }
  if (v.video) {
    return { kind: 'video', url: v.video };
  }
  if (v.artistVideo) {
    return { kind: 'artistVideo', url: v.artistVideo };
  }
  return v.motionCover ? { kind: 'motionCover', url: v.motionCover } : undefined;
}

const key = (v: Visual | undefined): string => (v ? `${v.kind}:${v.kind === 'youtube' ? v.id : v.url}` : '');

/** A YouTube video drifts this far from the track before it is put back in step. */
const YOUTUBE_DRIFT_S = 3;
const YOUTUBE = 'https://www.youtube-nocookie.com';

/**
 * Plays one video at a time, without sound, wherever it fits: a wide one fills the background,
 * a tall or square one takes the cover's tile (cropped to a square). The video plays only while
 * the music does and the window is visible; nothing is drawn over it, so it costs no more than
 * decoding, which the Mac does in hardware.
 */
export class VideoStage {
  private readonly background: HTMLElement;
  private readonly tile: HTMLElement;
  private readonly onPlace: (place: 'background' | 'tile' | undefined) => void;
  private shown = '';
  private video: HTMLVideoElement | undefined;
  private hls: Hls | undefined;
  private frame: HTMLIFrameElement | undefined;
  /** Where the YouTube video is, as it last reported. */
  private youtubeTime = 0;
  private playing = false;

  constructor(background: HTMLElement, tile: HTMLElement, onPlace: (place: 'background' | 'tile' | undefined) => void) {
    this.background = background;
    this.tile = tile;
    this.onPlace = onPlace;
    document.addEventListener('visibilitychange', () => this.apply());
    window.addEventListener('message', (e) => this.onYouTube(e));
  }

  /** Shows a track's video, or none; `position` is where the track is, for a YouTube video to follow. */
  show(visual: Visual | undefined, position: number): void {
    if (key(visual) === this.shown) {
      return;
    }
    this.shown = key(visual);
    this.clear();
    if (!visual) {
      return;
    }
    if (visual.kind === 'youtube') {
      this.showYouTube(visual.id, position);
    } else {
      this.showVideo(visual.url);
    }
  }

  /** Follows the music: plays and pauses with it, and keeps a YouTube video at the track's position. */
  follow(playing: boolean, position: number): void {
    if (playing !== this.playing) {
      this.playing = playing;
      this.apply();
    }
    if (this.frame && playing && Math.abs(this.youtubeTime - position) > YOUTUBE_DRIFT_S) {
      this.youtubeTime = position;
      this.command('seekTo', [position, true]);
    }
  }

  private get active(): boolean {
    return this.playing && document.visibilityState === 'visible';
  }

  private apply(): void {
    if (this.video) {
      if (this.active) {
        void this.video.play().catch(() => undefined);
      } else {
        this.video.pause();
      }
    }
    if (this.frame) {
      this.command(this.active ? 'playVideo' : 'pauseVideo', []);
    }
  }

  private clear(): void {
    const old = [this.video, this.frame].filter((e) => e !== undefined);
    this.hls?.destroy();
    this.hls = undefined;
    if (this.video) {
      // Lets the decoder go at once rather than when the element is collected.
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.video = undefined;
    this.frame = undefined;
    this.onPlace(undefined);
    for (const e of old) {
      e.classList.remove('shown');
      setTimeout(() => e.remove(), 800);
    }
  }

  private showVideo(url: string): void {
    const video = document.createElement('video');
    video.className = 'visual';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.setAttribute('aria-hidden', 'true');
    this.video = video;
    video.addEventListener('loadedmetadata', () => {
      if (this.video !== video) {
        return;
      }
      const wide = video.videoWidth / Math.max(1, video.videoHeight) > 1.2;
      (wide ? this.background : this.tile).append(video);
      this.onPlace(wide ? 'background' : 'tile');
      this.apply();
    });
    video.addEventListener('playing', () => video.classList.add('shown'), { once: true });
    // A video that fails to load is left out: the cover stays.
    video.addEventListener('error', () => this.video === video && this.clear());
    if (/\.m3u8(\?|$)/.test(url) && !video.canPlayType('application/vnd.apple.mpegurl')) {
      if (!Hls.isSupported()) {
        this.video = undefined;
        return;
      }
      // Only as sharp as the tile it plays in: a smaller stream is less to fetch and decode.
      const hls = new Hls({ enableWorker: false, capLevelToPlayerSize: true, maxBufferLength: 10 });
      hls.on(Hls.Events.ERROR, (_e, data) => data.fatal && this.video === video && this.clear());
      hls.loadSource(url);
      hls.attachMedia(video);
      this.hls = hls;
    } else {
      video.src = url;
    }
  }

  private showYouTube(id: string, position: number): void {
    const frame = document.createElement('iframe');
    frame.className = 'visual youtube';
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.allow = 'autoplay';
    const q = new URLSearchParams({
      autoplay: this.active ? '1' : '0',
      mute: '1',
      controls: '0',
      disablekb: '1',
      fs: '0',
      iv_load_policy: '3',
      playsinline: '1',
      rel: '0',
      enablejsapi: '1',
      start: String(Math.floor(position)),
    });
    frame.src = `${YOUTUBE}/embed/${encodeURIComponent(id)}?${q}`;
    frame.addEventListener('load', () => frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1 }), YOUTUBE));
    this.youtubeTime = position;
    this.frame = frame;
    this.background.append(frame);
    this.onPlace('background');
  }

  private command(func: string, args: unknown[]): void {
    this.frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YOUTUBE);
  }

  /** The YouTube player's reports: its position, that it plays (it shows then), or that it can't. */
  private onYouTube(e: MessageEvent): void {
    if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== YOUTUBE) {
      return;
    }
    let m: { event?: string; info?: any };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (m.event === 'onError') {
      this.clear(); // embedding not allowed, or the video is gone: the cover stays
    } else if (m.event === 'infoDelivery' && m.info) {
      if (typeof m.info.currentTime === 'number') {
        this.youtubeTime = m.info.currentTime;
      }
      if (m.info.playerState === 1) {
        this.frame.classList.add('shown');
      }
    }
  }
}
