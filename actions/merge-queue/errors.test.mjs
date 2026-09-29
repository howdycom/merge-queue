import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorText } from './errors.mjs'

test('errorText reads a string, stderr, message, then the value itself', () => {
  assert.equal(errorText('plain'), 'plain')
  assert.equal(errorText({ stderr: 'from-stderr', message: 'from-message' }), 'from-stderr')
  assert.equal(errorText({ message: 'from-message' }), 'from-message')
  assert.equal(errorText(undefined), 'undefined')
})
