/// <reference lib="deno.worker" />
// Worker side of worker_test.ts. Two ways in:
//   - `ownMap`: we map the path ourselves — an independent mapping, coherent with the
//     caller's through the page cache, with no shared lifetime.
//   - the `buffer` requests: the caller transferred its Mmap's buffer(), so we are
//     touching *its* pages. `hold` keeps the view alive across messages so the test can
//     poke at it from both threads at once.
import { Mmap } from "../mod.ts";

type Request =
	| { kind: "ownMap"; path: string }
	| { kind: "read"; buffer: ArrayBuffer }
	| { kind: "hold"; buffer: ArrayBuffer }
	| { kind: "writeHeld"; index: number; value: number }
	| { kind: "readHeld"; index: number }
	| { kind: "countHeld"; to: number; delayMs: number };

let held: Uint8Array | null = null;

self.onmessage = async (e: MessageEvent<Request>) => {
	const req = e.data;
	switch (req.kind) {
		case "ownMap": {
			using own = Mmap.openSync(req.path);
			const bytes = own.bytes();
			self.postMessage({ byteLength: own.length, byte0: bytes[0] });
			return;
		}
		case "read": {
			const bytes = new Uint8Array(req.buffer);
			self.postMessage({ byteLength: req.buffer.byteLength, byte0: bytes[0] });
			return;
		}
		case "hold": {
			held = new Uint8Array(req.buffer);
			self.postMessage({ byteLength: held.length, byte0: held[0] });
			return;
		}
		case "writeHeld": {
			held![req.index] = req.value;
			self.postMessage({ value: held![req.index] });
			return;
		}
		case "readHeld": {
			self.postMessage({ value: held![req.index] });
			return;
		}
		case "countHeld": {
			// Write a rising counter while the main thread polls its own view of the
			// same pages, to prove the sharing is live rather than a copy at transfer.
			for (let i = 1; i <= req.to; i++) {
				held![0] = i;
				await new Promise((resolve) => setTimeout(resolve, req.delayMs));
			}
			self.postMessage({ done: true });
			return;
		}
	}
};
