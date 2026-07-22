const WHISPER_SAMPLE_RATE = 16_000;

export function mixAndResampleAudio(channels: Float32Array[], sourceRate: number, targetRate = WHISPER_SAMPLE_RATE): Float32Array {
  if (!channels.length || sourceRate <= 0 || targetRate <= 0) return new Float32Array();
  const sourceLength = Math.min(...channels.map((channel) => channel.length));
  if (!sourceLength) return new Float32Array();
  const mixed = new Float32Array(sourceLength);
  for (let index = 0; index < sourceLength; index += 1) {
    let sample = 0;
    for (const channel of channels) sample += channel[index];
    mixed[index] = sample / channels.length;
  }
  if (sourceRate === targetRate) return mixed;
  const outputLength = Math.max(1, Math.round(sourceLength * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.min(sourceLength - 1, Math.floor(position));
    const right = Math.min(sourceLength - 1, left + 1);
    const fraction = position - left;
    output[index] = mixed[left] + (mixed[right] - mixed[left]) * fraction;
  }
  return output;
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = WHISPER_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

export async function recordedAudioToWav(blob: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const samples = mixAndResampleAudio(channels, decoded.sampleRate);
    if (!samples.length) throw new Error("A gravação não contém áudio");
    const wav = encodePcm16Wav(samples);
    const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    return new Blob([buffer], { type: "audio/wav" });
  } finally {
    await context.close();
  }
}
