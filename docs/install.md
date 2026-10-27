# Installing Renart

About 30 minutes on a cluster that already runs GitLab or can reach it.

## Requirements

- Kubernetes 1.30+ with a CNI that enforces NetworkPolicy (Calico, Cilium, Canal…) and an ingress controller.
- Helm 3.15+ or 4.
- A GitLab instance (self-managed or gitlab.com) where you can create a group, a project, a project access token and an OAuth application.
- An Anthropic API key, or an OpenAI-compatible model server with tool calling ([docs/openai-compatible.md](openai-compatible.md)).
- Podman or Docker to build the two images, and a registry the cluster can pull from (the GitLab registry works).

## 1. Build the images

```
podman build -t <registry>/renart/orchestrator:0.0.12 orchestrator
podman build -t <registry>/renart/runner:0.0.6 runner
podman push <registry>/renart/orchestrator:0.0.12
podman push <registry>/renart/runner:0.0.6
```

## 2. Set up GitLab

1. **Workflows project.** Create a project, for example `renart/workflows`, and push the content of [`workflows/`](../workflows) to its `main` branch. Protect `main`: whoever can merge there decides which prompts and tools the agent gets. The included CI validates every workflow against the JSON Schema and needs a GitLab Runner.
2. **Orchestrator token.** On that project, Settings → Access tokens: role Reporter, scopes `read_api` and `read_repository`.
3. **Renart account.** Create a regular user, for example `renart-bot` with the name « Renart » (and an avatar), then a personal access token for it with scopes `api` and `write_repository`. Add it as **Developer** to the groups or projects where Renart should work (a group or project access token with an expiry is better than a personal token: it cannot reach anything else). See SECURITY.md for the settings that limit what its CI runs could do. Comments, reviews and merge requests are authored by this account and signed « Lancé par … via Renart »; only users who are Developer or above on a project can launch actions there.
4. **OAuth application.** Admin → Applications (or a group's Applications): name `Renart`, **not confidential**, scope `read_api`, redirect URI `https://<extension-id>.chromiumapp.org/`. The extension's options page shows the exact URI once it is loaded (step 5); you can come back and set it then.

## 3. Create the namespace and secrets

```
kubectl create namespace renart
kubectl -n renart create secret generic renart-orchestrator --from-literal=GITLAB_TOKEN=<token from step 2.2>
kubectl -n renart create secret generic renart-anthropic --from-literal=ANTHROPIC_API_KEY=<key>
kubectl -n renart create secret generic renart-bot --from-literal=GITLAB_TOKEN=<token from step 2.3>
```

If the registry is private:

```
kubectl -n renart create secret docker-registry registry-pull --docker-server=<registry> --docker-username=<user> --docker-password=<token>
```

If GitLab uses a private CA:

```
kubectl -n renart create configmap gitlab-ca --from-file=ca.crt=<path to the CA certificate>
```

## 4. Install the chart

Write a `values.yaml` (all options are documented in [`deploy/chart/values.yaml`](../deploy/chart/values.yaml); [`deploy/lab-values.yaml`](../deploy/lab-values.yaml) is a complete example):

```yaml
gitlab:
  url: https://gitlab.example.com
images:
  orchestrator: <registry>/renart/orchestrator:0.0.12
  runner: <registry>/renart/runner:0.0.6
  pullSecret: registry-pull     # or "" for a public registry
caConfigMap: ""                 # or gitlab-ca
ingress:
  className: nginx
  host: renart.example.com
  annotations: { cert-manager.io/cluster-issuer: letsencrypt }
networkPolicy:
  ingressFrom:                  # pods of your ingress controller
    namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ingress-nginx } }
    podSelector: {}
```

```
helm upgrade --install renart deploy/chart -n renart -f values.yaml --wait
curl https://renart.example.com/healthz   # {"ok":true}
```

**GitLab on a private address.** Runner pods may only reach public addresses on port 443 (plus DNS). If GitLab resolves to a private IP, add a rule under `gitlab.egress`. If it sits behind an in-cluster ingress controller on a hostPort, allow the controller's pods on their container port, since traffic to the node IP reaches the pod before the policy applies (see `deploy/lab-values.yaml`).

## 5. Load the extension

1. Chrome or Chromium → `chrome://extensions` → Developer mode → Load unpacked → the [`extension/`](../extension) folder.
2. Open the extension's options: GitLab URL, orchestrator URL (`https://renart.example.com`) and the OAuth Application ID. Save and accept the host permissions.
3. Open a merge request, click the Renart icon, sign in with GitLab, choose « Résumer la MR » and launch. A summary comment appears on the MR.

## What runs where

| Piece | Where | Can reach |
|---|---|---|
| Orchestrator | Deployment `renart-orchestrator` | GitLab API and git (code graph builds), Kubernetes API (Jobs, pod logs in its namespace) |
| Runner | one Job per run, deleted 1 h after it ends | DNS, public HTTPS (Anthropic API), `gitlab.egress`, the orchestrator (code graph queries) |

Runs write to GitLab with the Renart account's token; the launching user's token is only used by the orchestrator to check who they are and that they are Developer on the project. Who ran which workflow (at which SHA) on which project is recorded on the Job's annotations and in the orchestrator log; the agent's steps are in the runner pod log. Ship both to your log store if you need an audit trail beyond the Job's lifetime.
