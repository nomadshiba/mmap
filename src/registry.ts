// Cross-worker sharing of Mmap handles for the same file.
//
// Within a single isolate, `mmap.ts` already dedupes `open()`/`openSync()` calls for the same
// (absolute path, key) via a module-level `Map` — that's automatic, no setup required. But a Deno
// `Worker` is a *separate* V8 isolate with its own copy of every module's state, so a plain JS `Map`
// in one isolate is invisible to another. The only thing that's actually shared between isolates in
// the same OS process is raw memory: a `SharedArrayBuffer`, and the mapped file's pages themselves
// (any thread can reconstruct a view over an existing mapping's address — see `mmap.ts`'s use of
// `Deno.UnsafePointer.create`).
//
// `MmapRegistry` is a tiny fixed-capacity hash table living in a `SharedArrayBuffer`, guarded by a
// spinlock (`Atomics.compareExchange`), that lets independent isolates agree on "who already mapped
// this (path, key)" and hand back that exact pointer/length instead of mapping the file again.
//
// Usage:
// ```ts
// // main thread
// const registry = MmapRegistry.create();
// worker.postMessage({ registryBuffer: registry.buffer });
//
// // inside the worker
// const registry = MmapRegistry.from(event.data.registryBuffer);
// using f = await Mmap.open("shared.bin", { registry });
// ```

/** Numeric fields describing an established mapping, as stored in a registry slot. */
export type SharedMappingEntry = {
	/** The mapping's base address, as returned by `Deno.UnsafePointer.value`. */
	pointer: bigint;
	/** Total length actually passed to `mmap()`/`MapViewOfFile` (post alignment). */
	mapLength: bigint;
	/** Bytes between the aligned base and the requested `offset`. */
	delta: bigint;
	/** The requested (unaligned) `offset`, for compatibility checks. */
	offset: bigint;
	/** The mapping's view length in bytes (`Mmap.length`). */
	length: bigint;
	/** Whether the mapping is read-write. */
	writable: boolean;
};

const textEncoder = new TextEncoder();

// --- slot layout ---------------------------------------------------------
// [ state:i32 | refCount:i32 | writable:i32 | keyLen:i32 ]  <- header, 16 bytes
// [ pointer:u64 | mapLength:u64 | delta:u64 | offset:u64 | length:u64 ]  <- 40 bytes
// [ key bytes ]  <- MAX_KEY_BYTES, UTF-8 of `${absolutePath}\0${key ?? ""}`
const MAX_KEY_BYTES = 256;
const HEADER_BYTES = 16;
const NUMERIC_BYTES = 40;
const SLOT_BYTES = HEADER_BYTES + NUMERIC_BYTES + MAX_KEY_BYTES;

const TABLE_HEADER_BYTES = 8; // [ lock:i32 | capacity:i32 ]

const STATE_EMPTY = 0;
const STATE_OCCUPIED = 1;

/** The result of {@linkcode MmapRegistry.acquire}. */
export type AcquireResult =
	| { hit: true; entry: SharedMappingEntry }
	| { hit: false; slot: number };

/**
 * A fixed-capacity registry of established mappings, backed by a `SharedArrayBuffer` so it can be
 * shared verbatim (not copied) with other {@linkcode Worker}s via `postMessage`. Pass a `MmapRegistry`
 * as `{ registry }` to {@linkcode Mmap.open}/{@linkcode Mmap.openSync} to opt a call into cross-worker
 * pointer sharing for the same absolute path + `key`.
 */
export class MmapRegistry {
	/** The underlying buffer — send this (not the `MmapRegistry` instance) to other workers. */
	readonly buffer: SharedArrayBuffer;
	readonly #lock: Int32Array;
	readonly #view: DataView;
	readonly #capacity: number;

	private constructor(buffer: SharedArrayBuffer) {
		this.buffer = buffer;
		this.#lock = new Int32Array(buffer, 0, 1);
		this.#view = new DataView(buffer);
		this.#capacity = this.#view.getInt32(4);
	}

	/**
	 * Create a brand-new, empty registry. Share `.buffer` with other workers (e.g. via
	 * `worker.postMessage({ buf: registry.buffer })`) and reconstruct it there with
	 * {@linkcode MmapRegistry.from}.
	 */
	static create(options: { capacity?: number } = {}): MmapRegistry {
		const capacity = options.capacity ?? 64;
		if (!Number.isInteger(capacity) || capacity <= 0) {
			throw new RangeError("capacity must be a positive integer");
		}
		const buffer = new SharedArrayBuffer(TABLE_HEADER_BYTES + capacity * SLOT_BYTES);
		new DataView(buffer).setInt32(4, capacity);
		return new MmapRegistry(buffer);
	}

	/** Reconstruct a registry handle from a `SharedArrayBuffer` received from another worker. */
	static from(buffer: SharedArrayBuffer): MmapRegistry {
		return new MmapRegistry(buffer);
	}

