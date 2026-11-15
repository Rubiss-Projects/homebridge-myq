<img src="assets/icon.svg" width="64" height="64" alt="">

# homebridge-myq-connect

Homebridge 2.x integration for myQ garage doors, with guided iPhone sign-in and automatic credential renewal. Requires Linux or macOS for the setup worker. This independent project is not affiliated with Chamberlain or LiftMaster. Account/device reads, refresh-token renewal, and supervised door control have been verified against myQ iOS 5.324.0. The guided iPhone setup imports credentials from an authorized app login; subsequent renewal runs in the plugin. The generated iPhone profile, official app login, automatic credential import, manual profile removal, and subsequent phone-free renewal have been verified on a physical iPhone.

## Installation

The npm package name is **homebridge-myq-connect**, distinct from the discontinued `homebridge-myq` package. Once published to npm, search for that exact name in Homebridge’s Plugins tab, or run `npm install -g homebridge-myq-connect`. GitHub releases include an installable `.tgz` for manual installation.

Open plugin settings, complete **Connect myQ**, enable garage controls if desired, and pair its child bridge using the instructions below. iPhone-assisted enrollment is supported; Android enrollment is not yet supported. Do not install this alongside the private development package: both use the `MyQReadOnly` platform alias. Existing development installations should preserve their config, child-bridge identity, and token file while replacing the package.

## Configuration

```json
{
  "platform": "MyQReadOnly",
  "name": "myQ",
  "pollIntervalSeconds": 60,
  "enableControl": false
}
```

The platform alias and accessory identifiers remain stable for existing installations. Read-only mode exposes each door as a contact sensor. Closed means contact detected; open, opening, closing, and stopped mean contact not detected. Unknown, offline, missing, stale, and failed reads report communication errors.

With `enableControl: true`, the accessory exposes only a primary GarageDoorOpener service. Any cached contact-sensor service is removed automatically. Commands require a fresh online status and myQ's unattended-action permission. Discovery and polling never issue door commands. Commands are not automatically repeated, including after a timeout or authentication failure. Current state always comes from observations; a successful command response does not imply the door reached its target. After an accepted command, status is polled every five seconds for up to 90 seconds. Unknown obstruction data means no reported obstruction, not proof that the doorway is clear.

## Add to Apple Home

Use a dedicated child bridge so myQ has its own pairing QR code. In Homebridge UI, open **Plugins → homebridge-myq-connect → Child Bridge Config** (or **Set Up Child Bridge**), enable the child bridge, name it **myQ Garage**, and restart Homebridge. The UI generates a unique bridge identity and port; do not copy another installation's bridge identity.

Open the plugin's child bridge settings to display its QR code. On your iPhone, open **Home → + → Add Accessory** and scan that code. If scanning is inconvenient, choose **More Options**, select **myQ Garage**, and enter the setup code shown in Homebridge. Pairing the main Homebridge bridge does not pair its child bridges.

Control mode uses the door’s myQ name (for example, **Garage Door**). Read-only mode adds **Status** to that name. Assign the accessory to your Garage room and rename it in Home if desired. Enable `enableControl` to expose garage-door controls; otherwise it appears as a contact sensor. Moving an existing accessory to a child bridge requires pairing the new bridge and may require recreating its Home automations. Leave your existing main bridge and other child bridges paired.

## Guided iPhone setup

Open the plugin settings in Homebridge and choose **Connect myQ**. Select Homebridge's address on the same private LAN as your iPhone, enter the exact Wi-Fi network name, and optionally enter its password (the iPhone may prompt if omitted). This currently supports personal WPA-family Wi-Fi networks, not enterprise Wi-Fi or Android.

Scan the QR code, or open its link in Safari on the iPhone. The phone page guides you through installing **myQ Temporary Setup**, enabling trust for its uniquely named certificate, and signing out and back into the official myQ app. Complete myQ's normal verification. Homebridge validates the resulting credentials using account/device reads and saves them privately; there are no tokens to copy or files to edit.

This is explicit, temporary interception of the official app's sign-in. Use a trusted private LAN. The trusted certificate is a root certificate; the PAC routing rules do not cryptographically limit its authority. Its private key stays in the setup worker's memory. The listener accepts only the phone that opened the unguessable setup link, forwards allowlisted identity traffic and read-only myQ requests, and rejects device changes. Unrelated domains stay direct. No passwords, cookies, verification codes, or traffic bodies are logged. The optional Wi-Fi password exists only in memory and the downloaded temporary profile, not Homebridge configuration.

After **Connected**, remove the temporary profile in **Settings → General → VPN & Device Management**, verify your normal Wi-Fi connection, and click **I removed the profile — finish setup** in Homebridge. The profile also has a 15-minute automatic-removal deadline. The listener expires after 15 minutes, even if you close Homebridge settings; reopening settings reconnects to the active setup. If cancelled, expired, or interrupted, remove the profile before retrying. Never leave a temporary certificate trusted indefinitely.

