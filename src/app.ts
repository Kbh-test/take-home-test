import express, { Request, Response } from "express";

const app = express();

app.use(express.json());

app.post("/ingest", (req: Request, res: Response) => {
	res.json({ message: "Ingesting form data" });
});

export default app;
