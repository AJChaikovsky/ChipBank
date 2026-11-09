# ChipBank

**Live:** https://chipbank.expo.app

Splitwise for home poker. Track buy-ins, rebuys, and cash-outs live across phones, then get the shortest list of who pays whom.

ChipBank **never holds or moves money**. It's a ledger. Payment happens in Venmo, Cash App, or cash, and the app pre-fills the amount.

- **App:** Expo SDK 58 + Expo Router + TypeScript. One codebase for iOS and web.
- **Backend:** Supabase (Postgres, Auth, Realtime, Row-Level Security).
- **Money:** integer cents everywhere, and an append-only ledger where you void entries instead of editing them.
- **Rules:** the host is the banker. Every write goes through a Postgres function that checks this. Settlement is computed on the server.

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (the free tier is fine).
2. **Run the schema.** In the dashboard, open SQL Editor, paste all of
   [`supabase/migrations/20261109000000_init.sql`](supabase/migrations/20261109000000_init.sql), and run it.
   Or use the CLI: `npx supabase link --project-ref <ref> && npx supabase db push`.
3. **Auth settings.** Authentication → Providers → Email is on by default. For quick testing with friends you can turn off
   "Confirm email". Otherwise new users confirm by email before signing in.
4. **Env vars.**
   ```bash
   cp .env.example .env   # fill in URL + anon key from Project Settings → API
   npm install
   ```
5. **Run.**
   ```bash
   npx expo start         # press i for the iOS simulator, w for web, or scan the QR code with Expo Go
   ```

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Settlement unit and property tests, plus database tests that run the real migration in embedded Postgres (PGlite) |
| `npm run typecheck` | `tsc --noEmit` |
| `npx expo export --platform web` | Static web build in `dist/` (deploy to Vercel, Netlify, or EAS Hosting) |

## Deploy

The project is linked to Expo as `@ajchaikovsky/chipbank`. The Supabase env vars are stored in EAS for the `production` and `preview` environments.

**Web (EAS Hosting):**
```bash
npx expo export --platform web   # reads .env; re-run before every deploy
npx eas-cli@latest deploy --prod # first run asks for a subdomain → https://<name>.expo.app
```
Afterwards, in Supabase → Authentication → URL Configuration, set **Site URL** to the deployed URL.

**iOS (App Store):** needs a paid Apple Developer account ($99/yr).
```bash
npx eas-cli@latest build --platform ios --profile production --auto-submit
```
EAS creates the signing certificates, builds in the cloud, and uploads the build to App Store Connect. It appears in TestFlight in about 15 minutes. Submit it for review from App Store Connect.

## How a game works

1. **Create a game.** Start from Games → New game, or from a crew to seat everyone at once. Set a default buy-in.
2. **Lobby.** Share the 6-letter code (tap it to copy an invite). Friends join with the code, and the host adds friends or **guests** (people without the app).
3. **Start.** The timer starts, and everyone without a buy-in is bought in at the default.
4. **Live.** The host logs rebuys and cash-outs. A player can leave early (cash out) and come back (rejoin with a rebuy). Mistakes are voided, not deleted. Every phone updates in real time.
5. **Settle up.** The host enters the remaining stacks. The balance check shows whether the cash-outs equal the buy-ins. If they don't, the host can **recount** or **split the difference by buy-in**. Two payout styles: **fewest payments** (at most n−1) or **everyone pays the host**.
6. **Settled.** Each payment has a **Pay on Venmo** button (if the payee set a Venmo username in Me) and **Mark paid**.

## Layout

```
src/app/                 routes (Expo Router)
  (tabs)/                Games · Friends · Crews · Me
  game/[id].tsx          lobby / live / settle / results
  group/[id].tsx         crew members + leaderboard
  new-game.tsx, join.tsx, sign-in.tsx
src/components/          ui kit, game panels
src/lib/
  settle.ts              settlement math (mirrors finalize_game in SQL)
  useGame.ts             game state + realtime sync
supabase/migrations/     schema, RLS, RPC functions
tests/                   vitest + fast-check + PGlite
```

## Still to do

- Push notifications (friend requests, game invites, "you owe $40" reminders) with `expo-notifications`
- Sign in with Apple (required by the App Store only if you add Google or other social logins)
- Claim a guest seat after the guest signs up
- Players request rebuys and the host approves
- Universal links (so `https://yourdomain/join?code=…` opens the app), then EAS Build and TestFlight
- Nice-to-haves: chip-to-dollar ratio, blind timer, shareable recap, CSV export
