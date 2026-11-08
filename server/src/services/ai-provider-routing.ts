import { OPENROUTER_ATTRIBUTION_HEADERS, isOpenRouterUrl, openRouterClaudeHeaders, openRouterCodexHeaders } from "@paperclipai/shared/openrouter-attribution";
import {
  aiRoutingBaseUrl,
  aiRoutingModel,
  type AiProviderRouting,
} from "@paperclipai/shared";

/** Projects one authoritative connection into an isolated harness environment. */
export function managedProviderRouting(
  route: AiProviderRouting,
  harness: string,
  credential: string,
  model: string,
  keySlot?: number | null,
  connectionId?: string | null,
) {
  const env: Record<string, string> = {};
  const config: Record<string, unknown> = {};
  let codexConfig = "";
  let hermesConfig = "";
  const baseUrl = aiRoutingBaseUrl(route, harness);
  const openrouter = isOpenRouterUrl(baseUrl);
  // Key-pool slot provenance beside the gateway key projection: the runner's
  // usage capture reads it for per-key usage attribution (ticket 04). This is
  // an additive env key only — routing decisions are unchanged. The pool's
  // owning connection rides the same channel so a usage row attributes itself
  // to the connection (review F2: per-pool 429 window accounting and Usage
  // key filtering); without a pooled slot neither marker is projected.
  if (typeof keySlot === "number") {
    env.PAPERCLIP_AI_PROVIDER_KEY_SLOT = String(keySlot);
    if (connectionId) env.PAPERCLIP_AI_PROVIDER_CONNECTION_ID = connectionId;
  }
  if (route.kind === "bedrock") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    env.AWS_REGION = route.region!;
    env.AWS_DEFAULT_REGION = route.region!;
    env.AWS_EC2_METADATA_DISABLED = "true";
    env.AWS_BEARER_TOKEN_BEDROCK = credential;
  } else if (harness === "codex_local") {
    env.PAPERCLIP_AI_PROVIDER_KEY = credential;
    codexConfig = `model_provider = "paperclip"\n[model_providers.paperclip]\nname = "Paperclip connection"\nbase_url = ${JSON.stringify(baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\n${route.auth === "none" ? "" : 'env_key = "PAPERCLIP_AI_PROVIDER_KEY"\n'}`;
    if (openrouter) codexConfig += openRouterCodexHeaders();
  } else if (harness === "claude_local") {
    env.ANTHROPIC_BASE_URL = baseUrl;
    if (openrouter) env.ANTHROPIC_CUSTOM_HEADERS = openRouterClaudeHeaders();
    env[
      route.auth === "api_key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"
    ] = credential;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (model) {
      env.ANTHROPIC_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    }
  } else if (harness === "pi_local" && route.kind === "openrouter") {
    env.OPENROUTER_API_KEY = credential;
    config.model = aiRoutingModel(route, harness, model);
  } else if (harness === "opencode_local") {
    const provider = route.kind === "openrouter" ? "openrouter" : "paperclip";
    if (route.kind === "openrouter") env.OPENROUTER_API_KEY = credential;
    else {
      env.PAPERCLIP_AI_PROVIDER_KEY = credential;
      env.PAPERCLIP_AI_PROVIDER_URL = baseUrl;
    }
    const id = model.startsWith(`${provider}/`)
      ? model.slice(provider.length + 1)
      : model;
    if (provider === "paperclip") {
      const modelEntry = route.models.find((entry) => entry.id === id);
      if (modelEntry?.limit || modelEntry?.options) {
        env.PAPERCLIP_OPENCODE_MODEL_CONFIG = JSON.stringify({
          ...(modelEntry.limit ? { limit: modelEntry.limit } : {}),
          ...(modelEntry.options ? { options: modelEntry.options } : {}),
        });
      }
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        [provider]: {
          ...(provider === "paperclip"
            ? { npm: "@ai-sdk/openai-compatible", name: "Paperclip connection" }
            : {}),
          options: { baseURL: baseUrl, apiKey: credential, ...(openrouter ? { headers: OPENROUTER_ATTRIBUTION_HEADERS } : {}) },
          models: id ? { [id]: { name: id } } : {},
        },
      },
      enabled_providers: [provider],
    });
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    config.model = aiRoutingModel(route, harness, model);
  } else if (harness === "hermes_local") {
    env.OPENAI_BASE_URL = baseUrl;
    env.OPENAI_API_KEY = credential;
    env.OPENROUTER_API_KEY = route.kind === "openrouter" ? credential : "";
    config.provider = route.kind === "openrouter" ? "openrouter" : "auto";
    // Hermes now reads custom endpoint routing from config.yaml, not OPENAI_BASE_URL.
    // Hermes strips OPENAI_API_KEY from terminal children. A custom variable
    // would expose the reusable gateway key to task-controlled shell commands.
    hermesConfig = `model:\n  provider: ${route.kind === "openrouter" ? '"openrouter"' : '"custom"'}\n  default: ${JSON.stringify(model)}\n  base_url: ${JSON.stringify(baseUrl)}\n  api_mode: "chat_completions"\n${route.auth === "none" ? "" : '  api_key: "${OPENAI_API_KEY}"\n'}`;
  }
  if (openrouter && hermesConfig) hermesConfig += `  default_headers: ${JSON.stringify(OPENROUTER_ATTRIBUTION_HEADERS)}\n`;
  return { env, config, codexConfig, hermesConfig };
}
