// Audio output for the macOS player service: AVPlayer driven through osascript (JXA).
//   osascript -l JavaScript avplayer.js
// Reads one JSON command per line on stdin and writes one JSON event per line on stdout.
// Commands: {cmd:"load", url, position?, play?}, {cmd:"play"}, {cmd:"pause"},
// {cmd:"seek", seconds}, {cmd:"volume", value}. Events: {type:"status", ...} four times
// a second, {type:"ended"} when a track plays to the end, {type:"error", message}.
// Exits when stdin closes, so it never outlives the service that started it.

ObjC.import('Foundation');
ObjC.import('AVFoundation');
ObjC.import('CoreMedia');
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
  }
  send(status());
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
          send(status());
        }
      },
    },
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
  center.addObserverSelectorNameObject(controller, 'onInput:', $.NSFileHandleReadCompletionNotification, stdin);
  stdin.readInBackgroundAndNotify;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.25, controller, 'onTick:', $(), true);
  send({ type: 'ready' });
  $.NSRunLoop.currentRunLoop.run;
}
