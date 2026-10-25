import { describe, expect, it } from "vitest";
import { orderSchema, registrationSchema } from "../src/server/validation";

describe("registration validation", () => {
  it("requires a 13-digit NIB", () => {
    expect(registrationSchema.safeParse({ email: "a@b.co", password: "x".repeat(12), nib: "123456789012" }).success).toBe(false);
    expect(registrationSchema.safeParse({ email: "a@b.co", password: "x".repeat(12), nib: "1234567890123" }).success).toBe(true);
  });
});

describe("order validation", () => {
  it("accepts amounts from 1 to 10000", () => {
    expect(orderSchema.safeParse({ amount: 0 }).success).toBe(false);
    expect(orderSchema.safeParse({ amount: 10000 }).success).toBe(true);
  });
});
