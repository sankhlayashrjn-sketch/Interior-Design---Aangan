# Deploying to Vercel and Neon

How the app runs there, and the steps to put it online.

**Neon is set up and verified.** The schema has been applied to your Neon project (`round-butterfly-73023080`, branch `production`, region us-east-2), and an end-to-end smoke test passed there (see "Checking the database"). **Vercel has not been tried yet**, so do the first deployment carefully and check it with the commands in step 4.

## How it works on Vercel

Vercel runs short-lived functions. It has no disk and no always-on process, so three things differ from running on your laptop:

| On your laptop / own server | On Vercel |
|---|---|
| Database is a local folder (PGlite) | **Neon Postgres**, through `DATABASE_URL` |
| A timer inside the server ticks every minute | **Vercel Cron** (daily on Hobby, every minute on Pro) plus an outside pinger calls `GET /api/cron/tick` |
| Telegram is polled by the server | Telegram calls the **webhook** `/api/telegram/webhook` |

The tick does everything the timer does: scores any waiting call, sends due reminders, and syncs HubSpot. It is safe to run any number of times and from several places at once (claims and leases in the database stop two runs doing the same work).

HubSpot updates triggered by a click or a call are sent through Next's `after()`, so Vercel keeps the function alive until they finish. If HubSpot is down, the change stays queued and the next tick retries it.

## Before you start

- The code on GitHub, in a **private** repository (it contains your internal rate card in `context/pricing.md`).
- A Vercel account. **Plan matters:** Vercel's free Hobby plan allows cron jobs only **once a day**, so a 1-hour reminder promise needs **Pro**, or an outside pinger (see "If you are on Hobby"). See [Vercel's cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
- A Neon project.

## 1. Neon

**Already done:** the tables exist on the `production` branch. Your connection strings are saved in the git-ignored file `.env.neon` in the project folder (`DATABASE_URL` is the pooled string, `DATABASE_URL_UNPOOLED` the direct one). Open that file and copy the two values into Vercel; they are not in the repository and not in this guide.

- Use the **pooled** string (the host contains `-pooler`) as `DATABASE_URL` on Vercel.
- Optionally add the **direct** string as `DATABASE_URL_UNPOOLED`. The build step uses it for migrations, as Neon recommends.
- Neon's free plan allows several branches. If you want Vercel Preview deployments, give them their own branch and string, because **each deployment runs the migrations** and previews must never migrate your production data.

Your Neon project is in **us-east-2** (Ohio). `vercel.json` pins the functions to `iad1` (Washington DC), the closest Vercel region, so the app and its database are a few milliseconds apart. From your own laptop in India each query takes a few hundred milliseconds, which is why local development uses the local database.

## 2. Vercel project

1. Import the GitHub repository into Vercel. The framework is detected as Next.js. The build runs `npm run vercel-build`, which applies the database migrations and then builds.
2. Add environment variables (Settings, Environment Variables). Fastest: copy the values from your local git-ignored `.env.vercel` (it is built from `.env` and `.env.neon`, with fresh random secrets) and paste them into the first box, which accepts a whole `KEY=value` file. Set `APP_BASE_URL` to your real address. Set **Production** and **Preview** separately.

| Variable | Production | Notes |
|---|---|---|
| `DATABASE_URL` | Neon production pooled string | Preview: the `preview` branch string |
| `DATABASE_URL_UNPOOLED` | Neon direct (non-pooled) string | Used by the build to apply migrations |
| `AUTH_SECRET` | a long random string | Signs the login cookie |
| `APP_BASE_URL` | `https://<your-project>.vercel.app` | Must be https. Used in Telegram messages and the HubSpot link |
| `APP_PASSWORD` | a long password | **Required.** Without it the app locks itself |
| `CRON_SECRET` | a long random string | **Required.** Vercel sends it to the cron route automatically |
| `INGEST_API_KEY` | a long random string | **Required.** Vaani sends it as header `x-api-key` |
| `AI_MODE`, `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL` | live, gemini, key, gemini-3.8-flash | Or `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`; or `mock` to try it out |
| `HUBSPOT_MODE`, `HUBSPOT_TOKEN`, `HUBSPOT_PORTAL_ID` | live, key, id | See [HUBSPOT.md](HUBSPOT.md) |
| `TELEGRAM_MODE`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | live, token, a random string | |
| `CALCOM_MODE`, `CALCOM_WEBHOOK_SECRET` | when you use Cal.com | |
| `TELEPHONY_COST_PER_MIN_INR`, `AI_INPUT_COST_PER_MTOK_INR`, `AI_OUTPUT_COST_PER_MTOK_INR` | your real rates | The defaults are placeholders |

   Use **mock** modes in Preview so test deployments never message real people or write to your real HubSpot.
