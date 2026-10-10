# Board brief: pick one B2C SaaS to build

Date of meeting: 10 October 2026.

## What the founder asked for

The founder wants a B2C SaaS that meets all of these:

1. **Easy architecture.** Built by a small team (or one person), with no
   proprietary model training, no hardware and no two-sided marketplace to
   bootstrap.
2. **High demand.** The kind of thing people say "that's amazing, this is what I
   need, I'd pay for it" about.
3. **Few competitors, and weak ones.** Ideally 1 or 2 doing it, badly.
4. **A target market of over 1 billion people.**

- Budget: not stated (open question).
- Team: not stated (open question).
- Background: the founder has built a static web prototype before, a meal planner
  in plain HTML with Tailwind and Alpine.js. Any of the three ideas below would be
  their first SaaS with paying users.

The founder's own first idea was an AI meal planner. A screen of the market found
it crowded. In 2026 there are many fridge-photo meal planners, for example
FridgeSmart (https://mwm.ai/apps/fridgesmart-app/6755790933),
Frigo (https://www.producthunt.com/products/frigo/launches/frigo-2),
PantryMynd (https://appgoblin.info/apps/6765681114) and
Chef AI (https://mwm.ai/apps/chef-ai-smart-kitchen/6772408064), as well as the
general assistants. That idea is set aside, and three other ideas made the
shortlist.

The board's job: **score all three against the founder's criteria and say which
one, if any, to build.**

---

## Idea A: an AI that makes phone calls for you, in any language

- **What it is:** You type or say what you need, for example "book a dentist
  cleaning next week", "cancel my gym", "ask my landlord when the heating gets
  fixed" or "dispute this charge". The AI places the call, works through the phone
  menu, waits on hold, has the conversation and reports back. You get the outcome,
  a transcript and the next steps. It can call in a language you don't speak and
  report back in yours. You can watch live and take over the call.
- **Who it is for:** People who dread or can't make phone calls. That includes
  younger adults with phone anxiety, busy professionals, and immigrants, expats or
  travellers who must call in a language they don't speak.
- **Proposed price (a starting guess, not tested):** 1 free call. Then a $12.99
  monthly plan with 10 calls, or $2.99 per call pay-as-you-go.
- **Where and how:** An iPhone, Android and web app. Customers would come through
  short-form video, expat communities and app store search.
- **Architecture:** A mobile or web app plus an off-the-shelf voice-agent platform
  (Retell, Vapi, ElevenLabs Agents or Bland) and Twilio telephony, with an LLM to
  take the task and summarise the result. No model training.
- **Costs (estimates from public sources, not quotes):**
  - Bundled voice-agent platforms advertise $0.07 to $0.12 a minute and land near
    $0.10 to $0.18 all-in; Twilio US outbound is about $0.014 a minute
    (https://techsy.io/en/blog/ai-voice-agent-pricing).
  - The founder's working estimate is $0.50 to $1.50 per completed task. That
    assumes hold time is handled cheaply and talk time stays under 10 minutes. It
    is an **estimate**, not a measured figure.

**Market facts (linked):**
- **Phone anxiety:**
  - YPulse's 2025 Mental Health report: 41% of young adults are anxious to answer
    or make calls (https://www.ypulse.com/newsfeed/2026/05/14/dont-call-gen-z-globally-is-on-dnd/).
  - Germany: 36% of respondents put off important calls out of fear or
    discomfort, rising to 44% among 16-to-29-year-olds
    (https://www.markt-kom.com/en/?p=221529).
- **Time on hold:**
  - Australians averaged 11.1 hours per person in 2024 waiting to resolve issues
    or complain, 123 million hours in total. Singaporeans averaged 19 hours per
    person (ServiceNow research:
    https://newsroom.servicenow.com/press-releases/details/2025/Australian-wait-times-soar-to-123-million-hours-on-hold/default.aspx,
    https://s205.q4cdn.com/537566246/files/doc_news/Singapore-service-wait-times-increase-to-40-million-hours-on-hold-03-24-2025-traffic-2025.pdf).
- **Migrants:** about 304 million international migrants worldwide in 2024, per
  UN DESA (https://www.destatis.de/EN/Themes/Countries-Regions/International-Statistics/Data-Topic/Population-Labour-Social-Issues/DemographyMigration/Migrants.html).

**Competitors (linked):**
- **Pine AI** (US):
  - What it does: calls customer service, negotiates bills and cancels
    subscriptions. Raised a $25M Series A in December 2025
    (https://fintech.global/?p=224280).
  - Reviews: Trustpilot 3.5/5 from only 6 reviews, including a February 2026
    1-star review alleging billing problems and an account ban, with no company
    replies to negative reviews (https://nl-be.trustpilot.com/review/www.19pine.ai).
  - Pricing: a third-party review lists a free tier and premium at $19 to
    $49 a month
    (https://aiindigo.com/blog/dealing-with-customer-service-so-you-don-t-have-to-a-review-of-pine-ai).
- **Google "Call for Me" (Gemini on Pixel 11):**
  - Launched as a US-only early preview around late September 2026.
  - Needs a Pixel 11, a US SIM, a paid Gemini plan, the Phone app beta and
    English as the device language
    (https://hothardware.com/news/google-gemini-call-businesses-wait-on-hold,
    https://pasqualepillitteri.it/en/news/18624/gemini-call-for-me-pixel-11-phones-stores).
  - Google's earlier "Ask for Me" Search Labs test called local businesses for
    prices, limited to some categories such as auto and beauty
    (https://getcoai.com/news/new-google-ai-feature-aims-to-handle-your-phone-calls).
- **Apple:** iOS 26 has Hold Assist, which waits on hold and alerts you when a
  human picks up. It does not hold the conversation for you
  (https://www.tomsguide.com/phones/iphones/i-tried-hold-assist-in-ios-26-and-it-solves-one-of-the-most-annoying-things-about-phone-calls-heres-how-it-works).
- **Small apps:**
  - CallBud AI (https://www.theaireport.ai/tooldatabase/callbud-ai)
  - "AI Phone App" (https://apps.apple.com/us/app/-/id6757747951)
  - Freebot (https://topai.tools/alternatives/pine)
  - Xpat24, a Product Hunt launch for German-language calls for expats
    (https://www.producthunt.com/@rzagahi)
  - None of these shows public traction or reviews.
- **Fallen player:** DoNotPay, the "robot lawyer" that also promised to fight
  companies for consumers, was ordered by the FTC in January 2025 to stop
  deceptive claims and to pay $193,000
  (https://getcoai.com/news/ftc-bans-donotpays-ai-lawyer-claims-and-orders-refunds).

**Rules that apply (linked):**
- In February 2024 the FCC confirmed that AI-generated voices count as "artificial
  or prerecorded voice" under the TCPA. Such calls to wireless numbers generally
  need prior express consent
  (https://orrick.com/Insights/2024/02/Did-the-FCC-Really-Ban-AI-Generated-Voice-Calls-No-But-Restrictions-Apply).
  No public source found addresses calls a consumer's own agent places on their
  behalf.
- A developer who looked into this in Germany reported concerns about recording
  consent, and noted that Berlin and Munich turned off online immigration-office
  booking because of bots (https://de.linkedin.com/in/mosmann). These are
  unverified claims.

---

## Idea B: an AI that explains any official letter, in any language

- **What it is:** You photograph any letter or notice: tax, government,
  immigration, insurance, landlord, court, medical bill. In plain language and in
  your own language, it tells you what the letter is, whether you must act, the
  deadline and the amount. It drafts a reply, sets reminders and keeps a
  searchable archive of your paperwork.
- **Who it is for:** Every adult who gets official mail. It matters most to
  immigrants, elderly people, and anyone who freezes at a scary letter.
- **Proposed price (a starting guess):** A free tier with 3 letters a month, then
  $4.99 a month or $39 a year.
- **Architecture:** A mobile app, a vision LLM, structured extraction, reminders
  and encrypted storage. Very simple.
- **Cost per letter (estimate):** a few cents in LLM fees.

**Competitors (linked):** many small, recent apps, with little or no rating data
and no clear leader.
- BriefAI (https://apps.apple.com/us/app/-/id6757674090)
- Explicame (https://apps.apple.com/us/app/-/id6760152819)
- ExplainThisDoc
- Barely Legible (https://hunted.space/product/barely-legible)
- X-plain
- Mein Büro (German official mail)
- Contract Analyzer (https://apps.apple.com/app/id6757685548)

The main substitute is pasting a photo into a general AI assistant such as
ChatGPT or Gemini, which many people already do for free.

---

## Idea C: a fair-price checker for any quote or invoice

- **What it is:** You photograph a quote or invoice from a mechanic, plumber,
  contractor or dentist. You get a verdict on whether the price is fair for your
  city, the line items that look padded, questions to ask and a negotiation
  script.
- **Who it is for:** Homeowners, renters and car owners facing a big repair bill.
- **Proposed price (a starting guess):** $4.99 per check, or $29 a year.
- **Architecture:** A vision LLM plus price data (public wage data, cost guides,
  web search). Simple, but the answer is only as good as the price data.

**Competitors (linked):** several, all recent and small.
- QuoteScore, a free ChatGPT app built on submitted quotes
  (https://www.scrippsnews.com/dont-waste-your-money/fair-quote-or-ripoff-how-to-get-the-best-price-on-a-big-job)
- Invoice Inspector, for car repairs (https://apps.apple.com/app/id6757395906)
- Ripoff.pro (https://peerpush.com/p/ripoffpro)
- Quoterly (https://peerpush.com/p/quoterly)
- QuotesBuster, free, uses BLS wage data
  (https://aiindigo.com/tools/alternatives/quotesbuster)
- FairBid
- RepairPal and cost guides such as HomeGuide or Fixr, for auto and home
  estimates

---

## What is not known yet

- The founder's budget, team and target launch country.
- Real buyer demand and willingness to pay, for any of the three: no test has been
  run.
- Real cost per completed task for Idea A, which needs a prototype to measure.
- Market sizes beyond the linked facts above. Treat any "1 billion users" figure
  as the founder's ambition, not a measured number.
