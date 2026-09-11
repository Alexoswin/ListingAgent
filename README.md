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
| `OPENAI_API_KEY` | OpenAI key used for both the drafting and verification passes |
| `AGENT_GENERATE_MODEL` | Model for the drafting pass (default `gpt-4.1-mini`) |
| `AGENT_VERIFY_MODEL` | Model for the verification pass (default `gpt-4.1`) |
| `TAVILY_API_KEY` / `SERPER_API_KEY` | Optional key for the product-lookup web search |
| `MONGO_URI` | MongoDB connection string |
| `PORT` | Server port (default `3000`) |

See [.env.example](./.env.example) for the full list.

## Stack

- [NestJS](https://nestjs.com/) (TypeScript)
- MongoDB with Mongoose schemas
- Node.js 18+

## Project Structure

```
src/
├── listings/         # listing entity and seller-submission/generated-PDP fields
├── users/            # marketplace user entity
├── images/           # image entity and analysis metadata
├── reviews/          # verification review entity and verdict/check fields
├── app.module.ts
└── main.ts
```

The current backend includes the MongoDB entity modules. Agent orchestration and CRUD endpoints can be layered on top of these schemas next.
