// Sharing one mapping with a worker by transferring buffer().
// Run: deno run --allow-ffi --allow-read --allow-write examples/worker_shared.ts
//
// Transferring an ArrayBuffer moves V8's backing store, and this backing store points
// at the mapped pages — so the worker gets the *same memory*, not a copy. Effectively
// a file-backed SharedArrayBuffer.
//
// NOTE: no `using` here, deliberately. Scope exit would call close() -> munmap(), and
// that invalidates the pages for every thread in the process. We close by hand, only
// after the worker confirms it is done.
import { Mmap } from "../mod.ts";

const path = "shared.bin";
const mapping = await Mmap.open(path, { write: true, ensureFileSize: 4096 });

const bytes = mapping.bytes();
bytes[0] = 0x01;
console.log("main: before transfer, byte[0] =", bytes[0]);

const worker = new Worker(import.meta.resolve("./worker.ts"), { type: "module" });

const buffer = mapping.buffer();
const reply = await new Promise<{ before: number; wrote: number }>((resolve, reject) => {
	worker.onmessage = (e) => resolve(e.data);
	worker.onerror = (e) => {
		e.preventDefault();
		reject(e.error ?? new Error(e.message));
	};
	worker.postMessage({ buffer }, [buffer]);
});

// That one ArrayBuffer object is detached here now...
console.log("main: transferred buffer detached?", buffer.byteLength === 0);
console.log("worker: saw", reply.before, "wrote", reply.wrote);

// ...but the Mmap is untouched, and a fresh view reads the worker's write.
const after = mapping.bytes();
console.log("main: after worker, byte[0] =", after[0], "(0x42 =", 0x42, ")");

mapping.flush();

// Safe: the worker already replied, so nothing is holding the pages.
worker.terminate();
mapping.close();
console.log("main: closed");
