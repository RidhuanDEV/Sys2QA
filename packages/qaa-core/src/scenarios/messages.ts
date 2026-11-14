/**
 * Scenario wording in each supported language (QAA-FR-037, LOC). Machine fields never depend on these texts; package
 * names, field names and conditions are inserted as written in the package.
 */
export type Language = "en" | "id";

type Params = Record<string, string | number>;
type Template = (p: Params) => string;

const EN: Record<string, Template> = {
  // What an item does.
  ep_valid: (p) => `Enter a valid ${p.field}`,
  ep_empty: (p) => `Leave ${p.field} empty`,
  bva_length: (p) => `Enter a ${p.field} of ${p.n} character(s)`,
  bva_value: (p) => `Enter ${p.field} = ${p.n}`,
  ep_non_integer: (p) => `Enter a ${p.field} with a fractional part`,
  ep_pattern: (p) => `Enter a ${p.field} of a valid length with a disallowed character (pattern ${p.pattern})`,
  ep_format: (p) => `Enter a ${p.field} that is not a valid ${p.format}`,
  ep_enum: (p) => `Enter a ${p.field} outside its allowed values`,
  dt_all_valid: () => "Fill every field with a valid value",
  dt_only: (p) => `Fill every field validly except one: violate "${p.rule}"`,
  dt_all_invalid: () => "Fill every field with an invalid value",
  st_move: (p) => `Move an item from ${p.from} to ${p.to}`,
  role_as: (p) => `Sign in as ${p.role} and request the guarded action`,
  role_anonymous: () => "Request the guarded action without signing in",
  error_trigger: (p) => `Bring about: ${p.condition}`,
  journey_main: (p) => `Go through ${p.workflow} from start to end`,
  journey_branch: (p) => `Take the branch where: ${p.condition}`,
  eg_whitespace: () => "Fill each field with leading and trailing spaces",
  eg_double_submit: () => "Submit the form twice in quick succession",
  // What is expected.
  accepted: () => "The input is accepted",
  rejected: (p) => (p.detail ? `The input is rejected (${p.detail})` : "The input is rejected"),
  allowed: () => "The action is allowed",
  denied: () => "The action is denied",
  refused: () => "The transition is refused",
  completes: () => "Every step completes",
  branch_outcome: (p) => `The outcome is ${p.outcome}`,
  http_response: (p) => `The response is HTTP ${p.status} ${p.outcome}${p.message ? ` ("${p.message}")` : ""}`,
  eg_consistent: () => "The values are handled consistently (trimmed or rejected, never silently changed)",
  eg_single_effect: () => "Only one submission takes effect",
  // Steps and labels.
  open_page: (p) => `Open ${p.page}.`,
  prepare: (p) => `Prepare a request to ${p.target}.`,
  perform: () => "Submit or perform the action and observe the result.",
  signed_in: (p) => `Signed in with the credential profile for ${p.role}.`,
  signed_out: () => "Not signed in.",
  item_in_state: (p) => `An item in state ${p.state} exists.`,
  reachable: (p) => `${p.page} is reachable.`,
  cleanup: () => "Remove what the scenario created, or reset the test data.",
  inferred: () => "QAA inference, not a documented requirement: confirm the expectation before relying on it.",
  observed_only: () => "Expected results come from observed behavior; internal effects are not asserted.",
  submission_unobserved: () => "Submitting this form was not observed; its effect is unknown.",
  title: (p) => `${p.what}: ${p.expected}`,
};

const ID: Record<string, Template> = {
  ep_valid: (p) => `Isi ${p.field} yang valid`,
  ep_empty: (p) => `Biarkan ${p.field} kosong`,
  bva_length: (p) => `Isi ${p.field} sepanjang ${p.n} karakter`,
  bva_value: (p) => `Isi ${p.field} = ${p.n}`,
  ep_non_integer: (p) => `Isi ${p.field} dengan bilangan pecahan`,
  ep_pattern: (p) =>
    `Isi ${p.field} dengan panjang valid tetapi berisi karakter yang tidak diizinkan (pola ${p.pattern})`,
  ep_format: (p) => `Isi ${p.field} yang bukan ${p.format} yang valid`,
  ep_enum: (p) => `Isi ${p.field} di luar nilai yang diizinkan`,
  dt_all_valid: () => "Isi semua field dengan nilai valid",
  dt_only: (p) => `Isi semua field dengan valid kecuali satu: langgar "${p.rule}"`,
  dt_all_invalid: () => "Isi semua field dengan nilai tidak valid",
  st_move: (p) => `Pindahkan item dari ${p.from} ke ${p.to}`,
  role_as: (p) => `Masuk sebagai ${p.role} lalu minta aksi yang dilindungi`,
  role_anonymous: () => "Minta aksi yang dilindungi tanpa masuk",
  error_trigger: (p) => `Timbulkan kondisi: ${p.condition}`,
  journey_main: (p) => `Jalani ${p.workflow} dari awal sampai akhir`,
  journey_branch: (p) => `Ambil cabang dengan kondisi: ${p.condition}`,
  eg_whitespace: () => "Isi setiap field dengan spasi di awal dan akhir",
  eg_double_submit: () => "Kirim formulir dua kali berturut-turut dengan cepat",
  accepted: () => "Input diterima",
  rejected: (p) => (p.detail ? `Input ditolak (${p.detail})` : "Input ditolak"),
  allowed: () => "Aksi diizinkan",
  denied: () => "Aksi ditolak",
  refused: () => "Transisi ditolak",
  completes: () => "Setiap langkah selesai",
  branch_outcome: (p) => `Hasilnya ${p.outcome}`,
  http_response: (p) => `Respons HTTP ${p.status} ${p.outcome}${p.message ? ` ("${p.message}")` : ""}`,
  eg_consistent: () => "Nilai ditangani secara konsisten (dipangkas atau ditolak, tidak diubah diam-diam)",
  eg_single_effect: () => "Hanya satu pengiriman yang berlaku",
  open_page: (p) => `Buka ${p.page}.`,
  prepare: (p) => `Siapkan permintaan ke ${p.target}.`,
  perform: () => "Kirim atau jalankan aksi lalu amati hasilnya.",
  signed_in: (p) => `Masuk dengan profil kredensial untuk ${p.role}.`,
  signed_out: () => "Belum masuk.",
  item_in_state: (p) => `Ada item dengan status ${p.state}.`,
  reachable: (p) => `${p.page} dapat diakses.`,
  cleanup: () => "Hapus data yang dibuat skenario, atau atur ulang data uji.",
  inferred: () => "Inferensi QAA, bukan requirement terdokumentasi: konfirmasi ekspektasi ini sebelum dipakai.",
  observed_only: () => "Hasil yang diharapkan berasal dari perilaku yang teramati; efek internal tidak diasersikan.",
  submission_unobserved: () => "Pengiriman formulir ini tidak teramati; efeknya tidak diketahui.",
  title: (p) => `${p.what}: ${p.expected}`,
};

const TABLES: Record<Language, Record<string, Template>> = { en: EN, id: ID };

export function say(language: Language, key: string, params: Params = {}): string {
  const template = TABLES[language][key] ?? TABLES.en[key];
  if (!template) throw new Error(`no message ${key}`);
  return template(params);
}

export const SUPPORTED_LANGUAGES: Language[] = ["en", "id"];
