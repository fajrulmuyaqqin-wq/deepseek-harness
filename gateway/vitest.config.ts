import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['gateway/tests/**/*.spec.ts'],
  },
})
