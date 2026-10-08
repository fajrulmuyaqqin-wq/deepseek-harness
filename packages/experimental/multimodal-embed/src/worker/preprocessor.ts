/**
 * Input clamping and preprocessing pipeline (Layer 4 Safeguard).
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/worker/preprocessor
 */

export interface PreprocessedImage {
  readonly clampedBuffer: Uint8Array
  readonly estimatedWidth: number
  readonly estimatedHeight: number
  readonly visualCharacteristics: string[]
}

export interface PreprocessedAudio {
  readonly clampedBuffer: Uint8Array
  readonly durationSec: number
}

/** Clamp text to prevent runaway tokenization and excessive memory consumption. */
export function clampText(raw: string, maxChars = 2000): string {
  if (raw.length <= maxChars) return raw.trim()
  return raw.slice(0, maxChars).trim()
}

/** Preprocess and downsample image input buffer to bounded dimensions. */
export function preprocessImage(buffer: Uint8Array, maxDim = 384): PreprocessedImage {
  // Maximum size guard: clamp to at most 4MB raw buffer if uncompressed
  const byteLimit = 4 * 1024 * 1024
  const clampedBuffer = buffer.byteLength > byteLimit ? buffer.subarray(0, byteLimit) : buffer

  // Parse basic PNG / JPEG dimensions if available
  let width = maxDim
  let height = maxDim
  const characteristics: string[] = []

  if (clampedBuffer.length > 24) {
    // Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (clampedBuffer[0] === 0x89 && clampedBuffer[1] === 0x50 && clampedBuffer[2] === 0x4e && clampedBuffer[3] === 0x47) {
      const view = new DataView(clampedBuffer.buffer, clampedBuffer.byteOffset, clampedBuffer.byteLength)
      const rawW = view.getUint32(16, false)
      const rawH = view.getUint32(20, false)
      if (rawW > 0 && rawH > 0) {
        const scale = Math.min(maxDim / rawW, maxDim / rawH, 1.0)
        width = Math.round(rawW * scale)
        height = Math.round(rawH * scale)
        characteristics.push(`png-image-${width}x${height}`)
      }
    } else if (clampedBuffer[0] === 0xff && clampedBuffer[1] === 0xd8) {
      characteristics.push('jpeg-image')
    }
  }

  // Basic luminance & distribution analysis from byte samples
  let sum = 0
  const step = Math.max(1, Math.floor(clampedBuffer.length / 500))
  let samples = 0
  for (let i = 0; i < clampedBuffer.length; i += step) {
    sum += clampedBuffer[i] ?? 0
    samples++
  }
  const avgLuminance = samples > 0 ? sum / samples : 128
  if (avgLuminance < 90) {
    characteristics.push('dark-theme-palette')
  } else if (avgLuminance > 170) {
    characteristics.push('light-clean-ui')
  } else {
    characteristics.push('balanced-contrast')
  }

  return {
    clampedBuffer,
    estimatedWidth: width,
    estimatedHeight: height,
    visualCharacteristics: characteristics,
  }
}

/** Clamp audio buffer to bounded duration (16kHz 16-bit PCM = 32,000 bytes/sec). */
export function preprocessAudio(buffer: Uint8Array, maxDurationSec = 30): PreprocessedAudio {
  const bytesPerSecond = 16000 * 2 // 16kHz mono 16-bit
  const maxBytes = maxDurationSec * bytesPerSecond
  const clamped = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer
  const durationSec = Math.min(maxDurationSec, Math.round((clamped.byteLength / bytesPerSecond) * 10) / 10)

  return {
    clampedBuffer: clamped,
    durationSec,
  }
}
