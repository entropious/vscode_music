// Audio output for the macOS player service: AVPlayer driven through osascript (JXA).
//   osascript -l JavaScript avplayer.js
// Reads one JSON command per line on stdin and writes one JSON event per line on stdout.
// Commands: {cmd:"load", url, position?, play?}, {cmd:"play"}, {cmd:"pause"},
// {cmd:"seek", seconds}, {cmd:"volume", value}, {cmd:"nowPlaying", title, artist, duration}.
// Events: {type:"status", ...} four times a second, {type:"ended"} when a track plays to the end,
// {type:"error", message}, {type:"remote", command, position?} when a media key or the system's
// Now Playing controls are used (command: play, pause, toggle, next, previous, seek).
// Exits when stdin closes, so it never outlives the service that started it.

ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('AVFoundation');
ObjC.import('CoreMedia');
ObjC.import('MediaPlayer');
ObjC.import('stdlib');

// AVPlayer and AVPlayerItem aren't in AVFoundation's BridgeSupport, so `$.AVPlayer` is
// undefined; the classes are loaded, though, and NSClassFromString reaches them. Their enum
// constants are missing for the same reason and are spelled out below.
const AVPlayer = $.NSClassFromString('AVPlayer');
const AVPlayerItem = $.NSClassFromString('AVPlayerItem');
const ITEM_FAILED = 2; // AVPlayerItemStatusFailed
const WAITING = 1; // AVPlayerTimeControlStatusWaitingToPlayAtSpecifiedRate
const PLAYING = 2; // AVPlayerTimeControlStatusPlaying

const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const center = $.NSNotificationCenter.defaultCenter;
const player = AVPlayer.alloc.init;
let pending = '';
let item = null;

const NOW_PLAYING_PLAYING = 1; // MPNowPlayingPlaybackStatePlaying
const NOW_PLAYING_PAUSED = 2; // MPNowPlayingPlaybackStatePaused
const SUCCESS = 0; // MPRemoteCommandHandlerStatusSuccess
const ACTIVATION_ACCESSORY = 1; // NSApplicationActivationPolicyAccessory
const commandCenter = $.MPRemoteCommandCenter.sharedCommandCenter;
const infoCenter = $.MPNowPlayingInfoCenter.defaultCenter;
/**
 * Track shown in Now Playing: {title, artist, duration}. There is no cover: MPMediaItemArtwork
 * takes a block that must return an NSImage, and a JXA function hands back a JSValue instead,
 * which crashes the process when the system asks for the image.
 */
let nowPlaying = null;
/** What Now Playing was last told, so it's only updated when playback actually changes. */
let published = { playing: false, duration: 0 };

