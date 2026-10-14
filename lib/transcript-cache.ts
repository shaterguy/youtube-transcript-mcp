/** Legacy Next v3 cache is retained in old releases for rollback.
 * The synchronous acquisition entry was removed in 0.3.6-dev3.
 * startPersistentTranscriptionJob owns the normalized durable transcript cache.
 * Old entries lack language metadata; never guess a language or reuse raw keys.
 */
export const TRANSCRIPT_CACHE_VERSION = "durable-v3";
