// Vitest setup (vite.config.js, test.setupFiles): Testing Library's findBy* and waitFor give a
// slow machine five seconds instead of one, for the same reason as the test timeout there.
import { configure } from '@testing-library/react'

configure({ asyncUtilTimeout: 5000 })
