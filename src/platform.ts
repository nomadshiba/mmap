/** Supported operating systems. */
export type Os = "linux" | "darwin" | "windows";

function detect(): Os {
	const b = Deno.build.os;
	if (b === "linux" || b === "darwin" || b === "windows") return b;
	throw new Error(`@nomadshiba/mmap: unsupported OS "${b}"`);
}

/** The current operating system. */
export const os: Os = detect();
