import endpoints from "../../brand/endpoints.json";

type EndpointKey = keyof typeof endpoints;

export function fizotEndpoint(key: EndpointKey): string {
  const value = endpoints[key];
  return typeof value === "string" ? value.trim() : "";
}
