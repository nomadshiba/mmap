/**
 * Zero-copy memory-mapped file I/O for Deno, via FFI — no native addon and no
 * prebuilt binary. It binds the platform's own C library directly: `libc`
 * (`mmap`/`munmap`/`madvise`/`msync`) on Linux and macOS, and `kernel32`
 * (`CreateFileMappingW`/`MapViewOfFile`/`FlushViewOfFile`) on Windows.
 *
 * The mapped pages are exposed to JavaScript as a real {@linkcode Uint8Array}
 * whose backing store *is* the mapping — reads and writes touch the file's
 * pages directly, with no copy, and pages fault in lazily from the OS page
 * cache.
 *
 * @example Read a file with zero copies
 * ```ts
 * import { Mmap } from "@nomadshiba/mmap";
 * using file = await Mmap.open("massive.bin");
 * console.log(file.bytes[102432]); // faults in a single page
 * ```
 *
 * @example Create, write, flush
 * ```ts
 * import { Mmap } from "@nomadshiba/mmap";
 * using out = await Mmap.open("out.bin", { write: true, size: 1024 * 1024 });
 * out.bytes[0] = 0xff;
 * out.view.setUint32(4, 0xdeadbeef, true);
 * out.flush();
 * ```
 *
 * Run with `--allow-ffi --allow-read` (add `--allow-write` for write maps).
 *
 * @module
 */

export { Mmap } from "./src/mmap.ts";
export type { MmapOptions as MapOptions } from "./src/mmap.ts";
export { Advice } from "./src/constants.ts";
