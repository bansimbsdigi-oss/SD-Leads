"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { reportBrowserErrorAction } from "@/app/actions";
import { Button, Card } from "@/components/ui";

/** Shown when a page crashes. Errors that started in the browser are reported; server ones are already logged. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const path = usePathname();
  useEffect(() => {
    if (!error.digest) reportBrowserErrorAction(error.message || "Page crashed", path).catch(() => {});
  }, [error, path]);
  return (
    <Card className="mx-auto mt-10 max-w-lg">
      <div className="flex flex-col items-center py-6 text-center">
        <span className="mb-3 flex size-12 items-center justify-center rounded-xl bg-red-50 text-red-700"><TriangleAlert aria-hidden className="size-5" /></span>
        <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
        <p className="mt-1 max-w-sm text-sm text-ink-muted">It&apos;s been noted for the Sabhi team. Try again, or go back and carry on.</p>
        {error.digest && <p className="mt-2 font-mono text-xs text-ink-muted">Reference: {error.digest}</p>}
        <Button className="mt-5" onClick={reset}><RotateCcw aria-hidden /> Try again</Button>
      </div>
    </Card>
  );
}
