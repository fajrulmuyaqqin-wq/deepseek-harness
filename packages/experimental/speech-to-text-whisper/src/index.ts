/** Optional local Whisper provider; activation performs no downloads or model loading. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { Config } from './config.ts'
import { WhisperWorker } from './recognizer.ts'
import { languages } from './input.ts'

export { Config } from './config.ts'
export const name = 'experimental-speech-to-text-whisper'
export const inject = ['speechToText', 'subprocess']

/**
 * Register the local recognizer and inspect disk caches without downloading or loading models.
 * @param ctx - Host registry and subprocess owner.
 * @param config - validated runtime configuration.
 */
export function apply(ctx: Context, config: Config): void {
  for (const path of [config.dataRoot, config.modelDirectory, config.vadModelPath]) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`Whisper paths must be absolute: ${path}`)
  }
  for (const origin of config.modelOrigin === undefined ? config.modelOrigins : [config.modelOrigin]) new URL(origin)
  const worker = new WhisperWorker(ctx, config)
  const estimatedBytes = 200_000_000
  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: { id: config.providerId as SpeechProviderId, name: `WhisperTiny (${config.precision.toUpperCase()})`, location: 'host-local', languages, downloadSources: worker.downloadSources,
        setupEstimate: { recommendedDiskBytes: estimatedBytes, expectedMemoryBytes: estimatedBytes,
          minimumMinutes: 1, maximumMinutes: 5 } },
      preparation: worker,
      transcribe: async (input, signal) => await worker.transcribe(input, signal),
    })
    worker.inspect()
    return async () => {
      const removing = unregister()
      await worker.dispose()
      await removing
    }
  })
}
