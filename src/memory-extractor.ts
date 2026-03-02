import Anthropic from "@anthropic-ai/sdk";

interface ConversationMessage {
  role: "user" | "agent" | "system";
  text: string;
  timestamp: number;
}

export interface ExtractionResult {
  profileUpdates: string[];
  actionItems: string[];
  skipReason?: string;
}

export async function extractAndFileInsights(
  messages: ConversationMessage[],
  currentProfile: string
): Promise<ExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { profileUpdates: [], actionItems: [], skipReason: "no_api_key" };
  }

  const transcript = messages
    .filter(m => m.role !== "system")
    .map(m => {
      const role = m.role === "user" ? "Rickin" : "Assistant";
      const text = m.text.length > 600 ? m.text.slice(0, 600) + "..." : m.text;
      return `${role}: ${text}`;
    })
    .join("\n\n");

  if (transcript.length < 50) {
    return { profileUpdates: [], actionItems: [], skipReason: "too_short" };
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `You analyze conversations between Rickin and his AI assistant to extract new facts worth remembering.

CURRENT PROFILE (already known):
${currentProfile || "(empty)"}

CONVERSATION:
${transcript}

Extract ONLY genuinely new information not already in the profile. Respond with valid JSON:
{
  "profileUpdates": ["string array of new facts about Rickin — preferences, people, projects, routines, interests, decisions. Each item is a short sentence."],
  "actionItems": ["string array of action items or tasks mentioned — things to do, follow up on, or remember. Each item is a short sentence."],
  "skipReason": "If nothing new was learned, set this to 'nothing_new'. Otherwise omit this field."
}

Rules:
- Only include facts that are NOT already in the current profile
- Do not include generic observations or AI-side actions
- Action items must be things Rickin needs to do, not things the assistant did
- If the conversation was purely functional (weather check, quick lookup) with no new personal info, return skipReason: "nothing_new"
- Keep each item concise — one sentence max
- Return ONLY the JSON, no markdown fencing`
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as ExtractionResult;

    return {
      profileUpdates: Array.isArray(parsed.profileUpdates) ? parsed.profileUpdates : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      skipReason: parsed.skipReason || undefined,
    };
  } catch (err) {
    console.error("[memory-extractor] Extraction failed:", err);
    return { profileUpdates: [], actionItems: [], skipReason: "extraction_error" };
  }
}
