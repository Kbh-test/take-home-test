import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
	entryPoints: ["src/client/home.tsx", "src/client/workers.tsx"],
	bundle: true,
	platform: "browser",
	target: "es2022",
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	minify: true,
	outdir: "dist/src/public",
	entryNames: "[name]",
});

await copyFile("src/pages/workers.css", "dist/src/public/workers.css");
