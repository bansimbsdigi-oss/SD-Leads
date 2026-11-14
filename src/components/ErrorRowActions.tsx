"use client";

import { Check, RotateCcw } from "lucide-react";
import { useTransition } from "react";
import { resolveErrorAction } from "@/app/actions";
import { Button } from "@/components/ui";

/** "Mark fixed" / "Reopen" on the Errors page. */
export function ErrorRowActions({ id, resolved }: { id: string; resolved: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => startTransition(() => resolveErrorAction(id, !resolved))}>
      {resolved ? <><RotateCcw aria-hidden /> Reopen</> : <><Check aria-hidden /> Mark fixed</>}
    </Button>
  );
}
