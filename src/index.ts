import app from "./app";
import { databaseUrl } from "./db/config";

const PORT = process.env.PORT || 3000;

try {
	databaseUrl();
} catch (error) {
	console.error(
		"Startup failed:",
		error instanceof Error ? error.message : error,
	);
	process.exit(1);
}

app.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);
});
