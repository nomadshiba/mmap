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
