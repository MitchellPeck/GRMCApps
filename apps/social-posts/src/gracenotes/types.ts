// Grace Notes: the weekly church email, collected from contributors.
export const PIECE_STATUSES = ["carried", "confirmed", "changed", "dropped", "new"] as const;
export type PieceStatus = (typeof PIECE_STATUSES)[number];

export const SECTION_KINDS = ["text", "events", "glance"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export interface Contributor {
  id: string; name: string; email: string; token: string; retired: boolean;
}

export interface Section {
  id: string; title: string; kind: SectionKind; position: number; retired: boolean;
  ownerIds: string[];
}

export interface Details {
  when?: string; place?: string; cost?: string; link?: string; linkLabel?: string; contact?: string;
  [key: string]: unknown;
}

export interface Piece {
  id: string; issueId: string; sectionId: string; contributorId: string | null; eventId: string | null;
  title: string; bodyHtml: string; details: Details; imageUrl: string;
  status: PieceStatus; position: number; carriedFrom: string | null; contentHash: string;
  updatedBy: string; updatedAt: string;
  sectionTitle: string; sectionKind: SectionKind;
  eventName: string | null; eventStartDate: string | null; eventImageUrl?: string | null;
}
