// Run: deno run --allow-ffi --allow-read --allow-write examples/basic.ts
import { Advice, Mmap } from "../mod.ts";

// Create a 64 KiB file and write into it, zero-copy.
using out = Mmap.openSync("scratch.bin", { write: true, size: 64 * 1024 });
out.advise(Advice.Sequential);
for (let i = 0; i < 256; i++) out.bytes[i] = i;
out.view.setBigUint64(4096, 0xCAFEBABEn, true);
out.flush();
console.log("wrote scratch.bin:", out.length, "bytes");

// Reopen read-only and read a single page's worth back.
using inp = Mmap.openSync("scratch.bin");
console.log("byte[7] =", inp.bytes[7]);
console.log("u64 @4096 =", inp.view.getBigUint64(4096, true).toString(16));
