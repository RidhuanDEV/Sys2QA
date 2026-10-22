import type { ICruiseOptions, IForbiddenRuleType } from "dependency-cruiser";

export const ALLOWED_INTERNAL: Record<string, string[]>;
export function dependencyRules(root?: string): IForbiddenRuleType[];
export const cruiseOptions: ICruiseOptions;
