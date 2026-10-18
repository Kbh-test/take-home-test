import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

let contents = "";

try {
	contents = readFileSync(".env", "utf8");
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
		throw error;
	}
}

for (const [key, value] of Object.entries(parseEnv(contents))) {
	process.env[key] ??= value;
}
