import type { TransformedFormSchema } from "../forms/schemas/transformed_schema";

export type Email = { to: string; from: string; subject: string; body: string };

export type Coordinates = { longitude: number; latitude: number };

export type FormBotDelivery = { idempotencyKey: string; form: TransformedFormSchema };
