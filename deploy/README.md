# AIFit API deployment

The API container runs on `ez-vm` at `127.0.0.1:18182`, alongside the existing
legacy API on `127.0.0.1:18081`. The production API hostname is
`api.aifit.living`; its Nginx route is separate from `dev.ezenciel.com` and the
legacy API stays available for rollback.

Production values stay on the VM in `/etc/aifit/aifit-api.env`. The binding
registry and application token are separate owner-only files at the paths in
`compose.prod.yml`; neither belongs in this repository or in Vercel.
The curated account model policy is the required private file
`/etc/aifit/aifit-model-policy.json`. Compose mounts it read-only and sets
`AIFIT_MODEL_POLICY_FILE`; a missing file blocks deployment instead of exposing
the full Ez catalog.

GitHub Actions runs API tests on pull requests and deploys `main` to the VM with
a restricted SSH key. The VM accepts that key only for the fixed
`/usr/local/sbin/aifit-api-deploy` command. That command fetches public `main`,
builds the API image, waits for the database-backed health check, and preserves
the prior image for a failed rollout. Do not register a persistent self-hosted
runner against this public repository.

Vercel owns the frontend deployment. Its project root is `web`, and connecting
the project to this GitHub repository makes pushes to `main` production
deployments. `API_BASE_URL` must be `https://api.aifit.living` before the new
frontend build is promoted.

Atlas credentials, the Privy secret, application-channel token, and the binding
registry remain owner-only files on the VM. The API container can read only the
files mounted for its own service.
