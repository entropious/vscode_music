import { execSync, spawn } from 'child_process';

export interface AudioStats {
  seconds: number;
  rms: number;
  peak: number;
  /** Оценка основной частоты по пересечениям нуля (для синусоиды совпадает с её частотой). */
  zeroCrossHz: number;
}

/** Есть ли PulseAudio-монитор, из которого можно записать звук VS Code. */
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

/** Пишет звук с монитора PulseAudio в течение ms миллисекунд и считает уровень сигнала. */
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
      // Частоту считаем только по «громким» окнам по 50 мс, чтобы паузы между треками её не занижали.
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
