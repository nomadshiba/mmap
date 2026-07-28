import { granularity, nativeAdvise, nativeMap, nativeSync, nativeUnmap, pageSize } from "./ffi.ts";
import type { Advice } from "./constants.ts";
import type { MmapRegistry } from "./registry.ts";

/** Options for {@linkcode Mmap.open}. */
export type MmapOptions = {
	/**
	 * Map the file read-write (`MAP_SHARED`). Requires `--allow-write`.
	 * Default `false` (read-only).
	 */
	write?: boolean;
	/**
	 * Byte offset into the file at which the mapping starts. May be unaligned —
	 * alignment to the OS granularity is handled internally. Default `0`.
	 */
	offset?: number | bigint;
	/**
	 * Number of bytes to map. Default: the file size minus {@linkcode offset}.
	 */
	length?: number | bigint;
	/**
	 * Ensure the file is at least this many bytes, creating or extending it as
	 * needed. Required when mapping a brand-new file. Only valid together with
	 * `write: true` — throws otherwise.
	 */
	size?: number | bigint;
	/**
	 * Distinguishes this mapping from others of the *same file* that should
	 * **not** share a pointer. By default (no `key`), every `open`/`openSync`
	 * call for the same absolute file path — with matching `write`/`offset`/
	 * `length` — hands back the *same* underlying mapping (same `pointer`,
	 * same `bytes`/`view`, refcounted) instead of mapping the file again.
	 * Passing a distinct `key` opts a call out of that sharing, giving it an
	 * independent mapping of the same file.
	 *
	 * This sharing is automatic and requires no setup *within a single
	 * isolate/thread*. To share the same pointer across `Worker` threads too,
	 * also pass {@linkcode registry}.
	 */
	key?: string;
	/**
	 * A {@linkcode MmapRegistry} to additionally coordinate sharing *across*
	 * `Worker` threads (each Worker is a separate isolate, so the default,
	 * in-module sharing keyed on path + `key` alone is invisible between
	 * them). Create one with `MmapRegistry.create()`, send its `.buffer` to
	 * each worker, and reconstruct it there with `MmapRegistry.from(buffer)`.
	 */
	registry?: MmapRegistry;
};

/** The state shared by every {@linkcode Mmap} instance backed by the same underlying mapping. */
type MappingHandle = {
	base: Deno.PointerObject;
	mapLength: bigint;
	delta: bigint;
	offset: bigint;
	length: bigint;
	bytes: Uint8Array;
	view: DataView | null;
	writable: boolean;
	/** Number of live {@linkcode Mmap} instances (in *this* isolate) sharing this handle. */
	refCount: number;
	/** `` `${absolutePath}\0${key ?? ""}` `` — the dedup key used by {@linkcode localCache} and `registry`. */
	mapKey: string;
	/** Set if this handle was established via a {@linkcode MmapRegistry}, for cross-worker refcounting. */
	registry: MmapRegistry | null;
};

// Per-isolate dedup cache: `Mmap.open`/`openSync` calls for the same (absolute path, key) within one
// thread reuse the same handle for free, with no `registry` required. Separate Worker threads each
// get their own copy of this module (and thus this Map) — see `MmapOptions.registry` for that case.
const localCache = new Map<string, MappingHandle>();

function alignDown(value: bigint, alignment: bigint): bigint {
	return (value / alignment) * alignment;
}

/** The largest file size we're willing to hand to `Deno.truncate(Sync)`, which only accepts `number`. */
function toTruncateLen(need: bigint): number {
	if (need > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`size ${need} exceeds Number.MAX_SAFE_INTEGER; cannot truncate to it`);
	}
	return Number(need);
}

/** The largest size the mapping needs the file to be, per `size`/`offset`/`length`. */
function neededSize(offset: bigint, opts: MmapOptions): bigint {
	let need = opts.size !== undefined ? BigInt(opts.size) : 0n;
	if (opts.length !== undefined) {
		const end = offset + BigInt(opts.length);
		if (end > need) need = end;
	}
	return need;
}

