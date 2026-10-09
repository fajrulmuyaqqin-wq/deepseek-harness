/**
 * Sensitive path detection for the filesystem sandbox. Identifies credential stores,
 * private keys, environment secrets, and sensitive host directories that an agent
 * must not read or modify under confined sandbox modes.
 *
 * @module @deepseek-ai/dsh-fs-sandbox/sensitive-blacklist
 */

import { basename } from 'node:path'

/**
 * File name patterns identifying known credential and secret files.
 */
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  // Environment secret files (.env, .env.local, .env.production, etc.)
  /^\.env(\..+)?$/i,
  // SSH private keys
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  // Key and certificate formats
  /\.(pem|key|p12|pfx|pkcs12|keystore)$/i,
  // Shell history files
  /\.(bash|zsh|sh)_history$/i,
]

/**
 * Path segment patterns identifying credential directories and host files.
 */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  // Git repository configuration (frequently contains embedded PAT tokens)
  /(?:^|[\\/])\.git[\\/]config$/i,
  // Cloud provider and host credential directories
  /(?:^|[\\/])\.(ssh|aws|gnupg|azure|kube)(?:[\\/]|$)/i,
  // CLI tool credential directories
  /(?:^|[\\/])\.config[\\/](gcloud|gh|op)(?:[\\/]|$)/i,
  // Critical host system credential stores
  /^[\\/]etc[\\/](shadow|sudoers|master\.passwd)$/i,
]

/**
 * Excluded template file patterns that are explicitly safe to inspect.
 */
const SAFE_TEMPLATE_PATTERNS: readonly RegExp[] = [
  /^\.env\.(example|sample|template)$/i,
]

/**
 * Test whether a path or target filename points to a protected credential or sensitive secret.
 *
 * @param filePath - the raw or canonical path to test.
 * @returns true if the path points to a sensitive credential file.
 */
export function isSensitivePath(filePath: string): boolean {
  if (filePath.length === 0) return false

  const name = basename(filePath)

  // Safe templates like .env.example are allowed for project onboarding and schema inspection
  for (const pattern of SAFE_TEMPLATE_PATTERNS) {
    if (pattern.test(name)) return false
  }

  // Check filename patterns
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(name)) return true
  }

  // Normalize separators for path segment checks
  const normalized = filePath.replace(/\\/g, '/')
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(normalized)) return true
  }

  return false
}
