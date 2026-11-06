import { defineConfig } from 'vitest/config'

// Unit tests for pure libraries (src/lib/**). Node environment; XML is parsed with @xmldom/xmldom.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
