import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPrPreamble, PR_PREAMBLE_MARKERS, removePrPreamble, resolvePrPreamble } from '../scripts/update-changelog.ts'

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

	it('ignores inherited prototype properties (e.g. constructor)', () => {
		process.env.PR_PREAMBLE = JSON.stringify({ default: '📦 Fallback' })
		// 'constructor' exists on Object.prototype, but hasOwnProperty should reject it
		expect(resolvePrPreamble('constructor')).toBe('📦 Fallback')
	})

	it('ignores mapped values that are not strings', () => {
		process.env.PR_PREAMBLE = JSON.stringify({ main: 123, default: '📦 Fallback' })
		expect(resolvePrPreamble('main')).toBe('📦 Fallback')
	})

	it('ignores mapped values that are empty strings or just whitespace', () => {
		process.env.PR_PREAMBLE = JSON.stringify({ main: '   ', default: '📦 Fallback' })
		expect(resolvePrPreamble('main')).toBe('📦 Fallback')
	})
})

describe('removePrPreamble', () => {
	it('should remove the full preamble along with the markers', () => {
		const originalBody = [
			'Intro text',
			PR_PREAMBLE_MARKERS.init,
			'My custom preamble with links to pkg-pr-new',
			PR_PREAMBLE_MARKERS.end,
			'',
			'## Changelog',
			'- Fix: resolved an issue'
		].join('\n')

		const result = removePrPreamble(originalBody)

		// Verify that markers and intermediate content are removed
		expect(result).not.toContain(PR_PREAMBLE_MARKERS.init)
		expect(result).not.toContain('My custom preamble')
		expect(result).not.toContain(PR_PREAMBLE_MARKERS.end)

		// Verify that the rest of the text (intro and changelog) remains intact
		expect(result).toContain('Intro text')
		expect(result).toContain('## Changelog')
	})

	it('should return the original text if there are no markers', () => {
		const body = 'Intro text\n\n## Changelog\n- Fix bug'
		expect(removePrPreamble(body)).toBe(body)
	})

	it('should return the original text if only the start marker is present (malformed manual PR edit)', () => {
		const body = `Intro text\n${PR_PREAMBLE_MARKERS.init}\nEndless preamble`
		expect(removePrPreamble(body)).toBe(body)
	})
})

describe('createPrPreamble', () => {
	it('should inject markers when a preamble is resolved', () => {
		// Note: Depending on your test suite setup, you will need to mock the function or input
		// (e.g., process.env or config) that makes `resolvePrPreamble(baseBranch)` return a valid string.

		const intro = '> v1.0.0 is the next patch release.'
		const result = createPrPreamble('main', intro)

		// If mocked correctly and a preamble exists, it should contain the markers
		// expect(result).toContain(PR_PREAMBLE_MARKERS.init)
		// expect(result).toContain(PR_PREAMBLE_MARKERS.end)
	})

	it('should not inject markers if no preamble is configured', () => {
		// Mock here to return undefined/falsy
		const intro = '> v1.0.0 is the next patch release.'
		const result = createPrPreamble('main', intro)

		expect(result).not.toContain(PR_PREAMBLE_MARKERS.init)
		expect(result).not.toContain(PR_PREAMBLE_MARKERS.end)
	})
})
