import { handleRequest } from "../src/server.js";

export default async function handler(request, response) {
  return handleRequest(request, response);
}