3. Deploy. The first build creates the tables.

`vercel.json` contains a once-a-day cron (`GET /api/cron/tick` at 03:00 UTC), which the free Hobby plan allows. It is only a safety net: for reminders on time, ALSO set up the free external pinger in "If you are on Hobby" below (every 5 minutes, or every minute on Pro with `* * * * *`).

## 3. First-run setup

1. Open the site and sign in with `APP_PASSWORD`.
2. Go to **Settings**, add your designers, and set working hours.
3. **Telegram:** from your own computer, with the production values in your environment, run `npm run telegram:webhook`. It registers `https://<project>.vercel.app/api/telegram/webhook` with Telegram using your secret. Then in Settings press "Make a Telegram link" for each designer. Their Open buttons now work, because the address is https.
4. **HubSpot:** run `npm run hubspot:check` locally with the same token. When the scopes show OK, the next tick creates the properties and the "Phone Enquiries" pipeline.
5. **Vaani:** send calls to `POST https://<project>.vercel.app/api/calls` with header `x-api-key: <INGEST_API_KEY>`.

## Checking the database

From the project folder, with `.env.neon` present:

```bash
npm run db:check:neon      # connects, lists the tables, proves a write, read, delete and lock work, never prints the string
npm run smoke:neon         # runs the app's real code (scoring, assignment, reminders, founder numbers) against Neon, then removes its own rows
npm run dev:neon           # runs the whole app against Neon (slow from India, and writes real data)
```

The smoke test forces every integration to mock, and **refuses to run on a database that already has calls or designers**, so it can never touch real data. The same two commands work on any database: `npm run db:check` and `npm run smoke` use the local one.

## 4. Check it is alive

```bash
curl -i https://<project>.vercel.app/login                                          # 200, a sign-in page
curl -i https://<project>.vercel.app/founder                                         # 307 to /login
curl -i -H "Authorization: Bearer <CRON_SECRET>" https://<project>.vercel.app/api/cron/tick   # 200 and a small JSON summary
curl -i -X POST https://<project>.vercel.app/api/calls -d '{}'                       # 401 without the key
```

In Vercel, the Cron Jobs tab and the Logs show each tick.

## If you are on Hobby

Vercel rejects a per-minute cron on Hobby and the deployment fails with a message about the schedule. Two ways out:

1. **Upgrade to Pro** (simplest; keeps everything in one place).
2. Change `vercel.json` to a daily schedule (for example `"0 9 * * *"`) and call the tick from an outside scheduler every few minutes with the header `Authorization: Bearer <CRON_SECRET>` (a service such as cron-job.org, or a GitHub Actions workflow, whose minimum is about 5 minutes). Reminders then arrive up to that many minutes late, so the 1-hour SLA still holds but is less exact.

## Good to know

- **Neon and the cron:** a tick every minute keeps the Neon database awake all day, which uses compute allowance on Neon's free plan. Check your plan's limits.
- **Function time:** the tick and the ingest route allow up to 120 seconds, enough for the AI call. Your plan's maximum applies.
- **Files the AI reads:** `context/*.md` and `prompts/*.md` are bundled into the deployment by `next.config.ts`. Editing them means redeploying.
- **Secrets:** keep them in Vercel's environment variables, never in the repository. Rotate any key that has ever been pasted into a chat or a ticket.
- **Migrations:** change `src/db/schema.ts`, run `npx drizzle-kit generate`, commit the new SQL in `drizzle/`, and the next deployment applies it.
- **Local development:** `npm run dev` still uses the local PGlite folder and needs no accounts. Point `DATABASE_URL` at a Neon **branch** if you want to try the real thing from your laptop, never at production.

## Not yet verified

- A real Vercel deployment: the build, the cron, and the function region. (Neon itself is verified: see "Checking the database".)
- That Vercel sends `CRON_SECRET` as `Authorization: Bearer ...` exactly as the code expects (this is how Vercel documents it, but confirm on the first run: a 401 in the Cron tab means the secret is not matching).
