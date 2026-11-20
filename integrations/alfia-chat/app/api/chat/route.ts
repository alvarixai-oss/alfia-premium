import { handleChatRequest } from "../../../lib/alfia-chat/server";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(request: Request) {
  return handleChatRequest(request, {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    trustVercelIp: process.env.VERCEL === "1",
  });
}
