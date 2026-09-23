# Yahoo Fantasy enrollment and weekly read operations

The enrollment/roster connector is fixed to NFL season 2026, league `420010`, and team `7`. All commands remain read-only. The separate operations module adds verified weekly roster, settings, transaction, and candidate reads. Its exported helpers provide GET-only transport and in-process token refresh; CLI output never contains credentials. Enrollment's network operations are:

- `POST https://api.login.yahoo.com/oauth2/get_token` for the authorization-code exchange or refresh grant.
- `GET` the signed-in user's 2026 NFL league/team membership from the Yahoo Fantasy API.
- `GET` the verified target team's roster from the Yahoo Fantasy API.

App `Zkzv5U7y` and its registered redirect `https://localhost:8765/callback` are setup inputs, not evidence that runtime access works. Installation, enrollment, and live roster verification must each have their own successful receipt.

## Security boundary

Client ID, client secret, refresh token, and the bound Yahoo identity live only as generic-password items in the user's default macOS Keychain under service `com.skrodzkai.fantasy.yahoo`. The identity is the Fantasy API user's GUID when Yahoo returns it. If Yahoo hides that GUID, the connector instead binds the exact owned-team key proven by the authenticated `users;use_login=1/.../teams` contract. The connector never accepts these values through command-line arguments, environment variables, repository files, or normal output. Access tokens remain in memory for one invocation. Yahoo may rotate a refresh token; the connector persists the replacement before making a Fantasy resource request and fails closed if that Keychain update fails.

The initial grant and every roster run read the Keychain. Initial grant and refresh-token rotation also change it. Those are credential/security operations and require the coordinator's or user's explicit approval before execution. Keychain prompts and Yahoo sign-in/consent are owner-controlled; they must not be automated around.

For token persistence, the connector sends one `add-generic-password` command to the documented `security -i` stdin interface, then closes the pipe. Values are hex-encoded for `-X` to prevent command parsing/injection, not to encrypt them. They never enter process arguments, shell history, files, or output. The process retains `-T ""` access restrictions. Inputs that exceed Apple's interactive line limit are rejected before spawning; write failures stop the operation. This avoids the trailing `-w` prompt, which reads twice from the controlling terminal rather than accepting one piped line. This mechanism does not authorize an agent to bypass a denied Keychain operation.

## Owner-approved setup

These steps are a runbook, not authorization to perform them.

1. In the existing Yahoo application, confirm—without changing it—that Fantasy Sports access is Read and the redirect is exactly `https://localhost:8765/callback`. Do not create another app or add scopes.
2. Enroll the existing client ID and client secret with hidden Keychain prompts. Because `-w` is the final option, `/usr/bin/security` prompts for each value rather than putting it in shell history or the process argument list. `-T ''` leaves access subject to macOS Keychain approval instead of silently trusting a broad executable:

   ```sh
   /usr/bin/security add-generic-password -U -a client-id -s com.skrodzkai.fantasy.yahoo -T '' -w
   /usr/bin/security add-generic-password -U -a client-secret -s com.skrodzkai.fantasy.yahoo -T '' -w
   ```

3. Run the bounded enrollment command from this repository:

   ```sh
   node analysis/yahoo-fantasy-readonly.mjs enroll
   ```

   The command prints Yahoo's authorization URL with a random state value. It deliberately does not open a browser or operate Yahoo UI. After the owner signs in and consents, Yahoo redirects to the registered HTTPS localhost URL. This connector does **not** start a TLS server and does not disable certificate validation. The browser is therefore expected to show a connection error; copy the complete URL still present in its address bar and paste it into the connector's hidden prompt. The connector requires the exact HTTPS scheme, host, port, path, and state before exchanging the short-lived code.

   Before persisting the refresh token, enrollment uses the new access token with the existing Fantasy read permission to request the single authenticated user and that user's owned teams. It requires one exact NFL 2026 game and exact owned team `7` in league `420010`. Yahoo's OAuth-only `xoauth_yahoo_guid` field is deprecated and is therefore optional; a returned token GUID may corroborate, but never replaces, the Fantasy ownership proof.

