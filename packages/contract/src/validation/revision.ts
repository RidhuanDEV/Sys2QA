import type { Revision } from "../generated/types.js";

/**
 * Canonical string form of a revision, used for `last_validated_revision` and comparisons
 * (Contract Specification §4.4): commit SHA, content fingerprint, or `<environment_id>@<from>/<to>`.
 */
export function revisionKey(revision: Revision): string {
  switch (revision.kind) {
    case "git_commit":
      return revision.worktree_dirty && revision.dirty_fingerprint
        ? `${revision.value}+${revision.dirty_fingerprint}`
        : revision.value;
    case "content_fingerprint":
      return revision.value;
    case "observation_window":
      return `${revision.environment_id}@${revision.observed_from}/${revision.observed_to}`;
  }
}

export function revisionsEqual(a: Revision, b: Revision): boolean {
  return revisionKey(a) === revisionKey(b) && a.kind === b.kind;
}
