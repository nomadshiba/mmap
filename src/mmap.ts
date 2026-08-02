import { granularity, nativeAdvise, nativeMap, nativeSync, nativeUnmap, pageSize } from "./ffi.ts";
import type { Advice } from "./constants.ts";

/** Options for {@linkcode Mmap.open}. */
export type MmapOptions = {
	/**
	 * Map the file read-write (`MAP_SHARED`). Requires `--allow-write`.
	 * Default `false` (read-only).
	 */
	write?: boolean;
	/**
	 * Byte offset into the file at which the mapping starts. May be unaligned —
	 * alignment to the OS granularity is handled internally, and the resulting view still starts
	 * exactly here. Default `0`.
	 */
	byteOffset?: number;
	/**
	 * How many bytes to map, starting at {@linkcode MmapOptions.byteOffset} — this becomes
	 * {@linkcode Mmap.length}. Default: the rest of the file (after applying
	 * {@linkcode MmapOptions.ensureFileSize}, if given).
	 */
	length?: number;
	/**
	 * Ensure the file is at least this many bytes, creating or extending it as
	 * needed. Required when mapping a brand-new file. Only valid together with
	 * `write: true` — throws otherwise.
	 */
	ensureFileSize?: number;
};

function alignDown(value: bigint, alignment: bigint): bigint {
	return (value / alignment) * alignment;
}

function ensureFileSync(path: string, size: number): number {
	const file = Deno.openSync(path, { read: true, write: true, create: true });
	const stat = file.statSync();
	file.close();
	if (size > stat.size) {
		Deno.truncateSync(path, size);
		return size;
	}
	return stat.size;
}

async function ensureFile(path: string, size: number): Promise<number> {
	const file = await Deno.open(path, { read: true, write: true, create: true });
	const stat = await file.stat();
	file.close();
	if (size > stat.size) {
		await Deno.truncate(path, size);
		return size;
	}
	return stat.size;
}

/**
 * A live, zero-copy memory mapping of a file.
 *
 * {@linkcode Mmap.bytes}, {@linkcode Mmap.view} and {@linkcode Mmap.buffer} each build a *fresh*
 * object per call, all over the same memory. Nothing is cached, so grab one and reuse it within a
 * scope instead of calling per byte in a loop.
 *
 * Every {@linkcode Mmap.open}/{@linkcode Mmap.openSync} call maps the file independently — no
 * sharing or deduplication between calls, even for the same path. Two mappings of one file get two
 * pointers, but both are `MAP_SHARED` views of the same page cache, so they are *the same physical
 * memory*: a store through one is visible through the other immediately, with no
 * {@linkcode Mmap.flush} in between, and the file's data is held in RAM once regardless of how many
 * times you map it. That holds for read-only mappings, overlapping windows, other processes, and
 * plain `read()`/`write()` on the same file too.
 *
 * ### Sharing one mapping with a `Worker`
 *
 * Transferring a `buffer()` (`postMessage(buf, [buf])`) hands the worker *these pages*, not a copy:
 * the structured-clone transfer moves the backing store, which points at the mapping. Whatever the
 * worker writes, this thread reads back from a fresh `bytes()` — live, in both directions. It is
 * effectively a file-backed `SharedArrayBuffer`.
 *
 * Transferring detaches only that one `ArrayBuffer` object in this isolate. The `Mmap` is untouched,
 * so `bytes()`/`view()`/`buffer()` keep working afterwards.
 *
 * The only rule is lifetime: {@linkcode Mmap.close} unmaps the pages for the *whole process*, so it
 * must not run while any thread still holds a transferred buffer. Have the worker acknowledge that
 * it's done before you close.
 *
 * ### Ways to crash — none of them catchable
 *
 * These are immediate `SIGSEGV`/`SIGBUS`, not JS errors you can `try`/`catch`:
 *
 * - **Use after close.** Touching a `bytes()`/`view()`/`buffer()` result once the mapping is closed
 *   (or its `using` scope ended) is a use-after-free. Includes a buffer you transferred to a worker.
 * - **Writing through a read-only mapping** (`writable === false`) hits a `PROT_READ`-only page.
 * - **Another process truncating the file** below the mapped range raises `SIGBUS` on the next touch
 *   of a now-invalid page — read-only mappings included.
 */
