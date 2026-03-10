import { FunctionCallingConfigMode, GoogleGenAI, Type } from "@google/genai";
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
        thinkingBudget: 12000,
      },
    },
  });

  return response.text ?? "";
}

type ScheduleToolArgs = {
  startDate: string;
  endDate: string;
  requestedLabel: string;
};

type ScheduleToolResult = {
  calendarId: string;
  count: number;
  requestedLabel: string;
  events: Array<{
    summary: string;
    start: string;
    end?: string;
    location?: string;
  }>;
};

export async function runGeminiScheduleLoop(input: {
  prompt: string;
  readSchedule: (args: ScheduleToolArgs) => Promise<ScheduleToolResult>;
}) {
  const env = getEnv();
  const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const readScheduleDeclaration = {
    name: "read_schedule",
    description:
      "Read calendar events for a specific date range. Use this for any question about schedule, events, agenda, today, tomorrow, this week, next week, or explicit date ranges.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        startDate: {
          type: Type.STRING,
          description: "Start date in YYYY-MM-DD format using the app timezone.",
        },
        endDate: {
          type: Type.STRING,
          description: "End date in YYYY-MM-DD format using the app timezone.",
        },
        requestedLabel: {
          type: Type.STRING,
          description: "Short human label for the requested window, such as 'today', 'tomorrow', or 'March 11 to March 17'.",
        },
      },
      required: ["startDate", "endDate", "requestedLabel"],
    },
  };

  const response1 = await client.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: input.prompt }] }],
    config: {
      temperature: 0.1,
      tools: [{ functionDeclarations: [readScheduleDeclaration] }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: ["read_schedule"],
        },
      },
      thinkingConfig: {
        thinkingBudget: 12000,
        includeThoughts: true,
      },
    },
  });

  const modelParts = response1.candidates?.[0]?.content?.parts ?? [];
  const functionCallPart = modelParts.find((part) => part.functionCall?.name === "read_schedule");
  const functionCall = functionCallPart?.functionCall;

  if (!functionCallPart || !functionCall || functionCall.name !== "read_schedule") {
    return response1.text ?? "I could not determine the schedule window.";
  }

  const functionArgs = functionCall.args ?? {};

  const toolResult = await input.readSchedule({
    startDate: String(functionArgs.startDate ?? ""),
    endDate: String(functionArgs.endDate ?? ""),
    requestedLabel: String(functionArgs.requestedLabel ?? "the requested range"),
  });

  const history = [
    { role: "user", parts: [{ text: input.prompt }] },
    {
      role: "model",
      parts: [functionCallPart],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: functionCall.name,
            response: toolResult,
          },
        },
      ],
    },
  ];

  const response2 = await client.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: history,
    config: {
      temperature: 0.1,
      tools: [{ functionDeclarations: [readScheduleDeclaration] }],
      thinkingConfig: {
        thinkingBudget: 12000,
        includeThoughts: true,
      },
    },
  });

  return response2.text ?? "I could not summarize the schedule.";
}
