# FaithLens

FaithLens is a single-page web app that shows **eight traditions responding simultaneously** to a single question.

## Run locally

1. Install Node.js (LTS).
2. Install dependencies:

```bash
npm install
```

3. Start local dev server (serves `index.html` + Cloudflare Pages Functions):

```bash
npm run dev
```

Then open the URL Wrangler prints (usually `http://localhost:8788`).

## Demo mode vs Live mode

- **Demo mode**: Works without any API key (frontend falls back to sample responses).
- **Live mode**: Set an Anthropic API key so `/api/faithlens` can call the model.

### Set API key for local dev

Create a file named `.dev.vars` in the project root:

```bash
ANTHROPIC_API_KEY=your_key_here
```

### Set API key on Cloudflare Pages

In your Cloudflare Pages project:

- Settings → Environment variables
- Add **Secret**: `ANTHROPIC_API_KEY`

## API

POST `/api/faithlens`

Body:

```json
{ "question": "Why do bad things happen to good people?" }
```

Returns:

```json
{ "traditions": [ { "id": "christianity", "response": "...", "quote": "...", "citation": "..." } ] }
```

