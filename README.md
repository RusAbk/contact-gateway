# Contact Gateway

Independent Node.js contact page in the `RusAbk/contact-gateway` repository. It has its own npm lockfile, Docker image, data volume, and GitHub Actions workflow. It does not use LMS packages, its API, or its database.

## Install on a clean server

Point a DNS record for the contact domain to an x86-64 Debian/Ubuntu server with an existing Caddy proxy on ports 80/443. Caddy can be a host service or a Docker container. The installer detects either; for Docker Caddy it joins the proxy's network and registers a site block. It asks for a GitHub token with access to the private repository and GHCR package, the contact domain, a Telegram bot token, a destination chat ID, and an administrator password. It installs Docker if necessary and waits for the GitHub Actions image for the current commit.

Run this one command in Bash on the server:

```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates && read -rsp 'GitHub token: ' GH_TOKEN && echo && installer=$(mktemp) && curl -fsSL --proto '=https' --tlsv1.2 -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github.raw+json' 'https://api.github.com/repos/RusAbk/contact-gateway/contents/deployment/install.sh?ref=main' -o "$installer" && sudo GH_TOKEN="$GH_TOKEN" bash "$installer"; result=$?; if [[ -n "${installer:-}" ]]; then rm -f -- "$installer"; fi; (exit "$result")
```

Update later with:

```bash
sudo bash /opt/contact-gateway/update.sh
```

The installation lives in `/opt/contact-gateway`; `.env` and `.github-token` are readable only by root. WhatsApp credentials and the recent-chat index live in `/opt/contact-gateway/data` and survive image updates. The image is built by `.github/workflows/build.yml` on every push to `main`. Wait for the workflow to finish before installing or updating; the installer also waits for the image for the latest commit.

## Use

1. Open `https://<domain>/admin`, sign in with the installation password, and scan the WhatsApp Web pairing QR with the WhatsApp app's **Linked devices** screen.
2. The app derives the account's phone number when Baileys provides it. If WhatsApp only exposes a LID and no number, enter the account's international number in the admin panel. The public QR points to `wa.me/<number>`.
3. Visitors choose email, phone, or WhatsApp. Email and phone with optional name/company go directly to the configured Telegram chat. WhatsApp visitors scan the public QR and send a message.
4. On the public page, select WhatsApp. Below the QR, sign in with the administrator password, or use an existing session from `/admin`. Refresh the recent incoming chats there, select a chat, and confirm to send its contact details and avatar to Telegram. A chat with no incoming message cannot be selected.
5. In the same private area, enter an international phone number or scan a WhatsApp QR code with the camera or an image. The app supports `wa.me/<number>` links and WhatsApp contact QR links such as `wa.me/qr/<code>`. Search for the contact, write a message, and send it from the linked WhatsApp account. Camera scanning requires HTTPS. Searches and outbound sends require an administrator session and are rate limited.

The recent-chat index stores a preview and identity metadata, not full message history or media. Unlinking WhatsApp clears this index and the pairing credentials. The public page never exposes private chats or the pairing QR. The container publishes only a localhost port for host Caddy and has no public Docker port.

Baileys is an unofficial WhatsApp Web client. This project pins `@whiskeysockets/baileys@7.0.0-rc14`; pairing and event behavior should be checked against a real account after installation. The LID/PN mapping and name priority follow the [Baileys v7 migration guide](https://github.com/WhiskeySockets/docs/blob/main/migration/v7.mdx) and its [event definitions](https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/Events.ts).

## Local checks

```bash
cd contact-gateway
npm ci
npm test
```

For local running, provide the variables in `.env.example` as environment variables, generate `ADMIN_PASSWORD_HASH` with Node's `scryptSync` in `salt:hash` format and a random 64-character hex `SESSION_SECRET`, set `PUBLIC_ORIGIN=http://localhost:8080`, then run `npm run dev`.
