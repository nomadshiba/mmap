> [!IMPORTANT]
> **This repo is moving to Nostr.** GitHub will stay as a mirror. New issues and patches go there.
>
> - Browse: [gitworkshop.dev/nomadshiba.me/mmap](https://gitworkshop.dev/nomadshiba.me/mmap)
> - Clone: `git clone nostr://nomadshiba.me/mmap`
>
> To clone `nostr://` URLs and send patches, install [ngit](https://ngit.dev). It's git collaboration over Nostr, with no accounts and no platform.
>
> <sub>If NIP-05 doesn't resolve: [gitworkshop (npub)](https://gitworkshop.dev/npub1gkp4cdh5rktehjqjnqc09awey4302dpadlka6mes4fu5spes7fhqfsppqk/mmap) · `nostr://npub1gkp4cdh5rktehjqjnqc09awey4302dpadlka6mes4fu5spes7fhqfsppqk/mmap`</sub>

# @nomadshiba/mmap

Zero-copy memory-mapped file I/O for **Deno**, via FFI — **no native addon and no prebuilt binary**. It binds the platform's own C library directly: `libc`
(`mmap`/`munmap`/`madvise`/`msync`) on Linux and macOS, and `kernel32` (`CreateFileMappingW`/`MapViewOfFile`/`FlushViewOfFile`) on Windows.

The mapped pages are handed to JavaScript as a real `Uint8Array` whose backing store **is** the mapping. Reads and writes touch the file's pages directly, with
no copy; pages fault in lazily from the OS page cache. Mapping a 1 GiB file costs a few dozen KiB of RSS until you actually touch pages.

```ts
import { Mmap } from "jsr:@nomadshiba/mmap";

using file = await Mmap.open("massive.bin");
const bytes = file.bytes();
console.log(bytes[102_432]); // faults in a single page, no full read
```

## Why not a native module?

Unlike NAN/N-API addons (node-gyp, per-platform prebuilds, postinstall compiles) or Rust-FFI libraries that download a `.so` from GitHub Releases at first run,
this package ships **only TypeScript**. The C library it calls is already on the machine. Nothing to build, nothing to download, nothing to trust beyond libc.

## Permissions

```
--allow-ffi --allow-read            # read-only maps
--allow-ffi --allow-read --allow-write   # write maps
```

`--allow-ffi` is effectively an all-access grant (native code runs outside the sandbox); only map files you trust the path of.

## Usage

### Read, zero-copy

```ts
import { Mmap } from "jsr:@nomadshiba/mmap";

using f = await Mmap.open("data.bin");

const bytes = f.bytes(); // Uint8Array over the file's pages
const first = bytes[0];

const view = f.view(); // DataView over the same memory
const n = view.getUint32(0, true);
```

`bytes()`/`view()`/`buffer()` each build a fresh object every call — none are cached — all over the same memory. Bind one to a variable and reuse it; calling
`f.bytes()[i]` in a loop allocates a new view per iteration for no reason.

### Create / write / flush

```ts
import { Mmap } from "jsr:@nomadshiba/mmap";

using out = await Mmap.open("out.bin", { write: true, ensureFileSize: 64 * 1024 });

const bytes = out.bytes();
bytes[0] = 0xff;

const view = out.view();
view.setBigUint64(8, 0xCAFEBABEn, true);

out.flush(); // msync(MS_SYNC) / FlushViewOfFile
```

`ensureFileSize` creates or extends the file so the mapping fits. Write maps use `MAP_SHARED`, so stores land in the page cache immediately and reach disk on
`flush()` (or when the kernel writes back).

### Windowed mapping

`byteOffset` need not be page-aligned — alignment is handled internally, and the returned view still starts exactly there. `length` defaults to the rest of the
file, and ends up as `m.length`.

```ts
import { Mmap } from "jsr:@nomadshiba/mmap";

// Map a 64 MiB window, 128 MiB into a large file.
using w = await Mmap.open("big.bin", { byteOffset: 128 * 1024 * 1024, length: 64 * 1024 * 1024 });
w.length; // 64 * 1024 * 1024

// Everything from 1 KiB onwards.
using tail = await Mmap.open("big.bin", { byteOffset: 1024 });
```

For files larger than you want to map at once (e.g. a multi-hundred-GiB index), map fixed-size windows and index into the right one — this also lets you unmap
cold regions.

### Access-pattern hints

```ts
import { Advice, Mmap } from "jsr:@nomadshiba/mmap";

using idx = await Mmap.open("hashtable.bin", { write: true });
idx.advise(Advice.Random); // point lookups — suppress read-ahead

using chunk = await Mmap.open("chunk.bin");
chunk.advise(Advice.Sequential); // full scan — aggressive read-ahead
```

`advise` is a no-op on Windows (no direct `madvise` equivalent); it never affects correctness, only kernel heuristics.

### Workers, option A: each thread maps the file itself

Every `open`/`openSync` call maps the file independently — no sharing, caching, or deduplication between calls, even for the same path. Two mappings of one file
each get their own pointer:

```ts
import { Mmap } from "jsr:@nomadshiba/mmap";

using a = await Mmap.open("data.bin");
using b = await Mmap.open("data.bin"); // a second, independent mmap() call
Deno.UnsafePointer.value(a.pointer) !== Deno.UnsafePointer.value(b.pointer); // true
```

Different pointers, but both are `MAP_SHARED` views of the same page cache, so they are the same physical memory: a store through one shows up through the other
**immediately, with no `flush()`** (see [memory & coherence](#memory--coherence)). That works across threads too — a worker just opens the same path:

```ts
// main.ts
import { Mmap } from "jsr:@nomadshiba/mmap";

using state = await Mmap.open("state.bin", { write: true, ensureFileSize: 4096 });
const view = state.view();
view.setUint32(0, 1, true); // no flush needed for the worker to see this

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.postMessage("state.bin"); // just the path
```

```ts ignore
// worker.ts
import { Mmap } from "jsr:@nomadshiba/mmap";

self.onmessage = async (e: MessageEvent<string>) => {
	using state = await Mmap.open(e.data, { write: true });
	const view = state.view();
	view.getUint32(0, true); // 1 — its own mapping, coherent with main.ts's write
};
```

This is the simplest option, and each side owns its own lifetime — no coordination needed before closing. Downside: an `mmap()` call per thread, and the worker
needs read (and write) permission for the path.

### Workers, option B: transfer a `buffer()` — genuinely shared memory

`buffer()` returns a real `ArrayBuffer`, and transferring it moves V8's _backing store_ — which points at the mapped pages. So the worker does not get a copy:
it gets the same physical memory. Writes are visible in both directions, live. It behaves like a file-backed `SharedArrayBuffer`.

```ts
// main.ts
import { Mmap } from "jsr:@nomadshiba/mmap";

const mapping = await Mmap.open("shared.bin", { write: true, ensureFileSize: 4096 });
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

const buffer = mapping.buffer();
worker.postMessage(buffer, [buffer]); // transferred: detached here, live there
buffer.byteLength; // 0 — this object is detached, but the Mmap is fine

// The worker's writes land in our pages. A fresh bytes() reads them back.
await new Promise<void>((resolve) => {
	worker.onmessage = () => resolve();
});
const bytes = mapping.bytes();
console.log(bytes[0]); // whatever the worker wrote

// Only now, after the worker said it's done, is it safe to unmap.
mapping.close();
```

```ts ignore
// worker.ts
self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
	const bytes = new Uint8Array(e.data);
	bytes[0] = 0x42; // writes straight into main's mapping
	self.postMessage("done"); // tell main it is safe to close()
};
```

Transferring detaches only _that_ `ArrayBuffer` object. The `Mmap` itself is untouched, so `bytes()`/`view()`/`buffer()` keep working, and you can transfer a
second buffer to a second worker to share the same pages three ways.

**The one rule: don't `close()` while another thread still holds it.** `close()` calls `munmap()`, which invalidates the address for the entire process, so the
worker's next touch segfaults — uncatchable. Have the worker acknowledge it's done first, as above, and remember that `using` calls `close()` at scope exit,
which is easy to do accidentally:

```ts ignore
// DON'T: `using` unmaps at the end of the block, while the worker is still holding the buffer.
using mapping = await Mmap.open("shared.bin", { write: true });
const buffer = mapping.buffer();
worker.postMessage(buffer, [buffer]);
// scope ends here -> munmap() -> worker segfaults on its next write
```

If you don't actually need shared memory, copy instead (`mapping.bytes().slice()`) and the lifetime problem disappears.

Both options are runnable: [`examples/worker_shared.ts`](examples/worker_shared.ts) and [`examples/worker_own_map.ts`](examples/worker_own_map.ts), sharing
[`examples/worker.ts`](examples/worker.ts).

## API

### `Mmap.open(path, options?): Promise<Mmap>` / `Mmap.openSync(path, options?): Mmap`

| option           | type      | default          | meaning                                                                                                                                            |
| ---------------- | --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write`          | `boolean` | `false`          | Map read-write (`MAP_SHARED`). Needs `--allow-write`.                                                                                              |
| `byteOffset`     | `number`  | `0`              | Offset into the file where the mapping starts (any value; auto-aligned internally).                                                                |
| `length`         | `number`  | rest of the file | How many bytes to map from `byteOffset` — becomes `m.length`. Must fit within the file (after `ensureFileSize`, if given); doesn't grow it itself. |
| `ensureFileSize` | `number`  | —                | Ensure the file is at least this large. Requires `write: true` — throws otherwise.                                                                 |

### `class Mmap`

| member                             | description                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bytes(): Uint8Array`              | A fresh zero-copy view of the mapped region. A new object every call — none are cached.          |
| `view(): DataView`                 | A fresh `DataView` over the same memory. Same fresh-per-call rule as `bytes()`.                  |
| `buffer(): ArrayBuffer`            | A fresh raw `ArrayBuffer` over the mapped region. Transferable to a `Worker` — shares the pages. |
| `length: number`                   | View length in bytes.                                                                            |
| `writable: boolean`                | Whether opened read-write.                                                                       |
| `pointer: Deno.PointerValue`       | Pointer to the first byte, for other FFI. `null` once closed — check before using.               |
| `advise(advice, offset?, length?)` | `madvise` hint (no-op on Windows).                                                               |
| `flush(offset?, length?)`          | `msync(MS_SYNC)` / `FlushViewOfFile`. Blocking — see below.                                      |
| `close()`                          | `munmap()`, process-wide. Idempotent.                                                            |
| `[Symbol.dispose]()`               | Enables `using`.                                                                                 |

### `enum Advice`

`Normal`, `Random`, `Sequential`, `WillNeed`, `DontNeed`.

## Lifecycle — read this

`bytes()`/`view()`/`buffer()` are **live windows into mapped memory**, not owned buffers. Three ways to crash the process — **none are catchable JS errors**,
all are immediate `SIGSEGV`/`SIGBUS`:

- **Use after close.** After `close()` (or a `using` block ending), the region is unmapped; touching a `bytes()`/`view()`/`buffer()` result from before that
  segfaults. `munmap()` is process-wide, so this includes a buffer you transferred to a `Worker` — see
  [option B](#workers-option-b-transfer-a-buffer--genuinely-shared-memory).
- **Writing through a read-only mapping.** If `writable` is `false`, the pages are `PROT_READ`-only and any write segfaults.
- **The file shrinking under you.** If another process truncates the file below the mapped range, the next touch of a now-invalid page raises `SIGBUS` —
  read-only mappings included, since they observe the file's current size through the shared page cache.

Rules:

- Prefer `using m = await Mmap.open(...)` so the mapping is disposed at scope end — except when you've transferred a buffer out, where scope exit is exactly the
  bug.
- Never let a `bytes()`/`view()`/`buffer()` result outlive the `Mmap`, on any thread.
- Don't hold a view across a remap/grow of the same region.
- Don't write through a mapping opened without `write: true`.
- Don't truncate a mapped file (from any process) unless every mapper agreed to it.

The library never auto-unmaps on GC — that could pull memory out from under a live view. The OS reclaims mappings on process exit regardless.

## Memory & coherence

Every mapping is `MAP_SHARED`, even read-only ones, so a mapping is a window onto the kernel's page cache for that file — not a private buffer. Two consequences
worth knowing:

**Mapping a file N times does not use N times the RAM.** Each mapping gets its own virtual addresses and its own page-table entries, but they resolve to the
_same physical pages_. Measured with 8 mappings of one 256 MiB file, every page touched through all 8:

| metric                               | value    | what it means                                |
| ------------------------------------ | -------- | -------------------------------------------- |
| naive expectation (8 x 256 MiB)      | 2048 MiB | what it would cost if pages were copied      |
| process `RSS`                        | 2048 MiB | **misleading** — counts each mapping in full |
| sum of `Pss` from `/proc/self/smaps` | 256 MiB  | the truth: shared pages divided by sharers   |
| `VmPTE` growth per extra mapping     | 0.50 MiB | page tables — 0.2% of the mapped size        |

So the real cost of an extra mapping is virtual address space plus ~0.2% of its size in page tables (only for pages you touch), and one kernel `vm_area_struct`.
Note that **`RSS` overstates memory for mapped files** — if you monitor RSS, use `Pss`/`smaps_rollup` instead.

**Stores are visible everywhere immediately, without `flush()`.** Since it's one set of physical pages, there is nothing to propagate. A write through one
mapping is observable through:

- another mapping of the same file, read-write or read-only;
- an overlapping window mapping, even at a different `byteOffset` alignment;
- another thread or another process that mapped the same path;
- a plain `read()` on the file.

`flush()` is **durability only** — it forces dirty pages to disk so they survive a crash. It is never needed for visibility. (These are all covered by the
`coherence:` tests in `test/mmap_test.ts`.)

## Notes

- **Size limits.** On 64-bit V8 an `ArrayBuffer`/`Uint8Array` can exceed 2 GiB, so a single large map is possible, but windowing the very large cases is
  recommended for portability and address-space hygiene.
- **Page size** is queried at load (`getpagesize` / `GetSystemInfo`), so Apple Silicon's 16 KiB pages and Windows' 64 KiB allocation granularity are handled.
- **Windows** uses `CreateFileW` (UTF-16), so non-ASCII paths work.
- **`flush()` blocks the event loop.** It's a synchronous FFI call; `msync(MS_SYNC)`/`FlushViewOfFile` don't return until the dirty range has hit disk, which
  can be tens to hundreds of ms for large ranges. There's currently no async variant — avoid flushing large dirty ranges from latency-sensitive code paths.
- **Error messages include the OS detail** where available (`strerror(3)` on POSIX, `FormatMessageW` on Windows), e.g.
  `open failed: /x: Permission denied
  (errno 13)`.

## Platform support & test status

| OS      | Backend             | Status                         |
| ------- | ------------------- | ------------------------------ |
| Linux   | `libc.so.6`         | Verified (test suite passes).  |
| macOS   | `libSystem.B.dylib` | Written to the documented ABI. |
| Windows | `kernel32.dll`      | Written to the documented ABI. |

The macOS and Windows paths are implemented against the documented libc/Win32 ABIs but were authored on Linux; run `deno task test` on those platforms to
confirm before relying on them.

## Testing

```
deno task test
# deno test --allow-ffi --allow-read --allow-write
```

## License

[LGPL v2.1](LICENSE)
