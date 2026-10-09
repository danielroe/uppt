import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolvePrPreamble } from '../scripts/update-changelog.ts'

describe('resolvePrPreamble', () => {
	const originalEnv = process.env.PR_PREAMBLE

	beforeEach(() => {
		delete process.env.PR_PREAMBLE
	})

	afterEach(() => {
		// Restore the environment to its original state after each test
		if (originalEnv !== undefined) {
			process.env.PR_PREAMBLE = originalEnv
		} else {
			delete process.env.PR_PREAMBLE
		}
	})

	it('returns undefined if PR_PREAMBLE is not defined or is empty', () => {
		expect(resolvePrPreamble('main')).toBeUndefined()
		process.env.PR_PREAMBLE = '   '
		expect(resolvePrPreamble('main')).toBeUndefined()
	})

	it('returns the literal string if it is not a valid JSON (compatibility fallback)', () => {
		const plainText = '📦 Test the latest changes'
		process.env.PR_PREAMBLE = plainText
		expect(resolvePrPreamble('main')).toBe(plainText)
		expect(resolvePrPreamble('v3.x')).toBe(plainText)
	})

	it('returns the literal string if the JSON is malformed', () => {
		const brokenJson = '{ "main": "broken JSON"' // Missing closing brace
		process.env.PR_PREAMBLE = brokenJson
		expect(resolvePrPreamble('main')).toBe(brokenJson)
	})

	it('resolves the exact branch preamble when a valid JSON is provided', () => {
		process.env.PR_PREAMBLE = JSON.stringify({
			'main': '📦 [View pkg-pr-new for main](...)',
			'v3.x': '📦 [View pkg-pr-new for v3.x](...)',
			'default': '📦 Test the latest changes'
		})
		expect(resolvePrPreamble('v3.x')).toBe('📦 [View pkg-pr-new for v3.x](...)')
	})

	it('resolves the "default" preamble if the branch does not match in the JSON', () => {
		process.env.PR_PREAMBLE = JSON.stringify({
			'main': '📦 [View pkg-pr-new for main](...)',
			'default': '📦 Test the latest changes'
		})
		expect(resolvePrPreamble('feature-branch')).toBe('📦 Test the latest changes')
	})

	it('returns undefined if it is a valid JSON but has no branch match or default', () => {
		process.env.PR_PREAMBLE = JSON.stringify({
			'main': '📦 [View pkg-pr-new for main](...)'
		})
		expect(resolvePrPreamble('feature-branch')).toBeUndefined()
	})

	it('returns the literal string if it is valid JSON but not an object (e.g. primitive or null)', () => {
		// 'null' is valid JSON, but since (parsed !== null) is false, the 'if' is skipped
		process.env.PR_PREAMBLE = 'null'
		// It should fall to the final return of the function (line 1271)
		expect(resolvePrPreamble('main')).toBe('null')

		// Another example: a JSON string literal
		process.env.PR_PREAMBLE = '"just a plain string"'
		expect(resolvePrPreamble('main')).toBe('"just a plain string"')
	})
})
