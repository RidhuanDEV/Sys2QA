import { config } from "./config";

/** Sends a transactional email through the external mail provider. Delivery is confirmed asynchronously by the provider. */
export async function sendEmail(to: string, template: "welcome" | "password-reset" | "order-approved", data: Record<string, string>): Promise<void> {
  await fetch(config.emailApiUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, template, data }),
  });
}
