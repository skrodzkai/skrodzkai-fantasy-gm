# Yahoo Fantasy read-only connection

This source-only connector is fixed to NFL season 2026, league `420010`, and team `7`. It does not expose a generic Yahoo client and contains no roster mutation method. Its only network operations are:

- `POST https://api.login.yahoo.com/oauth2/get_token` for the authorization-code exchange or refresh grant.
- `GET` the signed-in user's 2026 NFL league/team membership from the Yahoo Fantasy API.
- `GET` the verified target team's roster from the Yahoo Fantasy API.

The connector has not been enrolled, run against Yahoo, installed, or deployed. App `Zkzv5U7y` and its registered redirect `https://localhost:8765/callback` are inputs to the later owner-approved setup, not evidence that runtime access works.

## Security boundary

Client ID, client secret, refresh token, and bound Yahoo GUID live only as generic-password items in the user's default macOS Keychain under service `com.skrodzkai.fantasy.yahoo`. The connector never accepts them through command-line arguments, environment variables, repository files, or normal output. Access tokens remain in memory for one invocation. Yahoo may rotate a refresh token; the connector persists the replacement before making a Fantasy resource request and fails closed if that Keychain update fails.

The initial grant and every roster run read the Keychain. Initial grant and refresh-token rotation also change it. Those are credential/security operations and require the coordinator's or user's explicit approval before execution. Keychain prompts and Yahoo sign-in/consent are owner-controlled; they must not be automated around.

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

4. Run the read-only roster proof:

   ```sh
   node analysis/yahoo-fantasy-readonly.mjs roster
   ```

   Readiness requires all of the following in that natural run: token refresh succeeds; the token's bound Yahoo GUID matches the signed-in user; that user is a manager of exact team `7` in exact league `420010` for NFL season 2026; the roster response is for the resulting exact team key; and the roster is non-empty. The JSON result intentionally contains no GUID or token.

## Failure posture

Errors are short codes and never include Yahoo response bodies, callback URLs, authorization headers, or Keychain values. A wrong identity, missing membership, wrong team, empty roster, token rotation that cannot be stored, non-GET Fantasy request, redirect, or unexpected host fails closed. There is no retry, alternate account, HTTP callback, TLS bypass, write endpoint, or fallback credential source.

References: [Yahoo authorization-code flow](https://developer.yahoo.com/oauth2/guide/flows_authcode/), [Yahoo API bearer requests](https://developer.yahoo.com/oauth2/guide/apirequests/), and [Yahoo APIs overview](https://developer.yahoo.com/api/).
