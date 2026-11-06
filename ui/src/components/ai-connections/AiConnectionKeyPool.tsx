import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AiConnectionKeySlotCreate, AiConnectionKeySlotUpdate } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyPoolSlotSummary } from "./KeyPoolSlotList";

/** The key slots of one AI connection. Key values are write-only here: the API
 * never returns them and this block never displays them. */
export function AiConnectionKeyPool({
  companyId,
  connectionId,
}: {
  companyId: string;
  connectionId: string;
}) {
  const client = useQueryClient();
  const queryKey = ["ai-connection-key-slots", connectionId];
  const slots = useQuery({
    queryKey,
    queryFn: ({ signal }) => aiConnectionsApi.keySlots(companyId, connectionId, { signal }),
  });
  const [adding, setAdding] = useState(false);
  const [newSlot, setNewSlot] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editKey, setEditKey] = useState("");

  const refresh = () => client.invalidateQueries({ queryKey });
  const add = useMutation({
    mutationFn: (input: AiConnectionKeySlotCreate) => aiConnectionsApi.addKeySlot(companyId, connectionId, input),
    onSuccess: () => {
      setAdding(false);
      setNewSlot("");
      setNewLabel("");
      setNewKey("");
      return refresh();
    },
  });
  const update = useMutation({
    mutationFn: (input: AiConnectionKeySlotUpdate) => aiConnectionsApi.updateKeySlot(companyId, connectionId, input),
    onSuccess: () => {
      setEditing(null);
      setEditKey("");
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (slot: number) => aiConnectionsApi.removeKeySlot(companyId, connectionId, slot),
    onSuccess: refresh,
  });
  const failure = slots.error ?? add.error ?? update.error ?? remove.error;

  const startEdit = (slot: AiConnectionKeySlot) => {
    setEditing(slot.slot);
    setEditLabel(slot.label ?? "");
    setEditKey("");
  };

  const saveEdit = () => {
    if (editing === null) return;
    const input: AiConnectionKeySlotUpdate = { slot: editing };
    if (editKey) input.keyValue = editKey;
    input.label = editLabel.trim() ? editLabel.trim() : null;
    update.mutate(input);
  };

  const saveNew = () => {
    const slotNumber = Number(newSlot);
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || !newKey.trim()) return;
    add.mutate({ slot: slotNumber, keyValue: newKey.trim(), ...(newLabel.trim() ? { label: newLabel.trim() } : {}) });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Keys</h3>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add key
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {describeError(failure).body}
        </p>
      )}
      {slots.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading keys…
        </p>
      ) : !slots.data?.slots.length ? (
        <p role="status" className="text-sm text-muted-foreground">
          No pooled keys yet. Add keys to spread provider traffic across accounts.
        </p>
      ) : (
        <ul className="space-y-2">
          {slots.data.slots.map((slot) => (
            <li
              key={slot.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
              data-slot-row={slot.slot}
            >
              <KeyPoolSlotSummary slot={slot} />
              <span className="grow" />
              {editing === slot.slot ? (
                <div className="flex w-full flex-wrap items-center gap-2">
                  <Input
                    aria-label="Label"
                    value={editLabel}
                    placeholder="Label"
                    className="w-40"
                    onChange={(event) => setEditLabel(event.target.value)}
                  />
                  <Input
                    aria-label="API key"
                    type="password"
                    value={editKey}
                    placeholder="New key value"
                    className="w-64"
                    onChange={(event) => setEditKey(event.target.value)}
                  />
                  <Button size="sm" disabled={update.isPending} onClick={saveEdit}>
                    Save key
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => startEdit(slot)}>
                    Replace key
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ slot: slot.slot, enabled: !slot.enabled })}
                  >
                    {slot.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(slot.slot)}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
          <Input
            aria-label="Slot number"
            type="number"
            min={1}
            value={newSlot}
            placeholder="Slot"
            className="w-20"
            onChange={(event) => setNewSlot(event.target.value)}
          />
          <Input
            aria-label="Label"
            value={newLabel}
            placeholder="Label"
            className="w-40"
            onChange={(event) => setNewLabel(event.target.value)}
          />
          <Input
            aria-label="API key"
            type="password"
            value={newKey}
            placeholder="API key"
            className="w-64"
            onChange={(event) => setNewKey(event.target.value)}
          />
          <Button size="sm" disabled={add.isPending} onClick={saveNew}>
            Save key
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
