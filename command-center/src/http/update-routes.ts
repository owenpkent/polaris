// The update icon's routes (docs/update-proposal.md, sections 4B and 4C). The daemon never runs
// an update and never starts a program: these routes read the status file the updater writes
// (update/status.ts) and keep the update_requests table, whose every row is the owner asking the
// scheduled updater, which runs outside the daemon, to install one release.
//
// They are REST routes on /api only, so the api token or the Tailscale owner is the only way in:
// an mcp or read-only token gets 401 like everywhere else on /api. There is no MCP tool, no
// outbox op kind, and no rule action for any of this, and no update event exists.
import type { App } from '../app.ts';
import { ValidationError, type UpdateRequest } from '../core/index.ts';
import { readUpdateStatus, updaterInstalled, type UpdateStatus } from '../update/status.ts';
import { isNewerVersion } from '../update/version.ts';
import { HttpError, sendJson } from './errors.ts';
import type { Router } from './router.ts';
import { parseBody, updateFinishBodySchema, updateRequestBodySchema } from './schemas.ts';
import { VERSION } from './version.ts';

/** What the panel shows to copy when no scheduled updater is installed. */
export const UPDATE_COMMAND = 'npm run cc -- update --release';

export function registerUpdateRoutes(router: Router, app: App): void {
  const store = app.store;
  const status = (): UpdateStatus => readUpdateStatus(app.config.dbPath);

  // The daemon's own transitions (section 4C), in this order: a picked-up row whose outcome
  // reached the status file while the daemon was down takes that outcome; then a pending row
  // older than an hour expires, and so does a picked-up row the updater has held for two hours
  // with no outcome (it was stopped or killed), so a dead updater never wedges the table. The
  // file is read before the sweep, so an outcome that did arrive wins over the expiry.
  function takeFileOutcome(file: UpdateStatus): void {
    const row = store.currentUpdateRequest();
    if (row?.state === 'picked_up' && file.request?.id === row.id && (file.request.state === 'done' || file.request.state === 'failed')) {
      store.finishUpdateRequest(row.id, file.request.state === 'done', file.request.message);
    }
  }

  function reconcile(file: UpdateStatus): void {
    takeFileOutcome(file);
    store.expireUpdateRequests();
  }

  function currentRequest(file: UpdateStatus): UpdateRequest | null {
    reconcile(file);
    return store.currentUpdateRequest();
  }

  function payload(file: UpdateStatus) {
    return {
      running: VERSION,
      updaterInstalled: updaterInstalled(file),
      // Only a release strictly newer than what runs lights the icon. After an update the file
      // may still name the version just installed until the updater runs again.
      available: file.available && isNewerVersion(file.available.version, VERSION) ? file.available : null,
      request: currentRequest(file),
      lastResult: file.lastResult,
      command: UPDATE_COMMAND,
    };
  }

  router.add('GET', '/api/update', (ctx) => {
    sendJson(ctx.res, 200, payload(status()));
  });

  // The owner presses Update now. The version must be the one the updater reported as available
  // and strictly newer than what runs: the panel never names anything else, and a stolen token
  // can at most ask for the owner's own newer release early.
  router.add('POST', '/api/update/requests', (ctx) => {
    const body = parseBody(updateRequestBodySchema, ctx.body);
    const file = status();
    if (!isNewerVersion(body.version, VERSION)) throw new ValidationError(`${body.version} is not newer than the running version ${VERSION}`);
    if (!file.available || file.available.version !== body.version) throw new ValidationError(`${body.version} is not the release the updater reported as available`);
    const open = currentRequest(file);
    if (open && (open.state === 'pending' || open.state === 'picked_up')) {
      throw new HttpError(409, 'Conflict', `an update request is already ${open.state === 'pending' ? 'pending' : 'being installed'}`);
    }
    const request = store.createUpdateRequest(body.version, 'human');
    sendJson(ctx.res, 201, { request });
  });

  // The owner takes a request back: a pending one, or a picked-up one the updater has held past
  // the stale limit with no outcome. The file is read first, so a request whose outcome arrived
  // there is finished with that outcome and not cancelled; the expiry sweep is not run here, so
  // the owner's cancel, not the sweep, is what the row records.
  router.add('POST', '/api/update/requests/:id/cancel', (ctx) => {
    takeFileOutcome(status());
    sendJson(ctx.res, 200, { request: move(() => store.cancelUpdateRequest(ctx.params.id, 'human')) });
  });

  // The updater's two routes. Pickup is one guarded UPDATE in the store, so a pickup and an expiry
  // of the same row cannot both win.
  router.add('POST', '/api/update/requests/:id/pickup', (ctx) => {
    reconcile(status());
    sendJson(ctx.res, 200, { request: move(() => store.pickUpUpdateRequest(ctx.params.id)) });
  });

  router.add('POST', '/api/update/requests/:id/finish', (ctx) => {
    const body = parseBody(updateFinishBodySchema, ctx.body);
    sendJson(ctx.res, 200, { request: move(() => store.finishUpdateRequest(ctx.params.id, body.ok, body.message)) });
  });
}

/** A transition refused because the row has already moved on is a 409, not a 400: the request was well formed. */
function move(fn: () => UpdateRequest): UpdateRequest {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ValidationError) throw new HttpError(409, 'Conflict', e.message);
    throw e;
  }
}