export class Mmap {
	// `#base` doubles as the "closed?" sentinel: nulled by `close()`, checked by every accessor below.
	#base: Deno.PointerValue;
	#mapLength: bigint; // length of the raw, granularity-aligned mapping — what nativeUnmap needs.
	#delta: number; // `pointer` is `#base` shifted forward by this many bytes.

	/** Whether the mapping was opened read-write. */
	readonly writable: boolean;

	/**
	 * Length of the mapped view, in bytes. Unlike {@linkcode Mmap.bytes}/{@linkcode Mmap.view}/
	 * {@linkcode Mmap.buffer}, this is plain data fixed at open time, not a live memory access — so
	 * it stays valid (and correct) even after {@linkcode Mmap.close}.
	 */
	readonly length: number;

	#pointer: Deno.PointerValue;

	/**
	 * A pointer to the first byte of the view, for handing the mapped memory to other FFI calls.
	 * Computed once at open time — like {@linkcode Mmap.length}, reading it doesn't touch memory, so
	 * it's plain data, not a method. Unlike `length` though, {@linkcode Mmap.close} sets this to
	 * `null` (the address is meaningless once unmapped) — that's why it's typed
	 * {@linkcode Deno.PointerValue} rather than the non-nullable `PointerObject`, and callers must
	 * null-check it themselves.
	 */
	get pointer(): Deno.PointerValue {
		return this.#pointer;
	}

	/** @internal — use {@linkcode Mmap.openSync} or {@linkcode Mmap.open} to construct. */
	private constructor(base: Deno.PointerObject, mapLength: bigint, delta: number, length: number, writable: boolean) {
		this.#base = base;
		this.#mapLength = mapLength;
		this.#delta = delta;
		this.length = length;
		this.writable = writable;
		this.#pointer = Deno.UnsafePointer.offset(base, delta);
	}

	/**
	 * Memory-map a file and return a zero-copy {@linkcode Mmap} handle.
	 *
	 * @param path Filesystem path to the file.
	 * @param options See {@linkcode MmapOptions}.
	 *
	 * @example
	 * ```ts
	 * import { Mmap } from "@nomadshiba/mmap";
	 * using f = Mmap.openSync("data.bin");
	 * const bytes = f.bytes();
	 * const first = bytes[0];
	 * ```
	 */
	static openSync(path: string, options: MmapOptions = {}): Mmap {
		const write = options.write ?? false;
		const fileSize = ensureFileSync(path, options.ensureFileSize ?? 0);
		const absolutePath = Deno.realPathSync(path);
		return Mmap.#open(absolutePath, write, fileSize, options);
	}

	/**
	 * Memory-map a file and return a zero-copy {@linkcode Mmap} handle.
	 *
	 * @param path Filesystem path to the file.
	 * @param options See {@linkcode MmapOptions}.
	 *
	 * @example
	 * ```ts
	 * import { Mmap } from "@nomadshiba/mmap";
	 * using f = await Mmap.open("data.bin");
	 * const bytes = f.bytes();
	 * const first = bytes[0];
	 * ```
	 */
	static async open(path: string, options: MmapOptions = {}): Promise<Mmap> {
		const writable = options.write ?? false;
		const fileSize = await ensureFile(path, options.ensureFileSize ?? 0);
		const absolutePath = await Deno.realPath(path);
		return Mmap.#open(absolutePath, writable, fileSize, options);
	}

	// Shared tail end of openSync/open — the only difference between them is how
	// `fileSize`/`absolutePath` were obtained (sync vs. async).
	static #open(absolutePath: string, writable: boolean, fileSize: number, options: MmapOptions): Mmap {
		const size = BigInt(fileSize);

		const byteOffset = BigInt(options.byteOffset ?? 0);
		if (byteOffset < 0n) throw new RangeError("byteOffset must be >= 0");
		if (byteOffset > size) {
			throw new RangeError(`byteOffset ${byteOffset} is past the end of the file (size ${fileSize})`);
		}

