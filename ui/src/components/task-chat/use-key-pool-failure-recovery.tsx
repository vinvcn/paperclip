import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  aiConnectionBindingSchema,
  aiRoutingHarness,
  type Agent,
  type IssueAssigneeAdapterOverrides,
  type KeyPoolFailureSnapshot,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { switchModelRetryOverrides } from "./composer-run-settings";
import { KeyPoolFailureActions } from "./KeyPoolFailureActions";

/** The failed-run context a key-pool recovery action needs: which agent owns
 * the run (the wake route revalidates the run↔agent pairing server-side) and
 * the agent record for the connection binding and harness. */
export type KeyPoolFailedRunRef = { agentId: string; agent?: Agent };

/**
 * Ticket 06: the pooled-key recovery actions shared by the two failure
 * surfaces — the thread's failure marker and the interruption banner. The
 * host resolves the failed run to its agent (markers walk the linked runs;
 * the banner uses the interruption's observed run plus the assignee), and
 * this hook owns the retry mutation and the action row: "Try again" wakes
 * the exact failed run while the assignment matrix avoids the failed slot
 * once, "Switch key" re-dispatches with a clean pool pick, "Switch model"
 * saves the task-level model override from the connection's routed catalog
 * before re-dispatching, and "Key status" opens the read-only pool popover.
 */
export function useKeyPoolFailureRecovery(options: {
  companyId: string;
  issueId: string;
  /** The issue ref the runs/live-runs/active-run queries are keyed by. */
  runsQueryRef: string;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null | undefined;
  resolveFailedRun: (runId: string) => KeyPoolFailedRunRef | undefined;
}) {
  const { companyId, issueId, runsQueryRef, assigneeAdapterOverrides, resolveFailedRun } = options;
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const retryFailedRun = useMutation({
    mutationFn: async ({ runId, avoidKeySlot }: { runId: string; avoidKeySlot?: number | null }) => {
      const failedRun = resolveFailedRun(runId);
      if (!failedRun) throw new Error("Failed run is no longer available.");
      return agentsApi.retryFailedRun(
        failedRun.agentId,
        runId,
        companyId,
        // "Try again" avoids the failed pool slot once; a switch-key retry
        // passes null and the pool picks freely.
        { avoidKeySlot },
      );
    },
    onSuccess: (result) => {
      if (!result.runId) {
        pushToast({
          title: "Retry queued",
          body: "The exact request will retry when this task is ready.",
          tone: "success",
        });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.runs(runsQueryRef),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.liveRuns(runsQueryRef),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activeRun(runsQueryRef),
      });
    },
    onError: (error) => {
      pushToast({
        title: "Run retry failed",
        body: error instanceof Error ? error.message : "Unable to retry run",
        tone: "error",
      });
    },
  });

  const renderActions = useCallback((input: {
    snapshot?: KeyPoolFailureSnapshot | null;
    runId?: string | null;
  }) => {
    const { snapshot, runId } = input;
    if (!runId) return null;
    const failedRun = resolveFailedRun(runId);
    // An unresolvable run cannot produce a correct wake payload; hiding the
    // actions beats rendering buttons that can only fail on click.
    if (!failedRun) return null;
    const failedRunAgent = failedRun.agent;
    const binding = failedRunAgent
      ? aiConnectionBindingSchema.safeParse(failedRunAgent.runtimeConfig?.aiConnection).data
      : undefined;
    const harness = failedRunAgent
      ? aiRoutingHarness(failedRunAgent.adapterType, failedRunAgent.adapterConfig.provider, failedRunAgent.adapterConfig.acpxAgent)
      : "opencode_local";
    return (
      <KeyPoolFailureActions
        companyId={companyId}
        snapshot={snapshot}
        binding={binding}
        harness={harness}
        retryPending={retryFailedRun.isPending && retryFailedRun.variables?.runId === runId}
        onRetry={({ avoidKeySlot }) =>
          retryFailedRun.mutateAsync({ runId, avoidKeySlot }).then(() => undefined)
        }
        onSwitchModelRetry={async (model) => {
          try {
            const updated = await issuesApi.update(issueId, {
              assigneeAdapterOverrides: switchModelRetryOverrides(
                assigneeAdapterOverrides,
                failedRunAgent?.adapterType,
                model,
              ),
            });
            queryClient.setQueryData(queryKeys.issues.detail(issueId), updated);
          } catch (error) {
            pushToast({
              title: "Model override failed",
              body: error instanceof Error ? error.message : "Unable to save the model override",
              tone: "error",
            });
            return;
          }
          await retryFailedRun.mutateAsync({ runId, avoidKeySlot: null }).then(() => undefined);
        }}
      />
    );
  }, [assigneeAdapterOverrides, companyId, issueId, pushToast, queryClient, resolveFailedRun, retryFailedRun]);

  return { retryFailedRun, renderActions };
}
