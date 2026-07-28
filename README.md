# @nomadshiba/mmap

Zero-copy memory-mapped file I/O for **Deno**, via FFI — **no native addon and no prebuilt binary**. It binds the platform's own C library directly: `libc`
(`mmap`/`munmap`/`madvise`/`msync`) on Linux and macOS, and `kernel32` (`CreateFileMappingW`/`MapViewOfFile`/`FlushViewOfFile`) on Windows.

The mapped pages are handed to JavaScript as a real `Uint8Array` whose backing store **is** the mapping. Reads and writes touch the file's pages directly, with
no copy; pages fault in lazily from the OS page cache. Mapping a 1 GiB file costs a few dozen KiB of RSS until you actually touch pages.

```ts
import { Mmap } from "jsr:@nomadshiba/mmap";

using file = await Mmap.open("massive.bin");
console.log(file.bytes[102_432]); // faults in a single page, no full read
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
const b = f.bytes; // Uint8Array over the file's pages
const n = f.view.getUint32(0, true); // DataView over the same memory
```

### Create / write / flush

```ts
import { Mmap } from "jsr:@nomadshiba/mmap";

using out = await Mmap.open("out.bin", { write: true, size: 64 * 1024 });
out.bytes[0] = 0xff;
out.view.setBigUint64(8, 0xCAFEBABEn, true);
out.flush(); // msync(MS_SYNC) / FlushViewOfFile
```

`size` creates or extends the file so the mapping fits. Write maps use `MAP_SHARED`, so stores land in the page cache immediately and reach disk on `flush()`
(or when the kernel writes back).

### Windowed / offset mapping

Offsets need not be page-aligned — alignment is handled internally and the returned view starts exactly at your requested `offset`.

```ts
import { Mmap } from "jsr:@nomadshiba/mmap";

// Map a 64 MiB window 128 MiB into a large file.
using w = await Mmap.open("big.bin", { offset: 128 * 1024 * 1024, length: 64 * 1024 * 1024 });
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

## API

### `Mmap.open(path, options?): Promise<Mmap>` / `Mmap.openSync(path, options?): Mmap`

| option   | type               | default              | meaning                                                                            |
| -------- | ------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| `write`  | `boolean`          | `false`              | Map read-write (`MAP_SHARED`). Needs `--allow-write`.                              |
| `offset` | `number \| bigint` | `0`                  | Start offset into the file (any value; auto-aligned).                              |
| `length` | `number \| bigint` | file size − `offset` | Bytes to map.                                                                      |
| `size`   | `number \| bigint` | —                    | Ensure the file is at least this large. Requires `write: true` — throws otherwise. |

### `class Mmap`

| member                             | description                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| `bytes: Uint8Array`                | Zero-copy view of the mapped region.                        |
| `view: DataView`                   | `DataView` over the same memory.                            |
| `length: number`                   | View length in bytes.                                       |
| `writable: boolean`                | Whether opened read-write.                                  |
| `pointer: Deno.PointerValue`       | Pointer to the first byte, for other FFI.                   |
| `advise(advice, offset?, length?)` | `madvise` hint (no-op on Windows).                          |
| `flush(offset?, length?)`          | `msync(MS_SYNC)` / `FlushViewOfFile`. Blocking — see below. |
| `close()`                          | Unmap. Idempotent.                                          |
| `[Symbol.dispose]()`               | Enables `using`.                                            |

### `enum Advice`

`Normal`, `Random`, `Sequential`, `WillNeed`, `DontNeed`.

## Lifecycle — read this

`bytes`/`view` are a **live window into mapped memory**, not an owned buffer. Three ways to crash the process — **none are catchable JS errors**, all are
immediate `SIGSEGV`/`SIGBUS`:

- **Use-after-close.** After `close()` (or a `using` block ending), the region is unmapped; touching a previously captured `bytes`/`view` segfaults.
- **Writing through a read-only mapping.** If `writable` is `false`, the pages are `PROT_READ`-only — any write, even `m.bytes[0] = 1`, segfaults.
- **The file shrinking under you.** If another process truncates the file below the mapped range, touching a now-invalid page raises `SIGBUS` on the next access
  — this applies to read-only mappings too, since they still observe the file's current size via the shared page cache.

Rules:

- Prefer `using m = await Mmap.open(...)` so the mapping is disposed at scope end.
- Never let a captured `bytes`/`view` outlive the `Mmap`.
- Don't hold a view across a remap/grow of the same region.
- Don't write through a mapping opened without `write: true`.
- Don't truncate a file (from any process) while it's mapped, unless you've coordinated that with every mapper.

The library never auto-unmaps on GC (that could pull memory out from under a still-live view). The OS reclaims mappings on process exit regardless.

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
