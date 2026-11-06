import type { AiConnectionKeySlot } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

export const KEY_SLOT_STATE_LABELS: Record<AiConnectionKeySlot["state"], string> = {
  healthy: "Healthy",
  rpm_cooldown: "RPM cooldown",
  daily_cooldown: "Daily cooldown",
};

export function keySlotBadgeVariant(slot: AiConnectionKeySlot): "secondary" | "destructive" | "outline" {
  if (!slot.enabled) return "outline";
  if (slot.state === "healthy") return "secondary";
  return "destructive";
}

/** The read-only facts of one pooled key slot: identity, health badge,
 * occupancy and cooldown recovery. Shared by the connection detail manager
 * (which adds the editing actions around it) and the task-side pool popover
 * (ticket 06). Key values are write-only everywhere: the API never returns
 * them and this view never displays them. */
export function KeyPoolSlotSummary({ slot }: { slot: AiConnectionKeySlot }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-key-slot={slot.slot}>
      <span className="text-sm font-medium">Slot {slot.slot}</span>
      {slot.label && <span className="text-sm text-muted-foreground">{slot.label}</span>}
      <Badge variant={keySlotBadgeVariant(slot)}>
        {KEY_SLOT_STATE_LABELS[slot.state]}
        {!slot.enabled ? " · Disabled" : ""}
      </Badge>
      {slot.state !== "healthy" && slot.cooldownUntil && (
        <span className="text-xs text-muted-foreground">
          Until {new Date(slot.cooldownUntil).toLocaleString()}
        </span>
      )}
      {slot.activeRunId && (
        <span className="text-xs text-muted-foreground">In use by a run</span>
      )}
    </div>
  );
}

/** The pooled key slots of one connection, read-only. */
export function KeyPoolSlotList({ slots }: { slots: readonly AiConnectionKeySlot[] }) {
  if (!slots.length) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        No pooled keys yet. Add keys to spread provider traffic across accounts.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {slots.map((slot) => (
        <li
          key={slot.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
          data-slot-row={slot.slot}
        >
          <KeyPoolSlotSummary slot={slot} />
        </li>
      ))}
    </ul>
  );
}
