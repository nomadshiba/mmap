import { os } from "./platform.ts";

/**
 * `madvise()` advice values, passed to {@linkcode Mmap.advise}. The numeric
 * values are identical on Linux and macOS. On Windows there is no direct
 * equivalent, so advising is a no-op (advice never affects correctness, only
 * the kernel's read-ahead/eviction heuristics).
 */
export enum Advice {
	/** No special treatment (the default). */
	Normal = 0,
	/** Expect page references in random order — suppresses read-ahead. */
	Random = 1,
	/** Expect sequential references — aggressive read-ahead. */
	Sequential = 2,
	/** Expect access soon — read the pages in now. */
	WillNeed = 3,
	/** Don't expect access soon — the pages may be evicted. */
	DontNeed = 4,
}

// Protection / mapping flags. These values are stable across Linux and macOS.
export const PROT_READ = 0x1;
export const PROT_WRITE = 0x2;
export const MAP_SHARED = 0x1;
export const MAP_PRIVATE = 0x2;

// open(2) flags we use. O_RDONLY/O_RDWR are stable across Linux and macOS.
export const O_RDONLY = 0x0;
export const O_RDWR = 0x2;

/** `msync()` flag for a synchronous flush. macOS uses 0x10; Linux uses 0x4. */
export const MS_SYNC: number = os === "darwin" ? 0x10 : 0x4;
