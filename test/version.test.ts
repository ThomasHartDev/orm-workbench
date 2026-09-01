import { expect, test } from 'vitest'
import { version } from '../src/index'

test('exports a package version', () => {
  expect(version).toBe('0.1.0')
})
