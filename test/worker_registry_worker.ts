/// <reference lib="deno.worker" />
// Helper module for worker_registry_test.ts — runs inside a `Worker`.
// Attaches to the `MmapRegistry` sent by the main thread, opens the same file it did, and reports
// back the resulting pointer/bytes so the test can assert they match across isolates.
import { Mmap, MmapRegistry } from "../mod.ts";

self.onmessage = async (e: MessageEvent<{ path: string; buffer: SharedArrayBuffer }>) => {
	const registry = MmapRegistry.from(e.data.buffer);
	using f = await Mmap.open(e.data.path, { registry });
	self.postMessage({ pointer: Deno.UnsafePointer.value(f.pointer), byte0: f.bytes[0] });
};
