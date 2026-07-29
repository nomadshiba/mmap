// Run with: deno test --allow-ffi --allow-read --allow-write
//
// `Mmap` does no cross-isolate bookkeeping of its own, so these tests pin down what the
// OS and V8 actually give you:
//  1. Separate mappings of one file, from separate threads, see each other's writes
//     (kernel page cache).
//  2. Transferring a `buffer()` to a worker shares the *same pages* — writes travel in
//     both directions, live — because the transfer moves a backing store that points at
//     the mapping.
//  3. That sharing is safe as long as `close()` waits for the other side, which is the
//     one rule the class docs give. Tested for real, not reasoned about.
import { Mmap } from "../mod.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
	if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
	if (actual !== expected) {
		throw new Error(msg ?? `expected ${expected}, got ${actual}`);
	}
}

// deno-lint-ignore no-explicit-any
function rpc(worker: Worker, message: unknown, transfer: Transferable[] = []): Promise<any> {
	return new Promise((resolve, reject) => {
		worker.onmessage = (e) => resolve(e.data);
		worker.onerror = (e) => {
			e.preventDefault();
			reject(e.error ?? new Error(e.message));
		};
		worker.postMessage(message, transfer);
	});
}

function spawn(): Worker {
	return new Worker(import.meta.resolve("./worker.ts"), { type: "module" });
}

const tmp = Deno.makeTempDirSync();

function fixture(name: string, size = 64): string {
	const path = `${tmp}/${name}`;
	Deno.writeFileSync(path, new Uint8Array(size));
	return path;
}

Deno.test("a worker mapping the same path independently still sees this thread's writes", async () => {
	const path = fixture("coherent.bin");

	using main = Mmap.openSync(path, { write: true });
	const bytes = main.bytes();
	bytes[0] = 0x7E;
	main.flush();

	const worker = spawn();
	try {
		// A fresh mapping the worker makes itself — nothing is transferred here.
		const response = await rpc(worker, { kind: "ownMap", path });
		assertEquals(response.byte0, 0x7E, "the worker's own mapping should see this thread's write");
		assertEquals(response.byteLength, main.length);
	} finally {
		worker.terminate();
	}
});

Deno.test("transferring buffer() to a worker hands over the real bytes, and detaches only that object", async () => {
	const path = fixture("transfer.bin");
	{
		using seed = Mmap.openSync(path, { write: true });
		seed.bytes()[0] = 0xAB;
		seed.flush();
	}

	const mapping = Mmap.openSync(path, { write: true });
	const buffer = mapping.buffer();

	const worker = spawn();
	try {
		const response = await rpc(worker, { kind: "read", buffer }, [buffer]);

		assertEquals(buffer.byteLength, 0, "the transferred buffer should be detached in this isolate");
		assertEquals(response.byteLength, mapping.length, "the worker should see the full mapping");
		assertEquals(response.byte0, 0xAB, "the worker should have received the mapping's real contents");

		// The Mmap itself is untouched by the transfer.
		assertEquals(mapping.bytes()[0], 0xAB);
		assertEquals(mapping.view().getUint8(0), 0xAB);
		assertEquals(mapping.buffer().byteLength, mapping.length);

		// Safe to close now: the worker has finished with the message.
		mapping.close();
	} finally {
		worker.terminate();
	}
});

Deno.test("a worker's writes through a transferred buffer() land in the mapping", async () => {
	const path = fixture("worker_writes.bin");
	const mapping = Mmap.openSync(path, { write: true });

	const worker = spawn();
	try {
		const buffer = mapping.buffer();
		await rpc(worker, { kind: "hold", buffer }, [buffer]);
		const written = await rpc(worker, { kind: "writeHeld", index: 3, value: 0x44 });
		assertEquals(written.value, 0x44);

		// A fresh view on this thread reads what the other thread wrote — same pages,
		// not a copy handed over at transfer time.
		const bytes = mapping.bytes();
		assertEquals(bytes[3], 0x44, "the worker's write should be visible through a fresh bytes()");

		// ...and it reaches the file, since a write map is MAP_SHARED.
		mapping.flush();
		assertEquals(Deno.readFileSync(path)[3], 0x44, "the worker's write should reach the file");
	} finally {
		worker.terminate();
		mapping.close();
	}
});

Deno.test("a transferred buffer() is live shared memory: this thread's writes are visible to the worker too", async () => {
	const path = fixture("both_ways.bin");
	const mapping = Mmap.openSync(path, { write: true });

	const worker = spawn();
	try {
		const buffer = mapping.buffer();
		await rpc(worker, { kind: "hold", buffer }, [buffer]);

		// Write here, after the transfer, through a fresh view.
		const bytes = mapping.bytes();
		bytes[9] = 0x5A;

		const read = await rpc(worker, { kind: "readHeld", index: 9 });
		assertEquals(read.value, 0x5A, "the worker should see a write made on this thread after the transfer");
	} finally {
		worker.terminate();
		mapping.close();
	}
});

Deno.test("concurrent access: this thread observes the worker's writes as they happen", async () => {
	const path = fixture("concurrent.bin");
	const mapping = Mmap.openSync(path, { write: true });

	const worker = spawn();
	try {
		const buffer = mapping.buffer();
		await rpc(worker, { kind: "hold", buffer }, [buffer]);

		const to = 15;
		const counting = rpc(worker, { kind: "countHeld", to, delayMs: 5 });

		// Poll our own view while the worker is mid-write. If the transfer had copied
		// the bytes, we would only ever see 0 here.
		const seen = new Set<number>();
		let done = false;
		counting.then(() => done = true);
		while (!done) {
			seen.add(mapping.bytes()[0]);
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await counting;

		assert(seen.size > 2, `expected to observe intermediate values, only saw ${[...seen].join(",")}`);
		assertEquals(mapping.bytes()[0], to, "the final counter value should be visible here");
	} finally {
		worker.terminate();
		mapping.close();
	}
});

Deno.test("terminating the worker does not unmap the pages it was holding", async () => {
	const path = fixture("terminate.bin");
	const mapping = Mmap.openSync(path, { write: true });

	const worker = spawn();
	const buffer = mapping.buffer();
	await rpc(worker, { kind: "hold", buffer }, [buffer]);
	await rpc(worker, { kind: "writeHeld", index: 0, value: 0x33 });

	// The transferred backing store has no owning deleter, so tearing down the receiving
	// isolate must not free our mapping. If it did, the read below would segfault.
	worker.terminate();
	await new Promise((resolve) => setTimeout(resolve, 50));

	assertEquals(mapping.bytes()[0], 0x33, "the mapping should still be readable after the worker is gone");
	mapping.close();
});
