// Dependency-free tests — run with:
//   deno test --allow-ffi --allow-read --allow-write
import { Advice, Mmap } from "../mod.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
	if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
	if (actual !== expected) {
		throw new Error(msg ?? `expected ${expected}, got ${actual}`);
	}
}
function assertThrows(fn: () => unknown, msg?: string): void {
	let threw = false;
	try {
		fn();
	} catch {
		threw = true;
	}
	if (!threw) throw new Error(msg ?? "expected function to throw");
}

const tmp = Deno.makeTempDirSync();

Deno.test("write → flush → reopen: round-trips through the file", () => {
	const path = `${tmp}/rw.bin`;
	{
		using m = Mmap.openSync(path, { write: true, ensureFileSize: 4096 });
		assertEquals(m.length, 4096);
		assert(m.writable);
		const bytes = m.bytes();
		bytes[0] = 0xBE;
		bytes[1] = 0xEF;
		bytes[4095] = 0x42;
		m.view().setUint32(8, 0xDEADBEEF, true);
		m.flush();
	}
	using r = Mmap.openSync(path);
	const bytes = r.bytes();
	assertEquals(bytes[0], 0xBE);
	assertEquals(bytes[1], 0xEF);
	assertEquals(bytes[4095], 0x42);
	assertEquals(r.view().getUint32(8, true), 0xDEADBEEF);
});

Deno.test("zero-copy: mapping a 1 GiB sparse file barely moves RSS", () => {
	const path = `${tmp}/big.bin`;
	Deno.openSync(path, { write: true, create: true }).close();
	const SIZE = 1024 * 1024 * 1024; // 1 GiB, sparse
	Deno.truncateSync(path, SIZE);

	const before = Deno.memoryUsage().rss;
	using m = Mmap.openSync(path);
	m.advise(Advice.Random);
	assertEquals(m.length, SIZE);
	const bytes = m.bytes();
	assertEquals(bytes[SIZE - 4096], 0); // fault in exactly one page
	const grewMiB = (Deno.memoryUsage().rss - before) / (1024 * 1024);
	assert(grewMiB < 64, `RSS grew ${grewMiB.toFixed(1)} MiB (expected < 64)`);
});

Deno.test("unaligned byteOffset is handled (view starts exactly there)", () => {
	const path = `${tmp}/off.bin`;
	const src = new Uint8Array(200_000);
	for (let i = 0; i < src.length; i++) src[i] = i & 0xff;
	Deno.writeFileSync(path, src);

	const byteOffset = 100_003; // deliberately not page/granularity aligned
	const length = 5_000;
	using m = Mmap.openSync(path, { byteOffset, length });
	assertEquals(m.length, length);
	const bytes = m.bytes(); // one view, reused — not a fresh one per iteration
	for (let i = 0; i < length; i++) {
		assertEquals(bytes[i], (byteOffset + i) & 0xff);
	}
});

Deno.test("length defaults to the rest of the file from byteOffset", () => {
	const path = `${tmp}/rest.bin`;
	Deno.writeFileSync(path, new Uint8Array(10_000));

	using whole = Mmap.openSync(path);
	assertEquals(whole.length, 10_000);

	using tail = Mmap.openSync(path, { byteOffset: 4_096 });
	assertEquals(tail.length, 10_000 - 4_096);

	// Unaligned offset too — the default still runs to the exact end of the file.
	using odd = Mmap.openSync(path, { byteOffset: 1_234 });
	assertEquals(odd.length, 10_000 - 1_234);
});

Deno.test("bounds: reading past a read-only file is rejected", () => {
	const path = `${tmp}/small.bin`;
	Deno.writeFileSync(path, new Uint8Array(10));
	assertThrows(() => Mmap.openSync(path, { length: 999 }));
	assertThrows(() => Mmap.openSync(path, { byteOffset: 5, length: 6 }));
	assertThrows(() => Mmap.openSync(path, { byteOffset: 11 }));
	assertThrows(() => Mmap.openSync(path, { byteOffset: -1 }));
	assertThrows(() => Mmap.openSync(path, { length: 0 }));
	// Exactly the whole file is fine.
	using m = Mmap.openSync(path, { byteOffset: 0, length: 10 });
	assertEquals(m.length, 10);
});

Deno.test("bounds: `length` past the file is rejected even when writable, unless `ensureFileSize` covers it", () => {
	const path = `${tmp}/write_small.bin`;
	Deno.writeFileSync(path, new Uint8Array(10));
	// `length` alone doesn't grow the file — only `ensureFileSize` does.
	assertThrows(() => Mmap.openSync(path, { write: true, length: 999 }));
	// ...but once `ensureFileSize` covers it, the same `length` is fine.
	using m = Mmap.openSync(path, { write: true, ensureFileSize: 999, length: 999 });
	assertEquals(m.length, 999);
});

Deno.test("use after close throws (guarded getter), close is idempotent", () => {
	const path = `${tmp}/closed.bin`;
	const m = Mmap.openSync(path, { write: true, ensureFileSize: 16 });
	m.close();
	m.close(); // idempotent — no throw, no double-unmap
	assertThrows(() => m.bytes());
	assertThrows(() => m.view());
	assertThrows(() => m.buffer());
	// `length`/`pointer` aren't live memory accesses — `length` stays valid, and `pointer` is set to
	// `null` (rather than throwing) since it's plain data, same as `length`.
	assertEquals(m.length, 16);
	assertEquals(m.pointer, null);
});

