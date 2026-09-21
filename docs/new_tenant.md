# Create a new AIFit tenant

This is the public tenant contract. A deployment adapter owns the
provider-specific Ez provisioning; it is intentionally not part of this
repository. Do not use `previous_version/` or copy a legacy runtime workspace.

## Tenant shape

One authenticated AIFit account maps to one isolated Ez agent:

```text
verified identity
    -> server-owned account_id + tenant_id
    -> one isolated Ez workspace, native session scope, and binding
    -> AGENTS.md initialized from docs/tenant/AGENTS.md
```

`account_id` is the server-resolved Ez principal. `tenant_id` scopes AIFit
records. Neither is accepted from the browser as authority.

## Creation flow

1. The user signs in through the Privy application configured by the
   deployment.

2. The AIFit API verifies that identity with `GET /account`, then creates or
   updates the account and deterministically derives `account_id` and
   `tenant_id` from the verified subject.

3. The deployment adapter provisions one isolated Ez agent for that account.
   The agent must have its own workspace, control state, native session scope,
   and authenticated application binding. Do not share any of those between
   tenants. Keep the provisioning command, host paths, and service credentials
   in the deployment system rather than this repository.

4. The server configures a binding registry outside the source tree. Its
   deployment-specific entry must bind the same server-derived principal and
   owner, for example:

   ```json
   {
     "version": 1,
     "bindings": [
       {
         "principalId": "acc_<account-derived-id>",
         "ownerId": "acc_<account-derived-id>",
         "url": "http://127.0.0.1:<deployment-port>",
         "tokenFile": "/path/outside/repository/application-token"
       }
     ]
   }
   ```

   Keep the registry and token files out of the browser, tenant workspace, and
   Git. The binding layer must preserve authenticated ownership checks whether
   the deployment uses loopback or a private network.

5. Initialize the Ez workspace before the first user turn from
   [`tenant/AGENTS.md`](tenant/AGENTS.md). Keep shared runtime guidance generic
   and separate from the AIFit template. Do not add prompts, transcripts,
   credentials, tenant IDs, or a copied legacy `AGENTS.md`.

## Verification before ready

The tenant is ready only when all of these readbacks pass:

- `GET /account` reports `setup.status: "ready"` and `agent_available: true`;
- the Ez registration receipt reports the same server-owned `ownerId` and a
  non-empty binding identifier;
- one authenticated chat request completes through that bound native agent;
- the workspace contains the AIFit `AGENTS.md` template and no shared tenant
  files or credentials;
- the API passes only the current request, scoped references, and an opaque
  run capability to Ez; the plugin receives no browser identity or prompt
  reconstruction.

The AIFit API consumes a pre-provisioned binding. It does not create operating
system, container, workspace, or Ez registry state from `GET /account`. If a
deployment automates onboarding later, keep those changes in the deployment
adapter and preserve this account-link, seed, and readback sequence.

## Runtime contract

The native Ez agent owns conversation, context, memory, sessions, and decisions.
The AIFit plugin is the deterministic app boundary:

- canonical reads: `profile show`, `exercise show|history`, `blueprint active`,
  `program active`, `workout show|list`;
- writes: `profile update`, `exercise create`, `plan draft`,
  `blueprint draft|solidify`, `program publish`, `workout generate`,
  `workout log-set`, `workout swap`, `workout override`.

The frontend reads canonical AIFit API data. It never reads or invokes the
tenant plugin directly. The full typed artifact schema is in the plugin
`SKILL.md`.
