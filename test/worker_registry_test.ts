// Cross-worker pointer sharing via MmapRegistry.
// Run with: deno test --allow-ffi --allow-read --allow-write
import { Mmap, MmapRegistry } from "../mod.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
	if (actual !== expected) {
		throw new Error(msg ?? `expected ${expected}, got ${actual}`);
	}
}

Deno.test("MmapRegistry: a Worker sharing the registry gets the identical pointer", async () => {
	const tmp = Deno.makeTempDirSync();
	const path = `${tmp}/shared.bin`;
	Deno.writeFileSync(path, new Uint8Array([0xAB, 1, 2, 3]));

	const registry = MmapRegistry.create();
	using main = await Mmap.open(path, { registry });
	const mainPointer = Deno.UnsafePointer.value(main.pointer);
	assertEquals(main.bytes[0], 0xAB);

	const worker = new Worker(new URL("./worker_registry_worker.ts", import.meta.url).href, {
		type: "module",
	});
	try {
		const result = await new Promise<{ pointer: bigint; byte0: number }>((resolve, reject) => {
			worker.onmessage = (e) => resolve(e.data);
			worker.onerror = (e) => reject(e.error ?? new Error(e.message));
			worker.postMessage({ path, buffer: registry.buffer });
		});

		assertEquals(result.pointer, mainPointer, "worker's pointer should equal the main thread's pointer");
		assertEquals(result.byte0, 0xAB, "worker should read the same mapped memory");
	} finally {
		worker.terminate();
	}
});
