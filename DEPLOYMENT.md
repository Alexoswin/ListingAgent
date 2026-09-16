# Production Deployment

Circle is deployed as two independent Vercel projects in the `listing-agent` team.

| Service | Local directory | Vercel project | Production URL |
|---|---|---|---|
| NestJS API | `ListingAgent` | `listing-agent-api` | `https://listing-agent-api-seven.vercel.app` |
| Next.js web app | `ListingAgent-frontend` | `listing-agent-frontend` | `https://listing-agent-frontend.vercel.app` |

The public dashboard is at `https://listing-agent-frontend.vercel.app/dashboard`.

## Prerequisites

- Node.js 22 or later and npm.
- Vercel CLI authenticated to the `listing-agent` team:

```bash
vercel login
vercel whoami
```

- The local repositories linked to their Vercel projects. The `.vercel` directories are local-only and must not be committed.

## API Configuration

Set these as **Production** environment variables on `listing-agent-api`. Do not place their values in source control.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | Yes | `production` |
| `MONGO_URI` | Yes | MongoDB must allow connections from Vercel. |
| `OPENAI_API_KEY` | Yes | Used by the generation, image analysis, lookup, and validation calls. |
| `JWT_SECRET` | Yes | High-entropy secret, unique to production. |
| `FRONTEND_URL` | Yes | `https://listing-agent-frontend.vercel.app` |
| `AWS_REGION` | Yes | Region containing the S3 bucket and SES configuration. |
| `AWS_ACCESS_KEY_ID` | Yes | IAM credentials for S3 presigning and SES. |
| `AWS_SECRET_ACCESS_KEY` | Yes | IAM credentials for S3 presigning and SES. |
| `AWS_S3_BUCKET` | Yes | Listing image bucket. |
| `SES_FROM_EMAIL` | Yes | SES-verified sender address. |
| `AGENT_GENERATE_MODEL` | No | Overrides the default `gpt-4.1-mini`. |
| `AGENT_VERIFY_MODEL` | No | Overrides the default `gpt-4.1`. |

The S3 bucket CORS policy must allow `PUT`, `GET`, and `HEAD` from both `http://localhost:3000` and `https://listing-agent-frontend.vercel.app`, with `AllowedHeaders` set to `*`.

## Frontend Configuration

Set this **Production** environment variable on `listing-agent-frontend`:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://listing-agent-api-seven.vercel.app` |

After changing a `NEXT_PUBLIC_*` variable, redeploy the frontend because Next.js embeds it into the browser build.

## Deploy

Build before deploying:

```bash
# API repository
cd /home/oswinalex/Desktop/oswin/circle/ListingAgent
npm run build
npm test -- --runInBand
vercel deploy --prod --yes --scope listing-agent

# Frontend repository
cd /home/oswinalex/Desktop/oswin/circle/ListingAgent-frontend
npm run build
vercel deploy --prod --yes --scope listing-agent
```

Vercel assigns an immutable deployment URL and updates the stable production aliases listed above when the deployment is ready.

## Verify

Check the API root, CORS, and public analytics route:

```bash
vercel curl https://listing-agent-api-seven.vercel.app --scope listing-agent
vercel curl https://listing-agent-api-seven.vercel.app/agent-logs/analytics --scope listing-agent
```

Then open the marketplace and dashboard in a browser. Create a test listing with an image to confirm the complete flow: S3 upload, listing generation, MongoDB persistence, and one new dashboard run.

Vercel Deployment Protection is currently enabled. Use `vercel curl` for authenticated smoke checks, or update the project protection setting before expecting unauthenticated public access.

## Operational Notes

- Do not commit `.env`, `.env.local`, `.vercel`, AWS credentials, or OpenAI keys.
- Updating `FRONTEND_URL` requires an API redeploy because it controls credentialed CORS.
- If the production frontend URL changes, update both `FRONTEND_URL` and the S3 CORS allowed origins, then redeploy the API.
- Agent logs intentionally store operational metrics only. Seller identifiers and error messages are excluded from the public dashboard API.
