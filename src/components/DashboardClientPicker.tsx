"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui";

/** Switches the dashboard between all clients and one client, keeping the date range. */
export function DashboardClientPicker({ clients, value }: { clients: { id: string; name: string }[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-2">
      <Select
        aria-label="Client"
        value={value}
        className={`w-full sm:w-64 ${pending ? "opacity-60" : ""}`}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          if (e.target.value) next.set("client", e.target.value);
          else next.delete("client");
          startTransition(() => router.push(next.size ? `${pathname}?${next}` : pathname));
        }}
      >
        <option value="">All clients</option>
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
    </div>
  );
}