function ensureFileSync(
	path: string,
	write: boolean,
	opts: MmapOptions,
): bigint {
	if (!write) {
		if (opts.size !== undefined) {
			throw new TypeError("the `size` option requires `write: true`");
		}
		return BigInt(Deno.statSync(path).size);
	}

	// Create if absent, then extend to the largest size the mapping needs.
	Deno.openSync(path, { read: true, write: true, create: true }).close();
	let size = BigInt(Deno.statSync(path).size);

	const offset = BigInt(opts.offset ?? 0);
	const need = neededSize(offset, opts);
	if (need > size) {
		Deno.truncateSync(path, toTruncateLen(need));
		size = need;
	}
	return size;
}

async function ensureFile(
	path: string,
	write: boolean,
	opts: MmapOptions,
): Promise<bigint> {
	if (!write) {
		if (opts.size !== undefined) {
			throw new TypeError("the `size` option requires `write: true`");
		}
		const stat = await Deno.stat(path);
		return BigInt(stat.size);
	}

	// Create if absent, then extend to the largest size the mapping needs.
	{
		using _ = await Deno.open(path, { read: true, write: true, create: true });
	}
	const stat = await Deno.stat(path);
	let size = BigInt(stat.size);

	const offset = BigInt(opts.offset ?? 0);
	const need = neededSize(offset, opts);
	if (need > size) {
		await Deno.truncate(path, toTruncateLen(need));
		size = need;
	}
	return size;
}

/**
 * A live, zero-copy memory mapping of a file.
 *
 * The mapping stays valid until {@linkcode Mmap.close} is called (or the
 * instance is disposed by a `using` declaration). After that, the memory is
 * unmapped: **touching {@linkcode Mmap.bytes} or {@linkcode Mmap.view} past
 * that point is a use-after-free and will crash the process with a segfault,
 * not throw a catchable error.** Never let a captured view outlive the mapping.
 *
 * Two more crash risks beyond `close()`, neither of which is a catchable JS
 * error:
 * - **Writing through a read-only mapping** (`writable === false`) touches a
 *   `PROT_READ`-only page and segfaults immediately.
 * - **Another process truncating the file out from under an active mapping**
 *   raises `SIGBUS` the next time a now-invalid page is touched. This applies
 *   to any mapping of that file, including read-only ones.
 */
export class Mmap {
	#handle: MappingHandle | null;

	/** Whether the mapping was opened read-write. */
	readonly writable: boolean;

	/** @internal — use {@linkcode Mmap.openSync} or {@linkcode Mmap.open} to construct. */
	private constructor(handle: MappingHandle) {
		this.#handle = handle;
		this.writable = handle.writable;
	}

	/**
	 * Memory-map a file and return a zero-copy {@linkcode Mmap} handle.
	 *
	 * By default, mapping the same absolute file path again (with matching
	 * `write`/`offset`/`length`) — whether from a fresh call or one still open
	 * — hands back the *same* pointer instead of mapping the file a second
	 * time; see {@linkcode MmapOptions.key} to opt out, and
	 * {@linkcode MmapOptions.registry} to extend this across `Worker` threads.
	 *
	 * @param path Filesystem path to the file.
	 * @param options See {@linkcode MmapOptions}.
	 *
	 * @example
	 * ```ts
	 * import { Mmap } from "@nomadshiba/mmap";
	 * using f = Mmap.openSync("data.bin");
	 * const first = f.bytes[0];
	 * ```
	 */
	static openSync(path: string, options: MmapOptions = {}): Mmap {
		const write = options.write ?? false;
		const fileSize = ensureFileSync(path, write, options);
		const absolutePath = Deno.realPathSync(path);
		return Mmap.#open(absolutePath, write, fileSize, options);
	}

	/**
	 * Memory-map a file and return a zero-copy {@linkcode Mmap} handle.
	 *
	 * By default, mapping the same absolute file path again (with matching
	 * `write`/`offset`/`length`) — whether from a fresh call or one still open
	 * — hands back the *same* pointer instead of mapping the file a second
	 * time; see {@linkcode MmapOptions.key} to opt out, and
	 * {@linkcode MmapOptions.registry} to extend this across `Worker` threads.
	 *
	 * @param path Filesystem path to the file.
	 * @param options See {@linkcode MmapOptions}.
	 *
	 * @example
	 * ```ts
	 * import { Mmap } from "@nomadshiba/mmap";
	 * using f = await Mmap.open("data.bin");
	 * const first = f.bytes[0];
	 * ```
	 */
	static async open(path: string, options: MmapOptions = {}): Promise<Mmap> {
		const write = options.write ?? false;
		const fileSize = await ensureFile(path, write, options);
		const absolutePath = await Deno.realPath(path);
		return Mmap.#open(absolutePath, write, fileSize, options);
	}

