// Letting the worker map the same file itself — the simpler option.
// Run: deno run --allow-ffi --allow-read --allow-write examples/worker_own_map.ts
//
// We send only the path. The worker makes its own mmap() call, so it gets its own
// pointer, and the kernel keeps both mappings coherent through the page cache. Each
// side owns its own lifetime: `using` is fine here, because our close() cannot pull
// memory out from under the worker.
import { Mmap } from "../mod.ts";

const path = "own_map.bin";
using mapping = await Mmap.open(path, { write: true, ensureFileSize: 4096 });

const bytes = mapping.bytes();
bytes[0] = 0x01;
mapping.flush();
console.log("main: before worker, byte[0] =", bytes[0]);

const worker = new Worker(import.meta.resolve("./worker.ts"), { type: "module" });
try {
	const reply = await new Promise<{ before: number; wrote: number }>((resolve, reject) => {
		worker.onmessage = (e) => resolve(e.data);
		worker.onerror = (e) => {
			e.preventDefault();
			reject(e.error ?? new Error(e.message));
		};
		worker.postMessage({ path });
	});
	console.log("worker: saw", reply.before, "wrote", reply.wrote);
} finally {
	worker.terminate();
}

// Our mapping sees the worker's write, even though the pointers differ.
console.log("main: after worker, byte[0] =", bytes[0], "(0x42 =", 0x42, ")");
