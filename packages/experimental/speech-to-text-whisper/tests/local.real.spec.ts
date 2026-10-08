/** Explicit real Whisper inference test with Bahasa Indonesia. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { WhisperWorker } from '../src/recognizer.ts'

it('prepares Whisper worker, transcribes Indonesian audio, and releases cleanly', { timeout: 60_000, retry: 0 }, async () => {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocess)
  const worker = new WhisperWorker(ctx, Config({
    dataRoot: '/var/home/fazdev/.dsh/speech-to-text/whisper',
    modelDirectory: '/var/home/fazdev/.dsh/speech-to-text/whisper/models/whisper-tiny',
    vadModelPath: '/var/home/fazdev/.dsh/speech-to-text/sensevoice/models/silero/silero_vad.onnx',
    precision: 'int8',
  }))
  try {
    worker.prepare()
    await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 30_000 })
    const audio = await readFile('/tmp/canonical_indonesian_16k.wav')
    const input = { audio, language: 'id' }
    const result = await worker.transcribe(input, new AbortController().signal)
    console.info('Whisper Indonesian transcription result:', result)
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.audioSeconds).toBeGreaterThan(0)
    expect(result.inferenceSeconds).toBeGreaterThan(0)
  } finally {
    await worker.dispose()
    await ctx.fiber.dispose()
  }
})