		// Default to the rest of the file. `fileSize` already reflects `ensureFileSize`'s growth, if
		// any — `length` doesn't get to grow the file further, it just has to fit.
		const length = options.length !== undefined ? BigInt(options.length) : size - byteOffset;
		if (length <= 0n) throw new RangeError("length must be > 0 (nothing to map)");
		if (byteOffset + length > size) {
			throw new RangeError(`mapping [${byteOffset}, ${byteOffset + length}) exceeds file size ${fileSize}`);
		}

		// Align the offset down to the OS granularity; carry the remainder into the view's own
		// byteOffset so the returned bytes still start exactly at `byteOffset`.
		const delta = byteOffset - alignDown(byteOffset, granularity);
		const alignedStart = byteOffset - delta;
		const mapLength = length + delta;

		const base = nativeMap(absolutePath, alignedStart, mapLength, writable);
		return new Mmap(base, mapLength, Number(delta), Number(length), writable);
	}

	/**
	 * A fresh, zero-copy {@linkcode ArrayBuffer} over the mapped bytes. Reads and writes go straight
	 * to the file's pages. Invalid once {@linkcode Mmap.close} runs.
	 *
	 * Every call returns a *new* object, so transferring one to a `Worker` detaches only that object
	 * and leaves the `Mmap` usable. The worker then shares these pages — see the class docs.
	 */
	buffer(): ArrayBuffer {
		if (!this.#pointer) throw new Error("Mmap is closed");
		return Deno.UnsafePointerView.getArrayBuffer(this.#pointer, this.length);
	}

	/**
	 * A fresh, zero-copy {@linkcode Uint8Array} over the mapped bytes. See {@linkcode Mmap.buffer} —
	 * every call returns an independent `Uint8Array` over its own fresh `ArrayBuffer`.
	 *
	 * @example
	 * ```ts
	 * import { Mmap } from "@nomadshiba/mmap";
	 * using m = await Mmap.open("out.bin", { write: true, ensureFileSize: 256 });
	 * const bytes = m.bytes(); // once, then reuse
	 * for (let i = 0; i < 256; i++) bytes[i] = i;
	 * ```
	 */
	bytes(): Uint8Array {
		return new Uint8Array(this.buffer());
	}

	/**
	 * A fresh {@linkcode DataView} over the mapped bytes. See {@linkcode Mmap.buffer} — every call
	 * returns an independent `DataView` over its own fresh `ArrayBuffer`.
	 */
	view(): DataView {
		return new DataView(this.buffer());
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
	 * This is about **durability only**. You do not need it for anything else to *see* your writes:
	 * other mappings of the file, other threads, other processes, and plain `read()` calls all go
	 * through the same page cache and observe stores immediately. Flush when you want the bytes to
	 * survive a crash or power loss.
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
		if (!this.#base) throw new Error("Mmap is closed");
		const viewLen = this.length;
		if (offset < 0 || offset > viewLen) {
			throw new RangeError("offset out of bounds");
		}
		const len = length ?? viewLen - offset;
		if (len < 0 || offset + len > viewLen) {
			throw new RangeError("length out of bounds");
		}
		const abs = BigInt(this.#delta + offset); // position within the mapping
		const start = alignDown(abs, pageSize);
		const alignedLen = abs - start + BigInt(len);
		return [Deno.UnsafePointer.offset(this.#base, Number(start)), alignedLen];
	}

	/**
	 * Unmap the file and release this handle. Idempotent.
	 *
	 * This `munmap()`s the pages for the whole process. Nothing, on any thread, may still be holding a
	 * {@linkcode Mmap.bytes}/{@linkcode Mmap.view}/{@linkcode Mmap.buffer} result — including a buffer
	 * transferred to a `Worker` — or the next touch segfaults.
	 */
	close(): void {
		const base = this.#base;
		if (!base) return;
		this.#base = null;
		this.#pointer = null;
		nativeUnmap(base, this.#mapLength);
	}

	/** Disposes the mapping, enabling `using` declarations. */
	[Symbol.dispose](): void {
		this.close();
	}
}
