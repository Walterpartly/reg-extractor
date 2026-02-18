import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.use(express.json({ limit: "50mb" }));

const publicDir = path.join(__dirname, "../public");
console.log("Serving static files from:", publicDir);
app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const SYSTEM_PROMPT = `You are a UK vehicle registration plate and VIN extraction tool. Analyse the provided image and extract:

1. **UK Registration plates** — all formats including:
   - Current format: AB12 CDE
   - Prefix format: A123 BCD
   - Suffix format: ABC 123D
   - Northern Ireland: ABC 1234
   - Dateless: 1234 AB or AB 1234
2. **VINs (Vehicle Identification Numbers)** — 17-character alphanumeric codes (never contain I, O, or Q)

Return ONLY valid JSON in this exact format, with no other text:
{"results": [{"type": "reg", "value": "AB12 CDE", "uncertain": false}]}

Rules:
- Normalise registration plates to UPPERCASE with standard spacing
- For current-format plates, format as "XX00 XXX" (4+3 with space)
- Set "uncertain": true if the text is partially obscured, blurry, or you are less than 90% confident
- If no plates or VINs are found, return {"results": []}
- type must be "reg" for registration plates or "vin" for VINs`;

interface ExtractResult {
  type: "reg" | "vin";
  value: string;
  uncertain: boolean;
}

app.post("/api/extract", async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server misconfiguration: missing API key" });
    return;
  }

  const { image } = req.body as { image?: string };
  if (!image) {
    res.status(400).json({ error: "Missing 'image' field (expected a data URL)" });
    return;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Title": "Reg/VIN Extractor",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        max_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: image } },
              {
                type: "text",
                text: "Extract all UK registration plates and VINs visible in this image.",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const msg = err.error?.message ?? `OpenRouter API error: ${response.status}`;
      res.status(502).json({ error: msg });
      return;
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(502).json({ error: "Could not parse response from Claude." });
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { results?: ExtractResult[] };
    const results: ExtractResult[] = (parsed.results ?? []).map((r) => ({
      type: r.type === "vin" ? ("vin" as const) : ("reg" as const),
      value: r.value ?? "",
      uncertain: !!r.uncertain,
    }));

    res.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Reg Extractor server running on port ${PORT}`);
});
