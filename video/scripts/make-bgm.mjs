// Generates the 30-second soundtrack for the promo: 110 BPM, Am–F–C–G,
// soft pad + bass + plucked arpeggio + light kit. Everything is synthesized
// here — no samples, no third-party audio, no licensing to track. The output
// is deterministic, so re-rendering the video does not re-roll the music.
//
//   node scripts/make-bgm.mjs   (writes public/bgm.wav)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SR = 44100;
const DUR = 30;
const N = SR * DUR;
const BPM = 110;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const TAU = Math.PI * 2;

const mix = new Float32Array(N);
const space = new Float32Array(N);

/** Adds one synthesized event to a bus, sample by sample. */
function add(startSec, durSec, render, bus = mix) {
  const i0 = Math.max(0, Math.round(startSec * SR));
  const i1 = Math.min(N, Math.round((startSec + durSec) * SR));
  for (let i = i0; i < i1; i++) {
    bus[i] += render((i - i0) / SR);
  }
}

function env(t, attack, release, dur) {
  if (t < attack) return t / attack;
  const end = dur - release;
  if (t > end) return Math.max(0, (dur - t) / release);
  return 1;
}

function padTone(freq, amp, dur) {
  const harmonics = [1, 0.3, 0.08];
  return (t) => {
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      v += harmonics[h] * Math.sin(TAU * freq * (h + 1) * t);
    }
    return v * amp * env(t, 0.3, 0.6, dur);
  };
}

function bassTone(freq, amp, dur) {
  return (t) =>
    (Math.sin(TAU * freq * t) + 0.35 * Math.sin(TAU * freq * 2 * t)) *
    amp *
    env(t, 0.004, 0.12, dur);
}

function pluck(freq, amp) {
  return (t) =>
    (Math.sin(TAU * freq * t) + 0.25 * Math.sin(TAU * freq * 3 * t)) *
    amp *
    Math.exp(-t / 0.11);
}

function kick(amp) {
  let phase = 0;
  return (t) => {
    const f = 46 + 74 * Math.exp(-t / 0.035);
    phase += (TAU * f) / SR;
    return Math.sin(phase) * amp * Math.exp(-t / 0.16);
  };
}

/** Mulberry32: deterministic white noise for the hats. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hat(seed, amp) {
  const r = rng(seed);
  let prev = 0;
  return (t) => {
    const n = r() * 2 - 1;
    const hp = (n - prev) * 0.5;
    prev = n;
    return hp * amp * Math.exp(-t / 0.025);
  };
}

const CHORDS = [
  { root: 110.0, tones: [220.0, 261.63, 329.63] }, // Am
  { root: 87.31, tones: [174.61, 220.0, 261.63] }, // F
  { root: 130.81, tones: [261.63, 329.63, 392.0] }, // C
  { root: 98.0, tones: [196.0, 246.94, 293.66] }, // G
];

const bars = Math.floor(DUR / BAR);
const ARP = [0, 1, 2, 1, 2, 1, 0, 1];

for (let b = 0; b < bars; b++) {
  const t0 = b * BAR;
  const chord = CHORDS[b % CHORDS.length];

  for (const tone of chord.tones) {
    add(t0, BAR * 0.98, padTone(tone, 0.028, BAR * 0.98));
  }

  add(t0, 0.5, bassTone(chord.root, 0.13, 0.5));
  add(t0 + 2 * BEAT, 0.5, bassTone(chord.root, 0.13, 0.5));

  if (b >= 1) {
    const sixteenth = BEAT / 4;
    for (let s = 0; s < 16; s++) {
      const freq = chord.tones[ARP[s % ARP.length]] * 2;
      const t = t0 + s * sixteenth;
      add(t, 0.2, pluck(freq, 0.032));
      add(t, 0.2, pluck(freq, 0.026), space);
    }
  }

  const kicks = b < 2 ? [0, 2] : [0, 1, 2, 3];
  for (const k of kicks) {
    add(t0 + k * BEAT, 0.35, kick(0.26));
    if (b >= 1) add(t0 + k * BEAT + BEAT / 2, 0.06, hat(1000 + b * 10 + k, 0.04));
  }
}

// Dotted-eighth echo on the plucks only, so the kick stays tight.
for (const [delaySec, gain] of [
  [BEAT * 0.75, 0.22],
  [BEAT * 1.5, 0.09],
]) {
  const d = Math.round(delaySec * SR);
  for (let i = d; i < N; i++) mix[i] += space[i - d] * gain;
}

// Fades at both ends, then normalize to leave headroom for the AAC encode.
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const g = Math.min(t / 0.6, 1) * Math.min((DUR - t) / 1.6, 1);
  mix[i] *= Math.max(0, g);
  peak = Math.max(peak, Math.abs(mix[i]));
}
const scale = peak > 0 ? 0.85 / peak : 1;

const wav = Buffer.alloc(44 + N * 4);
wav.write("RIFF", 0, "latin1");
wav.writeUInt32LE(36 + N * 4, 4);
wav.write("WAVE", 8, "latin1");
wav.write("fmt ", 12, "latin1");
wav.writeUInt32LE(16, 16); // fmt chunk size
wav.writeUInt16LE(1, 20); // PCM
wav.writeUInt16LE(2, 22); // stereo
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 4, 28); // byte rate
wav.writeUInt16LE(4, 32); // block align
wav.writeUInt16LE(16, 34); // bits per sample
wav.write("data", 36, "latin1");
wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const sample = Math.max(-1, Math.min(1, mix[i] * scale));
  const v = Math.round(sample * 32767);
  wav.writeInt16LE(v, 44 + i * 4);
  wav.writeInt16LE(v, 46 + i * 4);
}

const outDir = join(import.meta.dirname, "..", "public");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "bgm.wav");
writeFileSync(out, wav);
console.log(`wrote ${out} (${Math.round(wav.length / 1024)} KB)`);
