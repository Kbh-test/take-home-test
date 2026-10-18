import { useCallback, useEffect, useState } from "react";

type PollingState<T> = {
	data: T[];
	error: string | null;
	loading: boolean;
	refresh: () => void;
};

export function usePolling<T>(url: string): PollingState<T> {
	const [data, setData] = useState<T[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshCount, setRefreshCount] = useState(0);
	const refresh = useCallback(() => setRefreshCount((count) => count + 1), []);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const response = await fetch(url, { cache: refreshCount > 0 ? "no-cache" : "default" });
				const result: unknown = await response.json();
				if (!response.ok) {
					const message =
						typeof result === "object" && result !== null && "error" in result
							? String(result.error)
							: "Could not load data";
					throw new Error(message);
				}
				if (!Array.isArray(result)) throw new Error("Unexpected response from server");
				if (active) {
					setData(result as T[]);
					setError(null);
				}
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : "Could not load data");
			} finally {
				if (active) setLoading(false);
			}
		};

		void load();
		const timer = window.setInterval(load, 5_000);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [url, refreshCount]);

	return { data, error, loading, refresh };
}
