// Next.js hook: every error thrown while handling a request (pages, server actions, API routes) is recorded
// in the built-in error log (lib/errors). The import sits inside the runtime check so the edge bundle,
// where it can't run, drops it at build time.
import type { Instrumentation } from "next";

export async function register() {}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recordError } = await import("@/lib/errors");
    await recordError(err, {
      source: "server",
      path: request.path,
      context: { method: request.method, routerKind: context.routerKind, routePath: context.routePath, routeType: context.routeType },
    });
  }
};
