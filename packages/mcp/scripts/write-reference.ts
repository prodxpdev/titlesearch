// Writes docs/reference/mcp-tools.md from the tool descriptions and schemas.
import { writeFileSync } from "node:fs";
import { renderToolReference } from "../src/reference.js";

writeFileSync(
  new URL("../../../docs/reference/mcp-tools.md", import.meta.url),
  renderToolReference(),
);
