// Bun's file imports: the default export is the file's path (embedded when compiled).
declare module "*.wasm" {
  const path: string;
  export default path;
}
