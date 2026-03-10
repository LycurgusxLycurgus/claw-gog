import { GoogleGenAI } from "@google/genai";
import { getEnv } from "../app/env";

export async function askGemini(prompt: string) {
  const env = getEnv();
  const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const response = await client.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: prompt,
    config: {
      temperature: 0.2,
      thinkingConfig: {
        thinkingBudget: 512,
      },
    },
  });

  return response.text ?? "";
}
