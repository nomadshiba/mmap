import { granularity, nativeAdvise, nativeMap, nativeSync, nativeUnmap, pageSize } from "./ffi.ts";
import type { Advice } from "./constants.ts";

/** Options for {@linkcode Mmap.open}. */
export interface MmapOptions {
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
	 * For write maps only: ensure the file is at least this many bytes, creating
	 * or extending it as needed. Required when mapping a brand-new file.
	 */
	size?: number | bigint;
}

function alignDown(value: bigint, alignment: bigint): bigint {
	return (value / alignment) * alignment;
}

function ensureFileSync(
	path: string,
	write: boolean,
	opts: MmapOptions,
): bigint {
	if (!write) return BigInt(Deno.statSync(path).size);

	// Create if absent, then extend to the largest size the mapping needs.
	Deno.openSync(path, { read: true, write: true, create: true }).close();
	let size = BigInt(Deno.statSync(path).size);

	const offset = BigInt(opts.offset ?? 0);
	let need = 0n;
	if (opts.size !== undefined) need = BigInt(opts.size);
	if (opts.length !== undefined) {
		const end = offset + BigInt(opts.length);
		if (end > need) need = end;
	}
	if (need > size) {
		Deno.truncateSync(path, Number(need));
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
	let need = 0n;
	if (opts.size !== undefined) need = BigInt(opts.size);
	if (opts.length !== undefined) {
		const end = offset + BigInt(opts.length);
		if (end > need) need = end;
	}
	if (need > size) {
		await Deno.truncate(path, Number(need));
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
 */
export class Mmap {
	protected base: Deno.PointerObject;
	protected mapLength: bigint;
	protected delta: bigint;
	protected bytes_: Uint8Array | null;
	protected view_: DataView | undefined | null;

	/** Whether the mapping was opened read-write. */
	readonly writable: boolean;

	/** @internal — use {@linkcode Mmap.openSync} to construct. */
	private constructor(
		base: Deno.PointerObject,
		mapLength: bigint,
		delta: bigint,
		bytes: Uint8Array,
		writable: boolean,
	) {
		this.base = base;
		this.mapLength = mapLength;
		this.delta = delta;
		this.bytes_ = bytes;
		this.writable = writable;
	}

	/**
	 * Memory-map a file and return a zero-copy {@linkcode Mmap} handle.
	 *
	 * @param path Filesystem path to the file.
	 * @param options See {@linkcode MmapOptions}.
	 *
	 * @example
	 * ```ts
	 * using f = Mmap.openSync("data.bin");
	 * const first = f.bytes[0];
	 * ```
	 */
	static openSync(path: string, options: MmapOptions = {}): Mmap {
		const write = options.write ?? false;
		const fileSize = ensureFileSync(path, write, options);

		const offset = BigInt(options.offset ?? 0);
		if (offset < 0n) throw new RangeError("offset must be >= 0");

		const length = options.length !== undefined ? BigInt(options.length) : fileSize - offset;
		if (length <= 0n) {
			throw new RangeError("length must be > 0 (nothing to map)");
		}
		if (!write && offset + length > fileSize) {
			throw new RangeError(`mapping [${offset}, ${offset + length}) exceeds file size ${fileSize}`);
		}

		// Align the file offset down to the OS granularity; carry the remainder into
		// the view's byteOffset so the returned bytes start exactly at `offset`.
		const g = BigInt(granularity);
		const alignedOffset = alignDown(offset, g);
		const delta = offset - alignedOffset;
		const mapLength = length + delta;

		const base = nativeMap(path, alignedOffset, mapLength, write);
		const buffer = Deno.UnsafePointerView.getArrayBuffer(base, Number(mapLength));
		const bytes = new Uint8Array(buffer, Number(delta), Number(length));

		return new Mmap(base, mapLength, delta, bytes, write);
	}

	/**
	 * Memory-map a file and return a zero-copy {@linkcode Mmap} handle.
	 *
	 * @param path Filesystem path to the file.
	 * @param options See {@linkcode MmapOptions}.
	 *
	 * @example
	 * ```ts
	 * using f = await Mmap.open("data.bin");
	 * const first = f.bytes[0];
	 * ```
	 */
	static async open(path: string, options: MmapOptions = {}): Promise<Mmap> {
		const write = options.write ?? false;
		const fileSize = await ensureFile(path, write, options);

		const offset = BigInt(options.offset ?? 0);
		if (offset < 0n) throw new RangeError("offset must be >= 0");

		const length = options.length !== undefined ? BigInt(options.length) : fileSize - offset;
		if (length <= 0n) {
			throw new RangeError("length must be > 0 (nothing to map)");
		}
		if (!write && offset + length > fileSize) {
			throw new RangeError(`mapping [${offset}, ${offset + length}) exceeds file size ${fileSize}`);
		}

		// Align the file offset down to the OS granularity; carry the remainder into
		// the view's byteOffset so the returned bytes start exactly at `offset`.
		const g = BigInt(granularity);
		const alignedOffset = alignDown(offset, g);
		const delta = offset - alignedOffset;
		const mapLength = length + delta;

		const base = nativeMap(path, alignedOffset, mapLength, write);
		const buffer = Deno.UnsafePointerView.getArrayBuffer(base, Number(mapLength));
		const bytes = new Uint8Array(buffer, Number(delta), Number(length));

		return new Mmap(base, mapLength, delta, bytes, write);
	}

	/**
	 * The mapped bytes as a zero-copy {@linkcode Uint8Array}. Reads and writes go
	 * straight to the file's pages. Invalid once {@linkcode Mmap.close} runs.
	 */
	get bytes(): Uint8Array {
		if (!this.bytes_) throw new Error("Mmap is closed");
		return this.bytes_;
	}

	/** Length of the mapped view, in bytes. */
	get length(): number {
		if (!this.bytes_) throw new Error("Mmap is closed");
		return this.bytes_.length;
	}

	/** A {@linkcode DataView} over the same zero-copy memory. */
	get view(): DataView {
		if (this.view_) return this.view_;
		const b = this.bytes;
		return this.view_ = new DataView(b.buffer, b.byteOffset, b.byteLength);
	}

	/**
	 * A pointer to the first byte of the view, for handing the mapped memory to
	 * other FFI calls.
	 */
	get pointer(): Deno.PointerValue {
		if (this.bytes_ === null) throw new Error("Mmap is closed");
		return Deno.UnsafePointer.offset(this.base, Number(this.delta));
	}

	/**
	 * Advise the kernel about the access pattern for a sub-range (`offset` and
	 * `length` are relative to this view). No-op on Windows.
	 */
	advise(advice: Advice, offset = 0, length?: number): void {
		if (this.bytes_ === null) throw new Error("Mmap is closed");
		const [ptr, len] = this.alignedRange(offset, length);
		nativeAdvise(ptr, len, advice);
	}

	/**
	 * Flush modified pages in a sub-range to disk (`msync(MS_SYNC)` on POSIX,
	 * `FlushViewOfFile` on Windows). `offset`/`length` are relative to this view.
	 */
	flush(offset = 0, length?: number): void {
		if (this.bytes_ === null) throw new Error("Mmap is closed");
		const [ptr, len] = this.alignedRange(offset, length);
		nativeSync(ptr, len);
	}

	// Translate a view-relative range into a page-aligned (pointer, length),
	// since msync/madvise require a page-aligned start address on POSIX.
	protected alignedRange(offset: number, length?: number): [Deno.PointerValue, bigint] {
		const viewLen = this.bytes_!.length;
		if (offset < 0 || offset > viewLen) {
			throw new RangeError("offset out of bounds");
		}
		const len = length ?? viewLen - offset;
		if (len < 0 || offset + len > viewLen) {
			throw new RangeError("length out of bounds");
		}
		const abs = this.delta + BigInt(offset); // position within the mapping
		const start = alignDown(abs, BigInt(pageSize));
		const alignedLen = (abs - start) + BigInt(len);
		return [Deno.UnsafePointer.offset(this.base, Number(start)), alignedLen];
	}

	/**
	 * Unmap the region. Idempotent. After this call the view is dead — see the
	 * class-level warning.
	 */
	close(): void {
		if (!this.bytes_) return;
		this.bytes_ = null;
		this.view_ = null;
		nativeUnmap(this.base, this.mapLength);
	}

	/** Disposes the mapping, enabling `using` declarations. */
	[Symbol.dispose](): void {
		this.close();
	}
}