	// Shared tail end of openSync/open — the only difference between them is how
	// `fileSize`/`absolutePath` were obtained (sync vs. async). Resolves an
	// existing handle to share (local cache, then `options.registry`) or maps
	// the file fresh.
	static #open(absolutePath: string, write: boolean, fileSize: bigint, options: MmapOptions): Mmap {
		const offset = BigInt(options.offset ?? 0);
		if (offset < 0n) throw new RangeError("offset must be >= 0");

		const length = options.length !== undefined ? BigInt(options.length) : fileSize - offset;
		if (length <= 0n) {
			throw new RangeError("length must be > 0 (nothing to map)");
		}
		if (!write && offset + length > fileSize) {
			throw new RangeError(`mapping [${offset}, ${offset + length}) exceeds file size ${fileSize}`);
		}

		const mapKey = `${absolutePath}\0${options.key ?? ""}`;

		const cached = localCache.get(mapKey);
		if (cached) {
			Mmap.#assertCompatible(mapKey, cached, write, offset, length);
			cached.refCount++;
			return new Mmap(cached);
		}

		const registry = options.registry ?? null;
		if (!registry) {
			const handle = Mmap.#map(absolutePath, mapKey, write, offset, length, null);
			localCache.set(mapKey, handle);
			return new Mmap(handle);
		}

		const acquired = registry.acquire(mapKey);
		if (!acquired.hit) {
			let handle: MappingHandle;
			try {
				handle = Mmap.#map(absolutePath, mapKey, write, offset, length, registry);
			} catch (e) {
				registry.abort(acquired.slot);
				throw e;
			}
			registry.publish(acquired.slot, {
				pointer: Deno.UnsafePointer.value(handle.base),
				mapLength: handle.mapLength,
				delta: handle.delta,
				offset: handle.offset,
				length: handle.length,
				writable: write,
			});
			localCache.set(mapKey, handle);
			return new Mmap(handle);
		}

