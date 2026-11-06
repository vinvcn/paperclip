import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type {
  AiConnectionBinding,
  KeyPoolFailureSnapshot,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { ChevronDown, KeyRound } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { KeyPoolSlotList } from "@/components/ai-connections/KeyPoolSlotList";
import { useConnectionModels } from "@/components/ai-connections/useConnectionModels";

/**
 * The four dedicated recovery actions on a pooled-key failure (ticket 06):
 * try again avoiding the failed slot once, switch-key retry (the pool picks
 * another slot by itself), switch-model retry from the connection's routed
 * catalog, and a read-only pool status popover. The host owns the retry and
 * override plumbing; this row only builds the action payloads.
 */
export function KeyPoolFailureActions({
  companyId,
  snapshot,
  binding,
  harness,
  retryPending,
  onRetry,
  onSwitchModelRetry,
}: {
  companyId: string;
  snapshot: KeyPoolFailureSnapshot | null | undefined;
  /** The assignee's AI connection binding, for the routed model catalog. */
  binding: AiConnectionBinding | undefined;
  harness: string;
  retryPending: boolean;
  onRetry: (options: { avoidKeySlot?: number | null }) => Promise<void> | void;
  onSwitchModelRetry: (model: string) => Promise<void> | void;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const connectionModels = useConnectionModels(companyId, binding, harness);
  const connectionId = typeof snapshot?.connectionId === "string" && snapshot.connectionId
    ? snapshot.connectionId
    : null;
  const status = useQuery({
    queryKey: ["ai-connection-key-slots", connectionId],
    queryFn: ({ signal }) => aiConnectionsApi.keySlots(companyId, connectionId!, { signal }),
    enabled: statusOpen && Boolean(connectionId),
  });
  const models = connectionModels?.models ?? [];
  // "Try again" re-runs the exact failed request while the assignment matrix
  // steers around the just-failed slot for that one wakeup. Only meaningful
  // when the snapshot names the slot that failed; assignment-time exhaustion
  // (pool_exhausted) has no slot to avoid.
  const failedSlot = typeof snapshot?.slot === "number" ? snapshot.slot : null;
  const pending = retryPending;

  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs"
      data-testid="key-pool-failure-actions"
    >
      {failedSlot !== null && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-testid="key-pool-try-again"
          disabled={pending}
          onClick={() => void Promise.resolve(onRetry({ avoidKeySlot: failedSlot })).catch(() => undefined)}
        >
          {pending ? "Trying again..." : "Try again"}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-testid="key-pool-switch-key"
        disabled={pending}
        onClick={() => void Promise.resolve(onRetry({ avoidKeySlot: null })).catch(() => undefined)}
      >
        Switch key
      </Button>
      <span className="text-muted-foreground">The pool picks another key automatically.</span>
      {models.length > 0 && (
        <Popover open={modelOpen} onOpenChange={setModelOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="xs" data-testid="key-pool-switch-model">
              Switch model
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-2" data-testid="key-pool-model-panel">
            <p className="px-2 pb-1.5 pt-1 text-xs text-muted-foreground">
              Retry on another model from this connection. The choice is saved as this task's model override.
            </p>
            <div className="flex max-h-64 flex-col overflow-y-auto">
              {models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                  data-testid="key-pool-model-option"
                  data-model={model.id}
                  onClick={() => {
                    setModelOpen(false);
                    void Promise.resolve(onSwitchModelRetry(model.id)).catch(() => undefined);
                  }}
                >
                  <span className="min-w-0 truncate">{model.label}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{model.id}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
      {connectionId && (
        <Popover open={statusOpen} onOpenChange={setStatusOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="xs" data-testid="key-pool-key-status">
              <KeyRound className="size-3.5" aria-hidden />
              Key status
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96" data-testid="key-pool-status-panel">
            <p className="mb-2 text-xs text-muted-foreground">
              Live slot status for this connection's key pool.
            </p>
            {status.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">Loading keys…</p>
            ) : status.isError ? (
              <p role="alert" className="text-sm text-destructive">Key status could not be loaded.</p>
            ) : (
              <KeyPoolSlotList slots={status.data?.slots ?? []} />
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
