import type { Pool } from "pg";

import { createApp } from "./app";
import { createPool } from "./db/pool";

const PORT = process.env.PORT || 3000;

let pool: Pool;

try {
	pool = createPool();
} catch (error) {
	console.error(
		"Startup failed:",
		error instanceof Error ? error.message : error,
	);
	process.exit(1);
}

createApp(pool).listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);
});