		const { entry } = acquired;
		if (entry.writable !== write || entry.offset !== offset || entry.length !== length) {
			registry.release(mapKey); // undo the refcount bump acquire() already made
			throw Mmap.#incompatibleError(mapKey);
		}
		const base = Deno.UnsafePointer.create(entry.pointer) as Deno.PointerObject;
		const buffer = Deno.UnsafePointerView.getArrayBuffer(base, Number(entry.mapLength));
		const bytes = new Uint8Array(buffer, Number(entry.delta), Number(entry.length));
		const handle: MappingHandle = {
			base,
			mapLength: entry.mapLength,
			delta: entry.delta,
			offset,
			length,
			bytes,
			view: null,
			writable: write,
			refCount: 1,
			mapKey,
			registry,
		};
		localCache.set(mapKey, handle);
		return new Mmap(handle);
	}

	// Actually calls mmap()/MapViewOfFile — only reached on a cache/registry miss.
	static #map(
		absolutePath: string,
		mapKey: string,
		write: boolean,
		offset: bigint,
		length: bigint,
		registry: MmapRegistry | null,
	): MappingHandle {
		// Align the file offset down to the OS granularity; carry the remainder into
		// the view's byteOffset so the returned bytes start exactly at `offset`.
		const g = BigInt(granularity);
		const alignedOffset = alignDown(offset, g);
		const delta = offset - alignedOffset;
		const mapLength = length + delta;

		const base = nativeMap(absolutePath, alignedOffset, mapLength, write);
		const buffer = Deno.UnsafePointerView.getArrayBuffer(base, Number(mapLength));
		const bytes = new Uint8Array(buffer, Number(delta), Number(length));

		return { base, mapLength, delta, offset, length, bytes, view: null, writable: write, refCount: 1, mapKey, registry };
	}

	static #incompatibleError(mapKey: string): Error {
		const [path] = mapKey.split("\0");
		return new Error(
			`Mmap: ${path} is already mapped with different write/offset/length options. ` +
				`Pass a distinct \`key\` to create an independent mapping of the same file.`,
		);
	}

	static #assertCompatible(mapKey: string, handle: MappingHandle, write: boolean, offset: bigint, length: bigint): void {
		if (handle.writable !== write || handle.offset !== offset || handle.length !== length) {
			throw Mmap.#incompatibleError(mapKey);
		}
	}

	/**
	 * The mapped bytes as a zero-copy {@linkcode Uint8Array}. Reads and writes go
	 * straight to the file's pages. Invalid once {@linkcode Mmap.close} runs.
	 */
	get bytes(): Uint8Array {
		if (!this.#handle) throw new Error("Mmap is closed");
		return this.#handle.bytes;
	}

	/** Length of the mapped view, in bytes. */
	get length(): number {
		return this.bytes.length;
	}

	/** A {@linkcode DataView} over the same zero-copy memory. */
	get view(): DataView {
		const handle = this.#handle;
		if (!handle) throw new Error("Mmap is closed");
		if (handle.view) return handle.view;
		const b = handle.bytes;
		return handle.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	}

	/**
	 * A pointer to the first byte of the view, for handing the mapped memory to
	 * other FFI calls. Shared mappings (see {@linkcode MmapOptions.key}) return
	 * the identical pointer value for every handle sharing them.
	 */
	get pointer(): Deno.PointerValue {
		if (!this.#handle) throw new Error("Mmap is closed");
		return Deno.UnsafePointer.offset(this.#handle.base, Number(this.#handle.delta));
	}

	/**
	 * Advise the kernel about the access pattern for a sub-range (`offset` and
	 * `length` are relative to this view). No-op on Windows.
	 */
	advise(advice: Advice, offset = 0, length?: number): void {
		const [ptr, len] = this.#alignedRange(offset, length);
		nativeAdvise(ptr, len, advice);
	}

	/**
	 * Flush modified pages in a sub-range to disk (`msync(MS_SYNC)` on POSIX,
	 * `FlushViewOfFile` on Windows). `offset`/`length` are relative to this view.
	 *
	 * This is a *blocking* FFI call — for large dirty ranges it can stall the
	 * event loop for the duration of the disk write.
	 */
	flush(offset = 0, length?: number): void {
		const [ptr, len] = this.#alignedRange(offset, length);
		nativeSync(ptr, len);
	}

	// Translate a view-relative range into a page-aligned (pointer, length),
	// since msync/madvise require a page-aligned start address on POSIX.
	#alignedRange(offset: number, length?: number): [Deno.PointerValue, bigint] {
		const handle = this.#handle;
		if (!handle) throw new Error("Mmap is closed");
		const viewLen = this.length;
		if (offset < 0 || offset > viewLen) {
			throw new RangeError("offset out of bounds");
		}
		const len = length ?? viewLen - offset;
		if (len < 0 || offset + len > viewLen) {
			throw new RangeError("length out of bounds");
		}
		const abs = handle.delta + BigInt(offset); // position within the mapping
		const start = alignDown(abs, BigInt(pageSize));
		const alignedLen = (abs - start) + BigInt(len);
		return [Deno.UnsafePointer.offset(handle.base, Number(start)), alignedLen];
	}

	/**
	 * Release this handle's reference to the mapping. Idempotent.
	 *
	 * If other {@linkcode Mmap} handles still share the same underlying
	 * mapping (see {@linkcode MmapOptions.key}) — in this isolate, or in
	 * another `Worker` via {@linkcode MmapOptions.registry} — the memory
	 * stays mapped for them and only this handle's `bytes`/`view` become
	 * invalid. It's only actually unmapped once every sharing handle,
	 * everywhere, has called `close()`. See the class-level warning.
	 */
	close(): void {
		const handle = this.#handle;
		if (!handle) return;
		this.#handle = null;

		handle.refCount--;
		if (handle.refCount > 0) return;

		localCache.delete(handle.mapKey);

		if (handle.registry) {
			// Other workers may still hold this mapping — only unmap once the registry
			// confirms we were the last reference anywhere, not just in this isolate.
			if (!handle.registry.release(handle.mapKey)) return;
		}
		nativeUnmap(handle.base, handle.mapLength);
	}

	/** Disposes the mapping, enabling `using` declarations. */
	[Symbol.dispose](): void {
		this.close();
	}
}
