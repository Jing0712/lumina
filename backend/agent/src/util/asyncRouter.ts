import { Router, type RequestHandler } from 'express';

/**
 * Express 4 ignores the promise an async handler returns, so a rejected one would hang the
 * request instead of reaching the error handler (and its 502). This router forwards every
 * rejection to `next`, where it becomes a logged 502 — never a silent 200.
 */
export function asyncRouter(): Router {
  const router = Router();
  for (const method of ['get', 'post', 'delete', 'put', 'patch'] as const) {
    const original = router[method].bind(router) as unknown as (path: string, ...h: RequestHandler[]) => Router;
    (router as unknown as Record<string, unknown>)[method] = (path: string, ...handlers: RequestHandler[]) =>
      original(path, ...handlers.map(wrap));
  }
  return router;
}

const wrap =
  (h: RequestHandler): RequestHandler =>
  (req, res, next) => {
    try {
      const out = h(req, res, next) as unknown;
      if (out && typeof (out as Promise<unknown>).then === 'function') (out as Promise<unknown>).catch(next);
    } catch (err) {
      next(err);
    }
  };
