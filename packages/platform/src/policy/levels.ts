/** Platform permission levels (PRD §9.5, SEC-006). L5 (production or live external systems) is out of scope. */
export const PERMISSION_LEVELS = ["L0", "L1", "L2", "L2r", "L3", "L4", "L5"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
/** Levels a declaration can grant (L5 cannot be declared). */
export type DeclarableLevel = Exclude<PermissionLevel, "L5">;

const RANK: Record<PermissionLevel, number> = { L0: 0, L1: 1, L2: 2, L2r: 3, L3: 4, L4: 5, L5: 6 };
export const levelAtMost = (level: PermissionLevel, ceiling: PermissionLevel): boolean => RANK[level] <= RANK[ceiling];

/** Operations the policy engine decides on, and the level each needs. */
export const OPERATION_LEVELS = {
  inventory: "L0",
  static_read: "L1",
  observe: "L2",
  submit_read_only_form: "L2r",
  execute_test: "L3",
  execute_state_changing_test: "L3",
  execute_repository_code: "L4",
  touch_production: "L5",
} as const satisfies Record<string, PermissionLevel>;
export type Operation = keyof typeof OPERATION_LEVELS;

/** Operations on a source root (path targets) versus on an environment (URL targets). */
export const SOURCE_OPERATIONS: ReadonlySet<Operation> = new Set([
  "inventory",
  "static_read",
  "execute_repository_code",
]);
