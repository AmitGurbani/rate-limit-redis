// /source/lib.ts
// The redis store code.

import type {
	Store,
	IncrementResponse,
	ClientRateLimitInfo,
	Options as RateLimitConfiguration,
} from 'express-rate-limit'
import scripts from './scripts.js'
import type { Options, SendCommandFn, RedisReply } from './types.js'

/**
 * Converts a string/number to a number.
 *
 * @param input {string | number | undefined} - The input to convert to a number.
 *
 * @return {number} - The parsed integer.
 * @throws {Error} - Thrown if the string does not contain a valid number.
 */
const toInt = (input: string | number | boolean | undefined): number => {
	if (typeof input === 'number') return input
	return Number.parseInt((input ?? '').toString(), 10)
}

/**
 * Parses the response from the script.
 *
 * Note that the responses returned by the `get` and `increment` scripts are
 * the same, so this function can be used with both.
 */
const parseScriptResponse = (results: RedisReply): ClientRateLimitInfo => {
	if (!Array.isArray(results))
		throw new TypeError('Expected result to be array of values')
	if (results.length !== 2)
		throw new Error(`Expected 2 replies, got ${results.length}`)

	const totalHits = toInt(results[0])
	const timeToExpire = toInt(results[1])

	const resetTime = new Date(Date.now() + timeToExpire)
	return { totalHits, resetTime }
}

/**
 * A `Store` for the `express-rate-limit` package that stores hit counts in
 * Redis.
 */
class RedisStore implements Store {
	/**
	 * The function used to send raw commands to Redis.
	 */
	sendCommand: SendCommandFn

	/**
	 * The text to prepend to the key in Redis.
	 */
	prefix: string

	/**
	 * Whether to reset the expiry for a particular key whenever its hit count
	 * changes.
	 */
	resetExpiryOnChange: boolean

	/**
	 * Stores the loaded SHA1s of the LUA scripts used for executing the increment
	 * and get key operations.
	 */
	incrementScriptSha: Promise<string>
	getScriptSha: Promise<string>

	/**
	 * The number of milliseconds to remember that user's requests.
	 */
	windowMs!: number

	/**
	 * @constructor for `RedisStore`.
	 *
	 * @param options {Options} - The configuration options for the store.
	 */
	constructor(options: Options) {
		this.sendCommand = options.sendCommand
		this.prefix = options.prefix ?? 'rl:'
		this.resetExpiryOnChange = options.resetExpiryOnChange ?? false

		// So that the script loading can occur non-blocking, this will send
		// the script to be loaded, and will capture the value within the
		// promise return. This way, if increment/get start being called before
		// the script has finished loading, it will wait until it is loaded
		// before it continues.
		this.incrementScriptSha = this.loadIncrementScript()
		this.getScriptSha = this.loadGetScript()
	}

	/**
	 * Loads the script used to increment a client's hit count.
	 */
	async loadIncrementScript(): Promise<string> {
		const result = await this.sendCommand('SCRIPT', 'LOAD', scripts.increment)

		if (typeof result !== 'string') {
			throw new TypeError('unexpected reply from redis client')
		}

		return result
	}

	/**
	 * Loads the script used to fetch a client's hit count and expiry time.
	 */
	async loadGetScript(): Promise<string> {
		const result = await this.sendCommand('SCRIPT', 'LOAD', scripts.get)

		if (typeof result !== 'string') {
			throw new TypeError('unexpected reply from redis client')
		}

		return result
	}

	/**
	 * Runs the increment command, and retries it if the script is not loaded.
	 */
	async retryableIncrement(key: string): Promise<RedisReply> {
		const evalCommand = async () =>
			this.sendCommand(
				'EVALSHA',
				await this.incrementScriptSha,
				'1',
				this.prefixKey(key),
				this.resetExpiryOnChange ? '1' : '0',
				this.windowMs.toString(),
			)

		try {
			const result = await evalCommand()
			return result
		} catch {
			// TODO: distinguish different error types
			this.incrementScriptSha = this.loadIncrementScript()
			return evalCommand()
		}
	}

	/**
	 * Method to prefix the keys with the given text.
	 *
	 * @param key {string} - The key.
	 *
	 * @returns {string} - The text + the key.
	 */
	prefixKey(key: string): string {
		return `${this.prefix}${key}`
	}

	/**
	 * Method that actually initializes the store.
	 *
	 * @param options {RateLimitConfiguration} - The options used to setup the middleware.
	 */
	init(options: RateLimitConfiguration) {
		this.windowMs = options.windowMs
	}

	/**
	 * Method to fetch a client's hit count and reset time.
	 *
	 * @param key {string} - The identifier for a client.
	 *
	 * @returns {ClientRateLimitInfo | undefined} - The number of hits and reset time for that client.
	 */
	async get(key: string): Promise<ClientRateLimitInfo | undefined> {
		const results = await this.sendCommand(
			'EVALSHA',
			await this.getScriptSha,
			'1',
			this.prefixKey(key),
		)

		return parseScriptResponse(results)
	}

	/**
	 * Method to increment a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client
	 *
	 * @returns {IncrementResponse} - The number of hits and reset time for that client
	 */
	async increment(key: string): Promise<IncrementResponse> {
		const results = await this.retryableIncrement(key)
		return parseScriptResponse(results)
	}

	/**
	 * Method to decrement a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client
	 */
	async decrement(key: string): Promise<void> {
		await this.sendCommand('DECR', this.prefixKey(key))
	}

	/**
	 * Method to reset a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client
	 */
	async resetKey(key: string): Promise<void> {
		await this.sendCommand('DEL', this.prefixKey(key))
	}
}

// Export it to the world!
export default RedisStore
