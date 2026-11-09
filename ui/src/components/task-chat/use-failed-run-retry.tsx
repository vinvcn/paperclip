import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

/** One retry contract for the thread and pooled-key recovery. Each caller owns
 * its mutation instance, while request feedback and cache invalidation stay
 * identical for the two user-facing entry points. */
export function useFailedRunRetry({
  companyId,
  runsQueryRef,
  resolveFailedRun,
}: {
  companyId: string;
  runsQueryRef: string;
  resolveFailedRun: (runId: string) => { agentId: string } | undefined;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  return useMutation({
    mutationFn: async (input: string | { runId: string; avoidKeySlot?: number | null }) => {
      const { runId, avoidKeySlot } = typeof input === "string" ? { runId: input } : input;
      const failedRun = resolveFailedRun(runId);
      if (!failedRun) throw new Error("Failed run is no longer available.");
      return agentsApi.retryFailedRun(failedRun.agentId, runId, companyId, { avoidKeySlot });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(runsQueryRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(runsQueryRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(runsQueryRef) });
    },
    onError: (error) => {
      pushToast({
        title: "Run retry failed",
        body: error instanceof Error ? error.message : "Unable to retry run",
        tone: "error",
      });
    },
  });
}
