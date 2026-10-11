# Board summary, 10 October 2026

> **Correction, 11 October 2026.** The brief told the board that almost nobody
> offers this outside the US or in other languages. `/founder-competitors` found
> that this is wrong:
> - Genspark's "Call for Me" already makes local-language AI calls in 7
>   countries. It reports 180,000 users, and 23% of its calls are translated.
> - Pine rates 4.5 on the App Store, better than the brief implied.
>
> Germany is not on Genspark's list, and Google is US-only, so the beachhead in
> section 4 still holds, but the gap is narrower. See `founder/competitors.md`.
> One condition is added to the checklist: choose the launch country from those
> Genspark and Google don't serve.

The brief is in `founder/board/brief.md`. The members' memos are in
`founder/board/offers.md`, `monopoly.md` and `product.md`.

Each member applied one published framework, summarised in
`.claude/skills/founder-board/lenses.md`. The lenses are summaries; they are not
the authors' own words or views.

## 1. The vote

| idea | Offers | Monopoly | Product | average | votes |
| --- | --- | --- | --- | --- | --- |
| **A. AI that makes phone calls for you** | 7 FUND IF | 5 FUND IF | 7 FUND IF | **6.3** | 3 fund if |
| C. Fair-price checker | 5 FUND IF | 6 FUND IF | 3 PASS | 4.7 | 2 fund if, 1 pass |
| B. Official-letter explainer | 3 PASS | 3 PASS | 5 FUND IF | 3.7 | 1 fund if, 2 pass |

**Picks: A (Offers, Product), C (Monopoly). The board backs Idea A, 2 to 1.**
No idea got an unconditional FUND.

## 2. The risks more than one member raised (Idea A)

1. **Nobody knows the completion rate.** All three members raised this.
   - Account-holder checks at banks, telecoms and insurers.
   - Businesses that hang up on bots.
   - Offices that block bots (the Berlin and Munich report is unverified).
   - If the one free call fails, that is the user's whole first impression.
2. **The rules are unsettled.** All three raised this.
   - AI voices fall under the TCPA consent rules in the US. No source covers a
     consumer's own agent.
   - Recording consent and AI disclosure vary by country.
   - DoNotPay's FTC order shows the cost of over-claiming.
3. **The platforms own the phone app.** Raised by Monopoly and Product, and
   Offers asked about it. Google's Call for Me (a US-only Pixel 11 preview) and
   Apple's Hold Assist sit inside the phone. Once Google goes global and
   multilingual, a paid app competes with a free built-in feature.
4. **Too much scope.** Raised by Product, Monopoly and Offers. Booking,
   cancelling, disputing, negotiating and "any language" are each separate
   products. Cancelling and disputing are adversarial and need identity checks,
   so they fail most often.
5. **Hold time could eat the margin.** Raised by Offers and Product. The $0.50 to
   $1.50 cost per task is an estimate. If hold is billed at agent rates, 30
   minutes costs $3.00 to $5.40.
6. **Easy to copy.** Raised by Monopoly, with Xpat24, CallBud, Freebot and Pine
   named. The code is not the moat.

## 3. The conditions (checklist for the rest of the pack)

- [ ] **One job.** Booking and rescheduling appointments only in version 1. No
      cancellations, disputes or bill negotiation yet. *(Product, Offers,
      Monopoly)*
- [ ] **One country, one language pair, outside Google's first footprint.**
      A non-US country with a large expat population and a culture of booking by
      phone. *(Monopoly, Offers)*
- [ ] **Measure before charging.** A prototype runs 50 or more real calls of that
      one task and records:
      - the share finished with no human help;
      - median time from tap to outcome;
      - all-in cost per completed call, hold included.
      *(all three)*
- [ ] **Written legal view for the launch country** on AI disclosure ("am I
      talking to a person?") and call recording, plus the US TCPA position before
      any US launch. *(all three)*
- [ ] **Charge for outcomes, not attempts.** "No outcome, no charge", if the
      measured cost per call allows it. *(Offers)*
- [ ] **Design the failure screen as carefully as the success screen.** "They
      need you to call yourself. Here is exactly what to say." *(Product)*
- [ ] **Build a moat from the calls.** By month six, own know-how a copycat on
      Vapi or Retell lacks:
      - phone-menu maps;
      - scripts that work;
      - what each office needs from callers.
      *(Monopoly)*
- [ ] **Have an answer to "why you, once Google ships it free?"** *(Offers,
      Monopoly)*
- [ ] **Choose the launch country from those Genspark and Google don't serve.**
      Germany leads; check the Netherlands, Spain and Italy too. Book doctors
      through Doctolib where it covers them, and call for everything else.
      *(added after `/founder-competitors`)*

The consumer panel (`/founder-consumer`), pricing (`/founder-pricing`) and the
CFO (`/founder-cfo`) will test most of these. The completion rate and cost per
call need a real prototype; no simulation can answer them.

## Where the members disagreed (kept on purpose)

- **Monopoly picked C over A.** Its argument: "Easy architecture" means easy to
  copy. Only C builds an asset the platforms can't get, namely real local
  line-item prices from paid invoices, compounding with every check. A is a
  timing play with no ten-year answer.
- **Product passed C.** Its argument: C's quality rests on price data the founder
  does not own, and a wrong "fair" or "padded" is worse than no answer.
- **On B, Product saw the cleanest experience and voted FUND IF; Offers and
  Monopoly passed.** Their argument: a free ChatGPT or Gemini photo already does
  the core job.
- **The "1 billion people" goal.** Monopoly called it the wrong place to start.
  The others treated it as the ceiling, not the launch market. No member
  disputed that the ceiling is large.

## 4. The strongest version the board can see

This is the chair's synthesis, and it is narrower than the pitch: **an AI that
books your appointments by phone, in a language you don't speak, in one country,
paid only when it succeeds.**

You type, in your own language, "book a dentist cleaning next week, any morning".
The agent calls in the local language and you watch a live transcript in yours.
A minute later: "Booked: Tuesday 9:30. Bring your insurance card." That moment is
the "wow" the founder asked for. It is also the call with the fewest seams:
nobody asks for an account PIN, and the result is a time in a calendar.

Start with expats in one country, a group that is concentrated, reachable through
communities and in real pain. Then add task types in the order the measured
completion rates allow:
1. reservations;
2. information calls;
3. landlord calls;
4. later, cancellations.

Then add a second country, then phone-anxious locals who speak the language.

Monopoly's objection is answered here, partly, by its own logic. Every call
teaches the business something no platform publishes:
- which practices take new patients;
- how soon they have appointments;
- what they need from callers;
- whether they speak English.

Over time that data, not the voice agent, is the moat. It is a real business only
if the 50-call prototype shows a high completion rate at a cost well under the
price. That is the first thing to find out.

**The board does not say this will reach a billion people.** It says this is the
only idea of the three with a "this is what I need" moment, a gap the funded
players have left open, and a cheap way to find out within weeks.
