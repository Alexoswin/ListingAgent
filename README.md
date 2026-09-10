# ListingAgent (Backend)

NestJS backend for the Circle listing agent. Generates marketplace-ready listings from raw seller data and images, then verifies its own output before publication.

See the [root README](../README.md) for the full project overview and how this fits with the frontend.

## Setup

```bash
npm install
cp .env.example .env
# fill in OPENAI_API_KEY and any other keys
```

## Run

```bash
npm run start:dev    # dev server with hot-reload, http://localhost:3000
npm run build         # compile to dist/
npm run start:prod    # run compiled build
npm run test           # unit tests
npm run test:e2e       # e2e tests
npm run lint            # eslint
```

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | LLM provider key used for generation/verification |
| `MODEL` | Model name to use (e.g. `gpt-4-turbo`) |
| `SEARCH_API_KEY` | Optional key for product-lookup/web search tool |
| `PORT` | Server port (default `3000`) |

See [.env.example](./.env.example) for the full list.

## Stack

- [NestJS](https://nestjs.com/) (TypeScript)
- Node.js 18+

## Project Structure

```
src/
├── agent/           # listing generation & verification logic (LLM orchestration)
├── listings/         # listing CRUD / status endpoints
├── images/           # image fetching from seller-supplied URLs
├── verification/     # review pipeline, auto_publish vs human_review_needed decision
├── app.module.ts
└── main.ts
```

> Note: this is the initial scaffold. `agent`, `listings`, `images`, and `verification` modules are not yet implemented — see the root README for the intended design.
