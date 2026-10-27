# Using Renart with an OpenAI-compatible model

Renart's default engine is the Claude Agent SDK on the Anthropic API. For installs that want a self-hosted model, the `openai` engine runs the same workflows on any server that speaks `/v1/chat/completions` with tool calling (vLLM, Ollama, LiteLLM, agentgateway…). It contains no Claude Code and makes no call to Anthropic.

## What changes

| | `claude` engine | `openai` engine |
|---|---|---|
| Agent loop | Claude Agent SDK | Renart's own tool-calling loop (`runner/src/openai.ts`) |
| GitLab tools | the same 6 tools, same code | the same 6 tools, sent as function definitions |
| Repository work (`workspace: true`) | Read, Edit, Write, Glob, Grep behind a path guard | `read_file`, `write_file`, `list_files`, limited to the clone |
| Commit and push | by the runner | by the runner |
| Tool arguments | validated by the SDK | validated against the same schemas before anything runs; errors go back to the model |

Everything the agent writes still goes through the same tools: signed « Lancé par … via Renart », quick actions neutralised, drafts only.

## Configure it

The model must support tool calling. With vLLM, start it with `--enable-auto-tool-choice` and the tool parser of your model.

```yaml
engine:
  name: openai
  model: Qwen/Qwen2.5-32B-Instruct          # the name the server serves
  openai:
    baseUrl: http://vllm.llm.svc:8000/v1
    # Runner pods only reach public HTTPS by default: open the model server.
    egress:
      - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: llm } } }]
        ports: [{ protocol: TCP, port: 8000 }]
```

If the server needs a key, put `OPENAI_API_KEY` in the `secrets.anthropic` Secret (it is loaded into runner pods whatever the engine).

### Through agentgateway

For an install with no Internet at all, see [air-gap.md](air-gap.md).

Set `agentgateway.enabled: true` and leave `engine.openai.baseUrl` empty: runners call `http://renart-agentgateway:3000/v1` and the NetworkPolicy opens it. Put your gateway configuration in `agentgateway.config` (see the [agentgateway docs](https://agentgateway.dev/docs/)); the default points at vLLM (`custom` provider, OpenAI format); Ollama has its own provider:

```yaml
agentgateway:
  enabled: true
  config: |
    llm:
      port: 3000
      models:
      - name: "*"
        provider: ollama
        params:
          model: qwen2.5:3b
          baseUrl: http://ollama.llm.svc:11434/v1
```

## Known limits

Measured on the lab cluster (4 CPU, no GPU), Ollama behind agentgateway, workflow « Résumer la MR »:

- **qwen2.5:1.5b** answered with an invented summary without calling any tool. Too small for these prompts.
- **qwen2.5:3b** read the merge request with `get_merge_request` and wrote a correct summary in French, but returned it as text instead of posting it. The runner reminds the model once to publish with the workflow's output tool (`comment_*`, `create_merge_request`) when it ends without having done so; qwen2.5:3b still answered with an empty message after the reminder.
- Small models follow multi-step workflows poorly (`review-mr` with line comments, `issue-to-mr`). Use at least a 30B-class instruct model with reliable tool calling for those.
- Cost and token counts are not reported for this engine (`cost_usd` is absent from the audit record).
