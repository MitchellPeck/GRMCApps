export interface Card {
  id: number;
  last4: string;
  nickname: string;
  primary_email: string;
  active: boolean;
  additional: string[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Cards this person may charge to. An empty email matches nothing — never
// everything — so a missing identity header cannot open up every card.
export function visibleCardsFor(email: string, cards: Card[]): Card[] {
  const who = (email ?? "").trim().toLowerCase();
  if (!who) return [];
  return cards.filter(
    (c) => c.active && (same(c.primary_email, who) || c.additional.some((a) => same(a, who)))
  );
}

export function cardLabel(card: Card): string {
  return `${card.nickname} ••${card.last4}`;
}
