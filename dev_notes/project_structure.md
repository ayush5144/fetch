fetch/
├── apps/
│   ├── api/                API layer (TypeScript) — front door: writes rows, enqueues jobs, takes webhooks
│   │   ├── routes/         leads, columns, campaigns, jobs, webhooks/{instantly,smartlead}
│   │   ├── middleware/     auth, rate limiting, webhook signature verification
│   │   └── index.ts        boots HTTP server + /health
│   ├── worker/             pg-boss consumers — all the slow/failable work
│   │   └── handlers/       enrich · validate · personalize · send · event
│   └── web/                Next.js dashboard (table-first operator UI)
│       └── app/            lead table, accounts, campaigns, prompt editor, job monitor, inbox, analytics
├── packages/
│   ├── db/                 THE TABLES — Drizzle schema + migrations (single source of truth)
│   │   ├── schema/         leads, accounts, columns, campaigns, sequences, jobs, events, prompts, sources, audit_log
│   │   ├── migrations/     versioned migrations
│   │   └── client.ts       pooled Postgres client
│   ├── core/               domain types, dedupe, audit, job-enqueue helpers
│   │   └── queue/          pg-boss setup (queue lives inside Postgres — no Redis)
│   ├── connectors/         INGESTION — normalize any source → canonical lead
│   │   ├── csv/            CSV import + header → field mapping
│   │   ├── webhook/        inbound lead webhooks
│   │   └── crm/            HubSpot / Salesforce sync
│   ├── columns/            DYNAMIC COLUMN ENGINE — run-column fan-out, run-only-if-empty
│   │   └── types/          enrichment · agent · formula · manual
│   ├── enrichment/         waterfall + cache (cheapest provider first, stop on hit)
│   │   └── providers/      apollo, hunter, findymail, dropcontact (+ base Provider interface)
│   ├── agent/              THE AGENT — LLM tool-calling research loop (waterfall fallback)
│   │   └── tools/          web_search (serper/brave) · scrape_url (firecrawl) · extract_field · browser_action (playwright)
│   ├── llm/                provider-agnostic LLM client (Claude / GPT behind one interface)
│   ├── validation/         syntax · MX · SMTP (reacher) · disposable · catch-all · dedupe → status gate
│   ├── personalization/    prompt builder + guardrails + versioned templates
│   └── senders/            SEND ADAPTERS — push(leads, campaign) + parseEvent(payload)
│       ├── instantly/      POST /api/v2/leads, ≤1000 batches, custom vars
│       ├── smartlead/      add-to-campaign + event parsing
│       └── smtp/           generic SMTP / webhook rail
├── infra/
│   ├── docker-compose.yml  Postgres only (queue is in Postgres, so no Redis)
│   └── Dockerfile.*        api / worker / web images
├── scripts/                seed · deploy · pg_dump backup
├── docs/                   PRD.md · ARCHITECTURE.md · WORKING.md · CHECKLIST.md
├── .env.example            DB, LLM, enrichment-provider, and send-rail keys
├── pnpm-workspace.yaml
├── package.json
└── README.md