import { existsSync } from "node:fs";
import { config } from "./config";

// Voice fingerprints for matching speakers across the parts of a long
// recording (see speakerLinking.ts). sherpa-onnx runs the ERes2Net speaker
// model in-process on the CPU; a fingerprint of a minute of audio takes well
// under a second. The model file is baked into the image (see Dockerfile).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;

function load(): any {
  if (extractor) return extractor;
  if (!existsSync(config.speakerModelPath)) {
    throw new Error(`Speaker model not found at ${config.speakerModelPath}.`);
  }
  // Loaded lazily so the app (and its tests) run where the native addon is absent.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require("sherpa-onnx-node");
  extractor = new sherpa.SpeakerEmbeddingExtractor({ model: config.speakerModelPath, numThreads: 2, debug: 0 });
  return extractor;
}

export function embedSpeaker(samples: Float32Array, sampleRate: number): Float32Array {
  const ex = load();
  const stream = ex.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  stream.inputFinished();
  return Float32Array.from(ex.compute(stream));
}
