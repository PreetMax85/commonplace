const COLORS: Record<string, string> = {
  uploading: "bg-ink-faint",
  indexing: "bg-status-indexing animate-pulse",
  ready: "bg-status-ready",
  error: "bg-status-error",
};

export default function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${COLORS[status] ?? "bg-ink-faint"}`}
      title={status}
    />
  );
}
