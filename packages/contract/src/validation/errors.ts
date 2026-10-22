import type { LangText, Sys2QaError } from "../generated/types.js";

/** Error catalog (Contract Specification §9, PRD §13.10). The only definition of error codes in Sys2QA. */
export const ERROR_CATALOG = {
  PKG_NOT_FOUND: entry(
    "error",
    ["Package not found or unreadable.", "Package tidak ditemukan atau tidak dapat dibaca."],
    [
      "Select an existing package directory or archive, or export one with the SAA CLI.",
      "Pilih direktori atau arsip package yang ada, atau ekspor package dengan CLI SAA.",
    ],
  ),
  PKG_MANIFEST_INVALID: entry(
    "error",
    ["The package manifest is missing or invalid.", "Manifest package tidak ada atau tidak valid."],
    [
      "Re-export the package with a compatible Sys2QA version.",
      "Ekspor ulang package dengan versi Sys2QA yang kompatibel.",
    ],
  ),
  PKG_SCHEMA_UNSUPPORTED_MAJOR: entry(
    "error",
    [
      "The package uses an unsupported contract major version.",
      "Package memakai versi mayor kontrak yang tidak didukung.",
    ],
    [
      "Use a Sys2QA version that supports this contract version, or re-export the package.",
      "Gunakan versi Sys2QA yang mendukung versi kontrak ini, atau ekspor ulang package.",
    ],
  ),
  PKG_ARTIFACT_MISSING: entry(
    "error",
    [
      "An artifact listed in the manifest, or a required artifact, is missing.",
      "Artefak yang tercantum di manifest, atau artefak wajib, tidak ada.",
    ],
    ["Re-export the complete package.", "Ekspor ulang package secara lengkap."],
  ),
  PKG_CHECKSUM_MISMATCH: entry(
    "error",
    ["An artifact does not match its checksum.", "Sebuah artefak tidak cocok dengan checksum-nya."],
    [
      "The package may be corrupt or modified. Re-export it from the source.",
      "Package mungkin rusak atau diubah. Ekspor ulang dari sumbernya.",
    ],
  ),
  PKG_ARTIFACT_INVALID: entry(
    "error",
    ["An artifact is invalid.", "Sebuah artefak tidak valid."],
    [
      "Re-export the package; if it persists, report a producer defect.",
      "Ekspor ulang package; jika tetap terjadi, laporkan sebagai defect pada producer.",
    ],
  ),
  PKG_REFERENCE_BROKEN: entry(
    "error",
    ["The package references IDs that do not exist.", "Package merujuk ID yang tidak ada."],
    [
      "Re-export the package; dangling references indicate a producer defect.",
      "Ekspor ulang package; referensi yang menggantung menandakan defect pada producer.",
    ],
  ),
  PKG_ANALYSIS_FAILED: entry(
    "error",
    [
      "The analysis behind this package failed or was cancelled.",
      "Analisis di balik package ini gagal atau dibatalkan.",
    ],
    ["Run the analysis again and export a new package.", "Jalankan analisis lagi dan ekspor package baru."],
  ),
  PKG_SECRET_SUSPECTED: entry(
    "error",
    [
      "The package appears to contain a secret value or an over-long excerpt.",
      "Package tampaknya berisi nilai rahasia atau kutipan yang terlalu panjang.",
    ],
    [
      "Do not share this package. Re-export it with redaction enabled.",
      "Jangan bagikan package ini. Ekspor ulang dengan redaksi aktif.",
    ],
  ),
  PKG_EVIDENCE_REVISION_MISMATCH: entry(
    "error",
    [
      "Evidence does not belong to the package's revision or observation window.",
      "Bukti tidak berasal dari revisi atau jendela observasi package ini.",
    ],
    [
      "Re-run the analysis so that all evidence comes from one revision.",
      "Jalankan ulang analisis agar semua bukti berasal dari satu revisi.",
    ],
  ),
  PKG_EVIDENCE_PROFILE_INCONSISTENT: entry(
    "error",
    [
      "The evidence profile does not match the evidence or producer in the package.",
      "Evidence profile tidak sesuai dengan bukti atau producer di dalam package.",
    ],
    [
      "Re-export the package; producers must only publish their own evidence types.",
      "Ekspor ulang package; producer hanya boleh menerbitkan jenis buktinya sendiri.",
    ],
  ),
  PKG_CLAIM_EXCEEDS_EVIDENCE: entry(
    "error",
    [
      "A claim states more certainty than its evidence supports.",
      "Sebuah klaim menyatakan kepastian melebihi yang didukung buktinya.",
    ],
    [
      "Report a producer defect; the claim must be narrowed or labeled inferred.",
      "Laporkan defect pada producer; klaim harus dipersempit atau diberi label inferred.",
    ],
  ),
  PKG_ANALYSIS_PARTIAL: entry(
    "warning",
    ["The analysis behind this package is partial.", "Analisis di balik package ini bersifat parsial."],
    [
      "Use the package for review only, or run a fuller analysis.",
      "Gunakan package hanya untuk review, atau jalankan analisis yang lebih lengkap.",
    ],
  ),
  PKG_REVISION_MISMATCH: entry(
    "warning",
    ["The package revision differs from the project baseline.", "Revisi package berbeda dari baseline proyek."],
    [
      "Re-analyze the current revision, or confirm the baseline explicitly.",
      "Analisis ulang revisi saat ini, atau konfirmasi baseline secara eksplisit.",
    ],
  ),
  PKG_REVISION_UNVERIFIABLE: entry(
    "warning",
    ["The deployed revision of the environment is unknown.", "Revisi yang ter-deploy di environment tidak diketahui."],
    [
      "Confirm which revision the environment runs before approving execution.",
      "Konfirmasi revisi yang berjalan di environment sebelum menyetujui eksekusi.",
    ],
  ),
  PKG_DIRTY_OR_NON_GIT: entry(
    "warning",
    [
      "The package was analyzed from uncommitted or non-Git sources.",
      "Package dianalisis dari source yang belum di-commit atau bukan Git.",
    ],
    [
      "Readiness is review-only until the baseline is confirmed.",
      "Kesiapan hanya untuk review sampai baseline dikonfirmasi.",
    ],
  ),
  PKG_MARKDOWN_ONLY: entry(
    "warning",
    ["The package has no structured artifacts.", "Package tidak memiliki artefak terstruktur."],
    [
      "Structure will be inferred from Markdown with lower confidence; export a full package if possible.",
      "Struktur akan disimpulkan dari Markdown dengan keyakinan lebih rendah; ekspor package lengkap bila memungkinkan.",
    ],
  ),
  PKG_MINOR_NEWER: entry(
    "info",
    ["The package uses a newer minor contract version.", "Package memakai versi minor kontrak yang lebih baru."],
    [
      "No action needed; unknown fields are preserved.",
      "Tidak perlu tindakan; field yang tidak dikenal tetap disimpan.",
    ],
  ),
  PKG_LANGUAGE_UNAVAILABLE: entry(
    "info",
    [
      "The requested documentation language is not in the package.",
      "Bahasa dokumentasi yang diminta tidak ada di package.",
    ],
    [
      "The best available language is shown and marked as a fallback.",
      "Bahasa terbaik yang tersedia ditampilkan dan ditandai sebagai fallback.",
    ],
  ),
  PKG_UNLISTED_FILE: entry(
    "info",
    [
      "The package contains a file not listed in the manifest.",
      "Package berisi file yang tidak tercantum di manifest.",
    ],
    ["The file is ignored.", "File tersebut diabaikan."],
  ),
  CONTRACT_SCHEMA_INVALID: entry(
    "error",
    ["The document does not match its contract schema.", "Dokumen tidak sesuai dengan schema kontraknya."],
    ["Fix the reported fields and validate again.", "Perbaiki field yang dilaporkan lalu validasi lagi."],
  ),
  SCN_OBJECTIVE_INCONSISTENT: entry(
    "error",
    [
      "The scenario's QA objective is not supported by its expected-result bases.",
      "Tujuan QA skenario tidak didukung oleh basis expected result-nya.",
    ],
    ["Change the QA objective or strengthen the test basis.", "Ubah tujuan QA atau perkuat test basis-nya."],
  ),
  SCN_NOT_AUTOMATABLE: entry(
    "error",
    ["The scenario cannot be automated as classified.", "Skenario tidak dapat diotomatisasi sesuai klasifikasinya."],
    [
      "Add supported automation actions and oracles, or classify it for manual execution.",
      "Tambahkan aksi otomasi dan oracle yang didukung, atau klasifikasikan untuk eksekusi manual.",
    ],
  ),
  SCN_ORACLE_INCONSISTENT: entry(
    "error",
    [
      "An expected result's oracle class does not follow from its basis.",
      "Kelas oracle sebuah expected result tidak sesuai dengan basisnya.",
    ],
    ["Let the oracle class be derived from the basis.", "Biarkan kelas oracle diturunkan dari basisnya."],
  ),
  SCN_BASIS_INVALID: entry(
    "error",
    [
      "An expected result has a basis that cannot be used in this scenario state.",
      "Sebuah expected result memiliki basis yang tidak dapat dipakai pada status skenario ini.",
    ],
    [
      "Resolve the open question or mark the scenario as needing clarification.",
      "Selesaikan pertanyaan terbuka atau tandai skenario sebagai perlu klarifikasi.",
    ],
  ),
  APPROVAL_REQUIRED: entry(
    "error",
    ["This execution requires an active approval.", "Eksekusi ini memerlukan approval yang aktif."],
    [
      "Review and approve the exact scenario version for this baseline.",
      "Tinjau dan setujui versi skenario yang tepat untuk baseline ini.",
    ],
  ),
  APPROVAL_MISMATCH: entry(
    "error",
    ["The approval does not match this execution's baseline.", "Approval tidak cocok dengan baseline eksekusi ini."],
    [
      "Revalidate or re-approve the scenario for the current baseline.",
      "Validasi ulang atau setujui ulang skenario untuk baseline saat ini.",
    ],
  ),
  SCOPE_DENIED: entry(
    "error",
    ["The destination is outside the declared scope.", "Tujuan berada di luar scope yang dideklarasikan."],
    [
      "Update the scope declaration if the destination should be allowed.",
      "Perbarui deklarasi scope jika tujuan tersebut seharusnya diizinkan.",
    ],
  ),
  PRODUCTION_REFUSED: entry(
    "error",
    ["Production environments are not tested.", "Environment produksi tidak diuji."],
    ["Use a development or staging environment.", "Gunakan environment development atau staging."],
  ),
  SUBMISSION_REQUIRES_APPROVAL: entry(
    "error",
    ["Submitting this form requires an approved test.", "Mengirim form ini memerlukan test yang sudah disetujui."],
    [
      "Create and approve a scenario for this form, or enable read-only submissions for confirmed read-only forms.",
      "Buat dan setujui skenario untuk form ini, atau aktifkan pengiriman read-only untuk form yang sudah dikonfirmasi read-only.",
    ],
  ),
  DEFECT_TRANSITION_INVALID: entry(
    "error",
    ["This defect state change is not allowed.", "Perubahan status defect ini tidak diizinkan."],
    ["Follow the defect lifecycle (PRD §15.12).", "Ikuti siklus hidup defect (PRD §15.12)."],
  ),
  JOB_CANCELLED: entry(
    "error",
    ["The job was cancelled.", "Job dibatalkan."],
    ["Start the job again when ready.", "Jalankan job lagi bila sudah siap."],
  ),
  BUDGET_EXHAUSTED: entry(
    "warning",
    ["The job stopped because its budget was exhausted.", "Job berhenti karena anggarannya habis."],
    [
      "The result is partial; increase the budget or narrow the scope.",
      "Hasilnya parsial; tambah anggaran atau persempit scope.",
    ],
  ),
  CONTAINER_RUNTIME_MISSING: entry(
    "error",
    [
      "Automated execution needs a container runtime, which was not found.",
      "Eksekusi otomatis memerlukan container runtime, yang tidak ditemukan.",
    ],
    [
      "Install a Docker-compatible runtime (WSL2-based on Windows), or run the scenarios manually.",
      "Pasang runtime yang kompatibel dengan Docker (berbasis WSL2 di Windows), atau jalankan skenario secara manual.",
    ],
  ),
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;
/** Severity of a validation issue (distinct from the defect `Severity` enum in the contract). */
export type IssueSeverity = "error" | "warning" | "info";
export type CatalogLanguage = "en" | "id";

/** Semantic rule IDs (Contract Specification §8). */
export type RuleId =
  | "CR-001"
  | "CR-002"
  | "CR-010"
  | "CR-011"
  | "CR-020"
  | "CR-021"
  | "CR-030"
  | "CR-040"
  | "CR-041"
  | "CR-042"
  | "CR-043"
  | "CR-050"
  | "CR-051"
  | "CR-052"
  | "CR-053"
  | "CR-054"
  | "CR-055"
  | "CR-056"
  | "CR-060"
  | "CR-070";

/** A validation finding. `message` is an English diagnostic for logs; user-facing text comes from the catalog. */
export interface ContractIssue {
  code: ErrorCode;
  severity: IssueSeverity;
  rule?: RuleId;
  message: string;
  artifact?: string;
  json_pointer?: string;
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  issues: ContractIssue[];
}

export function issue(
  code: ErrorCode,
  message: string,
  extra: Omit<ContractIssue, "code" | "severity" | "message"> = {},
): ContractIssue {
  return { code, severity: ERROR_CATALOG[code].severity, message, ...extra };
}

export function result(issues: ContractIssue[]): ValidationResult {
  return { ok: !issues.some((i) => i.severity === "error"), issues };
}

/** Converts an issue into the contract error object (schemas/error.schema.json) in the requested language. */
export function toErrorObject(found: ContractIssue, language: CatalogLanguage = "en"): Sys2QaError {
  const entryFor = ERROR_CATALOG[found.code];
  const text = (pair: readonly [string, string]): LangText => ({
    language,
    value: language === "id" ? pair[1] : pair[0],
  });
  const error: Sys2QaError = {
    code: found.code,
    severity: found.severity,
    message: text(entryFor.title),
    remediation: text(entryFor.remediation),
  };
  if (found.artifact !== undefined) error.artifact_id = found.artifact;
  if (found.json_pointer !== undefined) error.json_pointer = found.json_pointer;
  const details: Record<string, unknown> = { ...(found.details ?? {}) };
  if (found.rule) details.rule = found.rule;
  if (Object.keys(details).length > 0) error.details = details;
  return error;
}

function entry<S extends IssueSeverity>(
  severity: S,
  title: readonly [string, string],
  remediation: readonly [string, string],
) {
  return { severity, title, remediation } as const;
}