	#slotOffset(i: number): number {
		return TABLE_HEADER_BYTES + i * SLOT_BYTES;
	}

	#withLock<T>(fn: () => T): T {
		while (Atomics.compareExchange(this.#lock, 0, 0, 1) !== 0) {
			// Busy-wait: critical sections here are a handful of reads/writes, never blocking I/O.
		}
		try {
			return fn();
		} finally {
			Atomics.store(this.#lock, 0, 0);
		}
	}

	#encodeKey(mapKey: string): Uint8Array {
		const bytes = textEncoder.encode(mapKey);
		if (bytes.byteLength > MAX_KEY_BYTES) {
			throw new RangeError(
				`MmapRegistry: mapping key is ${bytes.byteLength} bytes (path + \`key\` option), exceeds the limit of ${MAX_KEY_BYTES} bytes`,
			);
		}
		return bytes;
	}

	#keyBytesAt(slot: number, keyLen: number): Uint8Array {
		const off = this.#slotOffset(slot) + HEADER_BYTES + NUMERIC_BYTES;
		return new Uint8Array(this.buffer, off, keyLen);
	}

	#keyMatches(slot: number, keyBytes: Uint8Array): boolean {
		const off = this.#slotOffset(slot);
		if (this.#view.getInt32(off + 12) !== keyBytes.byteLength) return false;
		const existing = this.#keyBytesAt(slot, keyBytes.byteLength);
		for (let i = 0; i < keyBytes.byteLength; i++) {
			if (existing[i] !== keyBytes[i]) return false;
		}
		return true;
	}

	#readEntry(slot: number): SharedMappingEntry {
		const off = this.#slotOffset(slot);
		const numOff = off + HEADER_BYTES;
		return {
			pointer: this.#view.getBigUint64(numOff),
			mapLength: this.#view.getBigUint64(numOff + 8),
			delta: this.#view.getBigUint64(numOff + 16),
			offset: this.#view.getBigUint64(numOff + 24),
			length: this.#view.getBigUint64(numOff + 32),
			writable: this.#view.getInt32(off + 8) !== 0,
		};
	}

	/**
	 * Look up `mapKey` (`` `${absolutePath}\0${key ?? ""}` ``):
	 * - **Hit** — another mapping already exists; its refcount is bumped and its numeric fields are
	 *   returned so the caller can reconstruct a view over the *same* memory without mapping the file again.
	 * - **Miss** — a slot is reserved (refcount 1) for the caller, who is now responsible for actually
	 *   mapping the file and calling {@linkcode MmapRegistry.publish} (or {@linkcode MmapRegistry.abort}
	 *   on failure).
	 */
	acquire(mapKey: string): AcquireResult {
		const keyBytes = this.#encodeKey(mapKey);
		return this.#withLock(() => {
			let freeSlot = -1;
			for (let i = 0; i < this.#capacity; i++) {
				const state = this.#view.getInt32(this.#slotOffset(i));
				if (state === STATE_EMPTY) {
					if (freeSlot === -1) freeSlot = i;
					continue;
				}
				if (!this.#keyMatches(i, keyBytes)) continue;

				const refOff = this.#slotOffset(i) + 4;
				this.#view.setInt32(refOff, this.#view.getInt32(refOff) + 1);
				return { hit: true, entry: this.#readEntry(i) } as const;
			}

			if (freeSlot === -1) {
				throw new RangeError(
					`MmapRegistry is full (capacity ${this.#capacity}); pass a larger \`capacity\` to MmapRegistry.create(), or close unused mappings`,
				);
			}

			// Reserve the slot now (state + refcount + key) so a concurrent acquire() for the same
			// key — while we're still mapping the file — sees a hit instead of also reserving a new slot.
			const off = this.#slotOffset(freeSlot);
			this.#view.setInt32(off, STATE_OCCUPIED);
			this.#view.setInt32(off + 4, 1);
			this.#view.setInt32(off + 12, keyBytes.byteLength);
			new Uint8Array(this.buffer, off + HEADER_BYTES + NUMERIC_BYTES, keyBytes.byteLength).set(keyBytes);
			return { hit: false, slot: freeSlot } as const;
		});
	}

	/** Fill in the numeric fields for a slot reserved by an {@linkcode MmapRegistry.acquire} miss. */
	publish(slot: number, entry: SharedMappingEntry): void {
		this.#withLock(() => {
			const off = this.#slotOffset(slot);
			this.#view.setInt32(off + 8, entry.writable ? 1 : 0);
			const numOff = off + HEADER_BYTES;
			this.#view.setBigUint64(numOff, entry.pointer);
			this.#view.setBigUint64(numOff + 8, entry.mapLength);
			this.#view.setBigUint64(numOff + 16, entry.delta);
			this.#view.setBigUint64(numOff + 24, entry.offset);
			this.#view.setBigUint64(numOff + 32, entry.length);
		});
	}

	/** Release a slot reserved by an {@linkcode MmapRegistry.acquire} miss without publishing (e.g. the map call failed). */
	abort(slot: number): void {
		this.#withLock(() => {
			this.#view.setInt32(this.#slotOffset(slot), STATE_EMPTY);
		});
	}

	/**
	 * Decrement the refcount for `mapKey`. Returns `true` if this was the last reference across every
	 * worker sharing this registry — the caller must now actually `munmap()`/`UnmapViewOfFile` it —
	 * or `false` if other workers still hold it (the caller must *not* unmap).
	 */
	release(mapKey: string): boolean {
		const keyBytes = this.#encodeKey(mapKey);
		return this.#withLock(() => {
			for (let i = 0; i < this.#capacity; i++) {
				if (this.#view.getInt32(this.#slotOffset(i)) === STATE_EMPTY) continue;
				if (!this.#keyMatches(i, keyBytes)) continue;

				const refOff = this.#slotOffset(i) + 4;
				const refCount = this.#view.getInt32(refOff) - 1;
				if (refCount <= 0) {
					this.#view.setInt32(this.#slotOffset(i), STATE_EMPTY);
					return true;
				}
				this.#view.setInt32(refOff, refCount);
				return false;
			}
			throw new Error(`MmapRegistry: release() called for a key that isn't registered: ${mapKey}`);
		});
	}
}
