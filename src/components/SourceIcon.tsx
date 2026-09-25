import { FileText, MonitorPlay, Globe, AlignLeft, Captions, File } from "lucide-react";

// One place to say what each source type is called and what it looks like, so
// the sidebar, the citations and the viewer never disagree with each other.
const KINDS = {
  pdf: { label: "PDF", Icon: FileText },
  youtube: { label: "Video", Icon: MonitorPlay },
  url: { label: "Web page", Icon: Globe },
  text: { label: "Text", Icon: AlignLeft },
  vtt: { label: "Transcript", Icon: Captions },
} as const;

export function sourceLabel(type: string): string {
  return KINDS[type as keyof typeof KINDS]?.label ?? "Source";
}

export default function SourceIcon({
  type,
  className = "size-4",
}: {
  type: string;
  className?: string;
}) {
  const Icon = KINDS[type as keyof typeof KINDS]?.Icon ?? File;
  return <Icon className={className} strokeWidth={1.75} aria-hidden />;
}
