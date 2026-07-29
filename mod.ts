/**
 * Zero-copy memory-mapped file I/O for Deno, via FFI — no native addon and no
 * prebuilt binary. It binds the platform's own C library directly: `libc`
 * (`mmap`/`munmap`/`madvise`/`msync`) on Linux and macOS, and `kernel32`
 * (`CreateFileMappingW`/`MapViewOfFile`/`FlushViewOfFile`) on Windows.
 *
 * {@linkcode Mmap.bytes} hands you a real {@linkcode Uint8Array} whose backing
 * store *is* the mapping. Reads and writes touch the file's pages directly, with
 * no copy, and pages fault in lazily from the OS page cache.
 *
 * @example Read a file with zero copies
 * ```ts
 * import { Mmap } from "@nomadshiba/mmap";
 * using file = await Mmap.open("massive.bin");
 * const bytes = file.bytes();
 * console.log(bytes[102_432]); // faults in a single page
 * ```
 *
 * @example Create, write, flush
 * ```ts
 * import { Mmap } from "@nomadshiba/mmap";
 * using out = await Mmap.open("out.bin", { write: true, ensureFileSize: 1024 * 1024 });
 * const bytes = out.bytes();
 * bytes[0] = 0xff;
 * out.view().setUint32(4, 0xdeadbeef, true);
 * out.flush();
 * ```
 *
 * Call `bytes()`/`view()`/`buffer()` once and reuse the result within a scope —
 * each call builds a fresh object, so calling one per byte in a loop is pure
 * overhead.
 *
 * Each `Mmap.open`/`openSync` call maps the file independently — nothing is
 * shared or cached between calls, even for the same path. Two mappings of one
 * file still see each other's writes, because the kernel keeps them coherent
 * through the page cache, but each has its own pointer.
 *
 * A `buffer()` transferred to a `Worker` is different: both threads then write
 * *the same pages*, like a file-backed `SharedArrayBuffer`. The one rule is
 * lifetime — don't {@linkcode Mmap.close} while the worker still holds it. See
 * {@linkcode Mmap} for the details and the ways to crash.
 *
 * Run with `--allow-ffi --allow-read` (add `--allow-write` for write maps).
 *
 * @module
 */

export { Mmap } from "./src/mmap.ts";
export type { MmapOptions as MapOptions } from "./src/mmap.ts";
export { Advice } from "./src/constants.ts";
