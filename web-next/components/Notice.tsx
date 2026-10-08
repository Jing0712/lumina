import { ApiError } from '@/lib/api';

/**
 * One place that turns a failed request into a sentence. A 501 is a route the backend
 * has not built yet, not a crash; anything else says what failed and carries the request
 * id so it can be found in both services' logs.
 */
export function Notice({ error, what }: { error: unknown; what: string }) {
  if (!error) return null;

  if (error instanceof ApiError && error.notImplemented) {
    return (
      <div className="notice todo" role="status">
        <strong>Not built yet.</strong> The backend answers <code>501</code> for {what}.
      </div>
    );
  }

  const e = error instanceof ApiError ? error : undefined;
  if (e?.status === 429 && e.resetsAt) {
    return (
      <div className="notice warn" role="alert">
        <strong>Limit reached.</strong> {e.message} It resets {new Date(e.resetsAt).toLocaleString()}.
      </div>
    );
  }

  return (
    <div className="notice bad" role="alert">
      <strong>{e?.status ? `${e.status}` : 'Request failed'}.</strong> {(error as Error).message}
      {e?.requestId ? (
        <span className="reqid">
          {' '}
          Request id <code>{e.requestId}</code>
        </span>
      ) : null}
    </div>
  );
}
