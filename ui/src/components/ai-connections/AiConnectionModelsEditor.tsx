import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AiProviderRoutingModel } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const efforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

function cloneModels(models: readonly AiProviderRoutingModel[]): AiProviderRoutingModel[] {
  return structuredClone(models) as AiProviderRoutingModel[];
}

function withoutEmptySettings(model: AiProviderRoutingModel): AiProviderRoutingModel {
  const limit = Object.fromEntries(Object.entries(model.limit ?? {}).filter(([, value]) => value !== undefined));
  const options = Object.fromEntries(Object.entries(model.options ?? {}).filter(([, value]) => value !== undefined));
  return {
    id: model.id.trim(),
    ...(model.label?.trim() ? { label: model.label.trim() } : {}),
    ...(Object.keys(limit).length ? { limit } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  } as AiProviderRoutingModel;
}

export function AiConnectionModelsEditor({ companyId, connectionId, models: initialModels }: {
  companyId: string;
  connectionId: string;
  models: readonly AiProviderRoutingModel[];
}) {
  const [models, setModels] = useState(() => cloneModels(initialModels));
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => aiConnectionsApi.updateModels(companyId, connectionId, models.map(withoutEmptySettings)),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }),
  });
  // Reconnect and another editor may replace this catalog. A saved response is
  // the new baseline, while ordinary parent rerenders preserve the local draft.
  const [baseline, setBaseline] = useState(initialModels);
  if (initialModels !== baseline) {
    setBaseline(initialModels);
    setModels(cloneModels(initialModels));
    save.reset();
  }
  const update = (index: number, patch: Partial<AiProviderRoutingModel>) => {
    save.reset();
    setModels((current) => current.map((model, i) => i === index ? { ...model, ...patch } : model));
  };
  const ids = models.map(model => model.id.trim());
  const duplicate = new Set(ids).size !== ids.length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Model settings</h3>
        <Button type="button" size="sm" variant="outline" onClick={() => { save.reset(); setModels(current => [...current, { id: "" }]); }}>Add model</Button>
      </div>
      {models.length === 0 ? <p className="text-xs text-muted-foreground">No models declared.</p> : null}
      <div className="space-y-3">
        {models.map((model, index) => (
          <div key={index} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">Model ID<Input aria-label="Model ID" value={model.id} onChange={(event) => update(index, { id: event.target.value })} /></label>
            <label className="space-y-1 text-xs text-muted-foreground">Label<Input aria-label="Model label" value={model.label ?? ""} onChange={(event) => update(index, { label: event.target.value || undefined })} /></label>
            <label className="space-y-1 text-xs text-muted-foreground">Context limit<Input type="number" aria-label="Context limit" value={model.limit?.context ?? ""} onChange={(event) => update(index, { limit: { ...model.limit, context: event.target.value ? Number(event.target.value) : undefined } })} /></label>
            <label className="space-y-1 text-xs text-muted-foreground">Output limit<Input aria-label="Output limit" type="number" value={model.limit?.output ?? ""} onChange={(event) => update(index, { limit: { ...model.limit, output: event.target.value ? Number(event.target.value) : undefined } })} /></label>
            <label className="space-y-1 text-xs text-muted-foreground">Default reasoning effort<select aria-label="Default reasoning effort" value={model.options?.reasoningEffort ?? ""} onChange={(event) => update(index, { options: { ...model.options, reasoningEffort: event.target.value ? event.target.value as NonNullable<typeof model.options>["reasoningEffort"] : undefined } })} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"><option value="">Provider default</option>{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
            <div className="flex items-end"><Button type="button" variant="ghost" size="sm" aria-label={`Remove ${model.label || model.id || "model"}`} onClick={() => { save.reset(); setModels(models.filter((_, i) => i !== index)); }}>Remove</Button></div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between"><Button type="button" variant="outline" size="sm" onClick={() => { save.reset(); setModels(cloneModels(initialModels)); }}>Reset</Button><Button type="button" size="sm" disabled={save.isPending || models.some(model => !model.id.trim()) || duplicate} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save models"}</Button></div>
      {ids.some(id => !id) ? <p role="alert" className="text-xs text-destructive">Model ID is required.</p> : null}
      {new Set(ids).size !== ids.length ? <p role="alert" className="text-xs text-destructive">Model IDs must be unique.</p> : null}
      {save.isError ? <p role="alert" className="text-xs text-destructive">{save.error instanceof Error ? save.error.message : "Could not save models"}</p> : null}
      {save.isSuccess ? <p role="status" className="text-xs text-muted-foreground">Model settings saved.</p> : null}
    </div>
  );
}
