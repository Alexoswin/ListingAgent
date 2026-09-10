## Circle Assignment

Build a single agent that turns raw seller-submitted data and images into a marketplace-ready listing, then checks its own work before publishing.

1. **Generate the listing** — produce a title, description, specifications, and a condition assessment.
2. **Verify the listing** — check the generated listing against the images and decide: `auto_publish` or `human_review_needed`.

---

## What you get

- `data/listings.json` — 12 seller-submitted listings: raw data plus images, as a seller would submit them.
- `examples/sample_input.json` and `examples/sample_output.json` — one worked example showing a valid way to shape the output. See [Output](#output).

---



## Input shape

The full dataset is in `data/listings.json`. Shape:

```json
{
  "listing_id": "1",
  "category": "electronics",
  "subcategory": "Laptops",
  "seller": {
    "title": "ASUS Tuf f15",
    "description": "",
    "price": 95000,
    "original_price": null,
    "brand": "ASUS",
    "model": "Tuf f15",
    "year_purchased": "2024",
    "specs": { "...category-specific fields, may be sparse..." },
    "condition_details": { "...condition-related data, can be anything..." }
  },
  "images": ["https://.../1.jpg", "https://.../2.jpg", "..."]
}
```

A complete example:

```json
{
  "listing_id": "2",
  "category": "electronics",
  "subcategory": "Laptops",
  "seller": {
    "title": "Dell 7420 7 series i7 11 generation",
    "description": "",
    "price": 42999,
    "original_price": null,
    "brand": "Dell",
    "model": "7420 7 series i7 11 generation",
    "year_purchased": "Not Available",
    "specs": {
      "os": "Windows",
      "ram": "16 GB",
      "brand": "Dell",
      "model": "7420 7 series i7 11 generation",
      "processor": "I7 11 generation ",
      "screen_size": 14,
      "storage_type": "SSD",
      "storage_capacity": "512 GB"
    },
    "condition_details": {
      "bill_available": false,
      "condition_issues": ["No functional issues"],
      "charger_available": "Original Charger Available",
      "select_battery_health": "Good (3-5 hours on a full charge)",
      "original_box_available": false,
      "brand_warranty_available": { "year": "", "month": "", "exists": false },
      "has_this_device_been_repaired_before": false
    }
  },
  "images": [
    "https://circlestore-s3.b-cdn.net/product-images/e674be66-6c74-49fb-9221-1f4807e5c058.jpg",
    "https://circlestore-s3.b-cdn.net/product-images/aae1a403-a3c1-4556-9a92-b13b8f3899b6.jpg"
  ]
}
```

Notes:

- Everything under `seller` is a claim, not ground truth, including `specs` and `condition_details`. Prefer the images and your tools over seller text when they conflict.
- `seller.specs` and `seller.condition_details` are free-form and vary by category. Do not assume a fixed key set.
- `images` are hosted URLs. Fetch them at runtime; do not assume local files.

---



## Output

Write one output object per listing, as an array, to `output/results.json`. Two things must be clear in each object; the rest of the structure is your choice:

- **Which listing** it is for — `listing_id`, matching the input.
- **Your generated listing** (title, description, specifications, condition, original MRP) and **your verification result**, clearly separated from each other.

`examples/sample_output.json` shows one valid shape: a `generated_pdp` object and a `review` object with a `verdict` plus supporting notes. It is just one example - you do not need to match it, and a different structure for the review side is fine as long as it is consistent and your README explains it.

The verdict itself is fixed to two values:

- `auto_publish` — safe to publish as generated.
- `human_review_needed` — needs a person to check before it goes live.

You can set stricter rules for yourself across the 12 listings if that helps you stay consistent. That is optional, not required.

Two fields worth extra thought, regardless of shape:

- **Condition**: separate what is visible (visual condition — wear, scuffs, screen or body state) from what functions (functional condition — powers on, known defects), plus an overall tier and your reasoning. Five reference tiers: `Brand New`, `Like New`, `Lightly Used`, `Regularly Used`, `Needs Repair`. Use these or your own equivalent, but be consistent.
- **Specifications**: include only what you can support from the images or a tool result. Omit a spec you are unsure of rather than guess it.
- **Original MRP**: the product's original list price when new, not the seller's asking price. The seller's `original_price` field is often blank or unreliable — look it up (product lookup tool) rather than copying it. Omit it if you cannot find a reasonable value.

Your verification step must be able to catch contradictions in its own draft, not simply approve whatever the generation step produced.

---



## Agent requirements



### Single agent

- A single agent entrypoint that decides when to call tools and when to finalize.
- No parallel specialist agents or dispatcher required.



### Tools

Examples of tools that may be useful. This is not a checklist to satisfy.

- **Product lookup** — web search to find specifications of branded products.
- **Vision / image analysis** — depending on your approach, this may not need a separate tool call at all; a multimodal model can just read the images directly. Add a separate vision tool only if that is really how your system works.
- Anything else that helps — a schema or consistency checker on your own output, for example.

Use tool calls only where they do real work, not to satisfy a count. Stubbing the lookup tool is acceptable if documented; a real lookup with your own API key is preferred.

---



## Technical expectations

- Python  / Javascript.
- Read `data/listings.json`, fetch images from their URLs, and write output for each listing.
- Provide `.env.example` for keys (`OPENAI_API_KEY`, etc.). Do not commit secrets.



### Suggested CLI

```bash
python run_agent.py --input data/listings.json --output output/results.json
```



### Dependencies

Pin dependencies in `requirements.txt` or `pyproject.toml`. Keep the stack small. Your entrypoint must run on a fresh copy of your repository with only these dependencies installed.

---



## README (required)

Include a `README.md` alongside your code that covers:

- **Setup** — how to install dependencies and run the project, and which env vars are needed.
- **Stack** — language, framework, model(s), and libraries used.
- **File map** — a summary of the main files and what they do, not a line-by-line breakdown.
- **Tools** — which tools the agent calls, and what each one does.
- **How it works** — the flow from input listing to output, in your own words.

Write it for someone opening the repository for the first time. It should describe what you built, not defend your design choices. We will talk through the harder questions — where the agent can go wrong, how it handles uncertainty, when it sends something to a human — in a follow-up conversation, not in writing.

---



## API keys

Use your own LLM and search API keys during development. Do not commit any key to the repository — use `.env.example` for the variable names, not the values. To test your submission, we will use our own keys and run it ourselves.

You can use OpenAI, Gemini, or any other provider. A free-tier model is fine if you cannot use a paid API. The agent still needs to meet the rules in this document — for example, not inventing specs and actually checking its own work.

Keep spend modest: the sample set is small (12 listings, plus a small held-out set).

---



## Submission

Send:

- [ ] Link to your GitHub repository, with runnable code and a README (setup, stack, file map, tools used, how the system works).
- [ ] `output/results.json` from your own run against `data/listings.json`.