import { PrismaClient } from "../generated";

export const db = new PrismaClient() as unknown as {
  user: { create(a: unknown): Promise<{ id: string; email: string }>; findUnique(a: unknown): Promise<{ id: string; email: string; passwordHash: string; role: string } | null>; findMany(a?: unknown): Promise<unknown[]>; update(a: unknown): Promise<unknown> };
  order: { create(a: unknown): Promise<{ id: string }>; findUnique(a: unknown): Promise<{ id: string; status: string; customerId: string } | null>; update(a: unknown): Promise<unknown>; deleteMany(a: unknown): Promise<unknown> };
  passwordResetToken: { create(a: unknown): Promise<unknown>; findUnique(a: unknown): Promise<{ userId: string; expiresAt: Date } | null>; deleteMany(a: unknown): Promise<unknown> };
};
