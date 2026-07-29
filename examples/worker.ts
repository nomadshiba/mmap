/// <reference lib="deno.worker" />
// The worker side of examples/worker_shared.ts and examples/worker_own_map.ts.
//
// Two ways to reach the same file, one message handler each:
//   - `{ buffer }`: main transferred its Mmap's buffer(). This is the *same memory*
//     as main's mapping, not a copy — writes here are visible there immediately.
//     We must tell main when we're done, because main's close() unmaps these pages
//     for the whole process.
//   - `{ path }`: we map the file ourselves. Separate mmap() call, separate pointer,
//     kept coherent by the kernel's page cache. No lifetime coupling with main.
import { Mmap } from "../mod.ts";

type Request = { buffer: ArrayBuffer } | { path: string };

self.onmessage = (e: MessageEvent<Request>) => {
	if ("buffer" in e.data) {
		const bytes = new Uint8Array(e.data.buffer);
		const before = bytes[0];
		bytes[0] = 0x42; // writes straight into main's mapping

		// Reply only when we are truly finished touching the memory: main waits for
		// this before calling close().
		self.postMessage({ mode: "shared", before, wrote: bytes[0] });
		return;
	}

	// Our own independent mapping. `using` closes it at the end of this handler,
	// which only unmaps *our* mapping — main's is unaffected.
	using own = Mmap.openSync(e.data.path, { write: true });
	const bytes = own.bytes();
	const before = bytes[0];
	bytes[0] = 0x42;
	own.flush();

	self.postMessage({ mode: "own", before, wrote: bytes[0] });
};
