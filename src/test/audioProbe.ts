import { execSync, spawn } from 'child_process';

export interface AudioStats {
  seconds: number;
  rms: number;
  peak: number;
  /** Fundamental frequency estimated from zero crossings (exact for a pure sine wave). */
  zeroCrossHz: number;
}

/** Whether a PulseAudio monitor is available to record VS Code's audio from. */
export function audioProbeAvailable(): boolean {
  if (!process.env.YM_AUDIO_DEVICE) {
    return false;
  }
  try {
    execSync('parec --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Records `ms` milliseconds of audio from the PulseAudio monitor and measures the signal level. */
export function recordAudio(ms: number): Promise<AudioStats> {
  const rate = 44100;
  return new Promise((resolve, reject) => {
    const p = spawn('parec', [`--device=${process.env.YM_AUDIO_DEVICE}`, '--raw', '--format=s16le', `--rate=${rate}`, '--channels=1', '--latency-msec=50']);
    const chunks: Buffer[] = [];
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.on('error', reject);
    setTimeout(() => p.kill('SIGTERM'), ms);
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        samples[i] = buf.readInt16LE(i * 2) / 32768;
      }
      let sum = 0;
      let peak = 0;
      for (const v of samples) {
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
      // Estimate frequency from loud 50 ms windows only, so gaps between tracks don't drag it down.
      const win = Math.floor(rate / 20);
      let crossings = 0;
      let loudSamples = 0;
      for (let w = 0; w + win <= n; w += win) {
        let e = 0;
        let c = 0;
        for (let i = w; i < w + win; i++) {
          e += samples[i] * samples[i];
          if (i > w && (samples[i - 1] < 0) !== (samples[i] < 0)) {
            c++;
          }
        }
        if (Math.sqrt(e / win) > 0.02) {
          crossings += c;
          loudSamples += win;
        }
      }
      const seconds = n / rate;
      const loudSeconds = loudSamples / rate;
      resolve({ seconds, rms: n ? Math.sqrt(sum / n) : 0, peak, zeroCrossHz: loudSeconds ? crossings / 2 / loudSeconds : 0 });
    });
  });
}