Deno.test("no sharing: opening the same path twice gives two independent mappings", () => {
	const path = `${tmp}/independent.bin`;
	Deno.writeFileSync(path, new Uint8Array(16));

	using a = Mmap.openSync(path, { write: true });
	using b = Mmap.openSync(path, { write: true });
	assert(
		Deno.UnsafePointer.value(a.pointer) !== Deno.UnsafePointer.value(b.pointer),
		"two open() calls for the same path must not share a pointer",
	);
	assert(a.bytes().buffer !== b.bytes().buffer, "two open() calls for the same path must not share a buffer");
});

// The next few tests all pin down the same thing: two mappings of one file are two sets of page
// table entries pointing at *one* set of physical pages, because MAP_SHARED maps the kernel's page
// cache for the inode. So stores are visible across mappings immediately — no flush() involved.
// flush() only forces durability to disk; it has nothing to do with cross-mapping visibility.

Deno.test("coherence: two mappings of one file see each other's writes, in both directions, unflushed", () => {
	const path = `${tmp}/coherent_pair.bin`;
	Deno.writeFileSync(path, new Uint8Array(1024 * 1024));

	using a = Mmap.openSync(path, { write: true });
	using b = Mmap.openSync(path, { write: true });
	const ba = a.bytes();
	const bb = b.bytes();

	ba[0] = 0x11;
	assertEquals(bb[0], 0x11, "a's write should be visible through b without a flush");

	bb[1] = 0x22;
	assertEquals(ba[1], 0x22, "b's write should be visible through a without a flush");

	// Far from page 0, to make sure this isn't an artefact of one shared first page.
	ba[900_000] = 0x33;
	assertEquals(bb[900_000], 0x33, "coherence should hold deep into the file too");
});

Deno.test("coherence: a read-only mapping observes a read-write mapping's stores", () => {
	const path = `${tmp}/coherent_ro.bin`;
	Deno.writeFileSync(path, new Uint8Array(64));

	using r = Mmap.openSync(path); // PROT_READ, opened *before* the write below
	const br = r.bytes();
	assertEquals(br[0], 0);
	assert(!r.writable);

	using w = Mmap.openSync(path, { write: true });
	w.bytes()[0] = 0x44;

	assertEquals(br[0], 0x44, "a read-only mapping should see a writer's store through the page cache");
});

Deno.test("coherence: overlapping windows stay coherent even with different aligned bases", () => {
	const path = `${tmp}/coherent_window.bin`;
	Deno.writeFileSync(path, new Uint8Array(64 * 1024));

	using whole = Mmap.openSync(path, { write: true });
	// An unaligned byteOffset means this mapping has a different granularity-aligned base than
	// `whole`, plus an internal delta — the overlap must still be the same physical pages.
	const byteOffset = 4_099;
	using win = Mmap.openSync(path, { write: true, byteOffset, length: 8_192 });

	const bw = whole.bytes();
	const bn = win.bytes();

	bw[byteOffset] = 0x66;
	assertEquals(bn[0], 0x66, "the window should see a write made through the whole-file mapping");

	bn[10] = 0x77;
	assertEquals(bw[byteOffset + 10], 0x77, "the whole-file mapping should see a write made through the window");
});

Deno.test("coherence: ordinary file I/O and an active mapping share the page cache", () => {
	const path = `${tmp}/coherent_syscall.bin`;
	Deno.writeFileSync(path, new Uint8Array(64));

	using m = Mmap.openSync(path, { write: true });
	const bytes = m.bytes();

	// A plain write() through a file descriptor, not mmap.
	{
		using f = Deno.openSync(path, { write: true });
		f.seekSync(4, Deno.SeekMode.Start);
		f.writeSync(new Uint8Array([0x88]));
	}
	assertEquals(bytes[4], 0x88, "the mapping should see a write() made through a normal fd");

	// ...and the reverse: a store through the mapping is visible to read().
	bytes[5] = 0x99;
	{
		using f = Deno.openSync(path, { read: true });
		const buf = new Uint8Array(1);
		f.seekSync(5, Deno.SeekMode.Start);
		f.readSync(buf);
		assertEquals(buf[0], 0x99, "read() should see a store made through the mapping");
	}
});

Deno.test("closing one mapping leaves another mapping of the same file alive", () => {
	const path = `${tmp}/close_one.bin`;
	Deno.writeFileSync(path, new Uint8Array(64));

	const a = Mmap.openSync(path, { write: true });
	using b = Mmap.openSync(path, { write: true });

	a.bytes()[0] = 0xAA;
	a.close(); // munmap()s a's range only — b's pages are a different mapping of the same file

	assertEquals(b.bytes()[0], 0xAA, "b should still hold the data a wrote before closing");
	b.bytes()[1] = 0xBB;
	assertEquals(b.bytes()[1], 0xBB, "b should still be writable after a closed");
});

Deno.test("bytes()/view()/buffer() are independent per call: detaching one doesn't brick the others", () => {
	const path = `${tmp}/fresh.bin`;
	Deno.writeFileSync(path, new Uint8Array(16).fill(0xAB));

	using m = Mmap.openSync(path, { write: true });
	assert(m.bytes() !== m.bytes(), "each bytes() call must be a fresh object");
	assert(m.bytes().buffer !== m.bytes().buffer, "each bytes() call must have its own fresh ArrayBuffer");

	const detached = m.buffer();
	structuredClone(detached, { transfer: [detached] }); // simulate transferring it to a Worker
	assertEquals(detached.byteLength, 0); // that specific buffer is gone...

	// ...but the Mmap instance itself is unaffected — later calls still work.
	assertEquals(m.bytes()[0], 0xAB);
	assertEquals(m.view().getUint8(0), 0xAB);
	assertEquals(m.buffer().byteLength, 16);
});
