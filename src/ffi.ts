import { MAP_PRIVATE, MAP_SHARED, MS_SYNC, O_RDONLY, O_RDWR, PROT_READ, PROT_WRITE } from "./constants.ts";
import { os } from "./platform.ts";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();

/** NUL-terminated UTF-8, for POSIX `open`. */
function cstr(s: string): Uint8Array {
	return encoder.encode(s + "\0");
}

/** NUL-terminated UTF-16LE, for the Windows `*W` APIs. */
function wstr(s: string): Uint8Array {
	const u16 = new Uint16Array(s.length + 1);
	for (let i = 0; i < s.length; i++) u16[i] = s.charCodeAt(i);
	u16[s.length] = 0;
	return new Uint8Array(u16.buffer);
}

function ptrValue(p: Deno.PointerValue): bigint {
	return p === null ? 0n : Deno.UnsafePointer.value(p);
}

// null, (void*)-1 and INVALID_HANDLE_VALUE, all treated as failure.
const FAILURE_PTRS = new Set([0n, -1n, 0xffffffffffffffffn]);
function failed(p: Deno.PointerValue): boolean {
	return p === null || FAILURE_PTRS.has(ptrValue(p));
}

// ---------------------------------------------------------------------------
// POSIX (Linux, macOS)
// ---------------------------------------------------------------------------
function openPosix() {
	const symbols = {
		open: { parameters: ["buffer", "i32"], result: "i32" },
		close: { parameters: ["i32"], result: "i32" },
		mmap: {
			parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"],
			result: "pointer",
		},
		munmap: { parameters: ["pointer", "usize"], result: "i32" },
		madvise: { parameters: ["pointer", "usize", "i32"], result: "i32" },
		msync: { parameters: ["pointer", "usize", "i32"], result: "i32" },
		getpagesize: { parameters: [], result: "i32" },
	} as const;

	const candidates = os === "darwin" ? ["libSystem.B.dylib", "libc.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];

	let lastErr: unknown;
	for (const name of candidates) {
		try {
			return Deno.dlopen(name, symbols);
		} catch (e) {
			lastErr = e;
		}
	}
	throw new Error(`@nomadshiba/mmap: could not load libc (${String(lastErr)})`);
}

// ---------------------------------------------------------------------------
// Windows (kernel32)
// ---------------------------------------------------------------------------
function openWin() {
	const symbols = {
		CreateFileW: {
			parameters: ["buffer", "u32", "u32", "pointer", "u32", "u32", "pointer"],
			result: "pointer",
		},
		CreateFileMappingW: {
			parameters: ["pointer", "pointer", "u32", "u32", "u32", "pointer"],
			result: "pointer",
		},
		MapViewOfFile: {
			parameters: ["pointer", "u32", "u32", "u32", "usize"],
			result: "pointer",
		},
		UnmapViewOfFile: { parameters: ["pointer"], result: "i32" },
		FlushViewOfFile: { parameters: ["pointer", "usize"], result: "i32" },
		CloseHandle: { parameters: ["pointer"], result: "i32" },
		GetSystemInfo: { parameters: ["pointer"], result: "void" },
	} as const;
	return Deno.dlopen("kernel32.dll", symbols);
}

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const PAGE_READONLY = 0x02;
const PAGE_READWRITE = 0x04;
const FILE_MAP_READ = 0x0004;
const FILE_MAP_WRITE = 0x0002; // grants read+write

// ---------------------------------------------------------------------------
// init: load the right library once, resolve page size / alloc granularity
// ---------------------------------------------------------------------------
type PosixSymbols = ReturnType<typeof openPosix>["symbols"];
type WinSymbols = ReturnType<typeof openWin>["symbols"];

let posix: PosixSymbols | null = null;
let win: WinSymbols | null = null;
let _pageSize = 4096;
let _granularity = 4096;

if (os === "windows") {
	win = openWin().symbols;
	const si = new Uint8Array(64); // SYSTEM_INFO is 48 bytes on 64-bit
	win.GetSystemInfo(Deno.UnsafePointer.of(si));
	const dv = new DataView(si.buffer);
	_pageSize = dv.getUint32(4, true); // dwPageSize
	_granularity = dv.getUint32(40, true); // dwAllocationGranularity
} else {
	posix = openPosix().symbols;
	_pageSize = posix.getpagesize();
	_granularity = _pageSize;
}

/** OS page size in bytes (e.g. 4096, or 16384 on Apple Silicon). */
export const pageSize: number = _pageSize;

/**
 * Required alignment for a mapping's file offset: the page size on POSIX, the
 * allocation granularity (usually 65536) on Windows.
 */
export const granularity: number = _granularity;

// ---------------------------------------------------------------------------
// native operations (platform-dispatched)
// ---------------------------------------------------------------------------

/**
 * Map `mapLength` bytes of `path` starting at `alignedOffset` (which the caller
 * must have aligned to {@linkcode granularity}). Returns the base pointer.
 */
export function nativeMap(
	path: string,
	alignedOffset: bigint,
	mapLength: bigint,
	write: boolean,
): Deno.PointerObject {
	if (posix) {
		const fd = posix.open(cstr(path), write ? O_RDWR : O_RDONLY);
		if (fd < 0) throw new Error(`open failed: ${path}`);
		try {
			const prot = write ? PROT_READ | PROT_WRITE : PROT_READ;
			const flags = write ? MAP_SHARED : MAP_PRIVATE;
			const p = posix.mmap(null, mapLength, prot, flags, fd, alignedOffset);
			if (failed(p)) throw new Error("mmap failed");
			return p as Deno.PointerObject;
		} finally {
			posix.close(fd); // mapping outlives the fd
		}
	}

	const w = win!;
	const handle = w.CreateFileW(
		wstr(path),
		write ? GENERIC_READ | GENERIC_WRITE : GENERIC_READ,
		write ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ,
		null,
		OPEN_EXISTING,
		FILE_ATTRIBUTE_NORMAL,
		null,
	);
	if (failed(handle)) throw new Error(`CreateFileW failed: ${path}`);

	let mapping: Deno.PointerValue = null;
	try {
		mapping = w.CreateFileMappingW(
			handle,
			null,
			write ? PAGE_READWRITE : PAGE_READONLY,
			0,
			0, // 0,0 → mapping spans the whole file
			null,
		);
		if (mapping === null || ptrValue(mapping) === 0n) {
			throw new Error("CreateFileMapping failed");
		}
		const offHigh = Number((alignedOffset >> 32n) & 0xffffffffn) >>> 0;
		const offLow = Number(alignedOffset & 0xffffffffn) >>> 0;
		const base = w.MapViewOfFile(
			mapping,
			write ? FILE_MAP_WRITE : FILE_MAP_READ,
			offHigh,
			offLow,
			mapLength,
		);
		if (base === null || ptrValue(base) === 0n) {
			throw new Error("MapViewOfFile failed");
		}
		return base as Deno.PointerObject;
	} finally {
		// The view keeps the file and mapping objects alive; their handles can go.
		if (mapping !== null) w.CloseHandle(mapping);
		w.CloseHandle(handle);
	}
}

/** Unmap a region previously returned by {@linkcode nativeMap}. */
export function nativeUnmap(base: Deno.PointerValue, mapLength: bigint): void {
	if (posix) {
		posix.munmap(base, mapLength);
		return;
	}
	win!.UnmapViewOfFile(base);
}

/** Flush a (page-aligned) sub-range to disk. */
export function nativeSync(ptr: Deno.PointerValue, length: bigint): void {
	if (posix) {
		if (posix.msync(ptr, length, MS_SYNC) !== 0) {
			throw new Error("msync failed");
		}
		return;
	}
	if (win!.FlushViewOfFile(ptr, length) === 0) {
		throw new Error("FlushViewOfFile failed");
	}
}

/** Advise the kernel about an access pattern. No-op on Windows. */
export function nativeAdvise(
	ptr: Deno.PointerValue,
	length: bigint,
	advice: number,
): void {
	if (posix) {
		posix.madvise(ptr, length, advice);
	}
	// Windows: no direct madvise equivalent; advice is only a hint, so ignore.
}
