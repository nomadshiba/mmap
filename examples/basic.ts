// Run: deno run --allow-ffi --allow-read --allow-write examples/basic.ts
import { Advice, Mmap } from "../mod.ts";

// Create a 64 KiB file and write into it, zero-copy.
using out = Mmap.openSync("scratch.bin", { write: true, ensureFileSize: 64 * 1024 });
out.advise(Advice.Sequential);

// Bind the view once and reuse it — every bytes()/view() call builds a new object.
const outBytes = out.bytes();
for (let i = 0; i < 256; i++) outBytes[i] = i;

const outView = out.view();
outView.setBigUint64(4096, 0xCAFEBABEn, true);

out.flush();
console.log("wrote scratch.bin:", out.length, "bytes");

// Reopen read-only and read a single page's worth back.
using inp = Mmap.openSync("scratch.bin");
const inBytes = inp.bytes();
const inView = inp.view();
console.log("byte[7] =", inBytes[7]);
console.log("u64 @4096 =", inView.getBigUint64(4096, true).toString(16));
