import { Avatar, cx } from "@/components/ui";

const SIZE = { sm: "size-7", md: "size-9", lg: "size-12" } as const;

/** A client's logo when they have one, otherwise their initials. */
export function ClientLogo({ name, logo, size = "md", className }: { name: string; logo: string | null; size?: keyof typeof SIZE; className?: string }) {
  if (!logo) return <Avatar name={name} size={size} />;
  // eslint-disable-next-line @next/next/no-img-element -- small, already-sized logo served by our own route
  return <img src={logo} alt="" className={cx(SIZE[size], "shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-line", className)} />;
}
