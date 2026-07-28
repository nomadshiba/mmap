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
		using m = Mmap.openSync(path, { write: true, size: 4096 });
		assertEquals(m.length, 4096);
		assert(m.writable);
		m.bytes[0] = 0xBE;
		m.bytes[1] = 0xEF;
		m.bytes[4095] = 0x42;
		m.view.setUint32(8, 0xDEADBEEF, true);
		m.flush();
	}
	using r = Mmap.openSync(path);
	assertEquals(r.bytes[0], 0xBE);
	assertEquals(r.bytes[1], 0xEF);
	assertEquals(r.bytes[4095], 0x42);
	assertEquals(r.view.getUint32(8, true), 0xDEADBEEF);
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
	assertEquals(m.bytes[SIZE - 4096], 0); // fault in exactly one page
	const grewMiB = (Deno.memoryUsage().rss - before) / (1024 * 1024);
	assert(grewMiB < 64, `RSS grew ${grewMiB.toFixed(1)} MiB (expected < 64)`);
});

Deno.test("unaligned offset is handled (view starts exactly at offset)", () => {
	const path = `${tmp}/off.bin`;
	const src = new Uint8Array(200_000);
	for (let i = 0; i < src.length; i++) src[i] = i & 0xff;
	Deno.writeFileSync(path, src);

	const offset = 100_003; // deliberately not page/granularity aligned
	const len = 5_000;
	using m = Mmap.openSync(path, { offset, length: len });
	assertEquals(m.length, len);
	for (let i = 0; i < len; i++) {
		assertEquals(m.bytes[i], (offset + i) & 0xff);
	}
});

Deno.test("bounds: reading past a read-only file is rejected", () => {
	const path = `${tmp}/small.bin`;
	Deno.writeFileSync(path, new Uint8Array(10));
	assertThrows(() => Mmap.openSync(path, { length: 999 }));
});

Deno.test("use after close throws (guarded getter), close is idempotent", () => {
	const path = `${tmp}/closed.bin`;
	const m = Mmap.openSync(path, { write: true, size: 16 });
	m.close();
	m.close(); // idempotent — no throw, no double-unmap
	assertThrows(() => m.bytes);
});

Deno.test("sharing: same path, no key → same pointer, refcounted close", () => {
	const path = `${tmp}/shared-default.bin`;
	Deno.writeFileSync(path, new Uint8Array(16));

	const a = Mmap.openSync(path);
	const b = Mmap.openSync(path);
	assertEquals(Deno.UnsafePointer.value(a.pointer), Deno.UnsafePointer.value(b.pointer), "same path should share the same pointer");
	assertEquals(a.bytes.buffer, b.bytes.buffer, "same path should share the same backing buffer");

	a.close();
	assertEquals(b.bytes.length, 16); // closing `a` must not invalidate sibling handle `b`

	b.close();
	// Both closed now — a brand-new open() must create a fresh mapping, not reuse a dead one.
	using c = Mmap.openSync(path);
	assertEquals(c.length, 16);
});

Deno.test("sharing: distinct `key` gives an independent mapping of the same file", () => {
	const path = `${tmp}/shared-keyed.bin`;
	Deno.writeFileSync(path, new Uint8Array(16));

	using a = Mmap.openSync(path, { key: "a" });
	using b = Mmap.openSync(path, { key: "b" });
	using c = Mmap.openSync(path, { key: "a" });

	assert(
		Deno.UnsafePointer.value(a.pointer) !== Deno.UnsafePointer.value(b.pointer),
		"different keys should get independent pointers",
	);
	assertEquals(Deno.UnsafePointer.value(a.pointer), Deno.UnsafePointer.value(c.pointer), "same key should share the same pointer");
});

Deno.test("sharing: mismatched options for the same key throws", () => {
	const path = `${tmp}/shared-mismatch.bin`;
	Deno.writeFileSync(path, new Uint8Array(4096));

	using a = Mmap.openSync(path); // read-only, whole file
	assertThrows(
		() => Mmap.openSync(path, { write: true }),
		"opening the same path read-write while a read-only mapping is live should throw",
	);
	assertThrows(
		() => Mmap.openSync(path, { length: 10 }),
		"opening the same path with a different length while a mapping is live should throw",
	);
	void a;
});
