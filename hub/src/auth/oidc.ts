import { Issuer, generators, Client } from "openid-client";
import { config } from "../config";

let client: Client | null = null;

export async function getOidcClient(): Promise<Client> {
  if (client) return client;
  const issuer = await Issuer.discover("https://accounts.google.com");
  client = new issuer.Client({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uris: [config.google.redirectUri],
    response_types: ["code"],
  });
  return client;
}

export { generators };
