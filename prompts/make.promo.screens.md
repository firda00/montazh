<!-- Second call of the promo writer (stage 31): the UI screens for the story written in the first call. -->
Now draw the UI screens of this promo as data: one `ui` object per line of the plan, in the same order ({{count}} screens).

PRODUCT: {{story}}
PLAN (kind — the card it follows — what the screen must show):
{{plan}}

Rules: `kind` exactly as in the plan; fill only the fields that kind uses (see UI SCREENS), the rest "" or []; every visible word in {{language}} except brand and product names; short cells (≤ 20 characters); plausible sample data, one currency; the screen must make the card's claim visible.
Return {"screens": [...]} only.
