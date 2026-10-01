import axios from "axios";

export const api = axios.create({ baseURL: "/api", timeout: 5000 });

export async function probeCache(): Promise<{ cachedAt: string; source: "local" }> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { cachedAt: new Date().toISOString(), source: "local" };
}
