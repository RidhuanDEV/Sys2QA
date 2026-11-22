import { appendAudit } from "@sys2qa/platform";
import { auditEgressDecisions, runL2Job, startScopeProxy } from "@sys2qa/runtime-observer";
import { serviceError, ServiceError, SERVICE_ERRORS } from "./errors.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
/** Default rate for one environment (SEC-020): a steady 5 requests per second, bursts of 10. */
export const DEFAULT_RATE_LIMIT = { perSecond: 5, burst: 10 } as const;

const environmentValidate = defineOperation<{ source_id: string }, unknown>({
  name: "environment.validate",
  title: "Check that an environment is reachable",
  description:
    "Opens the environment's base URL once in an L2 browser worker (QAA-FR-006, ADR-005): its own process, a fresh profile that is deleted afterwards, every request through the scope-enforcing proxy (ADR-007) and checked again in the browser, and only GET and HEAD requests let through, so nothing in the application changes. Needs a declaration allowing observation (L2); production environments are refused (SEC-009). Every proxy decision is audited. Returns the status, the final URL and title, and what was blocked.",
  level: "L2",
  effect: "write",
  input: { type: "object", additionalProperties: false, required: ["source_id"], properties: { source_id: ID } },
  run: async ({ host, caller }, input) => {
    const source = host.projects.getEvidenceSource(input.source_id);
    if (source.kind !== "environment")
      throw serviceError("INPUT_INVALID", "only an environment can be validated", { field: "source_id" });
    const policy = host.projects.currentScopePolicy(source.id);
    if (!policy) throw serviceError("NOT_FOUND", "configure the environment first (base URL, classification, hosts)");
    const decision = host.projects.authorize(source.id, "observe", { kind: "url", url: policy.base_url });
    if (!decision.allowed) {
      const code =
        decision.reason === "no_declaration"
          ? "DECLARATION_REQUIRED"
          : SERVICE_ERRORS[decision.code]
            ? decision.code
            : "SCOPE_DENIED";
      throw new ServiceError(
        code,
        "denied",
        `observing ${policy.base_url} is not authorized (${decision.reason})`,
        SERVICE_ERRORS[code]!.remediation,
      );
    }
    const jobId = host.newId("job");
    const audit = { redactor: host.redactor, now: host.now };
    const scope = {
      allowed_hosts: policy.allowed_hosts,
      path_prefixes: policy.path_prefixes,
      local_owner_mode: policy.local_owner_mode,
    };
    const proxy = await startScopeProxy({
      scope,
      localOwnerModeEnabled: host.projects.settings().local_owner_mode_enabled,
      rateLimit: DEFAULT_RATE_LIMIT,
      onDecision: auditEgressDecisions(host.state.db, audit, source.project_id, jobId),
      now: host.now,
    });
    let result;
    try {
      result = await runL2Job({ action: "validate", url: policy.base_url, scope }, proxy, { budgetMs: 60_000 });
    } finally {
      await proxy.close();
    }
    host.state.transaction(() =>
      appendAudit(
        host.state.db,
        {
          projectId: source.project_id,
          actor: caller.actor,
          action: "environment.validated",
          target: source.id,
          details: {
            job_id: jobId,
            reachable: result.ok,
            status: result.status ?? null,
            blocked: result.blocked.length,
            scope_policy_version: policy.version,
          },
        },
        audit,
      ),
    );
    return {
      environment_id: source.id,
      job_id: jobId,
      scope_policy_version: policy.version,
      classification: policy.classification,
      reachable: result.ok,
      status: result.status ?? null,
      final_url: result.final_url ?? null,
      title: result.title ?? null,
      blocked: result.blocked,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export const ENVIRONMENT_OPERATIONS = [environmentValidate];
