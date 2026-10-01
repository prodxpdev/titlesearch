// Compares the structure of a live OpenAPI excerpt with the one saved in
// fixtures/: $refs resolved, prose (descriptions, examples, code samples)
// dropped, so wording changes pass and shape changes fail.

type Json = unknown;

const PROSE = new Set(["description", "summary", "example", "examples", "x-codeSamples", "note"]);

export function resolveRefs(node: Json, root: Json, depth = 0): Json {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, root, depth));
  if (node && typeof node === "object") {
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === "string" && ref.startsWith("#/") && depth < 16) {
      let target: Json = root;
      for (const part of ref.slice(2).split("/")) target = (target as Record<string, Json>)?.[part];
      return resolveRefs(target, root, depth + 1);
    }
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, resolveRefs(v, root, depth)]),
    );
  }
  return node;
}

export function shape(node: Json): Json {
  if (Array.isArray(node)) return node.map(shape);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => !PROSE.has(k))
        .map(([k, v]) => [k, shape(v)]),
    );
  }
  return node;
}
