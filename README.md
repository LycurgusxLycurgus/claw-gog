# ClawGog Calendar App

ClawGog is a single-tenant, Telegram-first calendar assistant built around Convex, Google Calendar, Gemini, and a minimal Render-hosted operator UI.

## Current status

This repository now includes:

- Convex schema and HTTP entrypoints
- Environment validation
- Telegram webhook normalization and allowlist checks
- Google Calendar and Gemini adapters
- Daily digest formatter
- Static operator shell
- Smoke and integration tests
- Render config and GitHub Actions CI scaffold

The foundation is in place. The remaining work is finishing the live Convex mutations/actions, persistence wiring, OAuth callback persistence, and full pending-action lifecycle.

## Local setup

1. Copy `.env.example` to `.env.local` and fill every value.
2. Install dependencies:

```bash
npm install
```

3. Run tests:

```bash
npm test
```

4. Start local development:

```bash
npm run dev
```

5. In the browser console on the static UI, set:

```js
localStorage.setItem("ClawGog_convex_url", "https://YOUR-CONVEX.convex.site");
```

## GitHub

1. Create a new GitHub repository.
2. Initialize git locally if needed:

```bash
git init
git branch -M main
git add .
git commit -m "feat: scaffold ClawGog calendar app"
```

3. Add the remote and push:

```bash
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

4. In GitHub repository settings, add these Actions secrets:

- `CONVEX_DEPLOY_KEY`
- `CONVEX_DEPLOYMENT`

## Convex deployment

1. Create a Convex project in the Convex dashboard.
2. Authenticate locally:

```bash
npx convex login
```

3. Link the project:

```bash
npx convex init
```

4. Set environment variables in Convex dashboard from `.env.example`.
5. Deploy:

```bash
npm run deploy:convex
```

6. Confirm the health route works:

```text
https://YOUR-CONVEX.convex.site/health
```

## Render deployment

1. Create a new Static Site in Render and connect the GitHub repo.
2. Keep root directory as repository root.
3. Publish directory must be `web`.
4. After deployment, set `APP_BASE_URL` in Convex to the Render URL.

## Google Calendar setup

1. In Google Cloud Console, create OAuth credentials of type Web application.
2. Add the Convex callback URL from `GOOGLE_OAUTH_REDIRECT_URI`.
3. Add the Render URL to authorized JavaScript origins only if you later move login initiation to the frontend.
4. Enable Google Calendar API.

## Telegram setup

1. Create a bot with BotFather and get the bot token.
2. Put `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_ID`, and `TELEGRAM_DEFAULT_CHAT_ID` into Convex env vars.
3. Register the webhook:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://YOUR-CONVEX.convex.site/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>
```

4. Message the bot from the allowed Telegram account.

## Other service recommendation

If you want a simple custom domain and DNS layer, add Cloudflare in front of Render and Convex:

- custom domain for the Render static UI
- proxied DNS management
- optional WAF and rate limiting

## CI/CD

The included GitHub Actions workflow runs tests on pushes to `main`. Extend it once Convex deploy credentials are ready.
