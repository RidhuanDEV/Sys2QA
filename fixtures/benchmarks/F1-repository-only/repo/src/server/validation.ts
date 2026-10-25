import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 12;

export const registrationSchema = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH),
  nib: z.string().regex(/^[0-9]{13}$/, "NIB must be exactly 13 digits"),
});

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export const orderSchema = z.object({
  amount: z.number().int().min(1).max(10000),
});
