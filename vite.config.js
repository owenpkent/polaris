import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
  },
  // Dashboard unit tests (npm test). Command Center has its own node:test suite.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}', 'e2e/**/*.test.js', 'mobile/scripts/**/*.test.js'],
    restoreMocks: true,
  },
})
