# Air-gapped install

Renart can run with no Internet access at all: the model is served in your network (vLLM), reached through agentgateway, and nothing in Renart calls a public address.

```
extension ──► orchestrator ──► runner Job ──► agentgateway ──► vLLM
                   │                │
                   │                └──► GitLab (your instance)
                   └──► code graph build Job ──► GitLab, then upload to the orchestrator
```

## What `airGap: true` does

- Removes the "public HTTPS" egress rule from the runner and code graph build NetworkPolicies. Those pods can then only reach DNS, the orchestrator, `gitlab.egress`, and the model (agentgateway or `engine.openai.egress`).
- Refuses to render with the `claude` engine, which needs the Anthropic API.
- No Anthropic Secret is needed. `secrets.anthropic` is optional; create it only if vLLM or agentgateway wants an `OPENAI_API_KEY`.

What already holds in every install:
- **The extension** loads no remote script, font or style. It only talks to GitLab (OAuth) and to the orchestrator.
- **CodeGraph** works fully locally: tree-sitter and SQLite, no LLM. It runs with telemetry, update check, daemon and self-download turned off.
- **The orchestrator** only calls GitLab and the Kubernetes API.

## Images to mirror

| Image | Value |
|---|---|
| `registry.gitlab.com/renart/renart/orchestrator` | `images.orchestrator` (also used by code graph build Jobs) |
| `registry.gitlab.com/renart/renart/runner` | `images.runner` |
| `ghcr.io/agentgateway/agentgateway:v1.5.0` | `agentgateway.image` |
| `vllm/vllm-openai` and the model weights | your vLLM deployment |

The images contain all their dependencies; nothing is downloaded at run time. Building them still needs an npm registry: build them outside, or behind an npm mirror.

## Values

```yaml
airGap: true
images:
  orchestrator: registry.internal/renart/orchestrator:<tag>
  runner: registry.internal/renart/runner:<tag>
  pullSecret: registry-pull
engine:
  name: openai
  model: Qwen/Qwen2.5-32B-Instruct      # the name agentgateway sends to vLLM
agentgateway:
  enabled: true
  image: registry.internal/agentgateway/agentgateway:v1.5.0
  config: |
    llm:
      port: 3000
      models:
      - name: "*"
        provider:
          custom:
            formats: [{ type: completions }]
        params:
          model: Qwen/Qwen2.5-32B-Instruct
          baseUrl: http://vllm.llm.svc:8000/v1
          # apiKey: "$VLLM_API_KEY"      # if vLLM runs with --api-key
```

Start vLLM with tool calling, for example `--enable-auto-tool-choice --tool-call-parser hermes` for Qwen2.5. Runners call `http://renart-agentgateway:3000/v1`, and the NetworkPolicy opens that path. agentgateway itself has no NetworkPolicy; restrict it to the vLLM namespace if you want.

A model request can take several minutes on a loaded server. The runner waits up to 30 minutes per request, within the run's 15-minute Job deadline.

## Verified on the lab cluster

The test install ran in the `renart-airgap` namespace, with no Anthropic Secret and no public egress. Ollama's OpenAI-compatible API stood in for vLLM, because the lab has no GPU; it serves the same `/v1/chat/completions`. The model was qwen2.5:7b on 4 CPUs, and the workflow was « Résumer la MR » on a Flask MR.

- **Chart**: installed and healthy in 69 s. agentgateway v1.5.0 accepted the `custom` provider.
- **Run**: 6 model calls through agentgateway, all HTTP 200, the longest taking 7 min 17 s. The event stream stayed open throughout, and the run ended `succeeded` in 14 min 40 s.
- **Model**: it misread the merge request because Ollama's default 4096-token context cut the diff. vLLM serves the model's full context (`--max-model-len`). Use a 30B-class model for real workflows, see [openai-compatible.md](openai-compatible.md).
