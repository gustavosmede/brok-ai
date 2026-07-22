import assert from "node:assert/strict";
import test from "node:test";
import { encodePcm16Wav, mixAndResampleAudio } from "../lib/audio.ts";

test("mixes stereo and resamples audio for Whisper", () => {
  const left = Float32Array.from([1, 1, -1, -1]);
  const right = Float32Array.from([1, -1, 1, -1]);
  const samples = mixAndResampleAudio([left, right], 4, 2);
  assert.equal(samples.length, 2);
  assert.deepEqual(Array.from(samples), [1, 0]);
});

test("encodes mono PCM as a valid 16-bit WAV", () => {
  const wav = encodePcm16Wav(Float32Array.from([0, 1, -1]), 16_000);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), "WAVE");
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 16_000);
  assert.equal(new DataView(wav.buffer).getUint32(40, true), 6);
});
