export default function handler(_req: unknown, res: { json(body: unknown): void }) {
  res.json({ ok: true });
}