During setup this plugin's door commands are paused. Use only sign-in and status screens during setup. Validation never moves the door. Existing credentials remain unchanged if validation fails. Successful import is picked up by the next poll; newly installed plugins still need a Homebridge restart. Automatic renewal lasts while myQ accepts the session; revocation requires repeating setup.

The guided flow has been verified on a physical iPhone through profile installation, certificate trust, official myQ login, successful credential import, and manual profile removal. Homebridge then rotated both credentials and read the garage successfully without the phone proxy. Local tests cover TLS forwarding, command blocking, DHCP-address handoff, failed/cancelled imports, and worker cleanup. Automatic profile removal is configured using Apple’s removal-deadline fields; removal at that deadline has not yet been observed on a physical iPhone, so the normal flow still asks users to remove the profile themselves.

## Credentials

Keep the token file private (`0600`), outside source control and Homebridge's configuration editor:

```json
{
  "accessToken": "ACCESS_TOKEN",
  "refreshToken": "REFRESH_TOKEN",
  "expiresAt": 1800000000000
}
```

`expiresAt` is the token expiration in Unix milliseconds, not seconds. The original access-token-only file remains supported, but cannot renew. The default location is `myq-readonly-token.json` in Homebridge's storage directory.

The renewal implementation uses the app's identity host and client ID, shares concurrent refresh attempts, persists rotated credentials atomically before use, and honors server Retry-After backoff. Invalid sessions require replacement credentials. Replacing the file is detected without restarting Homebridge. The process needs write permission on the containing directory for atomic renewal.

Initial setup still requires both tokens from an authorized app session; the guided wizard above automates their import. A native system-browser prototype completes login and MFA, but myQ rejects its authorization-code exchange with application-authorization error 401.122. Refresh-token exchange has been verified without app cookies, AppCheck, or bearer headers. If myQ revokes the session, credentials must be bootstrapped again; an access token alone cannot renew.

## Build

Requires Node 22+ and Homebridge 2.x.

```sh
npm ci
npm test
npm pack
```

Install a release tarball in Homebridge’s persistent plugin directory and restart after configuration. See [release instructions](https://github.com/Rubiss-Projects/homebridge-myq/blob/main/RELEASING.md) for CI, tagged GitHub releases, and npm publishing.

## Protocol evidence

Verified live reads:

- `GET https://accounts.myq-cloud.com/api/v6.0/accounts`
- `GET https://devices.myq-cloud.com/api/v6.2/Accounts/{accountId}/Devices`

The verified command is a bodyless `PUT` to `https://account-devices-gdo.myq-cloud.com/api/v6.0/Accounts/{accountId}/door_openers/{serial}/{open|close}`. A supervised Homebridge test confirmed open and close commands and API-reported movement. Redirects are refused and credentials/raw API responses are not logged.

Tests cover token rotation, concurrent refresh, rate limits, token replacement, discovery, stale/offline handling, command gating, ambiguous command failures, HomeKit state transitions, and migration between read-only and garage-control services. They use fake API responses and do not actuate a door.


## Sign-in development status

A macOS system-browser helper and PKCE exchange implementation are available for development. The live test reached the myQ login form, completed email MFA, and delivered the `com.myqops://ios` callback to the helper without a proxy. The subsequent token exchange returned HTTP 401, provider code `401.122` (application unauthorized). This is not a bad-password error, and retrying the user login is not a remedy.

A controlled comparison confirmed the application-authorization gate: the same deliberately invalid authorization-code request returned `401.122` without AppCheck and reached OAuth validation (`400 invalid_grant`) with the genuine app’s `firebase-appcheck-token`. The independent helper does not have an accepted app-attestation value. This proves that the header removes the observed application gate; it does not establish a proxy-free way to obtain that header. The Marketplace website uses a server-side login session rather than exposing an alternative public token flow. No supported generic phone-to-Homebridge credential handoff was found in the official integration instructions or bounded readable app metadata. The main app executable is encrypted, so this is not an exhaustive claim about all internal routes. No working proxy-free initial-token flow is claimed, and no nonfunctional sign-in button has been deployed.

Development probe (macOS with Xcode command-line tools):

```sh
npm run login:macos -- /absolute/private/test-token-file.json
```

Use a separate test path, not the running plugin's credentials. The helper accepts the callback only for its short-lived PKCE session, rejects mismatched state/issuer and replay, and writes credentials only after a successful exchange that includes a refresh token. Passwords and MFA are entered into myQ's system-browser page; the helper does not receive them. This probe is not end-user setup instructions.