function send(event) {
  stdout.writeData($(JSON.stringify(event) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

function seconds(time) {
  return time && time.timescale > 0 ? time.value / time.timescale : 0;
}

function status() {
  const current = player.currentItem;
  // Numeric properties come back wrapped, hence Number() before comparing.
  const failed = current && Number(current.status) === ITEM_FAILED;
  const control = Number(player.timeControlStatus);
  return {
    type: 'status',
    position: seconds(player.currentTime),
    duration: current ? seconds(current.duration) : 0,
    playing: control === PLAYING,
    buffering: control === WAITING,
    error: failed ? ObjC.unwrap(current.error.localizedDescription) : undefined,
  };
}

/**
 * Publishes the current track to the system's Now Playing (Control Center, media keys). The
 * system extrapolates the elapsed time from the rate, so this only needs to run when playback
 * starts, stops, seeks or the track changes.
 */
function publishNowPlaying() {
  if (!nowPlaying) {
    return;
  }
  const s = status();
  const duration = s.duration || nowPlaying.duration || 0;
  const info = $.NSMutableDictionary.dictionary;
  info.setObjectForKey($(nowPlaying.title), $('title'));
  info.setObjectForKey($(nowPlaying.artist), $('artist'));
  info.setObjectForKey($.NSNumber.numberWithDouble(duration), $('playbackDuration'));
  info.setObjectForKey($.NSNumber.numberWithDouble(s.position), $('MPNowPlayingInfoPropertyElapsedPlaybackTime'));
  info.setObjectForKey($.NSNumber.numberWithDouble(s.playing ? 1 : 0), $('MPNowPlayingInfoPropertyPlaybackRate'));
  infoCenter.nowPlayingInfo = info;
  infoCenter.playbackState = s.playing ? NOW_PLAYING_PLAYING : NOW_PLAYING_PAUSED;
  published = { playing: s.playing, duration };
}

function handle(command) {
  switch (command.cmd) {
    case 'load': {
      if (item) {
        center.removeObserverNameObject(controller, $.AVPlayerItemDidPlayToEndTimeNotification, item);
      }
      item = AVPlayerItem.playerItemWithURL($.NSURL.URLWithString(command.url));
      center.addObserverSelectorNameObject(controller, 'onEnd:', $.AVPlayerItemDidPlayToEndTimeNotification, item);
      player.replaceCurrentItemWithPlayerItem(item);
      if (command.position) {
        player.seekToTime($.CMTimeMakeWithSeconds(command.position, 600));
      }
      if (command.play !== false) {
        player.play;
      }
      break;
    }
    case 'play':
      player.play;
      break;
    case 'pause':
      player.pause;
      break;
    case 'seek':
      player.seekToTime($.CMTimeMakeWithSeconds(command.seconds, 600));
      break;
    case 'volume':
      player.volume = command.value;
      break;
    case 'nowPlaying':
      nowPlaying = { title: command.title, artist: command.artist, duration: command.duration };
      break;
  }
  send(status());
  publishNowPlaying();
}

/** A target for a media key or Now Playing control: reports it to the service. */
function remote(name, event) {
  const message = { type: 'remote', command: name };
  if (name === 'seek') {
    message.position = Number(event.positionTime);
  }
  send(message);
  return SUCCESS;
}

ObjC.registerSubclass({
  name: 'YMAudioController',
  superclass: 'NSObject',
  methods: {
    'onInput:': {
      types: ['void', ['id']],
      implementation: function (note) {
        const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
        if (Number(data.length) === 0) {
          $.exit(0);
        }
        pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            handle(JSON.parse(line));
          } catch (e) {
            send({ type: 'error', message: String(e) });
          }
        }
        stdin.readInBackgroundAndNotify;
      },
    },
    'onTick:': {
      types: ['void', ['id']],
      implementation: function () {
        if (player.currentItem) {
          const s = status();
          send(s);
          if (nowPlaying && (s.playing !== published.playing || Math.abs(s.duration - published.duration) > 0.5)) {
            publishNowPlaying();
          }
        }
      },
    },
    'onPlay:': { types: ['long', ['id']], implementation: (event) => remote('play', event) },
    'onPause:': { types: ['long', ['id']], implementation: (event) => remote('pause', event) },
    'onToggle:': { types: ['long', ['id']], implementation: (event) => remote('toggle', event) },
    'onNext:': { types: ['long', ['id']], implementation: (event) => remote('next', event) },
    'onPrevious:': { types: ['long', ['id']], implementation: (event) => remote('previous', event) },
    'onSeek:': { types: ['long', ['id']], implementation: (event) => remote('seek', event) },
    'onEnd:': {
      types: ['void', ['id']],
      implementation: function () {
        send({ type: 'ended' });
      },
    },
  },
});

const controller = $.YMAudioController.alloc.init;

function run() {
  // A launched background app (no Dock icon), so the system routes media keys here.
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(ACTIVATION_ACCESSORY);
  app.finishLaunching;
  const targets = {
    playCommand: 'onPlay:',
    pauseCommand: 'onPause:',
    togglePlayPauseCommand: 'onToggle:',
    nextTrackCommand: 'onNext:',
    previousTrackCommand: 'onPrevious:',
    changePlaybackPositionCommand: 'onSeek:',
  };
  for (const name in targets) {
    const command = commandCenter[name];
    command.enabled = true;
    command.addTargetAction(controller, targets[name]);
  }
  center.addObserverSelectorNameObject(controller, 'onInput:', $.NSFileHandleReadCompletionNotification, stdin);
  stdin.readInBackgroundAndNotify;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.25, controller, 'onTick:', $(), true);
  send({ type: 'ready' });
  $.NSRunLoop.currentRunLoop.run;
}
