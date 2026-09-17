# Institutional and trial access codes (admin)

All routes require header **`X-Admin-Code`** (same value as `ADMIN_CODE` in env; default in dev is often `1127`).

## Behavior

- **While `active: true` and within 90 days of creation**: any number of user accounts can redeem the same plaintext code (each account only once per code).
- **`PRSATLAS30` exception**: this built-in code has `max_redemptions = 1`. The first successful redeem grants **1 month** of PRS Atlas access and spends the code forever (later attempts are rejected). It has no 90-day window.
- **`PATCH ... active: false`**: the code **cannot be redeemed**. Deactivation does not shorten access already granted to people who redeemed earlier.
- **90-day redemption window**: new codes (including `IOWA-TRIAL`, `TEMPLE-TRIAL`, and `NUMC-TRIAL`) cannot be redeemed after 90 days from creation. If someone redeems on day 89, they still get the full access period (30 days for trial codes, 365 days for institutional). Only the ability to redeem expires at 90 days.
- **Plaintext is never stored** — only a bcrypt hash. When you **create** a code, copy the plaintext immediately to send to the institution.

### Code types

- **`institutional`** (default): 365 days of access from redemption.
- **`trial`**: 30 days of access from redemption. Each account may redeem a trial code **once** (any trial code). Redeeming a trial code does **not** consume the 7-day Stripe intro trial when that account later subscribes for the first time.

Built-in trial codes (case-insensitive lookup; 90-day redemption window starts when the row is created):

- **`IOWA-TRIAL`** (University of Iowa)
- **`TEMPLE-TRIAL`** (Temple University)
- **`NUMC-TRIAL`** (Nassau University Medical Center)

One-time promo (case-insensitive lookup; no 90-day window; **one redemption ever** across all accounts):

- **`PRSATLAS30`**: 1 month of PRS Atlas access. After the first successful redeem, the code cannot be used again.

## API

### List codes (no hashes)

`GET /api/admin/institutional-codes`

Response: `{ codes: [{ id, institutionName, specialtyId, codeType, active, createdAt, redeemExpiresAt }] }`

### Create code

`POST /api/admin/institutional-codes`  
JSON: `{ "plaintextCode": "SPRING2026", "institutionName": "Example University", "specialtyId": "prs", "codeType": "institutional" }`

`codeType` is `"institutional"` (default) or `"trial"`. `specialtyId` is `"prs"` (default) or `"ortho"`.

Response `201`: `{ id, codeType, redeemExpiresAt, message }`

### Activate / deactivate

`PATCH /api/admin/institutional-codes/:id`  
JSON: `{ "active": false }` or `{ "active": true }`

A deactivated code cannot be redeemed, even if it is still inside the 90-day window.

## Examples

```bash
export ADMIN=your_admin_code

curl -s -H "X-Admin-Code: $ADMIN" https://your-app.com/api/admin/institutional-codes

curl -s -X POST -H "X-Admin-Code: $ADMIN" -H "Content-Type: application/json" \
  -d '{"plaintextCode":"EMORY2026","institutionName":"Emory University"}' \
  https://your-app.com/api/admin/institutional-codes

curl -s -X POST -H "X-Admin-Code: $ADMIN" -H "Content-Type: application/json" \
  -d '{"plaintextCode":"IOWA-TRIAL","institutionName":"University of Iowa","codeType":"trial"}' \
  https://your-app.com/api/admin/institutional-codes

curl -s -X POST -H "X-Admin-Code: $ADMIN" -H "Content-Type: application/json" \
  -d '{"plaintextCode":"TEMPLE-TRIAL","institutionName":"Temple University","codeType":"trial"}' \
  https://your-app.com/api/admin/institutional-codes

curl -s -X POST -H "X-Admin-Code: $ADMIN" -H "Content-Type: application/json" \
  -d '{"plaintextCode":"NUMC-TRIAL","institutionName":"Nassau University Medical Center","codeType":"trial"}' \
  https://your-app.com/api/admin/institutional-codes

curl -s -X PATCH -H "X-Admin-Code: $ADMIN" -H "Content-Type: application/json" \
  -d '{"active":false}' \
  https://your-app.com/api/admin/institutional-codes/CODE_UUID_HERE
```
