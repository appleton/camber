import { camberAcpNavCreateChat } from "@camber/helperapi";

export async function createACPChatWorkingDirectory(sessionId: string): Promise<string> {
  const result = await camberAcpNavCreateChat({ sessionId });
  return result.path;
}
