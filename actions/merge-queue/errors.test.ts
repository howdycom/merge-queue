import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorText } from './errors.ts'

test('errorText reads a string, stderr, message, then the value itself', () => {
  assert.equal(errorText('plain'), 'plain')
  assert.equal(errorText({ stderr: 'from-stderr', message: 'from-message' }), 'from-stderr')
  assert.equal(errorText({ message: 'from-message' }), 'from-message')
  assert.equal(errorText(undefined), 'undefined')
  assert.equal(errorText(null), 'null')
  assert.equal(errorText({}), '[object Object]')
})
