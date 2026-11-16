# Dispatch manifest: upgrade and drain procedure

This document covers deploying the version of MailPulse that records a **dispatch manifest** on
every campaign it starts sending, and what an operator must do with campaigns that were already
sending under an older version.

It contains no secrets and requires no data migration. It does require one read-only check before
the upgrade and a full stop of the old version.

## 1. What changed

When a campaign starts sending, the same atomic update that moves it to `sending` and takes its
dispatch lease now also stores:

| Field | Meaning |
|---|---|
| `dispatchManifestVersion` | Always `1`. Its presence marks a campaign locked by manifest-aware code. |
| `dispatchManifestCount` | The number of recipients the lock intended. |
| `dispatchManifest` | The recipients: contact id, email and name snapshot. Never returned by the API or exports. |

Delivery records are generated from that stored list and verified to be **exactly** it before any
delivery may be claimed. Recovery (startup resume and the watchdog) completes an interrupted
generation from the same list instead of guessing from whatever deliveries exist.

The manifest is written once. A campaign that already carries one can never be locked again, so
its recipient list is never replaced.

## 2. How recovery treats each campaign

Recovery classifies every `sending` campaign **before taking its lease**:

| Stored fields | Classification | What recovery does |
|---|---|---|
| Version 1, matching count, well-formed unique entries | `valid` | Takes the lease, records older in-flight deliveries `INTERRUPTED`, generates any missing deliveries, verifies the full list, resumes. |
| None of the three fields | `legacy` | Refuses. Nothing is fenced, swept, generated or sent; lease and epoch are unchanged. Logged on every sweep. |
| Anything else (partial fields, wrong count, unknown version, duplicate or malformed entry) | `corrupt` | Refuses, exactly as for `legacy`. |
| `valid`, but existing deliveries do not match the manifest | refused after takeover | Nothing is dispatched; the lease is released. Logged with counts only. |

A legacy record is identified only by the **absence** of all manifest fields. Delivery counts are
never used to decide that a recipient list is complete.

Refusals are logged as `[Dispatcher] Campaign <id> NOT recovered: ...` or
`[Dispatcher] Campaign <id> NOT resumed: ...`. Log lines contain campaign ids and counts, never
recipient names or addresses.

## 3. Behaviour changes users and operators will notice

- **A crash after the send lock no longer returns the campaign to draft.** The campaign was
  accepted; recovery completes it and sends it. Previously a crash before any delivery was written
  reverted it to `draft`.
- **A failure while generating deliveries no longer deletes them or reverts to draft.** The
  campaign stays `sending`, its lease is released, and recovery completes it at the next sweep
  (`CAMPAIGN_WATCHDOG_INTERVAL_MS`, default 5 minutes) or on the next start.
- **`stats.total` comes from the manifest**, not from however many deliveries happened to exist.

## 4. Upgrade procedure

Do every step in order. Do not run old and new versions at the same time.

1. **Check for in-flight campaigns (read-only).** Against the production database, count campaigns
   in `sending`:

   ```
   db.campaigns.countDocuments({ status: 'sending' })
   ```

   If the result is `0`, go to step 3.

2. **Drain.** Leave the old version running until every one of those campaigns reaches `sent` or
   `failed`. Re-run the count until it is `0`. Do not pause or edit those campaigns while waiting.

3. **Stop the old version completely.** Every API and worker process of the old version must be
   stopped before any process of the new version starts. A rolling upgrade is **not** supported:
   an old process recovering a campaign written by the new version would use the old, unverified
   recovery logic.

   With Docker Compose, `docker compose stop server` gives in-flight sends their grace period
   (`STOP_GRACE_SECONDS`). Do **not** use `docker compose down -v`: it deletes the database volume.

4. **Start the new version.**

5. **Verify.** Within one watchdog interval, the logs must contain no
   `NOT recovered: it has no dispatch manifest` lines. Campaigns in `draft`, `scheduled`, `sent`
   and `failed` need nothing: a scheduled campaign gets its manifest when it is locked.

## 5. If a legacy campaign is found after the upgrade

This only happens if step 1 or 2 was skipped, or an old process was still running.

The new version refuses it on every sweep and never sends it. It cannot be completed safely,
because its recipient list cannot be proven complete. An operator decides, case by case:

- **Its deliveries are all `sent` or `failed`:** it finished; only finalization was lost. Mark it
  `sent` (or `failed` if nothing was sent) after confirming the counts.
- **Anything else:** treat the campaign as interrupted. Do not re-send it in place. Mark it
  `failed`, inform the customer which recipients have a `sent` delivery, and if they want to reach
  the rest, duplicate the campaign and send the copy to an audience that excludes them.

Any such change is a production data change and needs the product owner's explicit approval.

## 6. Limits that protect the manifest

| Limit | Value | Where |
|---|---|---|
| Recipients per campaign | 5,000 (`MAX_CAMPAIGN_RECIPIENTS`) | Builder, send and schedule requests |
| Manifest size | 4 MiB measured BSON | Builder |
| Campaign document including manifest | 8 MiB measured BSON (half the MongoDB limit) | Builder |

Sizes are measured on the real data, never estimated. A send or schedule request over a limit is
refused with HTTP 422 before anything changes; a scheduled campaign that exceeds one at pickup is
marked `failed` without being locked.

## 7. Not covered here

- **Deleted contacts.** The pre-send check skips unsubscribed and suppressed recipients, but a
  contact deleted after the lock is still sent to at its snapshot address. A design is pending
  review; it is not implemented by this upgrade.
- **Separating the API and the dispatch worker** into different processes is a later change with
  its own deployment notes.
