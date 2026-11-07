import { useQuery } from "@tanstack/react-query";
import { aiConnectionsApi } from "@/api/ai-connections";
import { KEY_SLOT_STATE_LABELS } from "./KeyPoolSlotList";

/**
 * The agent-level default key pin (ticket 06): one pooled slot of the bound
 * connection, used unconditionally by the assignment matrix — cooldowns
 * included (risk acknowledged) while a disabled slot stays off. Rendered
 * beside the Connection field and only when that connection carries a key
 * pool; the select's empty option keeps the pool's automatic assignment.
 */
export function AgentKeySlotPin({
  companyId,
  connectionId,
  value,
  onChange,
  disabled = false,
}: {
  companyId: string;
  connectionId: string;
  /** The pinned slot number, or null for the automatic assignment. */
  value: number | null;
  onChange: (slot: number | null) => void;
  disabled?: boolean;
}) {
  const slots = useQuery({
    queryKey: ["ai-connection-key-slots", connectionId],
    queryFn: ({ signal }) => aiConnectionsApi.keySlots(companyId, connectionId, { signal }),
    // A permission denial or a pool-less connection both resolve to "no rows";
    // either way the pin has nothing to target and stays hidden.
    retry: false,
  });
  const rows = slots.data?.slots ?? [];
  if (slots.isPending || !rows.length) return null;
  const pinned = value != null ? rows.find((slot) => slot.slot === value) ?? null : null;
  return (
    <div className="space-y-1" data-testid="agent-key-slot-pin">
      <label className="block space-y-1 text-sm">
        Default key slot
        <select
          className="block w-full rounded-md border bg-background px-3 py-2"
          data-testid="agent-key-slot-select"
          disabled={disabled}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">Automatic (recommended)</option>
          {rows.map((slot) => (
            <option key={slot.slot} value={slot.slot}>
              Slot {slot.slot}{slot.label ? ` · ${slot.label}` : ""}
              {slot.enabled === false ? " · Disabled" : ""}
              {slot.state !== "healthy" ? ` · ${KEY_SLOT_STATE_LABELS[slot.state]}` : ""}
            </option>
          ))}
        </select>
      </label>
      {pinned && pinned.state !== "healthy" ? (
        <p role="note" data-testid="agent-key-slot-warning" className="text-xs text-destructive">
          Slot {pinned.slot} is in {KEY_SLOT_STATE_LABELS[pinned.state]?.toLowerCase() ?? "cooldown"} —
          {" "}this agent still uses it while it recovers.
        </p>
      ) : null}
    </div>
  );
}
