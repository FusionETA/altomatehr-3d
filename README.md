# Globe Live Floor

A 3D city map of Globe's three companies, live from AltomateHR:

- **Clocked in** people stand at their project (green ring), or outside its geofence (orange `!`).
- **Not clocked in yet**, or **clocked out**, people sleep at the **Snooze Inn**.
- **On approved leave** people relax at the **Leave Beach**.
- Each company has its own district, colour and name label. Click a name, a project, the hotel or the beach for the list.

It refreshes every 30 seconds. When someone clocks in, they get out of bed and walk to work.

## How it works

```
browser (office network)  →  server.js  →  AltomateHR public API (one read-only key per company)
```

`server.js` keeps the three keys on the server. It never sends them to the browser. It reads, per company:

| Call | How often |
|---|---|
| `GET /attendance/org/today` | every refresh |
| `GET /leave/on-leave-today` | every refresh |
| `GET /organizations/current`, `GET /projects`, `GET /employees` | every 10 minutes |

It merges the three companies into one snapshot at `/api/floor`. That snapshot carries only names, job titles and clock-in status: no emails, selfies or GPS coordinates. Each company is read with its own key, so the companies stay separate in AltomateHR.

`/attendance/org/today` is new in AltomateHR (branch `zr-attendance-org-today`). Until it's deployed, the map shows "AltomateHR does not have the /attendance/org/today endpoint yet".

## Setup

1. **Keys.** A Fusioneta superadmin creates one API key in each Globe company through AltomateHR's API keys screen (superadmin only; customers can't make keys themselves) with these scopes:
   `attendance:read, leave:read, projects:read, employees:read, organizations:read`. Read-only, nothing else.
2. **Settings.** `cp .env.example .env`, then fill in `ALTOMATE_API_URL` and `GLOBE_KEYS`. Use the order Engineering, Express, Success Learning.
3. **Run** (Node 18 or newer; no `npm install` needed):

   ```bash
   node server.js
   ```

4. Open `http://localhost:8080` and press **📺 Big screen** for the TV.

## Office network only

There is no login. Access is limited to the office network:

- `HOST=127.0.0.1` (the default) means only the computer running it can open the page. That suits a TV PC.
- `HOST=0.0.0.0` lets other office computers open it at `http://<that-pc's-ip>:8080`.
- Either way, any request from outside private address ranges (`ALLOW_NETWORKS`) gets `403`.
- **Don't port-forward it or put it on the internet.** It shows staff names and where they are.

## Known limits

- **"Not clocked in"** means everyone with no clock-in today, including people on a rest day. AltomateHR's API doesn't expose rosters yet.
- **Gender** isn't in the API, so every figure uses the neutral build.
- **New busy projects:** when a project gets its first clock-in of the day, the page reloads once to give it a city block. Districts have room for 8 (Engineering), 4 (Express) and 3 (Success Learning) busy projects; any more are listed under "Quiet sites" as busy but not on the map.
- **New employees** appear after the nightly reload, which happens automatically at midnight.
- three.js loads from a CDN, so the PC needs internet access (it needs it for AltomateHR anyway).