4. Run the read-only roster proof:

   ```sh
   node analysis/yahoo-fantasy-readonly.mjs roster
   ```

   Readiness requires all of the following in that natural run: token refresh succeeds; the authenticated Fantasy response matches the enrolled GUID when one was visible, or re-proves the exact enrolled owned-team binding when Yahoo hid it; that user owns exact team `7` in exact league `420010` for NFL season 2026; the roster response is for the resulting exact team key; and the roster is non-empty. The JSON result intentionally contains no identity value or token.

## Failure posture

Errors are short codes and never include Yahoo response bodies, callback URLs, authorization headers, or Keychain values. Multiple authenticated users, a changed visible GUID, missing exact owned-team proof, wrong season, wrong league/team, empty roster, token rotation that cannot be stored, redirect, or unexpected host fails closed. A missing or hidden GUID is accepted only when the authenticated-current-user owned-teams contract proves the exact target. There is no retry, alternate account, HTTP callback, TLS bypass, or fallback credential source.

## Weekly read operations

`analysis/yahoo-fantasy-operations.mjs` reuses enrolled refresh/identity binding and verifies the exact owned 2026 league/team on every command.

```sh
node analysis/yahoo-fantasy-operations.mjs snapshot
node analysis/yahoo-fantasy-operations.mjs candidates FA:0:25
node analysis/yahoo-fantasy-operations.mjs candidates W:0:25
```

- `snapshot`: verified current week, league waiver settings and slot counts, current roster eligibility/selected positions/status, team-specific pending waivers/trades, and up to 25 recent completed league transactions.
- `candidates`: one league-specific free-agent or waiver page, with ownership. Follow `nextStart` until null to finish the selected pool; a single page is not the full waiver universe. Repeated/changed pages across a live scan must be reconciled by player key, not assumed atomic.
- Missing collections, wrong league/team/week, invalid counts, duplicate players, taken candidates, or potentially truncated pending claims fail rather than pretending data is complete.
- Null status is unreported, not a health clearance. Roster-wide editability is not proof that an individual player's game is unlocked. `playerLocksVerified` remains false. Unknown eligibility cannot authorize a move.
- Waiver rules/days are not a verified processing clock; `verifiedReleaseTime` remains null. Verify the actual deadline/release in Yahoo before scheduling an execution event.
- No Yahoo projection replaces the existing custom weekly model. Match available-player keys/identities to that model and retain its season/week/source cutoffs.

### Actual access capability

As checked September 23, 2026, the installed app displays **Fantasy Sports - Read** only. Yahoo's [current access page](https://sports.yahoo.com/developer/access/) states that API access is currently read-only and write access is unavailable. The [reference guide](https://sports.yahoo.com/developer/docs/) still describes historical POST/PUT endpoints; these examples do not establish this application's permission. This implementation contains no Fantasy POST/PUT/DELETE, transaction executor, approval-packet framework, or speculative write fallback.

Use the API for research and read-only verification once live access is proven. Use the existing permitted signed-in Safari workflow for exact Joe-approved lineup/IR/add-drop/waiver changes. Revalidate live identities, availability, locks, legal slots/drop, exact approval conditions and expiry; preserve free-agent-only versus priority-spending mode; verify the resulting roster and transaction receipt. Do not repeat an ambiguous submission through the other route. Old completed approvals are not reusable.

### Acceptance and automation handoff

These commands are acceptance instructions, not a claim they have already succeeded. They use the existing Keychain and may persist a rotated refresh token. The prior direct-agent Keychain denial must be resolved through supported permission review; never evade it through another process, credential source or changed protections. Owner enrollment/roster proof does not prove unattended access. No new login or app recreation is implied.

Before switching the existing heartbeat to API reads, verify a real refreshed `snapshot` against the live Safari roster, exact 2026/420010/7 target, current week, player identities/slots and pending claims; verify FA and W page responses as well. Record only sanitized results. If access or response validation fails, report the actual blocker and use the already-permitted browser read path without claiming API readiness. Do not restore polling or add another automation. Keep the weekly custom rankings fixed between authorized refreshes.

References: [Yahoo Fantasy API access](https://sports.yahoo.com/developer/access/), [API reference](https://sports.yahoo.com/developer/docs/), [token flow](https://developer.yahoo.com/oauth2/guide/flows_authcode/), and [bearer requests](https://developer.yahoo.com/oauth2/guide/apirequests/).
